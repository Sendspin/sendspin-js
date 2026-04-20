import type { ClientMessage } from "../types";
export class WebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect: boolean = false;

  // Event handlers
  private onOpenHandler?: () => void;
  private onMessageHandler?: (event: MessageEvent) => void;
  private onErrorHandler?: (error: Event) => void;
  private onCloseHandler?: () => void;

  constructor() {}

  /**
   * Adopt an existing WebSocket connection.
   * The caller is responsible for having already opened the socket.
   * Reconnection is disabled for adopted sockets.
   *
   * Returns a Promise that resolves once the adopted socket is open. Throws
   * synchronously if the socket is already CLOSING or CLOSED.
   */
  adopt(
    ws: WebSocket,
    onOpen?: () => void,
    onMessage?: (event: MessageEvent) => void,
    onError?: (error: Event) => void,
    onClose?: () => void,
  ): Promise<void> {
    if (
      ws.readyState !== WebSocket.OPEN &&
      ws.readyState !== WebSocket.CONNECTING
    ) {
      throw new Error(
        `Sendspin: Cannot adopt WebSocket in readyState ${ws.readyState} (must be OPEN or CONNECTING)`,
      );
    }

    // Store handlers
    this.onOpenHandler = onOpen;
    this.onMessageHandler = onMessage;
    this.onErrorHandler = onError;
    this.onCloseHandler = onClose;

    // Detach handlers from any existing socket so its async close event
    // cannot fire into the newly-adopted session.
    if (this.ws) {
      const old = this.ws;
      old.onopen = null;
      old.onmessage = null;
      old.onerror = null;
      old.onclose = null;
      old.close();
      this.ws = null;
    }

    this.ws = ws;
    this.ws.binaryType = "arraybuffer";
    // No auto-reconnect for externally-managed sockets
    this.shouldReconnect = false;

    this.ws.onmessage = (event: MessageEvent) => {
      if (this.onMessageHandler) {
        this.onMessageHandler(event);
      }
    };

    this.ws.onerror = (error: Event) => {
      console.error("Sendspin: WebSocket error", error);
      if (this.onErrorHandler) {
        this.onErrorHandler(error);
      }
    };

    this.ws.onclose = () => {
      console.log("Sendspin: WebSocket disconnected");
      if (this.onCloseHandler) {
        this.onCloseHandler();
      }
    };

    return new Promise<void>((resolve, reject) => {
      const fireOpen = () => {
        if (this.onOpenHandler) {
          this.onOpenHandler();
        }
        resolve();
      };

      if (ws.readyState === WebSocket.OPEN) {
        console.log("Sendspin: Adopted open WebSocket");
        fireOpen();
        return;
      }

      // CONNECTING: wait for open or early close.
      const prevOnClose = this.ws!.onclose;
      this.ws!.onopen = () => {
        console.log("Sendspin: Adopted WebSocket connected");
        fireOpen();
      };
      this.ws!.onclose = (event: CloseEvent) => {
        if (prevOnClose) {
          prevOnClose.call(this.ws!, event);
        }
        reject(new Error("Sendspin: Adopted WebSocket closed before opening"));
      };
    });
  }

  // Connect to WebSocket server
  async connect(
    url: string,
    onOpen?: () => void,
    onMessage?: (event: MessageEvent) => void,
    onError?: (error: Event) => void,
    onClose?: () => void,
  ): Promise<void> {
    // Store handlers
    this.onOpenHandler = onOpen;
    this.onMessageHandler = onMessage;
    this.onErrorHandler = onError;
    this.onCloseHandler = onClose;

    // Disconnect if already connected
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    return new Promise((resolve, reject) => {
      try {
        console.log("Sendspin: Connecting to", url);

        this.ws = new WebSocket(url);
        this.ws.binaryType = "arraybuffer";
        this.shouldReconnect = true;

        this.ws.onopen = () => {
          console.log("Sendspin: WebSocket connected");
          if (this.onOpenHandler) {
            this.onOpenHandler();
          }
          resolve();
        };

        this.ws.onmessage = (event: MessageEvent) => {
          if (this.onMessageHandler) {
            this.onMessageHandler(event);
          }
        };

        this.ws.onerror = (error: Event) => {
          console.error("Sendspin: WebSocket error", error);
          if (this.onErrorHandler) {
            this.onErrorHandler(error);
          }
          reject(error);
        };

        this.ws.onclose = () => {
          console.log("Sendspin: WebSocket disconnected");
          if (this.onCloseHandler) {
            this.onCloseHandler();
          }

          // Try to reconnect after a delay if we should reconnect
          if (this.shouldReconnect) {
            this.scheduleReconnect(url);
          }
        };
      } catch (error) {
        console.error("Sendspin: Failed to connect", error);
        reject(error);
      }
    });
  }

  // Schedule reconnection attempt
  private scheduleReconnect(url: string): void {
    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = globalThis.setTimeout(() => {
      if (this.shouldReconnect) {
        console.log("Sendspin: Attempting to reconnect...");
        this.connect(
          url,
          this.onOpenHandler,
          this.onMessageHandler,
          this.onErrorHandler,
          this.onCloseHandler,
        ).catch((error) => {
          console.error("Sendspin: Reconnection failed", error);
        });
      }
    }, 5000);
  }

  // Disconnect from WebSocket server
  disconnect(): void {
    this.shouldReconnect = false;

    if (this.reconnectTimeout !== null) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // Send message to server (JSON)
  send(message: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn("Sendspin: Cannot send message, WebSocket not connected");
    }
  }

  // Check if WebSocket is connected
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // Get current ready state
  getReadyState(): number {
    return this.ws ? this.ws.readyState : WebSocket.CLOSED;
  }
}
