import { describe, it, expect } from "vitest";
import { harness, completeHandshakeWithPsk } from "./transport-harness";

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
  selected_pair_method?: string;
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
  it("rejects a first activate that omits active_roles", () => {
    const h = harness();
    const lt = new Uint8Array(32).fill(21);
    const { serverSession } = completeHandshakeWithPsk(h, lt, /*bound*/ true);
    h.transport.handleRaw({
      data: activate(serverSession, { activities: ["playback"] }),
    } as MessageEvent);
    expect(h.ws.disconnected).toBe(true);
  });

  it("re-validates persisted active_roles when a later activate omits them", () => {
    const h = harness();
    const lt = new Uint8Array(32).fill(22);
    const { serverSession } = completeHandshakeWithPsk(h, lt, /*bound*/ true);
    // First activate: playback-capable with roles -> accepted.
    h.transport.handleRaw({
      data: activate(serverSession, {
        activities: ["playback"],
        active_roles: ["player@v1"],
      }),
    } as MessageEvent);
    expect(h.ws.disconnected).toBe(false);
    // Later activate omits active_roles, so the persisted ["player@v1"] stays
    // effective. ['pairing'] is not playback-capable for a long-term PSK, so a
    // non-empty effective role set must be rejected as unauthorized.
    h.transport.handleRaw({
      data: activate(serverSession, { activities: ["pairing"] }),
    } as MessageEvent);
    expect(h.ws.disconnected).toBe(true);
  });

  it("accepts a later activate that omits active_roles when still playback-capable", () => {
    const h = harness();
    const lt = new Uint8Array(32).fill(23);
    const { serverSession } = completeHandshakeWithPsk(h, lt, /*bound*/ true);
    h.transport.handleRaw({
      data: activate(serverSession, {
        activities: ["playback"],
        active_roles: ["player@v1"],
      }),
    } as MessageEvent);
    // ['management'] is still playback-capable for a long-term PSK, so persisting
    // the roles is fine.
    h.transport.handleRaw({
      data: activate(serverSession, { activities: ["management"] }),
    } as MessageEvent);
    expect(h.ws.disconnected).toBe(false);
  });
});
