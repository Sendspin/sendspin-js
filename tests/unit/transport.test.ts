import { describe, it, expect, vi } from "vitest";
import { harness, completeHandshake } from "./transport-harness";
import { SUITES } from "../../src/core/noise/suites";
import { HandshakeState, MSG1, MSG2 } from "../../src/core/noise/handshake";
import {
  base64urlEncode,
  base64urlDecode,
} from "../../src/core/noise/base64url";

const utf8 = new TextEncoder();
const concat = (a: Uint8Array, b: Uint8Array) => {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
};

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

  it("closes when the next handshake message times out", () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.transport.start();
      vi.advanceTimersByTime(30_000);
      expect(h.ws.disconnected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
