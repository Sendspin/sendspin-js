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

import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { gcm } from "@noble/ciphers/aes";

describe("nonce endianness (interop)", () => {
  const key = new Uint8Array(32).fill(3);
  const pt = new Uint8Array([9, 9, 9]);
  const leNonce = new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  const beNonce = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);

  it("chacha uses a little-endian counter nonce", () => {
    const our = SUITES.chacha.aeadEncrypt(key, 1n, new Uint8Array(), pt);
    expect(Array.from(our)).toEqual(
      Array.from(chacha20poly1305(key, leNonce, new Uint8Array()).encrypt(pt)),
    );
    expect(Array.from(our)).not.toEqual(
      Array.from(chacha20poly1305(key, beNonce, new Uint8Array()).encrypt(pt)),
    );
  });

  it("aesgcm uses a big-endian counter nonce", () => {
    const our = SUITES.aesgcm.aeadEncrypt(key, 1n, new Uint8Array(), pt);
    expect(Array.from(our)).toEqual(
      Array.from(gcm(key, beNonce, new Uint8Array()).encrypt(pt)),
    );
    expect(Array.from(our)).not.toEqual(
      Array.from(gcm(key, leNonce, new Uint8Array()).encrypt(pt)),
    );
  });
});
