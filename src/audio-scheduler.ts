/**
 * Audio scheduler for synchronized playback.
 *
 * Handles Web Audio API scheduling, sync correction, AudioContext management,
 * volume control, and output routing. Receives pre-decoded audio chunks
 * (DecodedAudioChunk) from SendspinCore and schedules them for playback.
 */

import type {
  AudioBufferQueueItem,
  AudioOutputMode,
  CorrectionMode,
  DecodedAudioChunk,
  SendspinStorage,
} from "./types";
import type { StateManager } from "./state-manager";
import type { SendspinTimeFilter } from "./time-filter";

// Sync correction constants
const SAMPLE_CORRECTION_FADE_LEN = 8;
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
const OUTPUT_LATENCY_ALPHA = 0.01;
const SYNC_ERROR_ALPHA = 0.1;
const OUTPUT_LATENCY_STORAGE_KEY = "sendspin-output-latency-us";
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

const CORRECTION_THRESHOLDS: Record<
  CorrectionMode,
  {
    resyncAboveMs: number;
    rate2AboveMs: number;
    rate1AboveMs: number;
    samplesBelowMs: number;
    deadbandBelowMs: number;
    enableRecorrectionMonitor: boolean;
    immediateDelayCutover: boolean;
  }
> = {
  sync: {
    resyncAboveMs: 200,
    rate2AboveMs: 35,
    rate1AboveMs: 8,
    samplesBelowMs: 8,
    deadbandBelowMs: 1,
    enableRecorrectionMonitor: true,
    immediateDelayCutover: true,
  },
  quality: {
    resyncAboveMs: 35,
    rate2AboveMs: Infinity,
    rate1AboveMs: Infinity,
    samplesBelowMs: 35,
    deadbandBelowMs: 1,
    enableRecorrectionMonitor: false,
    immediateDelayCutover: false,
  },
  "quality-local": {
    resyncAboveMs: 600,
    rate2AboveMs: Infinity,
    rate1AboveMs: Infinity,
    samplesBelowMs: 0,
    deadbandBelowMs: 5,
    enableRecorrectionMonitor: false,
    immediateDelayCutover: false,
  },
};

export class AudioScheduler {
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

  private nextPlaybackTime: number = 0;
  private nextScheduleTime: number = 0;
  private lastScheduledServerTime: number = 0;

  private currentSyncErrorMs: number = 0;
  private smoothedSyncErrorMs: number = 0;
  private resyncCount: number = 0;
  private currentPlaybackRate: number = 1.0;
  private currentCorrectionMethod: "none" | "samples" | "rate" | "resync" =
    "none";
  private lastSamplesAdjusted: number = 0;

  private lastRawOutputLatencyUs: number = 0;
  private smoothedOutputLatencyUs: number | null = null;
  private lastLatencyPersistAtMs: number | null = null;

  private timingEstimateAudioContextTimeSec: number | null = null;
  private timingEstimateAtMs: number | null = null;

  private _correctionMode: CorrectionMode = "sync";

  private _lastStatusLogMs: number = 0;
  private _lastTimestampRejectReason: string | null = null;
  private _intervalResyncCount: number = 0;

  private useOutputLatencyCompensation: boolean = true;
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

  private scheduleTimeout: ReturnType<typeof setTimeout> | null = null;
  private queueProcessScheduled = false;

  constructor(
    private stateManager: StateManager,
    private timeFilter: SendspinTimeFilter,
    private outputMode: AudioOutputMode = "direct",
    private audioElement?: HTMLAudioElement,
    private isAndroid: boolean = false,
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
    this.loadPersistedLatency();
  }

  private sanitizeSyncDelayMs(delayMs: number): number {
    if (!isFinite(delayMs)) {
      return 0;
    }
    return Math.max(0, Math.min(5000, Math.round(delayMs)));
  }

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
      // ignore
    }
  }

  private persistLatency(): void {
    if (!this.storage || this.smoothedOutputLatencyUs === null) return;
    try {
      this.storage.setItem(
        OUTPUT_LATENCY_STORAGE_KEY,
        this.smoothedOutputLatencyUs.toString(),
      );
    } catch {
      // ignore
    }
  }


  get correctionMode(): CorrectionMode {
    return this._correctionMode;
  }

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
    const errorMs = this.timeFilter.error / 1000;
    if (errorMs < SCHEDULE_HORIZON_PRECISE_ERROR_MS) {
      return SCHEDULE_HORIZON_PRECISE_SEC;
    }
    if (errorMs <= SCHEDULE_HORIZON_GOOD_ERROR_MS) {
      return SCHEDULE_HORIZON_GOOD_SEC;
    }
    return SCHEDULE_HORIZON_POOR_SEC;
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
    const TIMING_MAX_SLEW_SEC = 0.002;
    const TIMING_RESET_THRESHOLD_SEC = 0.5;
    const TIMING_MAX_LEAD_SEC = 0.1;

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
    audioContextTimeSec: number;
    audioContextRawTimeSec: number;
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

    const queueDepth =
      this.audioBufferQueue.length + this.scheduledSources.length;
    const aheadSec = this.audioContext
      ? this.getScheduledAheadSec(this.audioContext.currentTime)
      : 0;

    let clock: string;
    if (this.activeAudioClockSource === "timestamp") {
      clock = `timestamp(good:${this.outputTimestampGoodSamples})`;
    } else if (this._lastTimestampRejectReason) {
      clock = `estimated(reject:"${this._lastTimestampRejectReason}")`;
    } else {
      clock = "estimated";
    }

    const tf = this.timeFilter.is_synchronized
      ? `synced(err=${(this.timeFilter.error / 1000).toFixed(1)}ms,drift=${this.timeFilter.drift.toFixed(3)},n=${this.timeFilter.count})`
      : `pending(n=${this.timeFilter.count})`;

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

  getRawOutputLatencyUs(): number {
    if (!this.audioContext) return 0;
    const baseLatency = this.audioContext.baseLatency ?? 0;
    const outputLatency = this.audioContext.outputLatency ?? 0;
    const rawUs = (baseLatency + outputLatency) * 1_000_000;
    this.lastRawOutputLatencyUs = rawUs;
    return rawUs;
  }

  getSmoothedOutputLatencyUs(): number {
    const rawLatencyUs = this.getRawOutputLatencyUs();

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

  private resetLatencySmoother(): void {
    this.smoothedOutputLatencyUs = null;
  }

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

          for (let f = 0; f < SAMPLE_CORRECTION_FADE_LEN; f++) {
            const pos = 2 + f;
            if (pos >= newData.length) break;
            const alpha = SAMPLE_CORRECTION_FADE_ALPHAS[f];
            newData[pos] = newData[pos] * (1 - alpha) + insertedSample * alpha;
          }
        }

        return newBuffer;
      } else {
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

  initAudioContext(): void {
    if (this.audioContext) {
      return;
    }

    if (this.outputMode === "media-element" && this.ownsAudioElement) {
      this.audioElement = document.createElement("audio");
      this.audioElement.style.display = "none";
      document.body.appendChild(this.audioElement);
    }

    if ((navigator as any).audioSession) {
      (navigator as any).audioSession.type = "playback";
    }

    const streamSampleRate =
      this.stateManager.currentStreamFormat?.sample_rate || 48000;
    this.audioContext = new AudioContext({ sampleRate: streamSampleRate });
    this.gainNode = this.audioContext.createGain();

    const audioElement = this.audioElement;

    if (this.outputMode === "direct") {
      this.gainNode.connect(this.audioContext.destination);
    } else {
      if (!audioElement) {
        throw new Error(
          "Media-element output requires an audio element to be available during initialization.",
        );
      }

      if (this.isAndroid && this.silentAudioSrc) {
        this.gainNode.connect(this.audioContext.destination);
        audioElement.src = this.silentAudioSrc;
        audioElement.loop = true;
        audioElement.muted = false;
        audioElement.volume = 1.0;
        audioElement.play().catch((e) => {
          console.warn("Sendspin: Audio autoplay blocked:", e);
        });
      } else {
        this.streamDestination =
          this.audioContext.createMediaStreamDestination();
        this.gainNode.connect(this.streamDestination);
        audioElement.srcObject = this.streamDestination.stream;
        audioElement.volume = 1.0;
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
      return { requeuedCount: 0, cutCount: 0, keptTailEndTimeSec: 0 };
    }
    const stopTime = Math.max(cutoffTime, this.audioContext.currentTime);
    let requeued = 0;
    let cutCount = 0;
    let keptTailEndTimeSec = 0;
    this.scheduledSources = this.scheduledSources.filter((entry) => {
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
    return { requeuedCount: requeued, cutCount, keptTailEndTimeSec };
  }

  updateVolume(): void {
    if (!this.gainNode) return;

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

  /** Accept a decoded audio chunk and queue it for synchronized playback. */
  handleDecodedChunk(chunk: DecodedAudioChunk): void {
    if (!this.audioContext || !this.gainNode) return;
    if (chunk.generation !== this.stateManager.streamGeneration) return;

    const numChannels = chunk.samples.length;
    const numFrames = chunk.samples[0].length;
    const audioBuffer = this.audioContext.createBuffer(
      numChannels,
      numFrames,
      chunk.sampleRate,
    );
    for (let ch = 0; ch < numChannels; ch++) {
      audioBuffer.getChannelData(ch).set(chunk.samples[ch]);
    }

    this.audioBufferQueue.push({
      buffer: audioBuffer,
      serverTime: chunk.serverTimeUs,
      generation: chunk.generation,
    });

    this.scheduleQueueProcessing();
  }

  processAudioQueue(): void {
    if (!this.audioContext || !this.gainNode) return;
    if (this.audioContext.state !== "running") return;

    const currentGeneration = this.stateManager.streamGeneration;
    this.audioBufferQueue = this.audioBufferQueue.filter(
      (chunk) => chunk.generation === currentGeneration,
    );

    this.audioBufferQueue.sort((a, b) => a.serverTime - b.serverTime);

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

      const targetPlaybackTime = this.computeTargetPlaybackTime(
        chunk.serverTime,
        audioContextTime,
        nowUs,
        outputLatencySec,
      );

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
        const expectedServerTime = this.lastScheduledServerTime;
        const serverGapUs = chunk.serverTime - expectedServerTime;
        const serverGapSec = serverGapUs / 1_000_000;

        if (Math.abs(serverGapSec) < 0.1) {
          const syncErrorSec = this.nextPlaybackTime - targetPlaybackTime;
          const syncErrorMs = syncErrorSec * 1000;

          const correctionErrorMs = this.applySyncErrorEma(syncErrorMs);

          const thresholds = CORRECTION_THRESHOLDS[this._correctionMode];
          const canUseHardResync = this.canUseHardResync(nowMs);

          if (
            Math.abs(correctionErrorMs) > thresholds.resyncAboveMs &&
            canUseHardResync
          ) {
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
            playbackTime = this.nextPlaybackTime;
            scheduleTime = this.nextScheduleTime;
            playbackRate = 1.0;
            this.currentCorrectionMethod = "none";
            this.lastSamplesAdjusted = 0;
            chunk.buffer = this.copyBuffer(chunk.buffer);
          } else if (Math.abs(correctionErrorMs) <= thresholds.samplesBelowMs) {
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

      this.currentPlaybackRate = playbackRate;

      if (playbackTime < audioContextRawTimeSec) {
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
      source.playbackRate.value = playbackRate;
      source.connect(this.gainNode);
      source.start(effectiveScheduleTime);

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

  startAudioElement(): void {
    if (this.outputMode === "media-element" && this.audioElement) {
      if (this.audioElement.paused) {
        this.audioElement.play().catch((e) => {
          console.warn("Sendspin: Failed to start audio element:", e);
        });
      }
    }
  }

  stopAudioElement(): void {
    if (this.outputMode === "media-element" && this.audioElement) {
      if (!this.audioElement.paused) {
        this.audioElement.pause();
      }
    }
  }

  clearBuffers(): void {
    this.stopRecorrectionMonitor();

    this.scheduledSources.forEach((entry) => {
      try {
        entry.source.stop();
      } catch (e) {
        // Ignore errors if source already stopped
      }
    });
    this.scheduledSources = [];

    this.audioBufferQueue = [];
    if (this.scheduleTimeout !== null) {
      clearTimeout(this.scheduleTimeout);
      this.scheduleTimeout = null;
    }
    this.queueProcessScheduled = false;

    this.stateManager.resetStreamAnchors();

    this.resetScheduledPlaybackState();
    this.resyncCount = 0;
    this.lastRawOutputLatencyUs = 0;
    this.resetLatencySmoother();
    this.timingEstimateAudioContextTimeSec = null;
    this.timingEstimateAtMs = null;
    this.resetOutputTimestampValidation();
  }

  close(): void {
    this.clearBuffers();

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.gainNode = null;
    this.streamDestination = null;

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

  getAudioContext(): AudioContext | null {
    return this.audioContext;
  }
}
