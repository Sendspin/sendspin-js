import { describe, it, expect, vi } from "vitest";
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

function fakeWs() {
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

function harness() {
  const ws = fakeWs();
  const identity = Identity.loadOrCreate(null);
  const store = new PskStore(null);
  const cb = {
    onHandshakeComplete: vi.fn(),
    onControlMessage: vi.fn(),
    onBinaryMessage: vi.fn(),
    onClose: vi.fn(),
  };
  const transport = new SendspinTransport(
    ws as never,
    { identity, pskStore: store, suiteId: "chacha" },
    cb,
  );
  return { ws, identity, cb, transport };
}

/** Run the full handshake; return the initiator-side NoiseSession (server). */
function completeHandshake(h: ReturnType<typeof harness>) {
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
  };
}

describe("SendspinTransport", () => {
  it("completes the Sentinel handshake and round-trips control + audio + fragments", () => {
    const h = harness();
    const { serverSession, serverId } = completeHandshake(h);
    expect(h.cb.onHandshakeComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        trustLevel: "none",
        category: "sentinel",
        serverId,
      }),
    );

    // server/hello inbound
    const helloPt = concat(
      Uint8Array.of(0),
      utf8.encode(
        JSON.stringify({ type: "server/hello", payload: { name: "Srv" } }),
      ),
    );
    h.transport.handleRaw({
      data: serverSession.encrypt(helloPt).buffer,
    } as MessageEvent);
    expect(h.cb.onControlMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "server/hello" }),
    );

    // outbound control decrypts on the server
    h.transport.sendControl({ type: "client/hello", payload: { name: "Cli" } });
    const outPt = serverSession.decrypt(h.ws.sentBinary[0]);
    expect(JSON.parse(new TextDecoder().decode(outPt.subarray(1))).type).toBe(
      "client/hello",
    );

    // audio passthrough (type 4)
    const audio = new Uint8Array(20);
    audio[0] = 4;
    audio[9] = 0xaa;
    h.transport.handleRaw({
      data: serverSession.encrypt(audio).buffer,
    } as MessageEvent);
    const got = h.cb.onBinaryMessage.mock.calls[0][0] as Uint8Array;
    expect(got[0]).toBe(4);
    expect(got[9]).toBe(0xaa);

    // fragmentation: origType 4, two parts
    const f1 = new Uint8Array([2, 4, 1, 2, 3]); // [more][origType=4][data 1,2,3]
    const f2 = new Uint8Array([3, 4, 5]); // [end][data 4,5]
    h.transport.handleRaw({
      data: serverSession.encrypt(f1).buffer,
    } as MessageEvent);
    h.transport.handleRaw({
      data: serverSession.encrypt(f2).buffer,
    } as MessageEvent);
    const frag = h.cb.onBinaryMessage.mock.calls[1][0] as Uint8Array;
    expect(Array.from(frag)).toEqual([4, 1, 2, 3, 4, 5]);
  });

  it("closes on a psk_id miss", () => {
    const h = harness();
    h.transport.start();
    const clientId = JSON.parse(h.ws.sentText[0]).payload.client_id as string;
    const server = SUITES.chacha.generateKeypair();
    const serverInitStr = JSON.stringify({
      type: "server/init",
      payload: { server_id: base64urlEncode(server.publicKey), version: 1 },
    });
    h.transport.handleRaw({ data: serverInitStr } as MessageEvent);
    const prologue = concat(
      utf8.encode(h.ws.sentText[0]),
      utf8.encode(serverInitStr),
    );
    const ini = new HandshakeState({
      suite: SUITES.chacha,
      role: "initiator",
      prologue,
      s: server,
      rs: base64urlDecode(clientId),
      psk: new Uint8Array(32).fill(1),
    });
    const m1 = ini.writeMessage(
      MSG1,
      utf8.encode(JSON.stringify({ psk_id: "unknown-psk-id" })),
    );
    h.transport.handleRaw({
      data: JSON.stringify({
        type: "noise/handshake",
        payload: { data: base64urlEncode(m1) },
      }),
    } as MessageEvent);
    expect(h.ws.disconnected).toBe(true);
  });

  it("closes on a bad server/init version", () => {
    const h = harness();
    h.transport.start();
    h.transport.handleRaw({
      data: JSON.stringify({
        type: "server/init",
        payload: { server_id: "x", version: 2 },
      }),
    } as MessageEvent);
    expect(h.ws.disconnected).toBe(true);
  });
});
