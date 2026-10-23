import { describe, it, expect } from "vitest";
import { SendspinPlayer } from "../../src/index";
import type { PairMethodDescriptor, SendspinStorage } from "../../src/types";

function memStorage(): SendspinStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

/** The descriptors the player would advertise in client/hello. */
function descriptorsOf(player: SendspinPlayer): PairMethodDescriptor[] {
  return (
    player as unknown as {
      core: { pairing: { descriptors(): PairMethodDescriptor[] } };
    }
  ).core.pairing.descriptors();
}

describe("SendspinPlayer pairing config", () => {
  // SendspinPlayer forwards an explicit list of options to SendspinCore, so a
  // new pairing option is easy to drop on the way through.
  it("reaches the advertised descriptors", () => {
    const player = new SendspinPlayer({
      webSocket: {} as never,
      storage: memStorage(),
      onPairingCode: () => undefined,
      pairingCodeOutChannels: ["display", "speaker"],
      minPinLength: 8,
      staticPairingCode: "12345678",
      staticPairingCodeLocations: ["device", "leaflet"],
      pairingPskLocations: ["leaflet"],
    });

    const byMethod = Object.fromEntries(
      descriptorsOf(player).map((d) => [d.method, d]),
    );
    expect(byMethod.dynamic_pin.out_channels).toEqual(["display", "speaker"]);
    expect(byMethod.dynamic_pin.min_pin_length).toBe(8);
    expect(byMethod.static_pin.locations).toEqual(["device", "leaflet"]);
    expect(byMethod.pairing_psk.locations).toEqual(["leaflet"]);
  });
});
