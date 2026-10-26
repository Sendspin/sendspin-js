import { describe, it, expect } from "vitest";
import { SendspinPlayer } from "../../src/index";
import type { SendspinStorage, SupportedPairMethods } from "../../src/types";

function memStorage(): SendspinStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

/** The pairing methods the player would advertise in client/hello. */
function pairMethodsOf(player: SendspinPlayer): SupportedPairMethods {
  return (
    player as unknown as {
      core: { pairing: { supportedPairMethods(): SupportedPairMethods } };
    }
  ).core.pairing.supportedPairMethods();
}

describe("SendspinPlayer pairing config", () => {
  // SendspinPlayer forwards an explicit list of options to SendspinCore, so a
  // new pairing option is easy to drop on the way through.
  it("reaches the advertised pairing methods", () => {
    const player = new SendspinPlayer({
      webSocket: {} as never,
      storage: memStorage(),
      onPairingCode: () => undefined,
      pairingCodeOutChannels: ["display", "speaker"],
      staticPairingCode: "12345678",
      staticPairingCodeLocations: ["device", "leaflet"],
      pairingPskLocations: ["leaflet"],
    });

    const methods = pairMethodsOf(player);
    expect(methods.dynamic_pairing_code!.out_channels).toEqual([
      "display",
      "speaker",
    ]);
    expect(methods.static_pairing_code!.locations).toEqual([
      "device",
      "leaflet",
    ]);
    expect(methods.pairing_psk.locations).toEqual(["leaflet"]);
  });
});
