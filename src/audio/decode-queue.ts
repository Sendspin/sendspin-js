import type { StreamFormat } from "../types.js";

interface EncodedChunk {
  data: ArrayBuffer;
  format: StreamFormat;
  generation: number;
  serverTimeUs: number;
}

/** Holds encoded audio chunks and decodes each one shortly before its server timestamp. */
export class DecodeQueue {
  private chunks: EncodedChunk[] = [];
  private wakeTimeout: ReturnType<typeof setTimeout> | null = null;
  private pumping = false;

  constructor(
    private decode: (
      data: ArrayBuffer,
      format: StreamFormat,
      generation: number,
    ) => Promise<void>,
    // Returns null while the clock is not synchronized.
    private serverNowUs: () => number | null,
    private isLive: (generation: number, serverTimeUs: number) => boolean,
    private leadSec: () => number,
  ) {}

  push(data: ArrayBuffer, format: StreamFormat, generation: number): void {
    const serverTimeUs = Number(new DataView(data, 1, 8).getBigInt64(0));
    this.chunks.push({ data, format, generation, serverTimeUs });
    void this.pump();
  }

  clear(): void {
    this.chunks = [];
    this.cancelWake();
  }

  /** Seconds until the last live undecoded chunk starts. */
  runwaySec(): number {
    const nowUs = this.serverNowUs();
    if (nowUs === null) return 0;
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const { generation, serverTimeUs } = this.chunks[i];
      if (this.isLive(generation, serverTimeUs)) {
        return Math.max(0, (serverTimeUs - nowUs) / 1_000_000);
      }
    }
    return 0;
  }

  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    this.cancelWake();
    try {
      while (this.chunks.length > 0) {
        const head = this.chunks[0];
        const nowUs = this.serverNowUs();
        if (nowUs === null) return;
        // A chunk whose start has passed can no longer play, so skip decoding it.
        if (
          !this.isLive(head.generation, head.serverTimeUs) ||
          head.serverTimeUs < nowUs
        ) {
          this.chunks.shift();
          continue;
        }
        const waitMs =
          (head.serverTimeUs - nowUs) / 1000 - this.leadSec() * 1000;
        if (waitMs > 0) {
          this.wakeTimeout = setTimeout(() => {
            this.wakeTimeout = null;
            void this.pump();
          }, waitMs);
          return;
        }
        this.chunks.shift();
        await this.decode(head.data, head.format, head.generation);
        await this.yieldToEventLoop();
      }
    } finally {
      this.pumping = false;
    }
  }

  // Message events, unlike timers, are not throttled in hidden tabs.
  private yieldToEventLoop(): Promise<void> {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }

  private cancelWake(): void {
    if (this.wakeTimeout !== null) {
      clearTimeout(this.wakeTimeout);
      this.wakeTimeout = null;
    }
  }
}
