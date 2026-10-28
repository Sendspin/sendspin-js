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
import { commitNonce, derivePairingCode } from "../../src/core/pake/pin";
import { SUITES } from "../../src/core/noise/suites";
import { sha256 } from "@noble/hashes/sha2";

const utf8 = (s: string) => new TextEncoder().encode(s);
const EMPTY = new Uint8Array(0);
const CPACE_AD_A = utf8("server");
const CPACE_AD_B = utf8("client");
const PSK_WRAP_LABEL = utf8("sendspin-pair-psk-wrap-v1");
const NONCE_WRAP_LABEL = utf8("sendspin-pair-nonce-wrap-v1");

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

// CPace sid = label || h || big-endian uint32 attempt counter || uint32 round.
function sidFor(index: number, round = 1): Uint8Array {
  const label = utf8("sendspin-pair-pake-v1");
  const sid = new Uint8Array(label.length + HANDSHAKE_HASH.length + 8);
  sid.set(label, 0);
  sid.set(HANDSHAKE_HASH, label.length);
  const view = new DataView(sid.buffer);
  view.setUint32(label.length + HANDSHAKE_HASH.length, index, false);
  view.setUint32(label.length + HANDSHAKE_HASH.length + 4, round, false);
  return sid;
}

// The negotiated-suite AEAD the manager uses to wrap code-flow values.
const aeadSeal = (key: Uint8Array, pt: Uint8Array) =>
  SUITES.chacha.aeadEncrypt(key, 0n, EMPTY, pt);

// Server side: recover a wrapped value from the CPace ISK and sid.
function unwrap(
  label: Uint8Array,
  wrapped: Uint8Array,
  sid: Uint8Array,
  isk: Uint8Array,
): Uint8Array {
  const kWrap = sha256(concatBytes(label, sid, isk));
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

/** A dynamic pairing code activation in the digits format. */
function dynamic(languages?: string[]): ActivatePairing {
  return { method: "dynamic_pairing_code", format: "digits", languages };
}

/** Drive the server (initiator) side of a PIN PAKE against the manager. */
function serverPake(pin: string, index = 1, round = 1) {
  return CPace.start({
    role: "initiator",
    prs: utf8(pin),
    sid: sidFor(index, round),
    ada: CPACE_AD_A,
    adb: CPACE_AD_B,
  });
}

describe("PairingManager (pairing_psk)", () => {
  it("finalizes a pairing_psk flow and persists a bound record", () => {
    const { store, sent, mgr } = setup();
    mgr.onActivate(["pairing"], { method: "pairing_psk" });
    expect(sent.map((m) => m.type)).toEqual([
      "client/pair-init",
      "client/pair-finalize",
    ]);
    expect(sent[0]!.payload).toEqual({ pairing_index: 1 });
    const fin = sent[1] as { type: string; payload: { long_term_psk: string } };
    expect(fin.payload.long_term_psk).toHaveLength(43);

    mgr.onPairFinalize();
    const ltPsk = base64urlDecode(fin.payload.long_term_psk);
    expect(store.lookup(pskId(ltPsk))?.serverId).toBe("SERVER_ID");
  });

  it("aborts an unsupported method and keeps the connection open", () => {
    const { sent, close, mgr } = setup();
    mgr.onActivate(["pairing"], { method: "static_pairing_code" }); // not configured
    expect(sent[0]!.type).toBe("pair/abort");
    expect(sent[0]!.payload!.reason).toBe("method_not_supported");
    expect(close).not.toHaveBeenCalled();
  });

  it("ignores a pairing object on a non-pairing activation", () => {
    const { sent, close, mgr } = setup();
    // Spec: "A client ignores this field when activities does not include
    // 'pairing'". No abort, no close, and no attempt started.
    mgr.onActivate(["playback"], { method: "pairing_psk" });
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
    mgr.onAbort("pairing_code_mismatch");
    expect(close).not.toHaveBeenCalled();
    expect(events).toContain("aborted");
  });

  it("ignores an inbound pair/abort when no attempt is in progress", () => {
    const { close, events, mgr } = setup();
    mgr.onAbort("pairing_code_mismatch");
    expect(close).not.toHaveBeenCalled();
    expect(events).not.toContain("aborted");
  });

  it("supersedes a running attempt when another pairing activate arrives", () => {
    const { sent, events, mgr } = setup();
    mgr.onActivate(["pairing"], { method: "pairing_psk" });
    mgr.onActivate(["pairing"], { method: "pairing_psk" });
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
    const { store, sent, close, mgr } = setup();
    mgr.onActivate(["pairing"], { method: "pairing_psk" });
    const fin = lastOfType(sent, "client/pair-finalize") as {
      payload: { long_term_psk: string };
    };
    mgr.onActivate(["playback"]); // leave pairing without finalize
    // The server left pairing itself, so a later server/pair-finalize is out of sequence.
    mgr.onPairFinalize();
    expect(close).toHaveBeenCalled();
    expect(
      store.lookup(pskId(base64urlDecode(fin.payload.long_term_psk))),
    ).toBeNull();
  });
});

describe("client/hello supported_pair_methods", () => {
  it("advertises only pairing_psk by default, with no locations hint", () => {
    const { mgr } = setup({ onPairingCode: null });
    // The hint says where the operator finds the secret, which only the
    // integrator knows, so an unconfigured client claims nothing.
    expect(mgr.supportedPairMethods()).toEqual({ pairing_psk: {} });
  });

  it("advertises dynamic_pairing_code with out_channels and the digits format when onPairingCode is set", () => {
    const { mgr } = setup({ onPairingCode: vi.fn() });
    expect(mgr.supportedPairMethods().dynamic_pairing_code).toEqual({
      out_channels: ["display"],
      formats: ["digits"],
    });
  });

  it("advertises the configured out-channels", () => {
    const { mgr } = setup({
      onPairingCode: vi.fn(),
      pairingCodeOutChannels: ["display", "speaker"],
    });
    expect(
      mgr.supportedPairMethods().dynamic_pairing_code!.out_channels,
    ).toEqual(["display", "speaker"]);
  });

  it("advertises static_pairing_code without a locations hint when unconfigured", () => {
    const { mgr } = setup({
      onPairingCode: null,
      staticPairingCode: "12345678",
    });
    expect(mgr.supportedPairMethods().static_pairing_code).toEqual({});
  });

  it("omits an empty locations list rather than advertising it", () => {
    const { mgr } = setup({
      onPairingCode: null,
      staticPairingCode: "12345678",
      staticPairingCodeLocations: [],
    });
    expect(mgr.supportedPairMethods().static_pairing_code).toEqual({});
  });

  it("advertises the configured secret locations", () => {
    const { mgr } = setup({
      onPairingCode: null,
      staticPairingCode: "12345678",
      staticPairingCodeLocations: ["device", "leaflet"],
      pairingPskLocations: ["leaflet"],
    });
    expect(mgr.supportedPairMethods()).toEqual({
      pairing_psk: { locations: ["leaflet"] },
      static_pairing_code: { locations: ["device", "leaflet"] },
    });
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

describe("PairingManager (dynamic_pairing_code)", () => {
  /** The PIN most recently surfaced to the app. */
  function shownPin(ctx: ReturnType<typeof setup>): string {
    return (ctx.onPairingCode as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0])
      .filter((p): p is string => typeof p === "string")
      .at(-1)!;
  }

  /** Send a server_kc that fails to verify. */
  function failConfirm(server: CPace, mgr: PairingManager): void {
    const badTag = server.tag().slice();
    badTag[0] ^= 1;
    mgr.onPairConfirm({ server_kc: base64urlEncode(badTag) });
  }

  function storedRounds(storage: { data: Map<string, string> }): number {
    return JSON.parse(storage.data.get("sendspin-pair-failures")!).dynamic_pin;
  }

  function storageWithRounds(rounds: number) {
    const storage = memStorage();
    storage.setItem(
      "sendspin-pair-failures",
      JSON.stringify({ dynamic_pin: rounds }),
    );
    return storage;
  }

  function runToConfirm(opts: SetupOpts = {}, pairing = dynamic()) {
    const ctx = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
      ...opts,
    });
    ctx.mgr.onActivate(["pairing"], pairing);

    // client/pair-init carries commit_B = SHA-256(nonce_B).
    const init = lastOfType(ctx.sent, "client/pair-init")!;
    const commitB = base64urlDecode(init.payload!.commit_B as string);
    expect(commitB).toHaveLength(32);

    // server/pair-init carries only nonce_A.
    const nonceA = new Uint8Array(32).fill(0xa1);
    ctx.mgr.onPairInit({ nonce_A: base64urlEncode(nonceA) });
    const pin = shownPin(ctx);
    expect(pin).toMatch(/^[0-9]{6}$/);

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
    expect(confirm.payload!.nonce_B).toBeUndefined();
    const nonceB = unwrap(
      NONCE_WRAP_LABEL,
      base64urlDecode(confirm.payload!.wrapped_nonce_B as string),
      sidFor(1),
      server.isk,
    );
    expect(commitNonce(nonceB)).toEqual(commitB);
    expect(derivePairingCode(HANDSHAKE_HASH, nonceA, nonceB)).toBe(shownPin);

    // client/pair-finalize follows back-to-back, carrying the wrapped PSK.
    const fin = lastOfType(sent, "client/pair-finalize")!;
    expect(fin.payload!.wrapped_psk).toHaveLength(64);
    expect(fin.payload!.long_term_psk).toBeUndefined();

    mgr.onPairFinalize();
    // The server unwraps with the shared CPace output and recovers the PSK.
    const ltPsk = unwrap(
      PSK_WRAP_LABEL,
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
    const ctx = runToConfirm({}, dynamic(["ca", "es", "en"]));
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
      method: "dynamic_pairing_code",
      format: "digits",
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

  it("fails closed when a dynamic_pairing_code activation omits format", () => {
    const { mgr, sent, close } = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
    });
    mgr.onActivate(["pairing"], { method: "dynamic_pairing_code" });
    expect(lastOfType(sent, "pair/abort")).toBeUndefined();
    expect(close).toHaveBeenCalled();
  });

  it("aborts with method_not_supported on a format the client does not offer", () => {
    const { mgr, sent, close } = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
    });
    mgr.onActivate(["pairing"], {
      method: "dynamic_pairing_code",
      format: "qr_code",
    });
    expect(lastOfType(sent, "pair/abort")!.payload!.reason).toBe(
      "method_not_supported",
    );
    expect(lastOfType(sent, "client/pair-init")).toBeUndefined();
    expect(close).not.toHaveBeenCalled();
  });

  it("asks for another round with the same code on a bad server tag", () => {
    const ctx = runToConfirm();
    failConfirm(ctx.server, ctx.mgr);
    expect(lastOfType(ctx.sent, "client/pair-retry")!.payload).toEqual({});
    expect(lastOfType(ctx.sent, "pair/abort")).toBeUndefined();

    // Later rounds carry no nonce_A and bind their own round number into the sid.
    ctx.mgr.onPairInit({});
    expect(shownPin(ctx)).toBe(ctx.shownPin);
    const server = serverPake(ctx.shownPin, 1, 2);
    ctx.mgr.onPairAuth({ pake_msg_1: base64urlEncode(server.publicShare) });
    const auth = lastOfType(ctx.sent, "client/pair-auth")!;
    server.derive(base64urlDecode(auth.payload!.pake_msg_2 as string));
    ctx.mgr.onPairConfirm({ server_kc: base64urlEncode(server.tag()) });
    const confirm = lastOfType(ctx.sent, "client/pair-confirm")!;
    expect(
      server.verify(base64urlDecode(confirm.payload!.client_kc as string)),
    ).toBe(true);
    expect(ctx.close).not.toHaveBeenCalled();
  });

  it("fails closed on a nonce_A in a later round", () => {
    const ctx = runToConfirm();
    failConfirm(ctx.server, ctx.mgr);
    ctx.mgr.onPairInit({
      nonce_A: base64urlEncode(new Uint8Array(32).fill(0xb2)),
    });
    expect(ctx.close).toHaveBeenCalled();
  });

  it("aborts instead of retrying at the round limit", () => {
    const storage = storageWithRounds(19);
    const ctx = runToConfirm({ storage });
    failConfirm(ctx.server, ctx.mgr);
    expect(lastOfType(ctx.sent, "pair/abort")!.payload!.reason).toBe(
      "pairing_code_mismatch",
    );
    expect(lastOfType(ctx.sent, "client/pair-retry")).toBeUndefined();
    expect(ctx.mgr.isRoundLimitReached()).toBe(true);
  });

  it("resets the round count when the server tag verifies", () => {
    const storage = storageWithRounds(9);
    const ctx = runToConfirm({ storage });
    ctx.mgr.onPairConfirm({ server_kc: base64urlEncode(ctx.server.tag()) });
    expect(storedRounds(storage)).toBe(0);
  });

  it("counts an abandoned attempt only once the code was shown", () => {
    const storage = memStorage();
    const ctx = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
      storage,
    });
    ctx.mgr.onActivate(["pairing"], dynamic());
    ctx.mgr.onActivate(["playback"]);
    expect(storage.data.get("sendspin-pair-failures")).toBeUndefined();

    ctx.mgr.onActivate(["pairing"], dynamic());
    ctx.mgr.onPairInit({
      nonce_A: base64urlEncode(new Uint8Array(32).fill(0xa1)),
    });
    ctx.mgr.onActivate(["playback"]);
    expect(storedRounds(storage)).toBe(1);
  });

  it("holds attempts back at the round limit until released, and still offers the method", () => {
    const storage = storageWithRounds(20);
    const { mgr, sent, events, close } = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
      storage,
    });
    expect(mgr.supportedPairMethods().dynamic_pairing_code).toBeDefined();

    mgr.onActivate(["pairing"], dynamic());
    expect(lastOfType(sent, "client/pair-pending")!.payload).toEqual({
      pairing_index: 1,
    });
    expect(events).toContain("pending");
    expect(close).not.toHaveBeenCalled();

    // The static pairing window does not release a dynamic hold.
    mgr.openPairingWindow();
    expect(lastOfType(sent, "client/pair-init")).toBeUndefined();

    mgr.releasePairingHold();
    expect(lastOfType(sent, "client/pair-init")).toBeDefined();
    expect(storedRounds(storage)).toBe(0);
  });

  it("does not reset the round count on a release during an attempt", () => {
    const storage = storageWithRounds(19);
    const ctx = runToConfirm({ storage });
    ctx.mgr.releasePairingHold();
    expect(storedRounds(storage)).toBe(20);
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

  it("fails closed on server/pair-finalize before the client finalized", () => {
    const ctx = runToConfirm();
    ctx.mgr.onPairFinalize();
    expect(ctx.close).toHaveBeenCalled();
  });

  it("fails closed on a pairing message when no attempt ran", () => {
    const ctx = setup({ category: "sentinel", onPairingCode: vi.fn() });
    ctx.mgr.onPairAuth({ pake_msg_1: base64urlEncode(new Uint8Array(32)) });
    expect(ctx.close).toHaveBeenCalled();
  });

  it.each([
    [
      "server/pair-init",
      (mgr: PairingManager) =>
        mgr.onPairInit({ nonce_A: base64urlEncode(new Uint8Array(32)) }),
    ],
    [
      "server/pair-auth",
      (mgr: PairingManager) =>
        mgr.onPairAuth({ pake_msg_1: base64urlEncode(new Uint8Array(32)) }),
    ],
    [
      "server/pair-confirm",
      (mgr: PairingManager) =>
        mgr.onPairConfirm({ server_kc: base64urlEncode(new Uint8Array(64)) }),
    ],
    ["server/pair-finalize", (mgr: PairingManager) => mgr.onPairFinalize()],
  ])("silently discards a stray %s after the client aborted", (_type, send) => {
    const ctx = setup({ category: "sentinel", onPairingCode: vi.fn() });
    ctx.mgr.onActivate(["pairing"], dynamic());
    ctx.mgr.cancelPairing(); // attempt ends, connection stays open
    send(ctx.mgr);
    expect(ctx.close).not.toHaveBeenCalled();
  });

  it("stops discarding stray pairing messages at the next server/activate", () => {
    const ctx = setup({ category: "sentinel", onPairingCode: vi.fn() });
    ctx.mgr.onActivate(["pairing"], dynamic());
    ctx.mgr.cancelPairing();
    ctx.mgr.onActivate(["playback"]);
    ctx.mgr.onPairAuth({ pake_msg_1: base64urlEncode(new Uint8Array(32)) });
    expect(ctx.close).toHaveBeenCalled();
  });
});

describe("PairingManager (static_pairing_code)", () => {
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
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
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
    expect(confirm.payload!.wrapped_nonce_B).toBeUndefined();

    const fin = lastOfType(ctx.sent, "client/pair-finalize")!;
    ctx.mgr.onPairFinalize();
    const ltPsk = unwrap(
      PSK_WRAP_LABEL,
      base64urlDecode(fin.payload!.wrapped_psk as string),
      sidFor(1),
      server.isk,
    );
    expect(ctx.store.lookup(pskId(ltPsk))?.serverId).toBe("SERVER_ID");
  });

  it("reports an abandoned gesture-gated attempt so the app can drop its prompt", () => {
    const ctx = staticSetup();
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
    expect(ctx.events).toEqual(["pending"]);
    // The server may leave pairing without first sending pair/abort, which is
    // only a SHOULD, so the client has to surface the end of the attempt itself.
    ctx.mgr.onActivate(["playback"]);
    expect(ctx.events).toEqual(["pending", "aborted"]);
    expect(ctx.details.at(-1)).toBe("server_cancelled");
  });

  it("supersedes a gesture-gated attempt and re-signals under the new index", () => {
    const ctx = staticSetup();
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
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
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
    expect(lastOfType(ctx.sent, "client/pair-pending")).toBeUndefined();
    expect(lastOfType(ctx.sent, "client/pair-init")).toBeDefined();
  });

  it("keeps no round count: a mismatch aborts without counting", () => {
    const storage = memStorage();
    const ctx = setup({
      category: "sentinel",
      onPairingCode: null,
      staticPairingCode: STATIC_PIN,
      storage,
    });
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
    ctx.mgr.openPairingWindow();
    const server = serverPake(STATIC_PIN);
    ctx.mgr.onPairAuth({ pake_msg_1: base64urlEncode(server.publicShare) });
    const auth = lastOfType(ctx.sent, "client/pair-auth")!;
    server.derive(base64urlDecode(auth.payload!.pake_msg_2 as string));
    const badTag = server.tag().slice();
    badTag[0] ^= 1;
    ctx.mgr.onPairConfirm({ server_kc: base64urlEncode(badTag) });

    expect(lastOfType(ctx.sent, "pair/abort")!.payload!.reason).toBe(
      "pairing_code_mismatch",
    );
    expect(storage.data.get("sendspin-pair-failures")).toBeUndefined();
  });

  it("closes the window on a completed pairing", () => {
    const ctx = staticSetup();
    ctx.mgr.openPairingWindow();
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
    completeFrom(ctx);
    ctx.mgr.onPairFinalize();
    // A new activate must wait for a fresh gesture.
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
    const inits = ctx.sent.filter((m) => m.type === "client/pair-init");
    expect(inits).toHaveLength(1);
  });

  it("closes the window on its fifth failed attempt", () => {
    const ctx = staticSetup();
    ctx.mgr.openPairingWindow();
    for (let index = 1; index <= 5; index++) {
      ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
      expect(
        lastOfType(ctx.sent, "client/pair-init")!.payload!.pairing_index,
      ).toBe(index);
      const server = serverPake(STATIC_PIN, index);
      ctx.mgr.onPairAuth({ pake_msg_1: base64urlEncode(server.publicShare) });
      const auth = lastOfType(ctx.sent, "client/pair-auth")!;
      server.derive(base64urlDecode(auth.payload!.pake_msg_2 as string));
      const badTag = server.tag().slice();
      badTag[0] ^= 1;
      ctx.mgr.onPairConfirm({ server_kc: base64urlEncode(badTag) });
    }
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
    expect(lastOfType(ctx.sent, "client/pair-pending")!.payload).toEqual({
      pairing_index: 6,
    });
  });

  it("closes the window when the connection carrying its attempt drops", () => {
    const ctx = staticSetup();
    ctx.mgr.openPairingWindow();
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
    ctx.mgr.onConnectionClosed();
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
    expect(lastOfType(ctx.sent, "client/pair-pending")).toBeDefined();
  });

  it("keeps the window bound when reopened during an attempt", () => {
    const ctx = staticSetup();
    ctx.mgr.openPairingWindow();
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
    ctx.mgr.openPairingWindow();
    ctx.mgr.onConnectionClosed();
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
    expect(lastOfType(ctx.sent, "client/pair-pending")).toBeDefined();
  });

  it("keeps a window with no attempt open across a drop", () => {
    const ctx = staticSetup();
    ctx.mgr.openPairingWindow();
    ctx.mgr.onConnectionClosed();
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
    expect(lastOfType(ctx.sent, "client/pair-pending")).toBeUndefined();
    expect(lastOfType(ctx.sent, "client/pair-init")).toBeDefined();
  });

  it("closes an open window on cancelPairing with no attempt running", () => {
    const ctx = staticSetup();
    ctx.mgr.openPairingWindow();
    ctx.mgr.cancelPairing();
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
    expect(lastOfType(ctx.sent, "client/pair-pending")).toBeDefined();
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
    mgr.onActivate(["pairing"], dynamic());
    vi.advanceTimersByTime(120_000);
    expect(lastOfType(sent, "pair/abort")!.payload!.reason).toBe(
      "attempt_timeout",
    );
    expect(close).not.toHaveBeenCalled();
  });

  it("keeps the attempt timeout running across a retry", () => {
    const { mgr, sent, onPairingCode } = setup({
      category: "sentinel",
      onPairingCode: vi.fn(),
    });
    mgr.onActivate(["pairing"], dynamic());
    vi.advanceTimersByTime(60_000);
    mgr.onPairInit({ nonce_A: base64urlEncode(new Uint8Array(32).fill(0xa1)) });
    const pin = (onPairingCode as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const server = serverPake(pin);
    mgr.onPairAuth({ pake_msg_1: base64urlEncode(server.publicShare) });
    const auth = lastOfType(sent, "client/pair-auth")!;
    server.derive(base64urlDecode(auth.payload!.pake_msg_2 as string));
    const badTag = server.tag().slice();
    badTag[0] ^= 1;
    mgr.onPairConfirm({ server_kc: base64urlEncode(badTag) });
    expect(lastOfType(sent, "client/pair-retry")).toBeDefined();
    vi.advanceTimersByTime(60_000);
    expect(lastOfType(sent, "pair/abort")!.payload!.reason).toBe(
      "attempt_timeout",
    );
  });

  it("expires an unused pairing window silently", () => {
    const ctx = setup({
      category: "sentinel",
      onPairingCode: null,
      staticPairingCode: "31415926",
    });
    ctx.mgr.openPairingWindow();
    vi.advanceTimersByTime(300_000);
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
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
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
    vi.advanceTimersByTime(600_000);
    expect(ctx.close).not.toHaveBeenCalled();
    expect(lastOfType(ctx.sent, "pair/abort")).toBeUndefined();
    // The gesture still starts the attempt after the wait.
    ctx.mgr.openPairingWindow();
    expect(lastOfType(ctx.sent, "client/pair-init")).toBeDefined();
  });

  it("keeps the window open after a timed-out attempt", () => {
    const ctx = setup({
      category: "sentinel",
      onPairingCode: null,
      staticPairingCode: "31415926",
    });
    ctx.mgr.openPairingWindow();
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
    vi.advanceTimersByTime(120_000);
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
    expect(lastOfType(ctx.sent, "client/pair-pending")).toBeUndefined();
    expect(
      lastOfType(ctx.sent, "client/pair-init")!.payload!.pairing_index,
    ).toBe(2);
  });

  it("static attempts also honor the attempt timeout", () => {
    const ctx = setup({
      category: "sentinel",
      onPairingCode: null,
      staticPairingCode: "31415926",
    });
    ctx.mgr.onActivate(["pairing"], { method: "static_pairing_code" });
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
