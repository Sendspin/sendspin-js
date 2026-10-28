import { base64urlDecode } from "./base64url";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const KEY_SIZE = 32;

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let encoded = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }

  if (bits > 0) {
    encoded += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return encoded;
}

function encodeToken(version: string, payload: Uint8Array): string {
  return `SP:${version}${encodeBase32(payload).replace(/2/g, "9")}`;
}

export function encodePairingToken(
  clientId: string,
  pairingPsk: Uint8Array,
): string {
  const clientKey = base64urlDecode(clientId);
  if (clientKey.length !== KEY_SIZE) {
    throw new Error(`clientId must decode to ${KEY_SIZE} bytes`);
  }
  if (pairingPsk.length !== KEY_SIZE) {
    throw new Error(`pairingPsk must be ${KEY_SIZE} bytes`);
  }

  const payload = new Uint8Array(clientKey.length + pairingPsk.length);
  payload.set(clientKey);
  payload.set(pairingPsk, clientKey.length);
  return encodeToken("0", payload);
}

/** The version 1 token carrying a dynamic pairing code in the qr_code format. */
export function encodeQrCodeToken(code: Uint8Array): string {
  return encodeToken("1", code);
}
