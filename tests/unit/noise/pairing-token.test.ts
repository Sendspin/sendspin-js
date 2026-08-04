import { describe, expect, it } from "vitest";
import { encodePairingToken } from "../../../src/core/noise/pairing-token";
import { base64urlEncode } from "../../../src/core/noise/base64url";

describe("pairing token", () => {
  it("matches the version 0 reference vector", () => {
    const clientKey = Uint8Array.from({ length: 32 }, (_, index) => index);
    const pairingPsk = Uint8Array.from(
      { length: 32 },
      (_, index) => 0xe0 + index,
    );

    expect(
      encodePairingToken(
        base64urlEncode(clientKey),
        base64urlEncode(pairingPsk),
      ),
    ).toBe(
      "SP:0AAAQEAYEAUDAOCAJBIFQYDIOB4IBCEQTCQKRMFYYDENBWHA5DYP6BYPC4PSOLZXH5DU6V97M5XXO74HR6LZ7J5PW674PT6X37T6757Y",
    );
  });
});
