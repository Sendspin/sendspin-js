import type { PskStore, PskCategory } from "./noise/psk";
import { base64urlEncode, base64urlDecode } from "./noise/base64url";
import type {
  PairAbortReason,
  PairMethod,
  PairMethodDescriptor,
  SendspinStorage,
} from "../types";
import { CPace, CPaceError, SHARE_SIZE, TAG_SIZE } from "./pake/cpace";
import {
  DEFAULT_MIN_PIN_DIGITS,
  MAX_PIN_DIGITS,
  MIN_PIN_DIGITS,
  NONCE_SIZE,
  commitNonce,
  derivePin,
  generateNonce,
  isValidStaticPin,
} from "./pake/pin";
import { sha256 } from "@noble/hashes/sha2";

export type PairingEvent = "started" | "finalized" | "aborted";

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

/** CPace session-id label. sid = label || Noise handshake hash || counter. */
const PAKE_SID_LABEL = "sendspin-pair-pake-v1";
/** Label for the key that wraps the PSK in PIN pairing (PSK Wrapping). */
const PSK_WRAP_LABEL = utf8("sendspin-pair-psk-wrap-v1");
/** CPace associated data: distinct per side to prevent a reflected MAC. */
const CPACE_AD_A = utf8("server");
const CPACE_AD_B = utf8("client");
/** A PIN pairing attempt must complete within this bound (spec: 2 minutes). */
const ATTEMPT_TIMEOUT_MS = 120_000;
/** Static-PIN pairing window lifetime after the operator gesture (spec: ~5 minutes). */
const WINDOW_LIFETIME_MS = 300_000;
/** A PIN method enters terminal lockout at this many consecutive failures. */
const PIN_LOCKOUT_THRESHOLD = 10;
/** Persisted per-method PIN failure counters (not partitioned by server). */
const FAILURES_STORAGE_KEY = "sendspin-pair-failures";

const PIN_METHODS: readonly PairMethod[] = ["dynamic_pin", "static_pin"];

type Phase =
  | "idle"
  /** Static PIN: pairing selected, waiting for the operator's window gesture. */
  | "await-window"
  /** Dynamic PIN: client/pair-init sent, awaiting server/pair-init. */
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
   * Seal the PIN-flow PSK under the negotiated AEAD (zero nonce, empty AD).
   * key is K_wrap. Returns the 48-byte wrapped PSK.
   */
  aeadSeal(key: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** Persists PIN-method failure counters. Null = in-memory only. */
  storage: SendspinStorage | null;
  /** Enables dynamic_pin: surfaces the PIN (null = attempt ended, hide it). */
  onPin: ((pin: string | null) => void) | null;
  /** Shortest dynamic PIN length this client accepts. */
  minPinLength?: number;
  /** Enables static_pin: this device's fixed 8-digit PIN. */
  staticPin?: string;
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
  /** The CPace sid for the current PIN attempt (for PSK wrapping). */
  private currentSid: Uint8Array | null = null;
  /** Pairing server/activate messages received since the last Noise handshake. */
  private pairingActivateCount = 0;
  /** The counter for the current attempt (pairing_index and CPace sid counter). */
  private attemptIndex = 0;
  private failures: Partial<Record<PairMethod, number>>;
  private readonly minPinLength: number;

  constructor(private deps: PairingDeps) {
    if (deps.staticPin !== undefined && !isValidStaticPin(deps.staticPin)) {
      throw new Error("staticPin must be exactly 8 decimal digits");
    }
    this.minPinLength = Math.min(
      MAX_PIN_DIGITS,
      Math.max(MIN_PIN_DIGITS, deps.minPinLength ?? DEFAULT_MIN_PIN_DIGITS),
    );
    if (!deps.storage && (deps.staticPin !== undefined || deps.onPin)) {
      // Spec requires the lockout counter to survive reboots. Without storage
      // it is in-memory only and brute-force lockout resets on restart.
      console.warn(
        "sendspin: PIN pairing is enabled without storage, so the lockout counter will not persist across reboots.",
      );
    }
    this.failures = this.loadFailures();
  }

  /** The pairing-method descriptors to advertise in client/hello. */
  descriptors(): PairMethodDescriptor[] {
    const out: PairMethodDescriptor[] = [{ method: "pairing_psk" }];
    if (this.deps.staticPin !== undefined) {
      out.push({
        method: "static_pin",
        locked_out: this.isLockedOut("static_pin"),
      });
    }
    if (this.deps.onPin) {
      out.push({
        method: "dynamic_pin",
        out_channels: ["display"],
        min_pin_length: this.minPinLength,
        locked_out: this.isLockedOut("dynamic_pin"),
      });
    }
    return out;
  }

  /** Whether a PIN method is in terminal lockout (spec: 10 failures). */
  isLockedOut(method: PairMethod): boolean {
    return (this.failures[method] ?? 0) >= PIN_LOCKOUT_THRESHOLD;
  }

  /**
   * Local operator action that exits terminal lockout for a PIN method,
   * resetting its failure counter (spec: deliberate local action).
   */
  clearLockout(method: PairMethod): void {
    this.resetFailures(method);
  }

  /**
   * Operator gesture that opens the static-PIN pairing window. If the server
   * already selected static_pin, the attempt starts immediately, otherwise the
   * window admits one attempt within its lifetime (~5 minutes).
   */
  openPairingWindow(): void {
    if (this.phase === "await-window") {
      this.startStaticAttempt();
      return;
    }
    this.windowOpen = true;
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimer = setTimeout(() => {
      this.windowOpen = false; // window expires silently
      this.windowTimer = null;
    }, WINDOW_LIFETIME_MS);
  }

  /** Cancel an in-progress pairing attempt (sends pair/abort user_cancelled). */
  cancelPairing(): void {
    if (this.phase === "idle") return;
    this.abort("user_cancelled");
  }

  /** Called for every server/activate. Returns true if it consumed a pairing activation. */
  onActivate(activities: string[], selectedPairMethod?: string): boolean {
    const isPairing = activities.includes("pairing");
    if (!isPairing) {
      // Non-pairing activate in place of pair-finalize = leave-pairing: discard
      // the attempt. With no attempt in progress, preserve a pre-opened
      // static-PIN window so a later static_pin activate can still use it.
      if (this.phase !== "idle" || this.pendingPsk) this.clearAttempt();
      return false;
    }
    if (this.phase !== "idle" || this.pendingPsk) return true; // attempt already running
    // Each pairing activate is one attempt, indexed for pairing_index and sid.
    this.pairingActivateCount += 1;
    this.attemptIndex = this.pairingActivateCount;
    const method = selectedPairMethod as PairMethod | undefined;
    const supported = this.descriptors().map((d) => d.method);
    // pairing_psk exactly when the matched PSK is the Pairing PSK, a PIN method otherwise.
    const fitsPsk =
      (method === "pairing_psk") ===
      (this.deps.matchedCategory() === "pairing");
    if (!method || !fitsPsk || !supported.includes(method)) {
      this.abort("method_not_supported");
      return true;
    }
    if (PIN_METHODS.includes(method) && this.isLockedOut(method)) {
      this.abort("locked_out");
      return true;
    }
    this.method = method;
    if (method === "pairing_psk") {
      this.sendFinalize();
      // Arm the attempt timer and leave a non-idle phase so the attempt can be
      // cancelled and times out if the server never sends server/pair-finalize.
      this.phase = "await-finalize";
      this.armAttemptTimer();
      this.deps.onEvent?.("started");
      return true;
    }
    this.deps.onEvent?.("started");
    if (method === "dynamic_pin") {
      this.nonceB = generateNonce();
      this.phase = "await-init";
      this.armAttemptTimer();
      this.deps.sendControl({
        type: "client/pair-init",
        payload: {
          pairing_index: this.attemptIndex,
          commit_B: base64urlEncode(commitNonce(this.nonceB)),
        },
      });
      return true;
    }
    // static_pin: the window gesture admits the attempt.
    if (this.windowOpen) {
      this.startStaticAttempt();
    } else {
      this.phase = "await-window";
      // Give the operator the window lifetime to make the gesture.
      this.windowTimer = setTimeout(() => this.fail(), WINDOW_LIFETIME_MS);
    }
    return true;
  }

  /** server/pair-init: the server's nonce contribution (dynamic PIN). */
  onPairInit(payload: { nonce_A?: string; pin_length?: number }): void {
    // Leftover from an ended attempt (kept-open connection): discard silently.
    if (this.phase === "idle") return;
    if (this.phase !== "await-init" || this.method !== "dynamic_pin") {
      return this.fail();
    }
    const nonceA = this.decode(payload.nonce_A, NONCE_SIZE);
    const pinLength = payload.pin_length;
    if (
      !nonceA ||
      typeof pinLength !== "number" ||
      !Number.isInteger(pinLength)
    )
      return this.fail();
    if (pinLength < this.minPinLength || pinLength > MAX_PIN_DIGITS) {
      return this.abort("pin_length_unacceptable");
    }
    const h = this.deps.handshakeHash();
    const pin = derivePin(h, nonceA, this.nonceB!, pinLength);
    this.currentSid = this.sid(h, this.attemptIndex);
    this.cpace = CPace.start({
      role: "responder",
      prs: new TextEncoder().encode(pin),
      sid: this.currentSid,
      ada: CPACE_AD_A,
      adb: CPACE_AD_B,
    });
    this.phase = "await-auth";
    this.deps.onPin?.(pin);
  }

  /** server/pair-auth: the server's CPace public share (both PIN methods). */
  onPairAuth(payload: { pake_msg_1?: string }): void {
    if (this.phase === "idle") return; // leftover from an ended attempt
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
      if (e instanceof CPaceError) return this.abort("pin_mismatch");
      throw e;
    }
    this.phase = "await-confirm";
  }

  /** server/pair-confirm: verify the server's tag, then confirm and finalize. */
  onPairConfirm(payload: { server_kc?: string }): void {
    if (this.phase === "idle") return; // leftover from an ended attempt
    if (this.phase !== "await-confirm" || !this.cpace) return this.fail();
    const serverKc = this.decode(payload.server_kc, TAG_SIZE);
    if (!serverKc) return this.fail();
    if (!this.cpace.verify(serverKc)) {
      this.recordFailure(this.method!);
      return this.abort("pin_mismatch");
    }
    this.resetFailures(this.method!);
    const confirm: { client_kc: string; nonce_B?: string } = {
      client_kc: base64urlEncode(this.cpace.tag()),
    };
    if (this.method === "dynamic_pin") {
      confirm.nonce_B = base64urlEncode(this.nonceB!);
    }
    this.deps.sendControl({ type: "client/pair-confirm", payload: confirm });
    // client/pair-finalize follows immediately, without waiting (spec).
    this.phase = "await-finalize";
    this.sendFinalize();
  }

  onPairFinalize(): void {
    if (!this.pendingPsk) return;
    this.deps.pskStore.addLongTerm(this.pendingPsk, this.deps.serverId());
    this.clearAttempt();
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

  /** Discard any in-flight pairing state and the activate counter (on handshake/close). */
  reset(): void {
    this.clearAttempt();
    this.pairingActivateCount = 0;
    this.attemptIndex = 0;
  }

  private startStaticAttempt(): void {
    this.windowOpen = false; // the window admits exactly one attempt
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    const h = this.deps.handshakeHash();
    this.currentSid = this.sid(h, this.attemptIndex);
    this.cpace = CPace.start({
      role: "responder",
      prs: new TextEncoder().encode(this.deps.staticPin!),
      sid: this.currentSid,
      ada: CPACE_AD_A,
      adb: CPACE_AD_B,
    });
    this.phase = "await-auth";
    this.armAttemptTimer();
    this.deps.sendControl({
      type: "client/pair-init",
      payload: { pairing_index: this.attemptIndex },
    });
  }

  /** Mint the long-term PSK and send client/pair-finalize. */
  private sendFinalize(): void {
    // A Sendspin PSK must be a 32-byte CSPRNG value, not a clamped X25519 private key.
    const psk = crypto.getRandomValues(new Uint8Array(32));
    this.pendingPsk = psk;
    if (this.cpace && this.currentSid) {
      // PIN flow: seal the PSK under a key derived from the CPace output.
      const kWrap = sha256(
        concatBytes(PSK_WRAP_LABEL, this.currentSid, this.cpace.isk),
      );
      const wrapped = this.deps.aeadSeal(kWrap, psk);
      this.deps.sendControl({
        type: "client/pair-finalize",
        payload: { wrapped_psk: base64urlEncode(wrapped) },
      });
      return;
    }
    // Pairing PSK flow: the PSK travels directly.
    this.deps.sendControl({
      type: "client/pair-finalize",
      payload: { long_term_psk: base64urlEncode(psk) },
    });
  }

  private sid(handshakeHash: Uint8Array, index: number): Uint8Array {
    const label = utf8(PAKE_SID_LABEL);
    const sid = new Uint8Array(label.length + handshakeHash.length + 4);
    sid.set(label, 0);
    sid.set(handshakeHash, label.length);
    // counter: big-endian uint32 of the attempt index.
    new DataView(sid.buffer).setUint32(
      label.length + handshakeHash.length,
      index,
      false,
    );
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
   * for a retry. Only method_not_supported (like concurrent_attempt) closes it.
   */
  private abort(reason: PairAbortReason): void {
    this.clearAttempt();
    this.deps.sendControl({ type: "pair/abort", payload: { reason } });
    this.deps.onEvent?.("aborted", reason);
    if (reason === "method_not_supported") this.deps.close();
  }

  /** Protocol violation or malformed field: fail closed without an abort reason. */
  private fail(): void {
    this.clearAttempt();
    this.deps.close();
  }

  private clearAttempt(): void {
    if (this.attemptTimer) clearTimeout(this.attemptTimer);
    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.attemptTimer = null;
    this.windowTimer = null;
    if (this.method && PIN_METHODS.includes(this.method)) {
      this.deps.onPin?.(null);
    }
    this.pendingPsk = null;
    this.phase = "idle";
    this.method = null;
    this.cpace = null;
    this.currentSid = null;
    this.nonceB = null;
    this.windowOpen = false;
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

  private loadFailures(): Partial<Record<PairMethod, number>> {
    try {
      const raw = this.deps.storage?.getItem(FAILURES_STORAGE_KEY);
      if (!raw) return {};
      return JSON.parse(raw) as Partial<Record<PairMethod, number>>;
    } catch {
      return {};
    }
  }

  private saveFailures(): void {
    this.deps.storage?.setItem(
      FAILURES_STORAGE_KEY,
      JSON.stringify(this.failures),
    );
  }

  private recordFailure(method: PairMethod): void {
    this.failures[method] = (this.failures[method] ?? 0) + 1;
    this.saveFailures();
  }

  private resetFailures(method: PairMethod): void {
    delete this.failures[method];
    this.saveFailures();
  }
}
