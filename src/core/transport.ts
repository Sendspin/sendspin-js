import type { WebSocketManager } from "./websocket-manager";
import type { Identity } from "./noise/identity";
import type { PskStore, PskEntry } from "./noise/psk";
import type { SuiteId } from "./noise/suites";
import { SUITES, SUITE_WIRE_NAME } from "./noise/suites";
import { HandshakeState, MSG1, MSG2 } from "./noise/handshake";
import { NoiseSession } from "./noise/session";
import { base64urlEncode, base64urlDecode } from "./noise/base64url";

const utf8 = new TextEncoder();
const dutf8 = new TextDecoder();
const HANDSHAKE_TIMEOUT_MS = 30000;
const MAX_TRANSPORT_PLAINTEXT = 65519; // 65535 - 16 (tag); includes the type byte
// Cap total reassembled size so an endless run of fragment-more frames can't exhaust memory.
const MAX_REASSEMBLY_BYTES = 4 * 1024 * 1024;

type State = "idle" | "await_server_init" | "await_noise1" | "transport";

export interface HandshakeInfo {
  trustLevel: "user" | "none";
  category: PskEntry["category"];
  serverId: string;
  entry: PskEntry;
}

export interface TransportCallbacks {
  onHandshakeComplete(info: HandshakeInfo): void;
  onControlMessage(msg: { type: string; payload?: unknown }): void;
  onBinaryMessage(bytes: Uint8Array): void;
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

  constructor(
    private wsManager: WebSocketManager,
    private deps: {
      identity: Identity;
      pskStore: PskStore;
      suiteId: SuiteId;
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

  start(): void {
    // Reset all per-connection state so a reconnect (start() called again on the
    // same transport instance) does not inherit a stale session, half-read
    // fragment, or pending re-handshake from a dropped connection.
    this.hs = null;
    this.session = null;
    this.matched = null;
    this.frag = null;
    this.serverId = "";
    this.rawServerInit = new Uint8Array(0);
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

  /** Public close: pair/abort and other flows need to tear down the socket. */
  close(): void {
    this.clearTimeout();
    this.wsManager.disconnect();
  }

  handleRaw(event: MessageEvent): void {
    try {
      if (this.state === "transport") {
        if (typeof event.data === "string") return this.fail(); // unexpected cleartext
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        this.onTransportFrame(bytes);
        return;
      }
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
    const { psk_id } = JSON.parse(dutf8.decode(payload1)) as { psk_id: string };
    const entry = this.deps.pskStore.lookup(psk_id);
    if (!entry) return this.fail();
    if (
      entry.category === "long_term" &&
      entry.serverId !== undefined &&
      entry.serverId !== this.serverId
    ) {
      return this.fail();
    }
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
    this.cb.onHandshakeComplete(this.handshakeInfo!);
  }

  private onTransportFrame(bytes: Uint8Array): void {
    const pt = this.session!.decrypt(bytes); // throws => fail (via handleRaw catch)
    this.dispatchPlain(pt[0], pt.subarray(1), pt);
  }

  /** type: message-type byte; body: bytes after the type byte; full: full plaintext incl type byte. */
  private dispatchPlain(
    type: number,
    body: Uint8Array,
    full: Uint8Array,
  ): void {
    if (type === 0) {
      this.handleControl(JSON.parse(dutf8.decode(body)));
    } else if (type === 2 || type === 3) {
      this.handleFragment(type, body);
    } else {
      this.cb.onBinaryMessage(full.slice()); // own ArrayBuffer, type byte intact
    }
  }

  private handleFragment(type: number, body: Uint8Array): void {
    if (type === 2 && this.frag === null) {
      const first = body.subarray(1);
      this.frag = { origType: body[0], parts: [first], size: first.length };
      return;
    }
    if (type === 2) {
      this.frag!.parts.push(body);
      this.frag!.size += body.length;
      if (this.frag!.size > MAX_REASSEMBLY_BYTES) {
        this.frag = null;
        return this.fail();
      }
      return;
    }
    // type === 3: closing frame
    if (this.frag === null) return this.fail();
    this.frag.parts.push(body);
    this.frag.size += body.length;
    if (this.frag.size > MAX_REASSEMBLY_BYTES) {
      this.frag = null;
      return this.fail();
    }
    const origType = this.frag.origType;
    const data = this.frag.parts.reduce(
      (acc, p) => concat(acc, p),
      new Uint8Array(0),
    );
    this.frag = null;
    if (origType === 0) {
      this.handleControl(JSON.parse(dutf8.decode(data)));
    } else {
      this.cb.onBinaryMessage(concat(Uint8Array.of(origType), data));
    }
  }

  /** Extended in later tasks (re-handshake, authorization, unpair). Base: forward. */
  protected handleControl(msg: { type: string; payload?: unknown }): void {
    this.cb.onControlMessage(msg);
  }

  /** Encrypt and send a JSON control message as a transport binary frame. */
  sendControl(msg: object): void {
    if (this.state !== "transport" || !this.session) {
      console.warn("Sendspin: sendControl before transport ready");
      return;
    }
    const json = utf8.encode(JSON.stringify(msg));
    const pt = concat(Uint8Array.of(0), json);
    if (pt.length > MAX_TRANSPORT_PLAINTEXT) {
      throw new Error("Sendspin: control message exceeds single-frame limit");
    }
    this.wsManager.sendBinary(this.session.encrypt(pt));
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
