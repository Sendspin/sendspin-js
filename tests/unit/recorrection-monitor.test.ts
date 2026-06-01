/**
 * Unit tests for RecorrectionMonitor (sustained-drift detection + cooldown).
 *
 * Spec ref: Playback Synchronization — "Each client is responsible for
 * maintaining synchronization with the server's timestamps." A hard resync
 * (cutover) is a last-resort correction; it must only fire on a SUSTAINED
 * breach and must be rate-limited by a cooldown so a single drift does not
 * trigger repeated audible jumps.
 *
 * Constants mirrored from source:
 *   CHECK_INTERVAL = 250ms, TRIGGER = 30ms, SUSTAIN = 400ms,
 *   COOLDOWN = 1500ms, TRANSIENT_JUMP = 25ms, CONFIRM_WINDOW = 1000ms,
 *   STARTUP_GRACE = 1000ms, HARD_RESYNC_COOLDOWN = 500ms.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { RecorrectionMonitor } from "../../src/audio/recorrection-monitor";

const TRIGGER = 30;
const SUSTAIN = 400;
const COOLDOWN = 1500;

describe("RecorrectionMonitor", () => {
  let onCheck: ReturnType<typeof vi.fn>;
  let mon: RecorrectionMonitor;

  beforeEach(() => {
    onCheck = vi.fn();
    mon = new RecorrectionMonitor(onCheck);
  });

  describe("interval lifecycle", () => {
    it("invokes the callback on the check interval", () => {
      vi.useFakeTimers();
      mon.start();
      vi.advanceTimersByTime(250);
      expect(onCheck).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(500);
      expect(onCheck).toHaveBeenCalledTimes(3);
      mon.stop();
      vi.useRealTimers();
    });

    it("start is idempotent (no duplicate intervals)", () => {
      vi.useFakeTimers();
      mon.start();
      mon.start();
      vi.advanceTimersByTime(250);
      expect(onCheck).toHaveBeenCalledTimes(1);
      mon.stop();
      vi.useRealTimers();
    });

    it("stop halts callbacks", () => {
      vi.useFakeTimers();
      mon.start();
      mon.stop();
      vi.advanceTimersByTime(1000);
      expect(onCheck).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("threshold gating (deadband below TRIGGER)", () => {
    it("does not recorrect when smoothed error is below the trigger", () => {
      // raw matches smoothed; no jump
      expect(mon.shouldRecorrect(TRIGGER - 1, TRIGGER - 1, 1000)).toBe(false);
    });

    it("does not fire on the first breach sample (must be sustained)", () => {
      // First sample at/above trigger only arms the breach window.
      expect(mon.shouldRecorrect(50, 50, 1000)).toBe(false);
    });
  });

  describe("sustained breach", () => {
    it("fires only after the breach persists for SUSTAIN ms", () => {
      let now = 1000;
      // Sample 1: arm breach
      expect(mon.shouldRecorrect(50, 50, now)).toBe(false);
      // Sample 2: still within sustain window
      now += 250;
      expect(mon.shouldRecorrect(50, 50, now)).toBe(false);
      // Sample 3: now SUSTAIN elapsed since breach start
      now = 1000 + SUSTAIN + 1;
      expect(mon.shouldRecorrect(50, 50, now)).toBe(true);
    });

    it("resets the breach window when error drops back under trigger", () => {
      let now = 1000;
      expect(mon.shouldRecorrect(50, 50, now)).toBe(false); // arm
      now += SUSTAIN + 10;
      // drop below trigger clears breach
      expect(mon.shouldRecorrect(10, 10, now)).toBe(false);
      // breach must re-arm from scratch: this is a fresh first-breach
      now += 10;
      expect(mon.shouldRecorrect(50, 50, now)).toBe(false);
    });
  });

  describe("cooldown gating", () => {
    it("suppresses a second recorrection within the cooldown window", () => {
      let now = 1000;
      // Drive to first recorrection
      mon.shouldRecorrect(50, 50, now); // arm
      now += SUSTAIN + 1;
      expect(mon.shouldRecorrect(50, 50, now)).toBe(true);
      mon.markRecorrection(now);

      // Re-arm and reach sustain again, but inside cooldown
      const recorrectAt = now;
      mon.clearBreachState();
      mon.shouldRecorrect(50, 50, now); // arm fresh breach
      now += SUSTAIN + 1;
      expect(now - recorrectAt).toBeLessThan(COOLDOWN);
      expect(mon.shouldRecorrect(50, 50, now)).toBe(false);
    });

    it("allows a recorrection once the cooldown has elapsed", () => {
      let now = 1000;
      mon.shouldRecorrect(50, 50, now);
      now += SUSTAIN + 1;
      expect(mon.shouldRecorrect(50, 50, now)).toBe(true);
      const recorrectAt = now;
      mon.markRecorrection(now);

      mon.clearBreachState();
      // Advance past cooldown, then arm + sustain
      now = recorrectAt + COOLDOWN + 1;
      mon.shouldRecorrect(50, 50, now); // arm
      now += SUSTAIN + 1;
      expect(mon.shouldRecorrect(50, 50, now)).toBe(true);
    });
  });

  describe("transient jump suppression", () => {
    it("returns false on the first observed error (no previous sample)", () => {
      expect(mon.shouldIgnoreTransientJump(100, 1000)).toBe(false);
    });

    it("ignores a single large unconfirmed jump as transient", () => {
      mon.shouldIgnoreTransientJump(0, 1000); // establish prev
      // jump of +50ms (>= 25) with no prior pending same-sign jump
      expect(mon.shouldIgnoreTransientJump(50, 1100)).toBe(true);
    });

    it("confirms a sustained same-sign jump (stops ignoring) within the window", () => {
      mon.shouldIgnoreTransientJump(0, 1000);
      // first jump: pending, ignored
      expect(mon.shouldIgnoreTransientJump(50, 1100)).toBe(true);
      // second same-sign jump within confirm window (1000ms): confirmed -> not transient
      expect(mon.shouldIgnoreTransientJump(100, 1300)).toBe(false);
    });

    it("blocks a sustained breach from firing while jumps remain unconfirmed", () => {
      let now = 1000;
      // raw error keeps jumping upward by >=25 each sample but never gets
      // a confirmed same-sign repeat before the value is re-evaluated.
      // Smoothed stays above trigger. A lone first jump is transient -> breach cleared.
      mon.shouldRecorrect(50, 0, now); // prev=0, no jump (first sample) -> arms breach
      now += SUSTAIN + 1;
      // jump +50 from 0 -> 50: transient on first detection -> clears breach, returns false
      expect(mon.shouldRecorrect(50, 50, now)).toBe(false);
    });
  });

  describe("sustained genuine drift must eventually recorrect (candidate bug)", () => {
    // A steadily drifting clock produces a raw sync error that climbs by more
    // than the transient-jump threshold (25ms) on every check while the
    // smoothed error stays far above the trigger. This is NOT a transient — it
    // is exactly the sustained breach a hard resync exists to fix. The monitor
    // must fire within a bounded time, not suppress it forever as "transient".
    it("fires for a monotonically climbing raw error within a few seconds", () => {
      let now = 1000;
      let raw = 0;
      mon.shouldRecorrect(Math.abs(raw), raw, now);
      let fired = false;
      for (let i = 0; i < 40 && !fired; i++) {
        now += 250;
        raw += 30; // > 25ms transient threshold, same (positive) sign
        fired = mon.shouldRecorrect(Math.abs(raw), raw, now);
      }
      // raw error has climbed past 1 second of skew by the loop's end.
      expect(fired).toBe(true);
    });

    it("fires when raw error jitters but stays a sustained large positive breach", () => {
      let now = 1000;
      // Smoothed pinned at 60ms (well above 30ms trigger); raw oscillates
      // 60<->100 (delta 40 >= 25) but never crosses zero -> not transient drift.
      let raw = 60;
      mon.shouldRecorrect(60, raw, now);
      let fired = false;
      for (let i = 0; i < 40 && !fired; i++) {
        now += 250;
        raw = raw === 60 ? 100 : 60;
        fired = mon.shouldRecorrect(60, raw, now);
      }
      expect(fired).toBe(true);
    });
  });

  describe("hard resync gating", () => {
    it("blocks hard resync during the startup grace window (non-timestamp clock)", () => {
      mon.armStartupGrace(1000, false);
      expect(mon.canUseHardResync(1500, false)).toBe(false); // within 1000ms grace
    });

    it("allows hard resync after the startup grace window", () => {
      mon.armStartupGrace(1000, false);
      expect(mon.canUseHardResync(2001, false)).toBe(true); // grace elapsed (1000+1000)
    });

    it("does not arm startup grace for timestamp clocks", () => {
      mon.armStartupGrace(1000, true);
      // timestamp clock: grace cleared, only the 500ms hard-resync cooldown applies
      expect(mon.canUseHardResync(1000, true)).toBe(true);
    });

    it("enforces the 500ms hard-resync cooldown between resyncs", () => {
      expect(mon.canUseHardResync(1000, true)).toBe(true);
      mon.noteHardResync(1000);
      expect(mon.canUseHardResync(1200, true)).toBe(false); // within 500ms
      expect(mon.canUseHardResync(1500, true)).toBe(true); // 500ms elapsed
    });

    it("clearHardResyncCooldown re-enables immediate hard resync", () => {
      mon.noteHardResync(1000);
      mon.clearHardResyncCooldown();
      expect(mon.canUseHardResync(1100, true)).toBe(true);
    });
  });

  describe("fullReset", () => {
    it("clears cooldown, grace, and schedule state", () => {
      mon.noteHardResync(1000);
      mon.setMinScheduleTime(5);
      mon.armStartupGrace(1000, false);
      mon.fullReset();
      expect(mon.minScheduleTimeSec).toBeNull();
      // hard resync cooldown cleared -> allowed immediately
      expect(mon.canUseHardResync(1100, true)).toBe(true);
    });

    it("resets recorrection cooldown on stop so first breach can fire again", () => {
      let now = 1000;
      mon.shouldRecorrect(50, 50, now);
      now += SUSTAIN + 1;
      expect(mon.shouldRecorrect(50, 50, now)).toBe(true);
      mon.markRecorrection(now);
      mon.stop(); // resets lastRecorrectionAtMs to -Infinity and clears breach
      // fresh breach after stop, no cooldown carried over
      now += 10;
      mon.shouldRecorrect(50, 50, now); // arm
      now += SUSTAIN + 1;
      expect(mon.shouldRecorrect(50, 50, now)).toBe(true);
    });
  });
});
