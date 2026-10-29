/**
 * Unit tests for ProtocolHandler message routing and command handling.
 *
 * Uses a real StateManager (pure) with a stubbed MessageSender, StreamHandler
 * and time filter so message dispatch, the output-delay guard, and the
 * stream/clear roles filter can be asserted directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ProtocolHandler,
  type HelloContext,
  type MessageSender,
} from "../../src/core/protocol-handler";
import { StateManager } from "../../src/core/state-manager";
import { SendspinTimeFilter } from "../../src/core/time-filter";
import type { StreamHandler } from "../../src/internal-types";

function makeHelloContext(overrides: Partial<HelloContext> = {}): HelloContext {
  return {
    pairMethods: () => ({ pairing_psk: {} }),
    unpairedAccess: true,
    ...overrides,
  };
}

function makeStreamHandler(): StreamHandler &
  Record<string, ReturnType<typeof vi.fn>> {
  return {
    handleBinaryMessage: vi.fn(),
    handleStreamStart: vi.fn(),
    handleStreamClear: vi.fn(),
    handleStreamEnd: vi.fn(),
    handleVolumeUpdate: vi.fn(),
    handleSyncDelayChange: vi.fn(),
    getSyncDelayMs: vi.fn(() => 0),
  } as StreamHandler & Record<string, ReturnType<typeof vi.fn>>;
}

const PCM_STREAM = {
  codec: "pcm",
  sample_rate: 48000,
  channels: 2,
  bit_depth: 16,
};

// Dispatch a parsed server message through the real entry point.
const dispatch = (handler: ProtocolHandler, msg: unknown): void =>
  handler.handleServerMessage(msg as never, 0);

function makeStreamHandlerWithDelay(
  syncDelayMs = 0,
): StreamHandler & Record<string, ReturnType<typeof vi.fn>> {
  return {
    handleBinaryMessage: vi.fn(),
    handleStreamStart: vi.fn(),
    handleStreamClear: vi.fn(),
    handleStreamEnd: vi.fn(),
    handleVolumeUpdate: vi.fn(),
    handleSyncDelayChange: vi.fn(),
    getSyncDelayMs: vi.fn(() => syncDelayMs),
  } as StreamHandler & Record<string, ReturnType<typeof vi.fn>>;
}

// Find the last sent message of a given type.
function lastSent(
  send: ReturnType<typeof vi.fn>,
  type: string,
): Record<string, unknown> | undefined {
  for (let i = send.mock.calls.length - 1; i >= 0; i--) {
    const m = send.mock.calls[i][0];
    if (m && m.type === type) return m;
  }
  return undefined;
}

describe("ProtocolHandler", () => {
  let send: ReturnType<typeof vi.fn>;
  let streamHandler: ReturnType<typeof makeStreamHandler>;
  let stateManager: StateManager;
  let onDelayCommand: ReturnType<typeof vi.fn>;
  let handler: ProtocolHandler;

  beforeEach(() => {
    vi.useFakeTimers();
    send = vi.fn();
    streamHandler = makeStreamHandler();
    stateManager = new StateManager();
    onDelayCommand = vi.fn();
    const sender: MessageSender = { sendControl: send };
    const timeFilter = { update: vi.fn() } as unknown as SendspinTimeFilter;

    handler = new ProtocolHandler(
      sender,
      makeHelloContext(),
      streamHandler,
      stateManager,
      timeFilter,
      { onDelayCommand },
    );
  });

  afterEach(() => {
    stateManager.clearAllIntervals();
    vi.useRealTimers();
  });

  describe("handleServerMessage routing", () => {
    it("ignores a JSON message with an unknown type", () => {
      dispatch(handler, { type: "server/bogus" });
      expect(streamHandler.handleBinaryMessage).not.toHaveBeenCalled();
      expect(streamHandler.handleStreamStart).not.toHaveBeenCalled();
    });
  });

  describe("stream/start without a player object", () => {
    it("starts no player stream, so the next player stream/start is not a format update", () => {
      dispatch(handler, {
        type: "stream/start",
        payload: { server_transmitted: 0 },
      });
      expect(streamHandler.handleStreamStart).not.toHaveBeenCalled();
      expect(stateManager.isPlaying).toBe(false);

      dispatch(handler, {
        type: "stream/start",
        payload: { server_transmitted: 0, player: PCM_STREAM },
      });
      expect(streamHandler.handleStreamStart).toHaveBeenCalledWith(
        PCM_STREAM,
        false,
      );
    });
  });

  describe("stream/clear roles filter", () => {
    it("forwards a clear with no roles to the stream handler", () => {
      dispatch(handler, { type: "stream/clear", payload: {} });
      expect(streamHandler.handleStreamClear).toHaveBeenCalledTimes(1);
    });

    it("ignores a clear whose roles exclude the player", () => {
      dispatch(handler, {
        type: "stream/clear",
        payload: { roles: ["controller"] },
      });
      expect(streamHandler.handleStreamClear).not.toHaveBeenCalled();
    });
  });

  describe("set_output_delay command", () => {
    const command = (output_delay_ms: unknown) => ({
      type: "server/command",
      payload: { player: { command: "set_output_delay", output_delay_ms } },
    });

    it("applies and clamps a valid delay", () => {
      dispatch(handler, command(9999));
      expect(streamHandler.handleSyncDelayChange).toHaveBeenCalledWith(5000);
      expect(onDelayCommand).toHaveBeenCalledWith(5000);
    });

    it("ignores a non-finite delay", () => {
      dispatch(handler, command("nope"));
      expect(streamHandler.handleSyncDelayChange).not.toHaveBeenCalled();
      expect(onDelayCommand).not.toHaveBeenCalled();
    });
  });
});

describe("ProtocolHandler extra", () => {
  let send: ReturnType<typeof vi.fn>;
  let streamHandler: ReturnType<typeof makeStreamHandler>;
  let stateManager: StateManager;
  let onDelayCommand: ReturnType<typeof vi.fn>;
  let onVolumeCommand: ReturnType<typeof vi.fn>;
  let sender: MessageSender;
  let helloContext: HelloContext;
  let timeFilter: SendspinTimeFilter;

  function makeHandler(
    config: ConstructorParameters<typeof ProtocolHandler>[5] = {},
  ): ProtocolHandler {
    return new ProtocolHandler(
      sender,
      helloContext,
      streamHandler,
      stateManager,
      timeFilter,
      { onDelayCommand, ...config },
    );
  }

  // Dispatch a server/activate so client/state + time-sync start (the tests
  // below that pre-date server/activate sequencing rely on this).
  const activate = (handler: ProtocolHandler): void =>
    dispatch(handler, {
      type: "server/activate",
      payload: {
        activities: ["playback"],
        active_roles: ["player@v1"],
      },
    });

  beforeEach(() => {
    vi.useFakeTimers();
    send = vi.fn();
    streamHandler = makeStreamHandler();
    stateManager = new StateManager();
    onDelayCommand = vi.fn();
    onVolumeCommand = vi.fn();
    sender = { sendControl: send };
    helloContext = makeHelloContext();
    timeFilter = { update: vi.fn() } as unknown as SendspinTimeFilter;
  });

  afterEach(() => {
    stateManager.clearAllIntervals();
    vi.useRealTimers();
  });

  describe("server/state metadata timing", () => {
    beforeEach(() => {
      vi.spyOn(performance, "now").mockReturnValue(1000);
      timeFilter = new SendspinTimeFilter(0, 1.1, 2.0, 1e-12);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("defers metadata until its timestamp, translated by the time filter", () => {
      // Server clock runs 5 s ahead, so server time 7 s is local time 2 s,
      // 1 s after the mocked local now of 1 s.
      timeFilter.update(5_000_000, 500, 900_000);
      const handler = makeHandler();

      dispatch(handler, {
        type: "server/state",
        payload: { metadata: { timestamp: 7_000_000, title: "Next" } },
      });
      vi.advanceTimersByTime(999);
      expect(stateManager.serverState.metadata).toBeUndefined();

      vi.advanceTimersByTime(1);
      expect(stateManager.serverState.metadata?.title).toBe("Next");
    });

    it("applies metadata at once before the first time sync measurement", () => {
      const handler = makeHandler();

      dispatch(handler, {
        type: "server/state",
        payload: { metadata: { timestamp: 7_000_000_000, title: "Current" } },
      });

      expect(stateManager.serverState.metadata?.title).toBe("Current");
    });
  });

  describe("sendClientHello", () => {
    it("sends a spec-shaped client/hello with envelope and player@v1_support", () => {
      const handler = makeHandler({
        clientName: "Living Room",
        codecs: ["pcm"],
      });
      handler.sendClientHello();

      const hello = lastSent(send, "client/hello")!;
      const payload = hello.payload as Record<string, unknown>;
      expect(payload.name).toBe("Living Room");
      expect(payload.supported_roles).toContain("player@v1");
      expect(payload.supported_pair_methods).toEqual({ pairing_psk: {} });

      const support = payload["player@v1_support"] as Record<string, unknown>;
      expect(support).not.toHaveProperty("supported_commands");
      expect(support.buffer_capacity).toBeTypeOf("number");
      const fmt = (
        support.supported_formats as Array<Record<string, unknown>>
      )[0];
      expect(fmt).toMatchObject({
        codec: expect.any(String),
        channels: expect.any(Number),
        sample_rate: expect.any(Number),
        bit_depth: expect.any(Number),
      });
    });

    it("advertises a buffer capacity covering the stream-ahead depth", () => {
      const handler = makeHandler({ codecs: ["pcm"] });
      handler.sendClientHello();

      const support = (
        lastSent(send, "client/hello")!.payload as Record<string, unknown>
      )["player@v1_support"] as Record<string, unknown>;
      // 30s of 48kHz/16-bit stereo PCM, the worst case among the pcm formats.
      expect(support.buffer_capacity as number).toBeGreaterThanOrEqual(
        48000 * 2 * 2 * 30,
      );
    });

    it("uses an explicit buffer capacity rounded to an integer", () => {
      const handler = makeHandler({
        codecs: ["pcm"],
        bufferCapacity: 123_455.6,
      });
      handler.sendClientHello();

      const support = (
        lastSent(send, "client/hello")!.payload as Record<string, unknown>
      )["player@v1_support"] as Record<string, unknown>;
      expect(support.buffer_capacity).toBe(123_456);
    });
  });

  describe("handleServerHello", () => {
    it("sends client/hello with unpaired_access and no trust_level", () => {
      const handler = makeHandler();
      dispatch(handler, { type: "server/hello", payload: {} });
      const hello = lastSent(send, "client/hello")!;
      const payload = hello.payload as Record<string, unknown>;
      expect(payload).not.toHaveProperty("trust_level");
      expect(payload.unpaired_access).toEqual({ enabled: true });
    });

    it("advertises the configured device info, omitting fields that are unset", () => {
      const dflt = makeHandler();
      dispatch(dflt, { type: "server/hello", payload: {} });
      let info = (lastSent(send, "client/hello")!.payload as never)[
        "device_info"
      ] as Record<string, unknown>;
      expect(info).toEqual({});

      const named = makeHandler({
        productName: "My App",
        manufacturer: "My Company",
        softwareVersion: "1.2.0",
      });
      dispatch(named, { type: "server/hello", payload: {} });
      info = (lastSent(send, "client/hello")!.payload as never)[
        "device_info"
      ] as Record<string, unknown>;
      expect(info).toEqual({
        product_name: "My App",
        manufacturer: "My Company",
        software_version: "1.2.0",
      });
    });

    it("does not send the initial client/state (deferred to server/activate)", () => {
      const handler = makeHandler();
      dispatch(handler, { type: "server/hello", payload: {} });
      expect(lastSent(send, "client/state")).toBeUndefined();
    });
  });

  describe("handleServerActivate", () => {
    it("sends an initial client/state immediately", () => {
      const handler = makeHandler();
      activate(handler);
      expect(lastSent(send, "client/state")).toBeDefined();
    });

    it("starts a periodic client/state interval (5s)", () => {
      const handler = makeHandler();
      activate(handler);
      send.mockClear();
      stateManager.volume = 42;
      vi.advanceTimersByTime(5000);
      expect(lastSent(send, "client/state")).toBeDefined();
    });

    it("is a no-op on a repeat activate", () => {
      const handler = makeHandler();
      activate(handler);
      send.mockClear();
      activate(handler);
      expect(lastSent(send, "client/state")).toBeUndefined();
    });

    it("sends the full player state when player@v1 is re-added", () => {
      const handler = makeHandler();
      activate(handler);
      dispatch(handler, {
        type: "server/activate",
        payload: { active_roles: [] },
      });
      send.mockClear();

      activate(handler);

      const state = lastSent(send, "client/state")!;
      expect((state.payload as Record<string, unknown>).player).toEqual({
        volume: 100,
        muted: false,
        output_delay_ms: 0,
        required_lead_time_ms: 250,
        min_buffer_ms: 250,
        supported_commands: ["volume", "mute", "set_output_delay"],
      });
    });

    it("ends the player stream when player@v1 is removed", () => {
      const handler = makeHandler();
      activate(handler);
      dispatch(handler, {
        type: "stream/start",
        payload: {
          player: {
            codec: "pcm",
            sample_rate: 48000,
            channels: 2,
            bit_depth: 16,
          },
        },
      });

      dispatch(handler, {
        type: "server/activate",
        payload: { activities: ["playback"], active_roles: [] },
      });

      expect(streamHandler.handleStreamEnd).toHaveBeenCalledTimes(1);
      expect(stateManager.currentStreamFormat).toBeNull();
      expect(stateManager.isPlaying).toBe(false);
    });

    it("starts a new stream on a new connection instead of updating the old one", () => {
      const handler = makeHandler();
      const streamStart = {
        type: "stream/start",
        payload: { player: PCM_STREAM },
      };
      activate(handler);
      dispatch(handler, streamStart);

      handler.resetActivation();
      activate(handler);

      expect(streamHandler.handleStreamEnd).toHaveBeenCalledTimes(1);
      expect(stateManager.isPlaying).toBe(false);
      dispatch(handler, streamStart);
      expect(streamHandler.handleStreamStart).toHaveBeenLastCalledWith(
        PCM_STREAM,
        false,
      );
    });

    it("keeps the player stream across a re-handshake", () => {
      const handler = makeHandler();
      activate(handler);
      dispatch(handler, {
        type: "stream/start",
        payload: { player: PCM_STREAM },
      });

      handler.resetActivation(true);
      activate(handler);

      expect(streamHandler.handleStreamEnd).not.toHaveBeenCalled();
      expect(stateManager.isPlaying).toBe(true);
    });

    it("discards the state of removed roles, including a scheduled metadata update", () => {
      const onStateChange = vi.fn();
      stateManager = new StateManager(onStateChange);
      const handler = makeHandler();
      dispatch(handler, {
        type: "server/activate",
        payload: {
          activities: ["playback"],
          active_roles: ["metadata@v1", "controller@v1"],
        },
      });
      stateManager.updateServerState({
        controller: {
          supported_commands: ["play"],
          volume: 50,
          muted: false,
          repeat: "off",
          shuffle: false,
        },
        metadata: { timestamp: 0 },
      });
      stateManager.updateServerState({ metadata: { timestamp: 1 } }, 1000);

      dispatch(handler, {
        type: "server/activate",
        payload: { activities: ["playback"], active_roles: ["controller@v1"] },
      });

      expect(Object.keys(stateManager.serverState)).toEqual(["controller"]);
      expect(Object.keys(onStateChange.mock.lastCall![0].serverState)).toEqual([
        "controller",
      ]);
      vi.advanceTimersByTime(1000);
      expect(Object.keys(stateManager.serverState)).toEqual(["controller"]);
    });

    it("resumes client/state and time sync under the kept roles after a refused activation", () => {
      const handler = makeHandler();
      activate(handler);
      handler.resetActivation(true);
      send.mockClear();
      handler.resumeActivation();
      expect(lastSent(send, "client/state")!.payload).toHaveProperty("player");
      expect(lastSent(send, "client/time")).toBeDefined();
    });

    it("re-sends the initial client/state on activate after resetActivation", () => {
      const handler = makeHandler();
      activate(handler);
      send.mockClear();
      handler.resetActivation();
      activate(handler);
      expect(lastSent(send, "client/state")).toBeDefined();
    });
  });

  describe("sendStateUpdate message shape (spec client/state player object)", () => {
    it("sends nothing before the first server/activate", () => {
      const handler = makeHandler();
      handler.sendStateUpdate();
      handler.setMinBufferMs(100);
      expect(lastSent(send, "client/state")).toBeUndefined();
    });

    it("omits player state while the role is inactive", () => {
      const handler = makeHandler();
      dispatch(handler, {
        type: "server/activate",
        payload: { activities: [], active_roles: [] },
      });

      const state = lastSent(send, "client/state")!;
      expect((state.payload as Record<string, unknown>).player).toBeUndefined();
    });

    it("reports available once the first time sync burst completes", () => {
      timeFilter = new SendspinTimeFilter();
      const handler = makeHandler();
      activate(handler);
      const available = () =>
        (lastSent(send, "client/state")!.payload as Record<string, unknown>)
          .available;
      expect(available()).toBe(false);

      for (let i = 0; i < 8; i++) {
        const t1 = (
          lastSent(send, "client/time")!.payload as Record<string, number>
        ).client_transmitted;
        handler.handleServerMessage(
          {
            type: "server/time",
            payload: {
              client_transmitted: t1,
              server_received: t1 + 100,
              server_transmitted: t1 + 200,
            },
          } as never,
          t1 + 300,
        );
      }

      expect(available()).toBe(true);
    });

    it("reports unavailable before time sync without the player role", () => {
      timeFilter = new SendspinTimeFilter();
      const handler = makeHandler();
      dispatch(handler, {
        type: "server/activate",
        payload: { activities: [], active_roles: ["controller@v1"] },
      });

      const state = lastSent(send, "client/state")!;
      expect((state.payload as Record<string, unknown>).available).toBe(false);
    });

    it("includes output_delay_ms clamped to 0-5000", () => {
      streamHandler = makeStreamHandlerWithDelay(9999);
      const handler = makeHandler();
      activate(handler);

      const player = (
        lastSent(send, "client/state")!.payload as Record<string, unknown>
      ).player as Record<string, unknown>;
      expect(player.output_delay_ms).toBe(5000);
    });

    it("rounds required_lead_time_ms and min_buffer_ms to integers", () => {
      const handler = makeHandler({
        requiredLeadTimeMs: 150.4,
        minBufferMs: 80.5,
      });
      activate(handler);
      let player = (
        lastSent(send, "client/state")!.payload as Record<string, unknown>
      ).player as Record<string, unknown>;
      expect(player.required_lead_time_ms).toBe(150);
      expect(player.min_buffer_ms).toBe(81);

      handler.setRequiredLeadTimeMs(200.7);
      player = (
        lastSent(send, "client/state")!.payload as Record<string, unknown>
      ).player as Record<string, unknown>;
      expect(player.required_lead_time_ms).toBe(201);

      handler.setMinBufferMs(99.2);
      player = (
        lastSent(send, "client/state")!.payload as Record<string, unknown>
      ).player as Record<string, unknown>;
      expect(player.min_buffer_ms).toBe(99);
    });

    describe("hardware volume", () => {
      it("reads external volume when useHardwareVolume and no skipHardwareRead", () => {
        const getExternalVolume = vi.fn(() => ({ volume: 30, muted: true }));
        const handler = makeHandler({
          useHardwareVolume: true,
          getExternalVolume,
        });
        // stateManager would say 100/false; hardware says 30/true.
        activate(handler);

        const player = (
          lastSent(send, "client/state")!.payload as Record<string, unknown>
        ).player as Record<string, unknown>;
        expect(getExternalVolume).toHaveBeenCalled();
        expect(player.volume).toBe(30);
        expect(player.muted).toBe(true);
      });

      it("rounds the external volume to an integer", () => {
        const handler = makeHandler({
          useHardwareVolume: true,
          getExternalVolume: () => ({ volume: 30.6, muted: false }),
        });
        activate(handler);

        const player = (
          lastSent(send, "client/state")!.payload as Record<string, unknown>
        ).player as Record<string, unknown>;
        expect(player.volume).toBe(31);
      });

      it("reports the stored volume when the external volume is NaN", () => {
        const handler = makeHandler({
          useHardwareVolume: true,
          getExternalVolume: () => ({ volume: NaN, muted: true }),
        });
        stateManager.volume = 64;
        activate(handler);

        const player = (
          lastSent(send, "client/state")!.payload as Record<string, unknown>
        ).player as Record<string, unknown>;
        expect(player.volume).toBe(64);
        expect(player.muted).toBe(true);
      });

      it("skips the hardware read and uses stateManager values when skipHardwareRead", () => {
        const getExternalVolume = vi.fn(() => ({ volume: 30, muted: true }));
        const handler = makeHandler({
          useHardwareVolume: true,
          getExternalVolume,
        });
        activate(handler);
        stateManager.volume = 77;
        getExternalVolume.mockClear();
        send.mockClear();

        handler.sendStateUpdate(true);

        const player = (
          lastSent(send, "client/state")!.payload as Record<string, unknown>
        ).player as Record<string, unknown>;
        expect(getExternalVolume).not.toHaveBeenCalled();
        expect(player.volume).toBe(77);
        expect(player.muted).toBe(false);
      });
    });
  });

  describe("full client/state (spec: complete role object, sent on change)", () => {
    it("sends every player field after a change to one field", () => {
      const handler = makeHandler();
      activate(handler);
      send.mockClear();

      stateManager.volume = 42;
      handler.sendStateUpdate();

      const player = (
        lastSent(send, "client/state")!.payload as Record<string, unknown>
      ).player;
      expect(player).toEqual({
        volume: 42,
        muted: false,
        output_delay_ms: 0,
        required_lead_time_ms: 250,
        min_buffer_ms: 250,
        supported_commands: ["volume", "mute", "set_output_delay"],
      });
    });

    it("sends nothing when the state is unchanged", () => {
      const handler = makeHandler();
      activate(handler);
      send.mockClear();

      handler.sendStateUpdate();
      vi.advanceTimersByTime(5000);

      expect(lastSent(send, "client/state")).toBeUndefined();
    });
  });

  describe("handleServerCommand volume / mute (spec server/command player object)", () => {
    const cmd = (player: Record<string, unknown>) => ({
      type: "server/command",
      payload: { player },
    });

    it("applies a volume command to state and notifies the stream handler", () => {
      const handler = makeHandler();
      dispatch(handler, cmd({ command: "volume", volume: 25 }));
      expect(stateManager.volume).toBe(25);
      expect(streamHandler.handleVolumeUpdate).toHaveBeenCalled();
    });

    it("calls onVolumeCommand with (volume, muted) when useHardwareVolume", () => {
      const handler = makeHandler({ useHardwareVolume: true, onVolumeCommand });
      dispatch(handler, cmd({ command: "volume", volume: 60 }));
      expect(onVolumeCommand).toHaveBeenCalledWith(60, false);
    });

    it("does not call onVolumeCommand when useHardwareVolume is false", () => {
      const handler = makeHandler({
        useHardwareVolume: false,
        onVolumeCommand,
      });
      dispatch(handler, cmd({ command: "volume", volume: 60 }));
      expect(onVolumeCommand).not.toHaveBeenCalled();
    });

    it("sends a follow-up client/state reflecting the commanded volume", () => {
      const handler = makeHandler();
      activate(handler);
      send.mockClear();
      dispatch(handler, cmd({ command: "volume", volume: 33 }));
      const player = (
        lastSent(send, "client/state")!.payload as Record<string, unknown>
      ).player as Record<string, unknown>;
      expect(player.volume).toBe(33);
    });

    it("ignores a set_static_delay command without sending state", () => {
      const handler = makeHandler({
        useHardwareVolume: true,
        getExternalVolume: () => ({ volume: 30, muted: false }),
      });
      activate(handler);
      send.mockClear();
      dispatch(
        handler,
        cmd({ command: "set_static_delay", static_delay_ms: 100 }),
      );
      expect(streamHandler.handleSyncDelayChange).not.toHaveBeenCalled();
      expect(lastSent(send, "client/state")).toBeUndefined();
    });

    it("ignores a server/command with no player object", () => {
      const handler = makeHandler();
      send.mockClear();
      dispatch(handler, { type: "server/command", payload: {} });
      expect(streamHandler.handleVolumeUpdate).not.toHaveBeenCalled();
      expect(lastSent(send, "client/state")).toBeUndefined();
    });
  });

  describe("stream/end roles filter", () => {
    const end = (payload: Record<string, unknown>) => ({
      type: "stream/end",
      payload,
    });

    it("ends the stream when roles is omitted", () => {
      const handler = makeHandler();
      dispatch(handler, end({}));
      expect(streamHandler.handleStreamEnd).toHaveBeenCalledTimes(1);
      expect(stateManager.isPlaying).toBe(false);
    });

    it("ignores a stream/end whose roles exclude player", () => {
      const handler = makeHandler();
      dispatch(handler, end({ roles: ["artwork"] }));
      expect(streamHandler.handleStreamEnd).not.toHaveBeenCalled();
    });
  });

  describe("sendGoodbye", () => {
    it("sends client/goodbye with the given reason", () => {
      const handler = makeHandler();
      handler.sendGoodbye("user_request");
      const bye = lastSent(send, "client/goodbye")!;
      expect((bye.payload as Record<string, unknown>).reason).toBe(
        "user_request",
      );
    });
  });

  describe("sendLeave", () => {
    it("sends client/leave with an empty payload only after server/activate", () => {
      const handler = makeHandler();
      handler.sendLeave();
      expect(lastSent(send, "client/leave")).toBeUndefined();

      activate(handler);
      handler.sendLeave();
      expect(lastSent(send, "client/leave")).toEqual({
        type: "client/leave",
        payload: {},
      });
    });
  });

  describe("sendCommand", () => {
    it("suppresses commands until the controller role is active", () => {
      const handler = makeHandler();
      dispatch(handler, {
        type: "server/activate",
        payload: { activities: [], active_roles: [] },
      });
      send.mockClear();
      handler.sendCommand("play", undefined as never);
      expect(lastSent(send, "client/command")).toBeUndefined();

      dispatch(handler, {
        type: "server/activate",
        payload: {
          activities: ["playback"],
          active_roles: ["controller@v1"],
        },
      });
      send.mockClear();
      handler.sendCommand("play", undefined as never);
      expect(lastSent(send, "client/command")).toBeDefined();
    });

    it("wraps a parameterless controller command", () => {
      const handler = makeHandler();
      dispatch(handler, {
        type: "server/activate",
        payload: {
          activities: ["playback"],
          active_roles: ["controller@v1"],
        },
      });
      handler.sendCommand("play", undefined as never);
      const cmd = lastSent(send, "client/command")!;
      const controller = (cmd.payload as Record<string, unknown>)
        .controller as Record<string, unknown>;
      expect(controller.command).toBe("play");
    });

    it("merges volume params into the controller command", () => {
      const handler = makeHandler();
      dispatch(handler, {
        type: "server/activate",
        payload: {
          activities: ["playback"],
          active_roles: ["controller@v1"],
        },
      });
      handler.sendCommand("volume", { volume: 55 });
      const controller = (
        lastSent(send, "client/command")!.payload as Record<string, unknown>
      ).controller as Record<string, unknown>;
      expect(controller.command).toBe("volume");
      expect(controller.volume).toBe(55);
    });

    it("rounds the controller volume", () => {
      const handler = makeHandler();
      dispatch(handler, {
        type: "server/activate",
        payload: {
          activities: ["playback"],
          active_roles: ["controller@v1"],
        },
      });
      handler.sendCommand("volume", { volume: 55.5 });
      const controller = (
        lastSent(send, "client/command")!.payload as Record<string, unknown>
      ).controller as Record<string, unknown>;
      expect(controller.volume).toBe(56);
    });

    it("sends seek positions and offsets as whole milliseconds", () => {
      const handler = makeHandler();
      dispatch(handler, {
        type: "server/activate",
        payload: {
          activities: ["playback"],
          active_roles: ["controller@v1"],
        },
      });
      const sentController = () =>
        (lastSent(send, "client/command")!.payload as Record<string, unknown>)
          .controller;

      handler.sendCommand("seek", { position_ms: 1234.6 });
      expect(sentController()).toEqual({ command: "seek", position_ms: 1235 });

      handler.sendCommand("seek_relative", { offset_ms: -10_000.4 });
      expect(sentController()).toEqual({
        command: "seek_relative",
        offset_ms: -10_000,
      });
    });

    it("clamps seek positions to 0 through seek_max_ms", () => {
      const handler = makeHandler();
      dispatch(handler, {
        type: "server/activate",
        payload: {
          activities: ["playback"],
          active_roles: ["controller@v1"],
        },
      });
      dispatch(handler, {
        type: "server/state",
        payload: {
          controller: {
            supported_commands: ["seek"],
            volume: 50,
            muted: false,
            repeat: "off",
            shuffle: false,
            seek_max_ms: 180_000,
          },
        },
      });
      const sentPosition = () =>
        (
          (lastSent(send, "client/command")!.payload as Record<string, unknown>)
            .controller as Record<string, unknown>
        ).position_ms;

      handler.sendCommand("seek", { position_ms: 200_000 });
      expect(sentPosition()).toBe(180_000);

      handler.sendCommand("seek", { position_ms: -500 });
      expect(sentPosition()).toBe(0);
    });
  });
});
