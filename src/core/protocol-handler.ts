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
  PairMethodDescriptor,
  ServerCommand,
  ServerActivate,
  ServerMessage,
  ServerState,
  ServerTime,
  StreamClear,
  StreamEnd,
  StreamStart,
} from "../types";
import type { StreamHandler } from "../internal-types";
import type { StateManager } from "./state-manager";
import { TimeSyncManager } from "./time-sync-manager";
import { getSupportedFormats } from "./codec-support";
import { clampSyncDelayMs } from "../sync-delay";

// Constants
const STATE_UPDATE_INTERVAL = 5000; // 5 seconds

const DEFAULT_REQUIRED_LEAD_TIME_MS = 250;
const DEFAULT_MIN_BUFFER_MS = 250;

function assertBufferMs(value: number, name: string): void {
  if (!isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}

export interface MessageSender {
  sendControl(msg: object): void;
}

export interface HelloContext {
  trustLevel(): "user" | "none";
  /** Pairing-method descriptors for client/hello ([] = pairing unavailable). */
  pairMethods(): PairMethodDescriptor[];
  unpairedAccess: boolean;
}

export interface ProtocolHandlerConfig {
  clientName?: string;
  productName?: string;
  codecs?: Codec[];
  bufferCapacity?: number;
  requiredLeadTimeMs?: number;
  minBufferMs?: number;
  useHardwareVolume?: boolean;
  onVolumeCommand?: (volume: number, muted: boolean) => void;
  onDelayCommand?: (delayMs: number) => void;
  getExternalVolume?: () => { volume: number; muted: boolean };
}

export class ProtocolHandler {
  private clientName: string;
  private productName?: string;
  private codecs: Codec[];
  private bufferCapacity: number;
  private requiredLeadTimeMs: number;
  private minBufferMs: number;
  private useHardwareVolume: boolean;
  private onVolumeCommand?: (volume: number, muted: boolean) => void;
  private onDelayCommand?: (delayMs: number) => void;
  private getExternalVolume?: () => { volume: number; muted: boolean };
  private timeSyncManager: TimeSyncManager;
  private activated = false;
  private activeRoles: Set<string> | null = null;
  private pairingSuspended = false;

  constructor(
    private sender: MessageSender,
    private helloContext: HelloContext,
    private streamHandler: StreamHandler,
    private stateManager: StateManager,
    private timeFilter: SendspinTimeFilter,
    config: ProtocolHandlerConfig = {},
  ) {
    this.clientName = config.clientName ?? "Sendspin Player";
    this.productName = config.productName;
    this.codecs = config.codecs ?? ["opus", "flac", "pcm"];
    this.bufferCapacity = config.bufferCapacity ?? 1024 * 1024 * 5; // 5MB default
    this.requiredLeadTimeMs =
      config.requiredLeadTimeMs ?? DEFAULT_REQUIRED_LEAD_TIME_MS;
    assertBufferMs(this.requiredLeadTimeMs, "requiredLeadTimeMs");
    this.minBufferMs = config.minBufferMs ?? DEFAULT_MIN_BUFFER_MS;
    assertBufferMs(this.minBufferMs, "minBufferMs");
    this.useHardwareVolume = config.useHardwareVolume ?? false;
    this.onVolumeCommand = config.onVolumeCommand;
    this.onDelayCommand = config.onDelayCommand;
    this.getExternalVolume = config.getExternalVolume;
    this.timeSyncManager = new TimeSyncManager(
      sender,
      stateManager,
      timeFilter,
    );
  }

  // Handle server messages
  handleServerMessage(message: ServerMessage): void {
    switch (message.type) {
      case "server/hello":
        this.handleServerHello();
        break;

      case "server/activate":
        this.handleServerActivate(message as ServerActivate);
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

  // Handle server hello: reply with client/hello. client/state and time-sync
  // are deferred to server/activate.
  private handleServerHello(): void {
    console.log("Sendspin: Connected to server");
    this.sendClientHello();
  }

  // Handle server/activate: start the initial client/state, time-sync, and
  // periodic state updates. Guarded so a repeat activate is a no-op.
  private handleServerActivate(message: ServerActivate): void {
    this.pairingSuspended = false;
    let rolesChanged = false;
    if (message.payload.active_roles !== undefined) {
      const nextRoles = new Set(message.payload.active_roles);
      rolesChanged =
        this.activeRoles === null ||
        nextRoles.size !== this.activeRoles.size ||
        [...nextRoles].some((role) => !this.activeRoles!.has(role));
      this.activeRoles = nextRoles;
    }
    if (this.activated) {
      if (rolesChanged) this.sendStateUpdate();
      return;
    }
    this.activated = true;
    this.sendStateUpdate();
    this.timeSyncManager.startAndSchedule();

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

  suspendForPairing(): void {
    this.pairingSuspended = true;
    this.activated = false;
    this.activeRoles = new Set();
    this.timeSyncManager.stop();
    this.stateManager.clearStateUpdateInterval();
  }

  /**
   * Clear the activate guard so the next server/activate (e.g. after a reconnect on a
   * reused handler) restarts time-sync and state updates.
   * @internal called by SendspinCore on transport close, not part of the public API.
   */
  resetActivation(preserveActiveRoles = false): void {
    this.pairingSuspended = false;
    this.activated = false;
    if (!preserveActiveRoles) this.activeRoles = null;
    this.timeSyncManager.stop();
    this.stateManager.clearStateUpdateInterval();
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

  // client_id and version live in client/init, not the hello.
  sendClientHello(): void {
    const hello: ClientHello = {
      type: "client/hello" as MessageType.CLIENT_HELLO,
      payload: {
        name: this.clientName,
        supported_roles: ["player@v1", "controller@v1", "metadata@v1"],
        trust_level: this.helloContext.trustLevel(),
        supported_pair_methods: this.helloContext.pairMethods(),
        unpaired_access: { enabled: this.helloContext.unpairedAccess },
        device_info: {
          product_name: this.productName,
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
    this.sender.sendControl(hello);
  }

  setRequiredLeadTimeMs(leadTimeMs: number): void {
    assertBufferMs(leadTimeMs, "requiredLeadTimeMs");
    this.requiredLeadTimeMs = leadTimeMs;
    this.sendStateUpdate();
  }

  setMinBufferMs(minBufferMs: number): void {
    assertBufferMs(minBufferMs, "minBufferMs");
    this.minBufferMs = minBufferMs;
    this.sendStateUpdate();
  }

  // Send state update
  // When skipHardwareRead is true, use stateManager values instead of reading from hardware.
  // This avoids race conditions when responding to volume commands.
  sendStateUpdate(skipHardwareRead = false): void {
    if (this.pairingSuspended) return;
    let volume = this.stateManager.volume;
    let muted = this.stateManager.muted;
    if (!skipHardwareRead && this.useHardwareVolume && this.getExternalVolume) {
      const externalVol = this.getExternalVolume();
      volume = externalVol.volume;
      muted = externalVol.muted;
    }

    const syncDelayMs = this.streamHandler.getSyncDelayMs();
    const staticDelayMs = clampSyncDelayMs(syncDelayMs);

    const payload: ClientState["payload"] = {
      available: true,
    };
    if (this.activeRoles === null || this.activeRoles.has("player@v1")) {
      payload.player = {
        volume,
        muted,
        static_delay_ms: staticDelayMs,
        required_lead_time_ms: this.requiredLeadTimeMs,
        min_buffer_ms: this.minBufferMs,
        supported_commands: ["set_static_delay"],
      };
    }

    const message: ClientState = {
      type: "client/state" as MessageType.CLIENT_STATE,
      payload,
    };
    this.sender.sendControl(message);
  }

  // Send goodbye message before disconnecting
  sendGoodbye(reason: GoodbyeReason): void {
    this.sender.sendControl({
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
    if (this.pairingSuspended || !this.activeRoles?.has("controller@v1"))
      return;
    this.sender.sendControl({
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
