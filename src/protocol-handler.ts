import type { SendspinTimeFilter } from "./time-filter";
import type {
  ClientCommand,
  ClientGoodbye,
  ClientHello,
  ClientState,
  ClientTime,
  Codec,
  ControllerCommand,
  ControllerCommands,
  GoodbyeReason,
  GroupUpdate,
  MessageType,
  ServerCommand,
  ServerMessage,
  ServerState,
  ServerTime,
  StreamClear,
  StreamEnd,
  StreamStart,
  SupportedFormat,
} from "./types";
import type { AudioProcessor } from "./audio-processor";
import type { StateManager } from "./state-manager";
import type { WebSocketManager } from "./websocket-manager";

// Constants
const STATE_UPDATE_INTERVAL = 5000; // 5 seconds
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

export interface ProtocolHandlerConfig {
  clientName?: string;
  codecs?: Codec[];
  bufferCapacity?: number;
  useHardwareVolume?: boolean;
  onVolumeCommand?: (volume: number, muted: boolean) => void;
  getExternalVolume?: () => { volume: number; muted: boolean };
  useOutputLatencyCompensation?: boolean;
}

export class ProtocolHandler {
  private clientName: string;
  private codecs: Codec[];
  private bufferCapacity: number;
  private useHardwareVolume: boolean;
  private useOutputLatencyCompensation: boolean;
  private onVolumeCommand?: (volume: number, muted: boolean) => void;
  private getExternalVolume?: () => { volume: number; muted: boolean };
  private timeSyncBurstActive: boolean = false;
  private timeSyncBurstSentCount: number = 0;
  private timeSyncInFlightClientTransmitted: number | null = null;
  private timeSyncInFlightTimeout: number | null = null;
  private timeSyncBurstSamples: TimeSyncSample[] = [];

  constructor(
    private playerId: string,
    private wsManager: WebSocketManager,
    private audioProcessor: AudioProcessor,
    private stateManager: StateManager,
    private timeFilter: SendspinTimeFilter,
    config: ProtocolHandlerConfig = {},
  ) {
    this.clientName = config.clientName ?? "Sendspin Player";
    this.codecs = config.codecs ?? ["opus", "flac", "pcm"];
    this.bufferCapacity = config.bufferCapacity ?? 1024 * 1024 * 5; // 5MB default
    this.useHardwareVolume = config.useHardwareVolume ?? false;
    this.useOutputLatencyCompensation =
      config.useOutputLatencyCompensation ?? true;
    this.onVolumeCommand = config.onVolumeCommand;
    this.getExternalVolume = config.getExternalVolume;
  }

  // Handle WebSocket messages
  handleMessage(event: MessageEvent): void {
    if (typeof event.data === "string") {
      // JSON message
      const message = JSON.parse(event.data) as ServerMessage;
      this.handleServerMessage(message);
    } else if (event.data instanceof ArrayBuffer) {
      // Binary message (audio chunk)
      this.audioProcessor.handleBinaryMessage(event.data);
    } else if (event.data instanceof Blob) {
      // Convert Blob to ArrayBuffer
      event.data.arrayBuffer().then((buffer) => {
        this.audioProcessor.handleBinaryMessage(buffer);
      });
    }
  }

  // Handle server messages
  private handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case "server/hello":
        this.handleServerHello();
        break;

      case "server/time":
        this.handleServerTime(message);
        break;

      case "stream/start":
        this.handleStreamStart(message as StreamStart);
        break;

      case "stream/clear":
        this.handleStreamClear(message as StreamClear);
        break;

      case "stream/end":
        this.handleStreamEnd(message as StreamEnd);
        break;

      case "server/command":
        this.handleServerCommand(message as ServerCommand);
        break;

      case "server/state":
        this.stateManager.updateServerState((message as ServerState).payload);
        break;

      case "group/update":
        this.stateManager.updateGroupState((message as GroupUpdate).payload);
        break;
    }
  }

  // Handle server hello
  private handleServerHello(): void {
    console.log("Sendspin: Connected to server");
    // Per spec: Send initial client/state immediately after server/hello
    this.sendStateUpdate();
    // Start time synchronization with fixed bursts.
    this.stopTimeSync();
    this.startTimeSyncBurstIfIdle();
    this.scheduleNextTimeSyncBurstTick();

    // Start periodic state updates
    const stateInterval = window.setInterval(
      () => this.sendStateUpdate(),
      STATE_UPDATE_INTERVAL,
    );
    this.stateManager.setStateUpdateInterval(stateInterval);
  }

  // Restart the periodic state update interval.
  // Called after volume commands to prevent a pending periodic update
  // from sending stale hardware volume shortly after the command response.
  private restartStateUpdateInterval(): void {
    const newInterval = window.setInterval(
      () => this.sendStateUpdate(),
      STATE_UPDATE_INTERVAL,
    );
    this.stateManager.setStateUpdateInterval(newInterval);
  }

  // Schedule the next fixed 10s burst tick.
  private scheduleNextTimeSyncBurstTick(): void {
    const timeSyncTimeout = window.setTimeout(() => {
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
    this.timeSyncInFlightTimeout = window.setTimeout(() => {
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

  stopTimeSync(): void {
    this.stateManager.clearTimeSyncInterval();
    this.abortTimeSyncBurst();
  }

  // Handle server time synchronization
  private handleServerTime(message: ServerTime): void {
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

  // Handle stream start (also used for format updates per new spec)
  private handleStreamStart(message: StreamStart): void {
    const isFormatUpdate = this.stateManager.currentStreamFormat !== null;

    this.stateManager.currentStreamFormat = message.payload.player;
    console.log(
      isFormatUpdate
        ? "Sendspin: Stream format updated"
        : "Sendspin: Stream started",
      this.stateManager.currentStreamFormat,
    );
    console.log(
      `Sendspin: Codec=${this.stateManager.currentStreamFormat.codec.toUpperCase()}, ` +
        `SampleRate=${this.stateManager.currentStreamFormat.sample_rate}Hz, ` +
        `Channels=${this.stateManager.currentStreamFormat.channels}, ` +
        `BitDepth=${this.stateManager.currentStreamFormat.bit_depth}bit`,
    );

    this.audioProcessor.initAudioContext();
    // Resume AudioContext if suspended (required for browser autoplay policies)
    this.audioProcessor.resumeAudioContext();

    if (!isFormatUpdate) {
      // New stream: reset scheduling state and clear buffers
      this.audioProcessor.clearBuffers();
    }
    // Format update: don't clear buffers (per new spec)

    this.stateManager.isPlaying = true;

    // Ensure audio element is playing for MediaSession
    this.audioProcessor.startAudioElement();

    // Explicitly set playbackState for Android (if mediaSession available)
    if (typeof navigator !== "undefined" && navigator.mediaSession) {
      navigator.mediaSession.playbackState = "playing";
    }
  }

  // Handle stream clear (for seek operations)
  private handleStreamClear(message: StreamClear): void {
    const roles = message.payload.roles;
    // If roles is undefined or includes 'player', clear player buffers
    if (!roles || roles.includes("player")) {
      console.log("Sendspin: Stream clear (seek)");
      this.audioProcessor.clearBuffers();
      // Note: Don't stop playing, don't clear format - just clear buffers
    }
  }

  // Handle stream end
  private handleStreamEnd(message: StreamEnd): void {
    const roles = message.payload?.roles;

    // If roles is undefined or includes 'player', handle player stream end
    if (!roles || roles.includes("player")) {
      console.log("Sendspin: Stream ended");
      // Per spec: Stop playback and clear buffers
      this.audioProcessor.clearBuffers();

      // Clear format and reset state
      this.stateManager.currentStreamFormat = null;
      this.stateManager.isPlaying = false;

      // Stop audio element (except on Android where silent loop continues)
      this.audioProcessor.stopAudioElement();

      // Explicitly set playbackState (if mediaSession available)
      if (typeof navigator !== "undefined" && navigator.mediaSession) {
        navigator.mediaSession.playbackState = "paused";
      }

      // Send state update to server
      this.sendStateUpdate();
    }
  }

  // Handle server commands
  private handleServerCommand(message: ServerCommand): void {
    const playerCommand = message.payload.player;
    if (!playerCommand) return;

    switch (playerCommand.command) {
      case "volume":
        // Set volume command
        if (playerCommand.volume !== undefined) {
          this.stateManager.volume = playerCommand.volume;
          this.audioProcessor.updateVolume();
          // Notify external handler for hardware volume
          if (this.useHardwareVolume && this.onVolumeCommand) {
            this.onVolumeCommand(playerCommand.volume, this.stateManager.muted);
          }
        }
        break;

      case "mute":
        // Mute/unmute command - uses boolean mute field
        if (playerCommand.mute !== undefined) {
          this.stateManager.muted = playerCommand.mute;
          this.audioProcessor.updateVolume();
          // Notify external handler for hardware volume
          if (this.useHardwareVolume && this.onVolumeCommand) {
            this.onVolumeCommand(this.stateManager.volume, playerCommand.mute);
          }
        }
        break;
    }

    // Reset periodic timer first, then send state with commanded values.
    // Skip hardware read to avoid race where hardware hasn't applied the volume yet.
    this.restartStateUpdateInterval();
    this.sendStateUpdate(true);
  }

  // Send client hello with player identification
  sendClientHello(): void {
    const hello: ClientHello = {
      type: "client/hello" as MessageType.CLIENT_HELLO,
      payload: {
        client_id: this.playerId,
        name: this.clientName,
        version: 1,
        supported_roles: ["player@v1", "controller@v1", "metadata@v1"],
        device_info: {
          product_name: "Web Browser",
          manufacturer:
            (typeof navigator !== "undefined" && navigator.vendor) || "Unknown",
          software_version:
            (typeof navigator !== "undefined" && navigator.userAgent) ||
            "Unknown",
        },
        "player@v1_support": {
          supported_formats: this.getSupportedFormats(),
          buffer_capacity: this.bufferCapacity,
          supported_commands: ["volume", "mute"],
        },
      },
    };
    this.wsManager.send(hello);
  }

  // Get supported codecs for the current browser
  private getBrowserSupportedCodecs(): Set<Codec> {
    const userAgent =
      typeof navigator !== "undefined" ? navigator.userAgent : "";
    const isSafari = /^((?!chrome|android).)*safari/i.test(userAgent);

    // Check if native Opus decoder is available (requires secure context)
    const hasNativeOpus = typeof AudioDecoder !== "undefined";

    if (!hasNativeOpus) {
      if (typeof window !== "undefined" && !window.isSecureContext) {
        console.warn(
          "[Opus] Running in insecure context, falling back to FLAC/PCM",
        );
      } else {
        console.warn(
          "[Opus] Native decoder not available, falling back to FLAC/PCM",
        );
      }
    }

    if (isSafari) {
      // Safari: No FLAC support
      return new Set(["pcm", "opus"] as Codec[]);
    }

    if (hasNativeOpus) {
      // Native Opus available (Chrome, Edge, Firefox desktop)
      return new Set(["pcm", "opus", "flac"] as Codec[]);
    }

    // No native Opus (Firefox Android, insecure context)
    return new Set(["pcm", "flac"] as Codec[]);
  }

  // Build supported formats from requested codecs, filtering out unsupported ones
  private getSupportedFormats(): SupportedFormat[] {
    const browserSupported = this.getBrowserSupportedCodecs();
    const formats: SupportedFormat[] = [];

    for (const codec of this.codecs) {
      if (!browserSupported.has(codec)) {
        continue;
      }

      if (codec === "opus") {
        // Opus requires 48kHz
        formats.push({
          codec: "opus",
          sample_rate: 48000,
          channels: 2,
          bit_depth: 16,
        });
      } else {
        // PCM and FLAC support both sample rates
        formats.push({ codec, sample_rate: 48000, channels: 2, bit_depth: 16 });
        formats.push({ codec, sample_rate: 44100, channels: 2, bit_depth: 16 });
      }
    }

    if (formats.length === 0) {
      throw new Error(
        `No supported codecs: requested [${this.codecs.join(", ")}], ` +
          `browser supports [${[...browserSupported].join(", ")}]`,
      );
    }

    return formats;
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

  // Send state update
  // When skipHardwareRead is true, use stateManager values instead of reading from hardware.
  // This avoids race conditions when responding to volume commands.
  sendStateUpdate(skipHardwareRead = false): void {
    let volume = this.stateManager.volume;
    let muted = this.stateManager.muted;
    if (!skipHardwareRead && this.useHardwareVolume && this.getExternalVolume) {
      const externalVol = this.getExternalVolume();
      volume = externalVol.volume;
      muted = externalVol.muted;
    }

    const message: ClientState = {
      type: "client/state" as MessageType.CLIENT_STATE,
      payload: {
        player: {
          state: this.stateManager.playerState,
          volume,
          muted,
        },
      },
    };
    this.wsManager.send(message);
  }

  // Send goodbye message before disconnecting
  sendGoodbye(reason: GoodbyeReason): void {
    this.wsManager.send({
      type: "client/goodbye" as MessageType.CLIENT_GOODBYE,
      payload: {
        reason,
      },
    } satisfies ClientGoodbye);
  }

  // Send controller command to server
  sendCommand<T extends ControllerCommand>(
    command: T,
    params: ControllerCommands[T],
  ): void {
    this.wsManager.send({
      type: "client/command" as MessageType.CLIENT_COMMAND,
      payload: {
        controller: {
          command,
          ...(params as object),
        },
      },
    } satisfies ClientCommand);
  }
}
