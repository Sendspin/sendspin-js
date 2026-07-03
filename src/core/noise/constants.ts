import { sha256 } from "@noble/hashes/sha256";
import { base64urlEncode } from "./base64url";

const enc = new TextEncoder();

/** SHA-256("sendspin-sentinel-psk-v1"). */
export const SENTINEL_PSK: Uint8Array = sha256(
  enc.encode("sendspin-sentinel-psk-v1"),
);

const PSK_ID_LABEL = enc.encode("sendspin-psk-id-v1");

/** psk_id = base64url(SHA-256("sendspin-psk-id-v1" || PSK)). */
export function pskId(psk: Uint8Array): string {
  const buf = new Uint8Array(PSK_ID_LABEL.length + psk.length);
  buf.set(PSK_ID_LABEL, 0);
  buf.set(psk, PSK_ID_LABEL.length);
  return base64urlEncode(sha256(buf));
}

export const SENTINEL_PSK_ID = pskId(SENTINEL_PSK);
