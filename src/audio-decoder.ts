/**
 * Audio decoder pipeline for Sendspin protocol.
 *
 * Decodes compressed audio (PCM, Opus, FLAC) into raw Float32Array PCM samples.
 * This module has no Web Audio playback concerns — it only produces decoded data.
 */

import type { StreamFormat, DecodedAudioChunk } from "./types";

export class SendspinDecoder {
  private onDecodedChunk: (chunk: DecodedAudioChunk) => void;
  private currentGeneration: () => number;

  // Native Opus decoder (WebCodecs API)
  private webCodecsDecoder: AudioDecoder | null = null;
  private webCodecsDecoderReady: Promise<void> | null = null;
  private webCodecsFormat: StreamFormat | null = null;
  private useNativeOpus: boolean = true;
  private nativeDecoderQueue: Array<{
    serverTimeUs: number;
    generation: number;
  }> = [];

  // Fallback Opus decoder (opus-encdec library)
  private opusDecoder: any = null;
  private opusDecoderModule: any = null;
  private opusDecoderReady: Promise<void> | null = null;

  // FLAC decoding context (OfflineAudioContext, no playback needed)
  private flacDecodingContext: OfflineAudioContext | null = null;
  private flacDecodingContextSampleRate: number = 0;

  constructor(
    onDecodedChunk: (chunk: DecodedAudioChunk) => void,
    currentGeneration: () => number,
  ) {
    this.onDecodedChunk = onDecodedChunk;
    this.currentGeneration = currentGeneration;
  }

  /**
   * Handle a binary audio message from the WebSocket.
   * Parses the message, decodes the audio, and emits a DecodedAudioChunk.
   */
  async handleBinaryMessage(
    data: ArrayBuffer,
    format: StreamFormat,
    generation: number,
  ): Promise<void> {
    // First byte contains role type and message slot
    const firstByte = new Uint8Array(data)[0];

    // Type 4 is audio chunk (Player role, slot 0)
    if (firstByte === 4) {
      // Next 8 bytes are server timestamp in microseconds (big-endian int64)
      const timestampView = new DataView(data, 1, 8);
      const serverTimeUs = Number(timestampView.getBigInt64(0, false));

      // Rest is audio data
      const audioData = data.slice(9);

      // For Opus: use native decoder (non-blocking async path)
      if (format.codec === "opus" && this.useNativeOpus) {
        await this.initWebCodecsDecoder(format);

        if (this.useNativeOpus && this.webCodecsDecoder) {
          if (
            this.queueToNativeOpusDecoder(audioData, serverTimeUs, generation)
          ) {
            return; // Async path - callback handles output
          }
          // Fall through to fallback on error
        }
      }

      // Fallback decode path (PCM, FLAC, or Opus via opus-encdec)
      try {
        const decoded = await this.decode(audioData, format);

        if (decoded && generation === this.currentGeneration()) {
          this.onDecodedChunk({
            samples: decoded.samples,
            sampleRate: decoded.sampleRate,
            serverTimeUs,
            generation,
          });
        }
      } catch (error) {
        console.error("Sendspin: Failed to decode audio buffer:", error);
      }
    }
  }

  private async decode(
    audioData: ArrayBuffer,
    format: StreamFormat,
  ): Promise<{ samples: Float32Array[]; sampleRate: number } | null> {
    if (format.codec === "opus") {
      return this.decodeOpusWithEncdec(audioData, format);
    } else if (format.codec === "flac") {
      return this.decodeFLAC(audioData, format);
    } else if (format.codec === "pcm") {
      return this.decodePCM(audioData, format);
    }
    return null;
  }

  // ========================================
  // PCM Decoder
  // ========================================

  private decodePCM(
    audioData: ArrayBuffer,
    format: StreamFormat,
  ): { samples: Float32Array[]; sampleRate: number } | null {
    const bytesPerSample = (format.bit_depth || 16) / 8;
    const dataView = new DataView(audioData);
    const numSamples =
      audioData.byteLength / (bytesPerSample * format.channels);

    const samples: Float32Array[] = [];
    for (let ch = 0; ch < format.channels; ch++) {
      samples.push(new Float32Array(numSamples));
    }

    // Decode PCM data (interleaved format)
    for (let channel = 0; channel < format.channels; channel++) {
      const channelData = samples[channel];
      for (let i = 0; i < numSamples; i++) {
        const offset = (i * format.channels + channel) * bytesPerSample;
        let sample = 0;

        if (format.bit_depth === 16) {
          sample = dataView.getInt16(offset, true) / 32768.0;
        } else if (format.bit_depth === 24) {
          const byte1 = dataView.getUint8(offset);
          const byte2 = dataView.getUint8(offset + 1);
          const byte3 = dataView.getUint8(offset + 2);
          let int24 = (byte3 << 16) | (byte2 << 8) | byte1;
          if (int24 & 0x800000) {
            int24 |= 0xff000000;
          }
          sample = int24 / 8388608.0;
        } else if (format.bit_depth === 32) {
          sample = dataView.getInt32(offset, true) / 2147483648.0;
        }

        channelData[i] = sample;
      }
    }

    return { samples, sampleRate: format.sample_rate };
  }

  // ========================================
  // FLAC Decoder (uses OfflineAudioContext)
  // ========================================

  private getFlacDecodingContext(sampleRate: number): OfflineAudioContext {
    if (
      !this.flacDecodingContext ||
      this.flacDecodingContextSampleRate !== sampleRate
    ) {
      this.flacDecodingContext = new OfflineAudioContext(2, 1, sampleRate);
      this.flacDecodingContextSampleRate = sampleRate;
    }
    return this.flacDecodingContext;
  }

  private async decodeFLAC(
    audioData: ArrayBuffer,
    format: StreamFormat,
  ): Promise<{ samples: Float32Array[]; sampleRate: number } | null> {
    try {
      let dataToEncode = audioData;
      if (format.codec_header) {
        // Decode Base64 codec header and prepend to audio data
        const headerBytes = Uint8Array.from(atob(format.codec_header), (c) =>
          c.charCodeAt(0),
        );
        const combined = new Uint8Array(
          headerBytes.length + audioData.byteLength,
        );
        combined.set(headerBytes, 0);
        combined.set(new Uint8Array(audioData), headerBytes.length);
        dataToEncode = combined.buffer;
      }

      const ctx = this.getFlacDecodingContext(format.sample_rate);
      const audioBuffer = await ctx.decodeAudioData(dataToEncode);

      // Extract Float32Array per channel from AudioBuffer
      const samples: Float32Array[] = [];
      for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        samples.push(new Float32Array(audioBuffer.getChannelData(ch)));
      }

      return { samples, sampleRate: audioBuffer.sampleRate };
    } catch (error) {
      console.error("Error decoding FLAC data:", error);
      return null;
    }
  }

  // ========================================
  // Opus - Native WebCodecs Decoder
  // ========================================

  private async initWebCodecsDecoder(format: StreamFormat): Promise<void> {
    const tryConfigureExistingDecoder = (): boolean => {
      if (!this.webCodecsDecoder) return false;

      const matchesFormat =
        !!this.webCodecsFormat &&
        this.webCodecsFormat.sample_rate === format.sample_rate &&
        this.webCodecsFormat.channels === format.channels;

      if (this.webCodecsDecoder.state === "configured" && matchesFormat) {
        return true;
      }

      if (this.webCodecsDecoder.state === "closed") {
        return false;
      }

      try {
        this.webCodecsDecoder.configure({
          codec: "opus",
          sampleRate: format.sample_rate,
          numberOfChannels: format.channels,
        });
        this.webCodecsFormat = format;
        return true;
      } catch {
        return false;
      }
    };

    if (tryConfigureExistingDecoder()) {
      return;
    }

    if (this.webCodecsDecoderReady) {
      await this.webCodecsDecoderReady;
      if (tryConfigureExistingDecoder()) {
        return;
      }

      try {
        this.webCodecsDecoder?.close();
      } catch {
        // Ignore close errors; we'll recreate below.
      }
      this.webCodecsDecoder = null;
      this.webCodecsDecoderReady = null;
      this.webCodecsFormat = null;
    }

    if (this.webCodecsDecoderReady) {
      await this.webCodecsDecoderReady;
      return;
    }

    this.webCodecsDecoderReady = this.createWebCodecsDecoder(format);
    await this.webCodecsDecoderReady;
  }

  private async createWebCodecsDecoder(format: StreamFormat): Promise<void> {
    if (typeof AudioDecoder === "undefined") {
      this.useNativeOpus = false;
      return;
    }

    try {
      const support = await AudioDecoder.isConfigSupported({
        codec: "opus",
        sampleRate: format.sample_rate,
        numberOfChannels: format.channels,
      });

      if (!support.supported) {
        console.log(
          "[NativeOpus] WebCodecs Opus not supported, will use fallback",
        );
        this.useNativeOpus = false;
        return;
      }

      this.webCodecsDecoder = new AudioDecoder({
        output: (audioData: AudioData) => this.handleAudioData(audioData),
        error: (error: Error) => {
          console.error("[NativeOpus] WebCodecs decoder error:", error);
        },
      });

      this.webCodecsDecoder.configure({
        codec: "opus",
        sampleRate: format.sample_rate,
        numberOfChannels: format.channels,
      });

      this.webCodecsFormat = format;
      console.log(
        `[NativeOpus] Using WebCodecs AudioDecoder: ${format.sample_rate}Hz, ${format.channels}ch`,
      );
    } catch (error) {
      console.warn(
        "[NativeOpus] WebCodecs init failed, will use fallback:",
        error,
      );
      this.useNativeOpus = false;
    }
  }

  // Handle decoded audio data from native Opus decoder
  private handleAudioData(audioData: AudioData): void {
    try {
      const outputTimestampUs = Number(audioData.timestamp);
      const metadata = this.nativeDecoderQueue.shift();

      if (!metadata) {
        console.warn(
          `[NativeOpus] Dropping frame with empty decode queue (out ts=${outputTimestampUs})`,
        );
        audioData.close();
        return;
      }

      const { serverTimeUs, generation } = metadata;
      if (generation !== this.currentGeneration()) {
        console.warn(
          `[NativeOpus] Dropping old-stream frame (ts=${serverTimeUs}, gen=${generation} != current=${this.currentGeneration()})`,
        );
        audioData.close();
        return;
      }

      const channels = audioData.numberOfChannels;
      const frames = audioData.numberOfFrames;
      const fmt = audioData.format;

      let interleaved: Float32Array;

      if (fmt === "f32-planar") {
        interleaved = new Float32Array(frames * channels);
        for (let ch = 0; ch < channels; ch++) {
          const channelData = new Float32Array(frames);
          audioData.copyTo(channelData, { planeIndex: ch });
          for (let i = 0; i < frames; i++) {
            interleaved[i * channels + ch] = channelData[i];
          }
        }
      } else if (fmt === "f32") {
        interleaved = new Float32Array(frames * channels);
        audioData.copyTo(interleaved, { planeIndex: 0 });
      } else if (fmt === "s16-planar") {
        interleaved = new Float32Array(frames * channels);
        for (let ch = 0; ch < channels; ch++) {
          const channelData = new Int16Array(frames);
          audioData.copyTo(channelData, { planeIndex: ch });
          for (let i = 0; i < frames; i++) {
            interleaved[i * channels + ch] = channelData[i] / 32768.0;
          }
        }
      } else if (fmt === "s16") {
        const int16Data = new Int16Array(frames * channels);
        audioData.copyTo(int16Data, { planeIndex: 0 });
        interleaved = new Float32Array(frames * channels);
        for (let i = 0; i < frames * channels; i++) {
          interleaved[i] = int16Data[i] / 32768.0;
        }
      } else {
        console.warn(`[NativeOpus] Unsupported AudioData format: ${fmt}`);
        audioData.close();
        return;
      }

      this.emitDeinterleavedChunk(
        interleaved,
        serverTimeUs,
        channels,
        generation,
      );
      audioData.close();
    } catch (e) {
      console.error("[NativeOpus] Error in output callback:", e);
      audioData.close();
    }
  }

  private emitDeinterleavedChunk(
    interleaved: Float32Array,
    serverTimeUs: number,
    channels: number,
    generation: number,
  ): void {
    if (!this.webCodecsFormat) return;

    const numFrames = interleaved.length / channels;
    const samples: Float32Array[] = [];

    for (let ch = 0; ch < channels; ch++) {
      const channelData = new Float32Array(numFrames);
      for (let i = 0; i < numFrames; i++) {
        channelData[i] = interleaved[i * channels + ch];
      }
      samples.push(channelData);
    }

    this.onDecodedChunk({
      samples,
      sampleRate: this.webCodecsFormat.sample_rate,
      serverTimeUs,
      generation,
    });
  }

  private queueToNativeOpusDecoder(
    audioData: ArrayBuffer,
    serverTimeUs: number,
    generation: number,
  ): boolean {
    if (
      !this.webCodecsDecoder ||
      this.webCodecsDecoder.state !== "configured"
    ) {
      return false;
    }

    try {
      this.nativeDecoderQueue.push({
        serverTimeUs,
        generation,
      });

      const chunk = new EncodedAudioChunk({
        type: "key",
        timestamp: serverTimeUs,
        data: audioData,
      });

      this.webCodecsDecoder.decode(chunk);
      return true;
    } catch (error) {
      if (this.nativeDecoderQueue.length > 0) {
        this.nativeDecoderQueue.pop();
      }
      console.error("[NativeOpus] WebCodecs queue error:", error);
      return false;
    }
  }

  // ========================================
  // Opus - Fallback (opus-encdec library)
  // ========================================

  private resolveOpusDecoderModule(moduleExport: any): any {
    const maybeDefault = moduleExport?.default;
    const maybeCommonJs = moduleExport?.["module.exports"];
    const resolved = maybeDefault ?? maybeCommonJs ?? moduleExport;

    if (!resolved || typeof resolved !== "object") {
      throw new Error("[Opus] Invalid libopus decoder module export");
    }
    return resolved;
  }

  private resolveOggOpusDecoderClass(wrapperExport: any): any {
    const maybeDefault = wrapperExport?.default;
    const maybeCommonJs = wrapperExport?.["module.exports"];
    const wrapper = maybeDefault ?? maybeCommonJs ?? wrapperExport;
    const resolved = wrapper?.OggOpusDecoder ?? wrapper;

    if (typeof resolved !== "function") {
      throw new Error("[Opus] OggOpusDecoder class export not found");
    }
    return resolved;
  }

  private async waitForOpusReady(target: {
    isReady: boolean;
    onready?: () => void;
  }): Promise<void> {
    if (target.isReady) return;

    if (Object.isExtensible(target)) {
      await new Promise<void>((resolve) => {
        target.onready = () => resolve();
      });
      return;
    }

    while (!target.isReady) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }

  private async initOpusEncdecDecoder(format: StreamFormat): Promise<void> {
    if (this.opusDecoderReady) {
      await this.opusDecoderReady;
      return;
    }

    this.opusDecoderReady = (async () => {
      console.log("[Opus] Initializing decoder (opus-encdec)...");

      const [DecoderModuleExport, DecoderWrapperExport] = await Promise.all([
        import("opus-encdec/dist/libopus-decoder.js"),
        import("opus-encdec/src/oggOpusDecoder.js"),
      ]);

      this.opusDecoderModule =
        this.resolveOpusDecoderModule(DecoderModuleExport);

      const OggOpusDecoderClass =
        this.resolveOggOpusDecoderClass(DecoderWrapperExport);

      await this.waitForOpusReady(this.opusDecoderModule);

      this.opusDecoder = new OggOpusDecoderClass(
        {
          rawOpus: true,
          decoderSampleRate: format.sample_rate,
          outputBufferSampleRate: format.sample_rate,
          numberOfChannels: format.channels,
        },
        this.opusDecoderModule,
      );

      await this.waitForOpusReady(this.opusDecoder);

      console.log("[Opus] Decoder ready");
    })();

    await this.opusDecoderReady;
  }

  private async decodeOpusWithEncdec(
    audioData: ArrayBuffer,
    format: StreamFormat,
  ): Promise<{ samples: Float32Array[]; sampleRate: number } | null> {
    try {
      await this.initOpusEncdecDecoder(format);

      const uint8Array = new Uint8Array(audioData);
      const decodedSamples: Float32Array[] = [];

      this.opusDecoder.decodeRaw(uint8Array, (samples: Float32Array) => {
        decodedSamples.push(new Float32Array(samples));
      });

      if (decodedSamples.length === 0) {
        console.warn("[Opus] Fallback decoder produced no samples");
        return null;
      }

      // Convert interleaved samples to per-channel arrays
      const interleavedSamples = decodedSamples[0];
      const numFrames = interleavedSamples.length / format.channels;
      const samples: Float32Array[] = [];

      for (let ch = 0; ch < format.channels; ch++) {
        const channelData = new Float32Array(numFrames);
        for (let i = 0; i < numFrames; i++) {
          channelData[i] = interleavedSamples[i * format.channels + ch];
        }
        samples.push(channelData);
      }

      return { samples, sampleRate: format.sample_rate };
    } catch (error) {
      console.error("[Opus] Decode error:", error);
      return null;
    }
  }

  // ========================================
  // Lifecycle
  // ========================================

  /** Clear decoder state (on stream change/clear). Drops in-flight async decodes. */
  clearState(): void {
    this.nativeDecoderQueue = [];
    try {
      this.webCodecsDecoder?.close();
    } catch {
      // Ignore close errors
    }
    this.webCodecsDecoder = null;
    this.webCodecsDecoderReady = null;
    this.webCodecsFormat = null;
  }

  /** Full cleanup (on disconnect). Releases all decoder resources. */
  close(): void {
    this.clearState();

    if (this.opusDecoder) {
      this.opusDecoder = null;
      this.opusDecoderModule = null;
      this.opusDecoderReady = null;
    }

    // Reset native Opus flag for next session
    this.useNativeOpus = true;

    this.flacDecodingContext = null;
    this.flacDecodingContextSampleRate = 0;
  }
}
