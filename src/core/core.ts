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
import { StaticDelayStore } from "./static-delay-store";
import { clampSyncDelayMs } from "../sync-delay";
import { Identity } from "./noise/identity";
import { PskStore } from "./noise/psk";
import { SendspinTransport } from "./transport";
import type { HandshakeInfo } from "./transport";
import { PairingManager } from "./pairing";
import { base64urlEncode, base64urlDecode } from "./noise/base64url";
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
  private delayStore: StaticDelayStore;

  private identity: Identity;
  private pskStore: PskStore;
  private transport: SendspinTransport;
  private pairing: PairingManager;
  private handshakeInfo: HandshakeInfo | null = null;

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
    const clientName =
      config.clientName ?? `Sendspin JS Client (${generateRandomId()})`;

    this.config = { ...config, clientName };

    // Initial delay precedence: explicit config, then persisted, then default.
    this.delayStore = new StaticDelayStore(config.storage ?? null);
    const persisted = this.delayStore.load();
    const initialDelay =
      config.syncDelay ?? persisted ?? config.defaultSyncDelay ?? 0;
    this._syncDelayMs = clampSyncDelayMs(initialDelay);

    this.timeFilter = new SendspinTimeFilter(0, 1.1, 2.0, 1e-12);
    this.stateManager = new StateManager(config.onStateChange);

    this.decoder = new SendspinDecoder(
      (chunk) => this._onAudioData?.(chunk),
      () => this.stateManager.streamGeneration,
    );

    this.wsManager = new WebSocketManager(config.reconnect);

    this.identity = Identity.loadOrCreate(config.storage ?? null);
    this.pskStore = new PskStore(config.storage ?? null);
    for (const r of config.longTermPsks ?? []) {
      this.pskStore.addLongTerm(base64urlDecode(r.psk), r.serverId);
    }

    this.transport = new SendspinTransport(
      this.wsManager,
      {
        identity: this.identity,
        pskStore: this.pskStore,
        suiteId: config.suite ?? "chacha",
        unpairedAccess: config.unpairedAccess ?? true,
      },
      {
        onHandshakeComplete: (info) => {
          this.handshakeInfo = info;
        },
        onControlMessage: (msg) => this.routeControl(msg),
        onBinaryMessage: (bytes) =>
          this.handleBinaryMessage(bytes.buffer as ArrayBuffer),
      },
    );

    this.pairing = new PairingManager({
      sendControl: (m) => this.transport.sendControl(m),
      close: () => this.transport.close(),
      pskStore: this.pskStore,
      serverId: () => this.handshakeInfo?.serverId ?? "",
      matchedCategory: () => this.handshakeInfo?.category ?? "sentinel",
      onEvent: (e, d) => this.config.onPairing?.(e, d),
    });

    const helloContext = {
      trustLevel: () => this.handshakeInfo?.trustLevel ?? "none",
      pairingAvailable: () => this.identity.persistent,
      unpairedAccess: config.unpairedAccess ?? true,
    };

    this.protocolHandler = new ProtocolHandler(
      this.transport,
      helloContext,
      this, // this class implements StreamHandler
      this.stateManager,
      this.timeFilter,
      {
        clientName,
        codecs: config.codecs,
        bufferCapacity: config.bufferCapacity,
        requiredLeadTimeMs: config.requiredLeadTimeMs,
        minBufferMs: config.minBufferMs,
        useHardwareVolume: config.useHardwareVolume,
        onVolumeCommand: config.onVolumeCommand,
        onDelayCommand: config.onDelayCommand,
        getExternalVolume: config.getExternalVolume,
      },
    );
  }

  // Route decrypted control messages from the transport. Pairing consumes its
  // own activate/finalize/abort; everything else goes to the protocol handler.
  private routeControl(msg: { type: string; payload?: unknown }): void {
    if (msg.type === "server/activate") {
      const p = (msg.payload ?? {}) as {
        activities?: string[];
        selected_pair_method?: string;
      };
      const consumed = this.pairing.onActivate(
        p.activities ?? [],
        p.selected_pair_method,
      );
      if (!consumed) this.protocolHandler.handleServerMessage(msg as never);
      return;
    }
    if (msg.type === "server/pair-finalize")
      return this.pairing.onPairFinalize();
    if (msg.type === "pair/abort") {
      return this.pairing.onAbort(
        ((msg.payload ?? {}) as { reason?: string }).reason ?? "",
      );
    }
    this.protocolHandler.handleServerMessage(msg as never);
  }

  private onTransportClose(): void {
    this.protocolHandler.stopTimeSync();
    this.protocolHandler.resetActivation();
    this.pairing.reset();
    // Stop periodic state-update sends so they don't spam
    // "WebSocket not connected" warnings after the transport is gone.
    this.stateManager.clearStateUpdateInterval();
    console.log("Sendspin: Connection closed");
    this._onConnectionClose?.();
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

  private applyDelay(delayMs: number): void {
    this._syncDelayMs = clampSyncDelayMs(delayMs);
    this.delayStore.save(this._syncDelayMs);
    this._onSyncDelayChange?.(this._syncDelayMs);
  }

  handleSyncDelayChange(delayMs: number): void {
    this.applyDelay(delayMs);
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
      this.transport.start();
    };
    const onMessage = (event: MessageEvent) => {
      this.transport.handleRaw(event);
    };
    const onError = (error: Event) => {
      console.error("Sendspin: WebSocket error", error);
    };
    const onClose = () => this.onTransportClose();

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
      const wsUrl = basePath.endsWith("/sendspin")
        ? `${wsProtocol}//${url.host}${basePath}`
        : `${wsProtocol}//${url.host}${basePath}/sendspin`;

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

  disconnect(reason: GoodbyeReason = "restart"): void {
    if (this.transport.ready) {
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
    this.applyDelay(delayMs);
    this.protocolHandler.sendStateUpdate();
  }

  // ========================================
  // Buffer timing
  // ========================================

  setRequiredLeadTimeMs(leadTimeMs: number): void {
    this.protocolHandler.setRequiredLeadTimeMs(leadTimeMs);
  }

  setMinBufferMs(minBufferMs: number): void {
    this.protocolHandler.setMinBufferMs(minBufferMs);
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

  // ========================================
  // Identity / pairing
  // ========================================

  get clientId(): string {
    return this.identity.clientId;
  }

  /** The client's Pairing PSK (base64url), for the operator to enter into the server. Null without storage. */
  get pairingPsk(): string | null {
    return this.identity.persistent
      ? base64urlEncode(this.pskStore.getOrCreatePairingPsk())
      : null;
  }

  rotatePairingPsk(): string | null {
    if (!this.identity.persistent) return null;
    this.pskStore.rotatePairingPsk();
    return this.pairingPsk;
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

    const trackDuration = metadata.progress.track_duration;
    return {
      // track_duration 0 means unbounded (live radio), so floor at 0 only.
      positionMs:
        trackDuration === 0
          ? Math.max(0, positionMs)
          : Math.max(0, Math.min(positionMs, trackDuration)),
      durationMs: trackDuration,
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
