import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import type { CipherSuite } from "./suites";
import { CipherState, EMPTY } from "./cipher-state";

const HASHLEN = 32;

/** Noise HKDF: derive `num` 32-byte outputs from (chainingKey, ikm). */
function hkdf(ck: Uint8Array, ikm: Uint8Array, num: 2 | 3): Uint8Array[] {
  const tempKey = hmac(sha256, ck, ikm);
  const o1 = hmac(sha256, tempKey, Uint8Array.of(1));
  const o2 = hmac(sha256, tempKey, concat(o1, Uint8Array.of(2)));
  if (num === 2) return [o1, o2];
  const o3 = hmac(sha256, tempKey, concat(o2, Uint8Array.of(3)));
  return [o1, o2, o3];
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export class SymmetricState {
  ck!: Uint8Array;
  h!: Uint8Array;
  readonly cipher: CipherState;

  constructor(private suite: CipherSuite) {
    this.cipher = new CipherState(suite);
  }

  initialize(protocolName: string): void {
    const name = new TextEncoder().encode(protocolName);
    if (name.length <= HASHLEN) {
      const h = new Uint8Array(HASHLEN);
      h.set(name);
      this.h = h;
    } else {
      this.h = this.suite.hash(name);
    }
    this.ck = this.h;
    this.cipher.initializeKey(null);
  }

  mixHash(data: Uint8Array): void {
    this.h = this.suite.hash(concat(this.h, data));
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = hkdf(this.ck, ikm, 2);
    this.ck = ck;
    this.cipher.initializeKey(tempK.slice(0, 32));
  }

  mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, tempH, tempK] = hkdf(this.ck, ikm, 3);
    this.ck = ck;
    this.mixHash(tempH);
    this.cipher.initializeKey(tempK.slice(0, 32));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ct = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const pt = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  /** Returns [sender-facing, receiver-facing] transport CipherStates. */
  split(): [CipherState, CipherState] {
    const [tempK1, tempK2] = hkdf(this.ck, EMPTY, 2);
    const c1 = new CipherState(this.suite);
    const c2 = new CipherState(this.suite);
    c1.initializeKey(tempK1.slice(0, 32));
    c2.initializeKey(tempK2.slice(0, 32));
    return [c1, c2];
  }
}
