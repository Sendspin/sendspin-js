import { describe, it, expect, vi } from "vitest";
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

describe("SendspinPlayer device info config", () => {
  it("reaches the device_info of client/hello", () => {
    const player = new SendspinPlayer({
      webSocket: {} as never,
      storage: memStorage(),
      manufacturer: "My Company",
      softwareVersion: "1.2.0",
    });
    const core = (
      player as unknown as {
        core: {
          transport: { sendControl(msg: object): void };
          protocolHandler: { sendClientHello(): void };
        };
      }
    ).core;
    const send = vi
      .spyOn(core.transport, "sendControl")
      .mockImplementation(() => {});

    core.protocolHandler.sendClientHello();

    expect(send.mock.calls[0][0]).toMatchObject({
      payload: {
        device_info: { manufacturer: "My Company", software_version: "1.2.0" },
      },
    });
  });
});
