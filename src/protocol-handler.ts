import type { SendspinTimeFilter } from "./time-filter";
import type {
  ClientHello,
  ClientState,
  ClientTime,
  MessageType,
  ServerCommand,
  ServerMessage,
  StreamClear,
  StreamEnd,
  StreamStart,
  SupportedFormat,
} from "./types";
import type { AudioProcessor } from "./audio-processor";
import type { StateManager } from "./state-manager";
import type { WebSocketManager } from "./websocket-manager";

// Constants
const TIME_SYNC_INTERVAL = 5000; // 5 seconds
const STATE_UPDATE_INTERVAL = 5000; // 5 seconds

export interface ProtocolHandlerConfig {
  clientName?: string;
  supportedFormats?: SupportedFormat[];
  bufferCapacity?: number;
  useHardwareVolume?: boolean;
  onVolumeCommand?: (volume: number, muted: boolean) => void;
  getExternalVolume?: () => { volume: number; muted: boolean };
  useOutputLatencyCompensation?: boolean;
}

export class ProtocolHandler {
  private clientName: string;
  private supportedFormats?: SupportedFormat[];
  private bufferCapacity: number;
  private useHardwareVolume: boolean;
  private useOutputLatencyCompensation: boolean;
  private onVolumeCommand?: (volume: number, muted: boolean) => void;
  private getExternalVolume?: () => { volume: number; muted: boolean };

  constructor(
    private playerId: string,
    private wsManager: WebSocketManager,
    private audioProcessor: AudioProcessor,
    private stateManager: StateManager,
    private timeFilter: SendspinTimeFilter,
    config: ProtocolHandlerConfig = {}
  ) {
    this.clientName = config.clientName ?? "Sendspin Player";
    this.supportedFormats = config.supportedFormats;
    this.bufferCapacity = config.bufferCapacity ?? 1024 * 1024 * 5; // 5MB default
    this.useHardwareVolume = config.useHardwareVolume ?? false;
    this.useOutputLatencyCompensation =
      config.useOutputLatencyCompensation ?? false;
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
      case "group/update":
        // Handle these if needed in the future
        break;
    }
  }

  // Handle server hello
  private handleServerHello(): void {
    console.log("Sendspin: Connected to server");
    // Per spec: Send initial client/state immediately after server/hello
    this.sendStateUpdate();
    // Start time synchronization
    this.sendTimeSync();
    const timeSyncInterval = window.setInterval(
      () => this.sendTimeSync(),
      TIME_SYNC_INTERVAL
    );
    this.stateManager.setTimeSyncInterval(timeSyncInterval);

    // Start periodic state updates
    const stateInterval = window.setInterval(
      () => this.sendStateUpdate(),
      STATE_UPDATE_INTERVAL
    );
    this.stateManager.setStateUpdateInterval(stateInterval);
  }

  // Handle server time synchronization
  private handleServerTime(message: any): void {
    // Update Kalman filter with NTP-style measurement
    // Per spec: client_transmitted (T1), server_received (T2), server_transmitted (T3)
    const T4 = Math.floor(performance.now() * 1000); // client received time
    const T1 = message.payload.client_transmitted;
    const T2 = message.payload.server_received;
    const T3 = message.payload.server_transmitted;

    // NTP offset calculation: measurement = ((T2 - T1) + (T3 - T4)) / 2
    const clockOffset = (T2 - T1 + (T3 - T4)) / 2;

    // Optionally add output latency to offset measurement so Kalman filter smooths it together
    // This compensates for hardware delay (e.g., Bluetooth) by scheduling audio earlier
    const outputLatencyUs = this.useOutputLatencyCompensation
      ? this.audioProcessor.getRawOutputLatencyUs()
      : 0;
    const measurement = clockOffset + outputLatencyUs;

    // Max error (half of round-trip time): max_error = ((T4 - T1) - (T3 - T2)) / 2
    const max_error = (T4 - T1 - (T3 - T2)) / 2;

    // Update Kalman filter
    this.timeFilter.update(measurement, max_error, T4);

    console.log(
      "Sendspin: Clock sync - offset:",
      (this.timeFilter.offset / 1000).toFixed(2),
      "ms, outputLatency:",
      (outputLatencyUs / 1000).toFixed(2),
      "ms, error:",
      (this.timeFilter.error / 1000).toFixed(2),
      "ms, synced:",
      this.timeFilter.is_synchronized
    );
  }

  // Handle stream start (also used for format updates per new spec)
  private handleStreamStart(message: StreamStart): void {
    const isFormatUpdate = this.stateManager.currentStreamFormat !== null;

    this.stateManager.currentStreamFormat = message.payload.player;
    console.log(
      isFormatUpdate
        ? "Sendspin: Stream format updated"
        : "Sendspin: Stream started",
      this.stateManager.currentStreamFormat
    );
    console.log(
      `🎵 Sendspin: Codec=${this.stateManager.currentStreamFormat.codec.toUpperCase()}, ` +
      `SampleRate=${this.stateManager.currentStreamFormat.sample_rate}Hz, ` +
      `Channels=${this.stateManager.currentStreamFormat.channels}, ` +
      `BitDepth=${this.stateManager.currentStreamFormat.bit_depth}bit`
    );

    this.audioProcessor.initAudioContext();
    // Resume AudioContext if suspended (required for browser autoplay policies)
    this.audioProcessor.resumeAudioContext();

    if (!isFormatUpdate) {
      // New stream: reset scheduling state and clear buffers
      this.stateManager.resetStreamAnchors();
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
      this.stateManager.resetStreamAnchors();
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

    // Send state update to confirm the change
    this.sendStateUpdate();
  }

  // Send client hello with player identification
  sendClientHello(): void {
    const hello: ClientHello = {
      type: "client/hello" as MessageType.CLIENT_HELLO,
      payload: {
        client_id: this.playerId,
        name: this.clientName,
        version: 1,
        supported_roles: ["player@v1"],
        device_info: {
          product_name: "Web Browser",
          manufacturer:
            (typeof navigator !== "undefined" && navigator.vendor) || "Unknown",
          software_version:
            (typeof navigator !== "undefined" && navigator.userAgent) ||
            "Unknown",
        },
        player_support: {
          supported_formats:
            this.supportedFormats ?? this.getDefaultSupportedFormats(),
          buffer_capacity: this.bufferCapacity,
          supported_commands: ["volume", "mute"],
        },
      },
    };
    this.wsManager.send(hello);
  }

  // Get default supported audio formats based on browser capabilities
  private getDefaultSupportedFormats(): Array<{
    codec: string;
    channels: number;
    sample_rate: number;
    bit_depth: number;
  }> {
    // Safari has limited codec support, only use PCM for Safari
    // TODO: add flac support for Safari
    const userAgent =
      typeof navigator !== "undefined" ? navigator.userAgent : "";
    const isSafari = /^((?!chrome|android).)*safari/i.test(userAgent);

    if (isSafari) {
      return [
        {
          codec: "pcm",
          sample_rate: 48000,
          channels: 2,
          bit_depth: 16,
        },
        {
          codec: "pcm",
          sample_rate: 44100,
          channels: 2,
          bit_depth: 16,
        },
      ];
    }

    // Other browsers support FLAC and PCM
    // TODO: Opus needs special handling, at least on Safari and Firefox
    return [
      // FLAC preferred
      {
        codec: "flac",
        sample_rate: 48000,
        channels: 2,
        bit_depth: 16,
      },
      {
        codec: "flac",
        sample_rate: 44100,
        channels: 2,
        bit_depth: 16,
      },
      // PCM fallback (uncompressed)
      {
        codec: "pcm",
        sample_rate: 48000,
        channels: 2,
        bit_depth: 16,
      },
      {
        codec: "pcm",
        sample_rate: 44100,
        channels: 2,
        bit_depth: 16,
      },
    ];
  }

  // Send time synchronization message
  sendTimeSync(): void {
    const clientTimeUs = Math.floor(performance.now() * 1000);
    const message: ClientTime = {
      type: "client/time" as MessageType.CLIENT_TIME,
      payload: {
        client_transmitted: clientTimeUs,
      },
    };
    this.wsManager.send(message);
  }

  // Send state update
  sendStateUpdate(): void {
    // Get volume from external source if using hardware volume
    let volume = this.stateManager.volume;
    let muted = this.stateManager.muted;
    if (this.useHardwareVolume && this.getExternalVolume) {
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
}
