import { x25519 } from "@noble/curves/ed25519";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { gcm } from "@noble/ciphers/aes";
import { sha256 } from "@noble/hashes/sha256";

export type SuiteId = "chacha" | "aesgcm";

export interface CipherSuite {
  /** The <cipher> segment as it appears in the Noise protocol name. */
  name: string;
  dhLen: 32;
  /** X25519 raw scalar mult. */
  dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array;
  generateKeypair(): { privateKey: Uint8Array; publicKey: Uint8Array };
  publicKey(privateKey: Uint8Array): Uint8Array;
  /** AEAD encrypt: 32-byte key, 64-bit counter n, associated data, plaintext. */
  aeadEncrypt(
    key: Uint8Array,
    n: bigint,
    ad: Uint8Array,
    plaintext: Uint8Array,
  ): Uint8Array;
  aeadDecrypt(
    key: Uint8Array,
    n: bigint,
    ad: Uint8Array,
    ciphertext: Uint8Array,
  ): Uint8Array;
  hash(data: Uint8Array): Uint8Array;
}

function nonceLE(n: bigint): Uint8Array {
  const nonce = new Uint8Array(12); // 4 zero bytes + 8-byte LE counter
  const dv = new DataView(nonce.buffer);
  dv.setBigUint64(4, n, true);
  return nonce;
}

function nonceBE(n: bigint): Uint8Array {
  const nonce = new Uint8Array(12); // 4 zero bytes + 8-byte BE counter
  const dv = new DataView(nonce.buffer);
  dv.setBigUint64(4, n, false);
  return nonce;
}

const dh = (priv: Uint8Array, pub: Uint8Array) =>
  x25519.getSharedSecret(priv, pub);
const publicKey = (priv: Uint8Array) => x25519.getPublicKey(priv);
const generateKeypair = () => {
  const privateKey = x25519.utils.randomSecretKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
};

export const SUITES: Record<SuiteId, CipherSuite> = {
  chacha: {
    name: "ChaChaPoly",
    dhLen: 32,
    dh,
    generateKeypair,
    publicKey,
    hash: sha256,
    aeadEncrypt: (k, n, ad, pt) =>
      chacha20poly1305(k, nonceLE(n), ad).encrypt(pt),
    aeadDecrypt: (k, n, ad, ct) =>
      chacha20poly1305(k, nonceLE(n), ad).decrypt(ct),
  },
  aesgcm: {
    name: "AESGCM",
    dhLen: 32,
    dh,
    generateKeypair,
    publicKey,
    hash: sha256,
    aeadEncrypt: (k, n, ad, pt) => gcm(k, nonceBE(n), ad).encrypt(pt),
    aeadDecrypt: (k, n, ad, ct) => gcm(k, nonceBE(n), ad).decrypt(ct),
  },
};

/** Maps the config suite id to the wire suite string in client/init. */
export const SUITE_WIRE_NAME: Record<SuiteId, string> = {
  chacha: "25519_ChaChaPoly_SHA256",
  aesgcm: "25519_AESGCM_SHA256",
};
