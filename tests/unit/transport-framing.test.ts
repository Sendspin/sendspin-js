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

  const json = (msg: object) =>
    Uint8Array.of(0, ...new TextEncoder().encode(JSON.stringify(msg)));

  it.each([
    ["a fragment missing its flags byte", [[1]]],
    ["a first fragment missing its orig_type byte", [[1, 0x02]]],
    ["a nonzero reserved flag bit", [[1, 0x07, 4]]],
    ["an orig_type of 1", [[1, 0x03, 1]]],
    ["a non-first fragment with none in flight", [[1, 0x01, 5]]],
    [
      "a first fragment while one is in flight",
      [
        [1, 0x02, 4, 1],
        [1, 0x03, 4, 2],
      ],
    ],
    [
      "a non-fragment message while a fragment is in flight",
      [[1, 0x02, 0, 1], json({ type: "server/hello", payload: {} })],
    ],
  ])("closes on %s", (_, frames) => {
    const h = harness();
    const { serverSession } = completeHandshake(h);
    for (const pt of frames) {
      h.transport.handleRaw(frame(serverSession, Uint8Array.from(pt)));
    }
    expect(h.ws.disconnected).toBe(true);
    expect(h.cb.onBinaryMessage).not.toHaveBeenCalled();
    expect(h.cb.onControlMessage).not.toHaveBeenCalled();
  });

  it("delivers a valid empty fragmented payload exactly once", () => {
    const h = harness();
    const { serverSession } = completeHandshake(h);
    // First and last in one fragment, orig_type 4, no data.
    h.transport.handleRaw(frame(serverSession, Uint8Array.of(1, 0x03, 4)));
    expect(h.ws.disconnected).toBe(false);
    expect(h.cb.onBinaryMessage).toHaveBeenCalledTimes(1);
    expect(Array.from(h.cb.onBinaryMessage.mock.calls[0][0])).toEqual([4]);
  });

  it("fragments an outbound message larger than one transport message", () => {
    const h = harness();
    const { serverSession } = completeHandshake(h);
    const msg = { type: "client/hello", payload: { name: "x".repeat(150000) } };
    h.transport.sendControl(msg);

    const frames = h.ws.sentBinary.map((ct) => {
      expect(ct.length).toBeLessThanOrEqual(65535);
      return serverSession.decrypt(ct);
    });
    expect(frames.map((f) => [f[0], f[1]])).toEqual([
      [1, 0x02],
      [1, 0x00],
      [1, 0x01],
    ]);
    expect(frames[0][2]).toBe(0);
    const data = frames.flatMap((f, i) => Array.from(f.subarray(i ? 2 : 3)));
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(data)))).toEqual(
      msg,
    );
  });
});
