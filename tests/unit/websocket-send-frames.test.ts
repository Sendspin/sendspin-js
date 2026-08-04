import { describe, it, expect, vi } from "vitest";
import { WebSocketManager } from "../../src/core/websocket-manager";

function fakeOpenSocket() {
  const sent: Array<string | Uint8Array> = [];
  const ws = { readyState: 1, send: (d: string | Uint8Array) => sent.push(d) };
  return { ws, sent };
}

describe("WebSocketManager frame sends", () => {
  it("sends text and binary frames when open", () => {
    const { ws, sent } = fakeOpenSocket();
    const mgr = new WebSocketManager();
    // Inject the fake socket.
    (mgr as unknown as { ws: unknown }).ws = ws;
    mgr.sendText('{"type":"client/init"}'); // eslint-disable-line quotes
    mgr.sendBinary(new Uint8Array([1, 2, 3]));
    expect(sent[0]).toBe('{"type":"client/init"}'); // eslint-disable-line quotes
    expect(Array.from(sent[1] as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("warns and no-ops when closed", () => {
    const mgr = new WebSocketManager();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mgr.sendText("x");
    mgr.sendBinary(new Uint8Array([1]));
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
