import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PairingManager } from "../../src/core/pairing";
import { PskStore } from "../../src/core/noise/psk";
import {
  base64urlDecode,
  base64urlEncode,
} from "../../src/core/noise/base64url";
import { pskId } from "../../src/core/noise/constants";
import type { PskCategory } from "../../src/core/noise/psk";
import type {
  ActivatePairing,
  PairOutChannel,
  PairSecretLocation,
  SendspinStorage,
} from "../../src/types";
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

type OnPin = (pin: string | null, languages?: string[]) => void;

interface SetupOpts {
  category?: PskCategory;
  storage?: SendspinStorage | null;
  onPairingCode?: OnPin | null;
  pairingCodeOutChannels?: PairOutChannel[];
  staticPairingCode?: string;
  staticPairingCodeLocations?: PairSecretLocation[];
  pairingPskLocations?: PairSecretLocation[];
  minPinLength?: number;
}

function setup(opts: SetupOpts = {}) {
  const store = new PskStore(null);
  const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const events: string[] = [];
  const details: Array<string | undefined> = [];
  const close = vi.fn();
  const onPairingCode =
    opts.onPairingCode === undefined ? vi.fn() : opts.onPairingCode;
  const mgr = new PairingManager({
    sendControl: (m) => sent.push(m as never),
    close,
    pskStore: store,
    serverId: () => "SERVER_ID",
    matchedCategory: () => opts.category ?? "pairing",
    handshakeHash: () => HANDSHAKE_HASH,
    aeadSeal,
    storage: opts.storage ?? null,
    onPairingCode: onPairingCode as OnPin | null,
    pairingCodeOutChannels: opts.pairingCodeOutChannels,
    minPinLength: opts.minPinLength,
    staticPairingCode: opts.staticPairingCode,
    staticPairingCodeLocations: opts.staticPairingCodeLocations,
    pairingPskLocations: opts.pairingPskLocations,
    onEvent: (e, d) => {
      events.push(e);
      details.push(d);
    },
  });
  return { store, sent, events, details, close, mgr, onPairingCode };
}

function lastOfType(
  sent: Array<{ type: string; payload?: Record<string, unknown> }>,
  type: string,
) {
  return sent.filter((m) => m.type === type).at(-1);
}

/** A dynamic-PIN pairing activation, which now carries the PIN length. */
function dynamic(pinLength = 6, languages?: string[]): ActivatePairing {
  return { method: "dynamic_pin", pin_length: pinLength, languages };
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
    expect(mgr.onActivate(["pairing"], { method: "pairing_psk" })).toBe(true);
    const fin = sent[0] as { type: string; payload: { long_term_psk: string } };
    expect(fin.type).toBe("client/pair-finalize");
    expect(fin.payload.long_term_psk).toHaveLength(43);

    mgr.onPairFinalize();
    const ltPsk = base64urlDecode(fin.payload.long_term_psk);
    expect(store.lookup(pskId(ltPsk))?.serverId).toBe("SERVER_ID");
  });

  it("aborts an unsupported method and keeps the connection open", () => {
    const { sent, close, mgr } = setup();
    mgr.onActivate(["pairing"], { method: "static_pin" }); // not configured
    expect(sent[0]!.type).toBe("pair/abort");
    expect(sent[0]!.payload!.reason).toBe("method_not_supported");
    expect(close).not.toHaveBeenCalled();
  });

  it("ignores a pairing object on a non-pairing activation", () => {
    const { sent, close, mgr } = setup();
    // Spec: "A client ignores this field when activities does not include
    // 'pairing'". No abort, no close, and no attempt started.
    expect(mgr.onActivate(["playback"], { method: "pairing_psk" })).toBe(false);
    expect(sent).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  });

  it("fails closed on a pairing activation with no pairing object", () => {
    const { sent, close, mgr } = setup();
    // A required field no conformant server omits: the abort reasons are all
    // defined over values that are present, so this is a protocol error.
    mgr.onActivate(["pairing"]);
    expect(sent).toEqual([]);
    expect(close).toHaveBeenCalled();
  });

  it("rejects a PIN method when the matched PSK is the Pairing PSK", () => {
    const { sent, mgr } = setup({
      category: "pairing",
      onPairingCode: vi.fn(),
    });
    mgr.onActivate(["pairing"], dynamic());
    expect(sent[0]!.payload!.reason).toBe("method_not_supported");
  });

  it("rejects pairing_psk when the matched PSK is not the Pairing PSK", () => {
    const { sent, mgr } = setup({ category: "sentinel" });
    mgr.onActivate(["pairing"], { method: "pairing_psk" });
    expect(sent[0]!.payload!.reason).toBe("method_not_supported");
  });

  it("clears the attempt on an inbound pair/abort but keeps the connection open", () => {
    const { close, events, mgr } = setup();
    mgr.onActivate(["pairing"], { method: "pairing_psk" });
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

  it("supersedes a running attempt when another pairing activate arrives", () => {
    const { sent, events, mgr } = setup();
    expect(mgr.onActivate(["pairing"], { method: "pairing_psk" })).toBe(true);
    expect(mgr.onActivate(["pairing"], { method: "pairing_psk" })).toBe(true);
    // The first attempt is abandoned and the second mints its own PSK, so the
    // client's activate count keeps pace with the server's.
    const finalizes = sent.filter((m) => m.type === "client/pair-finalize");
    expect(finalizes).toHaveLength(2);
    expect(finalizes[0]!.payload!.long_term_psk).not.toBe(
      finalizes[1]!.payload!.long_term_psk,
    );
    expect(events).toEqual(["started", "aborted", "started"]);
  });

  it("discards the pending PSK on leave-pairing (non-pairing activate)", () => {
    const { store, sent, mgr } = setup();
    mgr.onActivate(["pairing"], { method: "pairing_psk" });
    const fin = sent[0] as { payload: { long_term_psk: string } };
    mgr.onActivate(["playback"]); // leave pairing without finalize
    mgr.onPairFinalize(); // must be a no-op now
    expect(
      store.lookup(pskId(base64urlDecode(fin.payload.long_term_psk))),
    ).toBeNull();
  });
});

describe("client/hello descriptors", () => {
  it("advertises only pairing_psk by default, with no locations hint", () => {
    const { mgr } = setup({ onPairingCode: null });
    // The hint says where the operator finds the secret, which only the
    // integrator knows, so an unconfigured client claims nothing.
    expect(mgr.descriptors()).toEqual([{ method: "pairing_psk" }]);
  });

  it("advertises dynamic_pin with out_channels and min_pin_length when onPairingCode is set", () => {
    const { mgr } = setup({ onPairingCode: vi.fn(), minPinLength: 8 });
    expect(mgr.descriptors()).toContainEqual({
      method: "dynamic_pin",
      out_channels: ["display"],
      min_pin_length: 8,
    });
  });

  it("advertises the configured PIN out-channels", () => {
    const { mgr } = setup({
      onPairingCode: vi.fn(),
      pairingCodeOutChannels: ["display", "speaker"],
    });
    const dyn = mgr.descriptors().find((d) => d.method === "dynamic_pin")!;
    expect(dyn.out_channels).toEqual(["display", "speaker"]);
  });

  it("advertises static_pin without a locations hint when unconfigured", () => {
    const { mgr } = setup({
      onPairingCode: null,
      staticPairingCode: "12345678",
    });
    expect(mgr.descriptors()).toContainEqual({ method: "static_pin" });
  });

  it("omits an empty locations list rather than advertising it", () => {
    const { mgr } = setup({
      onPairingCode: null,
      staticPairingCode: "12345678",
      staticPairingCodeLocations: [],
    });
    expect(mgr.descriptors()).toContainEqual({ method: "static_pin" });
  });

  it("advertises the configured secret locations", () => {
    const { mgr } = setup({
      onPairingCode: null,
      staticPairingCode: "12345678",
      staticPairingCodeLocations: ["device", "leaflet"],
      pairingPskLocations: ["leaflet"],
    });
    const byMethod = Object.fromEntries(
      mgr.descriptors().map((d) => [d.method, d.locations]),
    );
    expect(byMethod).toEqual({
      pairing_psk: ["leaflet"],
      static_pin: ["device", "leaflet"],
    });
  });

  it("clamps min_pin_length into the 4-12 range", () => {
    const { mgr } = setup({ onPairingCode: vi.fn(), minPinLength: 2 });
    const dyn = mgr.descriptors().find((d) => d.method === "dynamic_pin")!;
    expect(dyn.min_pin_length).toBe(4);
  });

  it("rejects a malformed static PIN", () => {
    expect(() => setup({ staticPairingCode: "1234" })).toThrow(
      /8 decimal digits/,
    );
    expect(() => setup({ staticPairingCode: "abcdefgh" })).toThrow(
      /8 decimal digits/,
    );
  });
});

describe("PairingManager (dynamic_pin)", () => {
  const PIN_LENGTH = 6;
  const ESCALATION_THRESHOLD = 10;

  /** The PIN most recently surfaced to the app. */
  function shownPin(ctx: ReturnType<typeof setup>): string {
    return (ctx.onPairingCode as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .filter((p): p is string => typeof p === "string")
      .at(-1)!;
  }

  /** Drive one dynamic-PIN attempt through to a mismatched server tag. */
  function failAttempt(ctx: ReturnType<typeof setup>, index: number): void {
    ctx.mgr.onActivate(["pairing"], dynamic(PIN_LENGTH));
    // Once escalated, this attempt waits on a gesture instead of starting.
    const pending = lastOfType(ctx.sent, "client/pair-pending");
    if (pending?.payload!.pairing_index === index) ctx.mgr.openPairingWindow();
    ctx.mgr.onPairInit({
      nonce_A: base64urlEncode(new Uint8Array(32).fill(0xa1)),
    });
    const server = serverPake(shownPin(ctx), index);
    ctx.mgr.onPairAuth({ pake_msg_1: base64urlEncode(server.publicShare) });
    const auth = lastOfType(ctx.sent, "client/pair-auth")!;
    server.derive(base64urlDecode(auth.payload!.pake_msg_2 as string));
    const badTag = server.tag().slice();
    badTag[0] ^= 1;
    ctx.mgr.onPairConfirm({ server_kc: base64urlEncode(badTag) });
  }

  function runToConfirm(opts: SetupOpts = {}, pairing = dynamic(PIN_LENGTH)) {
    const ctx = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
      ...opts,
    });
    expect(ctx.mgr.onActivate(["pairing"], pairing)).toBe(true);

    // client/pair-init carries commit_B = SHA-256(nonce_B).
    const init = lastOfType(ctx.sent, "client/pair-init")!;
    const commitB = base64urlDecode(init.payload!.commit_B as string);
    expect(commitB).toHaveLength(32);

    // server/pair-init carries only nonce_A: pin_length came with the activation.
    const nonceA = new Uint8Array(32).fill(0xa1);
    ctx.mgr.onPairInit({ nonce_A: base64urlEncode(nonceA) });
    const pin = shownPin(ctx);
    expect(pin).toMatch(new RegExp(`^[0-9]{${pairing.pin_length}}$`));

    // server/pair-auth: the server's CPace share; expect client/pair-auth back.
    const server = serverPake(pin);
    ctx.mgr.onPairAuth({ pake_msg_1: base64urlEncode(server.publicShare) });
    const auth = lastOfType(ctx.sent, "client/pair-auth")!;
    server.derive(base64urlDecode(auth.payload!.pake_msg_2 as string));
    return { ...ctx, server, nonceA, commitB, shownPin: pin };
  }

  it("completes the full flow and persists the long-term PSK", () => {
    const storage = memStorage();
    const ctx = runToConfirm({ storage });
    const {
      mgr,
      sent,
      server,
      store,
      onPairingCode,
      nonceA,
      commitB,
      shownPin,
    } = ctx;

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
    expect(
      (onPairingCode as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0],
    ).toBe(null);
  });

  it("forwards the activation's spoken-PIN languages alongside the PIN", () => {
    const ctx = runToConfirm({}, dynamic(PIN_LENGTH, ["ca", "es", "en"]));
    const call = (
      ctx.onPairingCode as ReturnType<typeof vi.fn>
    ).mock.calls.find((c) => typeof c[0] === "string")!;
    expect(call[1]).toEqual(["ca", "es", "en"]);
  });

  it.each([
    ["not an array", "en" as unknown],
    ["an empty list", []],
    ["non-string members", ["en", 7]],
    ["a blank tag", ["en", ""]],
  ])("drops a languages hint that is %s", (_label, languages) => {
    const ctx = runToConfirm({}, {
      method: "dynamic_pin",
      pin_length: PIN_LENGTH,
      languages,
    } as ActivatePairing);
    const call = (
      ctx.onPairingCode as ReturnType<typeof vi.fn>
    ).mock.calls.find((c) => typeof c[0] === "string")!;
    // Informational only: a malformed hint is never grounds for pair/abort.
    expect(call[1]).toBeUndefined();
    expect(lastOfType(ctx.sent, "pair/abort")).toBeUndefined();
    expect(ctx.close).not.toHaveBeenCalled();
  });

  it("omits languages when the activation carries none", () => {
    const ctx = runToConfirm();
    const call = (
      ctx.onPairingCode as ReturnType<typeof vi.fn>
    ).mock.calls.find((c) => typeof c[0] === "string")!;
    expect(call[1]).toBeUndefined();
  });

  it("aborts with pin_length_unacceptable when the activation's PIN is too short", () => {
    const { mgr, sent, close } = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
      minPinLength: 6,
    });
    mgr.onActivate(["pairing"], dynamic(4));
    expect(lastOfType(sent, "pair/abort")!.payload!.reason).toBe(
      "pin_length_unacceptable",
    );
    expect(lastOfType(sent, "client/pair-init")).toBeUndefined();
    expect(close).not.toHaveBeenCalled();
  });

  it("aborts with pin_length_unacceptable above the 12-digit maximum", () => {
    const { mgr, sent } = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
    });
    mgr.onActivate(["pairing"], dynamic(13));
    expect(lastOfType(sent, "pair/abort")!.payload!.reason).toBe(
      "pin_length_unacceptable",
    );
  });

  it("fails closed on a non-integer pin_length", () => {
    const { mgr, sent, close } = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
    });
    mgr.onActivate(["pairing"], dynamic(6.5));
    expect(lastOfType(sent, "pair/abort")).toBeUndefined();
    expect(close).toHaveBeenCalled();
  });

  it("fails closed when a dynamic_pin activation omits pin_length", () => {
    const { mgr, sent, close } = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
    });
    mgr.onActivate(["pairing"], { method: "dynamic_pin" });
    expect(lastOfType(sent, "pair/abort")).toBeUndefined();
    expect(close).toHaveBeenCalled();
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
    ).toBe(0);
  });

  it("escalates on the tenth consecutive PIN mismatch", () => {
    const ctx = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
      storage: memStorage(),
    });
    for (let i = 1; i < ESCALATION_THRESHOLD; i++) failAttempt(ctx, i);
    expect(ctx.mgr.isDynamicPinEscalated()).toBe(false);
    failAttempt(ctx, ESCALATION_THRESHOLD);
    expect(ctx.mgr.isDynamicPinEscalated()).toBe(true);
  });

  it("gesture-gates every attempt once escalated, and still offers the method", () => {
    const storage = memStorage();
    storage.setItem(
      "sendspin-pair-failures",
      JSON.stringify({ dynamic_pin: 10 }),
    );
    const { mgr, sent, events, close } = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
      storage,
    });
    expect(mgr.descriptors().map((d) => d.method)).toContain("dynamic_pin");

    mgr.onActivate(["pairing"], dynamic());
    expect(lastOfType(sent, "client/pair-pending")!.payload).toEqual({
      pairing_index: 1,
    });
    expect(lastOfType(sent, "client/pair-init")).toBeUndefined();
    expect(events).toContain("pending");
    expect(close).not.toHaveBeenCalled();

    mgr.openPairingWindow();
    expect(lastOfType(sent, "client/pair-init")).toBeDefined();
  });

  it("de-escalates once a round verifies, so the next attempt needs no gesture", () => {
    const storage = memStorage();
    storage.setItem(
      "sendspin-pair-failures",
      JSON.stringify({ dynamic_pin: 10 }),
    );
    const ctx = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
      storage,
    });
    ctx.mgr.onActivate(["pairing"], dynamic(PIN_LENGTH));
    ctx.mgr.openPairingWindow();
    ctx.mgr.onPairInit({
      nonce_A: base64urlEncode(new Uint8Array(32).fill(0xa1)),
    });
    const server = serverPake(shownPin(ctx));
    ctx.mgr.onPairAuth({ pake_msg_1: base64urlEncode(server.publicShare) });
    const auth = lastOfType(ctx.sent, "client/pair-auth")!;
    server.derive(base64urlDecode(auth.payload!.pake_msg_2 as string));
    ctx.mgr.onPairConfirm({ server_kc: base64urlEncode(server.tag()) });
    ctx.mgr.onPairFinalize();

    expect(ctx.mgr.isDynamicPinEscalated()).toBe(false);
    ctx.mgr.onActivate(["pairing"], dynamic(PIN_LENGTH));
    expect(
      lastOfType(ctx.sent, "client/pair-init")!.payload!.pairing_index,
    ).toBe(2);
  });

  it("gesture-gates a PIN shorter than 6 digits even when not escalated", () => {
    const { mgr, sent } = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
      minPinLength: 4,
    });
    mgr.onActivate(["pairing"], dynamic(5));
    expect(lastOfType(sent, "client/pair-pending")).toBeDefined();
    expect(lastOfType(sent, "client/pair-init")).toBeUndefined();

    mgr.openPairingWindow();
    expect(lastOfType(sent, "client/pair-init")).toBeDefined();
  });

  it("sends pair-init immediately for a 6-digit PIN", () => {
    const { mgr, sent } = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
    });
    mgr.onActivate(["pairing"], dynamic(6));
    expect(lastOfType(sent, "client/pair-pending")).toBeUndefined();
    expect(lastOfType(sent, "client/pair-init")).toBeDefined();
  });

  it("fails closed on a low-order server share", () => {
    const ctx = setup({ category: "sentinel", onPairingCode: vi.fn() });
    ctx.mgr.onActivate(["pairing"], dynamic());
    ctx.mgr.onPairInit({
      nonce_A: base64urlEncode(new Uint8Array(32).fill(0xa1)),
    });
    ctx.mgr.onPairAuth({
      pake_msg_1: base64urlEncode(new Uint8Array(32)), // u = 0
    });
    expect(lastOfType(ctx.sent, "pair/abort")).toBeUndefined();
    expect(ctx.close).toHaveBeenCalledOnce();
  });

  it("fails closed on out-of-order pairing messages", () => {
    const { mgr, sent, close } = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
    });
    mgr.onActivate(["pairing"], dynamic());
    mgr.onPairConfirm({ server_kc: base64urlEncode(new Uint8Array(64)) });
    expect(lastOfType(sent, "pair/abort")).toBeUndefined();
    expect(close).toHaveBeenCalled();
  });

  it("clears the PIN display on leave-pairing", () => {
    const ctx = runToConfirm();
    ctx.mgr.onActivate(["playback"]); // leave pairing
    expect(
      (ctx.onPairingCode as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0],
    ).toBe(null);
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
    const ctx = setup({ category: "sentinel", onPairingCode: vi.fn() });
    ctx.mgr.onActivate(["pairing"], dynamic());
    expect(
      lastOfType(ctx.sent, "client/pair-init")!.payload!.pairing_index,
    ).toBe(1);
    // First attempt aborts (PIN too short); the connection stays open.
    ctx.mgr.onActivate(["playback"]);
    expect(ctx.close).not.toHaveBeenCalled();
    // A fresh pairing activate starts a new attempt with the next index.
    ctx.mgr.onActivate(["pairing"], dynamic());
    expect(
      lastOfType(ctx.sent, "client/pair-init")!.payload!.pairing_index,
    ).toBe(2);
  });

  it("silently discards a stray pairing message after the attempt ended", () => {
    const ctx = setup({ category: "sentinel", onPairingCode: vi.fn() });
    ctx.mgr.onActivate(["pairing"], dynamic());
    ctx.mgr.cancelPairing(); // attempt ends, connection stays open
    // A late server/pair-auth for the ended attempt is ignored, not fatal.
    ctx.mgr.onPairAuth({ pake_msg_1: base64urlEncode(new Uint8Array(32)) });
    expect(ctx.close).not.toHaveBeenCalled();
  });
});

describe("PairingManager (static_pin)", () => {
  const STATIC_PIN = "31415926";

  function staticSetup() {
    return setup({
      category: "sentinel",
      onPairingCode: null,
      staticPairingCode: STATIC_PIN,
    });
  }

  function completeFrom(ctx: ReturnType<typeof staticSetup>) {
    const server = serverPake(STATIC_PIN);
    ctx.mgr.onPairAuth({ pake_msg_1: base64urlEncode(server.publicShare) });
    const auth = lastOfType(ctx.sent, "client/pair-auth")!;
    server.derive(base64urlDecode(auth.payload!.pake_msg_2 as string));
    ctx.mgr.onPairConfirm({ server_kc: base64urlEncode(server.tag()) });
    return server;
  }

  it("signals pair-pending and waits for the gesture before sending pair-init", () => {
    const ctx = staticSetup();
    expect(ctx.mgr.onActivate(["pairing"], { method: "static_pin" })).toBe(
      true,
    );
    expect(lastOfType(ctx.sent, "client/pair-pending")!.payload).toEqual({
      pairing_index: 1,
    });
    expect(lastOfType(ctx.sent, "client/pair-init")).toBeUndefined();
    expect(ctx.events).toContain("pending");

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

  it("reports an abandoned gesture-gated attempt so the app can drop its prompt", () => {
    const ctx = staticSetup();
    ctx.mgr.onActivate(["pairing"], { method: "static_pin" });
    expect(ctx.events).toEqual(["pending"]);
    // The server may leave pairing without first sending pair/abort, which is
    // only a SHOULD, so the client has to surface the end of the attempt itself.
    ctx.mgr.onActivate(["playback"]);
    expect(ctx.events).toEqual(["pending", "aborted"]);
    expect(ctx.details.at(-1)).toBe("server_cancelled");
  });

  it("supersedes a gesture-gated attempt and re-signals under the new index", () => {
    const ctx = staticSetup();
    ctx.mgr.onActivate(["pairing"], { method: "static_pin" });
    ctx.mgr.onActivate(["pairing"], { method: "static_pin" });
    // Without counting the second activate the eventual pair-init would carry a
    // stale index, which the server discards silently and pairing wedges.
    expect(lastOfType(ctx.sent, "client/pair-pending")!.payload).toEqual({
      pairing_index: 2,
    });
    ctx.mgr.openPairingWindow();
    expect(lastOfType(ctx.sent, "client/pair-init")!.payload).toEqual({
      pairing_index: 2,
    });
  });

  it("starts immediately, with no pair-pending, when the window was already open", () => {
    const ctx = staticSetup();
    ctx.mgr.openPairingWindow();
    ctx.mgr.onActivate(["pairing"], { method: "static_pin" });
    expect(lastOfType(ctx.sent, "client/pair-pending")).toBeUndefined();
    expect(lastOfType(ctx.sent, "client/pair-init")).toBeDefined();
  });

  it("keeps no failure counter: repeated mismatches never escalate", () => {
    const storage = memStorage();
    const ctx = setup({
      category: "sentinel",
      onPairingCode: null,
      staticPairingCode: STATIC_PIN,
      storage,
    });
    ctx.mgr.onActivate(["pairing"], { method: "static_pin" });
    ctx.mgr.openPairingWindow();
    const server = serverPake(STATIC_PIN);
    ctx.mgr.onPairAuth({ pake_msg_1: base64urlEncode(server.publicShare) });
    const auth = lastOfType(ctx.sent, "client/pair-auth")!;
    server.derive(base64urlDecode(auth.payload!.pake_msg_2 as string));
    const badTag = server.tag().slice();
    badTag[0] ^= 1;
    ctx.mgr.onPairConfirm({ server_kc: base64urlEncode(badTag) });

    expect(lastOfType(ctx.sent, "pair/abort")!.payload!.reason).toBe(
      "pin_mismatch",
    );
    expect(storage.data.get("sendspin-pair-failures")).toBeUndefined();
  });

  it("the window admits exactly one attempt", () => {
    const ctx = staticSetup();
    ctx.mgr.openPairingWindow();
    ctx.mgr.onActivate(["pairing"], { method: "static_pin" });
    completeFrom(ctx);
    ctx.mgr.onPairFinalize();
    // A new activate must wait for a fresh gesture.
    ctx.mgr.onActivate(["pairing"], { method: "static_pin" });
    const inits = ctx.sent.filter((m) => m.type === "client/pair-init");
    expect(inits).toHaveLength(1);
  });

  it("reset preserves a pre-opened pairing window", () => {
    const ctx = staticSetup();
    ctx.mgr.openPairingWindow();
    // The window is device state: the spec closes it only on a drop of the
    // connection carrying its attempt, and no attempt is in flight here.
    ctx.mgr.reset();
    ctx.mgr.onActivate(["pairing"], { method: "static_pin" });
    expect(lastOfType(ctx.sent, "client/pair-pending")).toBeUndefined();
    expect(lastOfType(ctx.sent, "client/pair-init")).toBeDefined();
  });
});

describe("PairingManager timers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("aborts with attempt_timeout two minutes after pair-init", () => {
    const { mgr, sent, close } = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
    });
    mgr.onActivate(["pairing"], { method: "dynamic_pin", pin_length: 6 });
    vi.advanceTimersByTime(120_000);
    expect(lastOfType(sent, "pair/abort")!.payload!.reason).toBe(
      "attempt_timeout",
    );
    expect(close).not.toHaveBeenCalled();
  });

  it("expires an unused pairing window silently", () => {
    const ctx = setup({
      category: "sentinel",
      onPairingCode: null,
      staticPairingCode: "31415926",
    });
    ctx.mgr.openPairingWindow();
    vi.advanceTimersByTime(300_000);
    ctx.mgr.onActivate(["pairing"], { method: "static_pin" });
    // Window expired: the attempt waits for a fresh gesture.
    expect(lastOfType(ctx.sent, "client/pair-init")).toBeUndefined();
    expect(ctx.close).not.toHaveBeenCalled();
  });

  it("waits indefinitely for the gesture, leaving the timeout to the server", () => {
    const ctx = setup({
      category: "sentinel",
      onPairingCode: null,
      staticPairingCode: "31415926",
    });
    ctx.mgr.onActivate(["pairing"], { method: "static_pin" });
    vi.advanceTimersByTime(600_000);
    expect(ctx.close).not.toHaveBeenCalled();
    expect(lastOfType(ctx.sent, "pair/abort")).toBeUndefined();
    // The gesture still starts the attempt after the wait.
    ctx.mgr.openPairingWindow();
    expect(lastOfType(ctx.sent, "client/pair-init")).toBeDefined();
  });

  it("static attempts also honor the attempt timeout", () => {
    const ctx = setup({
      category: "sentinel",
      onPairingCode: null,
      staticPairingCode: "31415926",
    });
    ctx.mgr.onActivate(["pairing"], { method: "static_pin" });
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
