/**
 * Rendering-offset tests for AudioScheduler.
 *
 * The Sendspin spec defines an audio chunk timestamp as "server clock time in
 * microseconds when the first sample should be output", i.e. when it leaves the
 * device's audio port. These tests assert that end of the contract: a chunk
 * stamped for server instant T must be *audible* at the client instant T maps
 * to, with no constant offset.
 *
 * Unlike scheduler.test.ts (which asserts scheduled `source.start()` values),
 * the fake AudioContext here models the real Chrome clock relationship so the
 * audible instant can be derived from the scheduled one. Measured in Chromium
 * on macOS at 48kHz with an active source (see PLAYOUT_LATENCY_SEC below):
 *
 *   currentTime - (getOutputTimestamp().contextTime + freshness) = 20.9ms
 *   baseLatency + outputLatency                                  = 21.3ms
 *
 * So `currentTime` is the render clock (leading edge, where source.start()
 * places audio) and `contextTime` is the playout clock (trailing edge, what is
 * leaving the port now), the two separated by baseLatency + outputLatency.
 * Audio started at render-clock time S is therefore audible one latency later:
 *
 *   audible_wall(S) = wall(S) + baseLatency + outputLatency
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AudioScheduler } from "../../src/audio/scheduler";
import { StateManager } from "../../src/core/state-manager";
import { SendspinTimeFilter } from "../../src/core/time-filter";
import type { DecodedAudioChunk, StreamFormat } from "../../src/types";

const SAMPLE_RATE = 48000;

// Chrome/macOS measured values (see file header).
const BASE_LATENCY_SEC = 0.005333333333333333;
const OUTPUT_LATENCY_SEC = 0.016;
const PLAYOUT_LATENCY_SEC = BASE_LATENCY_SEC + OUTPUT_LATENCY_SEC;

// Virtual wall clock (performance.now() domain) and the AudioContext time that
// corresponds to it. Both advance 1:1.
const WALL_EPOCH_MS = 5_000_000;
const CTX_EPOCH_SEC = 1000;

// Server clock runs ahead of the client clock by this much.
const SERVER_OFFSET_US = 12_345_678;

// Chunks are stamped this far in the future, as a real server does (the client
// asks for lead time via required_lead_time_ms).
const CHUNK_LEAD_SEC = 0.5;

let nowMs = WALL_EPOCH_MS;

function rawCurrentTime(): number {
  return CTX_EPOCH_SEC + (nowMs - WALL_EPOCH_MS) / 1000;
}

/** Wall-clock instant (ms) at which audio started at render time `startSec` is audible. */
function audibleWallMs(startSec: number): number {
  return (
    WALL_EPOCH_MS +
    (startSec - CTX_EPOCH_SEC) * 1000 +
    PLAYOUT_LATENCY_SEC * 1000
  );
}

class FakeAudioBuffer {
  duration: number;
  private channels: Float32Array[];
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number,
  ) {
    this.duration = length / sampleRate;
    this.channels = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(length),
    );
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
  constructor(private ctx: ChromeLikeAudioContext) {}
  connect() {}
  start(when: number) {
    this.started = when;
    this.ctx.startedSources.push(this);
  }
  stop() {}
}

class FakeGainNode {
  gain = {
    value: 1.0,
    setTargetAtTime(target: number) {
      this.value = target;
    },
  };
  connect() {}
}

class ChromeLikeAudioContext {
  state: "running" | "suspended" | "closed" = "running";
  sampleRate: number;
  baseLatency = BASE_LATENCY_SEC;
  outputLatency = OUTPUT_LATENCY_SEC;
  destination = {};
  startedSources: FakeBufferSource[] = [];
  /** getOutputTimestamp() is only exposed once enabled, mirroring browser support. */
  outputTimestampEnabled = false;

  constructor(opts?: { sampleRate?: number }) {
    this.sampleRate = opts?.sampleRate ?? SAMPLE_RATE;
  }
  get currentTime(): number {
    return rawCurrentTime();
  }
  getOutputTimestamp():
    | { contextTime: number; performanceTime: number }
    | undefined {
    if (!this.outputTimestampEnabled) return undefined;
    // Playout clock: what is leaving the port right now.
    return {
      contextTime: rawCurrentTime() - PLAYOUT_LATENCY_SEC,
      performanceTime: nowMs,
    };
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
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

const PCM_FORMAT: StreamFormat = {
  codec: "pcm",
  sample_rate: SAMPLE_RATE,
  channels: 2,
  bit_depth: 16,
};

let lastCtx: ChromeLikeAudioContext | null = null;

interface Harness {
  scheduler: AudioScheduler;
  ctx: ChromeLikeAudioContext;
  timeFilter: SendspinTimeFilter;
}

function setup(
  opts: {
    syncDelayMs?: number;
    useOutputLatencyCompensation?: boolean;
    outputTimestamp?: boolean;
  } = {},
): Harness {
  const stateManager = new StateManager();
  const timeFilter = new SendspinTimeFilter();
  // A single measurement is enough to synchronize the filter; with one sample it
  // reports zero drift, so clientTime(serverUs) === serverUs - SERVER_OFFSET_US.
  timeFilter.update(SERVER_OFFSET_US, 1000, nowMs * 1000);
  expect(timeFilter.is_synchronized).toBe(true);

  const scheduler = new AudioScheduler({
    stateManager,
    timeFilter,
    syncDelayMs: opts.syncDelayMs ?? 0,
    useOutputLatencyCompensation: opts.useOutputLatencyCompensation ?? true,
    correctionMode: "sync",
  });
  stateManager.currentStreamFormat = PCM_FORMAT;
  scheduler.initAudioContext();
  const ctx = lastCtx!;
  ctx.outputTimestampEnabled = opts.outputTimestamp ?? false;
  stateManager.isPlaying = true;
  return { scheduler, ctx, timeFilter };
}

function makeChunk(serverTimeUs: number, frames = SAMPLE_RATE / 10) {
  return {
    samples: [new Float32Array(frames), new Float32Array(frames)],
    sampleRate: SAMPLE_RATE,
    serverTimeUs,
    generation: 0,
  } satisfies DecodedAudioChunk;
}

/**
 * Drive enough timing snapshots for ClockSource to promote to the
 * getOutputTimestamp-derived clock (6 good samples spanning >=750ms).
 */
function promoteToTimestampClock(scheduler: AudioScheduler): void {
  for (let i = 0; i < 7; i++) {
    nowMs += 150;
    scheduler.processAudioQueue();
  }
}

/**
 * Schedule one chunk stamped `CHUNK_LEAD_SEC` in the future and return how far
 * its audible instant lands from the instant the server asked for, in ms.
 * Positive means the client renders late.
 */
function measureRenderOffsetMs(h: Harness): number {
  const serverTimeUs = Math.round(
    (nowMs + CHUNK_LEAD_SEC * 1000) * 1000 + SERVER_OFFSET_US,
  );
  h.scheduler.handleDecodedChunk(makeChunk(serverTimeUs));
  h.scheduler.processAudioQueue();

  expect(h.ctx.startedSources.length).toBe(1);
  const startedAt = h.ctx.startedSources[0].started!;
  const intendedWallMs = h.timeFilter.computeClientTime(serverTimeUs) / 1000;
  return audibleWallMs(startedAt) - intendedWallMs;
}

beforeEach(() => {
  nowMs = WALL_EPOCH_MS;
  lastCtx = null;
  vi.stubGlobal("AudioContext", function (opts?: { sampleRate?: number }) {
    lastCtx = new ChromeLikeAudioContext(opts);
    return lastCtx;
  });
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("document", {
    createElement: () => ({ style: {}, play: () => Promise.resolve() }),
    body: { appendChild: () => {} },
  });
  if (typeof globalThis.performance === "undefined") {
    vi.stubGlobal("performance", { now: () => nowMs });
  } else {
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AudioScheduler rendering offset", () => {
  it("renders a chunk audible at its server timestamp (estimated clock)", () => {
    const h = setup();
    const offsetMs = measureRenderOffsetMs(h);
    console.info(`estimated clock: render offset ${offsetMs.toFixed(1)}ms`);
    expect(offsetMs).toBeCloseTo(0, 3);
  });

  it("renders a chunk audible at its server timestamp (output-timestamp clock)", () => {
    const h = setup({ outputTimestamp: true });
    promoteToTimestampClock(h.scheduler);
    const offsetMs = measureRenderOffsetMs(h);
    console.info(`timestamp clock: render offset ${offsetMs.toFixed(1)}ms`);
    expect(offsetMs).toBeCloseTo(0, 3);
  });

  it("keeps the render offset identical across a clock-source promotion", () => {
    const estimated = setup();
    const estimatedOffsetMs = measureRenderOffsetMs(estimated);

    const promoted = setup({ outputTimestamp: true });
    promoteToTimestampClock(promoted.scheduler);
    const promotedOffsetMs = measureRenderOffsetMs(promoted);

    // A step here would be audible as a jump when the clock source promotes
    // mid-playback.
    expect(promotedOffsetMs - estimatedOffsetMs).toBeCloseTo(0, 3);
  });

  it("renders exactly staticDelay earlier when a static delay is set", () => {
    const syncDelayMs = 120;
    const h = setup({ syncDelayMs });
    // Positive static delay means "play earlier to compensate for downstream
    // latency", so the port instant moves ahead of the server timestamp.
    expect(measureRenderOffsetMs(h)).toBeCloseTo(-syncDelayMs, 3);
  });

  it("renders one output latency late when latency compensation is disabled", () => {
    const expectedMs = PLAYOUT_LATENCY_SEC * 1000;

    const estimated = setup({ useOutputLatencyCompensation: false });
    expect(measureRenderOffsetMs(estimated)).toBeCloseTo(expectedMs, 3);

    // Same result on both clock sources: disabling compensation must not mean
    // "compensated on one clock, uncompensated on the other".
    const promoted = setup({
      useOutputLatencyCompensation: false,
      outputTimestamp: true,
    });
    promoteToTimestampClock(promoted.scheduler);
    expect(measureRenderOffsetMs(promoted)).toBeCloseTo(expectedMs, 3);
  });
});
