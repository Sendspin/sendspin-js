/**
 * Unit tests for OutputLatencyTracker (EMA-smoothed AudioContext latency).
 *
 * Spec ref: Playback Synchronization — clients should compensate for known
 * processing delays (DAC latency, audio buffer delays) when submitting audio
 * to hardware. This tracker estimates that delay from AudioContext and smooths it.
 *
 * Web Audio is mocked via a fake AudioContext exposing baseLatency/outputLatency.
 * No DOM is needed.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { OutputLatencyTracker } from "../../src/audio/output-latency-tracker";
import type { SendspinStorage } from "../../src/types";

const ALPHA = 0.01;

function fakeCtx(baseLatency: number, outputLatency: number): AudioContext {
  return { baseLatency, outputLatency } as unknown as AudioContext;
}

function makeStorage(): SendspinStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

describe("OutputLatencyTracker", () => {
  describe("getRawUs", () => {
    it("returns 0 when audioContext is null", () => {
      const t = new OutputLatencyTracker(null);
      expect(t.getRawUs(null)).toBe(0);
    });

    it("sums baseLatency and outputLatency converted to microseconds", () => {
      const t = new OutputLatencyTracker(null);
      // 0.005s + 0.02s = 0.025s = 25000us
      expect(t.getRawUs(fakeCtx(0.005, 0.02))).toBeCloseTo(25000, 6);
    });

    it("treats missing latency fields as 0", () => {
      const t = new OutputLatencyTracker(null);
      const ctx = {} as unknown as AudioContext;
      expect(t.getRawUs(ctx)).toBe(0);
    });
  });

  describe("EMA smoothing", () => {
    it("moves toward new readings by exactly alpha per step", () => {
      const t = new OutputLatencyTracker(null);
      // seed at 10000us
      t.getSmoothedUs(fakeCtx(0.01, 0)); // 10000us
      // step toward 20000us
      const v = t.getSmoothedUs(fakeCtx(0.02, 0)); // 20000us raw
      const expected = ALPHA * 20000 + (1 - ALPHA) * 10000;
      expect(v).toBeCloseTo(expected, 3);
    });
  });

  describe("zero/invalid raw readings", () => {
    it("holds the last smoothed value when a transient zero reading arrives", () => {
      const t = new OutputLatencyTracker(null);
      const seeded = t.getSmoothedUs(fakeCtx(0.01, 0)); // 10000
      // raw <= 0 with an existing smoothed value should NOT pull it down
      const held = t.getSmoothedUs(fakeCtx(0, 0));
      expect(held).toBeCloseTo(seeded, 6);
    });

    it("returns 0 from getSmoothedUs when first reading is zero (no prior value)", () => {
      const t = new OutputLatencyTracker(null);
      // raw is 0 and smoothed is null -> falls through to seed at 0
      expect(t.getSmoothedUs(fakeCtx(0, 0))).toBe(0);
    });
  });

  describe("reset", () => {
    it("clears the smoothed state so the next reading re-seeds", () => {
      const t = new OutputLatencyTracker(null);
      t.getSmoothedUs(fakeCtx(0.05, 0)); // 50000
      t.reset();
      // after reset, a fresh raw reading should seed directly (no EMA blend)
      const v = t.getSmoothedUs(fakeCtx(0.01, 0)); // 10000
      expect(v).toBeCloseTo(10000, 6);
    });
  });

  describe("persistence", () => {
    let storage: ReturnType<typeof makeStorage>;
    let nowMs: number;

    beforeEach(() => {
      storage = makeStorage();
      nowMs = 1_000_000;
      vi.stubGlobal("performance", { now: () => nowMs });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("persists the smoothed value on the first sample", () => {
      const t = new OutputLatencyTracker(storage);
      t.getSmoothedUs(fakeCtx(0.01, 0)); // 10000
      expect(storage.data.get("sendspin-output-latency-us")).toBeTruthy();
      expect(
        parseFloat(storage.data.get("sendspin-output-latency-us")!),
      ).toBeCloseTo(10000, 3);
    });

    it("re-persists after the persist interval elapses", () => {
      const t = new OutputLatencyTracker(storage);
      t.getSmoothedUs(fakeCtx(0.01, 0));
      const setSpy = vi.spyOn(storage, "setItem");
      nowMs += 10_001; // >= 10s interval
      t.getSmoothedUs(fakeCtx(0.05, 0));
      expect(setSpy).toHaveBeenCalledTimes(1);
    });

    it("loads a persisted value on construction and uses it for zero-reading holds", () => {
      storage.data.set("sendspin-output-latency-us", "42000");
      const t = new OutputLatencyTracker(storage);
      // a zero raw reading should return the persisted value, not 0
      expect(t.getSmoothedUs(fakeCtx(0, 0))).toBeCloseTo(42000, 6);
    });

    it("ignores a negative persisted value", () => {
      storage.data.set("sendspin-output-latency-us", "-5000");
      const t = new OutputLatencyTracker(storage);
      // negative was rejected on load -> smoothed is null -> zero reading seeds at 0
      expect(t.getSmoothedUs(fakeCtx(0, 0))).toBe(0);
    });
  });
});
