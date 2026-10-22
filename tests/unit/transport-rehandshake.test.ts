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
  const output = new Uint8Array(a.length + b.length);
  output.set(a);
  output.set(b, a.length);
  return output;
};

function setupRehandshake(
  beforeRehandshake?: (
    h: ReturnType<typeof harness>,
    session: NoiseSession,
  ) => void,
  toPairingPsk = false,
) {
  const h = harness();
  const { serverSession, serverId, server, clientId, priorHash } =
    completeHandshake(h);
  beforeRehandshake?.(h, serverSession);
  const newPsk = toPairingPsk
    ? h.store.getOrCreatePairingPsk()
    : new Uint8Array(32).fill(77);
  if (!toPairingPsk) h.store.addLongTerm(newPsk, serverId);

  const initiator = new HandshakeState({
    suite: SUITES.chacha,
    role: "initiator",
    prologue: priorHash,
    s: server,
    rs: base64urlDecode(clientId),
    psk: newPsk,
  });
  const message1 = initiator.writeMessage(
    MSG1,
    utf8.encode(JSON.stringify({ psk_id: pskId(newPsk) })),
  );
  const message1Frame = concat(
    Uint8Array.of(0),
    utf8.encode(
      JSON.stringify({
        type: "noise/handshake",
        payload: { data: base64urlEncode(message1) },
      }),
    ),
  );
  h.transport.handleRaw({
    data: serverSession.encrypt(message1Frame).buffer,
  } as MessageEvent);

  const outgoing = fakeWsSend(h).binary;
  const message2Frame = serverSession.decrypt(outgoing[outgoing.length - 1]);
  const message2 = base64urlDecode(
    JSON.parse(new TextDecoder().decode(message2Frame.subarray(1))).payload
      .data,
  );
  initiator.readMessage(MSG2, message2);
  return {
    h,
    newServerSession: new NoiseSession("initiator", initiator.split()),
  };
}

function deliverActivate(
  h: ReturnType<typeof harness>,
  session: NoiseSession,
  activities: string[],
  activeRoles: string[] | undefined,
  pairMethod?: string,
): void {
  const frame = concat(
    Uint8Array.of(0),
    utf8.encode(
      JSON.stringify({
        type: "server/activate",
        payload: {
          activities,
          active_roles: activeRoles,
          pairing: pairMethod ? { method: pairMethod } : undefined,
        },
      }),
    ),
  );
  h.transport.handleRaw({
    data: session.encrypt(frame).buffer,
  } as MessageEvent);
}

describe("transport re-handshake", () => {
  it("keeps active_roles from before the re-handshake when the next activate omits them", () => {
    const { h, newServerSession } = setupRehandshake((h, session) =>
      deliverActivate(h, session, ["playback"], ["player@v1"]),
    );

    deliverActivate(h, newServerSession, ["playback"], undefined);

    expect(h.ws.disconnected).toBe(false);
    expect(h.cb.onControlMessage).toHaveBeenLastCalledWith({
      type: "server/activate",
      payload: { activities: ["playback"], active_roles: ["player@v1"] },
    });
  });

  it("retains a queued command when playback restores the controller role", () => {
    const { h, newServerSession } = setupRehandshake();
    expect(h.transport.handshakeInfo?.trustLevel).toBe("user");

    const before = fakeWsSend(h).binary.length;
    h.transport.sendControl({
      type: "client/time",
      payload: { client_transmitted: 1 },
    });
    h.transport.sendControl({
      type: "client/state",
      payload: { available: true, player: { volume: 10 } },
    });
    h.transport.sendControl({
      type: "client/command",
      payload: { controller: { command: "play" } },
    });
    expect(fakeWsSend(h).binary.length).toBe(before);

    h.transport.sendControl({ type: "client/hello", payload: { name: "Cli" } });
    expect(fakeWsSend(h).binary.length).toBe(before + 1);
    const hello = newServerSession.decrypt(fakeWsSend(h).binary[before]);
    expect(JSON.parse(new TextDecoder().decode(hello.subarray(1))).type).toBe(
      "client/hello",
    );

    deliverActivate(
      h,
      newServerSession,
      ["playback"],
      ["player@v1", "controller@v1"],
    );
    expect(fakeWsSend(h).binary.length).toBe(before + 2);
    const command = newServerSession.decrypt(fakeWsSend(h).binary.at(-1)!);
    expect(JSON.parse(new TextDecoder().decode(command.subarray(1))).type).toBe(
      "client/command",
    );
  });

  it("drops a queued command when the controller role stays inactive", () => {
    const { h, newServerSession } = setupRehandshake();
    const before = fakeWsSend(h).binary.length;
    h.transport.sendControl({
      type: "client/command",
      payload: { controller: { command: "play" } },
    });
    h.transport.sendControl({ type: "client/hello", payload: { name: "Cli" } });

    deliverActivate(h, newServerSession, ["playback"], ["player@v1"]);

    expect(fakeWsSend(h).binary.length).toBe(before + 1);
  });

  it("drops queued normal traffic when the re-handshake enters pairing", () => {
    const { h, newServerSession } = setupRehandshake(undefined, true);
    const before = fakeWsSend(h).binary.length;
    h.transport.sendControl({
      type: "client/state",
      payload: { available: true },
    });
    h.transport.sendControl({
      type: "client/command",
      payload: { controller: { command: "play" } },
    });
    h.transport.sendControl({ type: "client/hello", payload: { name: "Cli" } });
    expect(fakeWsSend(h).binary.length).toBe(before + 1);

    deliverActivate(h, newServerSession, ["pairing"], [], "pairing_psk");

    expect(fakeWsSend(h).binary.length).toBe(before + 1);
  });
});
