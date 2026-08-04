import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { WebSocket } from "ws";
import { SendspinCore } from "../../src/core/core";
import type { SendspinStorage, SendspinCoreConfig } from "../../src/types";
import type { SuiteId } from "../../src/core/noise/suites";

const MASS_SERVER_ROOT = process.env.MASS_SERVER_ROOT;
const TEST_TIMEOUT_MS = 120_000;

interface PlayerStateResult {
  player_id: string;
  needs_setup: boolean;
  available: boolean;
}

interface ProviderConfigResult {
  instance_id: string;
  domain: string;
}

interface SetupFlowStepResult {
  flow_id: string;
  type: string;
  step_id?: string;
  errors?: Record<string, string>;
}

interface ConfigEntryResult {
  key: string;
}

function memoryStorage(): SendspinStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`Condition was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
  await waitFor(() => isPortOpen(port), timeoutMs);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}

class MusicAssistantHarness {
  private process: ChildProcess | null = null;
  private processDone: Promise<void> | null = null;
  private processError: Error | null = null;
  private dataDir = "";
  private token = "";

  async start(): Promise<void> {
    if (!MASS_SERVER_ROOT) return;
    await this.assertPortsAvailable();
    this.dataDir = await mkdtemp(join(tmpdir(), "sendspin-js-ma-"));
    await this.launch();

    const password = randomBytes(24).toString("base64url");
    const setupResponse = await fetch("http://127.0.0.1:8095/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "sendspin-test",
        password,
        device_name: "sendspin-js conformance",
      }),
    });
    if (!setupResponse.ok) {
      throw new Error(`Music Assistant setup failed: ${setupResponse.status}`);
    }
    const setup = (await setupResponse.json()) as {
      success: boolean;
      token?: string;
    };
    if (!setup.success || !setup.token) {
      throw new Error("Music Assistant setup did not return a token");
    }
    this.token = setup.token;
    await this.api("config/onboard_complete");

    let providers = await this.api<ProviderConfigResult[]>("config/providers", {
      provider_domain: "sendspin",
      include_values: true,
    });
    if (!providers.some((provider) => provider.domain === "sendspin")) {
      await this.api("config/providers/setup", {
        provider_domain: "sendspin",
      });
      providers = await this.api<ProviderConfigResult[]>("config/providers", {
        provider_domain: "sendspin",
        include_values: true,
      });
    }
    const sendspin = providers.find(
      (provider) => provider.domain === "sendspin",
    );
    if (!sendspin) {
      throw new Error("Music Assistant did not load the Sendspin provider");
    }
    await this.api("config/providers/save", {
      provider_domain: "sendspin",
      instance_id: sendspin.instance_id,
      values: { allow_unencrypted: false },
    });
    await waitForPort(8927);
  }

  async restart(): Promise<void> {
    await this.stopProcess();
    await this.assertPortsAvailable();
    await this.launch();
    await waitForPort(8927);
  }

  private async assertPortsAvailable(): Promise<void> {
    const ports = [8095, 8927];
    const occupied = (
      await Promise.all(
        ports.map(async (port) => [port, await isPortOpen(port)] as const),
      )
    )
      .filter(([, open]) => open)
      .map(([port]) => port);
    if (occupied.length > 0) {
      throw new Error(
        `Music Assistant test ports already in use: ${occupied.join(", ")}`,
      );
    }
  }

  private async launch(): Promise<void> {
    if (!MASS_SERVER_ROOT) return;
    const cacheDir = join(this.dataDir, "cache");
    const python =
      process.env.MASS_PYTHON ?? join(MASS_SERVER_ROOT, ".venv/bin/python");
    const child = spawn(
      python,
      [
        "-m",
        "music_assistant",
        "--data-dir",
        this.dataDir,
        "--cache-dir",
        cacheDir,
        "--log-level",
        "verbose",
      ],
      {
        cwd: MASS_SERVER_ROOT,
        env: {
          HOME: this.dataDir,
          LANG: process.env.LANG ?? "C.UTF-8",
          LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? "C.UTF-8",
          PATH: `${join(MASS_SERVER_ROOT, ".venv/bin")}${delimiter}${
            process.env.PATH ?? "/usr/bin:/bin"
          }`,
          PYTHONUNBUFFERED: "1",
          TMPDIR: tmpdir(),
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    this.process = child;
    this.processError = null;
    this.processDone = new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once("error", (error) => {
        this.processError = error;
        finish();
      });
      child.once("exit", finish);
      child.once("close", finish);
    });
    let startupStderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      startupStderr = (startupStderr + chunk.toString("utf8")).slice(-8_000);
    });
    await waitFor(async () => {
      if (this.processError) {
        throw new Error(
          `Music Assistant failed to start: ${this.processError.message}`,
        );
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `Music Assistant exited during startup\n${startupStderr}`,
        );
      }
      try {
        return (await fetch("http://127.0.0.1:8095/info")).ok;
      } catch {
        return false;
      }
    }, 60_000);
    child.stderr?.removeAllListeners("data");
    child.stderr?.resume();
  }

  async stop(): Promise<void> {
    await this.stopProcess();
    this.token = "";
    const dataDir = this.dataDir;
    this.dataDir = "";
    if (dataDir.startsWith(join(tmpdir(), "sendspin-js-ma-"))) {
      await rm(dataDir, { recursive: true, force: true });
    }
  }

  private async stopProcess(): Promise<void> {
    const child = this.process;
    const done = this.processDone;
    this.process = null;
    this.processDone = null;
    this.processError = null;
    if (!child) return;
    const isRunning = () =>
      child.exitCode === null && child.signalCode === null;
    if (!isRunning()) {
      await done;
      return;
    }

    child.kill("SIGTERM");
    const stopped = done
      ? await Promise.race([
          done.then(() => true),
          sleep(5_000).then(() => false),
        ])
      : false;
    if (!stopped && isRunning()) {
      child.kill("SIGKILL");
      if (done) {
        await Promise.race([done, sleep(1_000)]);
      }
    }
  }

  async api<T = unknown>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const response = await fetch("http://127.0.0.1:8095/api", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command, args }),
    });
    if (!response.ok) {
      throw new Error(`${command} failed: ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async player(clientId: string): Promise<PlayerStateResult | null> {
    return this.api<PlayerStateResult | null>("players/get", {
      player_id: clientId,
    });
  }

  async securityStatus(clientId: string): Promise<string | null> {
    const entries = await this.api<ConfigEntryResult[]>(
      "config/players/get_entries",
      { player_id: clientId },
    );
    return (
      entries.find((entry) => entry.key.startsWith("security_status_"))?.key ??
      null
    );
  }

  async hasPairingRecord(clientId: string): Promise<boolean> {
    try {
      const contents = await readFile(
        join(this.dataDir, "sendspin", "pairing_store.json"),
        "utf8",
      );
      const data = JSON.parse(contents) as {
        records?: Record<string, unknown>;
      };
      return Object.prototype.hasOwnProperty.call(data.records ?? {}, clientId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}

interface ConnectCoreOptions {
  clientName: string;
  suite?: SuiteId;
  storage?: SendspinStorage;
  onPairing?: SendspinCoreConfig["onPairing"];
  onPairingPin?: SendspinCoreConfig["onPairingPin"];
  staticPin?: string;
}

async function connectCore(options: ConnectCoreOptions): Promise<{
  core: SendspinCore;
  socket: WebSocket;
  textFrames: string[];
  binaryFrames: Uint8Array[];
}> {
  const socket = await openWebSocket("ws://127.0.0.1:8927/sendspin");
  const textFrames: string[] = [];
  const binaryFrames: Uint8Array[] = [];
  const send = socket.send.bind(socket);
  socket.send = ((
    data: Parameters<WebSocket["send"]>[0],
    ...args: unknown[]
  ) => {
    if (typeof data === "string") {
      textFrames.push(data);
    } else {
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
      binaryFrames.push(bytes.slice());
    }
    return Reflect.apply(send, socket, [data, ...args]);
  }) as WebSocket["send"];

  const config: SendspinCoreConfig = {
    webSocket: socket as unknown as WebSocket,
    storage: options.storage ?? memoryStorage(),
    suite: options.suite,
    clientName: options.clientName,
    codecs: ["pcm"],
    unpairedAccess: false,
    onPairing: options.onPairing,
    onPairingPin: options.onPairingPin,
    staticPin: options.staticPin,
  };
  const core = new SendspinCore(config);
  await core.connect();
  return { core, socket, textFrames, binaryFrames };
}

function staticPin(): string {
  return randomInt(0, 100_000_000).toString().padStart(8, "0");
}

describe.skipIf(!MASS_SERVER_ROOT)(
  "Music Assistant encryption interoperability",
  () => {
    const server = new MusicAssistantHarness();

    beforeEach(() => server.start(), TEST_TIMEOUT_MS);
    afterEach(() => server.stop(), TEST_TIMEOUT_MS);

    it.each<SuiteId>(["chacha", "aesgcm"])(
      "encrypts all application traffic with %s",
      async (suite) => {
        const canary = `sendspin-canary-${suite}-${randomBytes(8).toString("hex")}`;
        const { core, socket, textFrames, binaryFrames } = await connectCore({
          suite,
          clientName: canary,
        });
        try {
          await waitFor(
            async () => (await server.player(core.clientId)) !== null,
          );
          const player = await server.player(core.clientId);
          expect(player?.needs_setup).toBe(true);
          expect(player?.available).toBe(false);
          expect(
            textFrames.map(
              (frame) => (JSON.parse(frame) as { type: string }).type,
            ),
          ).toEqual(["client/init", "noise/handshake"]);
          expect(textFrames.some((frame) => frame.includes(canary))).toBe(
            false,
          );
          expect(binaryFrames.length).toBeGreaterThan(0);
          const canaryBytes = new TextEncoder().encode(canary);
          expect(
            binaryFrames.some((frame) =>
              Buffer.from(frame).includes(Buffer.from(canaryBytes)),
            ),
          ).toBe(false);
        } finally {
          core.disconnect();
          socket.close();
        }
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
      const socket = await openWebSocket("ws://127.0.0.1:8927/sendspin");
      try {
        socket.send(init);
        await waitForClose(socket);
        expect(socket.readyState).toBe(WebSocket.CLOSED);
      } finally {
        socket.close();
      }
    });

    it(
      "terminates the connection on replayed transport ciphertext",
      async () => {
        const connection = await connectCore({
          clientName: "Replay rejection client",
        });
        try {
          await waitFor(
            async () =>
              (await server.player(connection.core.clientId)) !== null,
          );
          expect(connection.binaryFrames.length).toBeGreaterThan(0);
          connection.socket.send(connection.binaryFrames[0]);
          await waitForClose(connection.socket);
          expect(connection.socket.readyState).toBe(WebSocket.CLOSED);
        } finally {
          connection.core.disconnect();
          connection.socket.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "terminates the connection on mutated transport ciphertext",
      async () => {
        const connection = await connectCore({
          clientName: "Ciphertext mutation client",
        });
        try {
          await waitFor(
            async () =>
              (await server.player(connection.core.clientId)) !== null,
          );
          const mutated = connection.binaryFrames[0].slice();
          mutated[mutated.length - 1] ^= 1;
          connection.socket.send(mutated);
          await waitForClose(connection.socket);
          expect(connection.socket.readyState).toBe(WebSocket.CLOSED);
        } finally {
          connection.core.disconnect();
          connection.socket.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "rejects a bare Pairing PSK",
      async () => {
        const connection = await connectCore({
          clientName: "Bare Pairing PSK client",
        });
        const clientId = connection.core.clientId;
        try {
          await waitFor(async () => (await server.player(clientId)) !== null);
          let step = await server.api<SetupFlowStepResult>(
            "config/players/setup",
            { player_id: clientId },
          );
          expect(step.step_id).toBe("enter_token");
          step = await server.api<SetupFlowStepResult>("config/flows/submit", {
            flow_id: step.flow_id,
            values: { pairing_token: connection.core.pairingPsk },
          });
          expect(step.step_id).toBe("enter_token");
          expect(step.errors).toBeTruthy();
          expect((await server.player(clientId))?.needs_setup).toBe(true);
          expect(connection.socket.readyState).toBe(WebSocket.OPEN);
          expect(await server.hasPairingRecord(clientId)).toBe(false);
          await server.api("config/flows/abort", { flow_id: step.flow_id });
        } finally {
          connection.core.disconnect();
          connection.socket.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "rejects the normative version 0 Pairing PSK token",
      async () => {
        const connection = await connectCore({
          clientName: "Version 0 Pairing PSK client",
        });
        const clientId = connection.core.clientId;
        try {
          await waitFor(async () => (await server.player(clientId)) !== null);
          let step = await server.api<SetupFlowStepResult>(
            "config/players/setup",
            { player_id: clientId },
          );
          expect(step.step_id).toBe("enter_token");
          expect(connection.core.pairingToken).toMatch(/^SP:0/);
          step = await server.api<SetupFlowStepResult>("config/flows/submit", {
            flow_id: step.flow_id,
            values: { pairing_token: connection.core.pairingToken },
          });
          expect(step.step_id).toBe("enter_token");
          expect(step.errors).toBeTruthy();
          expect((await server.player(clientId))?.needs_setup).toBe(true);
          expect(connection.socket.readyState).toBe(WebSocket.OPEN);
          expect(await server.hasPairingRecord(clientId)).toBe(false);
          await server.api("config/flows/abort", { flow_id: step.flow_id });
        } finally {
          connection.core.disconnect();
          connection.socket.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "retries a wrong Dynamic PIN and reconnects with long-term trust",
      async () => {
        const storage = memoryStorage();
        const pins: string[] = [];
        const pairingEvents: string[] = [];
        const first = await connectCore({
          clientName: "Dynamic PIN client",
          suite: "aesgcm",
          storage,
          onPairingPin: (pin) => {
            if (pin !== null) pins.push(pin);
          },
          onPairing: (event) => pairingEvents.push(event),
        });
        const clientId = first.core.clientId;
        try {
          await waitFor(async () => (await server.player(clientId)) !== null);
          let step = await server.api<SetupFlowStepResult>(
            "config/players/setup",
            { player_id: clientId },
          );
          expect(step.step_id).toBe("select_method");
          step = await server.api<SetupFlowStepResult>("config/flows/submit", {
            flow_id: step.flow_id,
            values: { pairing_method: "pin" },
          });
          expect(step.step_id).toBe("enter_pin");
          await waitFor(() => pins.length === 1);
          expect(pins[0]).toMatch(/^[0-9]{6}$/);

          const wrongPin = pins[0] === "000000" ? "111111" : "000000";
          step = await server.api<SetupFlowStepResult>("config/flows/submit", {
            flow_id: step.flow_id,
            values: { pairing_pin: wrongPin },
          });
          expect(step.step_id).toBe("enter_pin");
          expect(step.errors).toBeTruthy();
          expect(first.socket.readyState).toBe(WebSocket.OPEN);

          await waitFor(() => pins.length === 2);
          step = await server.api<SetupFlowStepResult>("config/flows/submit", {
            flow_id: step.flow_id,
            values: { pairing_pin: pins[1] },
          });
          expect(step.type).toBe("finish");
          await waitFor(() => pairingEvents.includes("finalized"));
          await waitFor(async () => {
            const player = await server.player(clientId);
            return player?.needs_setup === false && player.available;
          });
          expect(await server.securityStatus(clientId)).toBe(
            "security_status_paired",
          );
          expect(await server.hasPairingRecord(clientId)).toBe(true);
        } finally {
          first.core.disconnect();
          first.socket.close();
        }

        const reconnected = await connectCore({
          clientName: "Dynamic PIN client",
          storage,
        });
        try {
          expect(reconnected.core.clientId).toBe(clientId);
          await waitFor(async () => {
            const player = await server.player(clientId);
            return player?.needs_setup === false && player.available;
          });
          expect(await server.securityStatus(clientId)).toBe(
            "security_status_paired",
          );
        } finally {
          reconnected.core.disconnect();
          reconnected.socket.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "persists Dynamic PIN terminal lockout after ten mismatches",
      async () => {
        const storage = memoryStorage();
        const pins: string[] = [];
        const connection = await connectCore({
          clientName: "Dynamic PIN lockout client",
          storage,
          onPairingPin: (pin) => {
            if (pin !== null) pins.push(pin);
          },
        });
        const clientId = connection.core.clientId;
        try {
          await waitFor(async () => (await server.player(clientId)) !== null);
          let step = await server.api<SetupFlowStepResult>(
            "config/players/setup",
            { player_id: clientId },
          );
          step = await server.api<SetupFlowStepResult>("config/flows/submit", {
            flow_id: step.flow_id,
            values: { pairing_method: "pin" },
          });

          for (let attempt = 0; attempt < 10; attempt++) {
            await waitFor(() => pins.length === attempt + 1);
            const pin = pins[attempt];
            const wrongPin =
              pin === "0".repeat(pin.length)
                ? "1".repeat(pin.length)
                : "0".repeat(pin.length);
            step = await server.api<SetupFlowStepResult>(
              "config/flows/submit",
              {
                flow_id: step.flow_id,
                values: { pairing_pin: wrongPin },
              },
            );
            if (attempt < 9) {
              expect(step.step_id).toBe("enter_pin");
              expect(step.errors).toBeTruthy();
              expect(connection.socket.readyState).toBe(WebSocket.OPEN);
            }
          }

          expect(connection.core.isPairingLockedOut("dynamic_pin")).toBe(true);
          expect(await server.hasPairingRecord(clientId)).toBe(false);
          expect(connection.socket.readyState).toBe(WebSocket.OPEN);
          if (step.type !== "abort" && step.type !== "finish") {
            await server.api("config/flows/abort", { flow_id: step.flow_id });
          }
        } finally {
          connection.core.disconnect();
          connection.socket.close();
        }

        const reconnected = await connectCore({
          clientName: "Dynamic PIN lockout client",
          storage,
          onPairingPin: () => undefined,
        });
        try {
          expect(reconnected.core.clientId).toBe(clientId);
          expect(reconnected.core.isPairingLockedOut("dynamic_pin")).toBe(true);
          await waitFor(async () => (await server.player(clientId)) !== null);
          const step = await server.api<SetupFlowStepResult>(
            "config/players/setup",
            { player_id: clientId },
          );
          expect(step.step_id).toBe("enter_token");
          await server.api("config/flows/abort", { flow_id: step.flow_id });
        } finally {
          reconnected.core.clearPairingLockout("dynamic_pin");
          reconnected.core.disconnect();
          reconnected.socket.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "pairs through implicit Static PIN selection after a wrong PIN",
      async () => {
        const storage = memoryStorage();
        const pin = staticPin();
        const preopened = await connectCore({
          clientName: "Static PIN client",
          storage,
          staticPin: pin,
        });
        const clientId = preopened.core.clientId;
        await waitFor(async () => (await server.player(clientId)) !== null);
        preopened.core.openPairingWindow();
        preopened.core.disconnect();
        preopened.socket.close();
        await waitForClose(preopened.socket);

        const pairingEvents: string[] = [];
        let pairingCore: SendspinCore | null = null;
        const pairing = await connectCore({
          clientName: "Static PIN client",
          storage,
          staticPin: pin,
          onPairing: (event) => {
            pairingEvents.push(event);
            if (event === "aborted") pairingCore?.openPairingWindow();
          },
        });
        pairingCore = pairing.core;
        try {
          expect(pairing.core.clientId).toBe(clientId);
          await waitFor(async () => (await server.player(clientId)) !== null);
          let step = await server.api<SetupFlowStepResult>(
            "config/players/setup",
            { player_id: clientId },
          );
          expect(step.step_id).toBe("select_method");
          pairing.core.openPairingWindow();
          step = await server.api<SetupFlowStepResult>("config/flows/submit", {
            flow_id: step.flow_id,
            values: { pairing_method: "pin" },
          });
          expect(step.step_id).toBe("enter_pin");
          const wrongPin = pin === "00000000" ? "11111111" : "00000000";
          step = await server.api<SetupFlowStepResult>("config/flows/submit", {
            flow_id: step.flow_id,
            values: { pairing_pin: wrongPin },
          });
          expect(step.step_id).toBe("enter_pin");
          expect(step.errors).toBeTruthy();
          expect(pairing.socket.readyState).toBe(WebSocket.OPEN);

          step = await server.api<SetupFlowStepResult>("config/flows/submit", {
            flow_id: step.flow_id,
            values: { pairing_pin: pin },
          });
          expect(step.type).toBe("finish");
          await waitFor(() => pairingEvents.includes("finalized"));
          await waitFor(async () => {
            const player = await server.player(clientId);
            return player?.needs_setup === false && player.available;
          });
          expect(await server.securityStatus(clientId)).toBe(
            "security_status_paired",
          );
          expect(await server.hasPairingRecord(clientId)).toBe(true);
        } finally {
          pairing.core.disconnect();
          pairing.socket.close();
        }

        const reconnected = await connectCore({
          clientName: "Static PIN client",
          storage,
          staticPin: pin,
        });
        try {
          expect(reconnected.core.clientId).toBe(clientId);
          await waitFor(async () => {
            const player = await server.player(clientId);
            return player?.needs_setup === false && player.available;
          });
          expect(await server.securityStatus(clientId)).toBe(
            "security_status_paired",
          );
        } finally {
          reconnected.core.disconnect();
          reconnected.socket.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "selects Static PIN explicitly when both PIN methods are offered",
      async () => {
        const pin = staticPin();
        const connection = await connectCore({
          clientName: "Dual PIN client",
          storage: memoryStorage(),
          staticPin: pin,
          onPairingPin: () => undefined,
        });
        const clientId = connection.core.clientId;
        try {
          await waitFor(async () => (await server.player(clientId)) !== null);
          let step = await server.api<SetupFlowStepResult>(
            "config/players/setup",
            { player_id: clientId },
          );
          expect(step.step_id).toBe("select_method");
          connection.core.openPairingWindow();
          step = await server.api<SetupFlowStepResult>("config/flows/submit", {
            flow_id: step.flow_id,
            values: { pairing_method: "static_pin" },
          });
          expect(step.step_id).toBe("enter_pin");
          step = await server.api<SetupFlowStepResult>("config/flows/submit", {
            flow_id: step.flow_id,
            values: { pairing_pin: pin },
          });
          expect(step.type).toBe("finish");
          await waitFor(async () => {
            const player = await server.player(clientId);
            return player?.needs_setup === false && player.available;
          });
          expect(await server.securityStatus(clientId)).toBe(
            "security_status_paired",
          );
        } finally {
          connection.core.disconnect();
          connection.socket.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "preserves long-term pairing across a Music Assistant restart",
      async () => {
        const storage = memoryStorage();
        const pins: string[] = [];
        const first = await connectCore({
          clientName: "Restart persistence client",
          storage,
          onPairingPin: (pin) => {
            if (pin !== null) pins.push(pin);
          },
        });
        const clientId = first.core.clientId;
        try {
          await waitFor(async () => (await server.player(clientId)) !== null);
          let step = await server.api<SetupFlowStepResult>(
            "config/players/setup",
            { player_id: clientId },
          );
          expect(step.step_id).toBe("select_method");
          step = await server.api<SetupFlowStepResult>("config/flows/submit", {
            flow_id: step.flow_id,
            values: { pairing_method: "pin" },
          });
          expect(step.step_id).toBe("enter_pin");
          await waitFor(() => pins.length === 1);
          step = await server.api<SetupFlowStepResult>("config/flows/submit", {
            flow_id: step.flow_id,
            values: { pairing_pin: pins[0] },
          });
          expect(step.type).toBe("finish");
          await waitFor(async () => {
            const player = await server.player(clientId);
            return player?.needs_setup === false && player.available;
          });
          expect(await server.hasPairingRecord(clientId)).toBe(true);
        } finally {
          first.core.disconnect();
          first.socket.close();
          await waitForClose(first.socket);
        }

        await server.restart();
        expect(await server.hasPairingRecord(clientId)).toBe(true);

        const reconnected = await connectCore({
          clientName: "Restart persistence client",
          storage,
        });
        try {
          expect(reconnected.core.clientId).toBe(clientId);
          await waitFor(async () => {
            const player = await server.player(clientId);
            return player?.needs_setup === false && player.available;
          });
          expect(await server.securityStatus(clientId)).toBe(
            "security_status_paired",
          );
        } finally {
          reconnected.core.disconnect();
          reconnected.socket.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "rejects a legacy cleartext client when encryption is required",
      async () => {
        const socket = await openWebSocket("ws://127.0.0.1:8927/sendspin");
        const closed = new Promise<void>((resolve) =>
          socket.once("close", () => resolve()),
        );
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
        await closed;
        expect(socket.readyState).toBe(WebSocket.CLOSED);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
