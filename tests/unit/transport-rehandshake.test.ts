import { describe, it, expect } from "vitest";
import { harness, completeHandshake, fakeWsSend } from "./transport-harness";
import { SUITES } from "../../src/core/noise/suites";
import { HandshakeState, MSG1, MSG2 } from "../../src/core/noise/handshake";
import { NoiseSession } from "../../src/core/noise/session";
import {
  base64urlEncode,
  base64urlDecode,
} from "../../src/core/noise/base64url";
import { pskId } from "../../src/core/noise/constants";

const utf8 = new TextEncoder();
const concat = (a: Uint8Array, b: Uint8Array) => {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
};

describe("transport re-handshake", () => {
  it("promotes trust, quiesces outbound, and flushes after server/activate", () => {
    const h = harness();
    const { serverSession, serverId, server, clientId, priorHash } =
      completeHandshake(h);

    // Provision a long-term PSK on both sides, bound to serverId.
    const ltPsk = new Uint8Array(32).fill(77);
    h.store.addLongTerm(ltPsk, serverId);
    expect(h.transport.handshakeInfo?.trustLevel).toBe("none");

    // Server re-handshakes to the long-term PSK, prologue = prior handshake hash.
    const ini = new HandshakeState({
      suite: SUITES.chacha,
      role: "initiator",
      prologue: priorHash,
      s: server,
      rs: base64urlDecode(clientId),
      psk: ltPsk,
    });
    const rm1 = ini.writeMessage(
      MSG1,
      utf8.encode(JSON.stringify({ psk_id: pskId(ltPsk) })),
    );
    // Deliver re-handshake msg 1 as an encrypted control frame under the OLD keys.
    const rm1Frame = concat(
      Uint8Array.of(0),
      utf8.encode(
        JSON.stringify({
          type: "noise/handshake",
          payload: { data: base64urlEncode(rm1) },
        }),
      ),
    );
    h.transport.handleRaw({
      data: serverSession.encrypt(rm1Frame).buffer,
    } as MessageEvent);

    // Client's msg 2 comes back on the OLD keys; server reads it and both split.
    const outFrames = fakeWsSend(h).binary;
    const rm2Frame = serverSession.decrypt(outFrames[outFrames.length - 1]);
    const rm2 = base64urlDecode(
      JSON.parse(new TextDecoder().decode(rm2Frame.subarray(1))).payload.data,
    );
    ini.readMessage(MSG2, rm2);
    const newServerSession = new NoiseSession("initiator", ini.split());

    expect(h.transport.handshakeInfo?.trustLevel).toBe("user");

    // While quiesced, a client/time send is queued, not transmitted.
    const before = fakeWsSend(h).binary.length;
    h.transport.sendControl({
      type: "client/time",
      payload: { client_transmitted: 1 },
    });
    expect(fakeWsSend(h).binary.length).toBe(before);

    // Deadlock guard: client/hello MUST flow even while quiesced (post-re-handshake
    // the server waits for it before sending server/activate). It goes out under the
    // NEW keys immediately, not queued.
    h.transport.sendControl({ type: "client/hello", payload: { name: "Cli" } });
    expect(fakeWsSend(h).binary.length).toBe(before + 1);
    const helloPt = newServerSession.decrypt(fakeWsSend(h).binary[before]);
    expect(JSON.parse(new TextDecoder().decode(helloPt.subarray(1))).type).toBe(
      "client/hello",
    );

    // server/activate under NEW keys un-quiesces and flushes the queued client/time.
    const actFrame = concat(
      Uint8Array.of(0),
      utf8.encode(
        JSON.stringify({
          type: "server/activate",
          payload: { activities: ["playback"], active_roles: ["player@v1"] },
        }),
      ),
    );
    h.transport.handleRaw({
      data: newServerSession.encrypt(actFrame).buffer,
    } as MessageEvent);

    const flushed = fakeWsSend(h).binary[fakeWsSend(h).binary.length - 1];
    const flushedPt = newServerSession.decrypt(flushed);
    expect(
      JSON.parse(new TextDecoder().decode(flushedPt.subarray(1))).type,
    ).toBe("client/time");
  });
});
