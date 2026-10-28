import { describe, it, expect } from "vitest";
import { PskStore } from "../../../src/core/noise/psk";
import { pskId, SENTINEL_PSK_ID } from "../../../src/core/noise/constants";
import { base64urlEncode } from "../../../src/core/noise/base64url";
import type { SendspinStorage } from "../../../src/types";

function memStorage(): SendspinStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
  };
}

describe("PskStore", () => {
  it("always resolves the Sentinel PSK", () => {
    const store = new PskStore(null);
    expect(store.lookup(SENTINEL_PSK_ID)?.category).toBe("sentinel");
    expect(store.lookup("nope")).toBeNull();
  });

  it("skips a stored long-term record without a server_id", () => {
    const s = memStorage();
    const psk = new Uint8Array(32).fill(2);
    s.setItem("sendspin-psks", JSON.stringify([{ psk: base64urlEncode(psk) }]));
    expect(new PskStore(s).lookup(pskId(psk))).toBeNull();
  });

  it("creates a stable pairing PSK and reloads records from storage", () => {
    const s = memStorage();
    const store = new PskStore(s);
    const pairing = store.getOrCreatePairingPsk();
    expect(store.getOrCreatePairingPsk()).toEqual(pairing);
    store.addLongTerm(new Uint8Array(32).fill(5), "S2");

    const reloaded = new PskStore(s);
    expect(reloaded.lookup(pskId(pairing))?.category).toBe("pairing");
    expect(reloaded.lookup(pskId(new Uint8Array(32).fill(5)))?.serverId).toBe(
      "S2",
    );
  });

  it("replaces the record it already holds for a server", () => {
    const s = memStorage();
    const store = new PskStore(s);
    const old = new Uint8Array(32).fill(5);
    const other = new Uint8Array(32).fill(6);
    const renewed = new Uint8Array(32).fill(7);
    store.addLongTerm(old, "S1");
    store.addLongTerm(other, "S2");
    store.replaceLongTerm(renewed, "S1");

    const reloaded = new PskStore(s);
    expect(reloaded.lookup(pskId(old))).toBeNull();
    expect(reloaded.lookup(pskId(other))?.serverId).toBe("S2");
    expect(reloaded.lookup(pskId(renewed))?.serverId).toBe("S1");
  });

  it("rotates the pairing PSK", () => {
    const store = new PskStore(memStorage());
    const a = store.getOrCreatePairingPsk();
    const b = store.rotatePairingPsk();
    expect(b).not.toEqual(a);
    expect(store.lookup(pskId(a))).toBeNull();
    expect(store.lookup(pskId(b))?.category).toBe("pairing");
  });
});
