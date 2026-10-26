import { describe, it, expect, vi } from "vitest";
import {
  harness,
  completeHandshake,
  noise1Payload,
  readNoise2,
  sendNoise1,
} from "./transport-harness";
import { SUITES } from "../../src/core/noise/suites";
import { base64urlEncode } from "../../src/core/noise/base64url";
import { SENTINEL_PSK, SENTINEL_PSK_ID } from "../../src/core/noise/constants";

const utf8 = new TextEncoder();
const concat = (a: Uint8Array, b: Uint8Array) => {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
};

describe("SendspinTransport", () => {
  it("drops control messages sent before the handshake completes", () => {
    const h = harness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    h.transport.sendControl({ type: "client/state", payload: {} });

    expect(h.ws.sentBinary).toHaveLength(0);
    warn.mockRestore();
  });

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

  it("completes an initial handshake with the Sentinel PSK on a psk_id miss", () => {
    const h = harness();
    const unknown = new Uint8Array(32).fill(1);
    const { ini } = sendNoise1(h, SENTINEL_PSK, noise1Payload(unknown, "lt"));

    readNoise2(h, ini);
    expect(h.ws.disconnected).toBe(false);
    expect(h.transport.handshakeInfo?.category).toBe("sentinel");
  });

  it("treats a PSK held under another category as a miss", () => {
    const h = harness();
    const server = SUITES.chacha.generateKeypair();
    const lt = new Uint8Array(32).fill(2);
    h.store.addLongTerm(lt, base64urlEncode(server.publicKey));
    const { ini } = sendNoise1(
      h,
      SENTINEL_PSK,
      noise1Payload(lt, "pr"),
      server,
    );

    readNoise2(h, ini);
    expect(h.transport.handshakeInfo?.category).toBe("sentinel");
  });

  it("closes when the matched long-term PSK is bound to another server", () => {
    const h = harness();
    const other = SUITES.chacha.generateKeypair();
    const lt = new Uint8Array(32).fill(3);
    h.store.addLongTerm(lt, base64urlEncode(other.publicKey));
    sendNoise1(h, lt, noise1Payload(lt, "lt"));

    expect(h.ws.disconnected).toBe(true);
    expect(h.ws.sentText).toHaveLength(1);
  });

  const invalidUtf8 = utf8.encode(
    `{"psk_id":"${SENTINEL_PSK_ID}","psk_category":"sn","x":"_"}`,
  );
  invalidUtf8[invalidUtf8.length - 3] = 0xff;
  it.each([
    ["no psk_category", { psk_id: SENTINEL_PSK_ID }],
    [
      "an unknown psk_category",
      { psk_id: SENTINEL_PSK_ID, psk_category: "xx" },
    ],
    ["a short psk_id", { psk_id: "abc", psk_category: "sn" }],
    ["invalid UTF-8", invalidUtf8],
  ])("closes without falling back on a payload with %s", (_, payload) => {
    const h = harness();
    const bytes =
      payload instanceof Uint8Array
        ? payload
        : utf8.encode(JSON.stringify(payload));
    sendNoise1(h, SENTINEL_PSK, bytes);

    expect(h.ws.disconnected).toBe(true);
    expect(h.ws.sentText).toHaveLength(1);
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

  it("drops the handshake timeout when the socket closes", () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.transport.start(); // arms the handshake timeout
      h.transport.onSocketClosed();
      // A surviving timeout would call disconnect(), which turns off reconnect.
      vi.advanceTimersByTime(120_000);
      expect(h.ws.disconnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
