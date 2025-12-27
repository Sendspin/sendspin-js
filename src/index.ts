import { AudioProcessor } from "./audio-processor";
import { ProtocolHandler } from "./protocol-handler";
import { StateManager } from "./state-manager";
import { WebSocketManager } from "./websocket-manager";
import { SendspinTimeFilter } from "./time-filter";
import type {
  SendspinPlayerConfig,
  PlayerState,
  StreamFormat,
  GoodbyeReason,
  ControllerCommand,
  ControllerCommands,
} from "./types";

// Platform detection utilities
function detectIsAndroid(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent);
}

function detectIsIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function detectIsMobile(): boolean {
  return detectIsAndroid() || detectIsIOS();
}

function generateRandomId(): string {
  return Math.random().toString(36).substring(2, 6);
}

export class SendspinPlayer {
  private wsManager: WebSocketManager;
  private audioProcessor: AudioProcessor;
  private protocolHandler: ProtocolHandler;
  private stateManager: StateManager;
  private timeFilter: SendspinTimeFilter;

  private config: SendspinPlayerConfig;
  private wsUrl: string = "";

  constructor(config: SendspinPlayerConfig) {
    // Apply defaults for playerId and clientName (share same random ID)
    const randomId = generateRandomId();
    const playerId = config.playerId ?? `sendspin-js-${randomId}`;
    const clientName = config.clientName ?? `Sendspin JS Client (${randomId})`;

    // Auto-detect platform
    const isAndroid = config.isAndroid ?? detectIsAndroid();
    const isMobile = detectIsMobile();

    // Determine output mode:
    // - If explicitly set, use that
    // - If audioElement provided, use media-element
    // - If mobile (iOS/Android), default to media-element
    // - Otherwise, use direct
    const outputMode =
      config.audioOutputMode ??
      (config.audioElement
        ? "media-element"
        : isMobile
          ? "media-element"
          : "direct");

    // Auto-create audio element for mobile if not provided and using media-element mode
    let audioElement = config.audioElement;
    if (
      outputMode === "media-element" &&
      !audioElement &&
      typeof document !== "undefined"
    ) {
      audioElement = document.createElement("audio");
      audioElement.style.display = "none";
      document.body.appendChild(audioElement);
    }

    // Store config with resolved defaults
    this.config = {
      ...config,
      playerId,
      clientName,
      isAndroid,
      audioElement,
      audioOutputMode: outputMode,
    };

    // Initialize time filter (shared between audio processor and protocol handler)
    this.timeFilter = new SendspinTimeFilter();

    // Initialize state manager with callback
    this.stateManager = new StateManager(config.onStateChange);

    // Initialize audio processor
    this.audioProcessor = new AudioProcessor(
      this.stateManager,
      this.timeFilter,
      outputMode,
      audioElement,
      isAndroid,
      config.silentAudioSrc,
      config.syncDelay ?? 0,
      config.useHardwareVolume ?? false,
    );

    // Initialize WebSocket manager
    this.wsManager = new WebSocketManager();

    // Initialize protocol handler
    this.protocolHandler = new ProtocolHandler(
      playerId,
      this.wsManager,
      this.audioProcessor,
      this.stateManager,
      this.timeFilter,
      {
        clientName,
        codecs: config.codecs,
        bufferCapacity: config.bufferCapacity,
        useHardwareVolume: config.useHardwareVolume,
        onVolumeCommand: config.onVolumeCommand,
        getExternalVolume: config.getExternalVolume,
        useOutputLatencyCompensation: config.useOutputLatencyCompensation,
      },
    );
  }

  // Connect to Sendspin server
  async connect(): Promise<void> {
    // Build WebSocket URL
    const url = new URL(this.config.baseUrl);
    const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.wsUrl = `${wsProtocol}//${url.host}/sendspin`;

    // Connect to WebSocket
    await this.wsManager.connect(
      this.wsUrl,
      // onOpen
      () => {
        console.log("Sendspin: Using player_id:", this.config.playerId);
        this.protocolHandler.sendClientHello();
      },
      // onMessage
      (event: MessageEvent) => {
        this.protocolHandler.handleMessage(event);
      },
      // onError
      (error: Event) => {
        console.error("Sendspin: WebSocket error", error);
      },
      // onClose
      () => {
        console.log("Sendspin: Connection closed");
      },
    );
  }

  /**
   * Disconnect from Sendspin server
   * @param reason - Optional reason for disconnecting (default: 'shutdown')
   *   - 'another_server': Switching to a different Sendspin server
   *   - 'shutdown': Client is shutting down
   *   - 'restart': Client is restarting and will reconnect
   *   - 'user_request': User explicitly requested to disconnect
   */
  disconnect(reason: GoodbyeReason = "shutdown"): void {
    // Send goodbye message if connected
    if (this.wsManager.isConnected()) {
      this.protocolHandler.sendGoodbye(reason);
    }

    // Clear intervals
    this.stateManager.clearAllIntervals();

    // Disconnect WebSocket
    this.wsManager.disconnect();

    // Close audio processor
    this.audioProcessor.close();

    // Reset time filter
    this.timeFilter.reset();

    // Reset state
    this.stateManager.reset();

    // Reset MediaSession playbackState (if available)
    if (typeof navigator !== "undefined" && navigator.mediaSession) {
      navigator.mediaSession.playbackState = "none";
    }
  }

  // Set volume (0-100)
  setVolume(volume: number): void {
    this.stateManager.volume = volume;
    this.audioProcessor.updateVolume();
    this.protocolHandler.sendStateUpdate();
  }

  // Set muted state
  setMuted(muted: boolean): void {
    this.stateManager.muted = muted;
    this.audioProcessor.updateVolume();
    this.protocolHandler.sendStateUpdate();
  }

  // Set sync delay (in milliseconds)
  setSyncDelay(delayMs: number): void {
    this.audioProcessor.setSyncDelay(delayMs);
  }

  // ========================================
  // Controller Commands (sent to server)
  // ========================================

  /**
   * Send a controller command to the server.
   * Use this for playback control when the server manages the audio source.
   *
   * @throws Error if the command is not supported by the server
   *
   * @example
   * // Simple commands (no parameters)
   * player.sendCommand('play');
   * player.sendCommand('pause');
   * player.sendCommand('next');
   * player.sendCommand('previous');
   * player.sendCommand('stop');
   * player.sendCommand('shuffle');
   * player.sendCommand('unshuffle');
   * player.sendCommand('repeat_off');
   * player.sendCommand('repeat_one');
   * player.sendCommand('repeat_all');
   * player.sendCommand('switch');
   *
   * // Commands with required parameters
   * player.sendCommand('volume', { volume: 50 });
   * player.sendCommand('mute', { mute: true });
   */
  sendCommand<T extends ControllerCommand>(
    command: T,
    params: ControllerCommands[T],
  ): void {
    const supportedCommands =
      this.stateManager.serverState.controller?.supported_commands;
    if (supportedCommands && !supportedCommands.includes(command)) {
      throw new Error(
        `Command '${command}' is not supported by the server. ` +
          `Supported commands: ${supportedCommands.join(", ")}`,
      );
    }
    this.protocolHandler.sendCommand(command, params);
  }

  // Getters for reactive state
  get isPlaying(): boolean {
    return this.stateManager.isPlaying;
  }

  get volume(): number {
    return this.stateManager.volume;
  }

  get muted(): boolean {
    return this.stateManager.muted;
  }

  get playerState(): PlayerState {
    return this.stateManager.playerState;
  }

  get currentFormat(): StreamFormat | null {
    return this.stateManager.currentStreamFormat;
  }

  get isConnected(): boolean {
    return this.wsManager.isConnected();
  }

  // Time sync info for debugging
  get timeSyncInfo(): { synced: boolean; offset: number; error: number } {
    return {
      synced: this.timeFilter.is_synchronized,
      offset: Math.round(this.timeFilter.offset / 1000), // ms
      error: Math.round(this.timeFilter.error / 1000), // ms
    };
  }

  // Sync info for debugging/display
  get syncInfo(): {
    clockDriftPercent: number;
    syncErrorMs: number;
    resyncCount: number;
    outputLatencyMs: number;
    playbackRate: number;
  } {
    return this.audioProcessor.syncInfo;
  }
}

// Re-export types for convenience
export * from "./types";
export { SendspinTimeFilter } from "./time-filter";

// Export platform detection utilities
export { detectIsAndroid, detectIsIOS, detectIsMobile };
