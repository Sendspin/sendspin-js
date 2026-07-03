import { describe, it, expect } from "vitest";
import { harness, completeHandshakeWithPsk } from "./transport-harness";
import { pskId } from "../../src/core/noise/constants";

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
    const { serverSession } = completeHandshakeWithPsk(
      h,
      lt,
      /*serverId bound*/ true,
    );
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

  it("keeps a shared-PSK record but still closes", () => {
    const h = harness();
    const lt = new Uint8Array(32).fill(12);
    const { serverSession } = completeHandshakeWithPsk(
      h,
      lt,
      /*serverId bound*/ false,
    );
    const frame = concat(
      Uint8Array.of(0),
      utf8.encode(JSON.stringify({ type: "server/unpair", payload: {} })),
    );
    h.transport.handleRaw({
      data: serverSession.encrypt(frame).buffer,
    } as MessageEvent);
    expect(h.store.lookup(pskId(lt))).not.toBeNull();
    expect(h.ws.disconnected).toBe(true);
  });
});
