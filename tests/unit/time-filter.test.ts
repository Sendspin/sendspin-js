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

  describe("initialization", () => {
    it("starts unsynchronized", () => {
      expect(filter.is_synchronized).toBe(false);
      expect(filter.count).toBe(0);
    });

    it("starts with zero offset and drift", () => {
      expect(filter.offset).toBe(0);
      expect(filter.drift).toBe(0);
    });
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

    it("sets error from first measurement uncertainty", () => {
      filter.update(5000, 500, 100);
      expect(filter.error).toBe(500);
    });
  });

  describe("multiple measurements", () => {
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

    it("ignores duplicate timestamps", () => {
      filter.update(5000, 500, 100);
      filter.update(5500, 500, 100); // Same timestamp → should be skipped

      expect(filter.count).toBe(1);
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

    it("computes correct server time with zero offset", () => {
      filter.update(0, 500, 100000);

      const serverTime = filter.computeServerTime(200000);
      expect(serverTime).toBe(200000);
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
