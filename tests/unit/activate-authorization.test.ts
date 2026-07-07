import { describe, it, expect } from "vitest";
import { authorizeActivate } from "../../src/core/activate-authorization";

describe("authorizeActivate", () => {
  it("long-term allows playback+management and pairing-alone", () => {
    expect(
      authorizeActivate("long_term", ["playback", "management"], [], true).ok,
    ).toBe(true);
    expect(authorizeActivate("long_term", ["pairing"], [], true).ok).toBe(true);
    expect(
      authorizeActivate("long_term", ["pairing", "playback"], [], true),
    ).toEqual({ ok: false, goodbye: "unauthorized" });
  });

  it("pairing PSK allows only ['pairing']", () => {
    expect(authorizeActivate("pairing", ["pairing"], [], true).ok).toBe(true);
    expect(authorizeActivate("pairing", ["playback"], [], true)).toEqual({
      ok: false,
      goodbye: "unauthorized",
    });
  });

  it("sentinel gates playback on unpairedAccess", () => {
    expect(authorizeActivate("sentinel", [], [], false).ok).toBe(true);
    expect(authorizeActivate("sentinel", ["pairing"], [], false).ok).toBe(true);
    expect(authorizeActivate("sentinel", ["playback"], [], true).ok).toBe(true);
    expect(authorizeActivate("sentinel", ["playback"], [], false)).toEqual({
      ok: false,
      goodbye: "pairing_required",
    });
    expect(authorizeActivate("sentinel", ["management"], [], true)).toEqual({
      ok: false,
      goodbye: "unauthorized",
    });
  });

  it("rejects non-empty active_roles on a non-playback-capable connection", () => {
    // Pairing PSK is never playback-capable, so active_roles must be empty.
    expect(
      authorizeActivate("pairing", ["pairing"], ["player@v1"], true),
    ).toEqual({ ok: false, goodbye: "unauthorized" });
    // Long-term with 'pairing' activity is not playback-capable either.
    expect(
      authorizeActivate("long_term", ["pairing"], ["player@v1"], true),
    ).toEqual({ ok: false, goodbye: "unauthorized" });
  });

  it("returns pairing_required when enabling unpaired access would admit the active_roles activation", () => {
    expect(authorizeActivate("sentinel", [], ["player@v1"], false)).toEqual({
      ok: false,
      goodbye: "pairing_required",
    });
    expect(
      authorizeActivate("sentinel", ["playback"], ["player@v1"], false),
    ).toEqual({ ok: false, goodbye: "pairing_required" });
  });

  it("allows active_roles on a playback-capable connection", () => {
    // Long-term without pairing is playback-capable, even when 'playback' is not currently active.
    expect(
      authorizeActivate("long_term", ["management"], ["player@v1"], true).ok,
    ).toBe(true);
    expect(
      authorizeActivate("long_term", ["playback"], ["player@v1"], true).ok,
    ).toBe(true);
    // Sentinel with unpaired access enabled is playback-capable.
    expect(
      authorizeActivate("sentinel", ["playback"], ["player@v1"], true).ok,
    ).toBe(true);
  });

  it("rejects selected_pair_method present without a pairing activity", () => {
    expect(
      authorizeActivate("long_term", ["playback"], [], true, "pairing_psk"),
    ).toEqual({ ok: false, goodbye: "unauthorized" });
    expect(
      authorizeActivate("sentinel", [], undefined, true, "pairing_psk"),
    ).toEqual({ ok: false, goodbye: "unauthorized" });
  });

  it("allows selected_pair_method alongside a pairing activity", () => {
    expect(
      authorizeActivate("pairing", ["pairing"], [], true, "pairing_psk").ok,
    ).toBe(true);
  });
});
