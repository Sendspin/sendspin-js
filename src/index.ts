import { SendspinCore } from "./core/core";
import { AudioScheduler } from "./audio/scheduler";
import { SILENT_AUDIO_SRC } from "./silent-audio.generated";
import type {
  SendspinPlayerConfig,
  SendspinStorage,
  PlayerState,
  StreamFormat,
  GoodbyeReason,
  ControllerCommand,
  ControllerCommands,
  CorrectionMode,
} from "./types";

// Platform detection utilities
function detectIsAndroid(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent);
}

function detectIsIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function detectIsMobile(): boolean {
  return detectIsAndroid() || detectIsIOS();
}

function detectIsSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /Safari/i.test(ua) && !/Chrome/i.test(ua);
}

function detectIsMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Macintosh/i.test(navigator.userAgent);
}

function detectIsWindows(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Windows/i.test(navigator.userAgent);
}

/**
 * Get platform-specific default static delay in milliseconds.
 * Based on testing across various platforms and browsers.
 */
function getDefaultSyncDelay(): number {
  if (detectIsIOS()) return 250;
  if (detectIsAndroid()) return 200;
  if (detectIsMac()) return detectIsSafari() ? 190 : 150;
  if (detectIsWindows()) return 250;
  // Linux and others
  return 200;
}

export class SendspinPlayer {
  private core: SendspinCore;
  private scheduler: AudioScheduler;
  private ownsAudioElement = false;

  constructor(config: SendspinPlayerConfig) {
    // Auto-detect platform
    const isAndroid = detectIsAndroid();
    const isMobile = detectIsMobile();

    // Determine output mode
    const outputMode =
      config.audioElement || isMobile ? "media-element" : "direct";
    this.ownsAudioElement =
      outputMode === "media-element" && !config.audioElement;

    if (this.ownsAudioElement && typeof document === "undefined") {
      throw new Error(
        "SendspinPlayer requires a DOM document to use media-element output without a provided audioElement.",
      );
    }

    const syncDelay = config.syncDelay ?? getDefaultSyncDelay();

    // Create core (protocol + decoding)
    this.core = new SendspinCore({
      playerId: config.playerId,
      baseUrl: config.baseUrl,
      clientName: config.clientName,
      webSocket: config.webSocket,
      codecs: config.codecs,
      bufferCapacity:
        config.bufferCapacity ??
        (outputMode === "media-element" ? 1024 * 1024 * 5 : 1024 * 1024 * 1.5),
      syncDelay,
      useHardwareVolume: config.useHardwareVolume,
      onVolumeCommand: config.onVolumeCommand,
      onDelayCommand: config.onDelayCommand,
      getExternalVolume: config.getExternalVolume,
      onStateChange: config.onStateChange,
    });

    // Create scheduler (Web Audio playback)
    let storage: SendspinStorage | null = null;
    if (config.storage !== undefined) {
      storage = config.storage;
    } else if (typeof localStorage !== "undefined") {
      storage = localStorage;
    }

    this.scheduler = new AudioScheduler(
      this.core._stateManager,
      this.core._timeFilter,
      outputMode,
      config.audioElement,
      isAndroid,
      this.ownsAudioElement,
      isAndroid ? SILENT_AUDIO_SRC : undefined,
      syncDelay,
      config.useHardwareVolume ?? false,
      config.correctionMode ?? "sync",
      storage,
      config.useOutputLatencyCompensation ?? true,
      config.correctionThresholds,
    );

    // Wire core events to scheduler
    this.core.onAudioData = (chunk) => {
      this.scheduler.handleDecodedChunk(chunk);
    };

    this.core.onStreamStart = (format, isFormatUpdate) => {
      this.scheduler.initAudioContext();
      this.scheduler.resumeAudioContext();
      if (!isFormatUpdate) {
        this.scheduler.clearBuffers();
      }
      this.scheduler.startAudioElement();
    };

    this.core.onStreamClear = () => {
      this.scheduler.clearBuffers();
    };

    this.core.onStreamEnd = () => {
      this.scheduler.clearBuffers();
      this.scheduler.stopAudioElement();
    };

    this.core.onVolumeUpdate = () => {
      this.scheduler.updateVolume();
    };

    this.core.onSyncDelayChange = (delayMs) => {
      this.scheduler.setSyncDelay(delayMs);
    };
  }

  // Connect to Sendspin server
  async connect(): Promise<void> {
    return this.core.connect();
  }

  /**
   * Disconnect from Sendspin server
   * @param reason - Optional reason for disconnecting (default: 'shutdown')
   */
  disconnect(reason: GoodbyeReason = "shutdown"): void {
    this.core.disconnect(reason);

    // Close scheduler
    this.scheduler.close();

    // Reset MediaSession playbackState (if available)
    if (typeof navigator !== "undefined" && navigator.mediaSession) {
      navigator.mediaSession.playbackState = "none";
      navigator.mediaSession.metadata = null;
    }
  }

  // Set volume (0-100)
  setVolume(volume: number): void {
    this.core.setVolume(volume);
  }

  // Set muted state
  setMuted(muted: boolean): void {
    this.core.setMuted(muted);
  }

  // Set static delay (in milliseconds, 0-5000)
  setSyncDelay(delayMs: number): void {
    this.core.setSyncDelay(delayMs);
  }

  /**
   * Set the sync correction mode at runtime.
   */
  setCorrectionMode(mode: CorrectionMode): void {
    this.scheduler.setCorrectionMode(mode);
  }

  // ========================================
  // Controller Commands (sent to server)
  // ========================================

  /**
   * Send a controller command to the server.
   */
  sendCommand<T extends ControllerCommand>(
    command: T,
    params: ControllerCommands[T],
  ): void {
    this.core.sendCommand(command, params);
  }

  // Getters for reactive state
  get isPlaying(): boolean {
    return this.core.isPlaying;
  }

  get volume(): number {
    return this.core.volume;
  }

  get muted(): boolean {
    return this.core.muted;
  }

  get playerState(): PlayerState {
    return this.core.playerState;
  }

  get currentFormat(): StreamFormat | null {
    return this.core.currentFormat;
  }

  get isConnected(): boolean {
    return this.core.isConnected;
  }

  // Get current correction mode
  get correctionMode(): CorrectionMode {
    return this.scheduler.correctionMode;
  }

  // Time sync info for debugging
  get timeSyncInfo(): { synced: boolean; offset: number; error: number } {
    return this.core.timeSyncInfo;
  }

  /** Get current server time in microseconds using synchronized clock */
  getCurrentServerTimeUs(): number {
    return this.core.getCurrentServerTimeUs();
  }

  /** Get current track progress with real-time position calculation */
  get trackProgress(): {
    positionMs: number;
    durationMs: number;
    playbackSpeed: number;
  } | null {
    return this.core.trackProgress;
  }

  // Sync info for debugging/display
  get syncInfo(): {
    clockDriftPercent: number;
    syncErrorMs: number;
    resyncCount: number;
    outputLatencyMs: number;
    playbackRate: number;
    correctionMethod: "none" | "samples" | "rate" | "resync";
    samplesAdjusted: number;
    correctionMode: CorrectionMode;
  } {
    return this.scheduler.syncInfo;
  }
}

// Re-export types for convenience
export * from "./types";
export { SendspinTimeFilter } from "./core/time-filter";
export { SendspinCore } from "./core/core";
export { SendspinDecoder } from "./audio/decoder";
export { AudioScheduler } from "./audio/scheduler";

// Export platform detection utilities
export { detectIsAndroid, detectIsIOS, detectIsMobile, getDefaultSyncDelay };
