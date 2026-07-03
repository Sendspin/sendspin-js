import { describe, it, expect } from "vitest";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import { SUITES, type SuiteId } from "../../../src/core/noise/suites";
import { HandshakeState, MSG1, MSG2 } from "../../../src/core/noise/handshake";
import { NoiseSession } from "../../../src/core/noise/session";
import vectors from "./kkpsk2-vectors.json";

interface Vector {
  protocol_name: string;
  init_prologue: string;
  init_psks: string[];
  init_static: string;
  init_ephemeral: string;
  init_remote_static: string;
  resp_static: string;
  resp_ephemeral: string;
  resp_remote_static: string;
  messages: { payload: string; ciphertext: string }[];
}

function suiteId(name: string): SuiteId {
  return name.includes("ChaChaPoly") ? "chacha" : "aesgcm";
}

function keypairFrom(privHex: string, id: SuiteId) {
  const privateKey = hexToBytes(privHex);
  return { privateKey, publicKey: SUITES[id].publicKey(privateKey) };
}

describe.each(vectors as Vector[])("known-answer $protocol_name", (v) => {
  const id = suiteId(v.protocol_name);
  const suite = SUITES[id];

  it("produces byte-exact handshake messages", () => {
    const ini = new HandshakeState({
      suite,
      role: "initiator",
      prologue: hexToBytes(v.init_prologue),
      s: keypairFrom(v.init_static, id),
      rs: hexToBytes(v.init_remote_static),
      psk: hexToBytes(v.init_psks[0]),
      fixedEphemeral: keypairFrom(v.init_ephemeral, id),
    });
    const res = new HandshakeState({
      suite,
      role: "responder",
      prologue: hexToBytes(v.init_prologue),
      s: keypairFrom(v.resp_static, id),
      rs: hexToBytes(v.resp_remote_static),
      psk: hexToBytes(v.init_psks[0]),
      fixedEphemeral: keypairFrom(v.resp_ephemeral, id),
    });

    const m1 = ini.writeMessage(MSG1, hexToBytes(v.messages[0].payload));
    expect(bytesToHex(m1)).toBe(v.messages[0].ciphertext);
    expect(bytesToHex(res.readMessage(MSG1, m1))).toBe(v.messages[0].payload);

    const m2 = res.writeMessage(MSG2, hexToBytes(v.messages[1].payload));
    expect(bytesToHex(m2)).toBe(v.messages[1].ciphertext);
    expect(bytesToHex(ini.readMessage(MSG2, m2))).toBe(v.messages[1].payload);

    // First transport message (initiator -> responder) under split() keys.
    const s = new NoiseSession("initiator", ini.split());
    const c = new NoiseSession("responder", res.split());
    const ct = s.encrypt(hexToBytes(v.messages[2].payload));
    expect(bytesToHex(ct)).toBe(v.messages[2].ciphertext);
    expect(bytesToHex(c.decrypt(ct))).toBe(v.messages[2].payload);
  });
});
