import { describe, it, expect } from "vitest";
import { SUITES } from "../../../src/core/noise/suites";
import { HandshakeState, MSG1, MSG2 } from "../../../src/core/noise/handshake";
import { NoiseSession } from "../../../src/core/noise/session";

function keypair(id: "chacha" | "aesgcm") {
  return SUITES[id].generateKeypair();
}

describe.each(["chacha", "aesgcm"] as const)("KKpsk2 %s", (id) => {
  const suite = SUITES[id];
  const prologue = new TextEncoder().encode("client/initserver/init");
  const psk = new Uint8Array(32).fill(42);
  const pskIdBytes = new TextEncoder().encode('{"psk_id":"x"}'); // eslint-disable-line quotes

  function run(initPsk: Uint8Array, respPsk: Uint8Array) {
    const server = keypair(id); // initiator
    const client = keypair(id); // responder
    const ini = new HandshakeState({
      suite,
      role: "initiator",
      prologue,
      s: server,
      rs: client.publicKey,
      psk: initPsk,
    });
    const res = new HandshakeState({
      suite,
      role: "responder",
      prologue,
      s: client,
      rs: server.publicKey,
    });

    const m1 = ini.writeMessage(MSG1, pskIdBytes);
    const p1 = res.readMessage(MSG1, m1); // static-DH only, PSK not yet mixed
    res.setPsk(respPsk);
    const m2 = res.writeMessage(MSG2, new Uint8Array(0));
    ini.readMessage(MSG2, m2);
    return { ini, res, p1 };
  }

  it("completes and derives matching transport keys", () => {
    const { ini, res, p1 } = run(psk, psk);
    expect(Array.from(p1)).toEqual(Array.from(pskIdBytes));
    const s = new NoiseSession("initiator", ini.split());
    const c = new NoiseSession("responder", res.split());
    const ct = s.encrypt(new TextEncoder().encode("hi"));
    expect(new TextDecoder().decode(c.decrypt(ct))).toBe("hi");
    const back = c.encrypt(new TextEncoder().encode("yo"));
    expect(new TextDecoder().decode(s.decrypt(back))).toBe("yo");
  });

  it("fails message 2 under a mismatched PSK", () => {
    expect(() => run(psk, new Uint8Array(32).fill(1))).toThrow();
  });

  it("binds the prologue", () => {
    const server = keypair(id);
    const client = keypair(id);
    const ini = new HandshakeState({
      suite,
      role: "initiator",
      prologue,
      s: server,
      rs: client.publicKey,
      psk,
    });
    const res = new HandshakeState({
      suite,
      role: "responder",
      prologue: new TextEncoder().encode("tampered"),
      s: client,
      rs: server.publicKey,
    });
    const m1 = ini.writeMessage(MSG1, pskIdBytes);
    expect(() => res.readMessage(MSG1, m1)).toThrow();
  });
});
