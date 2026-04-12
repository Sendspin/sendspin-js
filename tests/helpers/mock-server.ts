/**
 * Mock Sendspin protocol server for testing.
 *
 * Implements the minimum server-side protocol needed to test the JS SDK:
 * - WebSocket server on a random port
 * - Responds to client/hello with server/hello
 * - Responds to client/time with server/time (NTP-style)
 * - Can send stream/start, binary PCM audio chunks, stream/clear, stream/end
 * - Can send server/command (volume, mute, set_static_delay)
 * - Tracks received messages for assertions
 */

import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import type { AddressInfo } from "net";

export interface ReceivedMessage {
  type: string;
  payload: Record<string, unknown>;
  raw: string;
}

export class MockSendspinServer {
  private wss: WebSocketServer | null = null;
  private clients: WsWebSocket[] = [];
  readonly received: ReceivedMessage[] = [];

  /** Port the server is listening on (available after start()). */
  port = 0;

  /** Monotonic server time in microseconds. Starts at a large offset to test sync. */
  private serverTimeOffsetUs = 1_000_000_000_000; // 1e12 µs ≈ 16.6 min

  /** Called when a client/hello is received. Override for custom behavior. */
  onClientHello?: (msg: ReceivedMessage, ws: WsWebSocket) => void;

  /** Called when a client/time is received. Override to suppress auto-reply. */
  onClientTime?: (msg: ReceivedMessage, ws: WsWebSocket) => boolean;

  /** Get the current "server time" in microseconds. */
  getServerTimeUs(): number {
    return Math.floor(performance.now() * 1000) + this.serverTimeOffsetUs;
  }

  /** Start the WebSocket server on a random available port. */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: 0 });

      this.wss.on("listening", () => {
        this.port = (this.wss!.address() as AddressInfo).port;
        resolve();
      });

      this.wss.on("connection", (ws) => {
        this.clients.push(ws);
        ws.binaryType = "arraybuffer";

        ws.on("message", (data: Buffer | ArrayBuffer | string) => {
          const text =
            typeof data === "string" ? data : Buffer.from(data).toString();

          let parsed: { type: string; payload: Record<string, unknown> };
          try {
            parsed = JSON.parse(text);
          } catch {
            return; // ignore non-JSON (shouldn't happen in this protocol)
          }

          this.received.push({
            type: parsed.type,
            payload: parsed.payload,
            raw: text,
          });

          this.handleMessage(parsed, ws);
        });

        ws.on("close", () => {
          this.clients = this.clients.filter((c) => c !== ws);
        });
      });
    });
  }

  private handleMessage(
    msg: { type: string; payload: Record<string, unknown> },
    ws: WsWebSocket,
  ): void {
    switch (msg.type) {
      case "client/hello":
        if (this.onClientHello) {
          this.onClientHello(
            { type: msg.type, payload: msg.payload, raw: JSON.stringify(msg) },
            ws,
          );
        }
        this.sendServerHello(ws);
        break;

      case "client/time": {
        const handled = this.onClientTime?.(
          { type: msg.type, payload: msg.payload, raw: JSON.stringify(msg) },
          ws,
        );
        if (!handled) {
          this.sendServerTime(
            ws,
            msg.payload.client_transmitted as number,
          );
        }
        break;
      }

      // client/state, client/command, client/goodbye — just record them
    }
  }

  /** Send server/hello to a specific client. */
  sendServerHello(ws: WsWebSocket): void {
    ws.send(
      JSON.stringify({
        type: "server/hello",
        payload: {
          server_id: "mock-server",
          server_name: "Mock Sendspin Server",
        },
      }),
    );
  }

  /** Send server/time in response to a client/time. */
  sendServerTime(ws: WsWebSocket, clientTransmitted: number): void {
    const now = this.getServerTimeUs();
    ws.send(
      JSON.stringify({
        type: "server/time",
        payload: {
          client_transmitted: clientTransmitted,
          server_received: now,
          server_transmitted: now,
        },
      }),
    );
  }

  /** Broadcast stream/start to all connected clients. */
  sendStreamStart(format: {
    codec: string;
    sample_rate: number;
    channels: number;
    bit_depth: number;
  }): void {
    const msg = JSON.stringify({
      type: "stream/start",
      payload: { player: format },
    });
    for (const ws of this.clients) {
      ws.send(msg);
    }
  }

  /** Broadcast stream/clear to all connected clients. */
  sendStreamClear(): void {
    const msg = JSON.stringify({
      type: "stream/clear",
      payload: { roles: ["player"] },
    });
    for (const ws of this.clients) {
      ws.send(msg);
    }
  }

  /** Broadcast stream/end to all connected clients. */
  sendStreamEnd(): void {
    const msg = JSON.stringify({
      type: "stream/end",
      payload: { roles: ["player"] },
    });
    for (const ws of this.clients) {
      ws.send(msg);
    }
  }

  /** Send a server/command to all connected clients. */
  sendServerCommand(playerCommand: {
    command: string;
    volume?: number;
    mute?: boolean;
    static_delay_ms?: number;
  }): void {
    const msg = JSON.stringify({
      type: "server/command",
      payload: { player: playerCommand },
    });
    for (const ws of this.clients) {
      ws.send(msg);
    }
  }

  /** Send a server/state to all connected clients. */
  sendServerState(payload: Record<string, unknown>): void {
    const msg = JSON.stringify({
      type: "server/state",
      payload,
    });
    for (const ws of this.clients) {
      ws.send(msg);
    }
  }

  /** Send a group/update to all connected clients. */
  sendGroupUpdate(payload: Record<string, unknown>): void {
    const msg = JSON.stringify({
      type: "group/update",
      payload,
    });
    for (const ws of this.clients) {
      ws.send(msg);
    }
  }

  /**
   * Build and broadcast a PCM audio chunk (binary message type 4).
   *
   * @param samples Interleaved PCM samples as Int16Array (16-bit) or raw buffer
   * @param serverTimeUs Server timestamp in microseconds
   */
  sendPcmChunk(samples: Int16Array, serverTimeUs?: number): void {
    const timeUs = serverTimeUs ?? this.getServerTimeUs();

    // Binary layout: [1 byte type] [8 bytes timestamp BE int64] [audio data]
    const header = new ArrayBuffer(9);
    const headerView = new DataView(header);
    headerView.setUint8(0, 4); // type = 4 (audio chunk)
    headerView.setBigInt64(1, BigInt(timeUs), false); // big-endian

    // Combine header + PCM data
    const audioBytes = new Uint8Array(samples.buffer);
    const packet = new Uint8Array(9 + audioBytes.byteLength);
    packet.set(new Uint8Array(header), 0);
    packet.set(audioBytes, 9);

    for (const ws of this.clients) {
      ws.send(packet.buffer);
    }
  }

  /**
   * Generate a sine-wave PCM chunk and send it.
   *
   * @param durationMs Duration in milliseconds
   * @param frequency Frequency in Hz (default 440 = A4)
   * @param sampleRate Sample rate (default 48000)
   * @param channels Number of channels (default 2)
   * @param serverTimeUs Override server timestamp
   */
  sendSineChunk(
    durationMs: number = 20,
    frequency: number = 440,
    sampleRate: number = 48000,
    channels: number = 2,
    serverTimeUs?: number,
  ): void {
    const numSamples = Math.floor((sampleRate * durationMs) / 1000);
    const samples = new Int16Array(numSamples * channels);

    for (let i = 0; i < numSamples; i++) {
      const t = i / sampleRate;
      const value = Math.round(Math.sin(2 * Math.PI * frequency * t) * 16000);
      for (let ch = 0; ch < channels; ch++) {
        samples[i * channels + ch] = value;
      }
    }

    this.sendPcmChunk(samples, serverTimeUs);
  }

  /** Return messages of a given type. */
  messagesOfType(type: string): ReceivedMessage[] {
    return this.received.filter((m) => m.type === type);
  }

  /** Wait until a message of the given type has been received. */
  async waitForMessage(
    type: string,
    timeoutMs: number = 5000,
  ): Promise<ReceivedMessage> {
    const existing = this.received.find((m) => m.type === type);
    if (existing) return existing;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for message type: ${type}`));
      }, timeoutMs);

      const check = setInterval(() => {
        const msg = this.received.find((m) => m.type === type);
        if (msg) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve(msg);
        }
      }, 10);
    });
  }

  /** Wait until N messages of the given type have been received. */
  async waitForMessageCount(
    type: string,
    count: number,
    timeoutMs: number = 5000,
  ): Promise<ReceivedMessage[]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const got = this.messagesOfType(type).length;
        reject(
          new Error(
            `Timed out waiting for ${count} messages of type ${type} (got ${got})`,
          ),
        );
      }, timeoutMs);

      const check = setInterval(() => {
        const msgs = this.messagesOfType(type);
        if (msgs.length >= count) {
          clearTimeout(timeout);
          clearInterval(check);
          resolve(msgs);
        }
      }, 10);
    });
  }

  /** Close the server and all connections. */
  async close(): Promise<void> {
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients = [];

    return new Promise((resolve) => {
      if (this.wss) {
        this.wss.close(() => resolve());
        this.wss = null;
      } else {
        resolve();
      }
    });
  }
}
