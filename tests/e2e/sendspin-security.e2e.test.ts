import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, randomInt } from "node:crypto";
import { WebSocket } from "ws";
import { SendspinCore } from "../../src/core/core";
import type { SendspinCoreConfig, SendspinStorage } from "../../src/types";
import type { SuiteId } from "../../src/core/noise/suites";
import {
  AiosendspinServer,
  reportDeferredViolations,
  type PairingResult,
} from "../helpers/aiosendspin-server";

if (typeof globalThis.WebSocket === "undefined") {
  // @ts-expect-error ws implements the browser WebSocket interface used by the SDK
  globalThis.WebSocket = WebSocket;
}

const TEST_TIMEOUT_MS = 45_000;

function memoryStorage(): SendspinStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function openWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await Promise.race([
    new Promise<void>((resolve) => socket.once("close", () => resolve())),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("WebSocket did not close")), 5_000),
    ),
  ]);
}

interface ConnectOptions {
  clientName: string;
  suite?: SuiteId;
  storage?: SendspinStorage;
  onPairing?: SendspinCoreConfig["onPairing"];
  onPairingCode?: SendspinCoreConfig["onPairingCode"];
  pairingCodeOutChannels?: SendspinCoreConfig["pairingCodeOutChannels"];
  staticPairingCode?: string;
  staticPairingCodeLocations?: SendspinCoreConfig["staticPairingCodeLocations"];
  pairingPskLocations?: SendspinCoreConfig["pairingPskLocations"];
  unpairedAccess?: boolean;
}

interface Connection {
  core: SendspinCore;
  socket: WebSocket;
  outboundText: string[];
  outboundBinary: Uint8Array[];
  inboundText: string[];
  inboundBinary: Uint8Array[];
  mutateNextBinary(): void;
}

async function connectCore(
  server: AiosendspinServer,
  options: ConnectOptions,
): Promise<Connection> {
  const socket = await openWebSocket(server.url);
  const outboundText: string[] = [];
  const outboundBinary: Uint8Array[] = [];
  const inboundText: string[] = [];
  const inboundBinary: Uint8Array[] = [];
  let binaryTransform: ((bytes: Uint8Array) => Uint8Array) | null = null;

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      inboundBinary.push(new Uint8Array(data as Buffer).slice());
    } else {
      inboundText.push(data.toString());
    }
  });

  const send = socket.send.bind(socket);
  socket.send = ((
    data: Parameters<WebSocket["send"]>[0],
    ...args: unknown[]
  ) => {
    if (typeof data === "string") {
      outboundText.push(data);
    } else {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
      outboundBinary.push(bytes.slice());
      if (binaryTransform) {
        data = binaryTransform(bytes);
        binaryTransform = null;
      }
    }
    return Reflect.apply(send, socket, [data, ...args]);
  }) as WebSocket["send"];

  const core = new SendspinCore({
    webSocket: socket as unknown as WebSocket,
    storage: options.storage ?? memoryStorage(),
    suite: options.suite,
    clientName: options.clientName,
    codecs: ["pcm"],
    unpairedAccess: options.unpairedAccess ?? false,
    onPairing: options.onPairing,
    onPairingCode: options.onPairingCode,
    pairingCodeOutChannels: options.pairingCodeOutChannels,
    staticPairingCode: options.staticPairingCode,
    staticPairingCodeLocations: options.staticPairingCodeLocations,
    pairingPskLocations: options.pairingPskLocations,
  });
  const statusPromise = server.waitForClient();
  await core.connect();
  const status = await statusPromise;
  expect(status.client_id).toBe(core.clientId);
  return {
    core,
    socket,
    outboundText,
    outboundBinary,
    inboundText,
    inboundBinary,
    mutateNextBinary: () => {
      binaryTransform = (bytes) => {
        const mutated = bytes.slice();
        mutated[mutated.length - 1] ^= 1;
        return mutated;
      };
    },
  };
}

function wrongPin(pin: string): string {
  return pin === "0".repeat(pin.length)
    ? "1".repeat(pin.length)
    : "0".repeat(pin.length);
}

function expectPairingResult(
  result: PairingResult,
  status: PairingResult["status"],
  reason?: string,
): void {
  expect(result.status, JSON.stringify(result)).toBe(status);
  if (reason !== undefined) expect(result.reason).toBe(reason);
}

describe("Sendspin encryption and pairing E2E (aiosendspin)", () => {
  let server: AiosendspinServer;
  let connections: Connection[];

  beforeEach(async () => {
    server = new AiosendspinServer();
    connections = [];
    await server.start();
  });

  afterEach(async ({ task }) => {
    for (const { core, socket } of connections) {
      core.disconnect();
      socket.close();
    }
    await server.close(task);
  });

  afterAll(reportDeferredViolations);

  async function connect(options: ConnectOptions): Promise<Connection> {
    const connection = await connectCore(server, options);
    connections.push(connection);
    return connection;
  }

  it.each<SuiteId>(["chacha", "aesgcm"])(
    "encrypts all application traffic with %s",
    async (suite) => {
      const canary = `sendspin-canary-${suite}-${randomBytes(8).toString("hex")}`;
      const connection = await connect({ suite, clientName: canary });
      const status = await server.status(connection.core.clientId);

      expect(status.psk_category).toBe("sentinel");
      expect(status.active_roles).toEqual([]);
      expect(
        connection.outboundText.map(
          (frame) => (JSON.parse(frame) as { type: string }).type,
        ),
      ).toEqual(["client/init", "noise/handshake"]);
      expect(
        connection.inboundText.map(
          (frame) => (JSON.parse(frame) as { type: string }).type,
        ),
      ).toEqual(["server/init", "noise/handshake"]);
      expect(connection.outboundBinary.length).toBeGreaterThan(0);
      expect(connection.inboundBinary.length).toBeGreaterThan(0);

      const canaryBytes = Buffer.from(canary);
      const rawFrames = [
        ...connection.outboundText.map((frame) => Buffer.from(frame)),
        ...connection.inboundText.map((frame) => Buffer.from(frame)),
        ...connection.outboundBinary.map((frame) => Buffer.from(frame)),
        ...connection.inboundBinary.map((frame) => Buffer.from(frame)),
      ];
      expect(rawFrames.some((frame) => frame.includes(canaryBytes))).toBe(
        false,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it.each([
    ["malformed init", "{"],
    [
      "unsupported version",
      JSON.stringify({
        type: "client/init",
        payload: {
          client_id: randomBytes(32).toString("base64url"),
          version: 2,
          suite: "25519_ChaChaPoly_SHA256",
        },
      }),
    ],
    [
      "unsupported suite",
      JSON.stringify({
        type: "client/init",
        payload: {
          client_id: randomBytes(32).toString("base64url"),
          version: 1,
          suite: "unsupported",
        },
      }),
    ],
  ])("terminates the connection on %s", async (_name, init) => {
    const socket = await openWebSocket(server.url);
    socket.send(init);
    await waitForClose(socket);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("terminates the connection on replayed transport ciphertext", async () => {
    const connection = await connect({ clientName: "Replay rejection client" });
    expect(connection.outboundBinary.length).toBeGreaterThan(0);
    connection.socket.send(connection.outboundBinary[0]);
    await waitForClose(connection.socket);
    expect(connection.socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("terminates the connection on mutated transport ciphertext", async () => {
    const connection = await connect({
      clientName: "Mutation rejection client",
      unpairedAccess: true,
    });
    await server.trustUnpaired(connection.core.clientId);
    await server.waitForClientState(connection.core.clientId, 100);
    connection.mutateNextBinary();
    connection.core.setVolume(42);
    await waitForClose(connection.socket);
    expect(connection.socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("rejects a legacy cleartext client", async () => {
    const socket = await openWebSocket(server.url);
    socket.send(
      JSON.stringify({
        type: "client/hello",
        payload: {
          name: "legacy-client",
          version: 1,
          supported_roles: [],
        },
      }),
    );
    await waitForClose(socket);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("reports exact player state when live trust activates the role", async () => {
    const connection = await connect({
      clientName: "Live trust client",
      unpairedAccess: true,
    });
    connection.core.setVolume(42);

    const trusted = await server.trustUnpaired(connection.core.clientId);
    expect(trusted.active_roles).toContain("player@v1");
    const state = await server.waitForClientState(connection.core.clientId, 42);
    const expectedState = {
      available: true,
      player: {
        volume: 42,
        muted: false,
        output_delay_ms: 0,
        required_lead_time_ms: 250,
        min_buffer_ms: 250,
        supported_commands: ["volume", "mute", "set_output_delay"],
      },
    };
    expect(state.raw_payload).toEqual(expectedState);
    expect(state.semantic_state).toEqual(expectedState);
  });

  it("rejects a malformed Pairing PSK token", async () => {
    const connection = await connect({ clientName: "Malformed token client" });
    const result = await server.pairWithToken("not-a-token");
    expectPairingResult(result, "rejected", "invalid_token");
    expect(connection.socket.readyState).toBe(WebSocket.OPEN);
    expect(await server.hasPairingRecord(connection.core.clientId)).toBe(false);
  });

  it("rejects a Pairing PSK token bound to another client", async () => {
    const connection = await connect({ clientName: "Wrong token client" });
    const other = new SendspinCore({
      baseUrl: "http://unused",
      storage: memoryStorage(),
    });
    const result = await server.pairWithToken(other.pairingToken!);
    expectPairingResult(result, "rejected", "client_id_mismatch");
    expect(connection.socket.readyState).toBe(WebSocket.OPEN);
    expect(await server.hasPairingRecord(connection.core.clientId)).toBe(false);
  });

  it("terminates Pairing PSK when the token carries a stale PSK", async () => {
    const connection = await connect({ clientName: "Wrong token PSK client" });
    const staleToken = connection.core.pairingToken!;
    connection.core.rotatePairingPsk();

    const result = await server.pairWithToken(staleToken);
    expectPairingResult(result, "error");
    await waitForClose(connection.socket);
    expect(await server.hasPairingRecord(connection.core.clientId)).toBe(false);
  });

  it(
    "pairs with a version 0 token, re-handshakes in-band, and reconnects",
    async () => {
      const storage = memoryStorage();
      const events: string[] = [];
      const connection = await connect({
        clientName: "Pairing PSK client",
        storage,
        onPairing: (event) => events.push(event),
      });
      const outboundTextCount = connection.outboundText.length;
      const inboundTextCount = connection.inboundText.length;
      expect(connection.core.pairingToken).toMatch(/^SP:0/);

      const result = await server.pairWithToken(connection.core.pairingToken!);
      expectPairingResult(result, "success");
      expect(result.connected).toBe(true);
      expect(result.psk_category).toBe("long_term");
      expect(result.active_roles).toContain("player@v1");
      expect(result.has_pairing_record).toBe(true);
      expect(connection.socket.readyState).toBe(WebSocket.OPEN);
      expect(connection.outboundText).toHaveLength(outboundTextCount);
      expect(connection.inboundText).toHaveLength(inboundTextCount);
      await waitFor(() => events.includes("finalized"));

      connection.core.disconnect();
      connection.socket.close();
      await waitForClose(connection.socket);
      const reconnected = await connect({
        clientName: "Pairing PSK client",
        storage,
      });
      const status = await server.status(reconnected.core.clientId);
      expect(status.psk_category).toBe("long_term");
      expect(status.has_pairing_record).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps delayed Dynamic PIN entry open, retries, and reconnects",
    async () => {
      const storage = memoryStorage();
      const pins: string[] = [];
      const connection = await connect({
        clientName: "Dynamic PIN client",
        suite: "aesgcm",
        storage,
        onPairingCode: (pin) => {
          if (pin !== null) pins.push(pin);
        },
      });

      await server.beginCodePairing("dynamic_pairing_code");
      expect((await server.waitForCodeRequest()).status).toBe("code_requested");
      await waitFor(() => pins.length === 1);
      connection.core.setVolume(42);
      await new Promise((resolve) => setTimeout(resolve, 5_200));
      expect(connection.socket.readyState).toBe(WebSocket.OPEN);
      const first = await server.submitCode(wrongPin(pins[0]));
      expectPairingResult(first, "aborted", "pairing_code_mismatch");
      expect(connection.socket.readyState).toBe(WebSocket.OPEN);

      await server.beginCodePairing("dynamic_pairing_code");
      expect((await server.waitForCodeRequest()).status).toBe("code_requested");
      await waitFor(() => pins.length === 2);
      const second = await server.submitCode(pins[1]);
      expectPairingResult(second, "success");
      expect(second.connected).toBe(true);
      expect(second.psk_category).toBe("long_term");
      expect(second.has_pairing_record).toBe(true);

      connection.core.disconnect();
      connection.socket.close();
      await waitForClose(connection.socket);
      const reconnected = await connect({
        clientName: "Dynamic PIN client",
        storage,
      });
      expect(
        (await server.status(reconnected.core.clientId)).psk_category,
      ).toBe("long_term");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "escalates Dynamic PIN to gesture-gating after ten mismatches",
    async () => {
      const storage = memoryStorage();
      const pins: string[] = [];
      const collectPin = (pin: string | null) => {
        if (pin !== null) pins.push(pin);
      };
      const connection = await connect({
        clientName: "Dynamic PIN escalation client",
        storage,
        onPairingCode: collectPin,
      });

      for (let attempt = 0; attempt < 10; attempt++) {
        await server.beginCodePairing("dynamic_pairing_code");
        expect((await server.waitForCodeRequest()).status).toBe(
          "code_requested",
        );
        await waitFor(() => pins.length === attempt + 1);
        const result = await server.submitCode(wrongPin(pins[attempt]));
        expectPairingResult(result, "aborted", "pairing_code_mismatch");
      }
      expect(connection.core.isDynamicPinEscalated()).toBe(true);
      expect(await server.hasPairingRecord(connection.core.clientId)).toBe(
        false,
      );

      connection.core.disconnect();
      connection.socket.close();
      await waitForClose(connection.socket);
      const reconnected = await connect({
        clientName: "Dynamic PIN escalation client",
        storage,
        onPairingCode: collectPin,
      });
      // The counter survived the reconnect, so the method stays escalated: the
      // client withholds pair-init until the operator opens the window.
      expect(reconnected.core.isDynamicPinEscalated()).toBe(true);
      await server.beginCodePairing("dynamic_pairing_code");
      expect((await server.waitForCodeRequest(200)).status).toBe("timeout");
      expect(reconnected.socket.readyState).toBe(WebSocket.OPEN);

      reconnected.core.openPairingWindow();
      expect((await server.waitForCodeRequest()).status).toBe("code_requested");
      await waitFor(() => pins.length === 11);
      expectPairingResult(await server.submitCode(pins[10]), "success");
      // A verified round de-escalates the method.
      expect(reconnected.core.isDynamicPinEscalated()).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it("advertises the configured out-channels and Pairing PSK locations", async () => {
    const connection = await connect({
      clientName: "Dynamic hints client",
      onPairingCode: () => undefined,
      pairingCodeOutChannels: ["display", "speaker"],
      pairingPskLocations: ["leaflet"],
    });

    const methods = (await server.status(connection.core.clientId))
      .supported_pair_methods;
    expect(methods.dynamic_pairing_code?.out_channels).toEqual([
      "display",
      "speaker",
    ]);
    expect(methods.pairing_psk?.locations).toEqual(["leaflet"]);
  });

  it("advertises the configured static pairing code locations", async () => {
    const connection = await connect({
      clientName: "Static hints client",
      staticPairingCode: "31415926",
      staticPairingCodeLocations: ["device", "leaflet"],
    });

    const methods = (await server.status(connection.core.clientId))
      .supported_pair_methods;
    expect(methods.static_pairing_code?.locations).toEqual([
      "device",
      "leaflet",
    ]);
  });

  it("waits for the Static PIN window before pairing", async () => {
    const pin = randomInt(0, 100_000_000).toString().padStart(8, "0");
    const connection = await connect({
      clientName: "Static PIN client",
      staticPairingCode: pin,
    });

    await server.beginCodePairing("static_pairing_code");
    expect((await server.waitForCodeRequest(200)).status).toBe("timeout");
    expect(connection.socket.readyState).toBe(WebSocket.OPEN);
    connection.core.openPairingWindow();
    expect((await server.waitForCodeRequest()).status).toBe("code_requested");
    const result = await server.submitCode(pin);
    expectPairingResult(result, "success");
    expect(result.connected).toBe(true);
    expect(result.psk_category).toBe("long_term");
    expect(result.has_pairing_record).toBe(true);
  });

  it(
    "preserves identity and long-term pairing across server restart",
    async () => {
      const storage = memoryStorage();
      const pins: string[] = [];
      const connection = await connect({
        clientName: "Restart persistence client",
        storage,
        onPairingCode: (pin) => {
          if (pin !== null) pins.push(pin);
        },
      });

      await server.beginCodePairing("dynamic_pairing_code");
      expect((await server.waitForCodeRequest()).status).toBe("code_requested");
      await waitFor(() => pins.length === 1);
      expectPairingResult(await server.submitCode(pins[0]), "success");
      const clientId = connection.core.clientId;
      connection.core.disconnect();
      connection.socket.close();
      await waitForClose(connection.socket);

      await server.restart();
      expect(await server.hasPairingRecord(clientId)).toBe(true);
      const reconnected = await connect({
        clientName: "Restart persistence client",
        storage,
      });
      const status = await server.status(reconnected.core.clientId);
      expect(status.client_id).toBe(clientId);
      expect(status.psk_category).toBe("long_term");
      expect(status.has_pairing_record).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
