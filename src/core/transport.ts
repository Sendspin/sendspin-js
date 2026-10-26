import type { WebSocketManager } from "./websocket-manager";
import type { Identity } from "./noise/identity";
import type { PskStore, PskEntry, PskCategory } from "./noise/psk";
import type { SuiteId } from "./noise/suites";
import { SUITES, SUITE_WIRE_NAME } from "./noise/suites";
import { HandshakeState, MSG1, MSG2 } from "./noise/handshake";
import { NoiseSession } from "./noise/session";
import { base64urlEncode, base64urlDecode } from "./noise/base64url";
import { SENTINEL_PSK_ID } from "./noise/constants";
import { authorizeActivate } from "./activate-authorization";
import type { GoodbyeReason } from "../types";

const utf8 = new TextEncoder();
const dutf8 = new TextDecoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const HANDSHAKE_TIMEOUT_MS = 30000;
const MAX_TRANSPORT_PLAINTEXT = 65519; // 65535 - 16 (tag); includes the type byte
const MAX_TRANSPORT_CIPHERTEXT = MAX_TRANSPORT_PLAINTEXT + 16; // Noise transport message cap
// Cap total reassembled size so an endless run of non-last fragments can't exhaust memory.
const MAX_REASSEMBLY_BYTES = 4 * 1024 * 1024;
const MSG_TYPE_FRAGMENT = 1;
const FRAGMENT_FLAG_LAST = 0x01;
const FRAGMENT_FLAG_FIRST = 0x02;
const FRAGMENT_FLAGS_RESERVED = 0xfc;

type State = "idle" | "await_server_init" | "await_noise1" | "transport";

export interface HandshakeInfo {
  trustLevel: "user" | "none";
  category: PskEntry["category"];
  serverId: string;
  entry: PskEntry;
}

export interface TransportCallbacks {
  onHandshakeComplete(info: HandshakeInfo): void;
  onControlMessage(
    msg: { type: string; payload?: unknown },
    receivedAtUs: number,
  ): void;
  onBinaryMessage(bytes: Uint8Array): void;
}

const PSK_CATEGORY_CODES = new Map<unknown, PskCategory>([
  ["lt", "long_term"],
  ["pr", "pairing"],
  ["sn", "sentinel"],
]);

/** Parse the Noise message 1 payload. Throws when it is malformed. */
function parseNoise1Payload(bytes: Uint8Array): {
  pskId: string;
  category: PskCategory;
} {
  const { psk_id, psk_category } = (JSON.parse(strictUtf8.decode(bytes)) ??
    {}) as Record<string, unknown>;
  const category = PSK_CATEGORY_CODES.get(psk_category);
  if (
    typeof psk_id !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(psk_id) ||
    category === undefined
  ) {
    throw new Error("Sendspin: malformed noise/handshake payload");
  }
  return { pskId: psk_id, category };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export class SendspinTransport {
  private state: State = "idle";
  private hs: HandshakeState | null = null;
  private session: NoiseSession | null = null;
  private matched: PskEntry | null = null;
  private serverId = "";
  private rawClientInit = new Uint8Array(0);
  private rawServerInit = new Uint8Array(0);
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private frag: { origType: number; parts: Uint8Array[]; size: number } | null =
    null;
  private lastHandshakeHash: Uint8Array = new Uint8Array(0);
  private quiesced = false;
  private outboundQueue: object[] = [];
  private activeRoles: string[] = [];

  constructor(
    private wsManager: WebSocketManager,
    private deps: {
      identity: Identity;
      pskStore: PskStore;
      suiteId: SuiteId;
      unpairedAccess: boolean;
    },
    protected cb: TransportCallbacks,
  ) {}

  private get suite() {
    return SUITES[this.deps.suiteId];
  }

  /** True once transport mode is established. */
  get ready(): boolean {
    return this.state === "transport";
  }

  get handshakeInfo(): HandshakeInfo | null {
    if (!this.matched) return null;
    return {
      trustLevel: this.matched.category === "long_term" ? "user" : "none",
      category: this.matched.category,
      serverId: this.serverId,
      entry: this.matched,
    };
  }

  /** The Noise handshake hash h of the current session (PIN pairing binds to it). */
  get handshakeHash(): Uint8Array {
    return this.lastHandshakeHash;
  }

  start(): void {
    // Reset per-connection state so a reconnect does not inherit a stale session.
    this.resetSession();
    const initStr = JSON.stringify({
      type: "client/init",
      payload: {
        client_id: this.deps.identity.clientId,
        version: 1,
        suite: SUITE_WIRE_NAME[this.deps.suiteId],
      },
    });
    this.rawClientInit = utf8.encode(initStr);
    this.wsManager.sendText(initStr);
    this.state = "await_server_init";
    this.armTimeout();
  }

  /** Reset per-connection handshake and session state. */
  private resetSession(): void {
    this.hs = null;
    this.session = null;
    this.matched = null;
    this.frag = null;
    this.serverId = "";
    this.rawServerInit = new Uint8Array(0);
    this.quiesced = false;
    this.outboundQueue = [];
    this.lastHandshakeHash = new Uint8Array(0);
    this.activeRoles = [];
  }

  /**
   * The socket closed. Drop the handshake timer and session so a reconnect
   * starts clean and no send targets the dead session's keys.
   */
  onSocketClosed(): void {
    this.clearTimeout();
    this.resetSession();
    this.state = "idle";
  }

  /** Public close: pair/abort and other flows need to tear down the socket. */
  close(): void {
    this.clearTimeout();
    this.wsManager.disconnect();
  }

  handleRaw(event: MessageEvent): void {
    const receivedAtUs = Math.floor(performance.now() * 1000);
    if (this.state === "transport") {
      if (typeof event.data === "string") return this.fail(); // unexpected cleartext
      let plain: Uint8Array;
      try {
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        if (bytes.length > MAX_TRANSPORT_CIPHERTEXT) return this.fail();
        plain = this.session!.decrypt(bytes); // AEAD failure is a real transport failure
      } catch {
        return this.fail();
      }
      if (plain.length < 1) return this.fail();
      // A malformed payload or a throwing app callback must not close the socket
      // or disable reconnect. Log and keep the connection.
      try {
        this.dispatchPlain(plain, receivedAtUs);
      } catch (e) {
        console.warn("Sendspin: dropped malformed transport message", e);
      }
      return;
    }
    try {
      if (typeof event.data !== "string") return this.fail(); // handshake is text only
      this.handleHandshakeText(event.data);
    } catch {
      this.fail();
    }
  }

  private handleHandshakeText(raw: string): void {
    const msg = JSON.parse(raw) as {
      type: string;
      payload: Record<string, unknown>;
    };
    if (this.state === "await_server_init" && msg.type === "server/init") {
      if (msg.payload.version !== 1) return this.fail();
      this.serverId = String(msg.payload.server_id);
      this.rawServerInit = utf8.encode(raw);
      this.hs = new HandshakeState({
        suite: this.suite,
        role: "responder",
        prologue: concat(this.rawClientInit, this.rawServerInit),
        s: this.deps.identity.keypair,
        rs: base64urlDecode(this.serverId),
      });
      this.state = "await_noise1";
      this.armTimeout();
      return;
    }
    if (this.state === "await_noise1" && msg.type === "noise/handshake") {
      this.processNoise1(base64urlDecode(String(msg.payload.data)));
      return;
    }
    this.fail();
  }

  private processNoise1(data: Uint8Array): void {
    const payload1 = this.hs!.readMessage(MSG1, data); // static-DH only; throws => fail
    const entry =
      this.matchPsk(payload1) ?? this.deps.pskStore.lookup(SENTINEL_PSK_ID)!;
    this.hs!.setPsk(entry.psk);
    const m2 = this.hs!.writeMessage(MSG2, utf8.encode("{}"));
    this.wsManager.sendText(
      JSON.stringify({
        type: "noise/handshake",
        payload: { data: base64urlEncode(m2) },
      }),
    );
    this.session = new NoiseSession("responder", this.hs!.split());
    this.matched = entry;
    this.state = "transport";
    this.clearTimeout();
    this.lastHandshakeHash = this.hs!.handshakeHash;
    this.cb.onHandshakeComplete(this.handshakeInfo!);
  }

  /** Stored PSK selected by a Noise message 1 payload, or null on a lookup miss. */
  private matchPsk(payload1: Uint8Array): PskEntry | null {
    const { pskId, category } = parseNoise1Payload(payload1);
    const entry = this.deps.pskStore.lookup(pskId);
    if (entry?.category !== category) return null;
    if (category === "long_term" && entry.serverId !== this.serverId) {
      throw new Error("Sendspin: long-term PSK bound to another server");
    }
    return entry;
  }

  /** Route one decrypted plaintext frame on its leading message-type byte. */
  private dispatchPlain(full: Uint8Array, receivedAtUs: number): void {
    const type = full[0];
    if (type === MSG_TYPE_FRAGMENT)
      return this.handleFragment(full, receivedAtUs);
    if (this.frag !== null) return this.fail();
    // The body view is built per branch: the binary path below is the hot one
    // and reads only `full`.
    if (type === 0) {
      this.handleControl(
        JSON.parse(dutf8.decode(full.subarray(1))),
        receivedAtUs,
      );
    } else {
      // full is the decrypt output: exclusively owned, offset 0, exact length,
      // type byte intact. Hand it over without re-copying.
      this.cb.onBinaryMessage(full);
    }
  }

  private handleFragment(full: Uint8Array, receivedAtUs: number): void {
    if (full.length < 2) return this.fail();
    const flags = full[1];
    if (flags & FRAGMENT_FLAGS_RESERVED) return this.fail();
    let data: Uint8Array;
    if (flags & FRAGMENT_FLAG_FIRST) {
      if (this.frag !== null || full.length < 3) return this.fail();
      if (full[2] === MSG_TYPE_FRAGMENT) return this.fail();
      this.frag = { origType: full[2], parts: [], size: 0 };
      data = full.subarray(3);
    } else {
      if (this.frag === null) return this.fail();
      data = full.subarray(2);
    }
    this.frag.parts.push(data);
    this.frag.size += data.length;
    if (this.frag.size > MAX_REASSEMBLY_BYTES) {
      this.frag = null;
      return this.fail();
    }
    if (!(flags & FRAGMENT_FLAG_LAST)) return;
    const origType = this.frag.origType;
    // Assemble into a size+1 buffer with the type byte at offset 0, so the
    // binary path can hand it over without a second copy to prepend the type.
    const assembled = new Uint8Array(this.frag.size + 1);
    assembled[0] = origType;
    let off = 1;
    for (const p of this.frag.parts) {
      assembled.set(p, off);
      off += p.length;
    }
    this.frag = null;
    if (origType === 0) {
      this.handleControl(
        JSON.parse(dutf8.decode(assembled.subarray(1))),
        receivedAtUs,
      );
    } else {
      this.cb.onBinaryMessage(assembled);
    }
  }

  protected handleControl(
    msg: { type: string; payload?: unknown },
    receivedAtUs: number,
  ): void {
    if (msg.type === "noise/handshake") {
      try {
        this.handleRehandshake(msg as { payload: { data: string } });
      } catch {
        return this.fail();
      }
      this.cb.onHandshakeComplete(this.handshakeInfo!);
      return;
    }
    if (msg.type === "server/activate") {
      this.handleActivate(
        msg as {
          type: string;
          payload: {
            activities: string[];
            active_roles?: string[];
          };
        },
        receivedAtUs,
      );
      return;
    }
    if (msg.type === "server/unpair") {
      this.handleUnpair();
      return;
    }
    this.cb.onControlMessage(msg, receivedAtUs);
  }

  private handleRehandshake(msg: { payload: { data: string } }): void {
    const newHs = new HandshakeState({
      suite: this.suite,
      role: "responder",
      prologue: this.lastHandshakeHash,
      s: this.deps.identity.keypair,
      rs: base64urlDecode(this.serverId),
    });
    const payload1 = newHs.readMessage(MSG1, base64urlDecode(msg.payload.data));
    const entry = this.matchPsk(payload1);
    if (!entry)
      throw new Error("Sendspin: psk_id lookup miss in a re-handshake");
    newHs.setPsk(entry.psk);
    const m2 = newHs.writeMessage(MSG2, utf8.encode("{}"));
    // Hold outbound traffic until the post-re-handshake server/activate.
    this.quiesced = true;
    this.armTimeout();
    // Send msg 2 under the CURRENT keys, then swap.
    this.encryptSend({
      type: "noise/handshake",
      payload: { data: base64urlEncode(m2) },
    });
    this.session = new NoiseSession("responder", newHs.split());
    this.matched = entry;
    this.lastHandshakeHash = newHs.handshakeHash;
  }

  protected handleActivate(
    msg: {
      type: string;
      payload: {
        activities: string[];
        active_roles?: string[];
      };
    },
    receivedAtUs: number,
  ): void {
    const result = authorizeActivate(
      this.matched!.category,
      msg.payload.activities,
      msg.payload.active_roles,
      this.activeRoles,
      this.deps.unpairedAccess,
    );
    if (!result.ok) {
      this.sendGoodbyeAndClose(result.goodbye);
      return;
    }
    this.activeRoles = result.activeRoles;
    this.clearTimeout();
    const queuedCommands =
      !msg.payload.activities.includes("pairing") &&
      this.activeRoles.includes("controller@v1")
        ? this.outboundQueue.filter(
            (queued) => (queued as { type?: string }).type === "client/command",
          )
        : [];
    this.quiesced = false;
    this.outboundQueue = [];
    this.cb.onControlMessage(
      {
        ...msg,
        payload: { ...msg.payload, active_roles: this.activeRoles },
      },
      receivedAtUs,
    );
    for (const command of queuedCommands) this.encryptSend(command);
  }

  private handleUnpair(): void {
    // trust_level none (Sentinel or in-flight pairing): ignore.
    if (this.matched?.category !== "long_term") return;
    this.deps.pskStore.removeByPskId(this.matched.pskId);
    this.sendGoodbyeAndClose("unpaired");
  }

  private sendGoodbyeAndClose(reason: GoodbyeReason): void {
    try {
      this.encryptSend({ type: "client/goodbye", payload: { reason } });
    } catch {
      /* best effort */
    }
    this.close();
  }

  sendControl(msg: object): void {
    if (this.state !== "transport" || !this.session) {
      console.warn("Sendspin: sendControl before transport ready");
      return;
    }
    // Hold outbound traffic during a re-handshake. client/hello still flows, since
    // a non-compliant server re-sends server/hello and awaits client/hello before
    // the post-re-handshake server/activate.
    if (this.quiesced && (msg as { type?: string }).type !== "client/hello") {
      this.outboundQueue.push(msg);
      return;
    }
    this.encryptSend(msg);
  }

  private encryptSend(msg: object): void {
    const json = utf8.encode(JSON.stringify(msg));
    if (json.length < MAX_TRANSPORT_PLAINTEXT) {
      const pt = concat(Uint8Array.of(0), json);
      this.wsManager.sendBinary(this.session!.encrypt(pt));
      return;
    }
    for (let start = 0; start < json.length;) {
      const first = start === 0;
      const end = Math.min(
        json.length,
        start + MAX_TRANSPORT_PLAINTEXT - (first ? 3 : 2),
      );
      const flags =
        (first ? FRAGMENT_FLAG_FIRST : 0) |
        (end === json.length ? FRAGMENT_FLAG_LAST : 0);
      const header = first
        ? Uint8Array.of(MSG_TYPE_FRAGMENT, flags, 0)
        : Uint8Array.of(MSG_TYPE_FRAGMENT, flags);
      const pt = concat(header, json.subarray(start, end));
      this.wsManager.sendBinary(this.session!.encrypt(pt));
      start = end;
    }
  }

  private armTimeout(): void {
    this.clearTimeout();
    this.timeout = globalThis.setTimeout(
      () => this.fail(),
      HANDSHAKE_TIMEOUT_MS,
    );
  }

  private clearTimeout(): void {
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  /** Any handshake or transport failure: close the socket with no app-level error. */
  protected fail(): void {
    this.clearTimeout();
    this.wsManager.disconnect();
  }
}
