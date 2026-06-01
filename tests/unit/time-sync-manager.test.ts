/**
 * Unit tests for TimeSyncManager (NTP-style burst → Kalman filter feeder).
 *
 * Drives the burst state machine with a stubbed performance.now and a fake
 * WebSocketManager so the NTP arithmetic, robust candidate selection, and
 * timeout/abort paths are exercised deterministically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TimeSyncManager } from "../../src/core/time-sync-manager";
import type { WebSocketManager } from "../../src/core/websocket-manager";
import type { StateManager } from "../../src/core/state-manager";
import type { SendspinTimeFilter } from "../../src/core/time-filter";
import type { ServerTime } from "../../src/types";

describe("TimeSyncManager", () => {
  let send: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let mgr: TimeSyncManager;
  let nowMs: number;

  // T1 (client_transmitted) of every probe sent so far, in order.
  const sentT1 = (): number[] =>
    send.mock.calls.map((c) => c[0].payload.client_transmitted);
  const lastT1 = (): number => {
    const all = sentT1();
    return all[all.length - 1];
  };

  const respond = (t1: number, t2: number, t3: number): void => {
    mgr.handleServerTime({
      type: "server/time",
      payload: {
        client_transmitted: t1,
        server_received: t2,
        server_transmitted: t3,
      },
    } as unknown as ServerTime);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    nowMs = 1;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);

    send = vi.fn();
    update = vi.fn();
    const wsManager = {
      isConnected: () => true,
      send,
    } as unknown as WebSocketManager;
    const stateManager = {
      setTimeSyncInterval: vi.fn(),
      clearTimeSyncInterval: vi.fn(),
    } as unknown as StateManager;
    const timeFilter = { update } as unknown as SendspinTimeFilter;

    mgr = new TimeSyncManager(wsManager, stateManager, timeFilter);
  });

  afterEach(() => {
    mgr.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("computes the NTP offset over a full burst and updates the filter once", () => {
    // Hold T2-T1 and T3-T4 constant so every sample yields the same
    // measurement ((a+b)/2) and rtt (a-b), regardless of absolute clocks.
    const a = 2000;
    const b = 1000;
    const recvMs = [10, 20, 30, 40, 50, 60, 70, 80];

    mgr.startAndSchedule();

    for (let i = 0; i < 8; i++) {
      const t1 = lastT1();
      nowMs = recvMs[i];
      const t4 = recvMs[i] * 1000;
      respond(t1, t1 + a, t4 + b);
    }

    // measurement = (a + b) / 2; maxError = max(1000, (a-b)/2)
    // Candidate = median-by-measurement of the 3 lowest-rtt samples; all
    // samples are equal so stable sort picks the 2nd sent (t4 = 20*1000).
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(1500, 1000, 20000);
  });

  it("selects the median measurement among the lowest-RTT samples", () => {
    // Per-probe (a, b): measurement = (a+b)/2, rtt = a-b.
    const a = [3000, 3000, 3000, 10000, 10000, 10000, 10000, 10000];
    const b = [2900, 2800, 2700, 0, 0, 0, 0, 0];
    const recvMs = [10, 20, 30, 40, 50, 60, 70, 80];

    mgr.startAndSchedule();

    for (let i = 0; i < 8; i++) {
      const t1 = lastT1();
      nowMs = recvMs[i];
      const t4 = recvMs[i] * 1000;
      respond(t1, t1 + a[i], t4 + b[i]);
    }

    // Lowest-3 rtt = probes 0/1/2 (rtt 100/200/300), measurements
    // 2950/2900/2850 → median 2900 (probe 1).
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toBe(2900);
  });

  it("ignores an out-of-order response and does not advance the burst", () => {
    mgr.startAndSchedule();
    expect(sentT1()).toHaveLength(1);

    respond(lastT1() + 999999, 1, 1);

    expect(sentT1()).toHaveLength(1);
    expect(update).not.toHaveBeenCalled();
  });

  it("aborts the burst when a probe times out", () => {
    mgr.startAndSchedule();
    const t1 = lastT1();

    vi.advanceTimersByTime(2000);

    // Burst is aborted: a late response for the in-flight probe is ignored
    // and no further probe is sent.
    respond(t1, t1 + 2000, t1 + 3000);
    expect(update).not.toHaveBeenCalled();
    expect(sentT1()).toHaveLength(1);
  });
});
