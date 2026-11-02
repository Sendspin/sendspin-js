/**
 * Unit tests for application-specific roles, driven through SendspinCore with
 * the transport's send methods replaced by spies.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { SendspinCore } from "../../src/core/core";
import { SendspinPlayer } from "../../src/index";
import type {
  ApplicationRole,
  ApplicationRoleSession,
  SendspinStorage,
} from "../../src/types";

const DISPLAY_V1 = "_example_display@v1";
const DISPLAY_V2 = "_example_display@v2";

function makeRole(
  id: string,
  overrides: Partial<ApplicationRole> = {},
): ApplicationRole & { session?: ApplicationRoleSession } {
  const role: ApplicationRole & { session?: ApplicationRoleSession } = {
    id,
    binaryMessageIds: [200],
    onActivate: vi.fn((session: ApplicationRoleSession) => {
      role.session = session;
    }),
    onDeactivate: vi.fn(),
    onServerState: vi.fn(),
    onServerCommand: vi.fn(),
    onStreamStart: vi.fn(),
    onStreamClear: vi.fn(),
    onStreamEnd: vi.fn(),
    onBinaryMessage: vi.fn(),
    ...overrides,
  };
  return role;
}

function setup(roles: ApplicationRole[]) {
  const core = new SendspinCore({ url: "ws://h", applicationRoles: roles });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = core as any;
  const sendControl = vi.fn();
  const sendBinary = vi.fn();
  internals.transport.sendControl = sendControl;
  internals.transport.sendBinary = sendBinary;
  const route = (type: string, payload: object) =>
    internals.routeControl({ type, payload }, 0);
  const activate = (activeRoles: string[]) =>
    route("server/activate", {
      activities: ["playback"],
      active_roles: activeRoles,
    });
  const deliverBinary = (bytes: number[], receivedAtUs = 0) =>
    internals.transport.cb.onBinaryMessage(
      Uint8Array.from(bytes),
      receivedAtUs,
    );
  const sent = (type: string) =>
    sendControl.mock.calls.filter(([msg]) => msg.type === type);
  return {
    core,
    internals,
    sendControl,
    sendBinary,
    route,
    activate,
    deliverBinary,
    sent,
  };
}

let current: SendspinCore | null = null;
function track<T extends { core: SendspinCore }>(t: T): T {
  current = t.core;
  return t;
}

afterEach(() => {
  current?.disconnect();
  current = null;
});

describe("application role registration", () => {
  it.each([
    ["a name without a leading underscore", [{ id: "example@v1" }]],
    ["a name without a version", [{ id: "_example" }]],
    ["the same role twice", [{ id: DISPLAY_V1 }, { id: DISPLAY_V1 }]],
    [
      "a binary ID outside 192-255",
      [{ id: DISPLAY_V1, binaryMessageIds: [191] }],
    ],
    [
      "one binary ID in two role families",
      [
        { id: DISPLAY_V1, binaryMessageIds: [200] },
        { id: "_example_light@v1", binaryMessageIds: [200] },
      ],
    ],
  ])("rejects %s", (_, roles) => {
    expect(
      () => new SendspinCore({ url: "ws://h", applicationRoles: roles }),
    ).toThrow();
  });

  it("advertises roles after the built-in ones with their support objects", () => {
    const { route, sent } = track(
      setup([
        makeRole(DISPLAY_V2, { support: { width: 64 } }),
        makeRole(DISPLAY_V1),
      ]),
    );
    route("server/hello", { name: "Server" });

    const hello = sent("client/hello")[0][0].payload;
    expect(hello.supported_roles).toEqual([
      "player@v1",
      "controller@v1",
      "metadata@v1",
      DISPLAY_V2,
      DISPLAY_V1,
    ]);
    expect(hello[`${DISPLAY_V2}_support`]).toEqual({ width: 64 });
    expect(`${DISPLAY_V1}_support` in hello).toBe(false);
  });
});

describe("application role activation", () => {
  it("activates a role before the client/state that carries its object", () => {
    let statesBeforeActivate = -1;
    const role = makeRole(DISPLAY_V1, {
      getState: () => ({ brightness: 3 }),
    });
    const t = track(setup([role]));
    role.onActivate = vi.fn((session) => {
      role.session = session;
      statesBeforeActivate = t.sent("client/state").length;
    });
    t.route("server/hello", {
      name: "Server",
      [`${DISPLAY_V1}_support`]: { fonts: ["a"] },
    });
    t.activate([DISPLAY_V1]);

    expect(statesBeforeActivate).toBe(0);
    expect(role.session!.serverSupport).toEqual({ fonts: ["a"] });
    expect(t.sent("client/state")[0][0].payload._example_display).toEqual({
      brightness: 3,
    });
  });

  it("sends client/state after a version swap even when the state is unchanged", () => {
    const v1 = makeRole(DISPLAY_V1, { getState: () => ({ on: true }) });
    const v2 = makeRole(DISPLAY_V2, { getState: () => ({ on: true }) });
    const t = track(setup([v2, v1]));
    t.activate([DISPLAY_V1]);
    t.sendControl.mockClear();

    t.activate([DISPLAY_V2]);

    expect(t.sent("client/state")).toHaveLength(1);
    expect(
      vi.mocked(v1.onDeactivate!).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(v2.onActivate!).mock.invocationCallOrder[0]);
  });

  it("stops serving the role once it is removed", () => {
    const role = makeRole(DISPLAY_V1);
    const t = track(setup([role]));
    t.activate([DISPLAY_V1]);

    t.activate([]);
    t.sendControl.mockClear();
    t.route("server/state", { _example_display: { text: "hi" } });
    role.session!.sendCommand({ command: "ping" });
    role.session!.sendBinaryMessage(200, Uint8Array.of(1));

    expect(role.onDeactivate).toHaveBeenCalledTimes(1);
    expect(role.onServerState).not.toHaveBeenCalled();
    expect(t.sendControl).not.toHaveBeenCalled();
    expect(t.sendBinary).not.toHaveBeenCalled();
  });

  it("ends an open client stream before deactivating a removed role", () => {
    const role = makeRole(DISPLAY_V1);
    const t = track(setup([role]));
    t.activate([DISPLAY_V1]);
    role.session!.startClientStream({ codec: "pcm" });
    expect(t.sendControl).toHaveBeenLastCalledWith(
      {
        type: "client-stream/start",
        payload: { _example_display: { codec: "pcm" } },
      },
      DISPLAY_V1,
    );

    t.activate([]);

    const end = t.sent("client-stream/end");
    expect(end).toEqual([
      [
        { type: "client-stream/end", payload: { roles: ["_example_display"] } },
        DISPLAY_V1,
      ],
    ]);
    expect(
      t.sendControl.mock.invocationCallOrder[
        t.sendControl.mock.calls.indexOf(end[0])
      ],
    ).toBeLessThan(vi.mocked(role.onDeactivate!).mock.invocationCallOrder[0]);
  });

  it("keeps roles active across a re-handshake and deactivates them on close", () => {
    const role = makeRole(DISPLAY_V1);
    const t = track(setup([role]));
    const info = { category: "long_term", serverId: "s", entry: {} };
    t.internals.transport.cb.onHandshakeComplete(info);
    t.activate([DISPLAY_V1]);

    t.internals.transport.cb.onHandshakeComplete(info);
    t.activate([DISPLAY_V1]);
    expect(role.onActivate).toHaveBeenCalledTimes(1);
    expect(role.onDeactivate).not.toHaveBeenCalled();

    t.internals.onTransportClose();
    expect(role.onDeactivate).toHaveBeenCalledTimes(1);
  });

  it("stops activating when a role disconnects from onActivate", () => {
    const first = makeRole(DISPLAY_V1, {
      onActivate: () => t.core.disconnect(),
    });
    const second = makeRole("_example_light@v1", { binaryMessageIds: [] });
    const t = track(setup([first, second]));

    t.activate([DISPLAY_V1, "_example_light@v1"]);

    expect(second.onActivate).not.toHaveBeenCalled();
    expect(t.sent("client/time")).toHaveLength(0);
  });

  it("skips the new version when the old one disconnects from onDeactivate", () => {
    const v1 = makeRole(DISPLAY_V1, {
      onDeactivate: () => t.core.disconnect(),
    });
    const v2 = makeRole(DISPLAY_V2);
    const t = track(setup([v2, v1]));
    t.activate([DISPLAY_V1]);

    t.activate([DISPLAY_V2]);

    expect(v2.onActivate).not.toHaveBeenCalled();
  });

  it("finishes activation when a role callback throws", () => {
    const broken = makeRole(DISPLAY_V1, {
      onActivate: () => {
        throw new Error("boom");
      },
      getState: () => {
        throw new Error("boom");
      },
    });
    const other = makeRole("_example_light@v1", { binaryMessageIds: [] });
    const t = track(setup([broken, other]));
    vi.spyOn(console, "error").mockImplementation(() => {});

    t.activate([DISPLAY_V1, "_example_light@v1"]);

    expect(other.onActivate).toHaveBeenCalledTimes(1);
    expect(t.sent("client/time")).toHaveLength(1);
    const state = t.sent("client/state")[0][0].payload;
    expect("_example_display" in state).toBe(false);
  });
});

describe("application role messages", () => {
  it("routes server/state, server/command and stream/start objects by family name", () => {
    const role = makeRole(DISPLAY_V1);
    const t = track(setup([role]));
    t.activate([DISPLAY_V1]);

    t.route("server/state", { _example_display: { text: "hi" }, _other: {} });
    t.route("server/command", { _example_display: { command: "blink" } });
    t.route("stream/start", {
      server_transmitted: 10,
      _example_display: { fps: 30 },
    });
    t.route("stream/start", {
      server_transmitted: 20,
      _example_display: { fps: 60 },
    });

    expect(role.onServerState).toHaveBeenCalledExactlyOnceWith({ text: "hi" });
    expect(role.onServerCommand).toHaveBeenCalledExactlyOnceWith({
      command: "blink",
    });
    expect(vi.mocked(role.onStreamStart!).mock.calls).toEqual([
      [{ fps: 30 }, false, 10],
      [{ fps: 60 }, true, 20],
    ]);
  });

  it("clears and ends the role's stream only as stream/clear and stream/end target it", () => {
    const role = makeRole(DISPLAY_V1);
    const t = track(setup([role]));
    t.activate([DISPLAY_V1]);
    t.route("stream/start", { server_transmitted: 0, _example_display: {} });

    t.route("stream/clear", { server_transmitted: 1 });
    expect(role.onStreamClear).not.toHaveBeenCalled();
    t.route("stream/clear", {
      server_transmitted: 2,
      roles: ["_example_display"],
    });
    expect(role.onStreamClear).toHaveBeenCalledExactlyOnceWith(2);

    t.route("stream/end", { roles: ["player"] });
    expect(role.onStreamEnd).not.toHaveBeenCalled();
    t.route("stream/end", {});
    t.route("stream/end", {});
    expect(role.onStreamEnd).toHaveBeenCalledTimes(1);
  });

  it("routes binary IDs to the active role that claims them", () => {
    const display = makeRole(DISPLAY_V1, { binaryMessageIds: [200] });
    const light = makeRole("_example_light@v1", { binaryMessageIds: [201] });
    const t = track(setup([display, light]));
    const playerBinary = vi.spyOn(t.core, "handleBinaryMessage");
    t.activate([DISPLAY_V1, "_example_light@v1"]);

    t.deliverBinary([200, 7, 8], 1234);
    t.deliverBinary([4, 0, 0]);
    t.activate(["_example_light@v1"]);
    t.deliverBinary([200, 9]);

    expect(display.onBinaryMessage).toHaveBeenCalledExactlyOnceWith(
      200,
      Uint8Array.of(7, 8),
      1234,
    );
    expect(light.onBinaryMessage).not.toHaveBeenCalled();
    expect(playerBinary).toHaveBeenCalledTimes(1);
  });

  it("sends commands and binary messages under the role", () => {
    const role = makeRole(DISPLAY_V1);
    const t = track(setup([role]));
    t.activate([DISPLAY_V1]);

    role.session!.sendCommand({ command: "ping" });
    role.session!.sendBinaryMessage(200, Uint8Array.of(1, 2));

    expect(t.sendControl).toHaveBeenLastCalledWith(
      {
        type: "client/command",
        payload: { _example_display: { command: "ping" } },
      },
      DISPLAY_V1,
    );
    expect(t.sendBinary).toHaveBeenCalledExactlyOnceWith(
      200,
      Uint8Array.of(1, 2),
      DISPLAY_V1,
    );
    expect(() =>
      role.session!.sendBinaryMessage(201, Uint8Array.of(1)),
    ).toThrow();
  });
});

describe("SendspinPlayer application roles config", () => {
  it("reaches the advertised roles", () => {
    const storage: SendspinStorage = {
      getItem: () => null,
      setItem: () => {},
    };
    const player = new SendspinPlayer({
      webSocket: {} as never,
      storage,
      applicationRoles: [{ id: DISPLAY_V1 }],
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

    expect(
      (send.mock.calls[0][0] as { payload: { supported_roles: string[] } })
        .payload.supported_roles,
    ).toContain(DISPLAY_V1);
  });
});
