import { vi } from "vitest";
import { SendspinTransport } from "../../src/core/transport";
import { Identity } from "../../src/core/noise/identity";
import { PskStore } from "../../src/core/noise/psk";
import { SUITES } from "../../src/core/noise/suites";
import { HandshakeState, MSG1, MSG2 } from "../../src/core/noise/handshake";
import { NoiseSession } from "../../src/core/noise/session";
import {
  base64urlEncode,
  base64urlDecode,
} from "../../src/core/noise/base64url";
import { SENTINEL_PSK, SENTINEL_PSK_ID } from "../../src/core/noise/constants";

const utf8 = new TextEncoder();
const concat = (a: Uint8Array, b: Uint8Array) => {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
};

export function fakeWs() {
  const text: string[] = [];
  const binary: Uint8Array[] = [];
  return {
    sentText: text,
    sentBinary: binary,
    disconnected: false,
    sendText(s: string) {
      text.push(s);
    },
    sendBinary(b: Uint8Array) {
      binary.push(b);
    },
    disconnect() {
      this.disconnected = true;
    },
  };
}

export function harness() {
  const ws = fakeWs();
  const identity = Identity.loadOrCreate(null);
  const store = new PskStore(null);
  const cb = {
    onHandshakeComplete: vi.fn(),
    onControlMessage: vi.fn(),
    onBinaryMessage: vi.fn(),
  };
  const transport = new SendspinTransport(
    ws as never,
    { identity, pskStore: store, suiteId: "chacha" },
    cb,
  );
  return { ws, identity, store, cb, transport };
}

export function fakeWsSend(h: ReturnType<typeof harness>) {
  return { text: h.ws.sentText, binary: h.ws.sentBinary };
}

/** Run the full handshake; return the initiator-side (server) session and keys. */
export function completeHandshake(h: ReturnType<typeof harness>) {
  h.transport.start();
  const clientInitStr = h.ws.sentText[0];
  const clientId = JSON.parse(clientInitStr).payload.client_id as string;

  const server = SUITES.chacha.generateKeypair();
  const serverId = base64urlEncode(server.publicKey);
  const serverInitStr = JSON.stringify({
    type: "server/init",
    payload: { server_id: serverId, version: 1 },
  });
  h.transport.handleRaw({ data: serverInitStr } as MessageEvent);

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
  h.transport.handleRaw({
    data: JSON.stringify({
      type: "noise/handshake",
      payload: { data: base64urlEncode(m1) },
    }),
  } as MessageEvent);

  const m2str = h.ws.sentText[h.ws.sentText.length - 1];
  const m2 = base64urlDecode(JSON.parse(m2str).payload.data);
  ini.readMessage(MSG2, m2);
  return {
    serverSession: new NoiseSession("initiator", ini.split()),
    serverId,
    server,
    clientId,
    priorHash: ini.handshakeHash,
  };
}
