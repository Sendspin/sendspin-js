import type { SendspinStorage } from "../../types";
import { SUITES } from "./suites";
import { base64urlEncode, base64urlDecode } from "./base64url";

const SK_KEY = "sendspin-identity-sk";

export class Identity {
  readonly clientId: string;

  private constructor(
    readonly privateKey: Uint8Array,
    readonly publicKey: Uint8Array,
  ) {
    this.clientId = base64urlEncode(publicKey);
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
        return new Identity(sk, kp.publicKey(sk));
      }
      const fresh = kp.generateKeypair();
      storage.setItem(SK_KEY, base64urlEncode(fresh.privateKey));
      return new Identity(fresh.privateKey, fresh.publicKey);
    }
    // Without storage the keypair regenerates each session, so client_id is not
    // stable and pairing records cannot persist. Callers disable pairing here.
    console.warn(
      "Sendspin: no storage provided, using an ephemeral identity (client_id changes each session, pairing unavailable)",
    );
    const fresh = kp.generateKeypair();
    return new Identity(fresh.privateKey, fresh.publicKey);
  }
}
