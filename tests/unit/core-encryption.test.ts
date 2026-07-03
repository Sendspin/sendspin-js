/**
 * Integration test for SendspinCore's encryption wiring: the client/init frame
 * on open, the Noise handshake driven through the adopt path, and the public
 * identity/pairing API. A minimal server-side initiator (built from the noise
 * primitives) completes the KKpsk2 handshake against the core's transport.
 */

import { describe, it, expect } from "vitest";
import { SendspinCore } from "../../src/core/core";
import { SUITES } from "../../src/core/noise/suites";
import { HandshakeState, MSG1, MSG2 } from "../../src/core/noise/handshake";
import { NoiseSession } from "../../src/core/noise/session";
import {
  base64urlEncode,
  base64urlDecode,
} from "../../src/core/noise/base64url";
import { SENTINEL_PSK, SENTINEL_PSK_ID } from "../../src/core/noise/constants";
import type { SendspinStorage } from "../../src/types";

const utf8 = new TextEncoder();
const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
};
const abuf = (u8: Uint8Array): ArrayBuffer => u8.slice().buffer;

class MockWS {
  static OPEN = 1;
  readyState = 1;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Array<string | Uint8Array> = [];
  send(d: string | Uint8Array): void {
    this.sent.push(d);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function memStorage(): SendspinStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
  };
}

function inject(ws: MockWS, data: string | ArrayBuffer): void {
  ws.onmessage?.({ data } as MessageEvent);
}

/** Drive the server side (initiator) of KKpsk2 to transport mode. */
function completeHandshake(ws: MockWS): NoiseSession {
  const clientInitStr = ws.sent[0] as string;
  const clientId = JSON.parse(clientInitStr).payload.client_id as string;

  const server = SUITES.chacha.generateKeypair();
  const serverInitStr = JSON.stringify({
    type: "server/init",
    payload: { server_id: base64urlEncode(server.publicKey), version: 1 },
  });
  inject(ws, serverInitStr);

  const prologue = concat(
    utf8.encode(clientInitStr),
    utf8.encode(serverInitStr),
  );
  const ini = new HandshakeState({
    suite: SUITES.chacha,
    role: "initiator",
    prologue,
    s: server,
    rs: base64urlDecode(clientId),
    psk: SENTINEL_PSK,
  });
  const m1 = ini.writeMessage(
    MSG1,
    utf8.encode(JSON.stringify({ psk_id: SENTINEL_PSK_ID })),
  );
  inject(
    ws,
    JSON.stringify({
      type: "noise/handshake",
      payload: { data: base64urlEncode(m1) },
    }),
  );

  const m2str = ws.sent[ws.sent.length - 1] as string;
  ini.readMessage(MSG2, base64urlDecode(JSON.parse(m2str).payload.data));
  return new NoiseSession("initiator", ini.split());
}

describe("SendspinCore encryption wiring", () => {
  it("sends client/init on open with the identity client_id", async () => {
    const ws = new MockWS();
    const core = new SendspinCore({
      webSocket: ws as unknown as WebSocket,
      storage: memStorage(),
    });
    expect(core.clientId).toHaveLength(43);

    await core.connect();

    const init = JSON.parse(ws.sent[0] as string);
    expect(init.type).toBe("client/init");
    expect(init.payload.client_id).toBe(core.clientId);
  });

  it("completes the handshake and replies to server/hello with an encrypted client/hello", async () => {
    const ws = new MockWS();
    const core = new SendspinCore({
      webSocket: ws as unknown as WebSocket,
      storage: memStorage(),
    });
    await core.connect();

    const serverSession = completeHandshake(ws);
    const before = ws.sent.length;

    // Encrypted server/hello -> core routes to protocol handler -> client/hello.
    const helloPt = concat(
      Uint8Array.of(0),
      utf8.encode(JSON.stringify({ type: "server/hello", payload: {} })),
    );
    inject(ws, abuf(serverSession.encrypt(helloPt)));

    const reply = ws.sent[before];
    expect(reply).toBeInstanceOf(Uint8Array);
    const clientHello = JSON.parse(
      new TextDecoder().decode(
        serverSession.decrypt(reply as Uint8Array).subarray(1),
      ),
    );
    expect(clientHello.type).toBe("client/hello");
  });

  it("exposes a 43-char pairingPsk that rotates", () => {
    const core = new SendspinCore({
      webSocket: new MockWS() as unknown as WebSocket,
      storage: memStorage(),
    });
    const psk = core.pairingPsk;
    expect(psk).toHaveLength(43);
    const rotated = core.rotatePairingPsk();
    expect(rotated).toHaveLength(43);
    expect(rotated).not.toBe(psk);
  });

  it("returns null pairing credentials without storage", () => {
    const core = new SendspinCore({
      webSocket: new MockWS() as unknown as WebSocket,
      storage: null,
    });
    expect(core.pairingPsk).toBeNull();
    expect(core.rotatePairingPsk()).toBeNull();
  });
});
