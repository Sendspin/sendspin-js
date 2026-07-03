import type { CipherSuite } from "./suites";

const EMPTY = new Uint8Array(0);

export class CipherState {
  private k: Uint8Array | null = null;
  private n = 0n;

  constructor(private suite: CipherSuite) {}

  initializeKey(key: Uint8Array | null): void {
    this.k = key;
    this.n = 0n;
  }

  hasKey(): boolean {
    return this.k !== null;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.k === null) return plaintext;
    const ct = this.suite.aeadEncrypt(this.k, this.n, ad, plaintext);
    this.n += 1n;
    return ct;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.k === null) return ciphertext;
    const pt = this.suite.aeadDecrypt(this.k, this.n, ad, ciphertext);
    this.n += 1n;
    return pt;
  }
}

export { EMPTY };
