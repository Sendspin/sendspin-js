import type { PskStore, PskCategory } from "./noise/psk";
import { base64urlEncode, base64urlDecode } from "./noise/base64url";
import type {
  ActivatePairing,
  PairAbortReason,
  PairCodeFormat,
  PairMethod,
  PairOutChannel,
  PairSecretLocation,
  SendspinStorage,
  SupportedPairMethods,
} from "../types";
import { CPace, CPaceError, SHARE_SIZE, TAG_SIZE } from "./pake/cpace";
import {
  NONCE_SIZE,
  commitNonce,
  derivePairingCode,
  deriveQrPairingCode,
  generateNonce,
  isValidStaticPairingCode,
} from "./pake/pin";
import { sha256 } from "@noble/hashes/sha2";
import { encodeQrCodeToken } from "./noise/pairing-token";

export type PairingEvent = "pending" | "started" | "finalized" | "aborted";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** CPace session-id label. sid = label || Noise handshake hash || counter || round. */
const PAKE_SID_LABEL = "sendspin-pair-pake-v1";
/** Labels for the keys that wrap the PSK and nonce_B in code pairing (Wrapping). */
const PSK_WRAP_LABEL = utf8("sendspin-pair-psk-wrap-v1");
const NONCE_WRAP_LABEL = utf8("sendspin-pair-nonce-wrap-v1");
/** CPace associated data: distinct per side to prevent a reflected MAC. */
const CPACE_AD_A = utf8("server");
const CPACE_AD_B = utf8("client");
/** A PIN pairing attempt must complete within this bound (spec: 2 minutes). */
const ATTEMPT_TIMEOUT_MS = 120_000;
/** Lifetime of a pairing window, from the gesture. */
const WINDOW_LIFETIME_MS = 300_000;
/** A pairing window closes on this many failed server_kc verifications. */
const WINDOW_FAILURE_LIMIT = 5;
/** Rounds since the last verified server_kc that hold dynamic attempts back. */
const ROUND_LIMIT = 20;
/** Persisted round count (dynamic pairing code only, not partitioned by server). */
const ROUNDS_STORAGE_KEY = "sendspin-pair-failures";
/** Field of the stored round count, kept as earlier releases wrote it. */
const ROUNDS_FIELD = "dynamic_pin";

const CODE_METHODS: readonly PairMethod[] = [
  "dynamic_pairing_code",
  "static_pairing_code",
];

/** Only advertise a locations hint the integrator actually configured. */
function withLocations(locations?: PairSecretLocation[]): {
  locations?: PairSecretLocation[];
} {
  return locations?.length ? { locations } : {};
}

/** A languages hint that is not a non-empty list of tags is treated as absent. */
function readLanguages(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((tag) => typeof tag === "string" && tag !== "")
    ? (value as string[])
    : undefined;
}

type Phase =
  | "idle"
  /** Held back: client/pair-pending sent, waiting for the operator. */
  | "held-back"
  /** Dynamic pairing code: awaiting server/pair-init, which begins a round. */
  | "await-init"
  /** Awaiting server/pair-auth (the server's CPace share). */
  | "await-auth"
  /** Awaiting server/pair-confirm (the server's confirmation tag). */
  | "await-confirm"
  /** client/pair-finalize sent, awaiting server/pair-finalize. */
  | "await-finalize";

export interface PairingDeps {
  sendControl(msg: object): void;
  /** Close the WebSocket. pair/abort requires the sender to close after sending. */
  close(): void;
  pskStore: PskStore;
  serverId(): string;
  matchedCategory(): PskCategory;
  /** The Noise handshake hash h, which PIN derivation and the PAKE sid bind to. */
  handshakeHash(): Uint8Array;
  /**
   * Seal a 32-byte code-flow value under the negotiated AEAD (zero nonce,
   * empty AD). key is K_wrap. Returns the 48-byte wrapped value.
   */
  aeadSeal(key: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** Persists the dynamic pairing code round count. Null = in-memory only. */
  storage: SendspinStorage | null;
  /** Enables dynamic_pairing_code: surfaces the code (null = attempt ended, hide it). */
  onPairingCode:
    | ((
        code: string | null,
        languages?: string[],
        format?: PairCodeFormat,
      ) => void)
    | null;
  /** Channels advertised for dynamic pairing code emission. Default ["display"]. */
  pairingCodeOutChannels?: PairOutChannel[];
  /** Emission formats advertised for the dynamic pairing code. Default ["digits"]. */
  pairingCodeFormats?: PairCodeFormat[];
  /** Enables static_pairing_code: this device's fixed 8-digit pairing code. */
  staticPairingCode?: string;
  /** Where the operator finds the static pairing code. Omitted when unset. */
  staticPairingCodeLocations?: PairSecretLocation[];
  /** Where the operator finds the Pairing PSK. Omitted when unset. */
  pairingPskLocations?: PairSecretLocation[];
  onEvent?(e: PairingEvent, detail?: string): void;
}

export class PairingManager {
  private pendingPsk: Uint8Array | null = null;
  private phase: Phase = "idle";
  private method: PairMethod | null = null;
  private cpace: CPace | null = null;
  private nonceB: Uint8Array | null = null;
  private attemptTimer: ReturnType<typeof setTimeout> | null = null;
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the operator's pairing-window gesture is currently live. */
  private windowOpen = false;
  /** Whether the open window carried an attempt on the current connection. */
  private windowBound = false;
  private windowFailures = 0;
  /** The CPace sid for the current PIN attempt (for PSK wrapping). */
  private currentSid: Uint8Array | null = null;
  /** Pairing server/activate messages received since the last Noise handshake. */
  private pairingActivateCount = 0;
  /** The counter for the current attempt (pairing_index and CPace sid counter). */
  private attemptIndex = 0;
  /** The activation's spoken-PIN language preferences, in descending order. */
  private languages: string[] | undefined;
  /** The emission format of the current dynamic pairing code attempt. */
  private format: PairCodeFormat | null = null;
  /** The dynamic pairing code of the current attempt as shown to the app. */
  private code: string | null = null;
  /** The CPace PRS of the current dynamic pairing code attempt. */
  private prs: Uint8Array | null = null;
  /** The current round of the attempt, 0 before its first server/pair-init. */
  private round = 0;
  /** Dynamic pairing code rounds since the last verified server_kc, persisted. */
  private rounds: number;
  /** Set once the client sends pair/abort, until the next server/activate. */
  private discardStray = false;

  constructor(private deps: PairingDeps) {
    if (
      deps.staticPairingCode !== undefined &&
      !isValidStaticPairingCode(deps.staticPairingCode)
    ) {
      throw new Error("staticPairingCode must be exactly 8 decimal digits");
    }
    const formats = deps.pairingCodeFormats;
    if (formats?.length === 0) {
      throw new Error("pairingCodeFormats must not be empty");
    }
    if (
      formats?.includes("qr_code") &&
      !(deps.pairingCodeOutChannels ?? ["display"]).includes("display")
    ) {
      throw new Error(
        "qr_code in pairingCodeFormats needs display in pairingCodeOutChannels",
      );
    }
    this.rounds = this.loadRounds();
  }

  /** The pairing methods to advertise in client/hello. */
  supportedPairMethods(): SupportedPairMethods {
    const methods: SupportedPairMethods = {
      pairing_psk: withLocations(this.deps.pairingPskLocations),
    };
    if (this.deps.staticPairingCode !== undefined) {
      methods.static_pairing_code = withLocations(
        this.deps.staticPairingCodeLocations,
      );
    }
    if (this.deps.onPairingCode) {
      methods.dynamic_pairing_code = {
        out_channels: this.deps.pairingCodeOutChannels ?? ["display"],
        formats: this.deps.pairingCodeFormats ?? ["digits"],
      };
    }
    return methods;
  }

  /**
   * Whether dynamic pairing code attempts are held back at the round limit.
   * The method stays offered, and attempts wait for releasePairingHold().
   */
  isRoundLimitReached(): boolean {
    return this.rounds >= ROUND_LIMIT;
  }

  /**
   * Operator action that releases dynamic pairing code attempts held back at
   * the round limit and resets the round count. Has no effect while an
   * attempt is running.
   */
  releasePairingHold(): void {
    if (!this.isRoundLimitReached()) return;
    if (this.phase !== "idle" && this.phase !== "held-back") return;
    this.resetRounds();
    if (this.phase === "held-back" && !this.isHeldBack()) this.startAttempt();
  }

  /**
   * Operator gesture that opens the pairing window for about 5 minutes. If an
   * attempt is already waiting on it the attempt starts immediately.
   */
  openPairingWindow(): void {
    // Keep the binding, since an attempt may be running on this connection.
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowOpen = true;
    this.windowFailures = 0;
    this.windowTimer = setTimeout(() => this.closeWindow(), WINDOW_LIFETIME_MS);
    if (this.phase === "held-back" && !this.isHeldBack()) this.startAttempt();
  }

  private closeWindow(): void {
    this.windowOpen = false;
    this.windowBound = false;
    this.windowFailures = 0;
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = null;
  }

  /**
   * Operator cancellation: close the pairing window and cancel any attempt
   * with pair/abort user_cancelled.
   */
  cancelPairing(): void {
    this.closeWindow();
    if (this.phase === "idle") return;
    this.abort("user_cancelled");
  }

  /** Called for every server/activate. */
  onActivate(activities: string[], pairing?: ActivatePairing): void {
    this.discardStray = false;
    const isPairing = activities.includes("pairing");
    if (!isPairing) {
      // Non-pairing activate in place of pair-finalize = leave-pairing.
      this.abandonAttempt("server_cancelled");
      return;
    }
    // A pairing activate arriving mid-attempt supersedes it: the server has
    // moved on, and any message still carrying the old index is discarded.
    this.abandonAttempt("superseded");
    // Each pairing activate is one attempt, indexed for pairing_index and sid.
    this.pairingActivateCount += 1;
    this.attemptIndex = this.pairingActivateCount;
    const method = pairing?.method;
    const offered = this.supportedPairMethods();
    // pairing_psk exactly when the matched PSK is the Pairing PSK, a PIN method otherwise.
    const fitsPsk =
      (method === "pairing_psk") ===
      (this.deps.matchedCategory() === "pairing");
    if (!method) {
      // A required field no conformant server omits, so it is a protocol error
      // rather than a rejection: close without any application-level message.
      // The log is local, so it still tells the integrator what went wrong.
      console.warn(
        "sendspin: server/activate carried no pairing method, so the server is not speaking the current specification.",
      );
      this.fail();
      return;
    }
    // A method the PSK disallows or the client no longer offers is something a
    // conformant server can produce, since its view of the config may be stale.
    if (!fitsPsk || !Object.keys(offered).includes(method)) {
      this.abort("method_not_supported");
      return;
    }
    this.method = method;
    if (method === "dynamic_pairing_code") {
      const format = pairing.format;
      // A missing format is a protocol error, like a missing method.
      if (typeof format !== "string") {
        this.fail();
        return;
      }
      if (!offered.dynamic_pairing_code!.formats.includes(format)) {
        this.abort("method_not_supported");
        return;
      }
      this.format = format;
      this.languages = readLanguages(pairing.languages);
    }
    if (this.isHeldBack()) {
      this.phase = "held-back";
      // pair-pending does not start the attempt, so no attempt timer runs. The
      // server bounds the wait and cancels with a non-pairing server/activate.
      this.deps.sendControl({
        type: "client/pair-pending",
        payload: { pairing_index: this.attemptIndex },
      });
      this.deps.onEvent?.("pending");
      return;
    }
    this.startAttempt();
  }

  /**
   * Whether the selected method withholds client/pair-init: static pairing
   * code until a window is open, dynamic pairing code at the round limit.
   */
  private isHeldBack(): boolean {
    if (this.method === "static_pairing_code") return !this.windowOpen;
    return this.method === "dynamic_pairing_code" && this.isRoundLimitReached();
  }

  /** server/pair-init: begins a round, carrying the server's nonce in the first. */
  onPairInit(payload: { nonce_A?: string }): void {
    if (this.phase === "idle") return this.strayMessage();
    if (this.phase !== "await-init" || this.method !== "dynamic_pairing_code") {
      return this.fail();
    }
    const h = this.deps.handshakeHash();
    if (this.round === 0) {
      const nonceA = this.decode(payload.nonce_A, NONCE_SIZE);
      if (!nonceA) return this.fail();
      if (this.format === "qr_code") {
        this.prs = deriveQrPairingCode(h, nonceA, this.nonceB!);
        this.code = encodeQrCodeToken(this.prs);
      } else {
        this.code = derivePairingCode(h, nonceA, this.nonceB!);
        this.prs = utf8(this.code);
      }
    } else if (payload.nonce_A !== undefined) {
      return this.fail();
    }
    this.round += 1;
    // Count the round before the code is shown, so an emitted code always counts.
    this.rounds += 1;
    this.saveRounds();
    this.currentSid = this.sid(h, this.attemptIndex, this.round);
    this.cpace = CPace.start({
      role: "responder",
      prs: this.prs!,
      sid: this.currentSid,
      ada: CPACE_AD_A,
      adb: CPACE_AD_B,
    });
    this.phase = "await-auth";
    this.deps.onPairingCode?.(this.code, this.languages, this.format!);
  }

  /** server/pair-auth: the server's CPace public share (both PIN methods). */
  onPairAuth(payload: { pake_msg_1?: string }): void {
    if (this.phase === "idle") return this.strayMessage();
    if (this.phase !== "await-auth" || !this.cpace) return this.fail();
    const peerShare = this.decode(payload.pake_msg_1, SHARE_SIZE);
    if (!peerShare) return this.fail();
    this.deps.sendControl({
      type: "client/pair-auth",
      payload: { pake_msg_2: base64urlEncode(this.cpace.publicShare) },
    });
    try {
      this.cpace.derive(peerShare);
    } catch (e) {
      if (e instanceof CPaceError) return this.fail();
      throw e;
    }
    this.phase = "await-confirm";
  }

  /** server/pair-confirm: verify the server's tag, then confirm and finalize. */
  onPairConfirm(payload: { server_kc?: string }): void {
    if (this.phase === "idle") return this.strayMessage();
    if (this.phase !== "await-confirm" || !this.cpace) return this.fail();
    const serverKc = this.decode(payload.server_kc, TAG_SIZE);
    if (!serverKc) return this.fail();
    if (!this.cpace.verify(serverKc)) {
      if (
        this.method === "dynamic_pairing_code" &&
        !this.isRoundLimitReached()
      ) {
        return this.retry();
      }
      if (this.method === "static_pairing_code") {
        this.windowFailures += 1;
        if (this.windowFailures >= WINDOW_FAILURE_LIMIT) this.closeWindow();
      }
      return this.abort("pairing_code_mismatch");
    }
    // Reset on a verified server_kc, whether or not the attempt finalizes.
    if (this.method === "dynamic_pairing_code") this.resetRounds();
    const confirm: { client_kc: string; wrapped_nonce_B?: string } = {
      client_kc: base64urlEncode(this.cpace.tag()),
    };
    if (this.method === "dynamic_pairing_code") {
      confirm.wrapped_nonce_B = base64urlEncode(
        this.wrap(NONCE_WRAP_LABEL, this.nonceB!),
      );
    }
    this.deps.sendControl({ type: "client/pair-confirm", payload: confirm });
    // client/pair-finalize follows immediately, without waiting (spec).
    this.phase = "await-finalize";
    this.sendFinalize();
  }

  onPairFinalize(): void {
    if (this.phase === "idle") return this.strayMessage();
    if (this.phase !== "await-finalize" || !this.pendingPsk) return this.fail();
    this.deps.pskStore.replaceLongTerm(this.pendingPsk, this.deps.serverId());
    this.clearAttempt();
    this.closeWindow();
    this.deps.onEvent?.("finalized");
  }

  /**
   * Inbound pair/abort from the server: discard the attempt. The sender closes
   * the connection when needed, so the receiver keeps it open. A pair/abort for
   * an already-ended attempt has no effect.
   */
  onAbort(reason: string): void {
    if (this.phase === "idle" && !this.pendingPsk) return;
    this.clearAttempt();
    this.deps.onEvent?.("aborted", reason);
  }

  /** Close a pairing window bound to the dropped connection, then reset. */
  onConnectionClosed(): void {
    if (this.windowBound) this.closeWindow();
    this.reset();
  }

  /** Discard any in-flight pairing state and the activate counter (on handshake/close). */
  reset(): void {
    this.clearAttempt();
    this.discardStray = false;
    this.pairingActivateCount = 0;
    this.attemptIndex = 0;
  }

  /** Send client/pair-init. A static attempt binds the window to this connection. */
  private startAttempt(): void {
    if (this.method === "static_pairing_code") this.windowBound = true;
    this.armAttemptTimer();
    this.deps.onEvent?.("started");
    if (this.method === "pairing_psk") {
      this.deps.sendControl({
        type: "client/pair-init",
        payload: { pairing_index: this.attemptIndex },
      });
      // client/pair-finalize follows immediately, without waiting (spec).
      this.phase = "await-finalize";
      this.sendFinalize();
      return;
    }
    if (this.method === "dynamic_pairing_code") {
      this.nonceB = generateNonce();
      this.phase = "await-init";
      this.deps.sendControl({
        type: "client/pair-init",
        payload: {
          pairing_index: this.attemptIndex,
          commit_B: base64urlEncode(commitNonce(this.nonceB)),
        },
      });
      return;
    }
    const h = this.deps.handshakeHash();
    this.currentSid = this.sid(h, this.attemptIndex, 1);
    this.cpace = CPace.start({
      role: "responder",
      prs: new TextEncoder().encode(this.deps.staticPairingCode!),
      sid: this.currentSid,
      ada: CPACE_AD_A,
      adb: CPACE_AD_B,
    });
    this.phase = "await-auth";
    this.deps.sendControl({
      type: "client/pair-init",
      payload: { pairing_index: this.attemptIndex },
    });
  }

  /** Ask for another round, keeping the attempt, its code and its timer. */
  private retry(): void {
    this.cpace = null;
    this.currentSid = null;
    this.phase = "await-init";
    this.deps.sendControl({ type: "client/pair-retry", payload: {} });
  }

  /** Mint the long-term PSK and send client/pair-finalize. */
  private sendFinalize(): void {
    // A Sendspin PSK must be a 32-byte CSPRNG value, not a clamped X25519 private key.
    const psk = crypto.getRandomValues(new Uint8Array(32));
    this.pendingPsk = psk;
    if (this.cpace && this.currentSid) {
      // Pairing code flow: seal the PSK under a key derived from the CPace output.
      this.deps.sendControl({
        type: "client/pair-finalize",
        payload: {
          wrapped_psk: base64urlEncode(this.wrap(PSK_WRAP_LABEL, psk)),
        },
      });
      return;
    }
    // Pairing PSK flow: the PSK travels directly.
    this.deps.sendControl({
      type: "client/pair-finalize",
      payload: { long_term_psk: base64urlEncode(psk) },
    });
  }

  /** Seal value under a key derived from the CPace output and sid. */
  private wrap(label: Uint8Array, value: Uint8Array): Uint8Array {
    const kWrap = sha256(concatBytes(label, this.currentSid!, this.cpace!.isk));
    return this.deps.aeadSeal(kWrap, value);
  }

  private sid(
    handshakeHash: Uint8Array,
    index: number,
    round: number,
  ): Uint8Array {
    const label = utf8(PAKE_SID_LABEL);
    const offset = label.length + handshakeHash.length;
    const sid = new Uint8Array(offset + 8);
    sid.set(label, 0);
    sid.set(handshakeHash, label.length);
    // counter and round: big-endian uint32 each.
    const view = new DataView(sid.buffer);
    view.setUint32(offset, index, false);
    view.setUint32(offset + 4, round, false);
    return sid;
  }

  private armAttemptTimer(): void {
    this.attemptTimer = setTimeout(
      () => this.abort("attempt_timeout"),
      ATTEMPT_TIMEOUT_MS,
    );
  }

  /**
   * Send pair/abort with reason and discard state. The connection stays open
   * for a retry. Only concurrent_attempt closes it.
   */
  private abort(reason: PairAbortReason): void {
    this.clearAttempt();
    this.discardStray = true;
    this.deps.sendControl({ type: "pair/abort", payload: { reason } });
    this.deps.onEvent?.("aborted", reason);
    if (reason === "concurrent_attempt") this.deps.close();
  }

  /** Protocol violation or malformed field: fail closed without an abort reason. */
  private fail(): void {
    this.clearAttempt();
    this.deps.close();
  }

  /**
   * A pairing message with no attempt running. Messages still in flight after
   * the client's own pair/abort are discarded, anything else is out of sequence.
   */
  private strayMessage(): void {
    if (!this.discardStray) this.fail();
  }

  private clearAttempt(): void {
    if (this.attemptTimer) clearTimeout(this.attemptTimer);
    this.attemptTimer = null;
    if (this.method && CODE_METHODS.includes(this.method)) {
      this.deps.onPairingCode?.(null);
    }
    this.pendingPsk = null;
    this.phase = "idle";
    this.method = null;
    this.cpace = null;
    this.currentSid = null;
    this.nonceB = null;
    this.format = null;
    this.code = null;
    this.prs = null;
    this.round = 0;
    this.languages = undefined;
  }

  /**
   * End an attempt the server walked away from, without sending pair/abort.
   * The event lets the app drop any "waiting for gesture" UI, which a silent
   * cancel would otherwise leave up (the server's pair/abort is only a SHOULD).
   */
  private abandonAttempt(detail: string): void {
    if (this.phase === "idle" && !this.pendingPsk) return;
    this.clearAttempt();
    this.deps.onEvent?.("aborted", detail);
  }

  private decode(value: string | undefined, size: number): Uint8Array | null {
    if (typeof value !== "string") return null;
    try {
      const raw = base64urlDecode(value);
      return raw.length === size ? raw : null;
    } catch {
      return null;
    }
  }

  private loadRounds(): number {
    try {
      const raw = this.deps.storage?.getItem(ROUNDS_STORAGE_KEY);
      if (!raw) return 0;
      const stored = JSON.parse(raw) as Record<string, number | undefined>;
      return stored[ROUNDS_FIELD] ?? 0;
    } catch {
      return 0;
    }
  }

  private saveRounds(): void {
    this.deps.storage?.setItem(
      ROUNDS_STORAGE_KEY,
      JSON.stringify({ [ROUNDS_FIELD]: this.rounds }),
    );
  }

  private resetRounds(): void {
    this.rounds = 0;
    this.saveRounds();
  }
}
