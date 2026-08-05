/**
 * Unit tests for SendspinTimeFilter (Kalman filter for time synchronization).
 *
 * Tests the core NTP-style clock offset and drift estimation algorithm
 * that is critical for synchronized audio playback.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SendspinTimeFilter } from "../../src/core/time-filter";

describe("SendspinTimeFilter", () => {
  let filter: SendspinTimeFilter;

  beforeEach(() => {
    filter = new SendspinTimeFilter(0, 1.1, 2.0, 1e-12);
  });

  describe("single measurement", () => {
    it("becomes synchronized after first measurement", () => {
      filter.update(1000, 500, 100);
      expect(filter.is_synchronized).toBe(true);
      expect(filter.count).toBe(1);
    });

    it("sets offset to first measurement value", () => {
      filter.update(5000, 500, 100);
      expect(filter.offset).toBe(5000);
    });
  });

  describe("multiple measurements", () => {
    it("reports measurements processed after the maturity gate caps", () => {
      for (let i = 1; i <= 105; i++) {
        filter.update(10000, 1000, i * 100000);
      }

      expect(filter.count).toBe(105);
    });

    it("refines offset with consistent measurements", () => {
      // Simulate a constant 10ms offset
      const trueOffset = 10000; // 10ms in µs
      const times = [100000, 200000, 300000, 400000, 500000];

      for (const t of times) {
        filter.update(trueOffset, 1000, t);
      }

      // Offset should converge close to true value
      expect(Math.abs(filter.offset - trueOffset)).toBeLessThan(500);
    });

    it("reduces error with more measurements", () => {
      const errors: number[] = [];

      for (let i = 0; i < 10; i++) {
        filter.update(10000, 1000, (i + 1) * 100000);
        errors.push(filter.error);
      }

      // Error should generally decrease (or stay low)
      expect(errors[errors.length - 1]).toBeLessThan(errors[0]);
    });
  });

  describe("computeServerTime", () => {
    it("applies offset to client time", () => {
      // Set up a known offset
      filter.update(10000, 500, 100000);

      const serverTime = filter.computeServerTime(200000);
      // Should be client_time + offset = 200000 + 10000 = 210000
      expect(serverTime).toBe(210000);
    });
  });

  describe("computeClientTime", () => {
    it("inverts computeServerTime", () => {
      filter.update(10000, 500, 100000);

      const clientTime = 200000;
      const serverTime = filter.computeServerTime(clientTime);
      const roundTrip = filter.computeClientTime(serverTime);

      expect(roundTrip).toBe(clientTime);
    });
  });

  describe("reset", () => {
    it("clears all state", () => {
      filter.update(10000, 500, 100000);
      filter.update(10500, 500, 200000);

      expect(filter.is_synchronized).toBe(true);

      filter.reset();

      expect(filter.is_synchronized).toBe(false);
      expect(filter.count).toBe(0);
      expect(filter.offset).toBe(0);
      expect(filter.drift).toBe(0);
    });
  });

  describe("drift estimation", () => {
    it("estimates drift from two measurements", () => {
      // Two measurements 100ms apart with increasing offset → drift
      filter.update(10000, 500, 100000); // t=100ms, offset=10ms
      filter.update(10100, 500, 200000); // t=200ms, offset=10.1ms

      // Drift should be approximately (10100 - 10000) / (200000 - 100000) = 0.001
      expect(filter.count).toBe(2);
      // Drift estimate should be non-zero (positive)
      expect(filter.drift).toBeCloseTo(0.001, 4);
    });
  });

  describe("drift compensation", () => {
    it("applies the drift term to the transform once drift is significant", () => {
      // Feed an exact linear offset(t) = base + rate*t so the drift estimate
      // becomes statistically significant and drift compensation switches on.
      const base = 10000;
      const rate = 0.01;
      for (let i = 1; i <= 30; i++) {
        const t = i * 100000;
        filter.update(base + rate * t, 200, t);
      }

      const t1 = 4_000_000;
      const t2 = 5_000_000;
      const off1 = filter.computeServerTime(t1) - t1;
      const off2 = filter.computeServerTime(t2) - t2;

      // With drift active the applied offset grows over time.
      expect(off2).toBeGreaterThan(off1);
      // Round-trip stays consistent through the inverse transform.
      expect(
        filter.computeClientTime(filter.computeServerTime(t1)),
      ).toBeCloseTo(t1, -1);
    });
  });

  describe("adaptive forgetting", () => {
    it("recovers from a large offset jump after sufficient history", () => {
      // Build up history with offset = 10000
      for (let i = 1; i <= 110; i++) {
        filter.update(10000, 500, i * 100000);
      }

      const offsetBefore = filter.offset;

      // Sudden large offset change (simulates server clock jump)
      filter.update(50000, 500, 111 * 100000);

      // The filter should adapt toward the new offset
      // (with forgetting, it won't snap immediately but should move)
      expect(Math.abs(filter.offset - 50000)).toBeLessThan(
        Math.abs(offsetBefore - 50000),
      );
    });
  });
});

describe("SendspinTimeFilter extra", () => {
  let filter: SendspinTimeFilter;

  beforeEach(() => {
    filter = new SendspinTimeFilter(0, 1.1, 2.0, 1e-12);
  });

  describe("getters", () => {
    it("error and covariance reflect the first measurement variance", () => {
      filter.update(5000, 400, 100);
      // covariance = max_error^2 = 160000, error = sqrt = 400.
      expect(filter.covariance).toBe(160000);
      expect(filter.error).toBe(400);
    });

    it("covariance shrinks as consistent measurements accumulate", () => {
      filter.update(10000, 1000, 100000);
      const first = filter.covariance;
      for (let i = 2; i <= 6; i++) {
        filter.update(10000, 1000, i * 100000);
      }
      expect(filter.covariance).toBeLessThan(first);
    });
  });

  describe("adaptive forgetting non-trigger", () => {
    it("does not inflate covariance for a sub-cutoff residual", () => {
      // Build >100 measurements so the count gate is open, then feed two
      // measurements: one perturbed within cutoff, one exactly on-model.
      // A within-cutoff residual must NOT apply the forgetting factor.
      const max_error = 1000;
      for (let i = 1; i <= 120; i++) {
        filter.update(10000, max_error, i * 100000);
      }
      // Residual just under cutoff (2 * max_error = 2000). offset≈10000.
      // Use a perturbation < 2000 so forgetting is not triggered.
      const before = filter.covariance;
      filter.update(11500, max_error, 121 * 100000); // residual ~1500 < 2000

      // Without forgetting the covariance update is the ordinary Kalman shrink:
      // it should stay bounded near the pre-update value, not blow up by 1.21x.
      expect(filter.covariance).toBeLessThanOrEqual(before * 1.05);
    });

    it("inflates the estimate path for an over-cutoff residual (control)", () => {
      const max_error = 1000;
      for (let i = 1; i <= 120; i++) {
        filter.update(10000, max_error, i * 100000);
      }
      const offsetBefore = filter.offset;
      // Residual well over cutoff -> forgetting -> larger Kalman gain -> the
      // offset jumps further toward the new measurement than a non-forgetting
      // step would. We assert the offset moves a meaningful fraction.
      filter.update(60000, max_error, 121 * 100000);
      expect(filter.offset).toBeGreaterThan(offsetBefore);
    });
  });

  describe("non-monotonic-timestamp guard", () => {
    it("skips a second update at the same timestamp without changing offset", () => {
      filter.update(5000, 500, 100);
      const offsetAfterFirst = filter.offset;
      filter.update(9999, 500, 100); // same time_added -> skipped
      expect(filter.count).toBe(1);
      expect(filter.offset).toBe(offsetAfterFirst);
    });

    it("skips an update with a backward time_added", () => {
      filter.update(5000, 500, 200000);
      const offsetAfterFirst = filter.offset;
      // time_added moves backward (e.g. out-of-order packet on UDP transport).
      // Accepting it would yield a negative dt and corrupt the predict step.
      filter.update(9999, 500, 100000);
      expect(filter.count).toBe(1);
      expect(filter.offset).toBe(offsetAfterFirst);
    });

    it("does not corrupt drift init when a duplicate sits between measurements", () => {
      filter.update(10000, 500, 100000);
      filter.update(10000, 500, 100000); // duplicate, skipped
      filter.update(10100, 500, 200000); // genuine second measurement
      expect(filter.count).toBe(2);
      // dt for drift = 200000-100000 = 100000 -> drift ≈ 0.001.
      expect(filter.drift).toBeCloseTo(0.001, 4);
    });
  });

  describe("reset clears drift usage", () => {
    it("disables drift compensation after reset", () => {
      // Drive drift to significance.
      const base = 10000;
      const rate = 0.01;
      for (let i = 1; i <= 40; i++) {
        const t = i * 100000;
        filter.update(base + rate * t, 200, t);
      }
      // With drift active, computeServerTime offset grows with client time.
      const t1 = 5_000_000;
      const t2 = 6_000_000;
      expect(
        filter.computeServerTime(t2) - t2 - (filter.computeServerTime(t1) - t1),
      ).not.toBe(0);

      filter.reset();

      // After reset, offset is 0 and drift is not applied: server time == client time.
      expect(filter.computeServerTime(t1)).toBe(t1);
      expect(filter.computeServerTime(t2)).toBe(t2);
      expect(filter.drift).toBe(0);
    });
  });
});
