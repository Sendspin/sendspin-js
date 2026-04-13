import type {
  AudioBufferQueueItem,
  StreamFormat,
  AudioOutputMode,
  CorrectionMode,
  SendspinStorage,
} from "./types";
import type { StateManager } from "./state-manager";
import type { SendspinTimeFilter } from "./time-filter";

// Sync correction constants
const SAMPLE_CORRECTION_FADE_LEN = 8; // samples to blend around correction points
// Blend budget across the whole fade window.
// We derive per-sample strength from fade length so longer fades become gentler.
// 1.0 means the whole fade applies roughly a full-strength blend in total.
const SAMPLE_CORRECTION_TARGET_BLEND_SUM = 1.0;
const SAMPLE_CORRECTION_FADE_STRENGTH = Math.min(
  1,
  (2 * SAMPLE_CORRECTION_TARGET_BLEND_SUM) / SAMPLE_CORRECTION_FADE_LEN,
);
const SAMPLE_CORRECTION_FADE_ALPHAS = new Float32Array(
  SAMPLE_CORRECTION_FADE_LEN,
);
for (let f = 0; f < SAMPLE_CORRECTION_FADE_LEN; f++) {
  SAMPLE_CORRECTION_FADE_ALPHAS[f] =
    ((SAMPLE_CORRECTION_FADE_LEN - f) / (SAMPLE_CORRECTION_FADE_LEN + 1)) *
    SAMPLE_CORRECTION_FADE_STRENGTH;
}
const OUTPUT_LATENCY_ALPHA = 0.01; // EMA smoothing factor for outputLatency
const SYNC_ERROR_ALPHA = 0.1; // EMA smoothing factor for sync error (filters jitter)
const OUTPUT_LATENCY_STORAGE_KEY = "sendspin-output-latency-us"; // LocalStorage key
const OUTPUT_LATENCY_PERSIST_INTERVAL_MS = 10_000;
const RECORRECTION_CHECK_INTERVAL_MS = 250;
const RECORRECTION_TRIGGER_MS = 30;
const RECORRECTION_SUSTAIN_MS = 400;
const RECORRECTION_COOLDOWN_MS = 1_500;
const RECORRECTION_CUTOVER_GUARD_SEC = 0.3;
const RECORRECTION_TRANSIENT_JUMP_MS = 25;
const RECORRECTION_TRANSIENT_CONFIRM_WINDOW_MS =
  RECORRECTION_CHECK_INTERVAL_MS * 4;
const HARD_RESYNC_STARTUP_GRACE_MS = 1_000;
const HARD_RESYNC_COOLDOWN_MS = 500;
const SCHEDULE_HEADROOM_SEC = 0.2;
const SCHEDULE_HORIZON_PRECISE_SEC = 20;
const SCHEDULE_HORIZON_GOOD_SEC = 8;
const SCHEDULE_HORIZON_POOR_SEC = 4;
const CAST_SCHEDULE_HORIZON_PRECISE_SEC = 1.5;
const CAST_SCHEDULE_HORIZON_GOOD_SEC = 1;
const CAST_SCHEDULE_HORIZON_POOR_SEC = 0.5;
const SCHEDULE_HORIZON_PRECISE_ERROR_MS = 2;
const SCHEDULE_HORIZON_GOOD_ERROR_MS = 8;
type AudioClockSource = "estimated" | "timestamp" | "raw";

interface OutputTimestampSample {
  contextTimeSec: number;
  performanceTimeMs: number;
  nowMs: number;
  predictedAudioTimeSec: number;
  rawAudioTimeSec: number;
}

const OUTPUT_TIMESTAMP_MAX_FRESHNESS_MS = 250;
const OUTPUT_TIMESTAMP_MIN_SAMPLE_INTERVAL_MS = 40;
const OUTPUT_TIMESTAMP_SLOPE_MIN = 0.95;
const OUTPUT_TIMESTAMP_SLOPE_MAX = 1.05;
const OUTPUT_TIMESTAMP_MAX_DIVERGENCE_SEC = 0.25;
const OUTPUT_TIMESTAMP_MAX_DIVERGENCE_DELTA_SEC = 0.05;
const OUTPUT_TIMESTAMP_MAX_BACKWARD_SEC = 0.005;
const OUTPUT_TIMESTAMP_FUTURE_TOLERANCE_MS = 5;
const OUTPUT_TIMESTAMP_PROMOTION_MIN_GOOD_SAMPLES = 6;
const OUTPUT_TIMESTAMP_PROMOTION_MIN_SPAN_MS = 750;
const OUTPUT_TIMESTAMP_MAX_CONSECUTIVE_BAD_SAMPLES = 2;

// Mode-specific sync correction thresholds
const CORRECTION_THRESHOLDS: Record<
  CorrectionMode,
  {
    resyncAboveMs: number; // ms - hard resync for extreme errors
    rate2AboveMs: number; // ms - use 2% rate above this
    rate1AboveMs: number; // ms - use 1% rate above this
    samplesBelowMs: number; // ms - use sample manipulation below this
    deadbandBelowMs: number; // ms - don't correct if error < this
    enableRecorrectionMonitor: boolean; // Whether recorrection monitor should run in this mode
    immediateDelayCutover: boolean; // Whether runtime static delay should trigger immediate cutover
  }
> = {
  sync: {
    resyncAboveMs: 200, // Hard resync for large errors
    rate2AboveMs: 35, // Use 2% rate when error exceeds this
    rate1AboveMs: 8, // Use 1% rate when error exceeds this
    samplesBelowMs: 8, // Use sample insertion/deletion below this
    deadbandBelowMs: 1, // Ignore corrections below this
    enableRecorrectionMonitor: true,
    immediateDelayCutover: true,
  },
  quality: {
    resyncAboveMs: 35, // Tighter resync threshold to avoid drifting too far
    rate2AboveMs: Infinity, // Disabled - never use rate correction
    rate1AboveMs: Infinity, // Disabled - never use rate correction
    samplesBelowMs: 35, // Use sample insertion/deletion below this
    deadbandBelowMs: 1, // Keep deadband tight for accurate sync
    enableRecorrectionMonitor: false,
    immediateDelayCutover: false,
  },
  "quality-local": {
    resyncAboveMs: 600, // Last resort only (prefer keeping uninterrupted playback even if out of sync)
    rate2AboveMs: Infinity, // Disabled - never use rate correction
    rate1AboveMs: Infinity, // Disabled - never use rate correction
    samplesBelowMs: 0, // Disabled - never use sample corrections (prioritize smooth local playback)
    deadbandBelowMs: 5, // Larger deadband to avoid frequent small adjustments
    enableRecorrectionMonitor: false,
    immediateDelayCutover: false,
  },
};

export class AudioProcessor {
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private streamDestination: MediaStreamAudioDestinationNode | null = null;
  private audioBufferQueue: AudioBufferQueueItem[] = [];
  private scheduledSources: {
    source: AudioBufferSourceNode;
    startTime: number;
    endTime: number;
    buffer: AudioBuffer;
    serverTime: number;
    generation: number;
  }[] = [];

  // Seamless playback tracking
  private nextPlaybackTime: number = 0; // AudioContext time when audio should reach the output
  private nextScheduleTime: number = 0; // AudioContext time for source.start() (delayed, for Web Audio)
  private lastScheduledServerTime: number = 0; // Server timestamp of last scheduled chunk end

  // Sync tracking (for debugging/display)
  private currentSyncErrorMs: number = 0;
  private smoothedSyncErrorMs: number = 0; // EMA-filtered sync error for corrections
  private resyncCount: number = 0;
  private currentPlaybackRate: number = 1.0;
  private currentCorrectionMethod: "none" | "samples" | "rate" | "resync" =
    "none";
  private lastSamplesAdjusted: number = 0;

  // Output latency smoothing (EMA to filter Chrome jitter)
  private lastRawOutputLatencyUs: number = 0;
  private smoothedOutputLatencyUs: number | null = null;
  private lastLatencyPersistAtMs: number | null = null;

  private timingEstimateAudioContextTimeSec: number | null = null;
  private timingEstimateAtMs: number | null = null;

  // Correction mode
  private _correctionMode: CorrectionMode = "sync";

  // Periodic status logging
  private _lastStatusLogMs: number = 0;
  private _lastTimestampRejectReason: string | null = null;
  private _intervalResyncCount: number = 0;

  // Native Opus decoder (uses WebCodecs API)
  private webCodecsDecoder: AudioDecoder | null = null;
  private webCodecsDecoderReady: Promise<void> | null = null;
  private webCodecsFormat: StreamFormat | null = null;
  private useNativeOpus: boolean = true; // false when WebCodecs unavailable

  // Fallback Opus decoder (opus-encdec library)
  private opusDecoder: any = null;
  private opusDecoderModule: any = null;
  private opusDecoderReady: Promise<void> | null = null;

  private useOutputLatencyCompensation: boolean = true;
  private nativeDecoderQueue: Array<{
    serverTimeUs: number;
    generation: number;
  }> = [];
  private recorrectionInterval: ReturnType<typeof setInterval> | null = null;
  private recorrectionBreachStartedAtMs: number | null = null;
  private lastRecorrectionAtMs: number = -Infinity;
  private recorrectionMinScheduleTimeSec: number | null = null;
  private recorrectionPrevRawSyncErrorMs: number | null = null;
  private recorrectionPendingJumpSign: number | null = null;
  private recorrectionPendingJumpAtMs: number | null = null;
  private hardResyncGraceUntilMs: number | null = null;
  private lastHardResyncAtMs: number = -Infinity;
  private pendingClockSourceCutover = false;
  private activeAudioClockSource: AudioClockSource = "estimated";
  private outputTimestampLastSample: OutputTimestampSample | null = null;
  private outputTimestampGoodSamples: number = 0;
  private outputTimestampBadSamples: number = 0;
  private outputTimestampGoodSinceMs: number | null = null;

  constructor(
    private stateManager: StateManager,
    private timeFilter: SendspinTimeFilter,
    private outputMode: AudioOutputMode = "direct",
    private audioElement?: HTMLAudioElement,
    private isAndroid: boolean = false,
    private isCastRuntime: boolean = false,
    private ownsAudioElement: boolean = false,
    private silentAudioSrc?: string,
    private syncDelayMs: number = 0,
    private useHardwareVolume: boolean = false,
    correctionMode: CorrectionMode = "sync",
    private storage: SendspinStorage | null = null,
    useOutputLatencyCompensation: boolean = true,
  ) {
    this._correctionMode = correctionMode;
    this.useOutputLatencyCompensation = useOutputLatencyCompensation;
    this.syncDelayMs = this.sanitizeSyncDelayMs(this.syncDelayMs);

    // Load persisted output latency from storage
    this.loadPersistedLatency();
  }

  private sanitizeSyncDelayMs(delayMs: number): number {
    if (!isFinite(delayMs)) {
      return 0;
    }
    return Math.max(0, Math.min(5000, Math.round(delayMs)));
  }

  // Load persisted output latency from storage
  private loadPersistedLatency(): void {
    if (!this.storage) return;
    try {
      const stored = this.storage.getItem(OUTPUT_LATENCY_STORAGE_KEY);
      if (stored) {
        const latency = parseFloat(stored);
        if (!isNaN(latency) && latency >= 0) {
          this.smoothedOutputLatencyUs = latency;
        }
      }
    } catch {
      // Storage may fail depending on the implementation, ignore errors
    }
  }

  // Persist output latency to storage
  private persistLatency(): void {
    if (!this.storage || this.smoothedOutputLatencyUs === null) return;
    try {
      this.storage.setItem(
        OUTPUT_LATENCY_STORAGE_KEY,
        this.smoothedOutputLatencyUs.toString(),
      );
    } catch {
      // Storage may fail depending on the implementation, ignore errors
    }
  }

  // Get current correction mode
  get correctionMode(): CorrectionMode {
    return this._correctionMode;
  }

  // Set correction mode at runtime
  setCorrectionMode(mode: CorrectionMode): void {
    this._correctionMode = mode;
    if (!this.modeUsesRecorrectionMonitor(mode)) {
      this.stopRecorrectionMonitor();
    } else {
      this.startRecorrectionMonitor();
    }
  }

  private modeUsesRecorrectionMonitor(mode: CorrectionMode): boolean {
    return CORRECTION_THRESHOLDS[mode].enableRecorrectionMonitor;
  }

  private get usesRecorrectionMonitor(): boolean {
    return this.modeUsesRecorrectionMonitor(this._correctionMode);
  }

  private get usesImmediateDelayCutover(): boolean {
    return CORRECTION_THRESHOLDS[this._correctionMode].immediateDelayCutover;
  }

  private getTargetScheduledHorizonSec(): number {
    const preciseHorizonSec = this.isCastRuntime
      ? CAST_SCHEDULE_HORIZON_PRECISE_SEC
      : SCHEDULE_HORIZON_PRECISE_SEC;
    const goodHorizonSec = this.isCastRuntime
      ? CAST_SCHEDULE_HORIZON_GOOD_SEC
      : SCHEDULE_HORIZON_GOOD_SEC;
    const poorHorizonSec = this.isCastRuntime
      ? CAST_SCHEDULE_HORIZON_POOR_SEC
      : SCHEDULE_HORIZON_POOR_SEC;
    const errorMs = this.timeFilter.error / 1000;
    if (errorMs < SCHEDULE_HORIZON_PRECISE_ERROR_MS) {
      return preciseHorizonSec;
    }
    if (errorMs <= SCHEDULE_HORIZON_GOOD_ERROR_MS) {
      return goodHorizonSec;
    }
    return poorHorizonSec;
  }

  private getScheduledAheadSec(currentTimeSec: number): number {
    let farthestScheduledSec = this.nextScheduleTime;
    for (const entry of this.scheduledSources) {
      if (entry.endTime > farthestScheduledSec) {
        farthestScheduledSec = entry.endTime;
      }
    }
    if (farthestScheduledSec <= 0) {
      return 0;
    }
    return Math.max(0, farthestScheduledSec - currentTimeSec);
  }

  private setActiveAudioClockSource(source: AudioClockSource): void {
    if (this.activeAudioClockSource === source) {
      return;
    }
    this.activeAudioClockSource = source;
    this.pendingClockSourceCutover = source === "timestamp";
    if (
      this.pendingClockSourceCutover &&
      (this.scheduledSources.length > 0 ||
        this.nextPlaybackTime !== 0 ||
        this.lastScheduledServerTime !== 0)
    ) {
      this.scheduleQueueProcessing();
    }
  }

  private resetOutputTimestampValidation(): void {
    this.activeAudioClockSource = "estimated";
    this.pendingClockSourceCutover = false;
    this.outputTimestampLastSample = null;
    this.outputTimestampGoodSamples = 0;
    this._lastTimestampRejectReason = null;
    this.outputTimestampBadSamples = 0;
    this.outputTimestampGoodSinceMs = null;
  }

  private demoteOutputTimestampValidation(reason: string): void {
    this.resetOutputTimestampValidation();
    this._lastTimestampRejectReason = reason;
  }

  private getEstimatedAudioContextTimeSec(
    rawTimeSec: number,
    nowMs: number,
  ): number {
    // Fallback: de-quantize `currentTime` using wall clock and slew toward the raw value.
    // Key goal: avoid discrete ~10/20ms jumps in derived audio time.
    const TIMING_MAX_SLEW_SEC = 0.002; // max correction per snapshot (2ms)
    const TIMING_RESET_THRESHOLD_SEC = 0.5; // snap if mapping is clearly invalid
    const TIMING_MAX_LEAD_SEC = 0.1; // don't run far ahead of raw time

    if (this.timingEstimateAudioContextTimeSec === null) {
      this.timingEstimateAudioContextTimeSec = rawTimeSec;
      this.timingEstimateAtMs = nowMs;
    } else if (this.timingEstimateAtMs !== null) {
      const wallDeltaSec = Math.max(
        0,
        (nowMs - this.timingEstimateAtMs) / 1000,
      );
      const predicted = this.timingEstimateAudioContextTimeSec + wallDeltaSec;
      this.timingEstimateAtMs = nowMs;

      const errorSec = rawTimeSec - predicted;
      if (Math.abs(errorSec) > TIMING_RESET_THRESHOLD_SEC) {
        this.timingEstimateAudioContextTimeSec = rawTimeSec;
      } else {
        const slew = Math.max(
          -TIMING_MAX_SLEW_SEC,
          Math.min(TIMING_MAX_SLEW_SEC, errorSec),
        );
        // Keep monotonic and bounded vs raw time.
        const next = Math.max(
          this.timingEstimateAudioContextTimeSec,
          predicted + slew,
        );
        this.timingEstimateAudioContextTimeSec = Math.min(
          next,
          rawTimeSec + TIMING_MAX_LEAD_SEC,
        );
      }
    }

    return this.timingEstimateAudioContextTimeSec ?? rawTimeSec;
  }

  private rejectOutputTimestampSample(
    reason: string,
    catastrophic: boolean = false,
  ): void {
    this.outputTimestampLastSample = null;
    this.outputTimestampGoodSamples = 0;
    this.outputTimestampGoodSinceMs = null;
    this._lastTimestampRejectReason = reason;

    if (this.activeAudioClockSource !== "timestamp") {
      this.outputTimestampBadSamples = 0;
      return;
    }

    this.outputTimestampBadSamples += 1;
    if (
      catastrophic ||
      this.outputTimestampBadSamples >=
        OUTPUT_TIMESTAMP_MAX_CONSECUTIVE_BAD_SAMPLES
    ) {
      this.demoteOutputTimestampValidation(reason);
    }
  }

  private getTimestampDerivedAudioTimeSec(rawTimeSec: number): number | null {
    if (!this.audioContext) {
      return null;
    }

    const getOutputTimestamp = (
      this.audioContext as unknown as {
        getOutputTimestamp?: () => {
          contextTime: number;
          performanceTime: number;
        };
      }
    ).getOutputTimestamp;

    if (typeof getOutputTimestamp !== "function") {
      if (this.activeAudioClockSource === "timestamp") {
        this.demoteOutputTimestampValidation("getOutputTimestamp unavailable");
      }
      return null;
    }

    try {
      const ts = getOutputTimestamp.call(this.audioContext);
      // Sample performance.now() after getOutputTimestamp() so we validate the
      // timestamp against a contemporaneous wall-clock reading instead of an
      // earlier one taken before the browser produced the timestamp snapshot.
      const nowMs = performance.now();
      const rawFreshnessMs = nowMs - ts.performanceTime;
      if (rawFreshnessMs < -OUTPUT_TIMESTAMP_FUTURE_TOLERANCE_MS) {
        this.rejectOutputTimestampSample(
          `performanceTime in future (${rawFreshnessMs.toFixed(1)}ms)`,
          true,
        );
        return null;
      }

      const freshnessMs = Math.max(0, rawFreshnessMs);
      const predictedAudioTimeSec = ts.contextTime + freshnessMs / 1000;
      const sample: OutputTimestampSample = {
        contextTimeSec: ts.contextTime,
        performanceTimeMs: ts.performanceTime,
        nowMs,
        predictedAudioTimeSec,
        rawAudioTimeSec: rawTimeSec,
      };

      if (freshnessMs > OUTPUT_TIMESTAMP_MAX_FRESHNESS_MS) {
        this.rejectOutputTimestampSample(
          `stale timestamp (${freshnessMs.toFixed(1)}ms old)`,
          true,
        );
        return null;
      }

      const divergenceSec = predictedAudioTimeSec - rawTimeSec;
      if (Math.abs(divergenceSec) > OUTPUT_TIMESTAMP_MAX_DIVERGENCE_SEC) {
        this.rejectOutputTimestampSample(
          `timestamp/raw divergence ${Math.abs(divergenceSec * 1000).toFixed(1)}ms`,
          true,
        );
        return null;
      }

      const lastSample = this.outputTimestampLastSample;
      if (lastSample) {
        const perfDeltaMs = ts.performanceTime - lastSample.performanceTimeMs;
        if (perfDeltaMs < 0) {
          this.rejectOutputTimestampSample(
            `performanceTime moved backward (${perfDeltaMs.toFixed(1)}ms)`,
            true,
          );
          return null;
        }

        if (
          predictedAudioTimeSec <
          lastSample.predictedAudioTimeSec - OUTPUT_TIMESTAMP_MAX_BACKWARD_SEC
        ) {
          this.rejectOutputTimestampSample(
            `predicted audio time moved backward ${((lastSample.predictedAudioTimeSec - predictedAudioTimeSec) * 1000).toFixed(1)}ms`,
            true,
          );
          return null;
        }

        const lastDivergenceSec =
          lastSample.predictedAudioTimeSec - lastSample.rawAudioTimeSec;
        if (
          Math.abs(divergenceSec - lastDivergenceSec) >
          OUTPUT_TIMESTAMP_MAX_DIVERGENCE_DELTA_SEC
        ) {
          this.rejectOutputTimestampSample(
            `timestamp/raw divergence drift ${Math.abs((divergenceSec - lastDivergenceSec) * 1000).toFixed(1)}ms`,
          );
          return null;
        }

        if (perfDeltaMs >= OUTPUT_TIMESTAMP_MIN_SAMPLE_INTERVAL_MS) {
          const perfDeltaSec = perfDeltaMs / 1000;
          const contextSlope =
            (ts.contextTime - lastSample.contextTimeSec) / perfDeltaSec;
          const predictedSlope =
            (predictedAudioTimeSec - lastSample.predictedAudioTimeSec) /
            perfDeltaSec;

          if (
            contextSlope < OUTPUT_TIMESTAMP_SLOPE_MIN ||
            contextSlope > OUTPUT_TIMESTAMP_SLOPE_MAX
          ) {
            this.rejectOutputTimestampSample(
              `context slope ${contextSlope.toFixed(3)} out of range`,
            );
            return null;
          }
          if (
            predictedSlope < OUTPUT_TIMESTAMP_SLOPE_MIN ||
            predictedSlope > OUTPUT_TIMESTAMP_SLOPE_MAX
          ) {
            this.rejectOutputTimestampSample(
              `predicted slope ${predictedSlope.toFixed(3)} out of range`,
            );
            return null;
          }
        }
      }

      this.outputTimestampLastSample = sample;
      this.outputTimestampBadSamples = 0;
      if (this.outputTimestampGoodSinceMs === null) {
        this.outputTimestampGoodSinceMs = nowMs;
      }
      this.outputTimestampGoodSamples += 1;

      if (
        this.activeAudioClockSource !== "timestamp" &&
        this.outputTimestampGoodSamples >=
          OUTPUT_TIMESTAMP_PROMOTION_MIN_GOOD_SAMPLES &&
        this.outputTimestampGoodSinceMs !== null &&
        nowMs - this.outputTimestampGoodSinceMs >=
          OUTPUT_TIMESTAMP_PROMOTION_MIN_SPAN_MS
      ) {
        this.setActiveAudioClockSource("timestamp");
        this._lastTimestampRejectReason = null;
      }

      return predictedAudioTimeSec;
    } catch (error) {
      const reason =
        error instanceof Error
          ? `getOutputTimestamp failed: ${error.message}`
          : `getOutputTimestamp failed: ${String(error)}`;
      this.rejectOutputTimestampSample(reason, true);
      return null;
    }
  }

  private getTimingSnapshot(): {
    audioContextTimeSec: number; // derived; use for target-time math
    audioContextRawTimeSec: number; // raw; use for comparisons (late drops/headroom)
    nowMs: number;
    nowUs: number;
  } {
    const nowMs = performance.now();
    const nowUs = nowMs * 1000;
    if (!this.audioContext) {
      return {
        audioContextTimeSec: 0,
        audioContextRawTimeSec: 0,
        nowMs,
        nowUs,
      };
    }

    const rawTimeSec = this.audioContext.currentTime;
    const estimatedTimeSec = this.getEstimatedAudioContextTimeSec(
      rawTimeSec,
      nowMs,
    );
    const timestampTimeSec = this.getTimestampDerivedAudioTimeSec(rawTimeSec);

    let derivedTimeSec =
      this.activeAudioClockSource === "timestamp" && timestampTimeSec !== null
        ? timestampTimeSec
        : estimatedTimeSec;
    if (!Number.isFinite(derivedTimeSec)) {
      derivedTimeSec = rawTimeSec;
    }

    return {
      audioContextTimeSec: derivedTimeSec,
      audioContextRawTimeSec: rawTimeSec,
      nowMs,
      nowUs,
    };
  }

  private resetScheduledPlaybackState(_reason?: string): void {
    this.nextPlaybackTime = 0;
    this.nextScheduleTime = 0;
    this.lastScheduledServerTime = 0;
    this.recorrectionMinScheduleTimeSec = null;
    this.hardResyncGraceUntilMs = null;
    this.lastHardResyncAtMs = -Infinity;
    this.pendingClockSourceCutover = false;
    this.resetRecorrectionCheckState();
    this.resetSyncErrorEma();
    this.currentSyncErrorMs = 0;
    this.currentPlaybackRate = 1.0;
    this.currentCorrectionMethod = "none";
    this.lastSamplesAdjusted = 0;
    this._lastStatusLogMs = 0;
    this._intervalResyncCount = 0;
  }

  private pruneExpiredScheduledSources(currentTimeSec: number): void {
    if (this.scheduledSources.length === 0) {
      return;
    }

    this.scheduledSources = this.scheduledSources.filter(
      (entry) => entry.endTime > currentTimeSec,
    );

    if (this.scheduledSources.length === 0) {
      this.resetScheduledPlaybackState("no scheduled audio ahead");
    }
  }

  private startRecorrectionMonitor(): void {
    if (this.recorrectionInterval !== null) {
      return;
    }
    this.recorrectionInterval = globalThis.setInterval(
      () => this.checkRecorrection(),
      RECORRECTION_CHECK_INTERVAL_MS,
    );
  }

  private stopRecorrectionMonitor(): void {
    if (this.recorrectionInterval !== null) {
      clearInterval(this.recorrectionInterval);
      this.recorrectionInterval = null;
    }
    this.resetRecorrectionCheckState();
    this.lastRecorrectionAtMs = -Infinity;
  }

  private clearRecorrectionBreachState(): void {
    this.recorrectionBreachStartedAtMs = null;
    this.recorrectionPendingJumpSign = null;
    this.recorrectionPendingJumpAtMs = null;
  }

  private resetRecorrectionCheckState(): void {
    this.clearRecorrectionBreachState();
    this.recorrectionPrevRawSyncErrorMs = null;
  }

  private armHardResyncStartupGrace(nowMs: number): void {
    if (this.activeAudioClockSource === "timestamp") {
      this.hardResyncGraceUntilMs = null;
      return;
    }
    if (this.hardResyncGraceUntilMs === null) {
      this.hardResyncGraceUntilMs = nowMs + HARD_RESYNC_STARTUP_GRACE_MS;
    }
  }

  private canUseHardResync(nowMs: number): boolean {
    if (this.activeAudioClockSource === "timestamp") {
      this.hardResyncGraceUntilMs = null;
    } else if (
      this.hardResyncGraceUntilMs !== null &&
      nowMs < this.hardResyncGraceUntilMs
    ) {
      return false;
    }

    return nowMs - this.lastHardResyncAtMs >= HARD_RESYNC_COOLDOWN_MS;
  }

  private noteHardResync(nowMs: number): void {
    this.lastHardResyncAtMs = nowMs;
  }

  private shouldIgnoreTransientRecorrectionJump(
    rawSyncErrorMs: number,
    nowMs: number,
  ): boolean {
    const prevRawSyncErrorMs = this.recorrectionPrevRawSyncErrorMs;
    this.recorrectionPrevRawSyncErrorMs = rawSyncErrorMs;

    if (prevRawSyncErrorMs === null) {
      this.recorrectionPendingJumpSign = null;
      this.recorrectionPendingJumpAtMs = null;
      return false;
    }

    const jumpDeltaMs = rawSyncErrorMs - prevRawSyncErrorMs;
    const jumpSign = Math.sign(rawSyncErrorMs);
    const isJumpDetected =
      Math.abs(jumpDeltaMs) >= RECORRECTION_TRANSIENT_JUMP_MS && jumpSign !== 0;
    if (!isJumpDetected) {
      this.recorrectionPendingJumpSign = null;
      this.recorrectionPendingJumpAtMs = null;
      return false;
    }

    const isConfirmed =
      this.recorrectionPendingJumpSign === jumpSign &&
      this.recorrectionPendingJumpAtMs !== null &&
      nowMs - this.recorrectionPendingJumpAtMs <=
        RECORRECTION_TRANSIENT_CONFIRM_WINDOW_MS;
    this.recorrectionPendingJumpSign = jumpSign;
    this.recorrectionPendingJumpAtMs = nowMs;
    if (isConfirmed) {
      this.recorrectionPendingJumpSign = null;
      this.recorrectionPendingJumpAtMs = null;
      return false;
    }

    return true;
  }

  private performGuardedCutover(
    reason: "recorrection" | "delay-change",
    options: {
      incrementResyncCount?: boolean;
      markCooldown?: boolean;
    } = {},
  ): void {
    if (!this.audioContext) {
      return;
    }

    const incrementResyncCount = options.incrementResyncCount ?? false;
    const markCooldown = options.markCooldown ?? true;
    const nowMs = performance.now();
    const cutoffTime =
      this.audioContext.currentTime + RECORRECTION_CUTOVER_GUARD_SEC;
    if (incrementResyncCount) {
      this.resyncCount++;
      this._intervalResyncCount++;
    }
    this.resetSyncErrorEma();
    this.currentCorrectionMethod = "resync";
    this.lastSamplesAdjusted = 0;
    this.currentPlaybackRate = 1.0;
    const cutResult = this.cutScheduledSources(cutoffTime);
    this.recorrectionMinScheduleTimeSec = Math.max(
      cutoffTime,
      cutResult.keptTailEndTimeSec,
    );
    this.nextPlaybackTime = 0;
    this.nextScheduleTime = 0;
    this.lastScheduledServerTime = 0;
    this.resetRecorrectionCheckState();
    if (markCooldown) {
      this.lastRecorrectionAtMs = nowMs;
    }
    this.noteHardResync(nowMs);

    this.processAudioQueue();
  }

  private checkRecorrection(): void {
    if (!this.usesRecorrectionMonitor) {
      this.resetRecorrectionCheckState();
      return;
    }
    if (!this.audioContext || this.audioContext.state !== "running") {
      this.resetRecorrectionCheckState();
      return;
    }
    if (
      !this.stateManager.isPlaying ||
      this.nextPlaybackTime === 0 ||
      this.lastScheduledServerTime === 0
    ) {
      this.resetRecorrectionCheckState();
      return;
    }

    const {
      audioContextTimeSec: audioContextTime,
      audioContextRawTimeSec: audioContextRawTime,
      nowMs,
      nowUs,
    } = this.getTimingSnapshot();
    this.pruneExpiredScheduledSources(audioContextRawTime);
    const scheduledAheadSec = this.getScheduledAheadSec(audioContextRawTime);
    if (scheduledAheadSec <= 0) {
      this.resetRecorrectionCheckState();
      if (this.audioBufferQueue.length > 0) {
        this.processAudioQueue();
      }
      return;
    }

    const outputLatencySec = this.useOutputLatencyCompensation
      ? this.getSmoothedOutputLatencyUs() / 1_000_000
      : 0;
    const targetPlaybackTime = this.computeTargetPlaybackTime(
      this.lastScheduledServerTime,
      audioContextTime,
      nowUs,
      outputLatencySec,
    );
    const syncErrorMs = (this.nextPlaybackTime - targetPlaybackTime) * 1000;
    const smoothedSyncErrorMs = this.applySyncErrorEma(syncErrorMs);
    const absErrorMs = Math.abs(smoothedSyncErrorMs);
    const isTransientJump = this.shouldIgnoreTransientRecorrectionJump(
      syncErrorMs,
      nowMs,
    );
    if (absErrorMs < RECORRECTION_TRIGGER_MS) {
      this.clearRecorrectionBreachState();
      return;
    }
    if (isTransientJump) {
      this.clearRecorrectionBreachState();
      return;
    }
    if (this.recorrectionBreachStartedAtMs === null) {
      this.recorrectionBreachStartedAtMs = nowMs;
      return;
    }
    if (nowMs - this.recorrectionBreachStartedAtMs < RECORRECTION_SUSTAIN_MS) {
      return;
    }
    if (nowMs - this.lastRecorrectionAtMs < RECORRECTION_COOLDOWN_MS) {
      return;
    }

    this.applyRecorrectionCutover();
  }

  private applyRecorrectionCutover(): void {
    this.performGuardedCutover("recorrection", {
      incrementResyncCount: true,
      markCooldown: true,
    });
  }

  getSyncDelayMs(): number {
    return this.syncDelayMs;
  }

  // Refresh expired scheduled-source bookkeeping before measuring how much
  // queued and already-scheduled audio remains available for playback.
  measureBufferedPlaybackRunwaySec(): number {
    if (!this.audioContext) {
      return 0;
    }

    const currentTimeSec = this.audioContext.currentTime;
    this.pruneExpiredScheduledSources(currentTimeSec);
    const scheduledAheadSec = this.getScheduledAheadSec(currentTimeSec);
    const queuedAheadSec = this.audioBufferQueue.reduce(
      (totalSec, chunk) => totalSec + chunk.buffer.duration,
      0,
    );
    return Math.max(0, scheduledAheadSec + queuedAheadSec);
  }

  // Update sync delay at runtime
  setSyncDelay(delayMs: number): void {
    const sanitizedDelayMs = this.sanitizeSyncDelayMs(delayMs);
    const oldDelayMs = this.syncDelayMs;
    const deltaMs = sanitizedDelayMs - oldDelayMs;
    this.syncDelayMs = sanitizedDelayMs;

    if (deltaMs === 0 || !this.usesImmediateDelayCutover) {
      return;
    }
    if (!this.audioContext || this.audioContext.state !== "running") {
      return;
    }
    if (!this.stateManager.isPlaying) {
      return;
    }
    if (
      this.scheduledSources.length === 0 &&
      this.audioBufferQueue.length === 0 &&
      this.nextPlaybackTime === 0
    ) {
      return;
    }

    this.performGuardedCutover("delay-change", {
      incrementResyncCount: false,
      markCooldown: true,
    });
  }

  // Get current sync info for debugging/display
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
    return {
      clockDriftPercent: this.timeFilter.drift * 100,
      syncErrorMs: this.currentSyncErrorMs,
      resyncCount: this.resyncCount,
      outputLatencyMs: this.getRawOutputLatencyUs() / 1000,
      playbackRate: this.currentPlaybackRate,
      correctionMethod: this.currentCorrectionMethod,
      samplesAdjusted: this.lastSamplesAdjusted,
      correctionMode: this._correctionMode,
    };
  }

  private emitStatusLog(nowMs: number): void {
    if (this._lastStatusLogMs !== 0 && nowMs - this._lastStatusLogMs < 10_000) {
      return;
    }
    this._lastStatusLogMs = nowMs;

    // corr field
    let corr: string;
    switch (this.currentCorrectionMethod) {
      case "rate":
        corr = `rate@${this.currentPlaybackRate}`;
        break;
      case "samples":
        corr = `samples:${this.lastSamplesAdjusted}`;
        break;
      default:
        corr = this.currentCorrectionMethod;
    }

    // q field
    const queueDepth =
      this.audioBufferQueue.length + this.scheduledSources.length;
    const aheadSec = this.audioContext
      ? this.getScheduledAheadSec(this.audioContext.currentTime)
      : 0;

    // clock field
    let clock: string;
    if (this.activeAudioClockSource === "timestamp") {
      clock = `timestamp(good:${this.outputTimestampGoodSamples})`;
    } else if (this._lastTimestampRejectReason) {
      clock = `estimated(reject:"${this._lastTimestampRejectReason}")`;
    } else {
      clock = "estimated";
    }

    // tf field
    const tf = this.timeFilter.is_synchronized
      ? `synced(err=${(this.timeFilter.error / 1000).toFixed(1)}ms,drift=${this.timeFilter.drift.toFixed(3)},n=${this.timeFilter.count})`
      : `pending(n=${this.timeFilter.count})`;

    // lat field
    const latMs =
      this.smoothedOutputLatencyUs !== null
        ? Math.round(this.smoothedOutputLatencyUs / 1000)
        : 0;

    console.log(
      `Sendspin: sync=${this.smoothedSyncErrorMs >= 0 ? "+" : ""}${this.smoothedSyncErrorMs.toFixed(1)}ms` +
        ` corr=${corr}` +
        ` q=${queueDepth}/${aheadSec.toFixed(1)}s` +
        ` resyncs=${this._intervalResyncCount}` +
        ` clock=${clock}` +
        ` tf=${tf}` +
        ` lat=${latMs}ms` +
        ` mode=${this._correctionMode}` +
        ` ctx=${this.audioContext?.state ?? "null"}` +
        ` gen=${this.stateManager.streamGeneration}`,
    );

    this._intervalResyncCount = 0;
  }

  private applySyncErrorEma(inputMs: number): number {
    this.currentSyncErrorMs = inputMs;
    this.smoothedSyncErrorMs =
      SYNC_ERROR_ALPHA * inputMs +
      (1 - SYNC_ERROR_ALPHA) * this.smoothedSyncErrorMs;
    return this.smoothedSyncErrorMs;
  }

  private resetSyncErrorEma(): void {
    this.smoothedSyncErrorMs = 0;
  }

  // Get raw output latency in microseconds (for Kalman filter input)
  getRawOutputLatencyUs(): number {
    if (!this.audioContext) return 0;
    const baseLatency = this.audioContext.baseLatency ?? 0;
    const outputLatency = this.audioContext.outputLatency ?? 0;
    const rawUs = (baseLatency + outputLatency) * 1_000_000; // Convert seconds to microseconds
    this.lastRawOutputLatencyUs = rawUs;
    return rawUs;
  }

  // Get smoothed output latency in microseconds (filters Chrome jitter)
  getSmoothedOutputLatencyUs(): number {
    const rawLatencyUs = this.getRawOutputLatencyUs();

    // Some browsers report 0 until playback is active; treat 0 as "unknown"
    // and keep the last good estimate to avoid poisoning sync.
    if (rawLatencyUs <= 0 && this.smoothedOutputLatencyUs !== null) {
      return this.smoothedOutputLatencyUs;
    }

    if (this.smoothedOutputLatencyUs === null) {
      this.smoothedOutputLatencyUs = rawLatencyUs;
    } else {
      this.smoothedOutputLatencyUs =
        OUTPUT_LATENCY_ALPHA * rawLatencyUs +
        (1 - OUTPUT_LATENCY_ALPHA) * this.smoothedOutputLatencyUs;
    }

    const nowMs =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    if (
      this.lastLatencyPersistAtMs === null ||
      nowMs - this.lastLatencyPersistAtMs >= OUTPUT_LATENCY_PERSIST_INTERVAL_MS
    ) {
      this.persistLatency();
      this.lastLatencyPersistAtMs = nowMs;
    }

    return this.smoothedOutputLatencyUs;
  }

  // Reset latency smoother (call on stream change or audio context recreation)
  private resetLatencySmoother(): void {
    this.smoothedOutputLatencyUs = null;
  }

  // Create a fresh copy of an AudioBuffer
  // Some decoders produce buffers with boundary artifacts - copying fixes this
  private copyBuffer(buffer: AudioBuffer): AudioBuffer {
    if (!this.audioContext) return buffer;

    const newBuffer = this.audioContext.createBuffer(
      buffer.numberOfChannels,
      buffer.length,
      buffer.sampleRate,
    );

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      newBuffer.getChannelData(ch).set(buffer.getChannelData(ch));
    }

    return newBuffer;
  }

  // Adjust buffer by inserting or deleting 1 sample using interpolation
  // Insert: [A, B, ...] → [A, (A+B)/2, B, ...] (at start)
  // Delete: [..., Y, Z] → [..., (Y+Z)/2] (at end)
  private adjustBufferSamples(
    buffer: AudioBuffer,
    samplesToAdjust: number,
  ): AudioBuffer {
    if (!this.audioContext || samplesToAdjust === 0 || buffer.length < 2) {
      return this.copyBuffer(buffer);
    }

    const channels = buffer.numberOfChannels;
    const len = buffer.length;
    const sampleRate = buffer.sampleRate;

    try {
      if (samplesToAdjust > 0) {
        // Insert 1 sample at START: [A, B, ...] → [A, (A+B)/2, B, ...]
        const newBuffer = this.audioContext.createBuffer(
          channels,
          len + 1,
          sampleRate,
        );

        for (let ch = 0; ch < channels; ch++) {
          const oldData = buffer.getChannelData(ch);
          const newData = newBuffer.getChannelData(ch);

          newData[0] = oldData[0];
          const insertedSample = (oldData[0] + oldData[1]) / 2;
          newData[1] = insertedSample;
          newData.set(oldData.subarray(1), 2);

          // After inserting one synthetic sample, gently pull the next few real samples toward it.
          // This smooths the splice and avoids a hard step immediately after the insertion point.
          for (let f = 0; f < SAMPLE_CORRECTION_FADE_LEN; f++) {
            const pos = 2 + f;
            if (pos >= newData.length) break;
            const alpha = SAMPLE_CORRECTION_FADE_ALPHAS[f];
            newData[pos] = newData[pos] * (1 - alpha) + insertedSample * alpha;
          }
        }

        return newBuffer;
      } else {
        // Delete 1 sample at END: [..., Y, Z] → [..., (Y+Z)/2]
        const newBuffer = this.audioContext.createBuffer(
          channels,
          len - 1,
          sampleRate,
        );

        for (let ch = 0; ch < channels; ch++) {
          const oldData = buffer.getChannelData(ch);
          const newData = newBuffer.getChannelData(ch);

          newData.set(oldData.subarray(0, len - 2));
          const replacementSample = (oldData[len - 2] + oldData[len - 1]) / 2;
          newData[len - 2] = replacementSample;

          // Before a deletion collapse, gently pull the preceding samples toward the replacement.
          // This smooths entry into the new boundary formed by skipping one sample.
          for (let f = 0; f < SAMPLE_CORRECTION_FADE_LEN; f++) {
            const pos = len - 3 - f;
            if (pos < 0) break;
            const alpha = SAMPLE_CORRECTION_FADE_ALPHAS[f];
            newData[pos] =
              newData[pos] * (1 - alpha) + replacementSample * alpha;
          }
        }

        return newBuffer;
      }
    } catch (e) {
      console.error("Sendspin: adjustBufferSamples error:", e);
      return buffer;
    }
  }

  // Initialize AudioContext with platform-specific setup
  initAudioContext(): void {
    if (this.audioContext) {
      return; // Already initialized
    }

    if (this.outputMode === "media-element" && this.ownsAudioElement) {
      this.audioElement = document.createElement("audio");
      this.audioElement.style.display = "none";
      document.body.appendChild(this.audioElement);
    }

    // Set audio session to "playback" so audio continues when iOS device is muted
    // (iOS 17+, no-op on other platforms)
    if ((navigator as any).audioSession) {
      (navigator as any).audioSession.type = "playback";
    }

    const streamSampleRate =
      this.stateManager.currentStreamFormat?.sample_rate || 48000;
    this.audioContext = new AudioContext({ sampleRate: streamSampleRate });
    this.gainNode = this.audioContext.createGain();

    const audioElement = this.audioElement;

    if (this.outputMode === "direct") {
      // Direct output to audioContext.destination (e.g., Cast receiver)
      this.gainNode.connect(this.audioContext.destination);
    } else {
      if (!audioElement) {
        throw new Error(
          "Media-element output requires an audio element to be available during initialization.",
        );
      }

      if (this.isAndroid && this.silentAudioSrc) {
        // Android MediaSession workaround: Play almost-silent audio file
        // Android browsers don't support MediaSession with MediaStream from Web Audio API
        // Solution: Loop almost-silent audio to keep MediaSession active
        // Real audio plays through Web Audio API → audioContext.destination
        this.gainNode.connect(this.audioContext.destination);

        // Use almost-silent audio file to trick Android into showing MediaSession
        audioElement.src = this.silentAudioSrc;
        audioElement.loop = true;
        // CRITICAL: Do NOT mute - Android requires audible audio for MediaSession
        audioElement.muted = false;
        // Set volume to 100% (the file itself is almost silent)
        audioElement.volume = 1.0;
        // Start playing to activate MediaSession
        audioElement.play().catch((e) => {
          console.warn("Sendspin: Audio autoplay blocked:", e);
        });
      } else {
        // iOS/Desktop: Use MediaStream approach for background playback
        // Create MediaStreamDestination to bridge Web Audio API to HTML5 audio element
        this.streamDestination =
          this.audioContext.createMediaStreamDestination();
        this.gainNode.connect(this.streamDestination);
        // Do NOT connect to audioContext.destination to avoid echo

        // Connect to HTML5 audio element for iOS background playback
        audioElement.srcObject = this.streamDestination.stream;
        audioElement.volume = 1.0;
        // Start playing to activate MediaSession
        audioElement.play().catch((e) => {
          console.warn("Sendspin: Audio autoplay blocked:", e);
        });
      }
    }

    this.updateVolume();
    if (this.usesRecorrectionMonitor) {
      this.startRecorrectionMonitor();
    }
  }

  // Resume AudioContext if suspended (required for browser autoplay policies)
  async resumeAudioContext(): Promise<void> {
    if (this.audioContext && this.audioContext.state === "suspended") {
      try {
        await this.audioContext.resume();
        console.log("Sendspin: AudioContext resumed");
      } catch (e) {
        console.warn("Sendspin: Failed to resume AudioContext:", e);
        return;
      }

      if (this.audioBufferQueue.length > 0) {
        this.scheduleQueueProcessing();
      }
      if (this.usesRecorrectionMonitor) {
        this.startRecorrectionMonitor();
      }
    }
  }

  private cutScheduledSources(cutoffTime: number): {
    requeuedCount: number;
    cutCount: number;
    keptTailEndTimeSec: number;
  } {
    if (!this.audioContext) {
      return {
        requeuedCount: 0,
        cutCount: 0,
        keptTailEndTimeSec: 0,
      };
    }
    const stopTime = Math.max(cutoffTime, this.audioContext.currentTime);
    let requeued = 0;
    let cutCount = 0;
    let keptTailEndTimeSec = 0;
    this.scheduledSources = this.scheduledSources.filter((entry) => {
      // Keep sources scheduled before stopTime to avoid cutting mid-buffer artifacts.
      if (entry.startTime < stopTime) {
        keptTailEndTimeSec = Math.max(keptTailEndTimeSec, entry.endTime);
        return true;
      }
      try {
        entry.source.onended = null;
        entry.source.stop(stopTime);
      } catch (e) {
        // Ignore errors if source already stopped
      }
      this.audioBufferQueue.push({
        buffer: entry.buffer,
        serverTime: entry.serverTime,
        generation: entry.generation,
      });
      requeued++;
      cutCount++;
      return false;
    });
    return {
      requeuedCount: requeued,
      cutCount,
      keptTailEndTimeSec,
    };
  }

  // Update volume based on current state
  updateVolume(): void {
    if (!this.gainNode) return;

    // Hardware volume mode: keep software gain at 1.0, external handles volume
    if (this.useHardwareVolume) {
      this.gainNode.gain.value = 1.0;
      return;
    }

    if (this.stateManager.muted) {
      this.gainNode.gain.value = 0;
    } else {
      this.gainNode.gain.value = this.stateManager.volume / 100;
    }
  }

  // Decode audio data based on codec
  async decodeAudioData(
    audioData: ArrayBuffer,
    format: StreamFormat,
  ): Promise<AudioBuffer | null> {
    if (!this.audioContext) return null;

    try {
      if (format.codec === "opus") {
        // Opus fallback path - native decoder uses async queueToNativeOpusDecoder
        return await this.decodeOpusWithEncdec(audioData, format);
      } else if (format.codec === "flac") {
        // FLAC can be decoded by the browser's native decoder
        // If codec_header is provided, prepend it to the audio data
        let dataToEncode = audioData;
        if (format.codec_header) {
          // Decode Base64 codec header
          const headerBytes = Uint8Array.from(atob(format.codec_header), (c) =>
            c.charCodeAt(0),
          );
          // Concatenate header + audio data
          const combined = new Uint8Array(
            headerBytes.length + audioData.byteLength,
          );
          combined.set(headerBytes, 0);
          combined.set(new Uint8Array(audioData), headerBytes.length);
          dataToEncode = combined.buffer;
        }
        return await this.audioContext.decodeAudioData(dataToEncode);
      } else if (format.codec === "pcm") {
        // PCM data needs manual decoding
        return this.decodePCMData(audioData, format);
      }
    } catch (error) {
      console.error("Error decoding audio data:", error);
    }

    return null;
  }

  // Initialize native Opus decoder
  private async initWebCodecsDecoder(format: StreamFormat): Promise<void> {
    const tryConfigureExistingDecoder = (): boolean => {
      if (!this.webCodecsDecoder) return false;

      const matchesFormat =
        !!this.webCodecsFormat &&
        this.webCodecsFormat.sample_rate === format.sample_rate &&
        this.webCodecsFormat.channels === format.channels;

      if (this.webCodecsDecoder.state === "configured" && matchesFormat) {
        return true;
      }

      if (this.webCodecsDecoder.state === "closed") {
        return false;
      }

      try {
        this.webCodecsDecoder.configure({
          codec: "opus",
          sampleRate: format.sample_rate,
          numberOfChannels: format.channels,
        });
        this.webCodecsFormat = format;
        return true;
      } catch {
        return false;
      }
    };

    if (tryConfigureExistingDecoder()) {
      return;
    }

    if (this.webCodecsDecoderReady) {
      await this.webCodecsDecoderReady;
      if (tryConfigureExistingDecoder()) {
        return;
      }

      try {
        this.webCodecsDecoder?.close();
      } catch {
        // Ignore close errors; we'll recreate below.
      }
      this.webCodecsDecoder = null;
      this.webCodecsDecoderReady = null;
      this.webCodecsFormat = null;
    }

    if (this.webCodecsDecoderReady) {
      await this.webCodecsDecoderReady;
      return;
    }

    this.webCodecsDecoderReady = this.createWebCodecsDecoder(format);
    await this.webCodecsDecoderReady;
  }

  // Create and configure native Opus decoder (WebCodecs)
  private async createWebCodecsDecoder(format: StreamFormat): Promise<void> {
    if (typeof AudioDecoder === "undefined") {
      this.useNativeOpus = false;
      return;
    }

    try {
      const support = await AudioDecoder.isConfigSupported({
        codec: "opus",
        sampleRate: format.sample_rate,
        numberOfChannels: format.channels,
      });

      if (!support.supported) {
        console.log(
          "[NativeOpus] WebCodecs Opus not supported, will use fallback",
        );
        this.useNativeOpus = false;
        return;
      }

      this.webCodecsDecoder = new AudioDecoder({
        output: (audioData: AudioData) => this.handleAudioData(audioData),
        error: (error: Error) => {
          console.error("[NativeOpus] WebCodecs decoder error:", error);
        },
      });

      this.webCodecsDecoder.configure({
        codec: "opus",
        sampleRate: format.sample_rate,
        numberOfChannels: format.channels,
      });

      this.webCodecsFormat = format;
      console.log(
        `[NativeOpus] Using WebCodecs AudioDecoder: ${format.sample_rate}Hz, ${format.channels}ch`,
      );
    } catch (error) {
      console.warn(
        "[NativeOpus] WebCodecs init failed, will use fallback:",
        error,
      );
      this.useNativeOpus = false;
    }
  }

  // Handle decoded audio data from native Opus decoder
  private handleAudioData(audioData: AudioData): void {
    try {
      const outputTimestampUs = Number(audioData.timestamp);
      const metadata = this.nativeDecoderQueue.shift();

      if (!metadata) {
        console.warn(
          `[NativeOpus] Dropping frame with empty decode queue (out ts=${outputTimestampUs})`,
        );
        audioData.close();
        return;
      }

      const { serverTimeUs, generation } = metadata;
      if (generation !== this.stateManager.streamGeneration) {
        console.warn(
          `[NativeOpus] Dropping old-stream frame (ts=${serverTimeUs}, gen=${generation} != current=${this.stateManager.streamGeneration})`,
        );
        audioData.close();
        return;
      }

      const channels = audioData.numberOfChannels;
      const frames = audioData.numberOfFrames;
      const fmt = audioData.format;

      let interleaved: Float32Array;

      if (fmt === "f32-planar") {
        interleaved = new Float32Array(frames * channels);
        for (let ch = 0; ch < channels; ch++) {
          const channelData = new Float32Array(frames);
          audioData.copyTo(channelData, { planeIndex: ch });
          for (let i = 0; i < frames; i++) {
            interleaved[i * channels + ch] = channelData[i];
          }
        }
      } else if (fmt === "f32") {
        interleaved = new Float32Array(frames * channels);
        audioData.copyTo(interleaved, { planeIndex: 0 });
      } else if (fmt === "s16-planar") {
        interleaved = new Float32Array(frames * channels);
        for (let ch = 0; ch < channels; ch++) {
          const channelData = new Int16Array(frames);
          audioData.copyTo(channelData, { planeIndex: ch });
          for (let i = 0; i < frames; i++) {
            interleaved[i * channels + ch] = channelData[i] / 32768.0;
          }
        }
      } else if (fmt === "s16") {
        const int16Data = new Int16Array(frames * channels);
        audioData.copyTo(int16Data, { planeIndex: 0 });
        interleaved = new Float32Array(frames * channels);
        for (let i = 0; i < frames * channels; i++) {
          interleaved[i] = int16Data[i] / 32768.0;
        }
      } else {
        console.warn(`[NativeOpus] Unsupported AudioData format: ${fmt}`);
        audioData.close();
        return;
      }

      this.handleNativeOpusOutput(interleaved, serverTimeUs, channels);
      audioData.close();
    } catch (e) {
      console.error("[NativeOpus] Error in output callback:", e);
      audioData.close();
    }
  }

  private resolveOpusDecoderModule(moduleExport: any): any {
    const maybeDefault = moduleExport?.default;
    const maybeCommonJs = moduleExport?.["module.exports"];
    const resolved = maybeDefault ?? maybeCommonJs ?? moduleExport;

    if (!resolved || typeof resolved !== "object") {
      throw new Error("[Opus] Invalid libopus decoder module export");
    }
    return resolved;
  }

  private resolveOggOpusDecoderClass(wrapperExport: any): any {
    const maybeDefault = wrapperExport?.default;
    const maybeCommonJs = wrapperExport?.["module.exports"];
    const wrapper = maybeDefault ?? maybeCommonJs ?? wrapperExport;
    const resolved = wrapper?.OggOpusDecoder ?? wrapper;

    if (typeof resolved !== "function") {
      throw new Error("[Opus] OggOpusDecoder class export not found");
    }
    return resolved;
  }

  private async waitForOpusReady(target: {
    isReady: boolean;
    onready?: () => void;
  }): Promise<void> {
    if (target.isReady) return;

    if (Object.isExtensible(target)) {
      await new Promise<void>((resolve) => {
        target.onready = () => resolve();
      });
      return;
    }

    while (!target.isReady) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }

  // Initialize opus-encdec decoder (fallback when WebCodecs unavailable)
  private async initOpusEncdecDecoder(format: StreamFormat): Promise<void> {
    if (this.opusDecoderReady) {
      await this.opusDecoderReady;
      return;
    }

    this.opusDecoderReady = (async () => {
      console.log("[Opus] Initializing decoder (opus-encdec)...");

      // Dynamically import the pure JavaScript decoder (not WASM) to avoid bundling issues
      const [DecoderModuleExport, DecoderWrapperExport] = await Promise.all([
        import("opus-encdec/dist/libopus-decoder.js"),
        import("opus-encdec/src/oggOpusDecoder.js"),
      ]);

      this.opusDecoderModule =
        this.resolveOpusDecoderModule(DecoderModuleExport);

      const OggOpusDecoderClass =
        this.resolveOggOpusDecoderClass(DecoderWrapperExport);

      // Wait for Module to be ready (async asm.js initialization)
      await this.waitForOpusReady(this.opusDecoderModule);

      // Create decoder instance
      this.opusDecoder = new OggOpusDecoderClass(
        {
          rawOpus: true, // We're decoding raw Opus packets, not Ogg containers
          decoderSampleRate: format.sample_rate,
          outputBufferSampleRate: format.sample_rate,
          numberOfChannels: format.channels,
        },
        this.opusDecoderModule,
      );

      // Wait for decoder to be ready if needed
      await this.waitForOpusReady(this.opusDecoder);

      console.log("[Opus] Decoder ready");
    })();

    await this.opusDecoderReady;
  }

  // Handle native Opus decoder output - creates AudioBuffer and adds to queue
  private handleNativeOpusOutput(
    interleaved: Float32Array,
    serverTimeUs: number,
    channels: number,
  ): void {
    if (!this.audioContext || !this.webCodecsFormat) {
      return;
    }

    const numFrames = interleaved.length / channels;
    const audioBuffer = this.audioContext.createBuffer(
      channels,
      numFrames,
      this.webCodecsFormat.sample_rate,
    );

    // De-interleave samples into separate channels
    for (let ch = 0; ch < channels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < numFrames; i++) {
        channelData[i] = interleaved[i * channels + ch];
      }
    }

    // Add to queue directly
    this.audioBufferQueue.push({
      buffer: audioBuffer,
      serverTime: serverTimeUs,
      generation: this.stateManager.streamGeneration,
    });

    this.scheduleQueueProcessing();
  }

  private scheduleTimeout: ReturnType<typeof setTimeout> | null = null;
  private queueProcessScheduled = false;

  // Schedule queue processing without starvation.
  // Uses a short timeout to allow out-of-order async decodes (FLAC) to batch.
  // TODO: Consider a "max-wait" watchdog if timer throttling/clamping causes excessive scheduling latency.
  private scheduleQueueProcessing(): void {
    if (this.queueProcessScheduled) {
      return;
    }
    this.queueProcessScheduled = true;

    if (typeof globalThis.setTimeout === "function") {
      this.scheduleTimeout = globalThis.setTimeout(() => {
        this.scheduleTimeout = null;
        this.queueProcessScheduled = false;
        this.processAudioQueue();
      }, 15);
      return;
    }

    const run = () => {
      this.queueProcessScheduled = false;
      this.processAudioQueue();
    };

    if (
      typeof (globalThis as unknown as { queueMicrotask?: unknown })
        .queueMicrotask === "function"
    ) {
      (
        globalThis as unknown as { queueMicrotask: (cb: () => void) => void }
      ).queueMicrotask(run);
    } else {
      Promise.resolve().then(run);
    }
  }

  // Queue Opus packet to native decoder for async decoding (non-blocking)
  private queueToNativeOpusDecoder(
    audioData: ArrayBuffer,
    serverTimeUs: number,
    generation: number,
  ): boolean {
    if (
      !this.webCodecsDecoder ||
      this.webCodecsDecoder.state !== "configured"
    ) {
      return false;
    }

    try {
      this.nativeDecoderQueue.push({
        serverTimeUs,
        generation,
      });

      const chunk = new EncodedAudioChunk({
        type: "key", // Opus packets are self-contained
        // Keep server time as timestamp for easier debugging/inspection.
        timestamp: serverTimeUs,
        data: audioData,
      });

      // Queue for async decoding (non-blocking)
      this.webCodecsDecoder.decode(chunk);
      return true;
    } catch (error) {
      if (this.nativeDecoderQueue.length > 0) {
        this.nativeDecoderQueue.pop();
      }
      console.error("[NativeOpus] WebCodecs queue error:", error);
      return false;
    }
  }

  // Decode using opus-encdec library (fallback)
  private async decodeOpusWithEncdec(
    audioData: ArrayBuffer,
    format: StreamFormat,
  ): Promise<AudioBuffer | null> {
    if (!this.audioContext) {
      return null;
    }

    try {
      // Initialize fallback decoder if needed
      await this.initOpusEncdecDecoder(format);

      // Decode the raw Opus packet
      const uint8Array = new Uint8Array(audioData);
      const decodedSamples: Float32Array[] = [];

      this.opusDecoder.decodeRaw(uint8Array, (samples: Float32Array) => {
        // Copy samples since they're from WASM heap
        decodedSamples.push(new Float32Array(samples));
      });

      if (decodedSamples.length === 0) {
        console.warn("[Opus] Fallback decoder produced no samples");
        return null;
      }

      // Convert interleaved samples to AudioBuffer
      const interleavedSamples = decodedSamples[0];
      const numFrames = interleavedSamples.length / format.channels;

      const audioBuffer = this.audioContext.createBuffer(
        format.channels,
        numFrames,
        format.sample_rate,
      );

      // De-interleave samples into separate channels
      for (let ch = 0; ch < format.channels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        for (let i = 0; i < numFrames; i++) {
          channelData[i] = interleavedSamples[i * format.channels + ch];
        }
      }

      return audioBuffer;
    } catch (error) {
      console.error("[Opus] Decode error:", error);
      return null;
    }
  }

  // Decode PCM audio data
  private decodePCMData(
    audioData: ArrayBuffer,
    format: StreamFormat,
  ): AudioBuffer | null {
    if (!this.audioContext) return null;

    const bytesPerSample = (format.bit_depth || 16) / 8;
    const dataView = new DataView(audioData);
    const numSamples =
      audioData.byteLength / (bytesPerSample * format.channels);

    const audioBuffer = this.audioContext.createBuffer(
      format.channels,
      numSamples,
      format.sample_rate,
    );

    // Decode PCM data (interleaved format)
    for (let channel = 0; channel < format.channels; channel++) {
      const channelData = audioBuffer.getChannelData(channel);
      for (let i = 0; i < numSamples; i++) {
        const offset = (i * format.channels + channel) * bytesPerSample;
        let sample = 0;

        if (format.bit_depth === 16) {
          sample = dataView.getInt16(offset, true) / 32768.0;
        } else if (format.bit_depth === 24) {
          // 24-bit is stored in 3 bytes (little-endian)
          const byte1 = dataView.getUint8(offset);
          const byte2 = dataView.getUint8(offset + 1);
          const byte3 = dataView.getUint8(offset + 2);
          // Reconstruct as signed 24-bit value
          let int24 = (byte3 << 16) | (byte2 << 8) | byte1;
          // Sign extend if necessary
          if (int24 & 0x800000) {
            int24 |= 0xff000000;
          }
          sample = int24 / 8388608.0;
        } else if (format.bit_depth === 32) {
          sample = dataView.getInt32(offset, true) / 2147483648.0;
        }

        channelData[i] = sample;
      }
    }

    return audioBuffer;
  }

  // Handle binary audio message
  async handleBinaryMessage(data: ArrayBuffer): Promise<void> {
    const format = this.stateManager.currentStreamFormat;
    if (!format) {
      console.warn("Sendspin: Received audio chunk but no stream format set");
      return;
    }
    if (!this.audioContext) {
      console.warn("Sendspin: Received audio chunk but no audio context");
      return;
    }
    if (!this.gainNode) {
      console.warn("Sendspin: Received audio chunk but no gain node");
      return;
    }

    // Capture stream generation before async decode
    const generation = this.stateManager.streamGeneration;

    // First byte contains role type and message slot
    // Spec: bits 7-2 identify role type (6 bits), bits 1-0 identify message slot (2 bits)
    const firstByte = new Uint8Array(data)[0];

    // Type 4 is audio chunk (Player role, slot 0) - IDs 4-7 are player role
    if (firstByte === 4) {
      // Next 8 bytes are server timestamp in microseconds (big-endian int64)
      const timestampView = new DataView(data, 1, 8);
      // Read as big-endian int64 and convert to number
      const serverTimeUs = Number(timestampView.getBigInt64(0, false));

      // Rest is audio data
      const audioData = data.slice(9);

      // For Opus: use native decoder (non-blocking async path)
      if (format.codec === "opus" && this.useNativeOpus) {
        await this.initWebCodecsDecoder(format);

        if (this.useNativeOpus && this.webCodecsDecoder) {
          if (
            this.queueToNativeOpusDecoder(audioData, serverTimeUs, generation)
          ) {
            return; // Async path - callback handles queue
          }
          // Fall through to fallback on error
        }
      }

      // Fallback decode path (PCM, FLAC, or Opus via opus-encdec)
      const audioBuffer = await this.decodeAudioData(audioData, format);

      if (audioBuffer) {
        // Check if stream generation changed during async decode
        if (generation !== this.stateManager.streamGeneration) {
          return;
        }

        // Add to queue for ordered playback
        this.audioBufferQueue.push({
          buffer: audioBuffer,
          serverTime: serverTimeUs,
          generation: generation,
        });

        this.scheduleQueueProcessing();
      } else {
        console.error("Sendspin: Failed to decode audio buffer");
      }
    }
  }

  // Process the audio queue and schedule chunks in order
  processAudioQueue(): void {
    if (!this.audioContext || !this.gainNode) return;
    if (this.audioContext.state !== "running") return;

    // Filter out any chunks from old streams (safety check)
    const currentGeneration = this.stateManager.streamGeneration;
    this.audioBufferQueue = this.audioBufferQueue.filter(
      (chunk) => chunk.generation === currentGeneration,
    );

    // Sort queue by server timestamp to ensure proper ordering
    this.audioBufferQueue.sort((a, b) => a.serverTime - b.serverTime);

    // Don't schedule until time sync is ready
    if (!this.timeFilter.is_synchronized) {
      return;
    }

    const {
      audioContextTimeSec: audioContextTime,
      audioContextRawTimeSec,
      nowMs,
      nowUs,
    } = this.getTimingSnapshot();
    this.pruneExpiredScheduledSources(audioContextRawTimeSec);

    const outputLatencySec = this.useOutputLatencyCompensation
      ? this.getSmoothedOutputLatencyUs() / 1_000_000
      : 0;
    const syncDelaySec = this.syncDelayMs / 1000;
    const targetScheduledHorizonSec = this.getTargetScheduledHorizonSec();

    if (this.usesRecorrectionMonitor) {
      this.startRecorrectionMonitor();
    }

    if (this.pendingClockSourceCutover) {
      this.pendingClockSourceCutover = false;
      if (
        this.scheduledSources.length > 0 ||
        this.nextPlaybackTime !== 0 ||
        this.lastScheduledServerTime !== 0
      ) {
        this.performGuardedCutover("delay-change", {
          incrementResyncCount: false,
          markCooldown: false,
        });
        return;
      }
    }

    // Schedule chunks until we have enough future audio to survive short JS throttling.
    while (this.audioBufferQueue.length > 0) {
      const scheduledAheadSec = this.getScheduledAheadSec(
        audioContextRawTimeSec,
      );
      if (
        this.nextPlaybackTime > 0 &&
        scheduledAheadSec >= targetScheduledHorizonSec
      ) {
        break;
      }

      const chunk = this.audioBufferQueue.shift()!;

      let playbackTime: number;
      let scheduleTime: number;
      let playbackRate: number;

      // Always compute the drift-corrected target time
      const targetPlaybackTime = this.computeTargetPlaybackTime(
        chunk.serverTime,
        audioContextTime,
        nowUs,
        outputLatencySec,
      );

      // First chunk or after a gap: calculate from server timestamp
      if (this.nextPlaybackTime === 0 || this.lastScheduledServerTime === 0) {
        this.armHardResyncStartupGrace(nowMs);
        playbackTime = targetPlaybackTime;
        scheduleTime = playbackTime - syncDelaySec;
        if (this.recorrectionMinScheduleTimeSec !== null) {
          scheduleTime = Math.max(
            scheduleTime,
            this.recorrectionMinScheduleTimeSec,
          );
          playbackTime = scheduleTime + syncDelaySec;
        }
        this.recorrectionMinScheduleTimeSec = null;
        playbackRate = 1.0;
        chunk.buffer = this.copyBuffer(chunk.buffer);
      } else {
        // Subsequent chunks: schedule back-to-back for seamless playback
        // Check if this chunk is contiguous with the last one
        const expectedServerTime = this.lastScheduledServerTime;
        const serverGapUs = chunk.serverTime - expectedServerTime;
        const serverGapSec = serverGapUs / 1_000_000;

        if (Math.abs(serverGapSec) < 0.1) {
          // Chunk is contiguous (within 100ms)
          // Calculate sync error (positive = behind target, negative = ahead)
          const syncErrorSec = this.nextPlaybackTime - targetPlaybackTime;
          const syncErrorMs = syncErrorSec * 1000;

          // Apply EMA smoothing to filter jitter - use smoothed value for corrections
          const correctionErrorMs = this.applySyncErrorEma(syncErrorMs);

          // Get thresholds for current correction mode
          const thresholds = CORRECTION_THRESHOLDS[this._correctionMode];
          const canUseHardResync = this.canUseHardResync(nowMs);

          if (
            Math.abs(correctionErrorMs) > thresholds.resyncAboveMs &&
            canUseHardResync
          ) {
            // Tier 4: Hard resync if sync error exceeds threshold
            this.noteHardResync(nowMs);
            this.resyncCount++;
            this._intervalResyncCount++;
            this.resetSyncErrorEma();
            this.cutScheduledSources(targetPlaybackTime - syncDelaySec);
            playbackTime = targetPlaybackTime;
            scheduleTime = playbackTime - syncDelaySec;
            playbackRate = 1.0;
            this.currentCorrectionMethod = "resync";
            this.lastSamplesAdjusted = 0;
            chunk.buffer = this.copyBuffer(chunk.buffer);
          } else if (Math.abs(correctionErrorMs) > thresholds.resyncAboveMs) {
            // We cannot hard resync right now because startup grace or the
            // cooldown is active, so use the strongest smooth correction instead.
            playbackTime = this.nextPlaybackTime;
            scheduleTime = this.nextScheduleTime;
            playbackRate = Number.isFinite(thresholds.rate2AboveMs)
              ? correctionErrorMs > 0
                ? 1.02
                : 0.98
              : 1.0;
            this.currentCorrectionMethod =
              playbackRate === 1.0 ? "none" : "rate";
            this.lastSamplesAdjusted = 0;
            chunk.buffer = this.copyBuffer(chunk.buffer);
          } else if (Math.abs(correctionErrorMs) < thresholds.deadbandBelowMs) {
            // Tier 1: Within deadband - no correction needed
            playbackTime = this.nextPlaybackTime;
            scheduleTime = this.nextScheduleTime;
            playbackRate = 1.0;
            this.currentCorrectionMethod = "none";
            this.lastSamplesAdjusted = 0;
            chunk.buffer = this.copyBuffer(chunk.buffer);
          } else if (Math.abs(correctionErrorMs) <= thresholds.samplesBelowMs) {
            // Tier 2: Small error - use single sample insertion/deletion
            playbackTime = this.nextPlaybackTime;
            scheduleTime = this.nextScheduleTime;
            playbackRate = 1.0;
            const samplesToAdjust = correctionErrorMs > 0 ? -1 : 1;
            chunk.buffer = this.adjustBufferSamples(
              chunk.buffer,
              samplesToAdjust,
            );
            this.currentCorrectionMethod = "samples";
            this.lastSamplesAdjusted = samplesToAdjust;
          } else {
            // Tier 3: Medium error - use playback rate adjustment
            playbackTime = this.nextPlaybackTime;
            scheduleTime = this.nextScheduleTime;
            const absErrorMs = Math.abs(correctionErrorMs);

            if (correctionErrorMs > 0) {
              playbackRate =
                absErrorMs >= thresholds.rate2AboveMs
                  ? 1.02
                  : absErrorMs >= thresholds.rate1AboveMs
                    ? 1.01
                    : 1.0;
            } else {
              playbackRate =
                absErrorMs >= thresholds.rate2AboveMs
                  ? 0.98
                  : absErrorMs >= thresholds.rate1AboveMs
                    ? 0.99
                    : 1.0;
            }

            this.currentCorrectionMethod =
              playbackRate === 1.0 ? "none" : "rate";
            this.lastSamplesAdjusted = 0;
            chunk.buffer = this.copyBuffer(chunk.buffer);
          }
        } else {
          // Gap detected in server timestamps - hard resync
          this.noteHardResync(nowMs);
          this.resyncCount++;
          this._intervalResyncCount++;
          this.cutScheduledSources(targetPlaybackTime - syncDelaySec);
          playbackTime = targetPlaybackTime;
          scheduleTime = playbackTime - syncDelaySec;
          playbackRate = 1.0;
          this.currentCorrectionMethod = "resync";
          this.lastSamplesAdjusted = 0;
          chunk.buffer = this.copyBuffer(chunk.buffer);
        }
      }

      // Track current rate for debugging
      this.currentPlaybackRate = playbackRate;

      // Drop only if we already missed the logical playback time. Missing the
      // early-start window just means we apply less sync delay for this chunk.
      if (playbackTime < audioContextRawTimeSec) {
        // Reset seamless tracking since we dropped a chunk
        this.nextPlaybackTime = 0;
        this.nextScheduleTime = 0;
        this.lastScheduledServerTime = 0;
        continue;
      }

      const effectiveScheduleTime = Math.max(
        scheduleTime,
        audioContextRawTimeSec,
      );
      const effectivePlaybackTime =
        effectiveScheduleTime + (playbackTime - scheduleTime);

      const source = this.audioContext.createBufferSource();
      source.buffer = chunk.buffer;
      source.playbackRate.value = playbackRate; // Apply rate correction
      source.connect(this.gainNode);
      source.start(effectiveScheduleTime);

      // Track for seamless scheduling of next chunk
      // Account for actual duration with playback rate adjustment
      const actualDuration = chunk.buffer.duration / playbackRate;
      this.nextPlaybackTime = effectivePlaybackTime + actualDuration;
      this.nextScheduleTime = effectiveScheduleTime + actualDuration;
      this.lastScheduledServerTime =
        chunk.serverTime + chunk.buffer.duration * 1_000_000;

      const scheduledEntry = {
        source,
        startTime: effectiveScheduleTime,
        endTime: effectiveScheduleTime + actualDuration,
        buffer: chunk.buffer,
        serverTime: chunk.serverTime,
        generation: chunk.generation,
      };
      this.scheduledSources.push(scheduledEntry);
      source.onended = () => {
        const idx = this.scheduledSources.indexOf(scheduledEntry);
        if (idx > -1) this.scheduledSources.splice(idx, 1);
        if (this.scheduledSources.length === 0) {
          this.resetScheduledPlaybackState("all scheduled audio ended");
          if (this.audioBufferQueue.length > 0) {
            this.processAudioQueue();
          }
        }
      };
    }
    this.emitStatusLog(nowMs);
  }

  private computeTargetPlaybackTime(
    serverTimeUs: number,
    audioContextTime: number,
    nowUs: number,
    outputLatencySec: number,
  ): number {
    const chunkClientTimeUs = this.timeFilter.computeClientTime(serverTimeUs);
    const deltaUs = chunkClientTimeUs - nowUs;
    const deltaSec = deltaUs / 1_000_000;
    return (
      audioContextTime + deltaSec + SCHEDULE_HEADROOM_SEC - outputLatencySec
    );
  }

  // Start audio element playback (for MediaSession)
  startAudioElement(): void {
    if (this.outputMode === "media-element" && this.audioElement) {
      if (this.audioElement.paused) {
        this.audioElement.play().catch((e) => {
          console.warn("Sendspin: Failed to start audio element:", e);
        });
      }
    }
    // No-op for direct mode
  }

  // Stop audio element playback (for MediaSession)
  stopAudioElement(): void {
    if (this.outputMode === "media-element" && this.audioElement) {
      if (!this.audioElement.paused) {
        this.audioElement.pause();
      }
    }
    // No-op for direct mode
  }

  // Clear all audio buffers and scheduled sources
  clearBuffers(): void {
    this.stopRecorrectionMonitor();

    // Stop all scheduled audio sources
    this.scheduledSources.forEach((entry) => {
      try {
        entry.source.stop();
      } catch (e) {
        // Ignore errors if source already stopped
      }
    });
    this.scheduledSources = [];

    // Clear buffers and reset scheduling state
    this.audioBufferQueue = [];
    if (this.scheduleTimeout !== null) {
      clearTimeout(this.scheduleTimeout);
      this.scheduleTimeout = null;
    }
    this.queueProcessScheduled = false;

    // Drop any pending native Opus decode outputs from the previous stream.
    // We close and recreate the decoder on next use to ensure stale callbacks
    // cannot be correlated with new-stream metadata.
    this.nativeDecoderQueue = [];
    try {
      this.webCodecsDecoder?.close();
    } catch {
      // Ignore close errors
    }
    this.webCodecsDecoder = null;
    this.webCodecsDecoderReady = null;
    this.webCodecsFormat = null;

    // Reset stream anchors
    this.stateManager.resetStreamAnchors();

    // Reset sync stats and timing sources
    this.resetScheduledPlaybackState();
    this.resyncCount = 0;
    this.lastRawOutputLatencyUs = 0;
    this.resetLatencySmoother();
    this.timingEstimateAudioContextTimeSec = null;
    this.timingEstimateAtMs = null;
    this.resetOutputTimestampValidation();
  }

  // Cleanup and close AudioContext
  close(): void {
    this.clearBuffers();

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    // Clean up native Opus decoder
    if (this.webCodecsDecoder) {
      try {
        this.webCodecsDecoder.close();
      } catch (e) {
        // Ignore if already closed
      }
      this.webCodecsDecoder = null;
      this.webCodecsDecoderReady = null;
      this.webCodecsFormat = null;
    }

    // Clean up fallback Opus decoder
    if (this.opusDecoder) {
      this.opusDecoder = null;
      this.opusDecoderModule = null;
      this.opusDecoderReady = null;
    }

    // Reset native Opus flag for next session
    this.useNativeOpus = true;

    this.gainNode = null;
    this.streamDestination = null;

    // Always stop and clear the audio element on full disconnect/teardown.
    if (this.outputMode === "media-element" && this.audioElement) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
      this.audioElement.loop = false;
      this.audioElement.removeAttribute("src");
      this.audioElement.load();

      if (this.ownsAudioElement) {
        this.audioElement.remove();
        this.audioElement = undefined;
      }
    }
  }

  // Get AudioContext for external use
  getAudioContext(): AudioContext | null {
    return this.audioContext;
  }
}
