/**
 * End-to-end tests for SendspinPlayer.
 *
 * These tests only exercise the public API (index.ts) and verify behavior
 * by observing AudioContext interactions and public state.
 *
 * Tests catch real synchronization and playback issues:
 * - Incorrect scheduling would cause stuttering
 * - Out-of-order chunks would cause audio corruption
 * - Drift handling bugs would cause desynchronization
 * - Late chunk handling bugs would cause gaps
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SendspinPlayer } from "../index";
import { MockSendspinServer } from "./mock-server";
import { generateChunkSequence } from "./audio-generator";
import type { StreamFormat } from "../types";

describe("SendspinPlayer E2E", () => {
  let mockServer: MockSendspinServer;
  let player: SendspinPlayer;
  let audioContextSpy: {
    createBufferSource: ReturnType<typeof vi.fn>;
    sources: Array<{
      start: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
      buffer: AudioBuffer | null;
    }>;
  };

  beforeEach(() => {
    // Install mock WebSocket
    mockServer = new MockSendspinServer({
      clockOffsetUs: 5000, // 5ms server ahead
      networkLatencyMs: 10,
    });
    mockServer.install();

    // Spy on AudioContext to observe scheduled audio
    const sources: Array<any> = [];

    const createBufferSourceFn = vi.fn(() => {
      const source = {
        buffer: null as AudioBuffer | null,
        start: vi.fn(),
        connect: vi.fn(),
        onended: null as (() => void) | null,
      };
      sources.push(source);
      return source;
    });

    audioContextSpy = {
      createBufferSource: createBufferSourceFn,
      sources,
    };

    // Override AudioContext
    (globalThis as any).AudioContext = class MockAudioContext {
      sampleRate = 48000;
      currentTime = 0;
      state = "running";
      destination = {};

      createGain() {
        return {
          gain: { value: 1 },
          connect: vi.fn(),
        };
      }

      createBufferSource() {
        return createBufferSourceFn();
      }

      createBuffer(channels: number, length: number, sampleRate: number) {
        // Create a real AudioBuffer-like object
        const buffer = {
          duration: length / sampleRate,
          length,
          numberOfChannels: channels,
          sampleRate,
          getChannelData: (channel: number) => new Float32Array(length),
        };
        return buffer as AudioBuffer;
      }

      createMediaStreamDestination() {
        return {
          stream: {},
          connect: vi.fn(),
        };
      }

      async resume() {}
      async close() {}

      decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
        // Mock PCM decoding - just create a buffer with appropriate duration
        const dataView = new DataView(data);
        const numSamples = data.byteLength / (2 * 2); // 16-bit stereo
        return Promise.resolve(this.createBuffer(2, numSamples, 48000));
      }
    };

    // Don't mock performance.now - use real time for simplicity
    // Tests will just need to wait for actual time to pass
  });

  afterEach(() => {
    if (player) {
      player.disconnect();
    }
    mockServer.close();
    vi.restoreAllMocks();
  });

  /**
   * Helper to establish time synchronization
   * Time sync requires at least 2 measurements to be synchronized
   * Polls until sync is established or timeout
   */
  async function establishTimeSync(): Promise<void> {
    const timeout = 15000; // 15 second timeout
    const pollInterval = 100; // Check every 100ms
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      if (player.timeSyncInfo.synced) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Time sync not established after ${timeout}ms`);
  }

  describe("Connection and Handshake", () => {
    it("should connect and complete handshake", async () => {
      player = new SendspinPlayer({
        playerId: "test-player-1",
        baseUrl: "http://localhost:8095",
        clientName: "Test Player",
      });

      await player.connect();

      // Wait for client/hello to be sent
      await mockServer.waitForMessage("client/hello", 500);

      const hello = mockServer.getLastMessage("client/hello");
      expect(hello).toBeDefined();
      expect(hello.payload.client_id).toBe("test-player-1");
      expect(hello.payload.name).toBe("Test Player");

      // Wait for client/state after server/hello
      await mockServer.waitForMessage("client/state", 500);

      const state = mockServer.getLastMessage("client/state");
      expect(state).toBeDefined();
    });

    it("should report connection status", async () => {
      player = new SendspinPlayer({
        playerId: "test-player-1",
        baseUrl: "http://localhost:8095",
      });

      expect(player.isConnected).toBe(false);

      await player.connect();

      // Give time for WebSocket to open
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(player.isConnected).toBe(true);
    });
  });

  describe("Time Synchronization", () => {
    it("should establish time sync with server", async () => {
      player = new SendspinPlayer({
        playerId: "test-player-1",
        baseUrl: "http://localhost:8095",
      });

      await player.connect();
      await mockServer.waitForMessage("client/hello", 500);
      await establishTimeSync();

      // Check time sync info
      const syncInfo = player.timeSyncInfo;

      // After time sync is established, should be synchronized
      expect(syncInfo.synced).toBe(true);

      // Offset should be close to the configured 5ms
      expect(Math.abs(syncInfo.offset - 5)).toBeLessThan(10);
    });
  });

  describe("Audio Streaming", () => {
    const streamFormat: StreamFormat = {
      codec: "pcm",
      sample_rate: 48000,
      channels: 2,
      bit_depth: 16,
    };

    it("should schedule audio chunks at correct times", async () => {
      player = new SendspinPlayer({
        playerId: "test-player-1",
        baseUrl: "http://localhost:8095",
      });

      await player.connect();
      await mockServer.waitForMessage("client/hello", 500);
      await establishTimeSync();

      // Start stream
      mockServer.sendStreamStart(streamFormat);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(player.isPlaying).toBe(true);

      // Generate and send audio chunks
      const startTimeUs = mockServer.getServerTime() + 500_000; // Start 500ms in future
      const chunks = generateChunkSequence(startTimeUs, 3, {
        durationSec: 0.1, // 100ms chunks
        sampleRate: 48000,
        channels: 2,
        bitDepth: 16,
      });

      // Send all chunks
      for (const chunk of chunks) {
        mockServer.sendAudioChunk(chunk.serverTimeUs, chunk.audioData);
      }

      // Wait for chunks to be processed and scheduled
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify that audio sources were scheduled
      expect(audioContextSpy.sources.length).toBe(3);

      // Verify that chunks were scheduled in order
      const startTimes = audioContextSpy.sources.map((s) => s.start.mock.calls[0]?.[0]);

      expect(startTimes[0]).toBeDefined();
      expect(startTimes[1]).toBeDefined();
      expect(startTimes[2]).toBeDefined();

      // Each chunk should be scheduled after the previous one
      expect(startTimes[1]).toBeGreaterThan(startTimes[0]);
      expect(startTimes[2]).toBeGreaterThan(startTimes[1]);

      // Chunks should be roughly 100ms apart (within 10ms tolerance)
      const gap1 = startTimes[1] - startTimes[0];
      const gap2 = startTimes[2] - startTimes[1];

      expect(Math.abs(gap1 - 0.1)).toBeLessThan(0.01);
      expect(Math.abs(gap2 - 0.1)).toBeLessThan(0.01);
    });

    it("should handle out-of-order chunk arrival", async () => {
      player = new SendspinPlayer({
        playerId: "test-player-1",
        baseUrl: "http://localhost:8095",
      });

      await player.connect();
      await mockServer.waitForMessage("client/hello", 500);
      await establishTimeSync();

      // Start stream
      mockServer.sendStreamStart(streamFormat);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Generate chunks with known timestamps
      const startTimeUs = mockServer.getServerTime() + 500_000;
      const chunks = generateChunkSequence(startTimeUs, 3, {
        durationSec: 0.1,
        sampleRate: 48000,
        channels: 2,
        bitDepth: 16,
      });

      // Send chunks OUT OF ORDER: chunk 2, chunk 0, chunk 1
      mockServer.sendAudioChunk(chunks[2].serverTimeUs, chunks[2].audioData);
      await new Promise((resolve) => setTimeout(resolve, 10));

      mockServer.sendAudioChunk(chunks[0].serverTimeUs, chunks[0].audioData);
      await new Promise((resolve) => setTimeout(resolve, 10));

      mockServer.sendAudioChunk(chunks[1].serverTimeUs, chunks[1].audioData);

      // Wait for all chunks to be processed (queue debounce is 50ms)
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Despite out-of-order arrival, they should be scheduled in correct order
      expect(audioContextSpy.sources.length).toBe(3);

      const startTimes = audioContextSpy.sources.map((s) => s.start.mock.calls[0]?.[0]);

      // Verify temporal ordering is preserved
      expect(startTimes[0]).toBeLessThan(startTimes[1]);
      expect(startTimes[1]).toBeLessThan(startTimes[2]);
    });

    it("should drop late-arriving chunks", async () => {
      player = new SendspinPlayer({
        playerId: "test-player-1",
        baseUrl: "http://localhost:8095",
      });

      await player.connect();
      await mockServer.waitForMessage("client/hello", 500);
      await establishTimeSync();

      // Start stream
      mockServer.sendStreamStart(streamFormat);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send a chunk with timestamp in the PAST
      const pastTimeUs = mockServer.getServerTime() - 1_000_000; // 1 second ago
      const chunk = generateChunkSequence(pastTimeUs, 1, {
        durationSec: 0.1,
        sampleRate: 48000,
        channels: 2,
        bitDepth: 16,
      })[0];

      mockServer.sendAudioChunk(chunk.serverTimeUs, chunk.audioData);

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Late chunk should be dropped, no sources scheduled
      expect(audioContextSpy.sources.length).toBe(0);
    });

    it("should resync on large drift errors", async () => {
      player = new SendspinPlayer({
        playerId: "test-player-1",
        baseUrl: "http://localhost:8095",
      });

      await player.connect();
      await mockServer.waitForMessage("client/hello", 500);
      await establishTimeSync();

      // Start stream
      mockServer.sendStreamStart(streamFormat);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send first chunk
      const startTimeUs = mockServer.getServerTime() + 500_000;
      const chunks = generateChunkSequence(startTimeUs, 1, {
        durationSec: 0.1,
        sampleRate: 48000,
        channels: 2,
        bitDepth: 16,
      });

      mockServer.sendAudioChunk(chunks[0].serverTimeUs, chunks[0].audioData);
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(audioContextSpy.sources.length).toBe(1);
      const initialResyncCount = player.syncInfo.resyncCount;

      // Wait a bit then send second chunk with a gap > 20ms sync error threshold
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Send second chunk with a gap > 20ms sync error threshold
      const chunk2TimeUs = chunks[0].serverTimeUs + 200_000; // 200ms later (larger than first chunk duration)
      const chunk2 = generateChunkSequence(chunk2TimeUs, 1, {
        durationSec: 0.1,
        sampleRate: 48000,
        channels: 2,
        bitDepth: 16,
      })[0];

      mockServer.sendAudioChunk(chunk2.serverTimeUs, chunk2.audioData);
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(audioContextSpy.sources.length).toBe(2);

      // Resync should have been triggered
      expect(player.syncInfo.resyncCount).toBeGreaterThan(initialResyncCount);
    });

    it("should clear buffers on stream clear (seek)", async () => {
      player = new SendspinPlayer({
        playerId: "test-player-1",
        baseUrl: "http://localhost:8095",
      });

      await player.connect();
      await mockServer.waitForMessage("client/hello", 500);
      await establishTimeSync();

      // Start stream
      mockServer.sendStreamStart(streamFormat);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send some chunks
      const startTimeUs = mockServer.getServerTime() + 500_000;
      const chunks = generateChunkSequence(startTimeUs, 2, {
        durationSec: 0.1,
        sampleRate: 48000,
        channels: 2,
        bitDepth: 16,
      });

      for (const chunk of chunks) {
        mockServer.sendAudioChunk(chunk.serverTimeUs, chunk.audioData);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));

      const sourcesBeforeClear = audioContextSpy.sources.length;
      expect(sourcesBeforeClear).toBe(2);

      // Verify sources were started
      for (const source of audioContextSpy.sources) {
        expect(source.start).toHaveBeenCalled();
      }

      // Send stream clear (seek)
      mockServer.sendStreamClear();
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Player should still be playing after clear
      expect(player.isPlaying).toBe(true);

      // Send new chunks after clear
      const newStartTimeUs = mockServer.getServerTime() + 500_000;
      const newChunks = generateChunkSequence(newStartTimeUs, 2, {
        durationSec: 0.1,
        sampleRate: 48000,
        channels: 2,
        bitDepth: 16,
      });

      for (const chunk of newChunks) {
        mockServer.sendAudioChunk(chunk.serverTimeUs, chunk.audioData);
      }
      await new Promise((resolve) => setTimeout(resolve, 150));

      // New chunks should be scheduled
      expect(audioContextSpy.sources.length).toBeGreaterThan(sourcesBeforeClear);
    });

    it("should stop playback on stream end", async () => {
      player = new SendspinPlayer({
        playerId: "test-player-1",
        baseUrl: "http://localhost:8095",
      });

      await player.connect();
      await mockServer.waitForMessage("client/hello", 500);

      // Start stream
      mockServer.sendStreamStart(streamFormat);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(player.isPlaying).toBe(true);
      expect(player.currentFormat).toEqual(streamFormat);

      // End stream
      mockServer.sendStreamEnd();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(player.isPlaying).toBe(false);
      expect(player.currentFormat).toBe(null);

      // Should send state update
      const stateUpdate = mockServer.getLastMessage("client/state");
      expect(stateUpdate).toBeDefined();
      expect(stateUpdate.payload.player.state).toBe("synchronized");
    });
  });

  describe("Volume Control", () => {
    it("should handle volume commands from server", async () => {
      player = new SendspinPlayer({
        playerId: "test-player-1",
        baseUrl: "http://localhost:8095",
      });

      await player.connect();
      await mockServer.waitForMessage("client/hello", 500);

      // Initial volume
      expect(player.volume).toBe(100);

      // Server sends volume command
      mockServer.sendVolumeCommand(50);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(player.volume).toBe(50);

      // Should send state update confirming volume change
      const stateUpdate = mockServer.getLastMessage("client/state");
      expect(stateUpdate.payload.player.volume).toBe(50);
    });

    it("should handle mute commands from server", async () => {
      player = new SendspinPlayer({
        playerId: "test-player-1",
        baseUrl: "http://localhost:8095",
      });

      await player.connect();
      await mockServer.waitForMessage("client/hello", 500);

      expect(player.muted).toBe(false);

      // Server sends mute command
      mockServer.sendMuteCommand(true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(player.muted).toBe(true);

      // Unmute
      mockServer.sendMuteCommand(false);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(player.muted).toBe(false);
    });

    it("should allow client to set volume", async () => {
      player = new SendspinPlayer({
        playerId: "test-player-1",
        baseUrl: "http://localhost:8095",
      });

      await player.connect();
      await mockServer.waitForMessage("client/hello", 500);

      player.setVolume(75);

      expect(player.volume).toBe(75);

      // Should send state update
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stateUpdate = mockServer.getLastMessage("client/state");
      expect(stateUpdate.payload.player.volume).toBe(75);
    });

    it("should allow client to set muted state", async () => {
      player = new SendspinPlayer({
        playerId: "test-player-1",
        baseUrl: "http://localhost:8095",
      });

      await player.connect();
      await mockServer.waitForMessage("client/hello", 500);

      player.setMuted(true);

      expect(player.muted).toBe(true);

      // Should send state update
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stateUpdate = mockServer.getLastMessage("client/state");
      expect(stateUpdate.payload.player.muted).toBe(true);
    });
  });

  describe("Sync Delay", () => {
    it("should allow runtime sync delay adjustment", async () => {
      player = new SendspinPlayer({
        playerId: "test-player-1",
        baseUrl: "http://localhost:8095",
        syncDelay: 50, // 50ms initial delay
      });

      await player.connect();
      await mockServer.waitForMessage("client/hello", 500);
      await establishTimeSync();

      // Start stream
      const streamFormat: StreamFormat = {
        codec: "pcm",
        sample_rate: 48000,
        channels: 2,
        bit_depth: 16,
      };
      mockServer.sendStreamStart(streamFormat);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send a chunk
      const startTimeUs = mockServer.getServerTime() + 500_000;
      const chunks = generateChunkSequence(startTimeUs, 1, {
        durationSec: 0.1,
        sampleRate: 48000,
        channels: 2,
        bitDepth: 16,
      });

      mockServer.sendAudioChunk(chunks[0].serverTimeUs, chunks[0].audioData);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const firstScheduleTime = audioContextSpy.sources[0].start.mock.calls[0][0];

      // Change sync delay
      player.setSyncDelay(100); // Increase to 100ms

      // Send another chunk
      const chunk2TimeUs = chunks[0].serverTimeUs + 100_000;
      const chunk2 = generateChunkSequence(chunk2TimeUs, 1, {
        durationSec: 0.1,
        sampleRate: 48000,
        channels: 2,
        bitDepth: 16,
      })[0];

      mockServer.sendAudioChunk(chunk2.serverTimeUs, chunk2.audioData);
      await new Promise((resolve) => setTimeout(resolve, 150));

      // The sync delay change should affect scheduling
      // (exact timing depends on implementation, but it should resync)
      expect(audioContextSpy.sources.length).toBe(2);
    });
  });
});
