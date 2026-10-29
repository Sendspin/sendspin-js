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
import { SENTINEL_PSK, pskId } from "../../src/core/noise/constants";

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

export function harness(unpairedAccess = true) {
  const ws = fakeWs();
  const identity = Identity.loadOrCreate(null);
  const store = new PskStore(null);
  const cb = {
    onHandshakeComplete: vi.fn(),
    onControlMessage: vi.fn(),
    onBinaryMessage: vi.fn(),
    onActivateRefused: vi.fn(),
  };
  const transport = new SendspinTransport(
    ws as never,
    {
      identity,
      pskStore: store,
      suiteId: "chacha",
      unpairedAccess,
      pairMethods: () => ({ pairing_psk: {} }),
    },
    cb,
  );
  return { ws, identity, store, cb, transport };
}

export function fakeWsSend(h: ReturnType<typeof harness>) {
  return { text: h.ws.sentText, binary: h.ws.sentBinary };
}

/** JSON payload of a Noise message 1 that selects `psk` as `category`. */
export function noise1Payload(psk: Uint8Array, category: string): Uint8Array {
  return utf8.encode(
    JSON.stringify({ psk_id: pskId(psk), psk_category: category }),
  );
}

/** Send server/init and a Noise message 1 keyed with `psk`, return the server's handshake state. */
export function sendNoise1(
  h: ReturnType<typeof harness>,
  psk: Uint8Array,
  payload: Uint8Array,
  server = SUITES.chacha.generateKeypair(),
) {
  h.transport.start();
  const clientInitStr = h.ws.sentText[0];
  const clientId = JSON.parse(clientInitStr).payload.client_id as string;

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
    psk,
  });
  const m1 = ini.writeMessage(MSG1, payload);
  h.transport.handleRaw({
    data: JSON.stringify({
      type: "noise/handshake",
      payload: { data: base64urlEncode(m1) },
    }),
  } as MessageEvent);
  return { ini, server, serverId, clientId };
}

/** Read the client's Noise message 2 and return the server's session. */
export function readNoise2(
  h: ReturnType<typeof harness>,
  ini: HandshakeState,
): NoiseSession {
  const m2str = h.ws.sentText[h.ws.sentText.length - 1];
  ini.readMessage(MSG2, base64urlDecode(JSON.parse(m2str).payload.data));
  return new NoiseSession("initiator", ini.split());
}

/** Run the full handshake; return the initiator-side (server) session and keys. */
export function completeHandshake(h: ReturnType<typeof harness>) {
  const { ini, server, serverId, clientId } = sendNoise1(
    h,
    SENTINEL_PSK,
    noise1Payload(SENTINEL_PSK, "sn"),
  );
  return {
    serverSession: readNoise2(h, ini),
    serverId,
    server,
    clientId,
    priorHash: ini.handshakeHash,
  };
}

/**
 * Complete a full handshake authenticated by the long-term `psk`, added to the
 * client's store beforehand and bound to the server's server_id.
 */
export function completeHandshakeWithPsk(
  h: ReturnType<typeof harness>,
  psk: Uint8Array,
) {
  const server = SUITES.chacha.generateKeypair();
  h.store.addLongTerm(psk, base64urlEncode(server.publicKey));
  const { ini, serverId, clientId } = sendNoise1(
    h,
    psk,
    noise1Payload(psk, "lt"),
    server,
  );
  return {
    serverSession: readNoise2(h, ini),
    serverId,
    server,
    clientId,
    priorHash: ini.handshakeHash,
  };
}
