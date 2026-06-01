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
