import type {
  AudioBufferQueueItem,
  StreamFormat,
  AudioOutputMode,
} from "./types";
import type { StateManager } from "./state-manager";
import type { SendspinTimeFilter } from "./time-filter";

// Drift correction constants
const CORRECTION_TARGET_SECONDS = 2.0; // Target time to correct any sync error
const MIN_PLAYBACK_RATE = 0.96; // Maximum 4% slowdown
const MAX_PLAYBACK_RATE = 1.04; // Maximum 4% speedup
const HARD_RESYNC_THRESHOLD_MS = 200; // Hard resync only for extreme errors
const SYNC_ERROR_DEADBAND_MS = 0.1; // Don't correct if error < 0.1ms
const SAMPLE_CORRECTION_THRESHOLD_MS = 30; // Use sample manipulation below this
const MAX_SAMPLES_PER_CHUNK = 5; // Max samples to insert/delete per chunk
const OUTPUT_LATENCY_ALPHA = 0.01; // EMA smoothing factor for outputLatency

export class AudioProcessor {
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private streamDestination: MediaStreamAudioDestinationNode | null = null;
  private audioBufferQueue: AudioBufferQueueItem[] = [];
  private scheduledSources: AudioBufferSourceNode[] = [];
  private queueProcessTimeout: number | null = null;

  // Seamless playback tracking
  private nextPlaybackTime: number = 0; // AudioContext time when next chunk should start
  private lastScheduledServerTime: number = 0; // Server timestamp of last scheduled chunk end

  // Sync tracking (for debugging/display)
  private currentSyncErrorMs: number = 0;
  private resyncCount: number = 0;
  private currentPlaybackRate: number = 1.0;

  // Native Opus decoder (uses WebCodecs API)
  private webCodecsDecoder: AudioDecoder | null = null;
  private webCodecsDecoderReady: Promise<void> | null = null;
  private webCodecsFormat: StreamFormat | null = null;
  private useNativeOpus: boolean = true; // false when WebCodecs unavailable

  // Fallback Opus decoder (opus-encdec library)
  private opusDecoder: any = null;
  private opusDecoderModule: any = null;
  private opusDecoderReady: Promise<void> | null = null;

  constructor(
    private stateManager: StateManager,
    private timeFilter: SendspinTimeFilter,
    private outputMode: AudioOutputMode = "direct",
    private audioElement?: HTMLAudioElement,
    private isAndroid: boolean = false,
    private silentAudioSrc?: string,
    private syncDelayMs: number = 0,
    private useHardwareVolume: boolean = false,
  ) {}

  // Update sync delay at runtime
  setSyncDelay(delayMs: number): void {
    this.syncDelayMs = delayMs;
    // Reset seamless playback tracking to force resync with new delay
    this.nextPlaybackTime = 0;
    this.lastScheduledServerTime = 0;
  }

  // Get current sync info for debugging/display
  get syncInfo(): {
    clockDriftPercent: number;
    syncErrorMs: number;
    resyncCount: number;
    outputLatencyMs: number;
    playbackRate: number;
  } {
    return {
      clockDriftPercent: this.timeFilter.drift * 100,
      syncErrorMs: this.currentSyncErrorMs,
      resyncCount: this.resyncCount,
      outputLatencyMs: this.getRawOutputLatencyUs() / 1000,
      playbackRate: this.currentPlaybackRate,
    };
  }

  // Get raw output latency in microseconds (for Kalman filter input)
  getRawOutputLatencyUs(): number {
    if (!this.audioContext) return 0;
    const baseLatency = this.audioContext.baseLatency ?? 0;
    const outputLatency = this.audioContext.outputLatency ?? 0;
    return (baseLatency + outputLatency) * 1_000_000; // Convert seconds to microseconds
  }

  // Initialize AudioContext with platform-specific setup
  initAudioContext(): void {
    if (this.audioContext) {
      return; // Already initialized
    }

    const streamSampleRate =
      this.stateManager.currentStreamFormat?.sample_rate || 48000;
    this.audioContext = new AudioContext({ sampleRate: streamSampleRate });
    this.gainNode = this.audioContext.createGain();

    if (this.outputMode === "direct") {
      // Direct output to audioContext.destination (e.g., Cast receiver)
      this.gainNode.connect(this.audioContext.destination);
    } else if (this.outputMode === "media-element" && this.audioElement) {
      if (this.isAndroid && this.silentAudioSrc) {
        // Android MediaSession workaround: Play almost-silent audio file
        // Android browsers don't support MediaSession with MediaStream from Web Audio API
        // Solution: Loop almost-silent audio to keep MediaSession active
        // Real audio plays through Web Audio API → audioContext.destination
        this.gainNode.connect(this.audioContext.destination);

        // Use almost-silent audio file to trick Android into showing MediaSession
        this.audioElement.src = this.silentAudioSrc;
        this.audioElement.loop = true;
        // CRITICAL: Do NOT mute - Android requires audible audio for MediaSession
        this.audioElement.muted = false;
        // Set volume to 100% (the file itself is almost silent)
        this.audioElement.volume = 1.0;
        // Start playing to activate MediaSession
        this.audioElement.play().catch((e) => {
          console.warn("Sendspin: Audio autoplay blocked:", e);
        });
      } else {
        // iOS/Desktop: Use MediaStream approach for background playback
        // Create MediaStreamDestination to bridge Web Audio API to HTML5 audio element
        this.streamDestination =
          this.audioContext.createMediaStreamDestination();
        this.gainNode.connect(this.streamDestination);
        // Do NOT connect to audioContext.destination to avoid echo

        // Connect to HTML5 audio element for iOS background playback
        this.audioElement.srcObject = this.streamDestination.stream;
        this.audioElement.volume = 1.0;
        // Start playing to activate MediaSession
        this.audioElement.play().catch((e) => {
          console.warn("Sendspin: Audio autoplay blocked:", e);
        });
      }
    }

    this.updateVolume();
  }

  // Resume AudioContext if suspended (required for browser autoplay policies)
  async resumeAudioContext(): Promise<void> {
    if (this.audioContext && this.audioContext.state === "suspended") {
      await this.audioContext.resume();
      console.log("Sendspin: AudioContext resumed");
    }
  }

  // Update volume based on current state
  updateVolume(): void {
    if (!this.gainNode) return;

    // Hardware volume mode: keep software gain at 1.0, external handles volume
    if (this.useHardwareVolume) {
      this.gainNode.gain.value = 1.0;
      return;
    }

    if (this.stateManager.muted) {
      this.gainNode.gain.value = 0;
    } else {
      this.gainNode.gain.value = this.stateManager.volume / 100;
    }
  }

  // Decode audio data based on codec
  async decodeAudioData(
    audioData: ArrayBuffer,
    format: StreamFormat,
  ): Promise<AudioBuffer | null> {
    if (!this.audioContext) return null;

    try {
      if (format.codec === "opus") {
        // Opus fallback path - native decoder uses async queueToNativeOpusDecoder
        return await this.decodeOpusWithEncdec(audioData, format);
      } else if (format.codec === "flac") {
        // FLAC can be decoded by the browser's native decoder
        // If codec_header is provided, prepend it to the audio data
        let dataToEncode = audioData;
        if (format.codec_header) {
          // Decode Base64 codec header
          const headerBytes = Uint8Array.from(atob(format.codec_header), (c) =>
            c.charCodeAt(0),
          );
          // Concatenate header + audio data
          const combined = new Uint8Array(
            headerBytes.length + audioData.byteLength,
          );
          combined.set(headerBytes, 0);
          combined.set(new Uint8Array(audioData), headerBytes.length);
          dataToEncode = combined.buffer;
        }
        return await this.audioContext.decodeAudioData(dataToEncode);
      } else if (format.codec === "pcm") {
        // PCM data needs manual decoding
        return this.decodePCMData(audioData, format);
      }
    } catch (error) {
      console.error("Error decoding audio data:", error);
    }

    return null;
  }

  // Initialize native Opus decoder
  private async initWebCodecsDecoder(format: StreamFormat): Promise<void> {
    if (this.webCodecsDecoderReady) {
      await this.webCodecsDecoderReady;
      return;
    }

    this.webCodecsDecoderReady = this.createWebCodecsDecoder(format);
    await this.webCodecsDecoderReady;
  }

  // Create and configure native Opus decoder (WebCodecs)
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

      const serverTimeUs = Number(audioData.timestamp);
      this.handleNativeOpusOutput(interleaved, serverTimeUs, channels);
      audioData.close();
    } catch (e) {
      console.error("[NativeOpus] Error in output callback:", e);
      audioData.close();
    }
  }

  // Initialize opus-encdec decoder (fallback when WebCodecs unavailable)
  private async initOpusEncdecDecoder(format: StreamFormat): Promise<void> {
    if (this.opusDecoderReady) {
      await this.opusDecoderReady;
      return;
    }

    this.opusDecoderReady = (async () => {
      console.log("[Opus] Initializing decoder (opus-encdec)...");

      // Dynamically import the pure JavaScript decoder (not WASM) to avoid bundling issues
      const [DecoderModuleExport, DecoderWrapperExport] = await Promise.all([
        import("opus-encdec/dist/libopus-decoder.js"),
        import("opus-encdec/src/oggOpusDecoder.js"),
      ]);

      // The UMD module exports the Module object directly (as default in ES6 modules)
      this.opusDecoderModule =
        DecoderModuleExport.default || DecoderModuleExport;

      // The OggOpusDecoder is exported as default.OggOpusDecoder
      const decoderWrapper =
        (DecoderWrapperExport as any).default || DecoderWrapperExport;
      const OggOpusDecoderClass =
        decoderWrapper.OggOpusDecoder || decoderWrapper;

      // Wait for Module to be ready (async asm.js initialization)
      if (!this.opusDecoderModule.isReady) {
        await new Promise<void>((resolve) => {
          this.opusDecoderModule.onready = () => resolve();
        });
      }

      // Create decoder instance
      this.opusDecoder = new OggOpusDecoderClass(
        {
          rawOpus: true, // We're decoding raw Opus packets, not Ogg containers
          decoderSampleRate: format.sample_rate,
          outputBufferSampleRate: format.sample_rate,
          numberOfChannels: format.channels,
        },
        this.opusDecoderModule,
      );

      // Wait for decoder to be ready if needed
      if (!this.opusDecoder.isReady) {
        await new Promise<void>((resolve) => {
          this.opusDecoder.onready = () => resolve();
        });
      }

      console.log("[Opus] Decoder ready");
    })();

    await this.opusDecoderReady;
  }

  // Handle native Opus decoder output - creates AudioBuffer and adds to queue
  private handleNativeOpusOutput(
    interleaved: Float32Array,
    serverTimeUs: number,
    channels: number,
  ): void {
    if (!this.audioContext || !this.webCodecsFormat) {
      return;
    }

    const numFrames = interleaved.length / channels;
    const audioBuffer = this.audioContext.createBuffer(
      channels,
      numFrames,
      this.webCodecsFormat.sample_rate,
    );

    // De-interleave samples into separate channels
    for (let ch = 0; ch < channels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < numFrames; i++) {
        channelData[i] = interleaved[i * channels + ch];
      }
    }

    // Add to queue directly
    this.audioBufferQueue.push({
      buffer: audioBuffer,
      serverTime: serverTimeUs,
      generation: this.stateManager.streamGeneration,
    });

    // Trigger queue processing (debounced)
    if (this.queueProcessTimeout !== null) {
      clearTimeout(this.queueProcessTimeout);
    }
    this.queueProcessTimeout = window.setTimeout(() => {
      this.processAudioQueue();
      this.queueProcessTimeout = null;
    }, 50);
  }

  // Queue Opus packet to native decoder for async decoding (non-blocking)
  private queueToNativeOpusDecoder(
    audioData: ArrayBuffer,
    serverTimeUs: number,
  ): boolean {
    if (
      !this.webCodecsDecoder ||
      this.webCodecsDecoder.state !== "configured"
    ) {
      return false;
    }

    try {
      // Create EncodedAudioChunk - use timestamp to pass server time through
      const chunk = new EncodedAudioChunk({
        type: "key", // Opus packets are self-contained
        timestamp: serverTimeUs, // Pass server timestamp through to output callback
        data: audioData,
      });

      // Queue for async decoding (non-blocking)
      this.webCodecsDecoder.decode(chunk);
      return true;
    } catch (error) {
      console.error("[NativeOpus] WebCodecs queue error:", error);
      return false;
    }
  }

  // Decode using opus-encdec library (fallback)
  private async decodeOpusWithEncdec(
    audioData: ArrayBuffer,
    format: StreamFormat,
  ): Promise<AudioBuffer | null> {
    if (!this.audioContext) {
      return null;
    }

    try {
      // Initialize fallback decoder if needed
      await this.initOpusEncdecDecoder(format);

      // Decode the raw Opus packet
      const uint8Array = new Uint8Array(audioData);
      const decodedSamples: Float32Array[] = [];

      this.opusDecoder.decodeRaw(uint8Array, (samples: Float32Array) => {
        // Copy samples since they're from WASM heap
        decodedSamples.push(new Float32Array(samples));
      });

      if (decodedSamples.length === 0) {
        console.warn("[Opus] Fallback decoder produced no samples");
        return null;
      }

      // Convert interleaved samples to AudioBuffer
      const interleavedSamples = decodedSamples[0];
      const numFrames = interleavedSamples.length / format.channels;

      const audioBuffer = this.audioContext.createBuffer(
        format.channels,
        numFrames,
        format.sample_rate,
      );

      // De-interleave samples into separate channels
      for (let ch = 0; ch < format.channels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        for (let i = 0; i < numFrames; i++) {
          channelData[i] = interleavedSamples[i * format.channels + ch];
        }
      }

      return audioBuffer;
    } catch (error) {
      console.error("[Opus] Decode error:", error);
      return null;
    }
  }

  // Decode PCM audio data
  private decodePCMData(
    audioData: ArrayBuffer,
    format: StreamFormat,
  ): AudioBuffer | null {
    if (!this.audioContext) return null;

    const bytesPerSample = (format.bit_depth || 16) / 8;
    const dataView = new DataView(audioData);
    const numSamples =
      audioData.byteLength / (bytesPerSample * format.channels);

    const audioBuffer = this.audioContext.createBuffer(
      format.channels,
      numSamples,
      format.sample_rate,
    );

    // Decode PCM data (interleaved format)
    for (let channel = 0; channel < format.channels; channel++) {
      const channelData = audioBuffer.getChannelData(channel);
      for (let i = 0; i < numSamples; i++) {
        const offset = (i * format.channels + channel) * bytesPerSample;
        let sample = 0;

        if (format.bit_depth === 16) {
          sample = dataView.getInt16(offset, true) / 32768.0;
        } else if (format.bit_depth === 24) {
          // 24-bit is stored in 3 bytes (little-endian)
          const byte1 = dataView.getUint8(offset);
          const byte2 = dataView.getUint8(offset + 1);
          const byte3 = dataView.getUint8(offset + 2);
          // Reconstruct as signed 24-bit value
          let int24 = (byte3 << 16) | (byte2 << 8) | byte1;
          // Sign extend if necessary
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

    return audioBuffer;
  }

  // Handle binary audio message
  async handleBinaryMessage(data: ArrayBuffer): Promise<void> {
    const format = this.stateManager.currentStreamFormat;
    if (!format) {
      console.warn("Sendspin: Received audio chunk but no stream format set");
      return;
    }
    if (!this.audioContext) {
      console.warn("Sendspin: Received audio chunk but no audio context");
      return;
    }
    if (!this.gainNode) {
      console.warn("Sendspin: Received audio chunk but no gain node");
      return;
    }

    // Capture stream generation before async decode
    const generation = this.stateManager.streamGeneration;

    // First byte contains role type and message slot
    // Spec: bits 7-2 identify role type (6 bits), bits 1-0 identify message slot (2 bits)
    const firstByte = new Uint8Array(data)[0];

    // Type 4 is audio chunk (Player role, slot 0) - IDs 4-7 are player role
    if (firstByte === 4) {
      // Next 8 bytes are server timestamp in microseconds (big-endian int64)
      const timestampView = new DataView(data, 1, 8);
      // Read as big-endian int64 and convert to number
      const serverTimeUs = Number(timestampView.getBigInt64(0, false));

      // Rest is audio data
      const audioData = data.slice(9);

      // For Opus: use native decoder (non-blocking async path)
      if (format.codec === "opus" && this.useNativeOpus) {
        await this.initWebCodecsDecoder(format);

        if (this.useNativeOpus && this.webCodecsDecoder) {
          if (this.queueToNativeOpusDecoder(audioData, serverTimeUs)) {
            return; // Async path - callback handles queue
          }
          // Fall through to fallback on error
        }
      }

      // Fallback decode path (PCM, FLAC, or Opus via opus-encdec)
      const audioBuffer = await this.decodeAudioData(audioData, format);

      if (audioBuffer) {
        // Check if stream generation changed during async decode
        if (generation !== this.stateManager.streamGeneration) {
          console.log(
            "Sendspin: Discarding audio chunk from old stream (generation mismatch)",
          );
          return;
        }

        // Add to queue for ordered playback
        this.audioBufferQueue.push({
          buffer: audioBuffer,
          serverTime: serverTimeUs,
          generation: generation,
        });

        // Debounce queue processing to allow multiple chunks to arrive
        // This handles out-of-order arrivals from async FLAC decoding
        if (this.queueProcessTimeout !== null) {
          clearTimeout(this.queueProcessTimeout);
        }
        this.queueProcessTimeout = window.setTimeout(() => {
          this.processAudioQueue();
          this.queueProcessTimeout = null;
        }, 50); // 50ms debounce - collect a larger batch before scheduling
      } else {
        console.error("Sendspin: Failed to decode audio buffer");
      }
    }
  }

  // Process the audio queue and schedule chunks in order
  processAudioQueue(): void {
    if (!this.audioContext || !this.gainNode) return;

    // Filter out any chunks from old streams (safety check)
    const currentGeneration = this.stateManager.streamGeneration;
    this.audioBufferQueue = this.audioBufferQueue.filter((chunk) => {
      if (chunk.generation !== currentGeneration) {
        console.log(
          "Sendspin: Filtering out audio chunk from old stream during queue processing",
        );
        return false;
      }
      return true;
    });

    // Sort queue by server timestamp to ensure proper ordering
    this.audioBufferQueue.sort((a, b) => a.serverTime - b.serverTime);

    // Don't schedule until time sync is ready
    if (!this.timeFilter.is_synchronized) {
      console.log("Sendspin: Waiting for time sync before scheduling audio");
      return;
    }

    const audioContextTime = this.audioContext.currentTime;
    const nowUs = performance.now() * 1000;

    // Buffer to add for scheduling headroom (200ms)
    const bufferSec = 0.2;

    // Convert sync delay from ms to seconds (positive = delay, negative = advance)
    const syncDelaySec = this.syncDelayMs / 1000;

    // Schedule all chunks in the queue
    while (this.audioBufferQueue.length > 0) {
      const chunk = this.audioBufferQueue.shift()!;
      const chunkDuration = chunk.buffer.duration;

      let playbackTime: number;
      let playbackRate: number;

      // Always compute the drift-corrected target time
      const chunkClientTimeUs = this.timeFilter.computeClientTime(
        chunk.serverTime,
      );
      const deltaUs = chunkClientTimeUs - nowUs;
      const deltaSec = deltaUs / 1_000_000;
      const targetPlaybackTime =
        audioContextTime + deltaSec + bufferSec + syncDelaySec;

      // First chunk or after a gap: calculate from server timestamp
      if (this.nextPlaybackTime === 0 || this.lastScheduledServerTime === 0) {
        playbackTime = targetPlaybackTime;
        playbackRate = 1.0;
      } else {
        // Subsequent chunks: schedule back-to-back for seamless playback
        // Check if this chunk is contiguous with the last one
        const expectedServerTime = this.lastScheduledServerTime;
        const serverGapUs = chunk.serverTime - expectedServerTime;
        const serverGapSec = serverGapUs / 1_000_000;

        if (Math.abs(serverGapSec) < 0.1) {
          // Chunk is contiguous (within 100ms)
          // Calculate sync error (positive = behind target, negative = ahead)
          const syncErrorSec = this.nextPlaybackTime - targetPlaybackTime;
          const syncErrorMs = syncErrorSec * 1000;

          // Store for display
          this.currentSyncErrorMs = syncErrorMs;

          if (Math.abs(syncErrorMs) > HARD_RESYNC_THRESHOLD_MS) {
            // Hard resync if sync error exceeds threshold
            console.log(
              `Sendspin: Sync error ${syncErrorMs.toFixed(1)}ms, hard resyncing`,
            );
            this.resyncCount++;
            playbackTime = targetPlaybackTime;
            playbackRate = 1.0;
          } else {
            // Continuous smooth correction via playback rate
            playbackTime = this.nextPlaybackTime;

            // Don't correct too small errors
            if (Math.abs(syncErrorMs) < SYNC_ERROR_DEADBAND_MS) {
              playbackRate = 1.0;
            } else {
              // Rate adjustment: spread correction over target time window
              // Positive syncError = behind target, need to speed up
              const rateAdjustment = syncErrorSec / CORRECTION_TARGET_SECONDS;
              playbackRate = 1.0 + rateAdjustment;
              playbackRate = Math.max(
                MIN_PLAYBACK_RATE,
                Math.min(MAX_PLAYBACK_RATE, playbackRate),
              );
            }
          }
        } else {
          // Gap detected in server timestamps - hard resync
          console.log(
            `Sendspin: Gap detected (${serverGapSec.toFixed(3)}s), resyncing`,
          );
          this.resyncCount++;
          playbackTime = targetPlaybackTime;
          playbackRate = 1.0;
        }
      }

      // Track current rate for debugging
      this.currentPlaybackRate = playbackRate;

      // Drop chunks that arrived too late
      if (playbackTime < audioContextTime) {
        console.log("Sendspin: Dropping late audio chunk");
        // Reset seamless tracking since we dropped a chunk
        this.nextPlaybackTime = 0;
        this.lastScheduledServerTime = 0;
        continue;
      }

      const source = this.audioContext.createBufferSource();
      source.buffer = chunk.buffer;
      source.playbackRate.value = playbackRate; // Apply drift correction
      source.connect(this.gainNode);
      source.start(playbackTime);

      // Track for seamless scheduling of next chunk
      // Account for actual duration with playback rate adjustment
      const actualDuration = chunkDuration / playbackRate;
      this.nextPlaybackTime = playbackTime + actualDuration;
      this.lastScheduledServerTime =
        chunk.serverTime + chunkDuration * 1_000_000;

      this.scheduledSources.push(source);
      source.onended = () => {
        const idx = this.scheduledSources.indexOf(source);
        if (idx > -1) this.scheduledSources.splice(idx, 1);
      };
    }
  }

  // Start audio element playback (for MediaSession)
  startAudioElement(): void {
    if (this.outputMode === "media-element" && this.audioElement) {
      if (this.audioElement.paused) {
        this.audioElement.play().catch((e) => {
          console.warn("Sendspin: Failed to start audio element:", e);
        });
      }
    }
    // No-op for direct mode
  }

  // Stop audio element playback (for MediaSession)
  stopAudioElement(): void {
    if (
      this.outputMode === "media-element" &&
      this.audioElement &&
      !this.isAndroid
    ) {
      if (!this.audioElement.paused) {
        this.audioElement.pause();
      }
    }
    // No-op for direct mode or Android
  }

  // Clear all audio buffers and scheduled sources
  clearBuffers(): void {
    // Stop all scheduled audio sources
    this.scheduledSources.forEach((source) => {
      try {
        source.stop();
      } catch (e) {
        // Ignore errors if source already stopped
      }
    });
    this.scheduledSources = [];

    // Clear pending queue processing
    if (this.queueProcessTimeout !== null) {
      clearTimeout(this.queueProcessTimeout);
      this.queueProcessTimeout = null;
    }

    // Clear buffers
    this.audioBufferQueue = [];

    // Reset stream anchors
    this.stateManager.resetStreamAnchors();

    // Reset seamless playback tracking
    this.nextPlaybackTime = 0;
    this.lastScheduledServerTime = 0;

    // Reset sync stats
    this.currentSyncErrorMs = 0;
    this.resyncCount = 0;
    this.currentPlaybackRate = 1.0;
  }

  // Cleanup and close AudioContext
  close(): void {
    this.clearBuffers();

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    // Clean up native Opus decoder
    if (this.webCodecsDecoder) {
      try {
        this.webCodecsDecoder.close();
      } catch (e) {
        // Ignore if already closed
      }
      this.webCodecsDecoder = null;
      this.webCodecsDecoderReady = null;
      this.webCodecsFormat = null;
    }

    // Clean up fallback Opus decoder
    if (this.opusDecoder) {
      this.opusDecoder = null;
      this.opusDecoderModule = null;
      this.opusDecoderReady = null;
    }

    // Reset native Opus flag for next session
    this.useNativeOpus = true;

    this.gainNode = null;
    this.streamDestination = null;

    // Stop and clear the audio element (only for non-Android media-element mode)
    if (
      this.outputMode === "media-element" &&
      this.audioElement &&
      !this.isAndroid
    ) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
    }
  }

  // Get AudioContext for external use
  getAudioContext(): AudioContext | null {
    return this.audioContext;
  }
}
