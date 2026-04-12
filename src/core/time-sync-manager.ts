import type { SendspinTimeFilter } from "./time-filter";
import type { StateManager } from "./state-manager";
import type { WebSocketManager } from "./websocket-manager";
import type { ClientTime, MessageType, ServerTime } from "../types";

const TIME_SYNC_BURST_SIZE = 8;
const TIME_SYNC_BURST_INTERVAL_MS = 10000;
const TIME_SYNC_REQUEST_TIMEOUT_MS = 2000;
const TIME_SYNC_ROBUST_SELECTION_COUNT = 3;

interface TimeSyncSample {
  measurement: number;
  maxError: number;
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
    private wsManager: WebSocketManager,
    private stateManager: StateManager,
    private timeFilter: SendspinTimeFilter,
  ) {}

  // Start an initial burst and schedule recurring bursts.
  startAndSchedule(): void {
    this.stop();
    this.startTimeSyncBurstIfIdle();
    this.scheduleNextTimeSyncBurstTick();
  }

  // Schedule the next fixed 10s burst tick.
  private scheduleNextTimeSyncBurstTick(): void {
    const timeSyncTimeout = globalThis.setTimeout(() => {
      this.startTimeSyncBurstIfIdle();
      this.scheduleNextTimeSyncBurstTick();
    }, TIME_SYNC_BURST_INTERVAL_MS);
    this.stateManager.setTimeSyncInterval(timeSyncTimeout);
  }

  private startTimeSyncBurstIfIdle(): void {
    if (this.timeSyncBurstActive || !this.wsManager.isConnected()) {
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
      this.timeSyncInFlightClientTransmitted !== null ||
      !this.wsManager.isConnected()
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

    const candidate = this.selectTimeSyncBurstCandidate();
    if (candidate) {
      this.timeFilter.update(
        candidate.measurement,
        candidate.maxError,
        candidate.t4,
      );
    }

    this.timeSyncBurstActive = false;
    this.timeSyncBurstSentCount = 0;
    this.timeSyncInFlightClientTransmitted = null;
    this.timeSyncBurstSamples = [];
  }

  private selectTimeSyncBurstCandidate(): TimeSyncSample | null {
    if (this.timeSyncBurstSamples.length === 0) {
      return null;
    }

    const topRttSamples = [...this.timeSyncBurstSamples]
      .sort((a, b) => a.rttTerm - b.rttTerm)
      .slice(
        0,
        Math.min(
          TIME_SYNC_ROBUST_SELECTION_COUNT,
          this.timeSyncBurstSamples.length,
        ),
      );
    const sortedByMeasurement = [...topRttSamples].sort(
      (a, b) => a.measurement - b.measurement,
    );
    return sortedByMeasurement[Math.floor(sortedByMeasurement.length / 2)];
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
  handleServerTime(message: ServerTime): void {
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

    const T4 = Math.floor(performance.now() * 1000); // client received time
    const T2 = message.payload.server_received;
    const T3 = message.payload.server_transmitted;

    // NTP offset calculation: measurement = ((T2 - T1) + (T3 - T4)) / 2
    const measurement = (T2 - T1 + (T3 - T4)) / 2;

    // Max error (half of round-trip time): max_error = ((T4 - T1) - (T3 - T2)) / 2
    const rttTerm = Math.max(0, T4 - T1 - (T3 - T2));
    const maxError = Math.max(1000, rttTerm / 2);
    this.timeSyncBurstSamples.push({
      measurement,
      maxError,
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
    this.wsManager.send(message);
    return clientTimeUs;
  }
}
