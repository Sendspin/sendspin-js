import { describe, it, expect } from "vitest";
import { Identity } from "../../../src/core/noise/identity";
import type { SendspinStorage } from "../../../src/types";

function memStorage(): SendspinStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
  };
}

describe("Identity", () => {
  it("is stable and persistent with storage", () => {
    const s = memStorage();
    const a = Identity.loadOrCreate(s);
    const b = Identity.loadOrCreate(s);
    expect(a.clientId).toBe(b.clientId);
    expect(a.persistent).toBe(true);
    expect(a.clientId).toHaveLength(43);
  });

  it("is ephemeral without storage", () => {
    const a = Identity.loadOrCreate(null);
    const b = Identity.loadOrCreate(null);
    expect(a.persistent).toBe(false);
    expect(a.clientId).not.toBe(b.clientId);
  });
});
