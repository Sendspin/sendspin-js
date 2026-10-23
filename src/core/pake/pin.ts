// Dynamic-PIN derivation and commitment (Sendspin pairing spec).

import { sha256 } from "@noble/hashes/sha2";

const PAIRING_CODE_DERIVE_LABEL = new TextEncoder().encode(
  "sendspin-pairing-code-derive-v1",
);
const PAIR_COMMIT_LABEL = new TextEncoder().encode("sendspin-pair-commit-v1");
export const NONCE_SIZE = 32;
const DYNAMIC_CODE_DIGITS = 6;
export const STATIC_PIN_DIGITS = 8;

const STATIC_PIN_RE = new RegExp(`^[0-9]{${STATIC_PIN_DIGITS}}$`);

/** Whether pin is exactly 8 decimal digits, as the static-PIN method requires. */
export function isValidStaticPairingCode(pin: string): boolean {
  return STATIC_PIN_RE.test(pin);
}

/** Fresh 32-byte CSPRNG nonce (nonce_A or nonce_B). */
export function generateNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(NONCE_SIZE));
}

/** SHA-256("sendspin-pair-commit-v1" || nonce), the commitment commit_B to nonce_B. */
export function commitNonce(nonce: Uint8Array): Uint8Array {
  const input = new Uint8Array(PAIR_COMMIT_LABEL.length + nonce.length);
  input.set(PAIR_COMMIT_LABEL, 0);
  input.set(nonce, PAIR_COMMIT_LABEL.length);
  return sha256(input);
}

/** Derive the 6-digit dynamic pairing code from the handshake hash and both nonces. */
export function derivePairingCode(
  handshakeHash: Uint8Array,
  nonceA: Uint8Array,
  nonceB: Uint8Array,
): string {
  const input = new Uint8Array(
    PAIRING_CODE_DERIVE_LABEL.length +
      handshakeHash.length +
      nonceA.length +
      nonceB.length,
  );
  input.set(PAIRING_CODE_DERIVE_LABEL, 0);
  input.set(handshakeHash, PAIRING_CODE_DERIVE_LABEL.length);
  input.set(nonceA, PAIRING_CODE_DERIVE_LABEL.length + handshakeHash.length);
  input.set(
    nonceB,
    PAIRING_CODE_DERIVE_LABEL.length + handshakeHash.length + nonceA.length,
  );
  const digest = sha256(input);
  let n = 0n;
  for (const b of digest) n = (n << 8n) | BigInt(b);
  const code = n % 10n ** BigInt(DYNAMIC_CODE_DIGITS);
  return code.toString().padStart(DYNAMIC_CODE_DIGITS, "0");
}
