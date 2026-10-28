/**
 * Unit tests for SendspinCore behaviors that need no live connection:
 * the supported-command guard, the audio-before-format drop, and the
 * teardown paths (disconnect without a connection, resetPlaybackState).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SendspinCore } from "../../src/core/core";
import type { SendspinStorage, StreamFormat } from "../../src/types";

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

const STATIC_DELAY_KEY = "sendspin-static-delay-ms-v2";

const PCM_FORMAT: StreamFormat = {
  codec: "pcm",
  sample_rate: 48000,
  channels: 2,
  bit_depth: 16,
};

// Capture control messages by replacing the transport's sendControl (the
// ProtocolHandler's sender), bypassing the not-ready guard for offline tests.
function spySend(core: SendspinCore): ReturnType<typeof vi.fn> {
  const send = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (core as any).transport.sendControl = send;
  return send;
}

// Force the transport into transport mode so disconnect() sends a goodbye.
function markTransportReady(core: SendspinCore): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (core as any).transport.state = "transport";
}

function activateController(core: SendspinCore): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (core as any).routeControl({
    type: "server/activate",
    payload: {
      activities: ["playback"],
      active_roles: ["controller@v1"],
    },
  });
}

// Activate the player role so client/state sends, dropping the initial state.
function activatePlayer(
  core: SendspinCore,
  send: ReturnType<typeof vi.fn>,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (core as any).routeControl({
    type: "server/activate",
    payload: {
      activities: ["playback"],
      active_roles: ["player@v1"],
    },
  });
  send.mockClear();
}

function seedController(core: SendspinCore, commands: string[]): void {
  core._stateManager.updateServerState({
    controller: {
      supported_commands: commands,
      volume: 50,
      muted: false,
      repeat: "off",
      shuffle: false,
    },
  });
}

function seedMetadata(
  core: SendspinCore,
  timestampUs: number,
  progress: {
    track_progress: number;
    track_duration: number;
    playback_speed: number;
  },
): void {
  core._stateManager.updateServerState({
    metadata: { timestamp: timestampUs, progress },
  });
}

describe("SendspinCore (offline)", () => {
  let core: SendspinCore;

  beforeEach(() => {
    core = new SendspinCore({ baseUrl: "http://127.0.0.1:9" });
  });

  describe("sendCommand guard", () => {
    it("throws when the command is not in the server's supported list", () => {
      seedController(core, ["play"]);
      expect(() => core.sendCommand("pause", undefined)).toThrow(
        /not supported/,
      );
    });

    it("throws before the server reports its controller state", () => {
      expect(() => core.sendCommand("pause", undefined)).toThrow(
        /controller state/,
      );
    });

    it("throws once the transport closes, even with a previous controller state", () => {
      seedController(core, ["pause"]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (core as any).onTransportClose();
      expect(() => core.sendCommand("pause", undefined)).toThrow(
        /controller state/,
      );
    });

    it("throws on a NaN controller volume", () => {
      seedController(core, ["volume"]);
      expect(() => core.sendCommand("volume", { volume: NaN })).toThrow(
        RangeError,
      );
    });

    it("throws on a non-finite seek position or offset", () => {
      seedController(core, ["seek", "seek_relative"]);
      expect(() => core.sendCommand("seek", { position_ms: NaN })).toThrow(
        RangeError,
      );
      expect(() =>
        core.sendCommand("seek_relative", { offset_ms: Infinity }),
      ).toThrow(RangeError);
    });
  });

  describe("handleBinaryMessage", () => {
    afterEach(() => vi.restoreAllMocks());

    it("drops audio chunks that arrive before a stream format is set", () => {
      const onAudioData = vi.fn();
      core.onAudioData = onAudioData;

      const chunk = new Uint8Array(20);
      chunk[0] = 4;
      core.handleBinaryMessage(chunk.buffer);

      expect(onAudioData).not.toHaveBeenCalled();
    });

    it("ignores binary IDs other than audio chunks without an audio warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const artwork = new Uint8Array(20);
      artwork[0] = 8;

      core.handleBinaryMessage(artwork.buffer);

      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("teardown", () => {
    it("resetPlaybackState clears playback flags without disconnecting", () => {
      core._stateManager.isPlaying = true;
      core._stateManager.currentStreamFormat = PCM_FORMAT;

      core.resetPlaybackState();

      expect(core.isPlaying).toBe(false);
      expect(core.currentFormat).toBeNull();
    });

    it("disconnect resets state even when never connected", () => {
      core._stateManager.volume = 50;
      core._stateManager.muted = true;

      core.disconnect();

      expect(core.volume).toBe(100);
      expect(core.muted).toBe(false);
      expect(core.isPlaying).toBe(false);
      expect(core.isConnected).toBe(false);
    });

    it("a transport close reports the cached group state as cleared", () => {
      const onStateChange = vi.fn();
      const observed = new SendspinCore({
        baseUrl: "http://127.0.0.1:9",
        onStateChange,
      });
      observed._stateManager.updateGroupState({
        playback_state: "playing",
        group_id: "g1",
        group_name: "Kitchen",
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (observed as any).onTransportClose();

      expect(observed._stateManager.groupState).toEqual({});
      expect(onStateChange.mock.lastCall?.[0].groupState).toEqual({});
    });
  });
});

describe("SendspinCore.trackProgress", () => {
  let core: SendspinCore;
  let nowMs: number;

  beforeEach(() => {
    core = new SendspinCore({ baseUrl: "http://127.0.0.1:9" });
    nowMs = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when metadata exists but progress is absent", () => {
    core._stateManager.updateServerState({ metadata: { timestamp: 5 } });
    expect(core.trackProgress).toBeNull();
  });

  it("interpolates position from elapsed server time at normal speed", () => {
    // No time sync -> offset 0 -> serverTimeUs == client now in us.
    // now = 2000ms -> serverTimeUs = 2_000_000us. metadata timestamp = 1_000_000us.
    // elapsed = 1_000_000us = 1000ms. speed 1000 (=1.0x).
    // expected position = track_progress(500) + 1000ms = 1500ms.
    seedMetadata(core, 1_000_000, {
      track_progress: 500,
      track_duration: 10_000,
      playback_speed: 1000,
    });
    nowMs = 2000;

    const p = core.trackProgress!;
    expect(p.positionMs).toBeCloseTo(1500, 6);
    expect(p.durationMs).toBe(10_000);
    expect(p.playbackSpeed).toBe(1.0);
  });

  it("scales the elapsed term by playback_speed/1000 (1.5x)", () => {
    // elapsed 1000ms * 1.5 = 1500ms added to track_progress 500 = 2000ms.
    seedMetadata(core, 1_000_000, {
      track_progress: 500,
      track_duration: 10_000,
      playback_speed: 1500,
    });
    nowMs = 2000;

    const p = core.trackProgress!;
    expect(p.positionMs).toBeCloseTo(2000, 6);
    expect(p.playbackSpeed).toBe(1.5);
  });

  it("clamps position to track_duration when interpolation overshoots", () => {
    seedMetadata(core, 1_000_000, {
      track_progress: 9000,
      track_duration: 10_000,
      playback_speed: 1000,
    });
    nowMs = 5000; // elapsed 4000ms -> raw 13000ms, clamp to 10000.

    expect(core.trackProgress!.positionMs).toBe(10_000);
  });

  it("clamps position to 0 when interpolation goes negative", () => {
    // Server timestamp is in the future relative to now -> negative elapsed.
    seedMetadata(core, 5_000_000, {
      track_progress: 0,
      track_duration: 10_000,
      playback_speed: 1000,
    });
    nowMs = 1000; // serverTime 1_000_000us < timestamp 5_000_000us.

    expect(core.trackProgress!.positionMs).toBe(0);
  });

  it("does NOT clamp to track_duration for live/unknown streams (track_duration === 0)", () => {
    // Spec: when track_duration == 0, position is max(calculated, 0) only,
    // never min(position, 0). A live radio stream should keep counting up.
    seedMetadata(core, 1_000_000, {
      track_progress: 30_000,
      track_duration: 0,
      playback_speed: 1000,
    });
    nowMs = 6000; // elapsed 5000ms -> expected 35000ms.

    expect(core.trackProgress!.positionMs).toBeCloseTo(35_000, 6);
  });
});

describe("SendspinCore.getCurrentServerTimeUs", () => {
  afterEach(() => vi.restoreAllMocks());

  it("floors performance.now()*1000 and applies the filter offset", () => {
    const core = new SendspinCore({ baseUrl: "http://h" });
    // Seed a known offset on the real time filter via one measurement.
    // First measurement sets offset = measurement directly.
    core._timeFilter.update(7000, 500, 1_000_000);

    vi.spyOn(performance, "now").mockReturnValue(2000.9); // -> floor(2000900) us
    // computeServerTime = client + offset = 2_000_900 + 7000 = 2_007_900
    expect(core.getCurrentServerTimeUs()).toBe(2_007_900);
  });
});

describe("SendspinCore URL building", () => {
  let captured: string[];
  let OrigWS: typeof WebSocket;

  beforeEach(() => {
    captured = [];
    OrigWS = globalThis.WebSocket;
    class FakeWS {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      binaryType = "";
      onopen: (() => void) | null = null;
      onmessage: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(url: string) {
        captured.push(url);
        // Never fire open; connect() promise stays pending. We only need the URL.
      }
      close() {}
      send() {}
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    globalThis.WebSocket = FakeWS as any;
  });

  afterEach(() => {
    globalThis.WebSocket = OrigWS;
  });

  const urlFor = (baseUrl: string): string => {
    const core = new SendspinCore({ baseUrl });
    void core.connect(); // fire-and-forget; promise never resolves with FakeWS
    return captured[captured.length - 1];
  };

  it("maps http -> ws and appends /sendspin", () => {
    expect(urlFor("http://host:8927")).toBe("ws://host:8927/sendspin");
  });

  it("preserves a base path for reverse-proxy setups", () => {
    expect(urlFor("http://host/proxy/audio")).toBe(
      "ws://host/proxy/audio/sendspin",
    );
  });

  it("does not duplicate slashes when baseUrl has a trailing slash", () => {
    expect(urlFor("http://host/proxy/")).toBe("ws://host/proxy/sendspin");
  });
});

describe("SendspinCore command + state forwarding", () => {
  let core: SendspinCore;

  beforeEach(() => {
    core = new SendspinCore({ baseUrl: "http://h" });
  });

  afterEach(() => {
    core._stateManager.clearAllIntervals();
  });

  it("forwards a controller command with command name and params merged", () => {
    const send = spySend(core);
    activateController(core);
    seedController(core, ["volume"]);
    send.mockClear();
    core.sendCommand("volume", { volume: 42 });

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.type).toBe("client/command");
    expect(msg.payload.controller).toEqual({ command: "volume", volume: 42 });
    core.disconnect();
  });

  it("closes a bound pairing window when connect() replaces a live socket", async () => {
    core = new SendspinCore({
      baseUrl: "http://h",
      staticPairingCode: "12345678",
    });
    const send = spySend(core);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = core as any;
    internals.wsManager.connect = vi.fn().mockResolvedValue(undefined);
    internals.wsManager.isConnected = () => true;
    const activatePairing = () =>
      internals.routeControl({
        type: "server/activate",
        payload: {
          activities: ["pairing"],
          pairing: { method: "static_pairing_code" },
        },
      });
    core.openPairingWindow();
    activatePairing();
    expect(send.mock.lastCall?.[0].type).toBe("client/pair-init");

    await core.connect();
    activatePairing();
    expect(send.mock.lastCall?.[0].type).toBe("client/pair-pending");
    core.disconnect();
  });

  it("does not report a close when connect() replaces a live socket", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = core as any;
    internals.wsManager.connect = vi.fn().mockResolvedValue(undefined);
    internals.wsManager.isConnected = () => true;
    const onClose = vi.fn();
    core.onConnectionClose = onClose;

    await core.connect();
    expect(onClose).not.toHaveBeenCalled();
    core.disconnect();
  });

  it("keeps player state and controller commands during a pairing activation", () => {
    core = new SendspinCore({
      baseUrl: "http://h",
      staticPairingCode: "12345678",
    });
    const send = spySend(core);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (core as any).routeControl({
      type: "server/activate",
      payload: {
        activities: ["playback", "pairing"],
        active_roles: ["player@v1", "controller@v1"],
        pairing: { method: "static_pairing_code" },
      },
    });
    const state = send.mock.calls
      .map((call) => call[0])
      .find((msg) => msg.type === "client/state");
    expect(state.payload.player).toBeDefined();

    seedController(core, ["play"]);
    send.mockClear();
    core.sendCommand("play", undefined);
    expect(send.mock.calls[0][0].type).toBe("client/command");
    core.disconnect();
  });

  it("setVolume clamps in state manager and sends a client/state update", () => {
    const send = spySend(core);
    activatePlayer(core, send);
    core.setVolume(-10);

    expect(core.volume).toBe(0); // clamped 0-100
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].type).toBe("client/state");
    expect(send.mock.calls[0][0].payload.player.volume).toBe(0);
  });

  it("setMuted updates state and sends a client/state update", () => {
    const send = spySend(core);
    activatePlayer(core, send);
    core.setMuted(true);

    expect(core.muted).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].payload.player.muted).toBe(true);
  });

  it("setVolume throws on NaN without sending state", () => {
    const send = spySend(core);
    activatePlayer(core, send);
    core.setVolume(42);
    send.mockClear();

    expect(() => core.setVolume(NaN)).toThrow(RangeError);
    expect(core.volume).toBe(42);
    expect(send).not.toHaveBeenCalled();
  });

  it("setVolume invokes the onVolumeUpdate callback", () => {
    const cb = vi.fn();
    core.onVolumeUpdate = cb;
    spySend(core);
    core.setVolume(30);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("SendspinCore.setSyncDelay", () => {
  let core: SendspinCore;

  beforeEach(() => {
    core = new SendspinCore({ baseUrl: "http://h" });
  });

  afterEach(() => {
    core._stateManager.clearAllIntervals();
  });

  it("clamps the delay, updates getSyncDelayMs, fires callback, and sends state", () => {
    const cb = vi.fn();
    core.onSyncDelayChange = cb;
    const send = spySend(core);
    activatePlayer(core, send);

    core.setSyncDelay(99999); // clamp to 5000

    expect(core.getSyncDelayMs()).toBe(5000);
    expect(cb).toHaveBeenCalledWith(5000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].payload.player.output_delay_ms).toBe(5000);
  });

  it("seeds the initial sync delay from config (clamped)", () => {
    const c2 = new SendspinCore({
      baseUrl: "http://h",
      syncDelay: 8000,
    });
    expect(c2.getSyncDelayMs()).toBe(5000);
  });
});

describe("SendspinCore output delay persistence", () => {
  it("persists a server-commanded delay change to storage", () => {
    const storage = makeStorage();
    const core = new SendspinCore({
      baseUrl: "http://h",
      storage,
    });

    core.handleSyncDelayChange(123);

    expect(storage.data.get(STATIC_DELAY_KEY)).toBe("123");
  });

  it("persists and reports a server set_output_delay command", () => {
    const storage = makeStorage();
    const core = new SendspinCore({ baseUrl: "http://h", storage });
    const send = spySend(core);
    activatePlayer(core, send);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (core as any).routeControl({
      type: "server/command",
      payload: {
        player: { command: "set_output_delay", output_delay_ms: 9999 },
      },
    });

    expect(storage.data.get(STATIC_DELAY_KEY)).toBe("5000");
    expect(send.mock.calls.at(-1)![0].payload.player.output_delay_ms).toBe(
      5000,
    );
    core._stateManager.clearAllIntervals();
  });

  it("restores a persisted delay on a fresh core with the same storage", () => {
    const storage = makeStorage();
    storage.data.set(STATIC_DELAY_KEY, "321");

    const core = new SendspinCore({
      baseUrl: "http://h",
      storage,
    });

    expect(core.getSyncDelayMs()).toBe(321);
  });

  it("ignores a delay persisted under the pre-v2 key", () => {
    const storage = makeStorage();
    storage.data.set("sendspin-static-delay-ms", "321");

    const core = new SendspinCore({
      baseUrl: "http://h",
      storage,
    });

    expect(core.getSyncDelayMs()).toBe(0);
  });

  it("lets an explicit config.syncDelay override the persisted value", () => {
    const storage = makeStorage();
    storage.data.set(STATIC_DELAY_KEY, "321");

    const core = new SendspinCore({
      baseUrl: "http://h",
      syncDelay: 100,
      storage,
    });

    expect(core.getSyncDelayMs()).toBe(100);
  });

  it("does not throw or persist when storage is disabled", () => {
    const core = new SendspinCore({
      baseUrl: "http://h",
      storage: null,
    });

    expect(() => core.handleSyncDelayChange(123)).not.toThrow();
    expect(core.getSyncDelayMs()).toBe(123);
  });
});

describe("SendspinCore.disconnect ordering and idempotency", () => {
  it("resets the time filter on disconnect", () => {
    const core = new SendspinCore({ baseUrl: "http://h" });
    core._timeFilter.update(10000, 500, 1_000_000);
    expect(core._timeFilter.is_synchronized).toBe(true);

    core.disconnect();

    expect(core._timeFilter.is_synchronized).toBe(false);
    expect(core._timeFilter.offset).toBe(0);
  });

  it("does not send goodbye when never connected", () => {
    const core = new SendspinCore({ baseUrl: "http://h" });
    const send = spySend(core);
    core.disconnect("user_request");
    expect(send).not.toHaveBeenCalled();
  });

  it("defaults the goodbye reason to restart, but forwards an explicit reason", () => {
    const core = new SendspinCore({ baseUrl: "http://h" });
    const send = spySend(core);
    markTransportReady(core);

    core.disconnect();
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "client/goodbye",
        payload: { reason: "restart" },
      }),
    );

    markTransportReady(core);
    core.disconnect("shutdown");
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "client/goodbye",
        payload: { reason: "shutdown" },
      }),
    );
  });

  it("fires onConnectionClose only via the close handler, not on disconnect()", () => {
    const core = new SendspinCore({ baseUrl: "http://h" });
    const cb = vi.fn();
    core.onConnectionClose = cb;
    core.disconnect();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("SendspinCore identity fallbacks", () => {
  it("derives a 43-char base64url clientId and a clientName from it", () => {
    const core = new SendspinCore({ baseUrl: "http://h" });
    expect(core.clientId).toHaveLength(43);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = (core as any).config;
    expect(cfg.clientName).toBe(
      `Sendspin JS Client (${core.clientId.slice(0, 6)})`,
    );
  });
});
