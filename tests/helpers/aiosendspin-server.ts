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
  private responseQueue: Array<(line: string) => void> = [];

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
      const waiter = this.responseQueue.shift();
      if (waiter) {
        waiter(line);
      }
    });

    // Collect stderr for debugging (uncomment to see aiosendspin output)
    this.proc.stderr!.on("data", () => {
      // process.stderr.write(`[aiosendspin] ${data}`);
    });

    // Wait for READY <port>
    const ready = await this.readLine(10000);
    const match = ready.match(/^READY (\d+)$/);
    if (!match) {
      throw new Error(`Expected READY <port>, got: ${ready}`);
    }
    this.port = parseInt(match[1], 10);
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove ourselves from the queue
        const idx = this.responseQueue.indexOf(handler);
        if (idx !== -1) this.responseQueue.splice(idx, 1);
        reject(new Error(`Timed out reading from server (${timeoutMs}ms)`));
      }, timeoutMs);

      const handler = (line: string) => {
        clearTimeout(timer);
        resolve(line);
      };

      this.responseQueue.push(handler);
    });
  }

  /**
   * Wait for a client to connect to the server.
   * Returns the client ID.
   */
  async waitForClient(): Promise<string> {
    const response = await this.sendCommand("WAIT_CLIENT", 15000);
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

    // Give it a moment, then force kill if needed
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.proc?.kill("SIGKILL");
          resolve();
        }, 3000);
        this.proc!.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    this.proc = null;
  }
}
