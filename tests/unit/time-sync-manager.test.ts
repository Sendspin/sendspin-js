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

    // measurement = (a + b) / 2; maxError = max(1000, (a-b)/2). Every sample
    // is equivalent so any may be selected — don't pin which t4 wins here
    // (selection is covered by the next test).
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(1500, 1000, expect.any(Number));
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

describe("TimeSyncManager extra", () => {
  let send: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let mgr: TimeSyncManager;
  let connected: boolean;
  let nowMs: number;
  let setIntervalSpy: ReturnType<typeof vi.fn>;

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
    connected = true;
    setIntervalSpy = vi.fn();

    const wsManager = {
      isConnected: () => connected,
      send,
    } as unknown as WebSocketManager;
    const stateManager = {
      setTimeSyncInterval: setIntervalSpy,
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

  it("does not start a burst when the socket is disconnected", () => {
    connected = false;
    mgr.startAndSchedule();
    expect(send).not.toHaveBeenCalled();
    // The recurring tick is still scheduled so it can start later.
    expect(setIntervalSpy).toHaveBeenCalled();
  });

  it("starts a fresh burst on the next 10s tick once reconnected", () => {
    connected = false;
    mgr.startAndSchedule();
    expect(send).not.toHaveBeenCalled();

    connected = true;
    vi.advanceTimersByTime(10000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("schedules a recurring burst every 10s after the previous one finalizes", () => {
    mgr.startAndSchedule();

    // Complete the first full burst (8 probes).
    const runBurst = () => {
      for (let i = 0; i < 8; i++) {
        const t1 = lastT1();
        nowMs += 1;
        respond(t1, t1 + 1000, nowMs * 1000 + 500);
      }
    };
    runBurst();
    expect(update).toHaveBeenCalledTimes(1);
    const afterFirst = send.mock.calls.length;
    expect(afterFirst).toBe(8);

    // Advance to the next tick; a second burst should begin.
    vi.advanceTimersByTime(10000);
    expect(send.mock.calls.length).toBe(afterFirst + 1);
    runBurst();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("stops sending further probes when isConnected flips false mid-burst", () => {
    mgr.startAndSchedule();
    expect(sentT1()).toHaveLength(1);

    // Answer the first probe, but the socket drops before the next probe goes out.
    const t1 = lastT1();
    connected = false;
    respond(t1, t1 + 1000, nowMs * 1000 + 500);

    // sendNextTimeSyncBurstProbe guards on isConnected, so no second probe.
    expect(sentT1()).toHaveLength(1);
    expect(update).not.toHaveBeenCalled();
  });

  it("sends client/time with only type and client_transmitted (spec shape)", () => {
    mgr.startAndSchedule();
    const msg = send.mock.calls[0][0];
    expect(msg.type).toBe("client/time");
    expect(Object.keys(msg.payload)).toEqual(["client_transmitted"]);
    expect(typeof msg.payload.client_transmitted).toBe("number");
    // client_transmitted is in microseconds: now=1ms -> 1000us.
    expect(msg.payload.client_transmitted).toBe(1000);
  });
});
