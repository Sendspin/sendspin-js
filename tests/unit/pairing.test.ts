import { describe, it, expect, vi } from "vitest";
import { PairingManager } from "../../src/core/pairing";
import { PskStore } from "../../src/core/noise/psk";
import { base64urlDecode } from "../../src/core/noise/base64url";
import { pskId } from "../../src/core/noise/constants";
import type { PskCategory } from "../../src/core/noise/psk";

function setup(category: PskCategory) {
  const store = new PskStore(null);
  const sent: object[] = [];
  const events: string[] = [];
  const close = vi.fn();
  const mgr = new PairingManager({
    sendControl: (m) => sent.push(m),
    close,
    pskStore: store,
    serverId: () => "SERVER_ID",
    matchedCategory: () => category,
    onEvent: (e) => events.push(e),
  });
  return { store, sent, events, close, mgr };
}

describe("PairingManager", () => {
  it("finalizes a pairing_psk flow and persists a bound record", () => {
    const { store, sent, mgr } = setup("pairing");
    expect(mgr.onActivate(["pairing"], "pairing_psk")).toBe(true);
    const fin = sent[0] as { type: string; payload: { long_term_psk: string } };
    expect(fin.type).toBe("client/pair-finalize");
    expect(fin.payload.long_term_psk).toHaveLength(43);

    mgr.onPairFinalize();
    const ltPsk = base64urlDecode(fin.payload.long_term_psk);
    expect(store.lookup(pskId(ltPsk))?.serverId).toBe("SERVER_ID");
  });

  it("aborts an unsupported method and closes", () => {
    const { sent, close, mgr } = setup("pairing");
    mgr.onActivate(["pairing"], "static_pin");
    expect((sent[0] as { type: string }).type).toBe("pair/abort");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes on an inbound pair/abort", () => {
    const { close, mgr } = setup("pairing");
    mgr.onAbort("pin_mismatch");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("ignores a duplicate pairing activate and mints only one PSK", () => {
    const { sent, mgr } = setup("pairing");
    expect(mgr.onActivate(["pairing"], "pairing_psk")).toBe(true);
    expect(mgr.onActivate(["pairing"], "pairing_psk")).toBe(true);
    const finalizes = sent.filter(
      (m) => (m as { type: string }).type === "client/pair-finalize",
    );
    expect(finalizes).toHaveLength(1);
  });

  it("discards the pending PSK on leave-pairing (non-pairing activate)", () => {
    const { store, sent, mgr } = setup("pairing");
    mgr.onActivate(["pairing"], "pairing_psk");
    const fin = sent[0] as { payload: { long_term_psk: string } };
    mgr.onActivate(["playback"]); // leave pairing without finalize
    mgr.onPairFinalize(); // must be a no-op now
    expect(
      store.lookup(pskId(base64urlDecode(fin.payload.long_term_psk))),
    ).toBeNull();
  });
});
