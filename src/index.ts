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

export class SendspinPlayer {
  private wsManager: WebSocketManager;
  private audioProcessor: AudioProcessor;
  private protocolHandler: ProtocolHandler;
  private stateManager: StateManager;
  private timeFilter: SendspinTimeFilter;

  private config: SendspinPlayerConfig;
  private wsUrl: string = "";

  constructor(config: SendspinPlayerConfig) {
    this.config = config;

    // Initialize time filter (shared between audio processor and protocol handler)
    this.timeFilter = new SendspinTimeFilter();

    // Initialize state manager with callback
    this.stateManager = new StateManager(config.onStateChange);

    // Determine output mode (default to media-element if audioElement provided, otherwise direct)
    const outputMode =
      config.audioOutputMode ??
      (config.audioElement ? "media-element" : "direct");

    // Initialize audio processor
    this.audioProcessor = new AudioProcessor(
      this.stateManager,
      this.timeFilter,
      outputMode,
      config.audioElement,
      config.isAndroid ?? false,
      config.silentAudioSrc,
      config.syncDelay ?? 0,
      config.useHardwareVolume ?? false,
    );

    // Initialize WebSocket manager
    this.wsManager = new WebSocketManager();

    // Initialize protocol handler
    this.protocolHandler = new ProtocolHandler(
      config.playerId,
      this.wsManager,
      this.audioProcessor,
      this.stateManager,
      this.timeFilter,
      {
        clientName: config.clientName,
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
