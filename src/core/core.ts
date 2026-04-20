/**
 * SendspinCore: Protocol + decoding layer.
 *
 * Manages the WebSocket connection, Sendspin protocol, time synchronization,
 * state management, and audio decoding. Emits decoded PCM audio chunks that
 * can be consumed by SendspinPlayer for playback, or by visualization/analysis
 * tools directly.
 */

import { SendspinDecoder } from "../audio/decoder";
import { ProtocolHandler } from "./protocol-handler";
import { StateManager } from "./state-manager";
import { WebSocketManager } from "./websocket-manager";
import { SendspinTimeFilter } from "./time-filter";
import { clampSyncDelayMs } from "../sync-delay";
import type {
  SendspinCoreConfig,
  DecodedAudioChunk,
  StreamFormat,
  GoodbyeReason,
  PlayerState,
  ControllerCommand,
  ControllerCommands,
  ServerStatePayload,
  GroupUpdatePayload,
} from "../types";
import type { StreamHandler } from "../internal-types";

function generateRandomId(): string {
  return Math.random().toString(36).substring(2, 6);
}

export class SendspinCore implements StreamHandler {
  private wsManager: WebSocketManager;
  private protocolHandler: ProtocolHandler;
  private stateManager: StateManager;
  private timeFilter: SendspinTimeFilter;
  private decoder: SendspinDecoder;

  private config: SendspinCoreConfig;
  private _syncDelayMs: number;

  // Stream events — consumers (e.g., SendspinPlayer) subscribe to these
  private _onAudioData?: (chunk: DecodedAudioChunk) => void;
  private _onStreamStart?: (
    format: StreamFormat,
    isFormatUpdate: boolean,
  ) => void;
  private _onStreamClear?: () => void;
  private _onStreamEnd?: () => void;
  private _onVolumeUpdate?: () => void;
  private _onSyncDelayChange?: (delayMs: number) => void;
  private _onConnectionOpen?: () => void;
  private _onConnectionClose?: () => void;

  constructor(config: SendspinCoreConfig) {
    const randomId = generateRandomId();
    const playerId = config.playerId ?? `sendspin-js-${randomId}`;
    const clientName = config.clientName ?? `Sendspin JS Client (${randomId})`;

    this.config = { ...config, playerId, clientName };
    this._syncDelayMs = clampSyncDelayMs(config.syncDelay ?? 0);

    this.timeFilter = new SendspinTimeFilter(0, 1.1, 2.0, 1e-12);
    this.stateManager = new StateManager(config.onStateChange);

    this.decoder = new SendspinDecoder(
      (chunk) => this._onAudioData?.(chunk),
      () => this.stateManager.streamGeneration,
    );

    this.wsManager = new WebSocketManager();

    this.protocolHandler = new ProtocolHandler(
      playerId,
      this.wsManager,
      this, // this class implements StreamHandler
      this.stateManager,
      this.timeFilter,
      {
        clientName,
        codecs: config.codecs,
        bufferCapacity: config.bufferCapacity,
        useHardwareVolume: config.useHardwareVolume,
        onVolumeCommand: config.onVolumeCommand,
        onDelayCommand: config.onDelayCommand,
        getExternalVolume: config.getExternalVolume,
      },
    );
  }

  // ========================================
  // StreamHandler implementation
  // (called by ProtocolHandler)
  // ========================================

  handleBinaryMessage(data: ArrayBuffer): void {
    const format = this.stateManager.currentStreamFormat;
    if (!format) {
      console.warn("Sendspin: Received audio chunk but no stream format set");
      return;
    }
    const generation = this.stateManager.streamGeneration;
    this.decoder.handleBinaryMessage(data, format, generation);
  }

  handleStreamStart(format: StreamFormat, isFormatUpdate: boolean): void {
    if (!isFormatUpdate) {
      this.decoder.clearState();
    }
    this._onStreamStart?.(format, isFormatUpdate);
  }

  handleStreamClear(): void {
    this.decoder.clearState();
    this._onStreamClear?.();
  }

  handleStreamEnd(): void {
    this.decoder.clearState();
    this._onStreamEnd?.();
  }

  handleVolumeUpdate(): void {
    this._onVolumeUpdate?.();
  }

  handleSyncDelayChange(delayMs: number): void {
    this._syncDelayMs = clampSyncDelayMs(delayMs);
    this._onSyncDelayChange?.(this._syncDelayMs);
  }

  getSyncDelayMs(): number {
    return this._syncDelayMs;
  }

  // ========================================
  // Event registration
  // ========================================

  set onAudioData(cb: ((chunk: DecodedAudioChunk) => void) | undefined) {
    this._onAudioData = cb;
  }
  set onStreamStart(
    cb: ((format: StreamFormat, isFormatUpdate: boolean) => void) | undefined,
  ) {
    this._onStreamStart = cb;
  }
  set onStreamClear(cb: (() => void) | undefined) {
    this._onStreamClear = cb;
  }
  set onStreamEnd(cb: (() => void) | undefined) {
    this._onStreamEnd = cb;
  }
  set onVolumeUpdate(cb: (() => void) | undefined) {
    this._onVolumeUpdate = cb;
  }
  set onSyncDelayChange(cb: ((delayMs: number) => void) | undefined) {
    this._onSyncDelayChange = cb;
  }
  set onConnectionOpen(cb: (() => void) | undefined) {
    this._onConnectionOpen = cb;
  }
  set onConnectionClose(cb: (() => void) | undefined) {
    this._onConnectionClose = cb;
  }

  // ========================================
  // Connection
  // ========================================

  async connect(): Promise<void> {
    const onOpen = () => {
      this._onConnectionOpen?.();
      console.log("Sendspin: Using player_id:", this.config.playerId);
      this.protocolHandler.sendClientHello();
    };
    const onMessage = (event: MessageEvent) => {
      this.protocolHandler.handleMessage(event);
    };
    const onError = (error: Event) => {
      console.error("Sendspin: WebSocket error", error);
    };
    const onClose = () => {
      this.protocolHandler.stopTimeSync();
      // Stop periodic state-update sends so they don't spam
      // "WebSocket not connected" warnings after the transport is gone.
      this.stateManager.clearStateUpdateInterval();
      console.log("Sendspin: Connection closed");
      this._onConnectionClose?.();
    };

    if (this.config.webSocket) {
      // Adopt externally-managed WebSocket
      await this.wsManager.adopt(
        this.config.webSocket,
        onOpen,
        onMessage,
        onError,
        onClose,
      );
    } else {
      // Create connection from baseUrl
      if (!this.config.baseUrl) {
        throw new Error(
          "SendspinCore requires either baseUrl or webSocket to be provided.",
        );
      }
      // Preserve path from baseUrl for reverse proxy support
      const url = new URL(
        this.config.baseUrl,
        typeof window !== "undefined" ? window.location.href : undefined,
      );
      const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
      const basePath = url.pathname.replace(/\/$/, "");
      const wsUrl = `${wsProtocol}//${url.host}${basePath}/sendspin`;

      await this.wsManager.connect(wsUrl, onOpen, onMessage, onError, onClose);
    }
  }

  /**
   * Reset playback-related state (isPlaying, currentStreamFormat) without
   * tearing down the connection. Intended for transport-loss cleanup after
   * any buffered audio has finished draining.
   */
  resetPlaybackState(): void {
    this.stateManager.isPlaying = false;
    this.stateManager.currentStreamFormat = null;
  }

  disconnect(reason: GoodbyeReason = "shutdown"): void {
    if (this.wsManager.isConnected()) {
      this.protocolHandler.sendGoodbye(reason);
    }
    this.protocolHandler.stopTimeSync();
    this.stateManager.clearAllIntervals();
    this.wsManager.disconnect();
    this.decoder.close();
    this.timeFilter.reset();
    this.stateManager.reset();
  }

  // ========================================
  // Volume / Mute
  // ========================================

  setVolume(volume: number): void {
    this.stateManager.volume = volume;
    this._onVolumeUpdate?.();
    this.protocolHandler.sendStateUpdate();
  }

  setMuted(muted: boolean): void {
    this.stateManager.muted = muted;
    this._onVolumeUpdate?.();
    this.protocolHandler.sendStateUpdate();
  }

  // ========================================
  // Sync delay
  // ========================================

  setSyncDelay(delayMs: number): void {
    this._syncDelayMs = clampSyncDelayMs(delayMs);
    this._onSyncDelayChange?.(this._syncDelayMs);
    this.protocolHandler.sendStateUpdate();
  }

  // ========================================
  // Controller commands
  // ========================================

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

  // ========================================
  // State getters
  // ========================================

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

  get timeSyncInfo(): { synced: boolean; offset: number; error: number } {
    return {
      synced: this.timeFilter.is_synchronized,
      offset: Math.round(this.timeFilter.offset / 1000),
      error: Math.round(this.timeFilter.error / 1000),
    };
  }

  getCurrentServerTimeUs(): number {
    return this.timeFilter.computeServerTime(
      Math.floor(performance.now() * 1000),
    );
  }

  get trackProgress(): {
    positionMs: number;
    durationMs: number;
    playbackSpeed: number;
  } | null {
    const metadata = this.stateManager.serverState.metadata;
    if (!metadata?.progress || metadata.timestamp === undefined) {
      return null;
    }

    const serverTimeUs = this.getCurrentServerTimeUs();
    const elapsedUs = serverTimeUs - metadata.timestamp;
    const positionMs =
      metadata.progress.track_progress +
      (elapsedUs * metadata.progress.playback_speed) / 1_000_000;

    return {
      positionMs: Math.max(
        0,
        Math.min(positionMs, metadata.progress.track_duration),
      ),
      durationMs: metadata.progress.track_duration,
      playbackSpeed: metadata.progress.playback_speed / 1000,
    };
  }

  // ========================================
  // Internal accessors (for SendspinPlayer)
  // ========================================

  /** @internal */
  get _stateManager(): StateManager {
    return this.stateManager;
  }

  /** @internal */
  get _timeFilter(): SendspinTimeFilter {
    return this.timeFilter;
  }
}
