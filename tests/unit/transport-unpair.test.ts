import { describe, it, expect } from "vitest";
import {
  harness,
  completeHandshake,
  completeHandshakeWithPsk,
  fakeWsSend,
} from "./transport-harness";
import { pskId, SENTINEL_PSK_ID } from "../../src/core/noise/constants";

const utf8 = new TextEncoder();
const concat = (a: Uint8Array, b: Uint8Array) => {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
};

describe("transport server/unpair", () => {
  it("removes a stored-pubkey record and closes", () => {
    const h = harness();
    const lt = new Uint8Array(32).fill(11);
    const { serverSession } = completeHandshakeWithPsk(h, lt);
    const frame = concat(
      Uint8Array.of(0),
      utf8.encode(JSON.stringify({ type: "server/unpair", payload: {} })),
    );
    h.transport.handleRaw({
      data: serverSession.encrypt(frame).buffer,
    } as MessageEvent);
    expect(h.store.lookup(pskId(lt))).toBeNull();
    expect(h.ws.disconnected).toBe(true);
  });

  it("ignores server/unpair on an untrusted (Sentinel) session", () => {
    const h = harness();
    const { serverSession } = completeHandshake(h);
    const before = fakeWsSend(h).binary.length;
    const frame = concat(
      Uint8Array.of(0),
      utf8.encode(JSON.stringify({ type: "server/unpair", payload: {} })),
    );
    h.transport.handleRaw({
      data: serverSession.encrypt(frame).buffer,
    } as MessageEvent);
    // Not a long-term PSK: ignored, no goodbye sent, socket stays open, sentinel intact.
    expect(h.ws.disconnected).toBe(false);
    expect(fakeWsSend(h).binary.length).toBe(before);
    expect(h.store.lookup(SENTINEL_PSK_ID)).not.toBeNull();
  });
});
