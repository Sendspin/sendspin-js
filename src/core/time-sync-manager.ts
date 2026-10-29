import type { SendspinTimeFilter } from "./time-filter";
import type { StateManager } from "./state-manager";
import type { MessageSender } from "./protocol-handler";
import type { ClientTime, MessageType, ServerTime } from "../types";

const TIME_SYNC_BURST_SIZE = 8;
// Stays under the spec's 10 s maximum between burst starts, leaving room for timer lateness.
const TIME_SYNC_BURST_INTERVAL_MS = 9000;
const TIME_SYNC_REQUEST_TIMEOUT_MS = 2000;

interface TimeSyncSample {
  measurement: number;
  t4: number;
  rttTerm: number;
}

export class TimeSyncManager {
  private timeSyncBurstActive = false;
  private timeSyncBurstSentCount = 0;
  private timeSyncInFlightClientTransmitted: number | null = null;
  private timeSyncInFlightTimeout: ReturnType<typeof setTimeout> | null = null;
  private timeSyncBurstSamples: TimeSyncSample[] = [];

  constructor(
    private sender: MessageSender,
    private stateManager: StateManager,
    private timeFilter: SendspinTimeFilter,
    private onSynchronized: () => void,
  ) {}

  // Start an initial burst and schedule recurring bursts.
  startAndSchedule(): void {
    this.stop();
    this.startTimeSyncBurstIfIdle();
    this.scheduleNextTimeSyncBurstTick();
  }

  // Schedule the next burst tick.
  private scheduleNextTimeSyncBurstTick(): void {
    const timeSyncTimeout = globalThis.setTimeout(() => {
      this.startTimeSyncBurstIfIdle();
      this.scheduleNextTimeSyncBurstTick();
    }, TIME_SYNC_BURST_INTERVAL_MS);
    this.stateManager.setTimeSyncInterval(timeSyncTimeout);
  }

  private startTimeSyncBurstIfIdle(): void {
    if (this.timeSyncBurstActive) {
      return;
    }

    this.timeSyncBurstActive = true;
    this.timeSyncBurstSentCount = 0;
    this.timeSyncBurstSamples = [];
    this.timeSyncInFlightClientTransmitted = null;
    this.sendNextTimeSyncBurstProbe();
  }

  private sendNextTimeSyncBurstProbe(): void {
    if (
      !this.timeSyncBurstActive ||
      this.timeSyncInFlightClientTransmitted !== null
    ) {
      return;
    }

    if (this.timeSyncBurstSentCount >= TIME_SYNC_BURST_SIZE) {
      this.finalizeTimeSyncBurst();
      return;
    }

    const clientTransmitted = this.sendTimeSync();
    this.timeSyncBurstSentCount += 1;
    this.timeSyncInFlightClientTransmitted = clientTransmitted;
    this.armTimeSyncProbeTimeout(clientTransmitted);
  }

  private armTimeSyncProbeTimeout(expectedClientTransmitted: number): void {
    this.clearTimeSyncProbeTimeout();
    this.timeSyncInFlightTimeout = globalThis.setTimeout(() => {
      this.handleTimeSyncProbeTimeout(expectedClientTransmitted);
    }, TIME_SYNC_REQUEST_TIMEOUT_MS);
  }

  private clearTimeSyncProbeTimeout(): void {
    if (this.timeSyncInFlightTimeout !== null) {
      clearTimeout(this.timeSyncInFlightTimeout);
      this.timeSyncInFlightTimeout = null;
    }
  }

  private handleTimeSyncProbeTimeout(expectedClientTransmitted: number): void {
    if (
      !this.timeSyncBurstActive ||
      this.timeSyncInFlightClientTransmitted !== expectedClientTransmitted
    ) {
      return;
    }

    console.warn("Sendspin: Time sync probe timed out, aborting current burst");
    this.abortTimeSyncBurst();
  }

  private finalizeTimeSyncBurst(): void {
    this.clearTimeSyncProbeTimeout();

    const wasSynchronized = this.timeFilter.is_synchronized;
    const candidate = this.selectTimeSyncBurstCandidate();
    if (candidate) {
      // Floor at 1 ms so coarse timers never yield a zero max_error.
      const maxError = Math.max(1000, Math.trunc(candidate.rttTerm / 2));
      this.timeFilter.update(candidate.measurement, maxError, candidate.t4);
    }

    this.timeSyncBurstActive = false;
    this.timeSyncBurstSentCount = 0;
    this.timeSyncInFlightClientTransmitted = null;
    this.timeSyncBurstSamples = [];

    if (!wasSynchronized && this.timeFilter.is_synchronized) {
      this.onSynchronized();
    }
  }

  private selectTimeSyncBurstCandidate(): TimeSyncSample | null {
    if (this.timeSyncBurstSamples.length === 0) {
      return null;
    }

    // Compare raw RTT since the 1 ms max_error floor ties fast LAN samples.
    return this.timeSyncBurstSamples.reduce((best, sample) =>
      sample.rttTerm < best.rttTerm ? sample : best,
    );
  }

  private abortTimeSyncBurst(): void {
    this.clearTimeSyncProbeTimeout();
    this.timeSyncBurstActive = false;
    this.timeSyncBurstSentCount = 0;
    this.timeSyncInFlightClientTransmitted = null;
    this.timeSyncBurstSamples = [];
  }

  // Stop all time sync activity (interval + in-flight burst).
  stop(): void {
    this.stateManager.clearTimeSyncInterval();
    this.abortTimeSyncBurst();
  }

  // Handle server/time response
  handleServerTime(message: ServerTime, receivedAtUs: number): void {
    if (
      !this.timeSyncBurstActive ||
      this.timeSyncInFlightClientTransmitted === null
    ) {
      return;
    }

    // Per spec: client_transmitted (T1), server_received (T2), server_transmitted (T3)
    const T1 = message.payload.client_transmitted;
    if (T1 !== this.timeSyncInFlightClientTransmitted) {
      console.warn(
        "Sendspin: Ignoring out-of-order time response",
        T1,
        this.timeSyncInFlightClientTransmitted,
      );
      return;
    }

    const T4 = receivedAtUs;
    const T2 = message.payload.server_received;
    const T3 = message.payload.server_transmitted;

    // NTP offset calculation: measurement = ((T2 - T1) + (T3 - T4)) / 2
    const measurement = Math.trunc((T2 - T1 + (T3 - T4)) / 2);

    // Max error (half of round-trip time): max_error = ((T4 - T1) - (T3 - T2)) / 2
    const rttTerm = Math.max(0, T4 - T1 - (T3 - T2));
    this.timeSyncBurstSamples.push({
      measurement,
      t4: T4,
      rttTerm,
    });

    this.clearTimeSyncProbeTimeout();
    this.timeSyncInFlightClientTransmitted = null;

    if (this.timeSyncBurstSentCount >= TIME_SYNC_BURST_SIZE) {
      this.finalizeTimeSyncBurst();
      return;
    }

    this.sendNextTimeSyncBurstProbe();
  }

  // Send time synchronization message
  sendTimeSync(clientTimeUs = Math.floor(performance.now() * 1000)): number {
    const message: ClientTime = {
      type: "client/time" as MessageType.CLIENT_TIME,
      payload: {
        client_transmitted: clientTimeUs,
      },
    };
    this.sender.sendControl(message);
    return clientTimeUs;
  }
}
