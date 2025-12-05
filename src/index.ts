import { AudioProcessor } from "./audio-processor";
import { ProtocolHandler } from "./protocol-handler";
import { StateManager } from "./state-manager";
import { WebSocketManager } from "./websocket-manager";
import { SendspinTimeFilter } from "./time-filter";
import type { SendspinPlayerConfig, PlayerState, StreamFormat } from "./types";

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
    const outputMode = config.audioOutputMode ?? (config.audioElement ? "media-element" : "direct");

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
        supportedFormats: config.supportedFormats,
        bufferCapacity: config.bufferCapacity,
        useHardwareVolume: config.useHardwareVolume,
        onVolumeCommand: config.onVolumeCommand,
        getExternalVolume: config.getExternalVolume,
        timeSyncInterval: config.timeSyncInterval,
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
        console.log("Experimental Sendspin: Using player_id:", this.config.playerId);
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

  // Disconnect from Sendspin server
  disconnect(): void {
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
  } {
    return this.audioProcessor.syncInfo;
  }
}

// Re-export types for convenience
export * from "./types";
export { SendspinTimeFilter } from "./time-filter";
