import { describe, it, expect } from "vitest";
import { authorizeActivate } from "../../src/core/activate-authorization";

const unauthorized = { ok: false, goodbye: "unauthorized" };
const pairingRequired = { ok: false, goodbye: "pairing_required" };

describe("authorizeActivate", () => {
  it("long-term allows only [] and ['playback']", () => {
    expect(authorizeActivate("long_term", [], [], [], false).ok).toBe(true);
    expect(authorizeActivate("long_term", ["playback"], [], [], false).ok).toBe(
      true,
    );
    expect(authorizeActivate("long_term", ["pairing"], [], [], true)).toEqual(
      unauthorized,
    );
    expect(
      authorizeActivate("long_term", ["playback", "pairing"], [], [], true),
    ).toEqual(unauthorized);
  });

  for (const category of ["pairing", "sentinel"] as const) {
    it(`${category} PSK allows [] and ['pairing'], and playback only with unpaired access`, () => {
      expect(authorizeActivate(category, [], [], [], false).ok).toBe(true);
      expect(authorizeActivate(category, ["pairing"], [], [], false).ok).toBe(
        true,
      );
      expect(authorizeActivate(category, ["playback"], [], [], true).ok).toBe(
        true,
      );
      expect(
        authorizeActivate(category, ["playback", "pairing"], [], [], true).ok,
      ).toBe(true);
      expect(authorizeActivate(category, ["playback"], [], [], false)).toEqual(
        pairingRequired,
      );
      expect(
        authorizeActivate(category, ["playback", "pairing"], [], [], false),
      ).toEqual(pairingRequired);
    });
  }

  it("rejects an activity the spec does not define", () => {
    expect(
      authorizeActivate("long_term", ["management"], [], [], true),
    ).toEqual(unauthorized);
  });

  it("returns pairing_required when enabling unpaired access would admit the active_roles activation", () => {
    expect(authorizeActivate("sentinel", [], ["player@v1"], [], false)).toEqual(
      pairingRequired,
    );
    expect(
      authorizeActivate("pairing", ["pairing"], ["player@v1"], [], false),
    ).toEqual(pairingRequired);
  });

  it("allows active_roles on a playback-capable connection without 'playback'", () => {
    expect(
      authorizeActivate("long_term", [], ["player@v1"], [], false),
    ).toEqual({ ok: true, activeRoles: ["player@v1"] });
    expect(
      authorizeActivate("pairing", ["pairing"], ["player@v1"], [], true),
    ).toEqual({ ok: true, activeRoles: ["player@v1"] });
  });

  it("keeps persisted active_roles when omitted on a playback-capable connection", () => {
    expect(
      authorizeActivate("long_term", [], undefined, ["player@v1"], false),
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
      ),
    ).toEqual({ ok: true, activeRoles: [] });
  });
});
