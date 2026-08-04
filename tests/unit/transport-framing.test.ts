import { describe, it, expect } from "vitest";
import { harness, completeHandshake } from "./transport-harness";

const frame = (
  session: ReturnType<typeof completeHandshake>["serverSession"],
  pt: Uint8Array,
) => ({ data: session.encrypt(pt).buffer }) as MessageEvent;

describe("transport frame validation", () => {
  it("closes on an empty plaintext (no type byte)", () => {
    const h = harness();
    const { serverSession } = completeHandshake(h);
    h.transport.handleRaw(frame(serverSession, new Uint8Array(0)));
    expect(h.ws.disconnected).toBe(true);
  });

  it("closes on a ciphertext over the Noise transport cap", () => {
    const h = harness();
    const { serverSession } = completeHandshake(h);
    // Binary type byte so an unguarded path would deliver it, not throw; the
    // 65520-byte plaintext yields a 65536-byte ciphertext, one over the cap.
    const pt = new Uint8Array(65520);
    pt[0] = 4;
    h.transport.handleRaw(frame(serverSession, pt));
    expect(h.ws.disconnected).toBe(true);
    expect(h.cb.onBinaryMessage).not.toHaveBeenCalled();
  });

  it("closes on a fragment opener missing its orig_type byte", () => {
    const h = harness();
    const { serverSession } = completeHandshake(h);
    h.transport.handleRaw(frame(serverSession, Uint8Array.of(2)));
    expect(h.ws.disconnected).toBe(true);
  });

  it("delivers a valid empty fragmented payload exactly once", () => {
    const h = harness();
    const { serverSession } = completeHandshake(h);
    h.transport.handleRaw(frame(serverSession, Uint8Array.of(2, 4))); // opener, origType 4, no data
    h.transport.handleRaw(frame(serverSession, Uint8Array.of(3))); // closer, no data
    expect(h.ws.disconnected).toBe(false);
    expect(h.cb.onBinaryMessage).toHaveBeenCalledTimes(1);
    expect(Array.from(h.cb.onBinaryMessage.mock.calls[0][0])).toEqual([4]);
  });
});
