/**
 * Audio clock source selection and output timestamp validation.
 *
 * Manages two clock sources for AudioContext time:
 * - "estimated": De-quantized AudioContext.currentTime using wall-clock slew
 * - "timestamp": AudioContext.getOutputTimestamp() with extensive validation
 *
 * Promotes to "timestamp" after enough good samples, demotes on failures.
 */

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

// Timing estimate constants
const TIMING_MAX_SLEW_SEC = 0.002;
const TIMING_RESET_THRESHOLD_SEC = 0.5;
const TIMING_MAX_LEAD_SEC = 0.1;

export interface TimingSnapshot {
  audioContextTimeSec: number;
  audioContextRawTimeSec: number;
  nowMs: number;
  nowUs: number;
}

export class ClockSource {
  private activeSource: AudioClockSource = "estimated";
  private _pendingCutover = false;
  private _lastRejectReason: string | null = null;
  private _timestampPromotionDisabled = false;
  private _onPromotion?: () => void;

  // Output timestamp validation state
  private lastSample: OutputTimestampSample | null = null;
  private goodSamples: number = 0;
  private badSamples: number = 0;
  private goodSinceMs: number | null = null;

  // Estimated time state
  private estimateAudioTimeSec: number | null = null;
  private estimateAtMs: number | null = null;

  get active(): AudioClockSource {
    return this.activeSource;
  }

  get pendingCutover(): boolean {
    return this._pendingCutover;
  }

  set pendingCutover(value: boolean) {
    this._pendingCutover = value;
  }

  get lastRejectReason(): string | null {
    return this._lastRejectReason;
  }

  get timestampGoodSamples(): number {
    return this.goodSamples;
  }

  get timestampPromotionDisabled(): boolean {
    return this._timestampPromotionDisabled;
  }

  /** Disable timestamp promotion (e.g., on Cast receivers to avoid rate oscillations). */
  disableTimestampPromotion(): void {
    this._timestampPromotionDisabled = true;
  }

  setActive(source: AudioClockSource): boolean {
    if (this.activeSource === source) return false;
    this.activeSource = source;
    this._pendingCutover = source === "timestamp";
    if (this._pendingCutover) {
      this._onPromotion?.();
    }
    return this._pendingCutover;
  }

  onPromotion(cb: () => void): void {
    this._onPromotion = cb;
  }

  reset(): void {
    this.activeSource = "estimated";
    this._pendingCutover = false;
    this.lastSample = null;
    this.goodSamples = 0;
    this._lastRejectReason = null;
    this.badSamples = 0;
    this.goodSinceMs = null;
    this.estimateAudioTimeSec = null;
    this.estimateAtMs = null;
  }

  private demote(reason: string): void {
    this.reset();
    this._lastRejectReason = reason;
  }

  private rejectSample(reason: string, catastrophic = false): void {
    this.lastSample = null;
    this.goodSamples = 0;
    this.goodSinceMs = null;
    this._lastRejectReason = reason;

    if (this.activeSource !== "timestamp") {
      this.badSamples = 0;
      return;
    }

    this.badSamples += 1;
    if (
      catastrophic ||
      this.badSamples >= OUTPUT_TIMESTAMP_MAX_CONSECUTIVE_BAD_SAMPLES
    ) {
      this.demote(reason);
    }
  }

  private getEstimatedTime(rawTimeSec: number, nowMs: number): number {
    if (this.estimateAudioTimeSec === null) {
      this.estimateAudioTimeSec = rawTimeSec;
      this.estimateAtMs = nowMs;
    } else if (this.estimateAtMs !== null) {
      const wallDeltaSec = Math.max(0, (nowMs - this.estimateAtMs) / 1000);
      const predicted = this.estimateAudioTimeSec + wallDeltaSec;
      this.estimateAtMs = nowMs;

      const errorSec = rawTimeSec - predicted;
      if (Math.abs(errorSec) > TIMING_RESET_THRESHOLD_SEC) {
        this.estimateAudioTimeSec = rawTimeSec;
      } else {
        const slew = Math.max(
          -TIMING_MAX_SLEW_SEC,
          Math.min(TIMING_MAX_SLEW_SEC, errorSec),
        );
        const next = Math.max(this.estimateAudioTimeSec, predicted + slew);
        this.estimateAudioTimeSec = Math.min(
          next,
          rawTimeSec + TIMING_MAX_LEAD_SEC,
        );
      }
    }

    return this.estimateAudioTimeSec ?? rawTimeSec;
  }

  private getTimestampDerivedTime(
    rawTimeSec: number,
    audioContext: AudioContext,
  ): number | null {
    // On Cast receivers, stay on the estimated clock to avoid rate oscillations.
    if (this._timestampPromotionDisabled) {
      if (
        this.activeSource !== "estimated" ||
        this.lastSample !== null ||
        this.goodSamples !== 0 ||
        this._lastRejectReason !== null
      ) {
        this.reset();
      }
      return null;
    }

    const getOutputTimestamp = (
      audioContext as unknown as {
        getOutputTimestamp?: () => {
          contextTime: number;
          performanceTime: number;
        };
      }
    ).getOutputTimestamp;

    if (typeof getOutputTimestamp !== "function") {
      if (this.activeSource === "timestamp") {
        this.demote("getOutputTimestamp unavailable");
      }
      return null;
    }

    try {
      const ts = getOutputTimestamp.call(audioContext);
      const nowMs = performance.now();
      const rawFreshnessMs = nowMs - ts.performanceTime;
      if (rawFreshnessMs < -OUTPUT_TIMESTAMP_FUTURE_TOLERANCE_MS) {
        this.rejectSample(
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
        this.rejectSample(
          `stale timestamp (${freshnessMs.toFixed(1)}ms old)`,
          true,
        );
        return null;
      }

      const divergenceSec = predictedAudioTimeSec - rawTimeSec;
      if (Math.abs(divergenceSec) > OUTPUT_TIMESTAMP_MAX_DIVERGENCE_SEC) {
        this.rejectSample(
          `timestamp/raw divergence ${Math.abs(divergenceSec * 1000).toFixed(1)}ms`,
          true,
        );
        return null;
      }

      const prev = this.lastSample;
      if (prev) {
        const perfDeltaMs = ts.performanceTime - prev.performanceTimeMs;
        if (perfDeltaMs < 0) {
          this.rejectSample(
            `performanceTime moved backward (${perfDeltaMs.toFixed(1)}ms)`,
            true,
          );
          return null;
        }

        if (
          predictedAudioTimeSec <
          prev.predictedAudioTimeSec - OUTPUT_TIMESTAMP_MAX_BACKWARD_SEC
        ) {
          this.rejectSample(
            `predicted audio time moved backward ${((prev.predictedAudioTimeSec - predictedAudioTimeSec) * 1000).toFixed(1)}ms`,
            true,
          );
          return null;
        }

        const prevDivergenceSec =
          prev.predictedAudioTimeSec - prev.rawAudioTimeSec;
        if (
          Math.abs(divergenceSec - prevDivergenceSec) >
          OUTPUT_TIMESTAMP_MAX_DIVERGENCE_DELTA_SEC
        ) {
          this.rejectSample(
            `timestamp/raw divergence drift ${Math.abs((divergenceSec - prevDivergenceSec) * 1000).toFixed(1)}ms`,
          );
          return null;
        }

        if (perfDeltaMs >= OUTPUT_TIMESTAMP_MIN_SAMPLE_INTERVAL_MS) {
          const perfDeltaSec = perfDeltaMs / 1000;
          const contextSlope =
            (ts.contextTime - prev.contextTimeSec) / perfDeltaSec;
          const predictedSlope =
            (predictedAudioTimeSec - prev.predictedAudioTimeSec) / perfDeltaSec;

          if (
            contextSlope < OUTPUT_TIMESTAMP_SLOPE_MIN ||
            contextSlope > OUTPUT_TIMESTAMP_SLOPE_MAX
          ) {
            this.rejectSample(
              `context slope ${contextSlope.toFixed(3)} out of range`,
            );
            return null;
          }
          if (
            predictedSlope < OUTPUT_TIMESTAMP_SLOPE_MIN ||
            predictedSlope > OUTPUT_TIMESTAMP_SLOPE_MAX
          ) {
            this.rejectSample(
              `predicted slope ${predictedSlope.toFixed(3)} out of range`,
            );
            return null;
          }
        }
      }

      this.lastSample = sample;
      this.badSamples = 0;
      if (this.goodSinceMs === null) {
        this.goodSinceMs = nowMs;
      }
      this.goodSamples += 1;

      if (
        this.activeSource !== "timestamp" &&
        this.goodSamples >= OUTPUT_TIMESTAMP_PROMOTION_MIN_GOOD_SAMPLES &&
        this.goodSinceMs !== null &&
        nowMs - this.goodSinceMs >= OUTPUT_TIMESTAMP_PROMOTION_MIN_SPAN_MS
      ) {
        this.setActive("timestamp");
        this._lastRejectReason = null;
      }

      return predictedAudioTimeSec;
    } catch (error) {
      const reason =
        error instanceof Error
          ? `getOutputTimestamp failed: ${error.message}`
          : `getOutputTimestamp failed: ${String(error)}`;
      this.rejectSample(reason, true);
      return null;
    }
  }

  /** Get a timing snapshot with both derived and raw AudioContext times. */
  getTimingSnapshot(audioContext: AudioContext | null): TimingSnapshot {
    const nowMs = performance.now();
    const nowUs = nowMs * 1000;
    if (!audioContext) {
      return {
        audioContextTimeSec: 0,
        audioContextRawTimeSec: 0,
        nowMs,
        nowUs,
      };
    }

    const rawTimeSec = audioContext.currentTime;
    const estimatedTimeSec = this.getEstimatedTime(rawTimeSec, nowMs);
    const timestampTimeSec = this.getTimestampDerivedTime(
      rawTimeSec,
      audioContext,
    );

    let derivedTimeSec =
      this.activeSource === "timestamp" && timestampTimeSec !== null
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
}
