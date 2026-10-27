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
  ServerActivate,
  ServerMessage,
  ServerState,
  ServerTime,
  StreamClear,
  StreamEnd,
  StreamStart,
  SupportedPairMethods,
} from "../types";
import type { StreamHandler } from "../internal-types";
import { clampVolume, type StateManager } from "./state-manager";
import { TimeSyncManager } from "./time-sync-manager";
import { getDefaultBufferCapacity, getSupportedFormats } from "./codec-support";
import { clampSyncDelayMs } from "../sync-delay";

// Constants
const STATE_UPDATE_INTERVAL = 5000; // 5 seconds

const DEFAULT_REQUIRED_LEAD_TIME_MS = 250;
const DEFAULT_MIN_BUFFER_MS = 250;

const PLAYER_COMMANDS = ["volume", "mute", "set_output_delay"] as const;

function toBufferMs(value: number, name: string): number {
  if (!isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return Math.round(value);
}

export interface MessageSender {
  sendControl(msg: object): void;
}

export interface HelloContext {
  trustLevel(): "user" | "none";
  pairMethods(): SupportedPairMethods;
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
  private bufferCapacity: number | undefined;
  private requiredLeadTimeMs: number;
  private minBufferMs: number;
  private useHardwareVolume: boolean;
  private onVolumeCommand?: (volume: number, muted: boolean) => void;
  private onDelayCommand?: (delayMs: number) => void;
  private getExternalVolume?: () => { volume: number; muted: boolean };
  private timeSyncManager: TimeSyncManager;
  private activated = false;
  private activeRoles: Set<string> | null = null;
  private lastSentState: string | null = null;

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
    // Left undefined so the capacity is derived from the formats actually
    // advertised in client/hello (see sendClientHello).
    this.bufferCapacity =
      config.bufferCapacity === undefined
        ? undefined
        : Math.round(config.bufferCapacity);
    this.requiredLeadTimeMs = toBufferMs(
      config.requiredLeadTimeMs ?? DEFAULT_REQUIRED_LEAD_TIME_MS,
      "requiredLeadTimeMs",
    );
    this.minBufferMs = toBufferMs(
      config.minBufferMs ?? DEFAULT_MIN_BUFFER_MS,
      "minBufferMs",
    );
    this.useHardwareVolume = config.useHardwareVolume ?? false;
    this.onVolumeCommand = config.onVolumeCommand;
    this.onDelayCommand = config.onDelayCommand;
    this.getExternalVolume = config.getExternalVolume;
    this.timeSyncManager = new TimeSyncManager(
      sender,
      stateManager,
      timeFilter,
      () => this.sendStateUpdate(),
    );
  }

  // Handle server messages
  handleServerMessage(message: ServerMessage, receivedAtUs: number): void {
    switch (message.type) {
      case "server/hello":
        this.handleServerHello();
        break;

      case "server/activate":
        this.handleServerActivate(message as ServerActivate);
        break;

      case "server/time":
        this.timeSyncManager.handleServerTime(
          message as ServerTime,
          receivedAtUs,
        );
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
        this.handleServerState(message as ServerState);
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
  // periodic state updates. A repeat activate only applies role changes.
  private handleServerActivate(message: ServerActivate): void {
    let rolesChanged = false;
    if (message.payload.active_roles !== undefined) {
      const nextRoles = new Set(message.payload.active_roles);
      const removedRoles = [...(this.activeRoles ?? [])].filter(
        (role) => !nextRoles.has(role),
      );
      rolesChanged =
        this.activeRoles === null ||
        removedRoles.length > 0 ||
        nextRoles.size !== this.activeRoles.size;
      this.activeRoles = nextRoles;
      if (
        removedRoles.includes("player@v1") &&
        this.stateManager.currentStreamFormat !== null
      ) {
        this.endPlayerStream();
      }
      this.stateManager.discardRoleState(
        removedRoles.map((role) => role.split("@")[0]),
      );
    }
    if (this.activated) {
      if (rolesChanged) this.sendStateUpdate();
      return;
    }
    this.activated = true;
    this.lastSentState = null;
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

  /**
   * Clear the activate guard so the next server/activate (e.g. after a reconnect on a
   * reused handler) restarts time-sync and state updates.
   * @internal called by SendspinCore on transport close, not part of the public API.
   */
  resetActivation(preserveActiveRoles = false): void {
    this.activated = false;
    if (!preserveActiveRoles) this.activeRoles = null;
    this.timeSyncManager.stop();
    this.stateManager.clearStateUpdateInterval();
  }

  // Without a time sync measurement the filter has no estimate to translate
  // the metadata timestamp with, so the update applies immediately.
  private handleServerState(message: ServerState): void {
    const { metadata } = message.payload;
    let metadataDelayMs = 0;
    if (metadata && this.timeFilter.count > 0) {
      const localUs = this.timeFilter.computeClientTime(metadata.timestamp);
      metadataDelayMs = (localUs - performance.now() * 1000) / 1000;
    }
    this.stateManager.updateServerState(message.payload, metadataDelayMs);
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
      this.endPlayerStream();
    }
  }

  private endPlayerStream(): void {
    this.streamHandler.handleStreamEnd();

    this.stateManager.currentStreamFormat = null;
    this.stateManager.isPlaying = false;

    if (typeof navigator !== "undefined" && navigator.mediaSession) {
      navigator.mediaSession.playbackState = "paused";
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

      case "set_output_delay": {
        const delay = playerCommand.output_delay_ms;
        if (typeof delay === "number" && isFinite(delay)) {
          const clamped = clampSyncDelayMs(delay);
          this.streamHandler.handleSyncDelayChange(clamped);
          this.onDelayCommand?.(clamped);
        }
        break;
      }

      default:
        return;
    }

    // Reset periodic timer first, then send state with commanded values.
    // Skip hardware read to avoid race where hardware hasn't applied the volume yet.
    this.restartStateUpdateInterval();
    this.sendStateUpdate(true);
  }

  // client_id and version live in client/init, not the hello.
  sendClientHello(): void {
    const supportedFormats = getSupportedFormats(this.codecs);
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
          supported_formats: supportedFormats,
          buffer_capacity:
            this.bufferCapacity ?? getDefaultBufferCapacity(supportedFormats),
          supported_commands: ["volume", "mute"],
        },
      },
    };
    this.sender.sendControl(hello);
  }

  setRequiredLeadTimeMs(leadTimeMs: number): void {
    this.requiredLeadTimeMs = toBufferMs(leadTimeMs, "requiredLeadTimeMs");
    this.sendStateUpdate();
  }

  setMinBufferMs(minBufferMs: number): void {
    this.minBufferMs = toBufferMs(minBufferMs, "minBufferMs");
    this.sendStateUpdate();
  }

  // Send the full state, skipped when identical to the last one sent.
  // When skipHardwareRead is true, use stateManager values instead of reading from hardware.
  // This avoids race conditions when responding to volume commands.
  sendStateUpdate(skipHardwareRead = false): void {
    if (!this.activated) return;
    let volume = this.stateManager.volume;
    let muted = this.stateManager.muted;
    if (!skipHardwareRead && this.useHardwareVolume && this.getExternalVolume) {
      const externalVol = this.getExternalVolume();
      if (!Number.isNaN(externalVol.volume))
        volume = clampVolume(externalVol.volume);
      muted = externalVol.muted;
    }

    const payload: ClientState["payload"] = {
      available: this.timeFilter.is_synchronized,
    };
    if (this.activeRoles?.has("player@v1")) {
      payload.player = {
        volume,
        muted,
        output_delay_ms: clampSyncDelayMs(this.streamHandler.getSyncDelayMs()),
        required_lead_time_ms: this.requiredLeadTimeMs,
        min_buffer_ms: this.minBufferMs,
        supported_commands: [...PLAYER_COMMANDS],
      };
    }

    const serialized = JSON.stringify(payload);
    if (serialized === this.lastSentState) return;
    this.lastSentState = serialized;

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
    if (!this.activeRoles?.has("controller@v1")) return;
    let fields = params as object;
    if (command === "volume") {
      const { volume } = params as ControllerCommands["volume"];
      fields = { volume: clampVolume(volume) };
    } else if (command === "seek") {
      const { position_ms } = params as ControllerCommands["seek"];
      const max =
        this.stateManager.serverState.controller?.seek_max_ms ?? Infinity;
      fields = {
        position_ms: Math.min(max, Math.max(0, Math.round(position_ms))),
      };
    } else if (command === "seek_relative") {
      const { offset_ms } = params as ControllerCommands["seek_relative"];
      fields = { offset_ms: Math.round(offset_ms) };
    }
    this.sender.sendControl({
      type: "client/command" as MessageType.CLIENT_COMMAND,
      payload: {
        controller: {
          command,
          ...fields,
        },
      },
    } satisfies ClientCommand);
  }
}
