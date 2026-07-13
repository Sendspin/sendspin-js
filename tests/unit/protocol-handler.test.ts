/**
 * Unit tests for ProtocolHandler message routing and command handling.
 *
 * Uses a real StateManager (pure) with mocked WebSocketManager, StreamHandler
 * and time filter so message dispatch, the static-delay guard, and the
 * stream/clear roles filter can be asserted directly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ProtocolHandler } from "../../src/core/protocol-handler";
import { StateManager } from "../../src/core/state-manager";
import type { WebSocketManager } from "../../src/core/websocket-manager";
import type { SendspinTimeFilter } from "../../src/core/time-filter";
import type { StreamHandler } from "../../src/internal-types";

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

const msgEvent = (data: unknown): MessageEvent => ({ data }) as MessageEvent;

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
    const wsManager = {
      send,
      isConnected: () => true,
    } as unknown as WebSocketManager;
    const timeFilter = { update: vi.fn() } as unknown as SendspinTimeFilter;

    handler = new ProtocolHandler(
      "player-1",
      wsManager,
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

  describe("handleMessage routing", () => {
    it("routes ArrayBuffer data to the binary handler", () => {
      const buf = new ArrayBuffer(8);
      handler.handleMessage(msgEvent(buf));
      expect(streamHandler.handleBinaryMessage).toHaveBeenCalledWith(buf);
    });

    it("routes Blob data to the binary handler", async () => {
      const blob = new Blob([new Uint8Array([1, 2, 3])]);
      handler.handleMessage(msgEvent(blob));
      await vi.waitFor(() =>
        expect(streamHandler.handleBinaryMessage).toHaveBeenCalled(),
      );
      const arg = streamHandler.handleBinaryMessage.mock.calls[0][0];
      expect(arg.byteLength).toBe(3);
    });

    it("ignores a JSON message with an unknown type", () => {
      handler.handleMessage(msgEvent(JSON.stringify({ type: "server/bogus" })));
      expect(streamHandler.handleBinaryMessage).not.toHaveBeenCalled();
      expect(streamHandler.handleStreamStart).not.toHaveBeenCalled();
    });

    it("throws on non-JSON string data (current behavior)", () => {
      expect(() => handler.handleMessage(msgEvent("not json"))).toThrow();
    });
  });

  describe("stream/clear roles filter", () => {
    it("forwards a clear with no roles to the stream handler", () => {
      handler.handleMessage(
        msgEvent(JSON.stringify({ type: "stream/clear", payload: {} })),
      );
      expect(streamHandler.handleStreamClear).toHaveBeenCalledTimes(1);
    });

    it("ignores a clear whose roles exclude the player", () => {
      handler.handleMessage(
        msgEvent(
          JSON.stringify({
            type: "stream/clear",
            payload: { roles: ["controller"] },
          }),
        ),
      );
      expect(streamHandler.handleStreamClear).not.toHaveBeenCalled();
    });
  });

  describe("set_static_delay command", () => {
    const command = (static_delay_ms: unknown) =>
      msgEvent(
        JSON.stringify({
          type: "server/command",
          payload: { player: { command: "set_static_delay", static_delay_ms } },
        }),
      );

    it("applies and clamps a valid delay", () => {
      handler.handleMessage(command(9999));
      expect(streamHandler.handleSyncDelayChange).toHaveBeenCalledWith(5000);
      expect(onDelayCommand).toHaveBeenCalledWith(5000);
    });

    it("ignores a non-finite delay", () => {
      handler.handleMessage(command("nope"));
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
  let wsManager: WebSocketManager;
  let timeFilter: SendspinTimeFilter;

  function makeHandler(
    config: ConstructorParameters<typeof ProtocolHandler>[5] = {},
  ): ProtocolHandler {
    return new ProtocolHandler(
      "player-1",
      wsManager,
      streamHandler,
      stateManager,
      timeFilter,
      { onDelayCommand, ...config },
    );
  }

  const serverHello = () =>
    msgEvent(JSON.stringify({ type: "server/hello", payload: {} }));

  function makeReadyHandler(
    config: ConstructorParameters<typeof ProtocolHandler>[5] = {},
  ): ProtocolHandler {
    const handler = makeHandler(config);
    handler.handleMessage(serverHello());
    send.mockClear();
    return handler;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    send = vi.fn();
    streamHandler = makeStreamHandler();
    stateManager = new StateManager();
    onDelayCommand = vi.fn();
    onVolumeCommand = vi.fn();
    wsManager = {
      send,
      isConnected: () => true,
    } as unknown as WebSocketManager;
    timeFilter = { update: vi.fn() } as unknown as SendspinTimeFilter;
  });

  afterEach(() => {
    stateManager.clearAllIntervals();
    vi.useRealTimers();
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
      expect(payload.client_id).toBe("player-1");
      expect(payload.name).toBe("Living Room");
      expect(payload.version).toBe(1);
      expect(payload.supported_roles).toContain("player@v1");

      const support = payload["player@v1_support"] as Record<string, unknown>;
      expect(support.supported_commands).toEqual(["volume", "mute"]);
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
  });

  describe("handleServerHello", () => {
    it("sends an initial client/state immediately", () => {
      const handler = makeHandler();
      handler.handleMessage(
        msgEvent(JSON.stringify({ type: "server/hello", payload: {} })),
      );
      expect(lastSent(send, "client/state")).toBeDefined();
    });

    it("starts a periodic client/state interval (5s)", () => {
      const handler = makeHandler();
      handler.handleMessage(
        msgEvent(JSON.stringify({ type: "server/hello", payload: {} })),
      );
      send.mockClear();
      vi.advanceTimersByTime(5000);
      expect(lastSent(send, "client/state")).toBeDefined();
    });
  });

  describe("sendStateUpdate message shape (spec client/state player object)", () => {
    it("reports volume in 0-100 and the player operational state", () => {
      const handler = makeHandler();
      stateManager.volume = 42;
      handler.handleMessage(serverHello());

      const state = lastSent(send, "client/state")!;
      const player = (state.payload as Record<string, unknown>)
        .player as Record<string, unknown>;
      expect(player.volume).toBe(42);
      expect(player.state).toBe("synchronized");
      expect(player.muted).toBe(false);
    });

    it("includes static_delay_ms clamped to 0-5000", () => {
      streamHandler = makeStreamHandlerWithDelay(9999);
      const handler = makeHandler();
      handler.handleMessage(serverHello());

      const player = (
        lastSent(send, "client/state")!.payload as Record<string, unknown>
      ).player as Record<string, unknown>;
      expect(player.static_delay_ms).toBe(5000);
    });

    it("declares set_static_delay in player supported_commands", () => {
      const handler = makeHandler();
      handler.handleMessage(serverHello());
      const player = (
        lastSent(send, "client/state")!.payload as Record<string, unknown>
      ).player as Record<string, unknown>;
      expect(player.supported_commands).toContain("set_static_delay");
    });

    it("includes required_lead_time_ms (spec: always required for players)", () => {
      const handler = makeHandler();
      handler.handleMessage(serverHello());
      const player = (
        lastSent(send, "client/state")!.payload as Record<string, unknown>
      ).player as Record<string, unknown>;
      expect(player.required_lead_time_ms).toBeTypeOf("number");
    });

    it("includes min_buffer_ms (spec: always required for players)", () => {
      const handler = makeHandler();
      handler.handleMessage(serverHello());
      const player = (
        lastSent(send, "client/state")!.payload as Record<string, unknown>
      ).player as Record<string, unknown>;
      expect(player.min_buffer_ms).toBeTypeOf("number");
    });

    describe("hardware volume", () => {
      it("reads external volume when useHardwareVolume and no skipHardwareRead", () => {
        const getExternalVolume = vi.fn(() => ({ volume: 30, muted: true }));
        const handler = makeHandler({
          useHardwareVolume: true,
          getExternalVolume,
        });
        handler.handleMessage(serverHello());

        const player = (
          lastSent(send, "client/state")!.payload as Record<string, unknown>
        ).player as Record<string, unknown>;
        expect(getExternalVolume).toHaveBeenCalled();
        expect(player.volume).toBe(30);
        expect(player.muted).toBe(true);
      });

      it("skips the hardware read and uses stateManager values when skipHardwareRead", () => {
        const getExternalVolume = vi.fn(() => ({ volume: 30, muted: true }));
        const handler = makeReadyHandler({
          useHardwareVolume: true,
          getExternalVolume,
        });
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

  describe("delta client/state (spec: full then changed-only)", () => {
    it("sends the full player payload on the first state after connect", () => {
      const handler = makeHandler();
      handler.sendClientHello();
      handler.handleMessage(serverHello());

      const player = (
        lastSent(send, "client/state")!.payload as Record<string, unknown>
      ).player as Record<string, unknown>;
      expect(player).toMatchObject({
        state: "synchronized",
        volume: expect.any(Number),
        muted: expect.any(Boolean),
        static_delay_ms: expect.any(Number),
        required_lead_time_ms: expect.any(Number),
        min_buffer_ms: expect.any(Number),
        supported_commands: ["set_static_delay"],
      });
    });

    it("sends the full player payload when state changes before server hello", () => {
      const handler = makeHandler();
      handler.sendClientHello();
      stateManager.volume = 42;
      handler.sendStateUpdate();
      send.mockClear();

      handler.handleMessage(serverHello());

      const player = (
        lastSent(send, "client/state")!.payload as Record<string, unknown>
      ).player as Record<string, unknown>;
      expect(player).toMatchObject({
        state: "synchronized",
        volume: 42,
        muted: expect.any(Boolean),
        static_delay_ms: expect.any(Number),
        required_lead_time_ms: expect.any(Number),
        min_buffer_ms: expect.any(Number),
        supported_commands: ["set_static_delay"],
      });
    });

    it("does not send client/state before server hello", () => {
      const handler = makeHandler();
      handler.sendClientHello();

      stateManager.volume = 42;
      handler.sendStateUpdate();

      expect(lastSent(send, "client/state")).toBeUndefined();
    });

    it("sends only the changed field on the next update", () => {
      const handler = makeHandler();
      handler.sendClientHello();
      handler.handleMessage(serverHello());
      send.mockClear();

      stateManager.volume = 42;
      handler.sendStateUpdate();

      const player = (
        lastSent(send, "client/state")!.payload as Record<string, unknown>
      ).player as Record<string, unknown>;
      expect(Object.keys(player)).toEqual(["volume"]);
      expect(player.volume).toBe(42);
    });

    it("resets to a full payload after a reconnect", () => {
      const handler = makeHandler();
      handler.sendClientHello();
      handler.handleMessage(serverHello());
      stateManager.volume = 42;
      handler.sendStateUpdate();
      send.mockClear();

      // Reconnect: a fresh server has no prior state to merge into.
      handler.sendClientHello();
      handler.sendStateUpdate();
      handler.handleMessage(serverHello());

      const player = (
        lastSent(send, "client/state")!.payload as Record<string, unknown>
      ).player as Record<string, unknown>;
      expect(player.supported_commands).toEqual(["set_static_delay"]);
      expect(player.required_lead_time_ms).toBeTypeOf("number");
      expect(player.min_buffer_ms).toBeTypeOf("number");
    });
  });

  describe("handleServerCommand volume / mute (spec server/command player object)", () => {
    const cmd = (player: Record<string, unknown>) =>
      msgEvent(JSON.stringify({ type: "server/command", payload: { player } }));

    it("applies a volume command to state and notifies the stream handler", () => {
      const handler = makeHandler();
      handler.handleMessage(cmd({ command: "volume", volume: 25 }));
      expect(stateManager.volume).toBe(25);
      expect(streamHandler.handleVolumeUpdate).toHaveBeenCalled();
    });

    it("calls onVolumeCommand with (volume, muted) when useHardwareVolume", () => {
      const handler = makeHandler({ useHardwareVolume: true, onVolumeCommand });
      handler.handleMessage(cmd({ command: "volume", volume: 60 }));
      expect(onVolumeCommand).toHaveBeenCalledWith(60, false);
    });

    it("does not call onVolumeCommand when useHardwareVolume is false", () => {
      const handler = makeHandler({
        useHardwareVolume: false,
        onVolumeCommand,
      });
      handler.handleMessage(cmd({ command: "volume", volume: 60 }));
      expect(onVolumeCommand).not.toHaveBeenCalled();
    });

    it("sends a follow-up client/state reflecting the commanded volume", () => {
      const handler = makeReadyHandler();
      handler.handleMessage(cmd({ command: "volume", volume: 33 }));
      const player = (
        lastSent(send, "client/state")!.payload as Record<string, unknown>
      ).player as Record<string, unknown>;
      expect(player.volume).toBe(33);
    });

    it("ignores a server/command with no player object", () => {
      const handler = makeHandler();
      send.mockClear();
      handler.handleMessage(
        msgEvent(JSON.stringify({ type: "server/command", payload: {} })),
      );
      expect(streamHandler.handleVolumeUpdate).not.toHaveBeenCalled();
      expect(lastSent(send, "client/state")).toBeUndefined();
    });
  });

  describe("stream/end roles filter", () => {
    const end = (payload: Record<string, unknown>) =>
      msgEvent(JSON.stringify({ type: "stream/end", payload }));

    it("ends the stream when roles is omitted", () => {
      const handler = makeHandler();
      handler.handleMessage(end({}));
      expect(streamHandler.handleStreamEnd).toHaveBeenCalledTimes(1);
      expect(stateManager.isPlaying).toBe(false);
    });

    it("ignores a stream/end whose roles exclude player", () => {
      const handler = makeHandler();
      handler.handleMessage(end({ roles: ["artwork"] }));
      expect(streamHandler.handleStreamEnd).not.toHaveBeenCalled();
    });

    it("sends a client/state after ending the player stream", () => {
      const handler = makeReadyHandler();
      handler.handleMessage(end({}));
      expect(lastSent(send, "client/state")).toBeDefined();
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

  describe("sendCommand", () => {
    it("wraps a parameterless controller command", () => {
      const handler = makeHandler();
      handler.sendCommand("play", undefined as never);
      const cmd = lastSent(send, "client/command")!;
      const controller = (cmd.payload as Record<string, unknown>)
        .controller as Record<string, unknown>;
      expect(controller.command).toBe("play");
    });

    it("merges volume params into the controller command", () => {
      const handler = makeHandler();
      handler.sendCommand("volume", { volume: 55 });
      const controller = (
        lastSent(send, "client/command")!.payload as Record<string, unknown>
      ).controller as Record<string, unknown>;
      expect(controller.command).toBe("volume");
      expect(controller.volume).toBe(55);
    });
  });
});
