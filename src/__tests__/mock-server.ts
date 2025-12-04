/**
 * Mock WebSocket server that speaks the Sendspin protocol.
 * Responds to client messages according to the protocol spec.
 */

import type {
  ClientHello,
  ClientTime,
  ClientState,
  StreamFormat,
} from "../types";

export interface MockServerConfig {
  /** Simulated server clock offset in microseconds (server ahead of client) */
  clockOffsetUs?: number;
  /** Simulated network latency in milliseconds (one-way) */
  networkLatencyMs?: number;
}

export class MockSendspinServer {
  private ws: WebSocket | null = null;
  private clockOffsetUs: number;
  private networkLatencyMs: number;
  private messageHandlers: Array<(data: any) => void> = [];
  private receivedMessages: any[] = [];

  constructor(config: MockServerConfig = {}) {
    this.clockOffsetUs = config.clockOffsetUs ?? 0;
    this.networkLatencyMs = config.networkLatencyMs ?? 10;
  }

  /**
   * Inject this server into WebSocket constructor to intercept connections
   */
  install(): void {
    const self = this;

    // Store original WebSocket
    const OriginalWebSocket = globalThis.WebSocket;

    // Override WebSocket constructor
    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      private openHandler: (() => void) | null = null;
      private messageHandler: ((event: MessageEvent) => void) | null = null;
      private closeHandler: (() => void) | null = null;
      private errorHandler: ((event: Event) => void) | null = null;

      readyState: number = 0; // CONNECTING
      url: string;

      constructor(url: string) {
        this.url = url;
        self.ws = this as any;

        // Connect immediately (synchronously) for tests
        // Use setTimeout(0) to allow constructor to complete first
        setTimeout(() => {
          this.readyState = 1; // OPEN
          if (this.openHandler) this.openHandler();
        }, 0);
      }

      send(data: string | ArrayBuffer) {
        if (typeof data === "string") {
          const message = JSON.parse(data);
          self.receivedMessages.push(message);
          self.handleClientMessage(message);
        }
        // Ignore binary messages from client (not used in protocol)
      }

      close() {
        this.readyState = 3; // CLOSED
        if (this.closeHandler) this.closeHandler();
      }

      set onopen(handler: () => void) {
        this.openHandler = handler;
      }

      set onmessage(handler: (event: MessageEvent) => void) {
        this.messageHandler = handler;
        self.messageHandlers.push(handler);
      }

      set onclose(handler: () => void) {
        this.closeHandler = handler;
      }

      set onerror(handler: (event: Event) => void) {
        this.errorHandler = handler;
      }
    }

    (globalThis as any).WebSocket = MockWebSocket;
  }

  /**
   * Handle messages from client
   */
  private handleClientMessage(message: any): void {
    if (message.type === "client/hello") {
      this.handleClientHello(message as ClientHello);
    } else if (message.type === "client/time") {
      this.handleClientTime(message as ClientTime);
    } else if (message.type === "client/state") {
      // Just record state updates, no response needed
    }
  }

  /**
   * Respond to client/hello with server/hello
   */
  private handleClientHello(message: ClientHello): void {
    setTimeout(() => {
      this.sendJSON({
        type: "server/hello",
        payload: {},
      });
    }, this.networkLatencyMs);
  }

  /**
   * Respond to client/time with server/time (NTP-style exchange)
   */
  private handleClientTime(message: ClientTime): void {
    const clientTransmitted = message.payload.client_transmitted;
    const now = performance.now() * 1000;

    // Server received time (with clock offset and network delay)
    const serverReceived = now + this.clockOffsetUs + this.networkLatencyMs * 1000;
    // Server transmitted time (with clock offset, assuming 1ms processing time)
    const serverTransmitted = serverReceived + 1000; // 1ms server processing

    // Send response with network latency
    setTimeout(() => {
      this.sendJSON({
        type: "server/time",
        payload: {
          client_transmitted: clientTransmitted,
          server_received: serverReceived,
          server_transmitted: serverTransmitted,
        },
      });
    }, this.networkLatencyMs * 2); // Round-trip delay
  }

  /**
   * Send a JSON message to the client
   */
  private sendJSON(message: any): void {
    const messageEvent = new MessageEvent("message", {
      data: JSON.stringify(message),
    });

    for (const handler of this.messageHandlers) {
      handler(messageEvent);
    }
  }

  /**
   * Send a binary audio chunk to the client
   */
  sendAudioChunk(serverTimeUs: number, audioData: ArrayBuffer): void {
    // Construct binary message per protocol spec:
    // - First byte: role type (4 for player audio chunk)
    // - Next 8 bytes: server timestamp (big-endian int64)
    // - Remaining bytes: audio data

    const buffer = new ArrayBuffer(1 + 8 + audioData.byteLength);
    const view = new DataView(buffer);

    // First byte: type 4 (player audio chunk)
    view.setUint8(0, 4);

    // Next 8 bytes: server timestamp as big-endian int64
    view.setBigInt64(1, BigInt(Math.floor(serverTimeUs)), false);

    // Copy audio data
    new Uint8Array(buffer, 9).set(new Uint8Array(audioData));

    // Send with network latency
    setTimeout(() => {
      const messageEvent = new MessageEvent("message", {
        data: buffer,
      });

      for (const handler of this.messageHandlers) {
        handler(messageEvent);
      }
    }, this.networkLatencyMs);
  }

  /**
   * Send stream/start message
   */
  sendStreamStart(format: StreamFormat): void {
    this.sendJSON({
      type: "stream/start",
      payload: {
        player: format,
      },
    });
  }

  /**
   * Send stream/end message
   */
  sendStreamEnd(): void {
    this.sendJSON({
      type: "stream/end",
      payload: {
        roles: ["player"],
      },
    });
  }

  /**
   * Send stream/clear message (for seek)
   */
  sendStreamClear(): void {
    this.sendJSON({
      type: "stream/clear",
      payload: {
        roles: ["player"],
      },
    });
  }

  /**
   * Send server/command message
   */
  sendVolumeCommand(volume: number): void {
    this.sendJSON({
      type: "server/command",
      payload: {
        player: {
          command: "volume",
          volume: volume,
        },
      },
    });
  }

  sendMuteCommand(muted: boolean): void {
    this.sendJSON({
      type: "server/command",
      payload: {
        player: {
          command: "mute",
          mute: muted,
        },
      },
    });
  }

  /**
   * Get all messages received from client
   */
  getReceivedMessages(): any[] {
    return this.receivedMessages;
  }

  /**
   * Get the last message of a specific type received from client
   */
  getLastMessage(type: string): any | null {
    for (let i = this.receivedMessages.length - 1; i >= 0; i--) {
      if (this.receivedMessages[i].type === type) {
        return this.receivedMessages[i];
      }
    }
    return null;
  }

  /**
   * Wait for client to send a message of a specific type
   */
  async waitForMessage(type: string, timeoutMs: number = 1000): Promise<any> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const message = this.getLastMessage(type);
      if (message) return message;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Timeout waiting for message type: ${type}`);
  }

  /**
   * Get current server time in microseconds
   */
  getServerTime(): number {
    return performance.now() * 1000 + this.clockOffsetUs;
  }

  /**
   * Clean up
   */
  close(): void {
    if (this.ws) {
      (this.ws as any).close();
    }
  }
}
