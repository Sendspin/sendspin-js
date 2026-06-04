/**
 * Node.js wrapper around the aiosendspin Python test server.
 *
 * Spawns the Python server as a subprocess and communicates via a
 * line-based stdin/stdout protocol. The real aiosendspin server handles
 * all protocol details (handshake, time sync, codec negotiation, audio
 * encoding, etc.) — no mocking.
 */

import { spawn, type ChildProcess } from "child_process";
import { createInterface, type Interface } from "readline";
import { resolve } from "path";

const PYTHON_BIN = resolve(import.meta.dirname, "../../.venv/bin/python");
const SERVER_SCRIPT = resolve(import.meta.dirname, "sendspin-server.py");

export class AiosendspinServer {
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private responseQueue: Array<{
    resolve: (line: string) => void;
    reject: (err: Error) => void;
  }> = [];
  // Responses owed to timed-out reads. The protocol is one line per command,
  // so a late line belongs to the read that already gave up and must be
  // dropped rather than handed to the next waiter.
  private staleLines = 0;
  // Tail of recent stderr lines, dumped into errors so a Python crash surfaces
  // instead of just a generic readLine timeout.
  private stderrTail: string[] = [];
  private static STDERR_TAIL_MAX = 50;
  // Final error after the subprocess dies. Pending and subsequent reads are
  // rejected with this rather than waiting out their full timeout.
  private procError: Error | null = null;
  // Set once close() begins so the exit listener treats the resulting exit as
  // expected and does not poison procError with a misleading message.
  private closing = false;

  /** Port the server is listening on (available after start()). */
  port = 0;

  /**
   * Start the aiosendspin test server.
   * Resolves when the server is ready to accept connections.
   */
  async start(): Promise<void> {
    this.proc = spawn(PYTHON_BIN, [SERVER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.rl = createInterface({ input: this.proc.stdout! });

    this.rl.on("line", (line: string) => {
      if (this.staleLines > 0) {
        this.staleLines--;
        return;
      }
      const waiter = this.responseQueue.shift();
      if (waiter) {
        waiter.resolve(line);
      }
    });

    // Keep a ring of stderr so a Python traceback is visible in the error
    // surfaced to vitest instead of just a generic readLine timeout.
    this.proc.stderr!.on("data", (data: Buffer) => {
      const lines = data.toString("utf8").split("\n");
      for (const line of lines) {
        if (!line) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > AiosendspinServer.STDERR_TAIL_MAX) {
          this.stderrTail.shift();
        }
      }
    });

    // Wrong python path, missing venv, or any other spawn failure would
    // otherwise hang every readLine for the full timeout.
    this.proc.on("error", (err: Error) => {
      this.failProcess(`spawn failed: ${err.message}`);
    });
    this.proc.on("exit", (code, signal) => {
      if (this.closing) return;
      // Treat any exit before close() as fatal — pending readers can't be
      // satisfied by a dead subprocess.
      this.failProcess(
        `subprocess exited unexpectedly (code=${code}, signal=${signal})`,
      );
    });

    // Wait for READY <port>
    const ready = await this.readLine(10000);
    const match = ready.match(/^READY (\d+)$/);
    if (!match) {
      throw new Error(`Expected READY <port>, got: ${ready}`);
    }
    this.port = parseInt(match[1], 10);
  }

  private formatStderrTail(): string {
    if (this.stderrTail.length === 0) return "";
    return `\nstderr tail:\n${this.stderrTail.join("\n")}`;
  }

  private failProcess(reason: string): void {
    if (this.procError) return;
    this.procError = new Error(reason + this.formatStderrTail());
    const queued = this.responseQueue.splice(0);
    for (const waiter of queued) {
      waiter.reject(this.procError);
    }
  }

  /** Send a command and wait for the response line. */
  private async sendCommand(
    cmd: string,
    timeoutMs: number = 10000,
  ): Promise<string> {
    if (!this.proc?.stdin?.writable) {
      throw new Error("Server process not running");
    }
    this.proc.stdin.write(cmd + "\n");
    return this.readLine(timeoutMs);
  }

  /** Read the next line from stdout with a timeout. */
  private readLine(timeoutMs: number): Promise<string> {
    if (this.procError) return Promise.reject(this.procError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove ourselves from the queue and discard the eventual late line.
        const idx = this.responseQueue.indexOf(waiter);
        if (idx !== -1) {
          this.responseQueue.splice(idx, 1);
          this.staleLines++;
        }
        reject(
          new Error(
            `Timed out reading from server (${timeoutMs}ms)` +
              this.formatStderrTail(),
          ),
        );
      }, timeoutMs);

      const waiter = {
        resolve: (line: string) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };

      this.responseQueue.push(waiter);
    });
  }

  /**
   * Wait for a client to connect to the server.
   * Returns the client ID.
   */
  async waitForClient(): Promise<string> {
    const response = await this.sendCommand("WAIT_CLIENT", 10000);
    const match = response.match(/^CLIENT_CONNECTED (.+)$/);
    if (!match) {
      throw new Error(`Expected CLIENT_CONNECTED <id>, got: ${response}`);
    }
    return match[1];
  }

  /** Tell the server to start a PCM stream. */
  async streamStart(): Promise<void> {
    const response = await this.sendCommand("STREAM_START");
    if (response !== "OK") {
      throw new Error(`STREAM_START failed: ${response}`);
    }
  }

  /** Tell the server to send audio (sine wave) for the given duration. */
  async sendAudio(durationMs: number): Promise<void> {
    const response = await this.sendCommand(`SEND_AUDIO ${durationMs}`);
    if (response !== "OK") {
      throw new Error(`SEND_AUDIO failed: ${response}`);
    }
  }

  /** Tell the server to send stream/clear (seek). */
  async streamClear(): Promise<void> {
    const response = await this.sendCommand("STREAM_CLEAR");
    if (response !== "OK") {
      throw new Error(`STREAM_CLEAR failed: ${response}`);
    }
  }

  /** Tell the server to send stream/end. */
  async streamEnd(): Promise<void> {
    const response = await this.sendCommand("STREAM_END");
    if (response !== "OK") {
      throw new Error(`STREAM_END failed: ${response}`);
    }
  }

  /** Tell the server to send a volume command. */
  async setVolume(volume: number): Promise<void> {
    const response = await this.sendCommand(`VOLUME ${volume}`);
    if (response !== "OK") {
      throw new Error(`VOLUME failed: ${response}`);
    }
  }

  /** Tell the server to send a mute command. */
  async setMute(muted: boolean): Promise<void> {
    const response = await this.sendCommand(`MUTE ${muted}`);
    if (response !== "OK") {
      throw new Error(`MUTE failed: ${response}`);
    }
  }

  /** Tell the server to send a set_static_delay command. */
  async setDelay(delayMs: number): Promise<void> {
    const response = await this.sendCommand(`SET_DELAY ${delayMs}`);
    if (response !== "OK") {
      throw new Error(`SET_DELAY failed: ${response}`);
    }
  }

  /** Gracefully shut down the server. */
  async close(): Promise<void> {
    if (!this.proc) return;
    this.closing = true;

    try {
      const response = await this.sendCommand("SHUTDOWN", 5000);
      if (response !== "BYE") {
        console.warn(`Expected BYE, got: ${response}`);
      }
    } catch {
      // Process may already be dead
    }

    this.rl?.close();
    this.rl = null;

    // Send SIGTERM, escalate to SIGKILL after 3s. Recheck exitCode after
    // attaching the listener so a race with a synchronous exit short-circuits.
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
      const proc = this.proc;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 3000);
        proc.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        if (proc.exitCode !== null) {
          clearTimeout(timer);
          resolve();
        }
      });
    }

    this.proc = null;
  }
}
