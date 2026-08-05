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
    it("reconnects after the configured base delay on unexpected close", async () => {
      const p = mgr.connect("ws://host/sendspin");
      FakeWebSocket.instances[0].fireOpen();
      await p;
      expect(FakeWebSocket.instances).toHaveLength(1);

      FakeWebSocket.instances[0].fireClose();
      // No reconnect before the base delay elapses (default 1000ms).
      vi.advanceTimersByTime(999);
      expect(FakeWebSocket.instances).toHaveLength(1);

      vi.advanceTimersByTime(1);
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

class RichFakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: RichFakeWebSocket[] = [];

  readyState = RichFakeWebSocket.CONNECTING;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;

  sent: string[] = [];
  closeCalls = 0;

  constructor(public url?: string) {
    RichFakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls++;
    this.readyState = RichFakeWebSocket.CLOSED;
  }

  fireOpen(): void {
    this.readyState = RichFakeWebSocket.OPEN;
    this.onopen?.();
  }
  fireClose(): void {
    this.readyState = RichFakeWebSocket.CLOSED;
    this.onclose?.();
  }
  fireMessage(data: unknown): void {
    this.onmessage?.({ data } as unknown);
  }
  fireError(err: unknown): void {
    this.onerror?.(err);
  }
}

describe("WebSocketManager extra", () => {
  let mgr: WebSocketManager;
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    RichFakeWebSocket.instances = [];
    // @ts-expect-error fake stands in for the browser global
    globalThis.WebSocket = RichFakeWebSocket;
    mgr = new WebSocketManager();
  });

  afterEach(() => {
    mgr.disconnect();
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  describe("message / error handler wiring on connect()", () => {
    it("forwards incoming messages and errors to the supplied handlers", async () => {
      const onMessage = vi.fn();
      const onError = vi.fn();
      const onClose = vi.fn();
      const p = mgr.connect(
        "ws://host/sendspin",
        undefined,
        onMessage,
        onError,
        onClose,
      );
      const ws = RichFakeWebSocket.instances[0];
      ws.fireOpen();
      await p;

      ws.fireMessage("hello");
      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({ data: "hello" }),
      );

      ws.fireError(new Error("boom"));
      expect(onError).toHaveBeenCalled();
    });

    it("does not report a close for a socket that never opened", () => {
      const onClose = vi.fn();
      void mgr.connect(
        "ws://host/sendspin",
        undefined,
        undefined,
        undefined,
        onClose,
      );

      RichFakeWebSocket.instances[0].fireClose();

      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("disconnect", () => {
    it("closes the socket, clears it, and reports disconnected", async () => {
      const p = mgr.connect("ws://host/sendspin");
      const ws = RichFakeWebSocket.instances[0];
      ws.fireOpen();
      await p;

      mgr.disconnect();
      expect(ws.closeCalls).toBe(1);
      expect(mgr.isConnected()).toBe(false);
      expect(mgr.getReadyState()).toBe(RichFakeWebSocket.CLOSED);
    });

    it("cancels a pending reconnect timer scheduled by an earlier close", async () => {
      const p = mgr.connect("ws://host/sendspin");
      RichFakeWebSocket.instances[0].fireOpen();
      await p;

      // Unexpected close schedules a reconnect.
      RichFakeWebSocket.instances[0].fireClose();
      // Disconnect must cancel it so no new socket is created.
      mgr.disconnect();
      vi.advanceTimersByTime(60000);
      expect(RichFakeWebSocket.instances).toHaveLength(1);
    });
  });

  describe("adopt open path", () => {
    it("resolves immediately, fires onOpen, and wires message/error/close", async () => {
      const onOpen = vi.fn();
      const onMessage = vi.fn();
      const onError = vi.fn();
      const onClose = vi.fn();
      const ws = new RichFakeWebSocket();
      ws.readyState = RichFakeWebSocket.OPEN;

      await mgr.adopt(
        // @ts-expect-error fake WebSocket is API-compatible here
        ws,
        onOpen,
        onMessage,
        onError,
        onClose,
      );

      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(mgr.isConnected()).toBe(true);

      ws.fireMessage("x");
      expect(onMessage).toHaveBeenCalled();
      ws.fireClose();
      expect(onClose).toHaveBeenCalled();
    });

    it("resolves after a CONNECTING socket opens", async () => {
      const onOpen = vi.fn();
      const ws = new RichFakeWebSocket();
      ws.readyState = RichFakeWebSocket.CONNECTING;
      // @ts-expect-error fake WebSocket is API-compatible here
      const p = mgr.adopt(ws, onOpen);
      ws.fireOpen();
      await p;
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(mgr.isConnected()).toBe(true);
    });

    it("never schedules a reconnect for an adopted socket", async () => {
      const ws = new RichFakeWebSocket();
      ws.readyState = RichFakeWebSocket.OPEN;
      // @ts-expect-error fake WebSocket is API-compatible here
      await mgr.adopt(ws);

      ws.fireClose();
      vi.advanceTimersByTime(60000);
      // Only the adopted socket exists.
      expect(RichFakeWebSocket.instances).toHaveLength(1);
    });
  });
});
