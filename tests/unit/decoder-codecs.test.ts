/**
 * Unit tests for SendspinDecoder non-PCM paths.
 *
 * Covers the WebCodecs (native Opus) dispatch + de-interleaving of every
 * AudioData layout (f32, f32-planar, s16, s16-planar), the FLAC base64
 * codec_header prepend + OfflineAudioContext dispatch, and codec routing.
 *
 * Real Opus/FLAC codecs are unavailable in node, so the WebCodecs AudioDecoder
 * and OfflineAudioContext are faked with the minimum surface the decoder uses.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SendspinDecoder } from "../../src/audio/decoder";
import type { DecodedAudioChunk, StreamFormat } from "../../src/types";

function buildBinaryMessage(
  serverTimeUs: number,
  audioPayload: ArrayBuffer,
  type = 4,
): ArrayBuffer {
  const combined = new Uint8Array(9 + audioPayload.byteLength);
  const view = new DataView(combined.buffer);
  view.setUint8(0, type);
  view.setBigInt64(1, BigInt(serverTimeUs), false);
  combined.set(new Uint8Array(audioPayload), 9);
  return combined.buffer;
}

// ---------------------------------------------------------------------------
// Fake WebCodecs surface
// ---------------------------------------------------------------------------

type AudioDataFormat = "f32" | "f32-planar" | "s16" | "s16-planar";

/**
 * Minimal AudioData stand-in. Holds either interleaved data (f32/s16) in
 * plane 0, or one plane per channel (planar). copyTo honours planeIndex.
 */
class FakeAudioData {
  format: AudioDataFormat;
  numberOfChannels: number;
  numberOfFrames: number;
  timestamp: number;
  closed = false;
  private planes: Array<Float32Array | Int16Array>;

  constructor(opts: {
    format: AudioDataFormat;
    channels: number;
    frames: number;
    timestamp: number;
    planes: Array<Float32Array | Int16Array>;
  }) {
    this.format = opts.format;
    this.numberOfChannels = opts.channels;
    this.numberOfFrames = opts.frames;
    this.timestamp = opts.timestamp;
    this.planes = opts.planes;
  }

  copyTo(dest: Float32Array | Int16Array, opts: { planeIndex: number }): void {
    const src = this.planes[opts.planeIndex];
    (dest as any).set(src as any);
  }

  close(): void {
    this.closed = true;
  }
}

/** Output factory: given the queued decode call, returns the AudioData to emit. */
let audioDataFactory: ((timestamp: number) => FakeAudioData) | null = null;
/** When true, the next isConfigSupported reports unsupported. */
let reportUnsupported = false;
/** When true, configure() throws. */
let configureThrows = false;

class FakeAudioDecoder {
  static lastInstance: FakeAudioDecoder | null = null;
  static isConfigSupportedCalls = 0;

  state: "unconfigured" | "configured" | "closed" = "unconfigured";
  private outputCb: (data: FakeAudioData) => void;
  private errorCb: (e: Error) => void;

  constructor(init: {
    output: (data: FakeAudioData) => void;
    error: (e: Error) => void;
  }) {
    this.outputCb = init.output;
    this.errorCb = init.error;
    FakeAudioDecoder.lastInstance = this;
  }

  static async isConfigSupported(_config: unknown): Promise<{
    supported: boolean;
  }> {
    FakeAudioDecoder.isConfigSupportedCalls++;
    return { supported: !reportUnsupported };
  }

  configure(_config: unknown): void {
    if (configureThrows) {
      throw new Error("configure failed");
    }
    this.state = "configured";
  }

  decode(chunk: { timestamp: number; data: ArrayBuffer }): void {
    // Synchronous output so tests can observe the emitted chunk immediately.
    const data = audioDataFactory
      ? audioDataFactory(chunk.timestamp)
      : new FakeAudioData({
          format: "f32",
          channels: 2,
          frames: 0,
          timestamp: chunk.timestamp,
          planes: [new Float32Array(0)],
        });
    this.outputCb(data);
  }

  close(): void {
    this.state = "closed";
  }
}

class FakeEncodedAudioChunk {
  type: string;
  timestamp: number;
  data: ArrayBuffer;
  constructor(init: { type: string; timestamp: number; data: ArrayBuffer }) {
    this.type = init.type;
    this.timestamp = init.timestamp;
    this.data = init.data;
  }
}

const opusFormat: StreamFormat = {
  codec: "opus",
  sample_rate: 48000,
  channels: 2,
  bit_depth: 16,
};

function installWebCodecs(): void {
  (globalThis as any).AudioDecoder = FakeAudioDecoder;
  (globalThis as any).EncodedAudioChunk = FakeEncodedAudioChunk;
}

function uninstallWebCodecs(): void {
  delete (globalThis as any).AudioDecoder;
  delete (globalThis as any).EncodedAudioChunk;
}

describe("SendspinDecoder — native Opus (WebCodecs)", () => {
  let decoder: SendspinDecoder;
  let chunks: DecodedAudioChunk[];
  let generation: number;

  beforeEach(() => {
    chunks = [];
    generation = 0;
    audioDataFactory = null;
    reportUnsupported = false;
    configureThrows = false;
    FakeAudioDecoder.lastInstance = null;
    FakeAudioDecoder.isConfigSupportedCalls = 0;
    installWebCodecs();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    decoder = new SendspinDecoder(
      (chunk) => chunks.push(chunk),
      () => generation,
    );
  });

  afterEach(() => {
    uninstallWebCodecs();
    vi.restoreAllMocks();
  });

  it("routes opus through the native decoder and emits decoded samples", async () => {
    audioDataFactory = (ts) =>
      new FakeAudioData({
        format: "f32",
        channels: 2,
        frames: 2,
        timestamp: ts,
        // interleaved L,R,L,R
        planes: [new Float32Array([0.25, -0.25, 0.5, -0.5])],
      });

    const message = buildBinaryMessage(7777, new Uint8Array([1, 2, 3]).buffer);
    await decoder.handleBinaryMessage(message, opusFormat, 0);

    expect(FakeAudioDecoder.isConfigSupportedCalls).toBe(1);
    expect(chunks.length).toBe(1);
    expect(chunks[0].serverTimeUs).toBe(7777);
    expect(chunks[0].sampleRate).toBe(48000);
    expect(chunks[0].samples.length).toBe(2);
  });

  it("de-interleaves f32 (packed plane 0) into per-channel arrays", async () => {
    audioDataFactory = (ts) =>
      new FakeAudioData({
        format: "f32",
        channels: 2,
        frames: 2,
        timestamp: ts,
        planes: [new Float32Array([0.25, -0.25, 0.5, -0.5])],
      });

    await decoder.handleBinaryMessage(
      buildBinaryMessage(1, new Uint8Array([0]).buffer),
      opusFormat,
      0,
    );

    expect(chunks[0].samples[0][0]).toBeCloseTo(0.25, 5);
    expect(chunks[0].samples[0][1]).toBeCloseTo(0.5, 5);
    expect(chunks[0].samples[1][0]).toBeCloseTo(-0.25, 5);
    expect(chunks[0].samples[1][1]).toBeCloseTo(-0.5, 5);
  });

  it("de-interleaves f32-planar into per-channel arrays", async () => {
    audioDataFactory = (ts) =>
      new FakeAudioData({
        format: "f32-planar",
        channels: 2,
        frames: 2,
        timestamp: ts,
        planes: [
          new Float32Array([0.1, 0.2]), // ch0
          new Float32Array([-0.1, -0.2]), // ch1
        ],
      });

    await decoder.handleBinaryMessage(
      buildBinaryMessage(1, new Uint8Array([0]).buffer),
      opusFormat,
      0,
    );

    expect(chunks[0].samples[0][0]).toBeCloseTo(0.1, 5);
    expect(chunks[0].samples[0][1]).toBeCloseTo(0.2, 5);
    expect(chunks[0].samples[1][0]).toBeCloseTo(-0.1, 5);
    expect(chunks[0].samples[1][1]).toBeCloseTo(-0.2, 5);
  });

  it("de-interleaves s16 (packed plane 0) and scales to float", async () => {
    audioDataFactory = (ts) =>
      new FakeAudioData({
        format: "s16",
        channels: 2,
        frames: 2,
        timestamp: ts,
        // interleaved L,R,L,R as int16
        planes: [new Int16Array([16384, -16384, 32767, -32768])],
      });

    await decoder.handleBinaryMessage(
      buildBinaryMessage(1, new Uint8Array([0]).buffer),
      opusFormat,
      0,
    );

    expect(chunks[0].samples[0][0]).toBeCloseTo(16384 / 32768, 5);
    expect(chunks[0].samples[1][0]).toBeCloseTo(-16384 / 32768, 5);
    expect(chunks[0].samples[0][1]).toBeCloseTo(32767 / 32768, 5);
    expect(chunks[0].samples[1][1]).toBeCloseTo(-32768 / 32768, 5);
  });

  it("de-interleaves s16-planar and scales to float", async () => {
    audioDataFactory = (ts) =>
      new FakeAudioData({
        format: "s16-planar",
        channels: 2,
        frames: 2,
        timestamp: ts,
        planes: [
          new Int16Array([16384, 32767]), // ch0
          new Int16Array([-16384, -32768]), // ch1
        ],
      });

    await decoder.handleBinaryMessage(
      buildBinaryMessage(1, new Uint8Array([0]).buffer),
      opusFormat,
      0,
    );

    expect(chunks[0].samples[0][0]).toBeCloseTo(16384 / 32768, 5);
    expect(chunks[0].samples[0][1]).toBeCloseTo(32767 / 32768, 5);
    expect(chunks[0].samples[1][0]).toBeCloseTo(-16384 / 32768, 5);
    expect(chunks[0].samples[1][1]).toBeCloseTo(-32768 / 32768, 5);
  });

  it("preserves the original server timestamp, not the AudioData output timestamp", async () => {
    // AudioData.timestamp differs from the chunk's server time; the emitted
    // chunk must carry the server time the message arrived with.
    audioDataFactory = () =>
      new FakeAudioData({
        format: "f32",
        channels: 2,
        frames: 1,
        timestamp: 999999,
        planes: [new Float32Array([0.1, 0.2])],
      });

    await decoder.handleBinaryMessage(
      buildBinaryMessage(424242, new Uint8Array([0]).buffer),
      opusFormat,
      0,
    );

    expect(chunks[0].serverTimeUs).toBe(424242);
  });

  it("drops native frames whose generation is stale", async () => {
    audioDataFactory = (ts) =>
      new FakeAudioData({
        format: "f32",
        channels: 2,
        frames: 1,
        timestamp: ts,
        planes: [new Float32Array([0.1, 0.2])],
      });

    generation = 5;
    await decoder.handleBinaryMessage(
      buildBinaryMessage(1, new Uint8Array([0]).buffer),
      opusFormat,
      2, // stale generation
    );

    expect(chunks.length).toBe(0);
  });

  it("falls back to opus-encdec path when WebCodecs reports unsupported", async () => {
    // isConfigSupported -> unsupported flips useNativeOpus off; the subsequent
    // fallback decode would import opus-encdec which is heavy. We only assert
    // the native decoder was never constructed and no native chunk was emitted.
    reportUnsupported = true;

    await decoder
      .handleBinaryMessage(
        buildBinaryMessage(1, new Uint8Array([1, 2, 3]).buffer),
        opusFormat,
        0,
      )
      .catch(() => {});

    expect(FakeAudioDecoder.lastInstance).toBeNull();
  });

  it("reuses a configured decoder across chunks with the same format", async () => {
    audioDataFactory = (ts) =>
      new FakeAudioData({
        format: "f32",
        channels: 2,
        frames: 1,
        timestamp: ts,
        planes: [new Float32Array([0.1, 0.2])],
      });

    await decoder.handleBinaryMessage(
      buildBinaryMessage(1, new Uint8Array([0]).buffer),
      opusFormat,
      0,
    );
    await decoder.handleBinaryMessage(
      buildBinaryMessage(2, new Uint8Array([0]).buffer),
      opusFormat,
      0,
    );

    expect(chunks.length).toBe(2);
    // Only one negotiation should have happened.
    expect(FakeAudioDecoder.isConfigSupportedCalls).toBe(1);
  });

  it("clearState closes the native decoder and forces re-negotiation", async () => {
    audioDataFactory = (ts) =>
      new FakeAudioData({
        format: "f32",
        channels: 2,
        frames: 1,
        timestamp: ts,
        planes: [new Float32Array([0.1, 0.2])],
      });

    await decoder.handleBinaryMessage(
      buildBinaryMessage(1, new Uint8Array([0]).buffer),
      opusFormat,
      0,
    );
    const first = FakeAudioDecoder.lastInstance;
    expect(first?.state).toBe("configured");

    decoder.clearState();
    expect(first?.state).toBe("closed");

    await decoder.handleBinaryMessage(
      buildBinaryMessage(2, new Uint8Array([0]).buffer),
      opusFormat,
      0,
    );

    expect(FakeAudioDecoder.lastInstance).not.toBe(first);
    expect(FakeAudioDecoder.isConfigSupportedCalls).toBe(2);
    expect(chunks.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// FLAC path — fake OfflineAudioContext
// ---------------------------------------------------------------------------

class FakeAudioBuffer {
  numberOfChannels: number;
  sampleRate: number;
  private channels: Float32Array[];
  constructor(channels: Float32Array[], sampleRate: number) {
    this.channels = channels;
    this.numberOfChannels = channels.length;
    this.sampleRate = sampleRate;
  }
  getChannelData(ch: number): Float32Array {
    return this.channels[ch];
  }
}

/** Captures what bytes decodeAudioData received, returns a canned AudioBuffer. */
let flacDecodeCapture: { received: Uint8Array | null } = { received: null };
let flacDecodeResult: FakeAudioBuffer | null = null;
let flacDecodeThrows = false;

class FakeOfflineAudioContext {
  static instances = 0;
  numberOfChannels: number;
  sampleRate: number;
  constructor(channels: number, _length: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.sampleRate = sampleRate;
    FakeOfflineAudioContext.instances++;
  }
  async decodeAudioData(data: ArrayBuffer): Promise<FakeAudioBuffer> {
    flacDecodeCapture.received = new Uint8Array(data.slice(0));
    if (flacDecodeThrows) {
      throw new Error("decode failed");
    }
    return (
      flacDecodeResult ??
      new FakeAudioBuffer(
        [new Float32Array([0.1, 0.2]), new Float32Array([-0.1, -0.2])],
        this.sampleRate,
      )
    );
  }
}

describe("SendspinDecoder — FLAC (OfflineAudioContext)", () => {
  let decoder: SendspinDecoder;
  let chunks: DecodedAudioChunk[];
  let generation: number;

  beforeEach(() => {
    chunks = [];
    generation = 0;
    flacDecodeCapture = { received: null };
    flacDecodeResult = null;
    flacDecodeThrows = false;
    FakeOfflineAudioContext.instances = 0;
    (globalThis as any).OfflineAudioContext = FakeOfflineAudioContext;
    vi.spyOn(console, "error").mockImplementation(() => {});

    decoder = new SendspinDecoder(
      (chunk) => chunks.push(chunk),
      () => generation,
    );
  });

  afterEach(() => {
    delete (globalThis as any).OfflineAudioContext;
    vi.restoreAllMocks();
  });

  const flacFormat: StreamFormat = {
    codec: "flac",
    sample_rate: 44100,
    channels: 2,
    bit_depth: 16,
  };

  it("decodes FLAC into per-channel float arrays from the AudioBuffer", async () => {
    flacDecodeResult = new FakeAudioBuffer(
      [new Float32Array([0.3, 0.4]), new Float32Array([-0.3, -0.4])],
      44100,
    );

    await decoder.handleBinaryMessage(
      buildBinaryMessage(555, new Uint8Array([9, 9, 9]).buffer),
      flacFormat,
      0,
    );

    expect(chunks.length).toBe(1);
    expect(chunks[0].serverTimeUs).toBe(555);
    expect(chunks[0].sampleRate).toBe(44100);
    expect(chunks[0].samples.length).toBe(2);
    expect(chunks[0].samples[0][0]).toBeCloseTo(0.3, 5);
    expect(chunks[0].samples[1][1]).toBeCloseTo(-0.4, 5);
  });

  it("prepends the base64 codec_header to the audio data before decoding", async () => {
    const header = new Uint8Array([0x66, 0x4c, 0x61, 0x43]); // "fLaC"
    const headerB64 = Buffer.from(header).toString("base64");
    const audioBytes = new Uint8Array([0xaa, 0xbb, 0xcc]);

    const format: StreamFormat = { ...flacFormat, codec_header: headerB64 };

    await decoder.handleBinaryMessage(
      buildBinaryMessage(1, audioBytes.buffer),
      format,
      0,
    );

    const received = flacDecodeCapture.received!;
    expect(received).not.toBeNull();
    // header + audio, in that order
    expect(Array.from(received)).toEqual([
      0x66, 0x4c, 0x61, 0x43, 0xaa, 0xbb, 0xcc,
    ]);
  });

  it("emits no chunk when decodeAudioData throws", async () => {
    flacDecodeThrows = true;

    await decoder.handleBinaryMessage(
      buildBinaryMessage(1, new Uint8Array([1, 2]).buffer),
      flacFormat,
      0,
    );

    expect(chunks.length).toBe(0);
  });

  it("recreates the decoding context when the format changes", async () => {
    await decoder.handleBinaryMessage(
      buildBinaryMessage(1, new Uint8Array([1]).buffer),
      flacFormat,
      0,
    );
    await decoder.handleBinaryMessage(
      buildBinaryMessage(2, new Uint8Array([1]).buffer),
      { ...flacFormat, sample_rate: 48000 },
      0,
    );

    expect(FakeOfflineAudioContext.instances).toBe(2);
    expect(chunks.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Codec routing
// ---------------------------------------------------------------------------

describe("SendspinDecoder — codec routing", () => {
  it("emits no chunk for an unknown codec", async () => {
    const chunks: DecodedAudioChunk[] = [];
    const decoder = new SendspinDecoder(
      (chunk) => chunks.push(chunk),
      () => 0,
    );

    const format = {
      codec: "mp3",
      sample_rate: 48000,
      channels: 2,
      bit_depth: 16,
    } as unknown as StreamFormat;

    await decoder.handleBinaryMessage(
      buildBinaryMessage(1, new Uint8Array([1, 2, 3]).buffer),
      format,
      0,
    );

    expect(chunks.length).toBe(0);
  });
});
