import type { CipherState } from "./cipher-state";
import type { Role } from "./handshake";

const EMPTY = new Uint8Array(0);

export class NoiseSession {
  private sendCs: CipherState;
  private recvCs: CipherState;

  constructor(role: Role, split: [CipherState, CipherState]) {
    const [c1, c2] = split;
    // c1: initiator->responder, c2: responder->initiator.
    if (role === "initiator") {
      this.sendCs = c1;
      this.recvCs = c2;
    } else {
      this.sendCs = c2;
      this.recvCs = c1;
    }
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    return this.sendCs.encryptWithAd(EMPTY, plaintext);
  }

  decrypt(ciphertext: Uint8Array): Uint8Array {
    return this.recvCs.decryptWithAd(EMPTY, ciphertext);
  }
}
