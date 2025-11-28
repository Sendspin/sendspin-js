import type { AudioBufferQueueItem, StreamFormat, AudioOutputMode } from "./types";
import type { StateManager } from "./state-manager";
import type { ResonateTimeFilter } from "./time-filter";

export class AudioProcessor {
  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private streamDestination: MediaStreamAudioDestinationNode | null = null;
  private audioBufferQueue: AudioBufferQueueItem[] = [];
  private scheduledSources: AudioBufferSourceNode[] = [];
  private queueProcessTimeout: number | null = null;

  // Seamless playback tracking
  private nextPlaybackTime: number = 0;  // AudioContext time when next chunk should start
  private lastScheduledServerTime: number = 0;  // Server timestamp of last scheduled chunk end

  constructor(
    private stateManager: StateManager,
    private timeFilter: ResonateTimeFilter,
    private outputMode: AudioOutputMode = "direct",
    private audioElement?: HTMLAudioElement,
    private isAndroid: boolean = false,
    private silentAudioSrc?: string,
    private syncDelayMs: number = 0,
  ) {}

  // Update sync delay at runtime
  setSyncDelay(delayMs: number): void {
    this.syncDelayMs = delayMs;
    // Reset seamless playback tracking to force resync with new delay
    this.nextPlaybackTime = 0;
    this.lastScheduledServerTime = 0;
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
          console.warn("Resonate: Audio autoplay blocked:", e);
        });
      } else {
        // iOS/Desktop: Use MediaStream approach for background playback
        // Create MediaStreamDestination to bridge Web Audio API to HTML5 audio element
        this.streamDestination = this.audioContext.createMediaStreamDestination();
        this.gainNode.connect(this.streamDestination);
        // Do NOT connect to audioContext.destination to avoid echo

        // Connect to HTML5 audio element for iOS background playback
        this.audioElement.srcObject = this.streamDestination.stream;
        this.audioElement.volume = 1.0;
        // Start playing to activate MediaSession
        this.audioElement.play().catch((e) => {
          console.warn("Resonate: Audio autoplay blocked:", e);
        });
      }
    }

    this.updateVolume();
  }

  // Resume AudioContext if suspended (required for browser autoplay policies)
  async resumeAudioContext(): Promise<void> {
    if (this.audioContext && this.audioContext.state === "suspended") {
      await this.audioContext.resume();
      console.log("Resonate: AudioContext resumed");
    }
  }

  // Update volume based on current state
  updateVolume(): void {
    if (!this.gainNode) return;

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
      if (format.codec === "opus" || format.codec === "flac") {
        // Opus and FLAC can be decoded by the browser's native decoder
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
      console.warn("Resonate: Received audio chunk but no stream format set");
      return;
    }
    if (!this.audioContext) {
      console.warn("Resonate: Received audio chunk but no audio context");
      return;
    }
    if (!this.gainNode) {
      console.warn("Resonate: Received audio chunk but no gain node");
      return;
    }

    // Capture stream generation before async decode
    const generation = this.stateManager.streamGeneration;

    // First byte contains role type and message slot
    // Spec: bits 7-2 identify role type (6 bits), bits 1-0 identify message slot (2 bits)
    const firstByte = new Uint8Array(data)[0];

    // Type 0 is audio chunk (Player role, slot 0)
    if (firstByte === 0) {
      // Next 8 bytes are server timestamp in microseconds (big-endian int64)
      const timestampView = new DataView(data, 1, 8);
      // Read as big-endian int64 and convert to number
      const serverTimeUs = Number(timestampView.getBigInt64(0, false));

      // Rest is audio data
      const audioData = data.slice(9);
      const audioBuffer = await this.decodeAudioData(audioData, format);

      if (audioBuffer) {
        // Check if stream generation changed during async decode
        if (generation !== this.stateManager.streamGeneration) {
          console.log(
            "Resonate: Discarding audio chunk from old stream (generation mismatch)",
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
        console.error("Resonate: Failed to decode audio buffer");
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
          "Resonate: Filtering out audio chunk from old stream during queue processing",
        );
        return false;
      }
      return true;
    });

    // Sort queue by server timestamp to ensure proper ordering
    this.audioBufferQueue.sort((a, b) => a.serverTime - b.serverTime);

    // Don't schedule until time sync is ready
    if (!this.timeFilter.is_synchronized) {
      console.log("Resonate: Waiting for time sync before scheduling audio");
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

      // First chunk or after a gap: calculate from server timestamp
      if (this.nextPlaybackTime === 0 || this.lastScheduledServerTime === 0) {
        // Convert server timestamp to client time using synchronized clock
        const chunkClientTimeUs = this.timeFilter.computeClientTime(
          chunk.serverTime,
        );
        const deltaUs = chunkClientTimeUs - nowUs;
        const deltaSec = deltaUs / 1_000_000;
        playbackTime = audioContextTime + deltaSec + bufferSec + syncDelaySec;
      } else {
        // Subsequent chunks: schedule back-to-back for seamless playback
        // Check if this chunk is contiguous with the last one
        const expectedServerTime = this.lastScheduledServerTime;
        const serverGapUs = chunk.serverTime - expectedServerTime;
        const serverGapSec = serverGapUs / 1_000_000;

        if (Math.abs(serverGapSec) < 0.1) {
          // Chunk is contiguous (within 100ms) - schedule seamlessly
          playbackTime = this.nextPlaybackTime;
        } else {
          // Gap detected in server timestamps - resync from timestamp
          console.log(`Resonate: Gap detected (${serverGapSec.toFixed(3)}s), resyncing`);
          const chunkClientTimeUs = this.timeFilter.computeClientTime(
            chunk.serverTime,
          );
          const deltaUs = chunkClientTimeUs - nowUs;
          const deltaSec = deltaUs / 1_000_000;
          playbackTime = audioContextTime + deltaSec + bufferSec + syncDelaySec;
        }
      }

      // Drop chunks that arrived too late
      if (playbackTime < audioContextTime) {
        console.log("Resonate: Dropping late audio chunk");
        // Reset seamless tracking since we dropped a chunk
        this.nextPlaybackTime = 0;
        this.lastScheduledServerTime = 0;
        continue;
      }

      const source = this.audioContext.createBufferSource();
      source.buffer = chunk.buffer;
      source.connect(this.gainNode);
      source.start(playbackTime);

      // Track for seamless scheduling of next chunk
      this.nextPlaybackTime = playbackTime + chunkDuration;
      this.lastScheduledServerTime = chunk.serverTime + chunkDuration * 1_000_000;

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
          console.warn("Resonate: Failed to start audio element:", e);
        });
      }
    }
    // No-op for direct mode
  }

  // Stop audio element playback (for MediaSession)
  stopAudioElement(): void {
    if (this.outputMode === "media-element" && this.audioElement && !this.isAndroid) {
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
  }

  // Cleanup and close AudioContext
  close(): void {
    this.clearBuffers();

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.gainNode = null;
    this.streamDestination = null;

    // Stop and clear the audio element (only for non-Android media-element mode)
    if (this.outputMode === "media-element" && this.audioElement && !this.isAndroid) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
    }
  }

  // Get AudioContext for external use
  getAudioContext(): AudioContext | null {
    return this.audioContext;
  }
}
