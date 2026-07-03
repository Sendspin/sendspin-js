import { describe, it, expect } from "vitest";
import { MessageType } from "../../../src/types";
import type { ClientInit, ServerActivate } from "../../../src/types";

describe("message types", () => {
  it("exposes the new handshake/pairing enum members", () => {
    expect(MessageType.CLIENT_INIT).toBe("client/init");
    expect(MessageType.SERVER_INIT).toBe("server/init");
    expect(MessageType.NOISE_HANDSHAKE).toBe("noise/handshake");
    expect(MessageType.SERVER_ACTIVATE).toBe("server/activate");
    expect(MessageType.SERVER_UNPAIR).toBe("server/unpair");
    expect(MessageType.CLIENT_PAIR_FINALIZE).toBe("client/pair-finalize");
  });

  it("builds a client/init and server/activate shape", () => {
    const init: ClientInit = {
      type: MessageType.CLIENT_INIT,
      payload: { client_id: "x", version: 1, suite: "25519_ChaChaPoly_SHA256" },
    };
    const act: ServerActivate = {
      type: MessageType.SERVER_ACTIVATE,
      payload: { activities: ["playback"], active_roles: ["player@v1"] },
    };
    expect(init.payload.version).toBe(1);
    expect(act.payload.activities).toContain("playback");
  });
});
