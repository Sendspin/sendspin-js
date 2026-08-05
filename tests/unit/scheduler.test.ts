/**
 * Unit tests for AudioScheduler clock-synced playback scheduling.
 *
 * Web Audio does not exist in node, so we install a minimal deterministic fake
 * AudioContext/AudioBuffer/source/gain. The fake's currentTime is a settable
 * number, getOutputTimestamp is omitted (so the clock stays on "estimated"),
 * and createBufferSource records start()/stop() calls. The time filter is a
 * controllable stub: computeClientTime is identity-with-offset so server
 * microseconds map predictably to client microseconds.
 *
 * Scheduling math reference (scheduler.ts computeTargetPlaybackTime):
 *   targetPlaybackTime = ctxTime + (clientTime(serverUs) - nowUs)/1e6
 *                        - outputLatencySec
 * We disable output-latency compensation in most tests to keep math clean.
 *
 * These tests assert scheduled `source.start()` times; render-offset.test.ts
 * covers the audible instant those add up to.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AudioScheduler, SYNC_ERROR_ALPHA } from "../../src/audio/scheduler";
import { StateManager } from "../../src/core/state-manager";
import type { DecodedAudioChunk, StreamFormat } from "../../src/types";

const SAMPLE_RATE = 48000;

// ---------------------------------------------------------------------------
// Fake Web Audio
// ---------------------------------------------------------------------------

class FakeAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  duration: number;
  private channels: Float32Array[];
  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = [];
    for (let c = 0; c < numberOfChannels; c++)
      this.channels.push(new Float32Array(length));
  }
  getChannelData(ch: number): Float32Array {
    return this.channels[ch];
  }
}

class FakeBufferSource {
  buffer: FakeAudioBuffer | null = null;
  playbackRate = { value: 1.0 };
  onended: (() => void) | null = null;
  started: number | null = null;
  stopped: number | null = null;
  connected = false;
  ctx: FakeAudioContext;
  constructor(ctx: FakeAudioContext) {
    this.ctx = ctx;
  }
  connect() {
    this.connected = true;
  }
  start(when: number) {
    this.started = when;
    this.ctx.startedSources.push(this);
  }
  stop(when?: number) {
    this.stopped = when ?? this.ctx.currentTime;
  }
}

class FakeGainNode {
  gain = {
    value: 1.0,
    setTargetAtTime(target: number, _startTime: number, _timeConstant: number) {
      this.value = target;
    },
  };
  connect() {}
}

class FakeAudioContext {
  currentTime = 1000; // start well past zero so playbackTime>=raw is easy
  state: "running" | "suspended" | "closed" = "running";
  sampleRate: number;
  baseLatency = 0;
  outputLatency = 0;
  destination = {};
  startedSources: FakeBufferSource[] = [];
  resumeCalls = 0;
  resumeError: Error | null = null;
  // deliberately NO getOutputTimestamp -> clock stays "estimated"
  constructor(opts?: { sampleRate?: number }) {
    this.sampleRate = opts?.sampleRate ?? 48000;
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }
  createGain() {
    return new FakeGainNode();
  }
  createBufferSource() {
    return new FakeBufferSource(this);
  }
  createMediaStreamDestination() {
    return { stream: {} };
  }
  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.resumeError) return Promise.reject(this.resumeError);
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

let lastCtx: FakeAudioContext | null = null;
let audioContextCreateCount = 0;

// ---------------------------------------------------------------------------
// Controllable time-filter stub
// ---------------------------------------------------------------------------

class FakeTimeFilter {
  synchronized = true;
  errorUs = 1000; // 1ms -> precise horizon
  driftRatio = 0;
  measurements = 5;
  // client = server + clientOffsetUs
  clientOffsetUs = 0;

  get is_synchronized() {
    return this.synchronized;
  }
  get error() {
    return this.errorUs;
  }
  get drift() {
    return this.driftRatio;
  }
  get count() {
    return this.measurements;
  }
  computeClientTime(serverUs: number): number {
    return serverUs + this.clientOffsetUs;
  }
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const PCM_FORMAT: StreamFormat = {
  codec: "pcm",
  sample_rate: SAMPLE_RATE,
  channels: 2,
  bit_depth: 16,
};

function makeChunk(
  serverTimeUs: number,
  generation: number,
  frames = SAMPLE_RATE / 10, // 100ms chunk
): DecodedAudioChunk {
  return {
    samples: [new Float32Array(frames), new Float32Array(frames)],
    sampleRate: SAMPLE_RATE,
    serverTimeUs,
    generation,
  };
}

interface SchedulerHarness {
  scheduler: AudioScheduler;
  state: StateManager;
  tf: FakeTimeFilter;
}

interface Harness extends SchedulerHarness {
  ctx: FakeAudioContext;
}

function createScheduler(
  opts: Partial<ConstructorParameters<typeof AudioScheduler>[0]> = {},
): SchedulerHarness {
  const state = new StateManager();
  const tf = new FakeTimeFilter();
  const scheduler = new AudioScheduler({
    stateManager: state,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    timeFilter: tf as any,
    useOutputLatencyCompensation: false,
    syncDelayMs: 0,
    correctionMode: "sync",
    ...opts,
  });
  // currentStreamFormat drives ctx sample rate
  state.currentStreamFormat = PCM_FORMAT;
  return { scheduler, state, tf };
}

function setup(
  opts: Partial<ConstructorParameters<typeof AudioScheduler>[0]> = {},
): Harness {
  const { scheduler, state, tf } = createScheduler(opts);
  scheduler.initAudioContext();
  const ctx = lastCtx!;
  // running state so playback proceeds
  state.isPlaying = true;
  // align "now" wall clock; computeTargetPlaybackTime uses (clientTime - nowUs)
  return { scheduler, state, tf, ctx };
}

let nowMsValue = 0;

beforeEach(() => {
  nowMsValue = 5_000_000; // 5000s in ms -> matches serverTime base below
  lastCtx = null;
  audioContextCreateCount = 0;
  // global Web Audio + browser stubs
  vi.stubGlobal("AudioContext", function (opts?: { sampleRate?: number }) {
    const ctx = new FakeAudioContext(opts);
    audioContextCreateCount++;
    lastCtx = ctx;
    return ctx;
  });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("document", {
    createElement: () => ({ style: {}, play: () => Promise.resolve() }),
    body: { appendChild: () => {} },
  });
  if (typeof globalThis.performance === "undefined") {
    vi.stubGlobal("performance", { now: () => nowMsValue });
  } else {
    vi.spyOn(performance, "now").mockImplementation(() => nowMsValue);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Server time base chosen so that clientTime(serverUs) == nowUs at chunk start
// gives a target ~= ctx.currentTime + HEADROOM. nowUs = nowMsValue * 1000.
function nowUs(): number {
  return nowMsValue * 1000;
}

describe("AudioScheduler AudioContext lifecycle", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("does not resume a newly initialized context that is already running", async () => {
    const { scheduler } = createScheduler();

    expect(lastCtx).toBeNull();
    scheduler.initAudioContext();

    const ctx = lastCtx!;
    expect(audioContextCreateCount).toBe(1);
    expect(ctx.sampleRate).toBe(SAMPLE_RATE);
    expect(scheduler.getAudioContext()).toBe(ctx);

    await scheduler.resumeAudioContext();
    expect(ctx.resumeCalls).toBe(0);
  });

  it("resumes a suspended context", async () => {
    const h = setup();
    h.ctx.state = "suspended";

    await expect(h.scheduler.resumeAudioContext()).resolves.toBeUndefined();

    expect(h.ctx.resumeCalls).toBe(1);
    expect(h.ctx.state).toBe("running");
  });

  it("leaves an already-running context untouched", async () => {
    const h = setup();

    await expect(h.scheduler.resumeAudioContext()).resolves.toBeUndefined();

    expect(h.ctx.resumeCalls).toBe(0);
    expect(h.ctx.state).toBe("running");
  });

  it("keeps repeated initialization and resume calls idempotent", async () => {
    const { scheduler } = createScheduler();
    scheduler.initAudioContext();
    const ctx = lastCtx!;
    ctx.state = "suspended";

    scheduler.initAudioContext();
    await scheduler.resumeAudioContext();
    await scheduler.resumeAudioContext();

    expect(audioContextCreateCount).toBe(1);
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.state).toBe("running");
  });

  it("creates a new context after close", () => {
    const { scheduler } = createScheduler();
    scheduler.initAudioContext();
    const firstCtx = lastCtx;

    scheduler.close();
    scheduler.initAudioContext();

    expect(audioContextCreateCount).toBe(2);
    expect(lastCtx).not.toBe(firstCtx);
  });

  it("propagates resume failures and allows retrying", async () => {
    const h = setup();
    const resumeError = new Error("resume blocked");
    h.ctx.state = "suspended";
    h.ctx.resumeError = resumeError;

    await expect(h.scheduler.resumeAudioContext()).rejects.toBe(resumeError);
    expect(h.ctx.resumeCalls).toBe(1);
    expect(h.ctx.state).toBe("suspended");

    h.ctx.resumeError = null;
    await expect(h.scheduler.resumeAudioContext()).resolves.toBeUndefined();
    expect(h.ctx.resumeCalls).toBe(2);
    expect(h.ctx.state).toBe("running");
  });
});

describe("AudioScheduler scheduling math", () => {
  it("first chunk schedules at ctxTime when chunk client time == now", () => {
    const { scheduler, ctx, tf } = setup();
    // serverTime maps to clientTime == nowUs -> delta 0
    const serverTime = nowUs();
    tf.clientOffsetUs = 0;
    scheduler.handleDecodedChunk(makeChunk(serverTime, 0));
    scheduler.processAudioQueue();

    expect(ctx.startedSources.length).toBe(1);
    const src = ctx.startedSources[0];
    // The target is the mapped client instant itself.
    expect(src.started!).toBeCloseTo(ctx.currentTime, 6);
    expect(src.playbackRate.value).toBe(1.0);
  });

  it("subtracts syncDelayMs from the schedule time of the first chunk", () => {
    const syncDelayMs = 50;
    const { scheduler, ctx } = setup({ syncDelayMs });
    // 1s of lead so the earlier start is not clamped up to "now"
    scheduler.handleDecodedChunk(makeChunk(nowUs() + 1_000_000, 0));
    scheduler.processAudioQueue();

    const src = ctx.startedSources[0];
    // playbackTime = ctxTime + 1 ; scheduleTime = playbackTime - 0.05
    expect(src.started!).toBeCloseTo(
      ctx.currentTime + 1 - syncDelayMs / 1000,
      6,
    );
  });

  it("future-timestamped chunk schedules later by the client-time delta", () => {
    const { scheduler, ctx } = setup();
    // 2 seconds in the future (server clock)
    const serverTime = nowUs() + 2_000_000;
    scheduler.handleDecodedChunk(makeChunk(serverTime, 0));
    scheduler.processAudioQueue();

    const src = ctx.startedSources[0];
    expect(src.started!).toBeCloseTo(ctx.currentTime + 2, 6);
  });
});

describe("AudioScheduler late-chunk dropping", () => {
  it("drops a chunk whose playback time is in the past (spec: drop late chunks)", () => {
    const { scheduler, ctx } = setup();
    // playbackTime ~ ctxTime + headroom + delta. Make delta hugely negative.
    const serverTime = nowUs() - 10_000_000; // 10s in the past
    scheduler.handleDecodedChunk(makeChunk(serverTime, 0));
    scheduler.processAudioQueue();

    // playbackTime < raw ctx time => skipped, no source started
    expect(ctx.startedSources.length).toBe(0);
  });
});

describe("AudioScheduler clock-not-synced gating", () => {
  it("schedules once the filter becomes synchronized", () => {
    const { scheduler, ctx, tf } = setup();
    tf.synchronized = false;
    scheduler.handleDecodedChunk(makeChunk(nowUs(), 0));
    scheduler.processAudioQueue();
    expect(ctx.startedSources.length).toBe(0);

    tf.synchronized = true;
    scheduler.processAudioQueue();
    expect(ctx.startedSources.length).toBe(1);
  });
});

describe("AudioScheduler generation / seek handling", () => {
  it("drops decoded chunks from a stale generation", () => {
    const { scheduler, state, ctx } = setup();
    const stale = state.streamGeneration; // 0
    state.resetStreamAnchors(); // generation -> 1
    scheduler.handleDecodedChunk(makeChunk(nowUs(), stale));
    scheduler.processAudioQueue();
    expect(ctx.startedSources.length).toBe(0);
  });

  it("processAudioQueue filters out queued chunks from a previous generation", () => {
    const { scheduler, state, ctx } = setup();
    // enqueue current-gen chunk, then bump generation before processing
    scheduler.handleDecodedChunk(makeChunk(nowUs(), state.streamGeneration));
    state.resetStreamAnchors();
    scheduler.processAudioQueue();
    expect(ctx.startedSources.length).toBe(0);
  });

  it("clearBuffers stops scheduled sources and empties the queue", () => {
    const { scheduler, ctx } = setup();
    scheduler.handleDecodedChunk(makeChunk(nowUs(), 0));
    scheduler.processAudioQueue();
    const src = ctx.startedSources[0];
    expect(src.stopped).toBeNull();
    scheduler.clearBuffers();
    expect(src.stopped).not.toBeNull();
    expect(scheduler.measureBufferedPlaybackRunwaySec()).toBe(0);
  });
});

describe("AudioScheduler consecutive-chunk continuity", () => {
  it("schedules consecutive in-sync chunks back-to-back (no gap)", () => {
    const { scheduler, ctx } = setup();
    const chunkUs = 100_000; // 100ms
    const base = nowUs();
    scheduler.handleDecodedChunk(makeChunk(base, 0));
    scheduler.handleDecodedChunk(makeChunk(base + chunkUs, 0));
    scheduler.processAudioQueue();

    expect(ctx.startedSources.length).toBe(2);
    const [a, b] = ctx.startedSources;
    // Second chunk starts exactly when the first ends (rate 1.0).
    expect(b.started!).toBeCloseTo(a.started! + a.buffer!.duration, 6);
    // Both at nominal rate when perfectly in sync.
    expect(a.playbackRate.value).toBe(1.0);
    expect(b.playbackRate.value).toBe(1.0);
  });
});

describe("AudioScheduler drift correction (sync mode)", () => {
  // The correction branch keys off the EMA-smoothed error, seeded from 0 after
  // the first chunk. So a single correction chunk with raw error R produces
  // smoothedError = SYNC_ERROR_ALPHA * R. offsetForSmoothedMs sizes the raw
  // offset to land a target smoothed error in the desired band, independent of
  // the alpha value. The first chunk establishes nextPlaybackTime at offset 0.
  // The offset is then applied for one contiguous second chunk (gap 100ms <
  // 0.1s threshold, so the in-sync correction branch runs, not the gap branch).

  // Raw clientOffset (µs) that yields the given smoothed error (ms) after one chunk.
  function offsetForSmoothedMs(ms: number): number {
    return Math.round((ms / SYNC_ERROR_ALPHA) * 1000);
  }

  function primeFirstChunk(h: Harness, base: number) {
    h.scheduler.handleDecodedChunk(makeChunk(base, 0));
    h.scheduler.processAudioQueue();
  }

  function correctOnce(h: Harness, base: number, offsetUs: number) {
    h.tf.clientOffsetUs = offsetUs;
    h.scheduler.handleDecodedChunk(makeChunk(base + 100_000, 0));
    h.scheduler.processAudioQueue();
  }

  it("applies no correction (rate 1.0) when smoothed error is below the deadband", () => {
    const h = setup();
    const base = nowUs();
    primeFirstChunk(h, base);
    correctOnce(h, base, 0); // raw 0 -> smoothed 0 -> deadband
    const last = h.ctx.startedSources.at(-1)!;
    expect(last.playbackRate.value).toBe(1.0);
    expect(h.scheduler.syncInfo.correctionMethod).toBe("none");
  });

  it("uses sample insertion/deletion for small smoothed errors (samples band)", () => {
    const h = setup();
    const base = nowUs();
    primeFirstChunk(h, base);
    // smoothed 2ms, in (deadband 1, samplesBelow 8).
    correctOnce(h, base, offsetForSmoothedMs(2));
    expect(h.scheduler.syncInfo.correctionMethod).toBe("samples");
    expect([1, -1]).toContain(h.scheduler.syncInfo.samplesAdjusted);
  });

  it("uses playback-rate adjustment for medium smoothed errors in sync mode", () => {
    const h = setup();
    const base = nowUs();
    primeFirstChunk(h, base);
    // smoothed 30ms, in (samplesBelow 8, resyncAbove 200).
    correctOnce(h, base, offsetForSmoothedMs(30));
    expect(h.scheduler.syncInfo.correctionMethod).toBe("rate");
    expect([0.995, 0.997, 1.003, 1.005]).toContain(
      h.scheduler.syncInfo.playbackRate,
    );
  });

  it("keeps the firm rate tier within the ±0.5% spec cap for large sub-resync errors", () => {
    const h = setup();
    const base = nowUs();
    primeFirstChunk(h, base);
    // smoothed 50ms, above rate2AboveMs (35) and below resync (200).
    correctOnce(h, base, offsetForSmoothedMs(50));
    expect(h.scheduler.syncInfo.correctionMethod).toBe("rate");
    expect(Math.abs(h.scheduler.syncInfo.playbackRate - 1)).toBeLessThanOrEqual(
      0.005 + 1e-9,
    );
  });

  it("hard-resyncs when smoothed error exceeds resyncAboveMs (after startup grace)", () => {
    const h = setup();
    const base = nowUs();
    primeFirstChunk(h, base);
    const resyncsBefore = h.scheduler.syncInfo.resyncCount;
    // Hard resync is suppressed during the ~1s startup grace on the estimated
    // clock, so advance the wall clock past it before driving the error. Keep
    // server timestamps contiguous (gap 100ms) so the in-sync resync branch
    // runs, not the gap branch.
    nowMsValue += 2000;
    // Drive smoothed error to 250ms (> resyncAbove 200). nowUs advanced 2s, so
    // add 2s to the offset to keep the raw error at the intended magnitude.
    h.tf.clientOffsetUs = 2_000_000 + offsetForSmoothedMs(250);
    h.scheduler.handleDecodedChunk(makeChunk(base + 100_000, 0));
    h.scheduler.processAudioQueue();
    expect(h.scheduler.syncInfo.correctionMethod).toBe("resync");
    expect(h.scheduler.syncInfo.resyncCount).toBeGreaterThan(resyncsBefore);
  });
});

describe("AudioScheduler server-timestamp gap handling", () => {
  it("hard-resyncs on a large gap between consecutive server timestamps", () => {
    const h = setup();
    const base = nowUs();
    h.scheduler.handleDecodedChunk(makeChunk(base, 0));
    h.scheduler.processAudioQueue();
    // Next chunk's server time jumps far beyond the previous chunk end
    // (>0.1s gap from lastScheduledServerTime) -> gap branch resync.
    h.scheduler.handleDecodedChunk(makeChunk(base + 5_000_000, 0));
    h.scheduler.processAudioQueue();
    expect(h.scheduler.syncInfo.correctionMethod).toBe("resync");
  });
});

describe("AudioScheduler cutover backlog handling", () => {
  it("drops late backlog on a cutover instead of clamping it forward", () => {
    const h = setup();
    const base = nowUs();
    // Schedule 5 contiguous 100ms chunks so several sources are pending.
    for (let i = 0; i < 5; i++) {
      h.scheduler.handleDecodedChunk(makeChunk(base + i * 100_000, 0));
    }
    h.scheduler.processAudioQueue();
    expect(h.ctx.startedSources.length).toBeGreaterThanOrEqual(2);

    // A filter correction shifts the mapping so all buffered audio is now ~2s late.
    h.tf.clientOffsetUs = -2_000_000;
    const startedBeforeCutover = h.ctx.startedSources.length;

    // A runtime sync-delay change triggers a guarded cutover (sync mode).
    h.scheduler.setSyncDelay(10);

    // The late backlog is dropped, not re-scheduled at clamped-forward times.
    expect(h.ctx.startedSources.length - startedBeforeCutover).toBe(0);
  });
});

describe("AudioScheduler cut requeue ordering", () => {
  it("restores serverTime order when a cut requeues behind a queued chunk", () => {
    const h = setup();
    const base = nowUs();
    // Two chunks scheduled, then a later one left queued.
    h.scheduler.handleDecodedChunk(makeChunk(base, 0));
    h.scheduler.handleDecodedChunk(makeChunk(base + 100_000, 0));
    h.scheduler.processAudioQueue();
    expect(h.ctx.startedSources.length).toBe(2);
    h.tf.synchronized = false;
    h.scheduler.handleDecodedChunk(makeChunk(base + 200_000, 0));

    // A cut mirrors the one processAudioQueue makes mid-drain, after its sort.
    (h.scheduler as any).cutScheduledSources(h.ctx.currentTime);

    const queued = (h.scheduler as any).audioBufferQueue as Array<{
      serverTime: number;
    }>;
    expect(queued.map((c) => c.serverTime)).toEqual([
      base,
      base + 100_000,
      base + 200_000,
    ]);
  });
});

describe("AudioScheduler quality mode thresholds", () => {
  it("never uses playback-rate changes in quality mode", () => {
    const h = setup({ correctionMode: "quality" });
    const base = nowUs();
    h.scheduler.handleDecodedChunk(makeChunk(base, 0));
    h.scheduler.processAudioQueue();
    // 20ms error: in sync mode this is a rate change; in quality, rate2/rate1
    // are Infinity and samplesBelowMs is 35 -> should be samples, not rate.
    h.tf.clientOffsetUs = 20_000;
    h.scheduler.handleDecodedChunk(makeChunk(base + 100_000, 0));
    h.scheduler.processAudioQueue();
    expect(h.scheduler.syncInfo.playbackRate).toBe(1.0);
    expect(h.scheduler.syncInfo.correctionMethod).not.toBe("rate");
  });
});

describe("AudioScheduler horizon / buffering", () => {
  it("stops scheduling once the target horizon is filled", () => {
    const h = setup();
    // precise clock -> 20s horizon. Enqueue 250 x 100ms = 25s of audio.
    const base = nowUs();
    for (let i = 0; i < 250; i++) {
      h.scheduler.handleDecodedChunk(makeChunk(base + i * 100_000, 0));
    }
    h.scheduler.processAudioQueue();
    const scheduledDurationSec = h.ctx.startedSources.reduce(
      (s, src) => s + src.buffer!.duration,
      0,
    );
    // Should not have scheduled the full 25s; capped near the 20s horizon.
    // The loop breaks before adding the chunk that crosses the horizon, so the
    // scheduled total lands just under 20s (one 100ms chunk short).
    expect(scheduledDurationSec).toBeLessThan(25);
    expect(scheduledDurationSec).toBeGreaterThanOrEqual(19.5);
  });

  it("measureBufferedPlaybackRunwaySec counts queued (unscheduled) audio", () => {
    const h = setup();
    h.tf.synchronized = false; // keep everything queued, nothing scheduled
    const base = nowUs();
    for (let i = 0; i < 5; i++)
      h.scheduler.handleDecodedChunk(makeChunk(base + i * 100_000, 0));
    h.scheduler.processAudioQueue();
    // 5 x 100ms = 0.5s queued
    expect(h.scheduler.measureBufferedPlaybackRunwaySec()).toBeCloseTo(0.5, 6);
  });
});

describe("AudioScheduler empty / no-context edge cases", () => {
  it("processAudioQueue is a no-op with an empty queue", () => {
    const h = setup();
    expect(() => h.scheduler.processAudioQueue()).not.toThrow();
    expect(h.ctx.startedSources.length).toBe(0);
  });

  it("handleDecodedChunk before initAudioContext does not throw and drops the chunk", () => {
    const state = new StateManager();
    const tf = new FakeTimeFilter();
    const scheduler = new AudioScheduler({
      stateManager: state,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      timeFilter: tf as any,
      useOutputLatencyCompensation: false,
    });
    state.isPlaying = true;
    expect(() =>
      scheduler.handleDecodedChunk(makeChunk(nowUs(), 0)),
    ).not.toThrow();
    expect(scheduler.measureBufferedPlaybackRunwaySec()).toBe(0);
  });

  it("does not schedule while the AudioContext is suspended", () => {
    const h = setup();
    h.ctx.state = "suspended";
    h.scheduler.handleDecodedChunk(makeChunk(nowUs(), 0));
    h.scheduler.processAudioQueue();
    expect(h.ctx.startedSources.length).toBe(0);
  });
});

describe("AudioScheduler volume", () => {
  it("applies the perceptual (volume/100)^1.5 curve to gain", () => {
    const h = setup();
    const gain = (h.scheduler as any).gainNode;

    h.state.volume = 50;
    h.scheduler.updateVolume();
    expect(gain.gain.value).toBeCloseTo(Math.pow(0.5, 1.5), 6);

    h.state.volume = 100;
    h.scheduler.updateVolume();
    expect(gain.gain.value).toBeCloseTo(1.0, 6);

    h.state.volume = 0;
    h.scheduler.updateVolume();
    expect(gain.gain.value).toBeCloseTo(0, 6);
  });

  it("maps muted to gain 0 regardless of volume", () => {
    const h = setup();
    h.state.volume = 80;
    h.state.muted = true;
    h.scheduler.updateVolume();
    const gain = (h.scheduler as any).gainNode;
    expect(gain.gain.value).toBe(0);
  });

  it("keeps gain at 1.0 when hardware volume is used", () => {
    const h = setup({ useHardwareVolume: true });
    h.state.volume = 30;
    h.scheduler.updateVolume();
    const gain = (h.scheduler as any).gainNode;
    expect(gain.gain.value).toBe(1.0);
  });
});

describe("AudioScheduler syncDelay clamping", () => {
  it("clamps sync delay to the 5000ms maximum", () => {
    const h = setup({ syncDelayMs: 99999 });
    expect(h.scheduler.getSyncDelayMs()).toBe(5000);
  });
});
