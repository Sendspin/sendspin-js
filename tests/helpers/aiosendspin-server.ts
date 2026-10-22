import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { KNOWN_VIOLATIONS } from "./known-violations";

const PYTHON_BIN = resolve(import.meta.dirname, "../../.venv/bin/python");
const SERVER_SCRIPT = resolve(import.meta.dirname, "sendspin-server.py");
const STATE_PREFIX = join(tmpdir(), "sendspin-js-aiosendspin-");

const NONCOMPLIANCE_SUBJECT = "non-compliant client";

export type PskCategory = "sentinel" | "pairing" | "long_term";
export type PairingCodeMethod = "dynamic_pairing_code" | "static_pairing_code";

/** client/hello supported_pair_methods as the server parsed it. */
export interface SupportedPairMethods {
  pairing_psk?: { locations?: string[] };
  static_pairing_code?: { locations?: string[] };
  dynamic_pairing_code?: { out_channels: string[]; formats: string[] };
}

export interface ClientStatus {
  client_id: string | null;
  connected: boolean;
  psk_category: PskCategory | null;
  active_roles: string[];
  supported_pair_methods: SupportedPairMethods;
  has_pairing_record: boolean;
}

export interface PairingResult extends ClientStatus {
  status: "success" | "aborted" | "rejected" | "error";
  reason: string | null;
}

export type CodeWaitResult =
  PairingResult | { status: "code_requested" | "timeout" };

export interface ReceivedClientState {
  raw_payload: Record<string, unknown>;
  semantic_state: {
    available: boolean;
    player: {
      volume: number;
      muted: boolean;
      output_delay_ms: number;
      required_lead_time_ms: number;
      min_buffer_ms: number;
      supported_commands: string[];
    };
  };
}

interface ServerLogLine {
  log?: { level: string; name: string; message: string };
}

// it.fails absorbs afterEach errors, so its violations are reported from afterAll.
const deferredViolations: string[] = [];

export function reportDeferredViolations(): void {
  if (deferredViolations.length) {
    throw new Error(deferredViolations.splice(0).join("\n"));
  }
}

interface CommandResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

export interface KillableProcess {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
}

export async function awaitProcessExit(
  proc: KillableProcess,
  done: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const waitForExit = () =>
    new Promise<boolean>((resolveExited) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveExited(value);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      void done.then(() => finish(true));
    });
  if (await waitForExit()) return;
  if (proc.exitCode === null && proc.signalCode === null) {
    if (!proc.kill("SIGKILL")) {
      throw new Error("Failed to deliver SIGKILL to child process");
    }
  }
  if (!(await waitForExit())) {
    throw new Error("Child process did not exit after SIGKILL");
  }
}

export class AiosendspinServer {
  private proc: ChildProcess | null = null;
  private procDone: Promise<void> | null = null;
  private rl: Interface | null = null;
  private responseQueue: Array<{
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }> = [];
  private staleLines = 0;
  private stderrTail: string[] = [];
  private procError: Error | null = null;
  private stateDir = "";
  private noncompliance: string[] = [];

  port = 0;

  get url(): string {
    if (!this.port) throw new Error("Server is not running");
    return `ws://127.0.0.1:${this.port}/sendspin`;
  }

  async start(): Promise<void> {
    if (!this.stateDir) this.stateDir = await mkdtemp(STATE_PREFIX);
    await this.launch();
  }

  async restart(): Promise<void> {
    await this.stopProcess();
    await this.launch();
  }

  private async launch(): Promise<void> {
    this.procError = null;
    this.stderrTail = [];
    this.staleLines = 0;
    this.proc = spawn(PYTHON_BIN, [SERVER_SCRIPT, this.stateDir], {
      env: {
        HOME: this.stateDir,
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? "C.UTF-8",
        PATH: `${resolve(import.meta.dirname, "../../.venv/bin")}${delimiter}${
          process.env.PATH ?? "/usr/bin:/bin"
        }`,
        PYTHONUNBUFFERED: "1",
        TMPDIR: tmpdir(),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const proc = this.proc;
    this.procDone = new Promise((resolveDone) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolveDone();
      };
      proc.once("error", (error) => {
        this.failProcess(`child process error: ${error.message}`);
      });
      proc.once("exit", (code, signal) => {
        if (code !== 0 && !this.procError) {
          this.failProcess(
            `subprocess exited unexpectedly (code=${code}, signal=${signal})`,
          );
        }
        settle();
      });
      proc.once("close", settle);
    });

    this.rl = createInterface({ input: proc.stdout! });
    this.rl.on("line", (line) => {
      if (this.staleLines > 0) {
        this.staleLines--;
        return;
      }
      this.responseQueue.shift()?.resolve(line);
    });
    createInterface({ input: proc.stderr! }).on("line", (line) => {
      if (line) this.recordStderrLine(line);
    });

    const ready = JSON.parse(await this.readLine(10_000)) as {
      ready?: { port?: number };
    };
    if (!ready.ready?.port) throw new Error("Server did not report a port");
    this.port = ready.ready.port;
  }

  private recordStderrLine(line: string): void {
    let text = line;
    try {
      const parsed = JSON.parse(line) as ServerLogLine;
      if (parsed.log) {
        text = `${parsed.log.level} ${parsed.log.name}: ${parsed.log.message}`;
        if (parsed.log.message.includes(NONCOMPLIANCE_SUBJECT)) {
          this.noncompliance.push(parsed.log.message);
        }
      }
    } catch {
      // Plain stderr output, kept as is.
    }
    this.stderrTail.push(text);
    if (this.stderrTail.length > 50) this.stderrTail.shift();
  }

  private formatStderrTail(): string {
    return this.stderrTail.length
      ? `\nstderr tail:\n${this.stderrTail.join("\n")}`
      : "";
  }

  private failProcess(reason: string): void {
    if (this.procError) return;
    this.procError = new Error(reason + this.formatStderrTail());
    for (const waiter of this.responseQueue.splice(0)) {
      waiter.reject(this.procError);
    }
  }

  private readLine(timeoutMs: number): Promise<string> {
    if (this.procError) return Promise.reject(this.procError);
    return new Promise((resolveLine, rejectLine) => {
      const waiter = {
        resolve: (line: string) => {
          clearTimeout(timer);
          resolveLine(line);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          rejectLine(error);
        },
      };
      const timer = setTimeout(() => {
        const index = this.responseQueue.indexOf(waiter);
        if (index !== -1) {
          this.responseQueue.splice(index, 1);
          this.staleLines++;
        }
        rejectLine(
          new Error(`Server command timed out${this.formatStderrTail()}`),
        );
      }, timeoutMs);
      this.responseQueue.push(waiter);
    });
  }

  private async sendCommand<T>(
    command: string,
    args: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<T> {
    if (!this.proc?.stdin?.writable) throw new Error("Server is not running");
    this.proc.stdin.write(`${JSON.stringify({ command, args })}\n`);
    const response = JSON.parse(
      await this.readLine(timeoutMs),
    ) as CommandResponse<T>;
    if (!response.ok) {
      throw new Error(
        `${command} failed: ${response.error ?? "unknown error"}` +
          this.formatStderrTail(),
      );
    }
    return response.result as T;
  }

  waitForClient(timeoutMs = 10_000): Promise<ClientStatus> {
    return this.sendCommand(
      "wait_client",
      { timeout_ms: timeoutMs },
      timeoutMs + 1_000,
    );
  }

  status(clientId?: string): Promise<ClientStatus> {
    return this.sendCommand("status", { client_id: clientId });
  }

  trustUnpaired(clientId: string): Promise<ClientStatus> {
    return this.sendCommand("trust_unpaired", { client_id: clientId });
  }

  waitForClientState(
    clientId: string,
    expectedVolume: number,
    timeoutMs = 10_000,
  ): Promise<ReceivedClientState> {
    return this.sendCommand(
      "wait_client_state",
      {
        client_id: clientId,
        expected_volume: expectedVolume,
        timeout_ms: timeoutMs,
      },
      timeoutMs + 1_000,
    );
  }

  async pairWithToken(token: string): Promise<PairingResult> {
    return this.sendCommand<PairingResult>("pair_token", { token }, 35_000);
  }

  async beginCodePairing(method: PairingCodeMethod): Promise<void> {
    await this.sendCommand("begin_code", { method });
  }

  waitForCodeRequest(timeoutMs = 10_000): Promise<CodeWaitResult> {
    return this.sendCommand(
      "wait_code",
      { timeout_ms: timeoutMs },
      timeoutMs + 1_000,
    );
  }

  submitCode(code: string): Promise<PairingResult> {
    return this.sendCommand("submit_code", { code }, 35_000);
  }

  async hasPairingRecord(clientId: string): Promise<boolean> {
    return (await this.status(clientId)).has_pairing_record;
  }

  async streamStart(): Promise<void> {
    await this.sendCommand("stream_start");
  }

  async sendAudio(durationMs: number): Promise<void> {
    await this.sendCommand("send_audio", { duration_ms: durationMs });
  }

  async streamClear(): Promise<void> {
    await this.sendCommand("stream_clear");
  }

  async streamEnd(): Promise<void> {
    await this.sendCommand("stream_end");
  }

  async setVolume(volume: number): Promise<void> {
    await this.sendCommand("volume", { volume });
  }

  async setMute(muted: boolean): Promise<void> {
    await this.sendCommand("mute", { muted });
  }

  async setDelay(delayMs: number): Promise<void> {
    await this.sendCommand("set_delay", { delay_ms: delayMs });
  }

  private async stopProcess(): Promise<void> {
    const proc = this.proc;
    const done = this.procDone;
    if (!proc) return;
    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        await this.sendCommand("shutdown", {}, 5_000);
      } catch {
        proc.kill("SIGTERM");
      }
    }
    if (done) {
      await awaitProcessExit(proc, done, 3_000);
    }
    this.rl?.close();
    this.rl = null;
    this.proc = null;
    this.procDone = null;
    this.port = 0;
  }

  /** Stop the server, then fail `test` on non-compliance outside the known list. */
  async close(test: { name: string; fails?: boolean }): Promise<void> {
    await this.stopProcess();
    const stateDir = this.stateDir;
    this.stateDir = "";
    if (stateDir.startsWith(STATE_PREFIX)) {
      await rm(stateDir, { recursive: true, force: true });
    }
    const unknown = this.noncompliance.filter(
      (message) =>
        !KNOWN_VIOLATIONS.some((known) => message.includes(known.message)),
    );
    if (!unknown.length) return;
    const error = `Server logged unknown non-compliance:\n${unknown.join("\n")}`;
    if (!test.fails) throw new Error(error);
    deferredViolations.push(`${test.name}: ${error}`);
  }
}
