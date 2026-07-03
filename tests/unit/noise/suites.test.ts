import { describe, it, expect } from "vitest";
import { SUITES } from "../../../src/core/noise/suites";

describe.each(["chacha", "aesgcm"] as const)("suite %s", (id) => {
  const s = SUITES[id];

  it("AEAD round-trips", () => {
    const key = new Uint8Array(32).fill(7);
    const ad = new Uint8Array([1, 2, 3]);
    const pt = new TextEncoder().encode("hello sendspin");
    const ct = s.aeadEncrypt(key, 0n, ad, pt);
    expect(Array.from(s.aeadDecrypt(key, 0n, ad, ct))).toEqual(Array.from(pt));
  });

  it("rejects a tampered ciphertext", () => {
    const key = new Uint8Array(32).fill(9);
    const ct = s.aeadEncrypt(key, 5n, new Uint8Array(), new Uint8Array([1]));
    ct[0] ^= 0xff;
    expect(() => s.aeadDecrypt(key, 5n, new Uint8Array(), ct)).toThrow();
  });

  it("x25519 agrees in both directions", () => {
    const a = s.generateKeypair();
    const b = s.generateKeypair();
    expect(Array.from(s.dh(a.privateKey, b.publicKey))).toEqual(
      Array.from(s.dh(b.privateKey, a.publicKey)),
    );
  });
});
