/**
 * Unit tests for SendspinDecoder (PCM decoding path).
 *
 * Tests the binary message parsing and PCM-to-float conversion that runs
 * entirely in JavaScript (no Web Audio APIs needed).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SendspinDecoder } from "../../src/audio/decoder";
import type { DecodedAudioChunk, StreamFormat } from "../../src/types";

/**
 * Build a binary audio message in Sendspin protocol format:
 *   [1 byte type=4] [8 bytes BE int64 timestamp] [audio payload]
 */
function buildBinaryMessage(
  serverTimeUs: number,
  audioPayload: ArrayBuffer,
): ArrayBuffer {
  const header = new ArrayBuffer(9);
  const view = new DataView(header);
  view.setUint8(0, 4); // audio chunk type
  view.setBigInt64(1, BigInt(serverTimeUs), false); // big-endian

  const combined = new Uint8Array(9 + audioPayload.byteLength);
  combined.set(new Uint8Array(header), 0);
  combined.set(new Uint8Array(audioPayload), 9);
  return combined.buffer;
}

/**
 * Create interleaved 16-bit PCM samples for a sine wave.
 */
function createPcm16Sine(
  numSamples: number,
  channels: number,
  frequency: number = 440,
  sampleRate: number = 48000,
): Int16Array {
  const samples = new Int16Array(numSamples * channels);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const value = Math.round(Math.sin(2 * Math.PI * frequency * t) * 16000);
    for (let ch = 0; ch < channels; ch++) {
      samples[i * channels + ch] = value;
    }
  }
  return samples;
}

/**
 * Create interleaved 24-bit PCM samples packed as 3 bytes per sample (LE).
 */
function createPcm24Sine(
  numSamples: number,
  channels: number,
  frequency: number = 440,
  sampleRate: number = 48000,
): ArrayBuffer {
  const totalSamples = numSamples * channels;
  const buffer = new ArrayBuffer(totalSamples * 3);
  const view = new DataView(buffer);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const floatVal = Math.sin(2 * Math.PI * frequency * t) * 0.5;
    const int24 = Math.round(floatVal * 8388607); // 2^23 - 1

    for (let ch = 0; ch < channels; ch++) {
      const offset = (i * channels + ch) * 3;
      // Little-endian 24-bit
      view.setUint8(offset, int24 & 0xff);
      view.setUint8(offset + 1, (int24 >> 8) & 0xff);
      view.setUint8(offset + 2, (int24 >> 16) & 0xff);
    }
  }
  return buffer;
}

/**
 * Create interleaved 32-bit PCM samples.
 */
function createPcm32Sine(
  numSamples: number,
  channels: number,
  frequency: number = 440,
  sampleRate: number = 48000,
): Int32Array {
  const samples = new Int32Array(numSamples * channels);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const value = Math.round(
      Math.sin(2 * Math.PI * frequency * t) * 1_000_000_000,
    );
    for (let ch = 0; ch < channels; ch++) {
      samples[i * channels + ch] = value;
    }
  }
  return samples;
}

describe("SendspinDecoder", () => {
  let decoder: SendspinDecoder;
  let chunks: DecodedAudioChunk[];
  let generation: number;

  beforeEach(() => {
    chunks = [];
    generation = 0;

    decoder = new SendspinDecoder(
      (chunk) => chunks.push(chunk),
      () => generation,
    );
  });

  describe("binary message parsing", () => {
    it("parses type-4 audio message correctly", async () => {
      const pcmData = createPcm16Sine(960, 2);
      const message = buildBinaryMessage(123456789, pcmData.buffer);

      const format: StreamFormat = {
        codec: "pcm",
        sample_rate: 48000,
        channels: 2,
        bit_depth: 16,
      };

      await decoder.handleBinaryMessage(message, format, 0);

      expect(chunks.length).toBe(1);
      expect(chunks[0].serverTimeUs).toBe(123456789);
      expect(chunks[0].generation).toBe(0);
    });

    it("ignores non-type-4 messages", async () => {
      const buffer = new ArrayBuffer(20);
      const view = new Uint8Array(buffer);
      view[0] = 5; // type 5, not audio

      const format: StreamFormat = {
        codec: "pcm",
        sample_rate: 48000,
        channels: 2,
        bit_depth: 16,
      };

      await decoder.handleBinaryMessage(buffer, format, 0);

      expect(chunks.length).toBe(0);
    });
  });

  describe("PCM 16-bit decoding", () => {
    const format: StreamFormat = {
      codec: "pcm",
      sample_rate: 48000,
      channels: 2,
      bit_depth: 16,
    };

    it("decodes stereo 16-bit PCM to float", async () => {
      const pcmData = createPcm16Sine(960, 2);
      const message = buildBinaryMessage(1000000, pcmData.buffer);

      await decoder.handleBinaryMessage(message, format, 0);

      expect(chunks.length).toBe(1);
      expect(chunks[0].samples.length).toBe(2); // stereo
      expect(chunks[0].samples[0].length).toBe(960);
      expect(chunks[0].samples[1].length).toBe(960);
      expect(chunks[0].sampleRate).toBe(48000);
    });

    it("converts samples to -1.0..1.0 range", async () => {
      // Create samples at known values
      const samples = new Int16Array(4); // 2 samples, 2 channels
      samples[0] = 16384; // ch0, sample0 ≈ 0.5
      samples[1] = -16384; // ch1, sample0 ≈ -0.5
      samples[2] = 32767; // ch0, sample1 ≈ 1.0
      samples[3] = -32768; // ch1, sample1 = -1.0

      const message = buildBinaryMessage(1000000, samples.buffer);
      await decoder.handleBinaryMessage(message, format, 0);

      const ch0 = chunks[0].samples[0];
      const ch1 = chunks[0].samples[1];

      expect(ch0[0]).toBeCloseTo(16384 / 32768, 4);
      expect(ch1[0]).toBeCloseTo(-16384 / 32768, 4);
      expect(ch0[1]).toBeCloseTo(32767 / 32768, 4);
      expect(ch1[1]).toBe(-1.0);
    });

    it("decodes mono 16-bit PCM", async () => {
      const monoFormat: StreamFormat = {
        codec: "pcm",
        sample_rate: 44100,
        channels: 1,
        bit_depth: 16,
      };
      const pcmData = createPcm16Sine(441, 1, 440, 44100);
      const message = buildBinaryMessage(1000000, pcmData.buffer);

      await decoder.handleBinaryMessage(message, monoFormat, 0);

      expect(chunks[0].samples.length).toBe(1); // mono
      expect(chunks[0].samples[0].length).toBe(441);
      expect(chunks[0].sampleRate).toBe(44100);
    });
  });

  describe("PCM 24-bit decoding", () => {
    it("decodes stereo 24-bit PCM to float", async () => {
      const format: StreamFormat = {
        codec: "pcm",
        sample_rate: 48000,
        channels: 2,
        bit_depth: 24,
      };

      const pcmData = createPcm24Sine(960, 2);
      const message = buildBinaryMessage(1000000, pcmData);

      await decoder.handleBinaryMessage(message, format, 0);

      expect(chunks.length).toBe(1);
      expect(chunks[0].samples.length).toBe(2);
      expect(chunks[0].samples[0].length).toBe(960);

      // Check samples are in valid range
      for (const ch of chunks[0].samples) {
        for (const s of ch) {
          expect(s).toBeGreaterThanOrEqual(-1.0);
          expect(s).toBeLessThanOrEqual(1.0);
        }
      }
    });
  });

  describe("PCM 32-bit decoding", () => {
    it("decodes stereo 32-bit PCM to float", async () => {
      const format: StreamFormat = {
        codec: "pcm",
        sample_rate: 48000,
        channels: 2,
        bit_depth: 32,
      };

      const pcmData = createPcm32Sine(960, 2);
      const message = buildBinaryMessage(1000000, pcmData.buffer);

      await decoder.handleBinaryMessage(message, format, 0);

      expect(chunks.length).toBe(1);
      expect(chunks[0].samples.length).toBe(2);
      expect(chunks[0].samples[0].length).toBe(960);

      for (const ch of chunks[0].samples) {
        for (const s of ch) {
          expect(s).toBeGreaterThanOrEqual(-1.0);
          expect(s).toBeLessThanOrEqual(1.0);
        }
      }
    });
  });

  describe("generation filtering", () => {
    it("drops frames for old generations", async () => {
      const format: StreamFormat = {
        codec: "pcm",
        sample_rate: 48000,
        channels: 2,
        bit_depth: 16,
      };

      const pcmData = createPcm16Sine(960, 2);

      // Message tagged with generation 0
      const message = buildBinaryMessage(1000000, pcmData.buffer);

      // Current generation is now 1 (stream has changed)
      generation = 1;

      await decoder.handleBinaryMessage(message, format, 0);

      // Should be dropped because generation 0 != current generation 1
      expect(chunks.length).toBe(0);
    });

    it("accepts frames for current generation", async () => {
      const format: StreamFormat = {
        codec: "pcm",
        sample_rate: 48000,
        channels: 2,
        bit_depth: 16,
      };

      generation = 3;
      const pcmData = createPcm16Sine(960, 2);
      const message = buildBinaryMessage(1000000, pcmData.buffer);

      await decoder.handleBinaryMessage(message, format, 3);

      expect(chunks.length).toBe(1);
      expect(chunks[0].generation).toBe(3);
    });
  });

  describe("lifecycle", () => {
    it("clearState resets decoder state", () => {
      decoder.clearState();
      // Should not throw and decoder should accept new frames
    });

    it("close fully resets decoder", async () => {
      const format: StreamFormat = {
        codec: "pcm",
        sample_rate: 48000,
        channels: 2,
        bit_depth: 16,
      };

      const pcmData = createPcm16Sine(960, 2);
      const message = buildBinaryMessage(1000000, pcmData.buffer);

      await decoder.handleBinaryMessage(message, format, 0);
      expect(chunks.length).toBe(1);

      decoder.close();

      // Should still be able to decode after close (new session)
      await decoder.handleBinaryMessage(message, format, 0);
      expect(chunks.length).toBe(2);
    });
  });

  describe("edge cases", () => {
    it("handles empty audio payload", async () => {
      const format: StreamFormat = {
        codec: "pcm",
        sample_rate: 48000,
        channels: 2,
        bit_depth: 16,
      };

      const emptyPayload = new ArrayBuffer(0);
      const message = buildBinaryMessage(1000000, emptyPayload);

      await decoder.handleBinaryMessage(message, format, 0);

      expect(chunks.length).toBe(1);
      expect(chunks[0].samples[0].length).toBe(0);
      expect(chunks[0].samples[1].length).toBe(0);
    });

    it("handles large timestamps", async () => {
      const format: StreamFormat = {
        codec: "pcm",
        sample_rate: 48000,
        channels: 2,
        bit_depth: 16,
      };

      const pcmData = createPcm16Sine(960, 2);
      // Large timestamp like a real server would produce
      const largeTimestamp = 1_700_000_000_000_000; // ~2023 in µs
      const message = buildBinaryMessage(largeTimestamp, pcmData.buffer);

      await decoder.handleBinaryMessage(message, format, 0);

      expect(chunks[0].serverTimeUs).toBe(largeTimestamp);
    });
  });
});
