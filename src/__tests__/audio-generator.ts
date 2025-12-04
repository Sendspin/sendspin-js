/**
 * Generate synthetic audio data for testing.
 * Produces real PCM audio that can be decoded by the audio processor.
 */

export interface AudioChunkConfig {
  /** Duration in seconds */
  durationSec: number;
  /** Sample rate in Hz */
  sampleRate: number;
  /** Number of channels */
  channels: number;
  /** Bit depth (16, 24, or 32) */
  bitDepth: number;
  /** Frequency of sine wave in Hz (if not silent) */
  frequency?: number;
}

/**
 * Generate a PCM audio chunk with a sine wave tone
 */
export function generatePCMAudioChunk(config: AudioChunkConfig): ArrayBuffer {
  const { durationSec, sampleRate, channels, bitDepth, frequency = 440 } = config;

  const numSamples = Math.floor(durationSec * sampleRate);
  const bytesPerSample = bitDepth / 8;
  const totalBytes = numSamples * channels * bytesPerSample;

  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);

  let offset = 0;

  // Generate interleaved PCM samples
  for (let i = 0; i < numSamples; i++) {
    // Generate sine wave sample
    const t = i / sampleRate;
    const amplitude = 0.3; // 30% amplitude to avoid clipping
    const sample = amplitude * Math.sin(2 * Math.PI * frequency * t);

    // Convert to integer sample based on bit depth
    for (let ch = 0; ch < channels; ch++) {
      if (bitDepth === 16) {
        const intSample = Math.floor(sample * 32767);
        view.setInt16(offset, intSample, true); // little-endian
        offset += 2;
      } else if (bitDepth === 24) {
        const intSample = Math.floor(sample * 8388607);
        // Write 24-bit value as 3 bytes (little-endian)
        view.setUint8(offset, intSample & 0xff);
        view.setUint8(offset + 1, (intSample >> 8) & 0xff);
        view.setUint8(offset + 2, (intSample >> 16) & 0xff);
        offset += 3;
      } else if (bitDepth === 32) {
        const intSample = Math.floor(sample * 2147483647);
        view.setInt32(offset, intSample, true); // little-endian
        offset += 4;
      }
    }
  }

  return buffer;
}

/**
 * Generate a silent PCM audio chunk (all zeros)
 */
export function generateSilentChunk(config: AudioChunkConfig): ArrayBuffer {
  const { durationSec, sampleRate, channels, bitDepth } = config;

  const numSamples = Math.floor(durationSec * sampleRate);
  const bytesPerSample = bitDepth / 8;
  const totalBytes = numSamples * channels * bytesPerSample;

  // ArrayBuffer is initialized to zeros by default
  return new ArrayBuffer(totalBytes);
}

/**
 * Calculate the duration of a PCM audio chunk in microseconds
 */
export function calculateChunkDurationUs(
  numBytes: number,
  sampleRate: number,
  channels: number,
  bitDepth: number,
): number {
  const bytesPerSample = bitDepth / 8;
  const numSamples = numBytes / (channels * bytesPerSample);
  const durationSec = numSamples / sampleRate;
  return Math.floor(durationSec * 1_000_000);
}

/**
 * Generate a sequence of contiguous audio chunks
 */
export function generateChunkSequence(
  startTimeUs: number,
  chunkCount: number,
  chunkConfig: AudioChunkConfig,
): Array<{ audioData: ArrayBuffer; serverTimeUs: number }> {
  const chunks: Array<{ audioData: ArrayBuffer; serverTimeUs: number }> = [];

  const chunkDurationUs = calculateChunkDurationUs(
    Math.floor(chunkConfig.durationSec * chunkConfig.sampleRate) *
      chunkConfig.channels *
      (chunkConfig.bitDepth / 8),
    chunkConfig.sampleRate,
    chunkConfig.channels,
    chunkConfig.bitDepth,
  );

  let currentTimeUs = startTimeUs;

  for (let i = 0; i < chunkCount; i++) {
    const audioData = generatePCMAudioChunk({
      ...chunkConfig,
      // Vary frequency slightly per chunk to make them distinguishable
      frequency: (chunkConfig.frequency ?? 440) + i * 10,
    });

    chunks.push({
      audioData,
      serverTimeUs: currentTimeUs,
    });

    currentTimeUs += chunkDurationUs;
  }

  return chunks;
}
