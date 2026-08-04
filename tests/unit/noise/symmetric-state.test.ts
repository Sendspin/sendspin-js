import { describe, it, expect } from "vitest";
import { SUITES } from "../../../src/core/noise/suites";
import { SymmetricState } from "../../../src/core/noise/symmetric-state";

describe("SymmetricState", () => {
  it("mirrors h and round-trips encryptAndHash across two states", () => {
    const a = new SymmetricState(SUITES.chacha);
    const b = new SymmetricState(SUITES.chacha);
    a.initialize("Noise_KKpsk2_25519_ChaChaPoly_SHA256");
    b.initialize("Noise_KKpsk2_25519_ChaChaPoly_SHA256");
    for (const s of [a, b]) {
      s.mixHash(new Uint8Array([1, 2, 3]));
      s.mixKey(new Uint8Array(32).fill(4));
      s.mixKeyAndHash(new Uint8Array(32).fill(5));
    }
    expect(Array.from(a.h)).toEqual(Array.from(b.h));
    const pt = new TextEncoder().encode("payload");
    const ct = a.encryptAndHash(pt);
    expect(Array.from(b.decryptAndHash(ct))).toEqual(Array.from(pt));
  });

  it("split yields transport keys that round-trip", () => {
    const a = new SymmetricState(SUITES.aesgcm);
    const b = new SymmetricState(SUITES.aesgcm);
    a.initialize("Noise_KKpsk2_25519_AESGCM_SHA256");
    b.initialize("Noise_KKpsk2_25519_AESGCM_SHA256");
    a.mixKey(new Uint8Array(32).fill(9));
    b.mixKey(new Uint8Array(32).fill(9));
    const [a1] = a.split();
    const [b1] = b.split();
    const msg = new Uint8Array([10, 20, 30]);
    const ct = a1.encryptWithAd(new Uint8Array(), msg);
    expect(Array.from(b1.decryptWithAd(new Uint8Array(), ct))).toEqual([
      10, 20, 30,
    ]);
  });
});
