import type { SendspinStorage } from "../../types";
import { SUITES } from "./suites";
import { base64urlEncode, base64urlDecode } from "./base64url";

const SK_KEY = "sendspin:identity:sk";

export class Identity {
  readonly clientId: string;
  readonly persistent: boolean;

  private constructor(
    readonly privateKey: Uint8Array,
    readonly publicKey: Uint8Array,
    persistent: boolean,
  ) {
    this.clientId = base64urlEncode(publicKey);
    this.persistent = persistent;
  }

  get keypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
    return { privateKey: this.privateKey, publicKey: this.publicKey };
  }

  static loadOrCreate(storage: SendspinStorage | null): Identity {
    const kp = SUITES.chacha; // DH/curve is suite-independent (both 25519)
    if (storage) {
      const stored = storage.getItem(SK_KEY);
      if (stored) {
        const sk = base64urlDecode(stored);
        return new Identity(sk, kp.publicKey(sk), true);
      }
      const fresh = kp.generateKeypair();
      storage.setItem(SK_KEY, base64urlEncode(fresh.privateKey));
      return new Identity(fresh.privateKey, fresh.publicKey, true);
    }
    const fresh = kp.generateKeypair();
    return new Identity(fresh.privateKey, fresh.publicKey, false);
  }
}
