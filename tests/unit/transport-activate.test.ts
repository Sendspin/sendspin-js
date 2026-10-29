import { describe, it, expect } from "vitest";
import {
  harness,
  completeHandshake,
  completeHandshakeWithPsk,
} from "./transport-harness";

const utf8 = new TextEncoder();
const concat = (a: Uint8Array, b: Uint8Array) => {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
};

type ActivatePayload = {
  activities: string[];
  active_roles?: string[];
  pairing?: { method: string };
};

function activate(
  serverSession: { encrypt(b: Uint8Array): Uint8Array },
  payload: ActivatePayload,
): ArrayBuffer {
  const frame = concat(
    Uint8Array.of(0),
    utf8.encode(JSON.stringify({ type: "server/activate", payload })),
  );
  return serverSession.encrypt(frame).buffer as ArrayBuffer;
}

describe("transport server/activate active_roles", () => {
  it("treats a first activate without active_roles as carrying empty roles", () => {
    const h = harness();
    const lt = new Uint8Array(32).fill(21);
    const { serverSession } = completeHandshakeWithPsk(h, lt);
    h.transport.handleRaw({
      data: activate(serverSession, { activities: ["playback"] }),
    } as MessageEvent);
    expect(h.ws.disconnected).toBe(false);
    expect(h.cb.onControlMessage).toHaveBeenLastCalledWith(
      {
        type: "server/activate",
        payload: { activities: ["playback"], active_roles: [] },
      },
      expect.any(Number),
    );
  });

  it("forwards the persisted active_roles when a later activate omits them", () => {
    const h = harness();
    const lt = new Uint8Array(32).fill(23);
    const { serverSession } = completeHandshakeWithPsk(h, lt);
    h.transport.handleRaw({
      data: activate(serverSession, {
        activities: ["playback"],
        active_roles: ["player@v1"],
      }),
    } as MessageEvent);
    h.transport.handleRaw({
      data: activate(serverSession, { activities: [] }),
    } as MessageEvent);
    expect(h.ws.disconnected).toBe(false);
    expect(h.cb.onControlMessage).toHaveBeenLastCalledWith(
      {
        type: "server/activate",
        payload: { activities: [], active_roles: ["player@v1"] },
      },
      expect.any(Number),
    );
  });

  it("closes without any message on a pairing activation missing its method", () => {
    const h = harness();
    const { serverSession } = completeHandshake(h);
    const before = h.ws.sentBinary.length;
    h.transport.handleRaw({
      data: activate(serverSession, { activities: ["pairing"] }),
    } as MessageEvent);
    expect(h.ws.disconnected).toBe(true);
    expect(h.ws.sentBinary.length).toBe(before);
  });
});
