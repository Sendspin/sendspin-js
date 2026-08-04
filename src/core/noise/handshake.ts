import type { CipherSuite } from "./suites";
import { SymmetricState } from "./symmetric-state";
import { CipherState } from "./cipher-state";

export type Role = "initiator" | "responder";
type Token = "e" | "s" | "ee" | "es" | "se" | "ss" | "psk";

const MSG1: Token[] = ["e", "es", "ss"];
const MSG2: Token[] = ["e", "ee", "se", "psk"];

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export interface HandshakeParams {
  suite: CipherSuite;
  role: Role;
  prologue: Uint8Array;
  s: { privateKey: Uint8Array; publicKey: Uint8Array };
  rs: Uint8Array;
  psk?: Uint8Array;
  /** Test-only: inject a deterministic ephemeral so known-answer vectors are reproducible. */
  fixedEphemeral?: { privateKey: Uint8Array; publicKey: Uint8Array };
}

export class HandshakeState {
  private sym: SymmetricState;
  private suite: CipherSuite;
  private role: Role;
  private s: HandshakeParams["s"];
  private rs: Uint8Array;
  private e?: { privateKey: Uint8Array; publicKey: Uint8Array };
  private re?: Uint8Array;
  private psk?: Uint8Array;
  private fixedEphemeral?: { privateKey: Uint8Array; publicKey: Uint8Array };

  constructor(p: HandshakeParams) {
    this.suite = p.suite;
    this.role = p.role;
    this.s = p.s;
    this.rs = p.rs;
    this.psk = p.psk;
    this.fixedEphemeral = p.fixedEphemeral;
    this.sym = new SymmetricState(p.suite);
    this.sym.initialize(`Noise_KKpsk2_25519_${p.suite.name}_SHA256`);
    this.sym.mixHash(p.prologue);
    // Pre-messages: initiator static, then responder static.
    const initiatorStatic = p.role === "initiator" ? p.s.publicKey : p.rs;
    const responderStatic = p.role === "responder" ? p.s.publicKey : p.rs;
    this.sym.mixHash(initiatorStatic);
    this.sym.mixHash(responderStatic);
  }

  /** The running handshake hash, e.g. for the re-handshake prologue. */
  get handshakeHash(): Uint8Array {
    return this.sym.h;
  }

  setPsk(psk: Uint8Array): void {
    this.psk = psk;
  }

  private dhToken(token: "ee" | "es" | "se" | "ss"): Uint8Array {
    const init = this.role === "initiator";
    switch (token) {
      case "ee":
        return this.suite.dh(this.e!.privateKey, this.re!);
      case "ss":
        return this.suite.dh(this.s.privateKey, this.rs);
      case "es":
        return init
          ? this.suite.dh(this.e!.privateKey, this.rs)
          : this.suite.dh(this.s.privateKey, this.re!);
      case "se":
        return init
          ? this.suite.dh(this.s.privateKey, this.re!)
          : this.suite.dh(this.e!.privateKey, this.rs);
    }
  }

  private processTokenWrite(token: Token, out: { buf: Uint8Array }): void {
    if (token === "e") {
      this.e = this.fixedEphemeral ?? this.suite.generateKeypair();
      this.sym.mixHash(this.e.publicKey);
      // PSK-mode rule (Noise 9.2): the ephemeral is also mixed into the key.
      this.sym.mixKey(this.e.publicKey);
      out.buf = concat(out.buf, this.e.publicKey);
    } else if (token === "s") {
      out.buf = concat(out.buf, this.sym.encryptAndHash(this.s.publicKey));
    } else if (token === "psk") {
      this.sym.mixKeyAndHash(this.psk!);
    } else {
      this.sym.mixKey(this.dhToken(token));
    }
  }

  private processTokenRead(token: Token, cursor: { buf: Uint8Array }): void {
    if (token === "e") {
      this.re = cursor.buf.slice(0, this.suite.dhLen);
      cursor.buf = cursor.buf.slice(this.suite.dhLen);
      this.sym.mixHash(this.re);
      // PSK-mode rule (Noise 9.2): the ephemeral is also mixed into the key.
      this.sym.mixKey(this.re);
    } else if (token === "s") {
      const len = this.suite.dhLen + 16;
      this.sym.decryptAndHash(cursor.buf.slice(0, len));
      cursor.buf = cursor.buf.slice(len);
    } else if (token === "psk") {
      this.sym.mixKeyAndHash(this.psk!);
    } else {
      this.sym.mixKey(this.dhToken(token));
    }
  }

  writeMessage(tokens: Token[], payload: Uint8Array): Uint8Array {
    const out: { buf: Uint8Array } = { buf: new Uint8Array(0) };
    for (const t of tokens) this.processTokenWrite(t, out);
    out.buf = concat(out.buf, this.sym.encryptAndHash(payload));
    return out.buf;
  }

  readMessage(tokens: Token[], message: Uint8Array): Uint8Array {
    const cursor = { buf: message };
    for (const t of tokens) this.processTokenRead(t, cursor);
    return this.sym.decryptAndHash(cursor.buf);
  }

  split(): [CipherState, CipherState] {
    return this.sym.split();
  }
}

export { MSG1, MSG2 };
