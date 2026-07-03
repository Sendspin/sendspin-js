import { describe, it, expect } from "vitest";
import { PskStore } from "../../../src/core/noise/psk";
import { pskId, SENTINEL_PSK_ID } from "../../../src/core/noise/constants";
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

  it("adds stored-pubkey and shared-PSK long-term records", () => {
    const store = new PskStore(null);
    const bound = new Uint8Array(32).fill(1);
    const shared = new Uint8Array(32).fill(2);
    store.addLongTerm(bound, "SERVERID");
    store.addLongTerm(shared);
    expect(store.lookup(pskId(bound))?.serverId).toBe("SERVERID");
    expect(store.lookup(pskId(shared))?.serverId).toBeUndefined();
  });

  it("removes stored-pubkey but keeps shared-PSK on removeByPskId", () => {
    const store = new PskStore(null);
    const bound = new Uint8Array(32).fill(3);
    const shared = new Uint8Array(32).fill(4);
    store.addLongTerm(bound, "S");
    store.addLongTerm(shared);
    store.removeByPskId(pskId(bound));
    store.removeByPskId(pskId(shared));
    expect(store.lookup(pskId(bound))).toBeNull();
    expect(store.lookup(pskId(shared))).not.toBeNull();
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

  it("rotates the pairing PSK", () => {
    const store = new PskStore(memStorage());
    const a = store.getOrCreatePairingPsk();
    const b = store.rotatePairingPsk();
    expect(b).not.toEqual(a);
    expect(store.lookup(pskId(a))).toBeNull();
    expect(store.lookup(pskId(b))?.category).toBe("pairing");
  });
});
