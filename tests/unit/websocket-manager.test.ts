/**
 * Unit tests for WebSocketManager focusing on the auto-reconnect lifecycle
 * and the adopt() error paths. A fake WebSocket stands in for the browser
 * global so connection state can be driven deterministically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocketManager } from "../../src/core/websocket-manager";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;

  constructor(public url?: string) {
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  // Test helpers
  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  fireClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

describe("WebSocketManager", () => {
  let mgr: WebSocketManager;
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    // @ts-expect-error fake stands in for the browser global
    globalThis.WebSocket = FakeWebSocket;
    mgr = new WebSocketManager();
  });

  afterEach(() => {
    mgr.disconnect();
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  describe("auto-reconnect", () => {
    it("reconnects 5s after an unexpected close", async () => {
      const p = mgr.connect("ws://host/sendspin");
      FakeWebSocket.instances[0].fireOpen();
      await p;
      expect(FakeWebSocket.instances).toHaveLength(1);

      FakeWebSocket.instances[0].fireClose();
      expect(FakeWebSocket.instances).toHaveLength(1);

      vi.advanceTimersByTime(5000);
      expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it("does not reconnect after an explicit disconnect", async () => {
      const p = mgr.connect("ws://host/sendspin");
      FakeWebSocket.instances[0].fireOpen();
      await p;

      FakeWebSocket.instances[0].fireClose();
      mgr.disconnect();

      vi.advanceTimersByTime(5000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it("does not reconnect an adopted socket on close", async () => {
      const ws = new FakeWebSocket();
      ws.readyState = FakeWebSocket.OPEN;
      // @ts-expect-error fake WebSocket is API-compatible here
      await mgr.adopt(ws);

      ws.fireClose();
      vi.advanceTimersByTime(5000);
      // Only the adopted socket exists — no reconnect attempt.
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
  });

  describe("adopt", () => {
    it("throws synchronously for a closed socket", () => {
      const ws = new FakeWebSocket();
      ws.readyState = FakeWebSocket.CLOSED;
      // @ts-expect-error fake WebSocket is API-compatible here
      expect(() => mgr.adopt(ws)).toThrow(/Cannot adopt/);
    });

    it("rejects if a connecting socket closes before opening", async () => {
      const ws = new FakeWebSocket();
      ws.readyState = FakeWebSocket.CONNECTING;
      // @ts-expect-error fake WebSocket is API-compatible here
      const p = mgr.adopt(ws);
      ws.fireClose();
      await expect(p).rejects.toThrow(/closed before opening/);
    });
  });
});
