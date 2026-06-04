/**
 * Recorrection monitor for detecting sustained sync drift.
 *
 * Runs on a periodic interval and detects when sync error exceeds a threshold
 * for long enough to warrant a hard resync. The monitor only detects — the
 * actual cutover execution is delegated to the scheduler via callback.
 */

const RECORRECTION_CHECK_INTERVAL_MS = 250;
const RECORRECTION_TRIGGER_MS = 30;
const RECORRECTION_SUSTAIN_MS = 400;
const RECORRECTION_COOLDOWN_MS = 1_500;
const RECORRECTION_TRANSIENT_JUMP_MS = 25;
const RECORRECTION_TRANSIENT_CONFIRM_WINDOW_MS =
  RECORRECTION_CHECK_INTERVAL_MS * 4;
const HARD_RESYNC_STARTUP_GRACE_MS = 1_000;
const HARD_RESYNC_COOLDOWN_MS = 500;

export class RecorrectionMonitor {
  private interval: ReturnType<typeof setInterval> | null = null;
  private breachStartedAtMs: number | null = null;
  private lastRecorrectionAtMs: number = -Infinity;
  private prevRawSyncErrorMs: number | null = null;
  private pendingJumpSign: number | null = null;
  private pendingJumpAtMs: number | null = null;
  private transientStartedAtMs: number | null = null;
  private _hardResyncGraceUntilMs: number | null = null;
  private _lastHardResyncAtMs: number = -Infinity;
  /** After a recorrection, scheduling must not start before this time. */
  private _minScheduleTimeSec: number | null = null;

  get minScheduleTimeSec(): number | null {
    return this._minScheduleTimeSec;
  }

  setMinScheduleTime(timeSec: number | null): void {
    this._minScheduleTimeSec = timeSec;
  }

  clearMinScheduleTime(): void {
    this._minScheduleTimeSec = null;
  }

  constructor(private onCheck: () => void) {}

  start(): void {
    if (this.interval !== null) return;
    this.interval = globalThis.setInterval(
      () => this.onCheck(),
      RECORRECTION_CHECK_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.resetCheckState();
    this.lastRecorrectionAtMs = -Infinity;
  }

  clearBreachState(): void {
    this.breachStartedAtMs = null;
    this.pendingJumpSign = null;
    this.pendingJumpAtMs = null;
    this.transientStartedAtMs = null;
  }

  resetCheckState(): void {
    this.clearBreachState();
    this.prevRawSyncErrorMs = null;
  }

  clearHardResyncCooldown(): void {
    this._hardResyncGraceUntilMs = null;
    this._lastHardResyncAtMs = -Infinity;
  }

  armStartupGrace(nowMs: number, isTimestampClock: boolean): void {
    if (isTimestampClock) {
      this._hardResyncGraceUntilMs = null;
      return;
    }
    if (this._hardResyncGraceUntilMs === null) {
      this._hardResyncGraceUntilMs = nowMs + HARD_RESYNC_STARTUP_GRACE_MS;
    }
  }

  canUseHardResync(nowMs: number, isTimestampClock: boolean): boolean {
    if (isTimestampClock) {
      this._hardResyncGraceUntilMs = null;
    } else if (
      this._hardResyncGraceUntilMs !== null &&
      nowMs < this._hardResyncGraceUntilMs
    ) {
      return false;
    }
    return nowMs - this._lastHardResyncAtMs >= HARD_RESYNC_COOLDOWN_MS;
  }

  noteHardResync(nowMs: number): void {
    this._lastHardResyncAtMs = nowMs;
  }

  /** Mark a recorrection as having just happened (for cooldown). */
  markRecorrection(nowMs: number): void {
    this.lastRecorrectionAtMs = nowMs;
  }

  shouldIgnoreTransientJump(rawSyncErrorMs: number, nowMs: number): boolean {
    const prev = this.prevRawSyncErrorMs;
    this.prevRawSyncErrorMs = rawSyncErrorMs;

    if (prev === null) {
      this.pendingJumpSign = null;
      this.pendingJumpAtMs = null;
      return false;
    }

    const jumpDeltaMs = rawSyncErrorMs - prev;
    const jumpSign = Math.sign(jumpDeltaMs);
    const isJumpDetected =
      Math.abs(jumpDeltaMs) >= RECORRECTION_TRANSIENT_JUMP_MS;
    if (!isJumpDetected) {
      this.pendingJumpSign = null;
      this.pendingJumpAtMs = null;
      return false;
    }

    const isConfirmed =
      this.pendingJumpSign === jumpSign &&
      this.pendingJumpAtMs !== null &&
      nowMs - this.pendingJumpAtMs <= RECORRECTION_TRANSIENT_CONFIRM_WINDOW_MS;
    this.pendingJumpSign = jumpSign;
    this.pendingJumpAtMs = nowMs;
    // Keep the pending jump so a sustained same-sign run stays confirmed.
    if (isConfirmed) {
      return false;
    }

    return true;
  }

  /**
   * Evaluate whether a recorrection should fire given the current sync state.
   * Returns true if the scheduler should perform a guarded cutover.
   */
  shouldRecorrect(
    smoothedAbsErrorMs: number,
    rawSyncErrorMs: number,
    nowMs: number,
  ): boolean {
    const isTransient = this.shouldIgnoreTransientJump(rawSyncErrorMs, nowMs);

    if (smoothedAbsErrorMs < RECORRECTION_TRIGGER_MS) {
      this.clearBreachState();
      return false;
    }
    if (isTransient) {
      // Jitter that keeps suppressing for SUSTAIN_MS while smoothed stays high
      // is sustained drift, not a glitch. Stop treating it as transient.
      if (this.transientStartedAtMs === null) {
        this.transientStartedAtMs = nowMs;
      }
      if (nowMs - this.transientStartedAtMs < RECORRECTION_SUSTAIN_MS) {
        this.breachStartedAtMs = null;
        return false;
      }
      // Mature on the same budget as clean drift by counting from suppression start.
      if (this.breachStartedAtMs === null) {
        this.breachStartedAtMs = this.transientStartedAtMs;
      }
    } else {
      this.transientStartedAtMs = null;
    }
    if (this.breachStartedAtMs === null) {
      this.breachStartedAtMs = nowMs;
      return false;
    }
    if (nowMs - this.breachStartedAtMs < RECORRECTION_SUSTAIN_MS) {
      return false;
    }
    if (nowMs - this.lastRecorrectionAtMs < RECORRECTION_COOLDOWN_MS) {
      return false;
    }

    return true;
  }

  /** Full reset (on disconnect or stream clear). */
  fullReset(): void {
    this.stop();
    this._hardResyncGraceUntilMs = null;
    this._lastHardResyncAtMs = -Infinity;
    this._minScheduleTimeSec = null;
  }
}

export const RECORRECTION_CUTOVER_GUARD_SEC = 0.3;
