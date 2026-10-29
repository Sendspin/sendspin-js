import { describe, it, expect } from "vitest";
import { authorizeActivate } from "../../src/core/activate-authorization";
import type { PskCategory } from "../../src/core/noise/psk";
import type { PairCodeFormat, PairMethod } from "../../src/types";

const unauthorized = { ok: false, goodbye: "unauthorized" };
const pairingRequired = { ok: false, goodbye: "pairing_required" };
const methodNotSupported = {
  ok: false,
  pairAbort: "method_not_supported",
  activeRoles: [],
};
const offered = { pairing_psk: {}, static_pairing_code: {} };
const methodFor = (category: PskCategory) =>
  ({
    method: category === "pairing" ? "pairing_psk" : "static_pairing_code",
  }) as const;

describe("authorizeActivate", () => {
  it("long-term allows only [] and ['playback']", () => {
    expect(
      authorizeActivate("long_term", [], [], [], false, undefined, offered).ok,
    ).toBe(true);
    expect(
      authorizeActivate(
        "long_term",
        ["playback"],
        [],
        [],
        false,
        undefined,
        offered,
      ).ok,
    ).toBe(true);
    expect(
      authorizeActivate(
        "long_term",
        ["pairing"],
        [],
        [],
        true,
        methodFor("long_term"),
        offered,
      ),
    ).toEqual(unauthorized);
    expect(
      authorizeActivate(
        "long_term",
        ["playback", "pairing"],
        [],
        [],
        true,
        methodFor("long_term"),
        offered,
      ),
    ).toEqual(unauthorized);
  });

  for (const category of ["pairing", "sentinel"] as const) {
    it(`${category} PSK allows [] and ['pairing'], and playback only with unpaired access`, () => {
      expect(
        authorizeActivate(category, [], [], [], false, undefined, offered).ok,
      ).toBe(true);
      expect(
        authorizeActivate(
          category,
          ["pairing"],
          [],
          [],
          false,
          methodFor(category),
          offered,
        ).ok,
      ).toBe(true);
      expect(
        authorizeActivate(
          category,
          ["playback"],
          [],
          [],
          true,
          undefined,
          offered,
        ).ok,
      ).toBe(true);
      expect(
        authorizeActivate(
          category,
          ["playback", "pairing"],
          [],
          [],
          true,
          methodFor(category),
          offered,
        ).ok,
      ).toBe(true);
      expect(
        authorizeActivate(
          category,
          ["playback"],
          [],
          [],
          false,
          undefined,
          offered,
        ),
      ).toEqual(pairingRequired);
      expect(
        authorizeActivate(
          category,
          ["playback", "pairing"],
          [],
          [],
          false,
          methodFor(category),
          offered,
        ),
      ).toEqual(pairingRequired);
    });
  }

  it("rejects an activity the spec does not define", () => {
    expect(
      authorizeActivate(
        "long_term",
        ["management"],
        [],
        [],
        true,
        undefined,
        offered,
      ),
    ).toEqual(unauthorized);
  });

  it("returns pairing_required when enabling unpaired access would admit the active_roles activation", () => {
    expect(
      authorizeActivate(
        "sentinel",
        [],
        ["player@v1"],
        [],
        false,
        undefined,
        offered,
      ),
    ).toEqual(pairingRequired);
    expect(
      authorizeActivate(
        "pairing",
        ["pairing"],
        ["player@v1"],
        [],
        false,
        methodFor("pairing"),
        offered,
      ),
    ).toEqual(pairingRequired);
  });

  it("returns unauthorized when enabling unpaired access would still leave the pairing method disallowed", () => {
    expect(
      authorizeActivate(
        "sentinel",
        ["playback", "pairing"],
        [],
        [],
        false,
        { method: "pairing_psk" },
        offered,
      ),
    ).toEqual(unauthorized);
  });

  it("refuses a pairing method or format the PSK disallows or the client does not offer", () => {
    const offersDynamic = {
      pairing_psk: {},
      dynamic_pairing_code: { out_channels: [], formats: ["digits"] },
    } as const;
    const refuse = (
      category: "pairing" | "sentinel",
      pairing: { method: PairMethod; format?: PairCodeFormat },
    ) =>
      authorizeActivate(
        category,
        ["pairing"],
        [],
        [],
        false,
        pairing,
        offersDynamic,
      );
    expect(refuse("sentinel", { method: "pairing_psk" })).toEqual(
      methodNotSupported,
    );
    expect(
      refuse("pairing", { method: "dynamic_pairing_code", format: "digits" }),
    ).toEqual(methodNotSupported);
    expect(refuse("sentinel", { method: "static_pairing_code" })).toEqual(
      methodNotSupported,
    );
    expect(
      refuse("sentinel", { method: "dynamic_pairing_code", format: "qr_code" }),
    ).toEqual(methodNotSupported);
    expect(refuse("sentinel", { method: "toString" as PairMethod })).toEqual(
      methodNotSupported,
    );
  });

  it("drops persisted active_roles on a refusal once the matched PSK allows no roles", () => {
    const refuse = (unpairedAccess: boolean) =>
      authorizeActivate(
        "sentinel",
        ["pairing"],
        undefined,
        ["controller@v1"],
        unpairedAccess,
        { method: "dynamic_pairing_code", format: "digits" },
        offered,
      );
    expect(refuse(false)).toEqual(methodNotSupported);
    expect(refuse(true)).toEqual({
      ...methodNotSupported,
      activeRoles: ["controller@v1"],
    });
  });

  it("treats a missing pairing method or format as a protocol error", () => {
    const protocolError = { ok: false, protocolError: true };
    const offersDynamic = {
      pairing_psk: {},
      dynamic_pairing_code: { out_channels: [], formats: ["digits"] },
    } as const;
    expect(
      authorizeActivate(
        "sentinel",
        ["playback", "pairing"],
        [],
        [],
        false,
        undefined,
        offersDynamic,
      ),
    ).toEqual(protocolError);
    expect(
      authorizeActivate(
        "sentinel",
        ["pairing"],
        [],
        [],
        false,
        { method: "dynamic_pairing_code" },
        offersDynamic,
      ),
    ).toEqual(protocolError);
  });

  it("ignores the pairing object when 'pairing' is not in activities", () => {
    expect(
      authorizeActivate(
        "sentinel",
        ["playback"],
        [],
        [],
        true,
        { method: "pairing_psk" },
        offered,
      ),
    ).toEqual({ ok: true, activeRoles: [] });
  });

  it("allows active_roles on a playback-capable connection without 'playback'", () => {
    expect(
      authorizeActivate(
        "long_term",
        [],
        ["player@v1"],
        [],
        false,
        undefined,
        offered,
      ),
    ).toEqual({ ok: true, activeRoles: ["player@v1"] });
    expect(
      authorizeActivate(
        "pairing",
        ["pairing"],
        ["player@v1"],
        [],
        true,
        methodFor("pairing"),
        offered,
      ),
    ).toEqual({ ok: true, activeRoles: ["player@v1"] });
  });

  it("keeps persisted active_roles when omitted on a playback-capable connection", () => {
    expect(
      authorizeActivate(
        "long_term",
        [],
        undefined,
        ["player@v1"],
        false,
        undefined,
        offered,
      ),
    ).toEqual({ ok: true, activeRoles: ["player@v1"] });
  });

  it("treats persisted active_roles as empty once the connection is not playback-capable", () => {
    expect(
      authorizeActivate(
        "sentinel",
        ["pairing"],
        undefined,
        ["player@v1"],
        false,
        methodFor("sentinel"),
        offered,
      ),
    ).toEqual({ ok: true, activeRoles: [] });
  });
});
