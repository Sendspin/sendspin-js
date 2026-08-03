import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PairingManager } from "../../src/core/pairing";
import { PskStore } from "../../src/core/noise/psk";
import {
  base64urlDecode,
  base64urlEncode,
} from "../../src/core/noise/base64url";
import { pskId } from "../../src/core/noise/constants";
import type { PskCategory } from "../../src/core/noise/psk";
import type { SendspinStorage } from "../../src/types";
import { CPace } from "../../src/core/pake/cpace";
import { commitNonce, derivePin } from "../../src/core/pake/pin";
import { SUITES } from "../../src/core/noise/suites";
import { sha256 } from "@noble/hashes/sha2";

const utf8 = (s: string) => new TextEncoder().encode(s);
const EMPTY = new Uint8Array(0);
const CPACE_AD_A = utf8("server");
const CPACE_AD_B = utf8("client");
const PSK_WRAP_LABEL = utf8("sendspin-pair-psk-wrap-v1");

const HANDSHAKE_HASH = new Uint8Array(32).fill(7);

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// CPace sid = label || h || big-endian uint32 attempt counter.
function sidFor(index: number): Uint8Array {
  const label = utf8("sendspin-pair-pake-v1");
  const sid = new Uint8Array(label.length + HANDSHAKE_HASH.length + 4);
  sid.set(label, 0);
  sid.set(HANDSHAKE_HASH, label.length);
  new DataView(sid.buffer).setUint32(
    label.length + HANDSHAKE_HASH.length,
    index,
    false,
  );
  return sid;
}

// The negotiated-suite AEAD the manager uses to wrap the PIN-flow PSK.
const aeadSeal = (key: Uint8Array, pt: Uint8Array) =>
  SUITES.chacha.aeadEncrypt(key, 0n, EMPTY, pt);

// Server side: recover the wrapped PSK from the CPace ISK and sid.
function unwrapPsk(
  wrapped: Uint8Array,
  sid: Uint8Array,
  isk: Uint8Array,
): Uint8Array {
  const kWrap = sha256(concatBytes(PSK_WRAP_LABEL, sid, isk));
  return SUITES.chacha.aeadDecrypt(kWrap, 0n, EMPTY, wrapped);
}

function memStorage(): SendspinStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

interface SetupOpts {
  category?: PskCategory;
  storage?: SendspinStorage | null;
  onPin?: ((pin: string | null) => void) | null;
  staticPin?: string;
  minPinLength?: number;
}

function setup(opts: SetupOpts = {}) {
  const store = new PskStore(null);
  const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const events: string[] = [];
  const details: Array<string | undefined> = [];
  const close = vi.fn();
  const onPin = opts.onPin === undefined ? vi.fn() : opts.onPin;
  const mgr = new PairingManager({
    sendControl: (m) => sent.push(m as never),
    close,
    pskStore: store,
    serverId: () => "SERVER_ID",
    matchedCategory: () => opts.category ?? "pairing",
    handshakeHash: () => HANDSHAKE_HASH,
    aeadSeal,
    storage: opts.storage ?? null,
    onPin: onPin as ((pin: string | null) => void) | null,
    minPinLength: opts.minPinLength,
    staticPin: opts.staticPin,
    onEvent: (e, d) => {
      events.push(e);
      details.push(d);
    },
  });
  return { store, sent, events, details, close, mgr, onPin };
}

function lastOfType(
  sent: Array<{ type: string; payload?: Record<string, unknown> }>,
  type: string,
) {
  return sent.filter((m) => m.type === type).at(-1);
}

/** Drive the server (initiator) side of a PIN PAKE against the manager. */
function serverPake(pin: string, index = 1) {
  return CPace.start({
    role: "initiator",
    prs: utf8(pin),
    sid: sidFor(index),
    ada: CPACE_AD_A,
    adb: CPACE_AD_B,
  });
}

describe("PairingManager (pairing_psk)", () => {
  it("finalizes a pairing_psk flow and persists a bound record", () => {
    const { store, sent, mgr } = setup();
    expect(mgr.onActivate(["pairing"], "pairing_psk")).toBe(true);
    const fin = sent[0] as { type: string; payload: { long_term_psk: string } };
    expect(fin.type).toBe("client/pair-finalize");
    expect(fin.payload.long_term_psk).toHaveLength(43);

    mgr.onPairFinalize();
    const ltPsk = base64urlDecode(fin.payload.long_term_psk);
    expect(store.lookup(pskId(ltPsk))?.serverId).toBe("SERVER_ID");
  });

  it("aborts an unsupported method and closes", () => {
    const { sent, close, mgr } = setup();
    mgr.onActivate(["pairing"], "static_pin"); // not configured
    expect(sent[0]!.type).toBe("pair/abort");
    expect(sent[0]!.payload!.reason).toBe("method_not_supported");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects a PIN method when the matched PSK is the Pairing PSK", () => {
    const { sent, mgr } = setup({ category: "pairing", onPin: vi.fn() });
    mgr.onActivate(["pairing"], "dynamic_pin");
    expect(sent[0]!.payload!.reason).toBe("method_not_supported");
  });

  it("rejects pairing_psk when the matched PSK is not the Pairing PSK", () => {
    const { sent, mgr } = setup({ category: "sentinel" });
    mgr.onActivate(["pairing"], "pairing_psk");
    expect(sent[0]!.payload!.reason).toBe("method_not_supported");
  });

  it("clears the attempt on an inbound pair/abort but keeps the connection open", () => {
    const { close, events, mgr } = setup();
    mgr.onActivate(["pairing"], "pairing_psk");
    mgr.onAbort("pin_mismatch");
    expect(close).not.toHaveBeenCalled();
    expect(events).toContain("aborted");
  });

  it("ignores an inbound pair/abort when no attempt is in progress", () => {
    const { close, events, mgr } = setup();
    mgr.onAbort("pin_mismatch");
    expect(close).not.toHaveBeenCalled();
    expect(events).not.toContain("aborted");
  });

  it("ignores a duplicate pairing activate and mints only one PSK", () => {
    const { sent, mgr } = setup();
    expect(mgr.onActivate(["pairing"], "pairing_psk")).toBe(true);
    expect(mgr.onActivate(["pairing"], "pairing_psk")).toBe(true);
    const finalizes = sent.filter((m) => m.type === "client/pair-finalize");
    expect(finalizes).toHaveLength(1);
  });

  it("discards the pending PSK on leave-pairing (non-pairing activate)", () => {
    const { store, sent, mgr } = setup();
    mgr.onActivate(["pairing"], "pairing_psk");
    const fin = sent[0] as { payload: { long_term_psk: string } };
    mgr.onActivate(["playback"]); // leave pairing without finalize
    mgr.onPairFinalize(); // must be a no-op now
    expect(
      store.lookup(pskId(base64urlDecode(fin.payload.long_term_psk))),
    ).toBeNull();
  });
});

describe("client/hello descriptors", () => {
  it("advertises only pairing_psk by default", () => {
    const { mgr } = setup({ onPin: null });
    expect(mgr.descriptors()).toEqual([{ method: "pairing_psk" }]);
  });

  it("advertises dynamic_pin with out_channels and min_pin_length when onPin is set", () => {
    const { mgr } = setup({ onPin: vi.fn(), minPinLength: 8 });
    expect(mgr.descriptors()).toContainEqual({
      method: "dynamic_pin",
      out_channels: ["display"],
      min_pin_length: 8,
      locked_out: false,
    });
  });

  it("advertises static_pin when a PIN is configured", () => {
    const { mgr } = setup({ onPin: null, staticPin: "12345678" });
    expect(mgr.descriptors()).toContainEqual({
      method: "static_pin",
      locked_out: false,
    });
  });

  it("clamps min_pin_length into the 4-12 range", () => {
    const { mgr } = setup({ onPin: vi.fn(), minPinLength: 2 });
    const dyn = mgr.descriptors().find((d) => d.method === "dynamic_pin")!;
    expect(dyn.min_pin_length).toBe(4);
  });

  it("rejects a malformed static PIN", () => {
    expect(() => setup({ staticPin: "1234" })).toThrow(/8 decimal digits/);
    expect(() => setup({ staticPin: "abcdefgh" })).toThrow(/8 decimal digits/);
  });
});

describe("PairingManager (dynamic_pin)", () => {
  const PIN_LENGTH = 6;
  const LOCKOUT_THRESHOLD = 10;

  /** Drive one dynamic-PIN attempt through to a mismatched server tag. */
  function failAttempt(ctx: ReturnType<typeof setup>, index: number): void {
    ctx.mgr.onActivate(["pairing"], "dynamic_pin");
    ctx.mgr.onPairInit({
      nonce_A: base64urlEncode(new Uint8Array(32).fill(0xa1)),
      pin_length: PIN_LENGTH,
    });
    const shownPin = (ctx.onPin as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .filter((p): p is string => typeof p === "string")
      .at(-1)!;
    const server = serverPake(shownPin, index);
    ctx.mgr.onPairAuth({ pake_msg_1: base64urlEncode(server.publicShare) });
    const auth = lastOfType(ctx.sent, "client/pair-auth")!;
    server.derive(base64urlDecode(auth.payload!.pake_msg_2 as string));
    const badTag = server.tag().slice();
    badTag[0] ^= 1;
    ctx.mgr.onPairConfirm({ server_kc: base64urlEncode(badTag) });
  }

  function runToConfirm(opts: SetupOpts = {}) {
    const ctx = setup({ category: "sentinel", onPin: vi.fn(), ...opts });
    expect(ctx.mgr.onActivate(["pairing"], "dynamic_pin")).toBe(true);

    // client/pair-init carries commit_B = SHA-256(nonce_B).
    const init = lastOfType(ctx.sent, "client/pair-init")!;
    const commitB = base64urlDecode(init.payload!.commit_B as string);
    expect(commitB).toHaveLength(32);

    // server/pair-init: nonce_A and the PIN length.
    const nonceA = new Uint8Array(32).fill(0xa1);
    ctx.mgr.onPairInit({
      nonce_A: base64urlEncode(nonceA),
      pin_length: PIN_LENGTH,
    });
    const shownPin = (ctx.onPin as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(shownPin).toMatch(/^[0-9]{6}$/);

    // server/pair-auth: the server's CPace share; expect client/pair-auth back.
    const server = serverPake(shownPin);
    ctx.mgr.onPairAuth({ pake_msg_1: base64urlEncode(server.publicShare) });
    const auth = lastOfType(ctx.sent, "client/pair-auth")!;
    server.derive(base64urlDecode(auth.payload!.pake_msg_2 as string));
    return { ...ctx, server, nonceA, commitB, shownPin };
  }

  it("completes the full flow and persists the long-term PSK", () => {
    const storage = memStorage();
    const ctx = runToConfirm({ storage });
    const { mgr, sent, server, store, onPin, nonceA, commitB, shownPin } = ctx;

    mgr.onPairConfirm({ server_kc: base64urlEncode(server.tag()) });

    // client/pair-confirm opens the commitment and proves the PAKE.
    const confirm = lastOfType(sent, "client/pair-confirm")!;
    expect(
      server.verify(base64urlDecode(confirm.payload!.client_kc as string)),
    ).toBe(true);
    const nonceB = base64urlDecode(confirm.payload!.nonce_B as string);
    expect(commitNonce(nonceB)).toEqual(commitB);
    expect(derivePin(HANDSHAKE_HASH, nonceA, nonceB, 6)).toBe(shownPin);

    // client/pair-finalize follows back-to-back, carrying the wrapped PSK.
    const fin = lastOfType(sent, "client/pair-finalize")!;
    expect(fin.payload!.wrapped_psk).toHaveLength(64);
    expect(fin.payload!.long_term_psk).toBeUndefined();

    mgr.onPairFinalize();
    // The server unwraps with the shared CPace output and recovers the PSK.
    const ltPsk = unwrapPsk(
      base64urlDecode(fin.payload!.wrapped_psk as string),
      sidFor(1),
      server.isk,
    );
    expect(store.lookup(pskId(ltPsk))?.serverId).toBe("SERVER_ID");
    // The PIN display is cleared when the attempt ends.
    expect((onPin as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe(
      null,
    );
  });

  it("aborts with pin_length_unacceptable when the PIN is too short", () => {
    const { mgr, sent, close } = setup({
      category: "sentinel",
      onPin: vi.fn(),
      minPinLength: 6,
    });
    mgr.onActivate(["pairing"], "dynamic_pin");
    mgr.onPairInit({
      nonce_A: base64urlEncode(new Uint8Array(32)),
      pin_length: 4,
    });
    expect(lastOfType(sent, "pair/abort")!.payload!.reason).toBe(
      "pin_length_unacceptable",
    );
    expect(close).not.toHaveBeenCalled();
  });

  it("aborts with pin_mismatch and records a failure on a bad server tag", () => {
    const storage = memStorage();
    const ctx = runToConfirm({ storage });
    const badTag = ctx.server.tag().slice();
    badTag[0] ^= 1;
    ctx.mgr.onPairConfirm({ server_kc: base64urlEncode(badTag) });
    expect(lastOfType(ctx.sent, "pair/abort")!.payload!.reason).toBe(
      "pin_mismatch",
    );
    expect(ctx.close).not.toHaveBeenCalled();
    expect(
      JSON.parse(storage.data.get("sendspin-pair-failures")!).dynamic_pin,
    ).toBe(1);
  });

  it("resets the failure counter when the server tag verifies", () => {
    const storage = memStorage();
    storage.setItem(
      "sendspin-pair-failures",
      JSON.stringify({ dynamic_pin: 9 }),
    );
    const ctx = runToConfirm({ storage });
    ctx.mgr.onPairConfirm({ server_kc: base64urlEncode(ctx.server.tag()) });
    expect(
      JSON.parse(storage.data.get("sendspin-pair-failures")!).dynamic_pin,
    ).toBeUndefined();
  });

  it("refuses to pair while locked out", () => {
    const storage = memStorage();
    storage.setItem(
      "sendspin-pair-failures",
      JSON.stringify({ dynamic_pin: 10 }),
    );
    const { mgr, sent, close } = setup({
      category: "sentinel",
      onPin: vi.fn(),
      storage,
    });
    expect(mgr.isLockedOut("dynamic_pin")).toBe(true);
    expect(
      mgr.descriptors().find((d) => d.method === "dynamic_pin")!.locked_out,
    ).toBe(true);
    mgr.onActivate(["pairing"], "dynamic_pin");
    expect(lastOfType(sent, "pair/abort")!.payload!.reason).toBe("locked_out");
    expect(close).not.toHaveBeenCalled();
  });

  it("clearLockout resets the counter and admits attempts again", () => {
    const storage = memStorage();
    storage.setItem(
      "sendspin-pair-failures",
      JSON.stringify({ dynamic_pin: 10 }),
    );
    const { mgr } = setup({ category: "sentinel", onPin: vi.fn(), storage });
    expect(mgr.isLockedOut("dynamic_pin")).toBe(true);
    mgr.clearLockout("dynamic_pin");
    expect(mgr.isLockedOut("dynamic_pin")).toBe(false);
    expect(
      JSON.parse(storage.data.get("sendspin-pair-failures")!).dynamic_pin,
    ).toBeUndefined();
  });

  it("locks out on the tenth consecutive PIN mismatch", () => {
    const ctx = setup({
      category: "sentinel",
      onPin: vi.fn(),
      storage: memStorage(),
    });
    for (let i = 1; i < LOCKOUT_THRESHOLD; i++) failAttempt(ctx, i);
    expect(ctx.mgr.isLockedOut("dynamic_pin")).toBe(false);
    failAttempt(ctx, LOCKOUT_THRESHOLD);
    expect(ctx.mgr.isLockedOut("dynamic_pin")).toBe(true);
  });

  it("fails closed on a non-integer pin_length", () => {
    const { mgr, sent, close } = setup({
      category: "sentinel",
      onPin: vi.fn(),
    });
    mgr.onActivate(["pairing"], "dynamic_pin");
    mgr.onPairInit({
      nonce_A: base64urlEncode(new Uint8Array(32)),
      pin_length: 6.5,
    });
    expect(lastOfType(sent, "pair/abort")).toBeUndefined();
    expect(close).toHaveBeenCalled();
  });

  it("aborts with pin_mismatch on a low-order server share", () => {
    const ctx = setup({ category: "sentinel", onPin: vi.fn() });
    ctx.mgr.onActivate(["pairing"], "dynamic_pin");
    ctx.mgr.onPairInit({
      nonce_A: base64urlEncode(new Uint8Array(32).fill(0xa1)),
      pin_length: 6,
    });
    ctx.mgr.onPairAuth({
      pake_msg_1: base64urlEncode(new Uint8Array(32)), // u = 0
    });
    expect(lastOfType(ctx.sent, "pair/abort")!.payload!.reason).toBe(
      "pin_mismatch",
    );
  });

  it("fails closed on out-of-order pairing messages", () => {
    const { mgr, sent, close } = setup({
      category: "sentinel",
      onPin: vi.fn(),
    });
    mgr.onActivate(["pairing"], "dynamic_pin");
    mgr.onPairConfirm({ server_kc: base64urlEncode(new Uint8Array(64)) });
    expect(lastOfType(sent, "pair/abort")).toBeUndefined();
    expect(close).toHaveBeenCalled();
  });

  it("clears the PIN display on leave-pairing", () => {
    const ctx = runToConfirm();
    ctx.mgr.onActivate(["playback"]); // leave pairing
    expect((ctx.onPin as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe(
      null,
    );
  });

  it("cancels an in-progress attempt with user_cancelled", () => {
    const ctx = runToConfirm();
    ctx.mgr.cancelPairing();
    expect(lastOfType(ctx.sent, "pair/abort")!.payload!.reason).toBe(
      "user_cancelled",
    );
    expect(ctx.close).not.toHaveBeenCalled();
  });

  it("keeps the connection open and advances pairing_index on a retry", () => {
    const ctx = setup({ category: "sentinel", onPin: vi.fn() });
    ctx.mgr.onActivate(["pairing"], "dynamic_pin");
    expect(
      lastOfType(ctx.sent, "client/pair-init")!.payload!.pairing_index,
    ).toBe(1);
    // First attempt aborts (PIN too short); the connection stays open.
    ctx.mgr.onPairInit({
      nonce_A: base64urlEncode(new Uint8Array(32)),
      pin_length: 3,
    });
    expect(ctx.close).not.toHaveBeenCalled();
    // A fresh pairing activate starts a new attempt with the next index.
    ctx.mgr.onActivate(["pairing"], "dynamic_pin");
    expect(
      lastOfType(ctx.sent, "client/pair-init")!.payload!.pairing_index,
    ).toBe(2);
  });

  it("silently discards a stray pairing message after the attempt ended", () => {
    const ctx = setup({ category: "sentinel", onPin: vi.fn() });
    ctx.mgr.onActivate(["pairing"], "dynamic_pin");
    ctx.mgr.cancelPairing(); // attempt ends, connection stays open
    // A late server/pair-auth for the ended attempt is ignored, not fatal.
    ctx.mgr.onPairAuth({ pake_msg_1: base64urlEncode(new Uint8Array(32)) });
    expect(ctx.close).not.toHaveBeenCalled();
  });
});

describe("PairingManager (static_pin)", () => {
  const STATIC_PIN = "31415926";

  function staticSetup() {
    return setup({ category: "sentinel", onPin: null, staticPin: STATIC_PIN });
  }

  function completeFrom(ctx: ReturnType<typeof staticSetup>) {
    const server = serverPake(STATIC_PIN);
    ctx.mgr.onPairAuth({ pake_msg_1: base64urlEncode(server.publicShare) });
    const auth = lastOfType(ctx.sent, "client/pair-auth")!;
    server.derive(base64urlDecode(auth.payload!.pake_msg_2 as string));
    ctx.mgr.onPairConfirm({ server_kc: base64urlEncode(server.tag()) });
    return server;
  }

  it("waits for the pairing-window gesture before sending pair-init", () => {
    const ctx = staticSetup();
    expect(ctx.mgr.onActivate(["pairing"], "static_pin")).toBe(true);
    expect(lastOfType(ctx.sent, "client/pair-init")).toBeUndefined();

    ctx.mgr.openPairingWindow();
    const init = lastOfType(ctx.sent, "client/pair-init")!;
    // pairing_index, but no commit_B in static PIN.
    expect(init.payload).toEqual({ pairing_index: 1 });

    const server = completeFrom(ctx);
    const confirm = lastOfType(ctx.sent, "client/pair-confirm")!;
    expect(
      server.verify(base64urlDecode(confirm.payload!.client_kc as string)),
    ).toBe(true);
    expect(confirm.payload!.nonce_B).toBeUndefined();

    const fin = lastOfType(ctx.sent, "client/pair-finalize")!;
    ctx.mgr.onPairFinalize();
    const ltPsk = unwrapPsk(
      base64urlDecode(fin.payload!.wrapped_psk as string),
      sidFor(1),
      server.isk,
    );
    expect(ctx.store.lookup(pskId(ltPsk))?.serverId).toBe("SERVER_ID");
  });

  it("starts immediately when the window was opened before activation", () => {
    const ctx = staticSetup();
    ctx.mgr.openPairingWindow();
    ctx.mgr.onActivate(["pairing"], "static_pin");
    expect(lastOfType(ctx.sent, "client/pair-init")).toBeDefined();
  });

  it("the window admits exactly one attempt", () => {
    const ctx = staticSetup();
    ctx.mgr.openPairingWindow();
    ctx.mgr.onActivate(["pairing"], "static_pin");
    completeFrom(ctx);
    ctx.mgr.onPairFinalize();
    // A new activate must wait for a fresh gesture.
    ctx.mgr.onActivate(["pairing"], "static_pin");
    const inits = ctx.sent.filter((m) => m.type === "client/pair-init");
    expect(inits).toHaveLength(1);
  });
});

describe("PairingManager timers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("aborts with attempt_timeout two minutes after pair-init", () => {
    const { mgr, sent, close } = setup({
      category: "sentinel",
      onPin: vi.fn(),
    });
    mgr.onActivate(["pairing"], "dynamic_pin");
    vi.advanceTimersByTime(120_000);
    expect(lastOfType(sent, "pair/abort")!.payload!.reason).toBe(
      "attempt_timeout",
    );
    expect(close).not.toHaveBeenCalled();
  });

  it("expires an unused pairing window silently", () => {
    const ctx = setup({
      category: "sentinel",
      onPin: null,
      staticPin: "31415926",
    });
    ctx.mgr.openPairingWindow();
    vi.advanceTimersByTime(300_000);
    ctx.mgr.onActivate(["pairing"], "static_pin");
    // Window expired: the attempt waits for a fresh gesture.
    expect(lastOfType(ctx.sent, "client/pair-init")).toBeUndefined();
    expect(ctx.close).not.toHaveBeenCalled();
  });

  it("closes when the operator never opens the window", () => {
    const ctx = setup({
      category: "sentinel",
      onPin: null,
      staticPin: "31415926",
    });
    ctx.mgr.onActivate(["pairing"], "static_pin");
    vi.advanceTimersByTime(300_000);
    expect(ctx.close).toHaveBeenCalled();
  });

  it("static attempts also honor the attempt timeout", () => {
    const ctx = setup({
      category: "sentinel",
      onPin: null,
      staticPin: "31415926",
    });
    ctx.mgr.onActivate(["pairing"], "static_pin");
    ctx.mgr.openPairingWindow();
    vi.advanceTimersByTime(120_000);
    expect(lastOfType(ctx.sent, "pair/abort")!.payload!.reason).toBe(
      "attempt_timeout",
    );
  });
});

// Sanity: commitments are domain-separated SHA-256 (matches the server).
describe("commitment", () => {
  it("commit_B is SHA-256('sendspin-pair-commit-v1' || nonce_B)", () => {
    const nonce = new Uint8Array(32).fill(0x5c);
    expect(commitNonce(nonce)).toEqual(
      sha256(concatBytes(utf8("sendspin-pair-commit-v1"), nonce)),
    );
  });
});
