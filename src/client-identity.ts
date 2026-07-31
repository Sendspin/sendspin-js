import type { SendspinStorage } from "./types";
import { Identity } from "./core/noise/identity";
import { PskStore } from "./core/noise/psk";
import { base64urlEncode } from "./core/noise/base64url";

export interface SendspinClientIdentity {
  /** The client's stable identity id (base64url X25519 public key). */
  clientId: string;
  /** The client's Pairing PSK (base64url), or null without storage. */
  pairingPsk: string | null;
}

/**
 * Read the persisted client identity, creating it if absent.
 *
 * Apps that key their own state on the client id need it before a player
 * exists. A SendspinPlayer built afterwards with the same storage adopts this
 * identity rather than minting another.
 */
export function loadSendspinClientIdentity(
  storage?: SendspinStorage | null,
): SendspinClientIdentity {
  let resolved: SendspinStorage | null = null;
  if (storage !== undefined) {
    resolved = storage;
  } else if (typeof localStorage !== "undefined") {
    resolved = localStorage;
  }
  const identity = Identity.loadOrCreate(resolved);
  return {
    clientId: identity.clientId,
    pairingPsk: resolved
      ? base64urlEncode(new PskStore(resolved).getOrCreatePairingPsk())
      : null,
  };
}
