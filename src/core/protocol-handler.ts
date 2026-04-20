import type { SendspinTimeFilter } from "./time-filter";
import type {
  ClientCommand,
  ClientGoodbye,
  ClientHello,
  ClientState,
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
} from "../types";
import type { StreamHandler } from "../types";
import type { StateManager } from "./state-manager";
import type { WebSocketManager } from "./websocket-manager";
import { TimeSyncManager } from "./time-sync-manager";
import { getSupportedFormats } from "./codec-support";
import { clampSyncDelayMs } from "../sync-delay";

// Constants
const STATE_UPDATE_INTERVAL = 5000; // 5 seconds

export interface ProtocolHandlerConfig {
  clientName?: string;
  codecs?: Codec[];
  bufferCapacity?: number;
  useHardwareVolume?: boolean;
  onVolumeCommand?: (volume: number, muted: boolean) => void;
  onDelayCommand?: (delayMs: number) => void;
  getExternalVolume?: () => { volume: number; muted: boolean };
}

export class ProtocolHandler {
  private clientName: string;
  private codecs: Codec[];
  private bufferCapacity: number;
  private useHardwareVolume: boolean;
  private onVolumeCommand?: (volume: number, muted: boolean) => void;
  private onDelayCommand?: (delayMs: number) => void;
  private getExternalVolume?: () => { volume: number; muted: boolean };
  private timeSyncManager: TimeSyncManager;

  constructor(
    private playerId: string,
    private wsManager: WebSocketManager,
    private streamHandler: StreamHandler,
    private stateManager: StateManager,
    private timeFilter: SendspinTimeFilter,
    config: ProtocolHandlerConfig = {},
  ) {
    this.clientName = config.clientName ?? "Sendspin Player";
    this.codecs = config.codecs ?? ["opus", "flac", "pcm"];
    this.bufferCapacity = config.bufferCapacity ?? 1024 * 1024 * 5; // 5MB default
    this.useHardwareVolume = config.useHardwareVolume ?? false;
    this.onVolumeCommand = config.onVolumeCommand;
    this.onDelayCommand = config.onDelayCommand;
    this.getExternalVolume = config.getExternalVolume;
    this.timeSyncManager = new TimeSyncManager(
      wsManager,
      stateManager,
      timeFilter,
    );
  }

  // Handle WebSocket messages
  handleMessage(event: MessageEvent): void {
    if (typeof event.data === "string") {
      // JSON message
      const message = JSON.parse(event.data) as ServerMessage;
      this.handleServerMessage(message);
    } else if (event.data instanceof ArrayBuffer) {
      // Binary message (audio chunk)
      this.streamHandler.handleBinaryMessage(event.data);
    } else if (event.data instanceof Blob) {
      // Convert Blob to ArrayBuffer
      event.data.arrayBuffer().then((buffer) => {
        this.streamHandler.handleBinaryMessage(buffer);
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
        this.timeSyncManager.handleServerTime(message as ServerTime);
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
    this.timeSyncManager.startAndSchedule();

    // Start periodic state updates
    const stateInterval = globalThis.setInterval(
      () => this.sendStateUpdate(),
      STATE_UPDATE_INTERVAL,
    );
    this.stateManager.setStateUpdateInterval(stateInterval);
  }

  // Restart the periodic state update interval.
  // Called after volume commands to prevent a pending periodic update
  // from sending stale hardware volume shortly after the command response.
  private restartStateUpdateInterval(): void {
    const newInterval = globalThis.setInterval(
      () => this.sendStateUpdate(),
      STATE_UPDATE_INTERVAL,
    );
    this.stateManager.setStateUpdateInterval(newInterval);
  }

  stopTimeSync(): void {
    this.timeSyncManager.stop();
  }

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

    this.streamHandler.handleStreamStart(
      this.stateManager.currentStreamFormat,
      isFormatUpdate,
    );

    this.stateManager.isPlaying = true;

    // Explicitly set playbackState for Android (if mediaSession available)
    if (typeof navigator !== "undefined" && navigator.mediaSession) {
      navigator.mediaSession.playbackState = "playing";
    }
  }

  private handleStreamClear(message: StreamClear): void {
    const roles = message.payload.roles;
    if (!roles || roles.includes("player")) {
      console.log("Sendspin: Stream clear (seek)");
      this.streamHandler.handleStreamClear();
    }
  }

  private handleStreamEnd(message: StreamEnd): void {
    const roles = message.payload?.roles;
    if (!roles || roles.includes("player")) {
      console.log("Sendspin: Stream ended");
      this.streamHandler.handleStreamEnd();

      this.stateManager.currentStreamFormat = null;
      this.stateManager.isPlaying = false;

      if (typeof navigator !== "undefined" && navigator.mediaSession) {
        navigator.mediaSession.playbackState = "paused";
      }

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
          this.streamHandler.handleVolumeUpdate();
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
          this.streamHandler.handleVolumeUpdate();
          // Notify external handler for hardware volume
          if (this.useHardwareVolume && this.onVolumeCommand) {
            this.onVolumeCommand(this.stateManager.volume, playerCommand.mute);
          }
        }
        break;

      case "set_static_delay": {
        const delay = playerCommand.static_delay_ms;
        if (typeof delay === "number" && isFinite(delay)) {
          const clamped = clampSyncDelayMs(delay);
          this.streamHandler.handleSyncDelayChange(clamped);
          this.onDelayCommand?.(clamped);
        }
        break;
      }
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
          supported_formats: getSupportedFormats(this.codecs),
          buffer_capacity: this.bufferCapacity,
          supported_commands: ["volume", "mute"],
        },
      },
    };
    this.wsManager.send(hello);
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

    const syncDelayMs = this.streamHandler.getSyncDelayMs();
    const staticDelayMs = clampSyncDelayMs(syncDelayMs);

    const message: ClientState = {
      type: "client/state" as MessageType.CLIENT_STATE,
      payload: {
        player: {
          state: this.stateManager.playerState,
          volume,
          muted,
          static_delay_ms: staticDelayMs,
          supported_commands: ["set_static_delay"],
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
