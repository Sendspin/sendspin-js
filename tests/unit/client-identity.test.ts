import { describe, it, expect } from "vitest";
import { loadSendspinClientIdentity } from "../../src/client-identity";
import { SendspinCore } from "../../src/core/core";
import type { SendspinStorage } from "../../src/types";

function memStorage(): SendspinStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
  };
}

describe("loadSendspinClientIdentity", () => {
  it("returns the identity a core built on the same storage adopts", () => {
    const storage = memStorage();
    const preread = loadSendspinClientIdentity(storage);
    const core = new SendspinCore({ baseUrl: "http://server", storage });
    expect(core.clientId).toBe(preread.clientId);
    expect(core.pairingPsk).toBe(preread.pairingPsk);
    expect(core.pairingToken).toBe(preread.pairingToken);
    expect("getPairingToken" in preread).toBe(false);
  });

  it("reports no pairing credentials without storage", () => {
    const identity = loadSendspinClientIdentity(null);
    expect(identity.pairingPsk).toBeNull();
    expect(identity.pairingToken).toBeNull();
    expect("getPairingToken" in identity).toBe(false);
  });
});
