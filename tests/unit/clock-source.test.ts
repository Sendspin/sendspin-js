/**
 * Unit tests for ClockSource (AudioContext clock selection + validation).
 *
 * Spec ref: Clock Synchronization / Playback Synchronization — clients
 * translate server timestamps to a local clock and "compensate for any known
 * processing delays". This module derives a stable AudioContext time, either
 * by de-quantizing currentTime ("estimated") or via getOutputTimestamp
 * ("timestamp"), validating the latter heavily before promoting to it.
 *
 * Web Audio is mocked. A fake AudioContext exposes currentTime and an optional
 * getOutputTimestamp(); performance.now() is stubbed for deterministic timing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ClockSource } from "../../src/audio/clock-source";

let nowMs = 0;

function makeCtx(opts: {
  currentTime?: number | (() => number);
  getOutputTimestamp?: () => { contextTime: number; performanceTime: number };
}): AudioContext {
  return {
    get currentTime() {
      return typeof opts.currentTime === "function"
        ? opts.currentTime()
        : (opts.currentTime ?? 0);
    },
    getOutputTimestamp: opts.getOutputTimestamp,
  } as unknown as AudioContext;
}

describe("ClockSource", () => {
  beforeEach(() => {
    nowMs = 1000;
    vi.stubGlobal("performance", { now: () => nowMs });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("getTimingSnapshot with null context", () => {
    it("returns zeros for context times and current wall clock", () => {
      const cs = new ClockSource();
      const snap = cs.getTimingSnapshot(null);
      expect(snap.audioContextTimeSec).toBe(0);
      expect(snap.audioContextRawTimeSec).toBe(0);
      expect(snap.nowMs).toBe(1000);
      expect(snap.nowUs).toBe(1_000_000);
    });
  });

  describe("estimated clock de-quantization", () => {
    it("seeds the estimate with the first raw time", () => {
      const cs = new ClockSource();
      const snap = cs.getTimingSnapshot(makeCtx({ currentTime: 5.0 }));
      expect(snap.audioContextTimeSec).toBeCloseTo(5.0, 6);
      expect(snap.audioContextRawTimeSec).toBeCloseTo(5.0, 6);
    });

    it("advances by wall-clock delta when raw time is quantized (stuck)", () => {
      const cs = new ClockSource();
      const ctx = makeCtx({ currentTime: 5.0 });
      cs.getTimingSnapshot(ctx); // seed at 5.0
      // raw stays at 5.0 (quantized) but 100ms wall time passed
      nowMs += 100;
      const snap = cs.getTimingSnapshot(ctx);
      // predicted = 5.0 + 0.1, error = 5.0 - 5.1 = -0.1, slew clamped to -0.002
      // next = max(5.0, 5.1 - 0.002) = 5.098, then min(5.098, 5.0+0.1)=5.098
      expect(snap.audioContextTimeSec).toBeGreaterThan(5.0);
      expect(snap.audioContextTimeSec).toBeLessThanOrEqual(5.1);
    });

    it("never moves the estimate backward (monotonic)", () => {
      const cs = new ClockSource();
      const ctx = makeCtx({ currentTime: 10.0 });
      const a = cs.getTimingSnapshot(ctx).audioContextTimeSec;
      nowMs += 50;
      const b = cs.getTimingSnapshot(ctx).audioContextTimeSec;
      expect(b).toBeGreaterThanOrEqual(a);
    });

    it("resets the estimate on a large raw discontinuity (> 0.5s)", () => {
      const cs = new ClockSource();
      cs.getTimingSnapshot(makeCtx({ currentTime: 5.0 })); // seed
      nowMs += 10;
      // raw jumps to 100s, far beyond reset threshold
      const snap = cs.getTimingSnapshot(makeCtx({ currentTime: 100.0 }));
      expect(snap.audioContextTimeSec).toBeCloseTo(100.0, 6);
    });

    it("does not lead the raw time by more than the max lead (0.1s)", () => {
      const cs = new ClockSource();
      const ctx = makeCtx({ currentTime: 5.0 });
      cs.getTimingSnapshot(ctx); // seed
      // a huge wall delta would push predicted way ahead, but lead is capped
      nowMs += 10_000;
      const snap = cs.getTimingSnapshot(ctx);
      expect(snap.audioContextTimeSec).toBeLessThanOrEqual(5.0 + 0.1 + 1e-9);
    });
  });

  describe("timestamp promotion", () => {
    // A getOutputTimestamp that advances contextTime in lockstep with wall time
    // and stays close to currentTime, so every sample is "good".
    function goodCtx(base: { contextTime: number }) {
      // raw currentTime tracks contextTime closely
      return makeCtx({
        currentTime: () => base.contextTime,
        getOutputTimestamp: () => ({
          contextTime: base.contextTime,
          performanceTime: nowMs,
        }),
      });
    }

    it("promotes to the timestamp clock after enough good samples over enough span", () => {
      const base = { contextTime: 10.0 };
      const ctx = goodCtx(base);
      const cs = new ClockSource();
      // Feed >= 6 good samples spanning >= 750ms, each >= 40ms apart.
      for (let i = 0; i < 8; i++) {
        cs.getTimingSnapshot(ctx);
        nowMs += 150;
        base.contextTime += 0.15;
      }
      expect(cs.active).toBe("timestamp");
      expect(cs.pendingCutover).toBe(true);
      expect(cs.timestampGoodSamples).toBeGreaterThanOrEqual(6);
    });

    it("does not promote when fewer than the minimum good samples are seen", () => {
      const base = { contextTime: 10.0 };
      const ctx = goodCtx(base);
      const cs = new ClockSource();
      for (let i = 0; i < 3; i++) {
        cs.getTimingSnapshot(ctx);
        nowMs += 150;
        base.contextTime += 0.15;
      }
      expect(cs.active).toBe("estimated");
    });

    it("does not promote when the good-sample span is too short", () => {
      const base = { contextTime: 10.0 };
      const ctx = goodCtx(base);
      const cs = new ClockSource();
      // Many samples but spanning < 750ms total.
      for (let i = 0; i < 8; i++) {
        cs.getTimingSnapshot(ctx);
        nowMs += 50; // 8*50 = 400ms total span < 750
        base.contextTime += 0.05;
      }
      expect(cs.active).toBe("estimated");
    });

    it("fires the promotion callback exactly when promoted", () => {
      const base = { contextTime: 10.0 };
      const ctx = goodCtx(base);
      const cs = new ClockSource();
      const cb = vi.fn();
      cs.onPromotion(cb);
      for (let i = 0; i < 8; i++) {
        cs.getTimingSnapshot(ctx);
        nowMs += 150;
        base.contextTime += 0.15;
      }
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe("playout-latency normalization", () => {
    // Real browsers put getOutputTimestamp().contextTime one output latency
    // behind currentTime (measured in Chromium/macOS: 20.9ms lag vs a reported
    // baseLatency + outputLatency of 21.3ms). Both clock sources must report the
    // render clock, so the caller-supplied latency is added back.
    function laggingCtx(base: { currentTime: number }, latencySec: number) {
      return makeCtx({
        currentTime: () => base.currentTime,
        getOutputTimestamp: () => ({
          contextTime: base.currentTime - latencySec,
          performanceTime: nowMs,
        }),
      });
    }

    function promote(
      cs: ClockSource,
      ctx: AudioContext,
      base: { currentTime: number },
      latencySec: number,
    ): number {
      let snapshot = cs.getTimingSnapshot(ctx, latencySec);
      for (let i = 0; i < 8; i++) {
        nowMs += 150;
        base.currentTime += 0.15;
        snapshot = cs.getTimingSnapshot(ctx, latencySec);
      }
      return snapshot.audioContextTimeSec;
    }

    it("reports the render clock, not the playout clock, once promoted", () => {
      const latencySec = 0.021333333333333333;
      const base = { currentTime: 10.0 };
      const cs = new ClockSource();
      const derived = promote(
        cs,
        laggingCtx(base, latencySec),
        base,
        latencySec,
      );

      expect(cs.active).toBe("timestamp");
      expect(derived).toBeCloseTo(base.currentTime, 6);
    });

    it("trails the render clock by the latency when none is supplied", () => {
      const latencySec = 0.021333333333333333;
      const base = { currentTime: 10.0 };
      const cs = new ClockSource();
      // Passing 0 leaves contextTime in the playout domain: the promoted clock
      // then reads one latency early, which would schedule audio that much late.
      const derived = promote(cs, laggingCtx(base, latencySec), base, 0);

      expect(cs.active).toBe("timestamp");
      expect(base.currentTime - derived).toBeCloseTo(latencySec, 6);
    });

    it("still promotes on devices whose output latency exceeds the divergence tolerance", () => {
      // 300ms of latency (e.g. a Bluetooth sink) exceeds the 250ms timestamp/raw
      // divergence tolerance, so without normalization every sample is rejected.
      const latencySec = 0.3;

      const normalizedBase = { currentTime: 10.0 };
      const normalized = new ClockSource();
      promote(
        normalized,
        laggingCtx(normalizedBase, latencySec),
        normalizedBase,
        latencySec,
      );
      expect(normalized.active).toBe("timestamp");

      nowMs = 1000;
      const unnormalizedBase = { currentTime: 10.0 };
      const unnormalized = new ClockSource();
      promote(
        unnormalized,
        laggingCtx(unnormalizedBase, latencySec),
        unnormalizedBase,
        0,
      );
      expect(unnormalized.active).toBe("estimated");
      expect(unnormalized.lastRejectReason).toMatch(/divergence/);
    });
  });

  describe("timestamp rejection / demotion", () => {
    it("rejects and never promotes when contextTime diverges from raw beyond tolerance", () => {
      const base = { contextTime: 10.0 };
      const cs = new ClockSource();
      // raw currentTime is 10 but getOutputTimestamp reports 11 -> ~1s divergence
      const ctx = makeCtx({
        currentTime: 10.0,
        getOutputTimestamp: () => ({
          contextTime: base.contextTime + 1.0,
          performanceTime: nowMs,
        }),
      });
      for (let i = 0; i < 8; i++) {
        cs.getTimingSnapshot(ctx);
        nowMs += 150;
      }
      expect(cs.active).toBe("estimated");
      expect(cs.lastRejectReason).toMatch(/divergence/);
    });

    it("rejects a stale timestamp sample (performanceTime too old)", () => {
      const cs = new ClockSource();
      const ctx = makeCtx({
        currentTime: 10.0,
        getOutputTimestamp: () => ({
          contextTime: 10.0,
          performanceTime: nowMs - 500, // 500ms old > 250ms freshness limit
        }),
      });
      cs.getTimingSnapshot(ctx);
      expect(cs.active).toBe("estimated");
      expect(cs.lastRejectReason).toMatch(/stale/);
      expect(cs.timestampGoodSamples).toBe(0);
    });

    it("rejects a timestamp whose performanceTime is in the future", () => {
      const cs = new ClockSource();
      const ctx = makeCtx({
        currentTime: 10.0,
        getOutputTimestamp: () => ({
          contextTime: 10.0,
          performanceTime: nowMs + 50, // well beyond 5ms future tolerance
        }),
      });
      cs.getTimingSnapshot(ctx);
      expect(cs.lastRejectReason).toMatch(/future/);
    });

    it("demotes back to estimated when getOutputTimestamp disappears after promotion", () => {
      const base = { contextTime: 10.0 };
      // promote first
      const good = makeCtx({
        currentTime: () => base.contextTime,
        getOutputTimestamp: () => ({
          contextTime: base.contextTime,
          performanceTime: nowMs,
        }),
      });
      const cs = new ClockSource();
      for (let i = 0; i < 8; i++) {
        cs.getTimingSnapshot(good);
        nowMs += 150;
        base.contextTime += 0.15;
      }
      expect(cs.active).toBe("timestamp");
      // now the API vanishes
      const bad = makeCtx({ currentTime: base.contextTime });
      cs.getTimingSnapshot(bad);
      expect(cs.active).toBe("estimated");
      expect(cs.lastRejectReason).toMatch(/unavailable/);
    });

    it("falls back to estimated time in the snapshot while unpromoted even with good samples", () => {
      const base = { contextTime: 10.0 };
      const ctx = makeCtx({
        currentTime: () => base.contextTime,
        getOutputTimestamp: () => ({
          contextTime: base.contextTime,
          performanceTime: nowMs,
        }),
      });
      const cs = new ClockSource();
      const snap = cs.getTimingSnapshot(ctx);
      // first sample: still estimated, so reported time is the estimated seed
      expect(cs.active).toBe("estimated");
      expect(snap.audioContextTimeSec).toBeCloseTo(10.0, 6);
    });
  });

  describe("disableTimestampPromotion (Cast receivers)", () => {
    it("never promotes when promotion is disabled even with good samples", () => {
      const base = { contextTime: 10.0 };
      const ctx = makeCtx({
        currentTime: () => base.contextTime,
        getOutputTimestamp: () => ({
          contextTime: base.contextTime,
          performanceTime: nowMs,
        }),
      });
      const cs = new ClockSource();
      cs.disableTimestampPromotion();
      expect(cs.timestampPromotionDisabled).toBe(true);
      for (let i = 0; i < 12; i++) {
        cs.getTimingSnapshot(ctx);
        nowMs += 150;
        base.contextTime += 0.15;
      }
      expect(cs.active).toBe("estimated");
      expect(cs.timestampGoodSamples).toBe(0);
    });
  });

  describe("reset", () => {
    it("returns to the estimated clock and clears sample state", () => {
      const base = { contextTime: 10.0 };
      const ctx = makeCtx({
        currentTime: () => base.contextTime,
        getOutputTimestamp: () => ({
          contextTime: base.contextTime,
          performanceTime: nowMs,
        }),
      });
      const cs = new ClockSource();
      for (let i = 0; i < 8; i++) {
        cs.getTimingSnapshot(ctx);
        nowMs += 150;
        base.contextTime += 0.15;
      }
      expect(cs.active).toBe("timestamp");
      cs.reset();
      expect(cs.active).toBe("estimated");
      expect(cs.pendingCutover).toBe(false);
      expect(cs.timestampGoodSamples).toBe(0);
      expect(cs.lastRejectReason).toBeNull();
    });
  });
});
