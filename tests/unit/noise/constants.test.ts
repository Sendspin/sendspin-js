import { describe, it, expect } from "vitest";
import { bytesToHex } from "@noble/hashes/utils";
import { SENTINEL_PSK, SENTINEL_PSK_ID, pskId } from "../../../src/core/noise/constants";
import { base64urlEncode, base64urlDecode } from "../../../src/core/noise/base64url";

describe("noise constants", () => {
  it("Sentinel PSK matches the spec constant", () => {
    expect(bytesToHex(SENTINEL_PSK)).toBe(
      "1b5e24dbc1aed95fc2a5a338a90c05df44bd10f5ec1f4cd66cbf86272767b9d3",
    );
  });

  it("Sentinel psk_id matches the published base64url", () => {
    expect(SENTINEL_PSK_ID).toBe("GFsV9tLaSQm9HcFWpKsgYQOr7wFTvNUtkmFwuVz3zoo");
    expect(pskId(SENTINEL_PSK)).toBe(SENTINEL_PSK_ID);
  });

  it("base64url round-trips without padding", () => {
    const b = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const s = base64urlEncode(b);
    expect(s).not.toContain("=");
    expect(Array.from(base64urlDecode(s))).toEqual(Array.from(b));
  });
});
