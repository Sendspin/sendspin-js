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
  CorrectionThresholds,
  DecodedAudioChunk,
  SendspinStorage,
} from "../types";
import type { StateManager } from "../core/state-manager";
import type { SendspinTimeFilter } from "../core/time-filter";
import { ClockSource } from "./clock-source";
import {
  RecorrectionMonitor,
  RECORRECTION_CUTOVER_GUARD_SEC,
} from "./recorrection-monitor";
import { OutputLatencyTracker } from "./output-latency-tracker";

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
const SYNC_ERROR_ALPHA = 0.1;
const SCHEDULE_HEADROOM_SEC = 0.2;
const SCHEDULE_HORIZON_PRECISE_SEC = 20;
const SCHEDULE_HORIZON_GOOD_SEC = 8;
const SCHEDULE_HORIZON_POOR_SEC = 4;
const CAST_SCHEDULE_HORIZON_SEC = 1.5;
const SCHEDULE_HORIZON_PRECISE_ERROR_MS = 2;
const SCHEDULE_HORIZON_GOOD_ERROR_MS = 8;
const SCHEDULE_REFILL_THRESHOLD_FRACTION = 0.5;
const SCHEDULE_REFILL_MIN_THRESHOLD_SEC = 0.1;
const SCHEDULE_REFILL_MAX_THRESHOLD_SEC = 5;

const DEFAULT_CORRECTION_THRESHOLDS: Record<
  CorrectionMode,
  CorrectionThresholds
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

  private _correctionMode: CorrectionMode = "sync";
  private correctionThresholds: Record<CorrectionMode, CorrectionThresholds>;

  private _lastStatusLogMs: number = 0;
  private _intervalResyncCount: number = 0;

  private useOutputLatencyCompensation: boolean;
  private scheduleTimeout: ReturnType<typeof setTimeout> | null = null;
  private refillTimeout: ReturnType<typeof setTimeout> | null = null;
  private queueProcessScheduled = false;

  // Sub-modules
  private clockSource = new ClockSource();
  private recorrectionMonitor: RecorrectionMonitor;
  private latencyTracker: OutputLatencyTracker;

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
    storage: SendspinStorage | null = null,
    useOutputLatencyCompensation: boolean = true,
    thresholdOverrides?: Partial<
      Record<CorrectionMode, Partial<CorrectionThresholds>>
    >,
  ) {
    this._correctionMode = correctionMode;
    this.useOutputLatencyCompensation = useOutputLatencyCompensation;
    this.syncDelayMs = this.sanitizeSyncDelayMs(this.syncDelayMs);

    // Merge user-provided threshold overrides with defaults
    this.correctionThresholds = { ...DEFAULT_CORRECTION_THRESHOLDS };
    if (thresholdOverrides) {
      for (const mode of Object.keys(thresholdOverrides) as CorrectionMode[]) {
        const overrides = thresholdOverrides[mode];
        if (overrides) {
          this.correctionThresholds[mode] = {
            ...DEFAULT_CORRECTION_THRESHOLDS[mode],
            ...overrides,
          };
        }
      }
    }

    this.latencyTracker = new OutputLatencyTracker(storage);
    if (this.isCastRuntime) {
      this.clockSource.disableTimestampPromotion();
    }
    this.recorrectionMonitor = new RecorrectionMonitor(() =>
      this.checkRecorrection(),
    );
  }

  private sanitizeSyncDelayMs(delayMs: number): number {
    if (!isFinite(delayMs)) return 0;
    return Math.max(0, Math.min(5000, Math.round(delayMs)));
  }

  get correctionMode(): CorrectionMode {
    return this._correctionMode;
  }

  setCorrectionMode(mode: CorrectionMode): void {
    this._correctionMode = mode;
    if (!this.correctionThresholds[mode].enableRecorrectionMonitor) {
      this.recorrectionMonitor.stop();
    } else {
      this.recorrectionMonitor.start();
    }
  }

  private get usesRecorrectionMonitor(): boolean {
    return this.correctionThresholds[this._correctionMode]
      .enableRecorrectionMonitor;
  }

  private get usesImmediateDelayCutover(): boolean {
    return this.correctionThresholds[this._correctionMode]
      .immediateDelayCutover;
  }

  private getTargetScheduledHorizonSec(): number {
    if (this.isCastRuntime) {
      return CAST_SCHEDULE_HORIZON_SEC;
    }
    const errorMs = this.timeFilter.error / 1000;
    if (errorMs < SCHEDULE_HORIZON_PRECISE_ERROR_MS)
      return SCHEDULE_HORIZON_PRECISE_SEC;
    if (errorMs <= SCHEDULE_HORIZON_GOOD_ERROR_MS)
      return SCHEDULE_HORIZON_GOOD_SEC;
    return SCHEDULE_HORIZON_POOR_SEC;
  }

  private getScheduledAheadSec(currentTimeSec: number): number {
    let farthest = this.nextScheduleTime;
    for (const entry of this.scheduledSources) {
      if (entry.endTime > farthest) farthest = entry.endTime;
    }
    return farthest <= 0 ? 0 : Math.max(0, farthest - currentTimeSec);
  }

  private resetScheduledPlaybackState(_reason?: string): void {
    this.nextPlaybackTime = 0;
    this.nextScheduleTime = 0;
    this.lastScheduledServerTime = 0;
    this.recorrectionMonitor.minScheduleTimeSec = null;
    this.clockSource.pendingCutover = false;
    this.recorrectionMonitor.resetCheckState();
    this.resetSyncErrorEma();
    this.currentSyncErrorMs = 0;
    this.currentPlaybackRate = 1.0;
    this.currentCorrectionMethod = "none";
    this.lastSamplesAdjusted = 0;
    this._lastStatusLogMs = 0;
    this._intervalResyncCount = 0;
  }

  private pruneExpiredScheduledSources(currentTimeSec: number): void {
    if (this.scheduledSources.length === 0) return;
    this.scheduledSources = this.scheduledSources.filter(
      (entry) => entry.endTime > currentTimeSec,
    );
    if (this.scheduledSources.length === 0) {
      this.resetScheduledPlaybackState("no scheduled audio ahead");
    }
  }

  private performGuardedCutover(
    _reason: "recorrection" | "delay-change",
    options: { incrementResyncCount?: boolean; markCooldown?: boolean } = {},
  ): void {
    if (!this.audioContext) return;
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
    this.recorrectionMonitor.minScheduleTimeSec = Math.max(
      cutoffTime,
      cutResult.keptTailEndTimeSec,
    );
    this.nextPlaybackTime = 0;
    this.nextScheduleTime = 0;
    this.lastScheduledServerTime = 0;
    this.recorrectionMonitor.resetCheckState();
    if (markCooldown) this.recorrectionMonitor.markRecorrection(nowMs);
    this.recorrectionMonitor.noteHardResync(nowMs);
    this.processAudioQueue();
  }

  private checkRecorrection(): void {
    if (!this.usesRecorrectionMonitor) {
      this.recorrectionMonitor.resetCheckState();
      return;
    }
    if (!this.audioContext || this.audioContext.state !== "running") {
      this.recorrectionMonitor.resetCheckState();
      return;
    }
    if (
      !this.stateManager.isPlaying ||
      this.nextPlaybackTime === 0 ||
      this.lastScheduledServerTime === 0
    ) {
      this.recorrectionMonitor.resetCheckState();
      return;
    }

    const { audioContextTimeSec, audioContextRawTimeSec, nowMs, nowUs } =
      this.clockSource.getTimingSnapshot(this.audioContext);
    this.pruneExpiredScheduledSources(audioContextRawTimeSec);
    if (this.getScheduledAheadSec(audioContextRawTimeSec) <= 0) {
      this.recorrectionMonitor.resetCheckState();
      if (this.audioBufferQueue.length > 0) this.processAudioQueue();
      return;
    }

    const outputLatencySec = this.useOutputLatencyCompensation
      ? this.latencyTracker.getSmoothedUs(this.audioContext) / 1_000_000
      : 0;
    const targetPlaybackTime = this.computeTargetPlaybackTime(
      this.lastScheduledServerTime,
      audioContextTimeSec,
      nowUs,
      outputLatencySec,
    );
    const syncErrorMs = (this.nextPlaybackTime - targetPlaybackTime) * 1000;
    const smoothedSyncErrorMs = this.applySyncErrorEma(syncErrorMs);

    if (
      this.recorrectionMonitor.shouldRecorrect(
        Math.abs(smoothedSyncErrorMs),
        syncErrorMs,
        nowMs,
      )
    ) {
      this.performGuardedCutover("recorrection", {
        incrementResyncCount: true,
        markCooldown: true,
      });
    }
  }

  getSyncDelayMs(): number {
    return this.syncDelayMs;
  }

  setSyncDelay(delayMs: number): void {
    const sanitized = this.sanitizeSyncDelayMs(delayMs);
    const delta = sanitized - this.syncDelayMs;
    this.syncDelayMs = sanitized;
    if (delta === 0 || !this.usesImmediateDelayCutover) return;
    if (!this.audioContext || this.audioContext.state !== "running") return;
    if (!this.stateManager.isPlaying) return;
    if (
      this.scheduledSources.length === 0 &&
      this.audioBufferQueue.length === 0 &&
      this.nextPlaybackTime === 0
    )
      return;
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
      outputLatencyMs: this.latencyTracker.getLastRawUs() / 1000,
      playbackRate: this.currentPlaybackRate,
      correctionMethod: this.currentCorrectionMethod,
      samplesAdjusted: this.lastSamplesAdjusted,
      correctionMode: this._correctionMode,
    };
  }

  private emitStatusLog(nowMs: number): void {
    if (this._lastStatusLogMs !== 0 && nowMs - this._lastStatusLogMs < 10_000)
      return;
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
    if (this.clockSource.timestampPromotionDisabled) {
      clock = "estimated(cast-disabled)";
    } else if (this.clockSource.active === "timestamp") {
      clock = `timestamp(good:${this.clockSource.timestampGoodSamples})`;
    } else if (this.clockSource.lastRejectReason) {
      clock = `estimated(reject:"${this.clockSource.lastRejectReason}")`;
    } else {
      clock = "estimated";
    }

    const tf = this.timeFilter.is_synchronized
      ? `synced(err=${(this.timeFilter.error / 1000).toFixed(1)}ms,drift=${this.timeFilter.drift.toFixed(3)},n=${this.timeFilter.count})`
      : `pending(n=${this.timeFilter.count})`;

    const smoothedLatUs = this.latencyTracker.getSmoothedUs(this.audioContext);
    const latMs = Math.round(smoothedLatUs / 1000);

    console.log(
      `Sendspin: sync=${this.smoothedSyncErrorMs >= 0 ? "+" : ""}${this.smoothedSyncErrorMs.toFixed(1)}ms` +
        ` corr=${corr} q=${queueDepth}/${aheadSec.toFixed(1)}s resyncs=${this._intervalResyncCount}` +
        ` clock=${clock} tf=${tf} lat=${latMs}ms mode=${this._correctionMode}` +
        ` ctx=${this.audioContext?.state ?? "null"} gen=${this.stateManager.streamGeneration}`,
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
    if (!this.audioContext || samplesToAdjust === 0 || buffer.length < 2)
      return this.copyBuffer(buffer);
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
    if (this.audioContext) return;
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
      if (!audioElement)
        throw new Error("Media-element output requires an audio element.");
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
    if (this.usesRecorrectionMonitor) this.recorrectionMonitor.start();
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
      if (this.audioBufferQueue.length > 0) this.scheduleQueueProcessing();
      if (this.usesRecorrectionMonitor) this.recorrectionMonitor.start();
    }
  }

  private cutScheduledSources(cutoffTime: number): {
    requeuedCount: number;
    cutCount: number;
    keptTailEndTimeSec: number;
  } {
    if (!this.audioContext)
      return { requeuedCount: 0, cutCount: 0, keptTailEndTimeSec: 0 };
    const stopTime = Math.max(cutoffTime, this.audioContext.currentTime);
    let requeued = 0,
      cutCount = 0,
      keptTailEndTimeSec = 0;
    this.scheduledSources = this.scheduledSources.filter((entry) => {
      if (entry.startTime < stopTime) {
        keptTailEndTimeSec = Math.max(keptTailEndTimeSec, entry.endTime);
        return true;
      }
      try {
        entry.source.onended = null;
        entry.source.stop(stopTime);
      } catch {
        /* ignore */
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
    this.gainNode.gain.value = this.stateManager.muted
      ? 0
      : this.stateManager.volume / 100;
  }

  measureBufferedPlaybackRunwaySec(): number {
    if (!this.audioContext) return 0;
    const currentTimeSec = this.audioContext.currentTime;
    this.pruneExpiredScheduledSources(currentTimeSec);
    const scheduledAheadSec = this.getScheduledAheadSec(currentTimeSec);
    const queuedAheadSec = this.audioBufferQueue.reduce(
      (totalSec, chunk) => totalSec + chunk.buffer.duration,
      0,
    );
    return Math.max(0, scheduledAheadSec + queuedAheadSec);
  }

  private cancelScheduledRefill(): void {
    if (this.refillTimeout !== null) {
      clearTimeout(this.refillTimeout);
      this.refillTimeout = null;
    }
  }

  private getScheduledRefillThresholdSec(
    targetScheduledHorizonSec: number,
  ): number {
    return Math.max(
      SCHEDULE_REFILL_MIN_THRESHOLD_SEC,
      Math.min(
        SCHEDULE_REFILL_MAX_THRESHOLD_SEC,
        targetScheduledHorizonSec * SCHEDULE_REFILL_THRESHOLD_FRACTION,
      ),
    );
  }

  private scheduleQueueRefill(targetScheduledHorizonSec: number): void {
    this.cancelScheduledRefill();
    if (
      !this.audioContext ||
      this.audioContext.state !== "running" ||
      !this.stateManager.isPlaying ||
      this.audioBufferQueue.length === 0
    )
      return;
    const currentTimeSec = this.audioContext.currentTime;
    this.pruneExpiredScheduledSources(currentTimeSec);
    const scheduledAheadSec = this.getScheduledAheadSec(currentTimeSec);
    const refillThresholdSec = this.getScheduledRefillThresholdSec(
      targetScheduledHorizonSec,
    );
    if (scheduledAheadSec <= refillThresholdSec) {
      this.scheduleQueueProcessing();
      return;
    }
    const delayMs = (scheduledAheadSec - refillThresholdSec) * 1000;
    const runRefill = () => {
      this.refillTimeout = null;
      if (
        !this.audioContext ||
        this.audioContext.state !== "running" ||
        !this.stateManager.isPlaying ||
        this.audioBufferQueue.length === 0
      )
        return;
      this.scheduleQueueProcessing();
    };
    if (typeof globalThis.setTimeout === "function") {
      this.refillTimeout = globalThis.setTimeout(runRefill, delayMs);
      return;
    }
    this.refillTimeout = null;
    if (
      typeof (globalThis as unknown as { queueMicrotask?: unknown })
        .queueMicrotask === "function"
    ) {
      (
        globalThis as unknown as { queueMicrotask: (cb: () => void) => void }
      ).queueMicrotask(runRefill);
      return;
    }
    void Promise.resolve().then(runRefill);
  }

  private scheduleQueueProcessing(): void {
    this.cancelScheduledRefill();
    if (this.queueProcessScheduled) return;
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
    for (let ch = 0; ch < numChannels; ch++)
      audioBuffer.getChannelData(ch).set(chunk.samples[ch]);
    this.audioBufferQueue.push({
      buffer: audioBuffer,
      serverTime: chunk.serverTimeUs,
      generation: chunk.generation,
    });
    this.scheduleQueueProcessing();
  }

  processAudioQueue(): void {
    this.cancelScheduledRefill();
    if (!this.audioContext || !this.gainNode) return;
    if (this.audioContext.state !== "running") return;

    const currentGeneration = this.stateManager.streamGeneration;
    this.audioBufferQueue = this.audioBufferQueue.filter(
      (chunk) => chunk.generation === currentGeneration,
    );
    this.audioBufferQueue.sort((a, b) => a.serverTime - b.serverTime);
    if (!this.timeFilter.is_synchronized) return;

    const {
      audioContextTimeSec: audioContextTime,
      audioContextRawTimeSec,
      nowMs,
      nowUs,
    } = this.clockSource.getTimingSnapshot(this.audioContext);
    this.pruneExpiredScheduledSources(audioContextRawTimeSec);

    const outputLatencySec = this.useOutputLatencyCompensation
      ? this.latencyTracker.getSmoothedUs(this.audioContext) / 1_000_000
      : 0;
    const syncDelaySec = this.syncDelayMs / 1000;
    const targetScheduledHorizonSec = this.getTargetScheduledHorizonSec();

    if (this.usesRecorrectionMonitor) this.recorrectionMonitor.start();

    if (this.clockSource.pendingCutover) {
      this.clockSource.pendingCutover = false;
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
      )
        break;

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
      const isTimestamp = this.clockSource.active === "timestamp";

      if (this.nextPlaybackTime === 0 || this.lastScheduledServerTime === 0) {
        this.recorrectionMonitor.armStartupGrace(nowMs, isTimestamp);
        playbackTime = targetPlaybackTime;
        scheduleTime = playbackTime - syncDelaySec;
        if (this.recorrectionMonitor.minScheduleTimeSec !== null) {
          scheduleTime = Math.max(
            scheduleTime,
            this.recorrectionMonitor.minScheduleTimeSec,
          );
          playbackTime = scheduleTime + syncDelaySec;
        }
        this.recorrectionMonitor.minScheduleTimeSec = null;
        playbackRate = 1.0;
        chunk.buffer = this.copyBuffer(chunk.buffer);
      } else {
        const serverGapUs = chunk.serverTime - this.lastScheduledServerTime;
        const serverGapSec = serverGapUs / 1_000_000;

        if (Math.abs(serverGapSec) < 0.1) {
          const syncErrorSec = this.nextPlaybackTime - targetPlaybackTime;
          const syncErrorMs = syncErrorSec * 1000;
          const correctionErrorMs = this.applySyncErrorEma(syncErrorMs);
          const thresholds = this.correctionThresholds[this._correctionMode];
          const canHardResync = this.recorrectionMonitor.canUseHardResync(
            nowMs,
            isTimestamp,
          );

          if (
            Math.abs(correctionErrorMs) > thresholds.resyncAboveMs &&
            canHardResync
          ) {
            this.recorrectionMonitor.noteHardResync(nowMs);
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
          // Gap detected in server timestamps - hard resync (gated on cooldown)
          if (this.recorrectionMonitor.canUseHardResync(nowMs, isTimestamp)) {
            this.recorrectionMonitor.noteHardResync(nowMs);
            this.resyncCount++;
            this._intervalResyncCount++;
            this.cutScheduledSources(targetPlaybackTime - syncDelaySec);
          }
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
          if (this.audioBufferQueue.length > 0) this.processAudioQueue();
        }
      };
    }
    this.scheduleQueueRefill(targetScheduledHorizonSec);
    this.emitStatusLog(nowMs);
  }

  private computeTargetPlaybackTime(
    serverTimeUs: number,
    audioContextTime: number,
    nowUs: number,
    outputLatencySec: number,
  ): number {
    const chunkClientTimeUs = this.timeFilter.computeClientTime(serverTimeUs);
    const deltaSec = (chunkClientTimeUs - nowUs) / 1_000_000;
    return (
      audioContextTime + deltaSec + SCHEDULE_HEADROOM_SEC - outputLatencySec
    );
  }

  startAudioElement(): void {
    if (this.outputMode === "media-element" && this.audioElement?.paused) {
      this.audioElement.play().catch((e) => {
        console.warn("Sendspin: Failed to start audio element:", e);
      });
    }
  }

  stopAudioElement(): void {
    if (
      this.outputMode === "media-element" &&
      this.audioElement &&
      !this.audioElement.paused
    ) {
      this.audioElement.pause();
    }
  }

  clearBuffers(): void {
    this.recorrectionMonitor.stop();
    this.cancelScheduledRefill();
    this.scheduledSources.forEach((entry) => {
      try {
        entry.source.stop();
      } catch {
        /* ignore */
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
    this.latencyTracker.reset();
    this.clockSource.reset();
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
