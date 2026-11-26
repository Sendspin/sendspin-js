import { describe, it, expect, afterEach, vi } from "vitest";
import { DecodeQueue } from "../../src/audio/decode-queue";
import type { StreamFormat } from "../../src/types";

const FORMAT: StreamFormat = {
  codec: "pcm",
  sample_rate: 48000,
  channels: 2,
  bit_depth: 16,
};

function chunk(serverTimeUs: number): ArrayBuffer {
  const data = new Uint8Array(17);
  data[0] = 4;
  new DataView(data.buffer).setBigInt64(1, BigInt(serverTimeUs));
  return data.buffer;
}

describe("DecodeQueue", () => {
  afterEach(() => vi.useRealTimers());

  it("decodes a chunk only once its timestamp is within the lead", async () => {
    vi.useFakeTimers({ now: 0 });
    const decode = vi.fn(async () => {});
    const queue = new DecodeQueue(
      decode,
      () => Date.now() * 1000,
      () => true,
      () => 5,
    );

    queue.push(chunk(8_000_000), FORMAT, 0);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(decode).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(decode).toHaveBeenCalledOnce();
  });

  it("decodes chunks that are already due without waiting on timers", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const decode = vi.fn(async () => {});
    const queue = new DecodeQueue(
      decode,
      () => Date.now() * 1000,
      () => true,
      () => 5,
    );

    for (let i = 0; i < 3; i++) {
      queue.push(chunk(10_000_000 + i * 20_000), FORMAT, 0);
    }
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          resolve(null);
        };
        channel.port2.postMessage(null);
      });
    }

    expect(decode).toHaveBeenCalledTimes(3);
  });

  it("skips chunks whose start has passed without decoding them", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const decode = vi.fn(async () => {});
    const queue = new DecodeQueue(
      decode,
      () => Date.now() * 1000,
      () => true,
      () => 5,
    );
    const late = chunk(9_000_000);
    const due = chunk(10_100_000);

    queue.push(late, FORMAT, 0);
    queue.push(due, FORMAT, 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(decode).toHaveBeenCalledOnce();
    expect(decode.mock.calls[0][0]).toBe(due);
  });
});
