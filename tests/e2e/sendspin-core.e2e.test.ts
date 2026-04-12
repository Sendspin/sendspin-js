/**
 * End-to-end tests for SendspinCore against a real aiosendspin server.
 *
 * These tests verify the full protocol flow using the reference Python
 * implementation of the Sendspin server. No mocking — the SDK talks to a
 * real server over WebSocket, exercising the actual protocol stack:
 *
 * - WebSocket connection and handshake (client/hello → server/hello)
 * - Time synchronization (NTP-style burst probes)
 * - Stream lifecycle (stream/start → PCM audio → stream/end)
 * - Server commands (volume, mute, set_static_delay)
 * - Client state updates
 * - Disconnect (client/goodbye)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { WebSocket } from "ws";
import { AiosendspinServer } from "../helpers/aiosendspin-server";
import { SendspinCore } from "../../src/core/core";
import type { DecodedAudioChunk, StreamFormat } from "../../src/types";

// Polyfill browser globals that the SDK expects
if (typeof globalThis.WebSocket === "undefined") {
  // @ts-expect-error ws WebSocket is API-compatible for our purposes
  globalThis.WebSocket = WebSocket;
}

/** Helper: wait for a condition with polling. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 5000,
  intervalMs: number = 50,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("SendspinCore E2E (aiosendspin)", () => {
  let server: AiosendspinServer;
  let core: SendspinCore | null = null;

  beforeAll(async () => {
    server = new AiosendspinServer();
    await server.start();
  });

  afterAll(async () => {
    await server.close();
  });

  afterEach(() => {
    core?.disconnect();
    core = null;
  });

  /**
   * Helper: create a SendspinCore connected to the aiosendspin server
   * and wait for the server to acknowledge the client.
   */
  async function connectCore(
    config: {
      playerId?: string;
      codecs?: ("pcm" | "opus" | "flac")[];
      syncDelay?: number;
      onStateChange?: any;
    } = {},
  ): Promise<SendspinCore> {
    core = new SendspinCore({
      baseUrl: `http://127.0.0.1:${server.port}`,
      playerId: config.playerId ?? "e2e-test-player",
      clientName: "E2E Test Player",
      codecs: config.codecs ?? ["pcm"],
      syncDelay: config.syncDelay,
      onStateChange: config.onStateChange,
    });

    // Start both: the SDK connecting and the server waiting for the client
    const [, clientId] = await Promise.all([
      core.connect(),
      server.waitForClient(),
    ]);

    expect(clientId).toBeTruthy();

    // Give the protocol handler a moment to process server/hello
    await new Promise((r) => setTimeout(r, 100));

    return core;
  }

  // ===== Handshake =====

  describe("handshake", () => {
    it("connects to a real aiosendspin server and completes handshake", async () => {
      await connectCore();

      expect(core!.isConnected).toBe(true);
      expect(core!.volume).toBe(100);
      expect(core!.muted).toBe(false);
    });

    it("connects with external WebSocket", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/sendspin`);

      // Wait for the WebSocket to open before passing it to SendspinCore
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () => resolve());
        ws.on("error", (err) => reject(err));
      });

      core = new SendspinCore({
        // @ts-expect-error ws WebSocket is compatible
        webSocket: ws,
        playerId: "external-ws-player",
        clientName: "External WS Player",
        codecs: ["pcm"],
      });

      const [, clientId] = await Promise.all([
        core.connect(),
        server.waitForClient(),
      ]);

      expect(clientId).toBeTruthy();
      await new Promise((r) => setTimeout(r, 100));
      expect(core.isConnected).toBe(true);
    });
  });

  // ===== Time Synchronization =====

  describe("time synchronization", () => {
    it("achieves time sync with real server", async () => {
      await connectCore();

      // Wait for the time sync burst to complete
      await waitFor(() => core!.timeSyncInfo.synced, 8000);

      const info = core!.timeSyncInfo;
      expect(info.synced).toBe(true);
      // With loopback, error should be small
      expect(info.error).toBeLessThan(50);
    });
  });

  // ===== Streaming =====

  describe("streaming", () => {
    it("receives stream/start from server and sets format", async () => {
      await connectCore();

      const streamStartPromise = new Promise<StreamFormat>((resolve) => {
        core!.onStreamStart = (format) => resolve(format);
      });

      await server.streamStart();

      const format = await streamStartPromise;
      expect(format.codec).toBeTruthy();
      expect(format.sample_rate).toBeGreaterThan(0);
      expect(format.channels).toBeGreaterThan(0);
      expect(core!.isPlaying).toBe(true);
      expect(core!.currentFormat).not.toBeNull();
    });

    it("decodes PCM audio from a real server stream", async () => {
      await connectCore();

      const chunks: DecodedAudioChunk[] = [];
      core!.onAudioData = (chunk) => chunks.push(chunk);

      // Start stream
      await server.streamStart();
      await new Promise((r) => setTimeout(r, 200));

      // Send audio
      await server.sendAudio(20);

      // Wait for audio to arrive
      await waitFor(() => chunks.length >= 1, 3000);

      const chunk = chunks[0];
      expect(chunk.samples.length).toBeGreaterThanOrEqual(1);
      expect(chunk.sampleRate).toBeGreaterThan(0);
      expect(chunk.serverTimeUs).toBeGreaterThan(0);
      expect(chunk.samples[0].length).toBeGreaterThan(0);

      // Verify samples are in -1.0 to 1.0 range
      for (const channelSamples of chunk.samples) {
        for (const sample of channelSamples) {
          expect(sample).toBeGreaterThanOrEqual(-1.0);
          expect(sample).toBeLessThanOrEqual(1.0);
        }
      }
    });

    it("receives multiple audio chunks", async () => {
      await connectCore();

      const chunks: DecodedAudioChunk[] = [];
      core!.onAudioData = (chunk) => chunks.push(chunk);

      await server.streamStart();
      await new Promise((r) => setTimeout(r, 200));

      // Send several chunks
      for (let i = 0; i < 5; i++) {
        await server.sendAudio(20);
      }

      await waitFor(() => chunks.length >= 3, 3000);

      // Verify timestamps are increasing
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].serverTimeUs).toBeGreaterThan(
          chunks[i - 1].serverTimeUs,
        );
      }
    });

    it("handles stream end", async () => {
      await connectCore();

      const streamStarted = new Promise<void>((resolve) => {
        core!.onStreamStart = () => resolve();
      });

      await server.streamStart();
      await streamStarted;

      expect(core!.isPlaying).toBe(true);

      const endPromise = new Promise<void>((resolve) => {
        core!.onStreamEnd = () => resolve();
      });

      await server.streamEnd();
      await endPromise;

      expect(core!.isPlaying).toBe(false);
      expect(core!.currentFormat).toBeNull();
    });
  });

  // ===== Server Commands =====

  describe("server commands", () => {
    it("receives volume command from server", async () => {
      await connectCore();

      // Start a stream so the player role is fully active
      const streamStarted = new Promise<void>((resolve) => {
        core!.onStreamStart = () => resolve();
      });
      await server.streamStart();
      await streamStarted;
      await new Promise((r) => setTimeout(r, 100));

      const volumeUpdated = new Promise<void>((resolve) => {
        core!.onVolumeUpdate = () => resolve();
      });

      await server.setVolume(42);
      await volumeUpdated;

      expect(core!.volume).toBe(42);
    });

    it("receives mute command from server", async () => {
      await connectCore();

      const streamStarted = new Promise<void>((resolve) => {
        core!.onStreamStart = () => resolve();
      });
      await server.streamStart();
      await streamStarted;
      await new Promise((r) => setTimeout(r, 100));

      const volumeUpdated = new Promise<void>((resolve) => {
        core!.onVolumeUpdate = () => resolve();
      });

      await server.setMute(true);
      await volumeUpdated;

      expect(core!.muted).toBe(true);
    });

    it("receives set_static_delay command from server", async () => {
      await connectCore();

      const streamStarted = new Promise<void>((resolve) => {
        core!.onStreamStart = () => resolve();
      });
      await server.streamStart();
      await streamStarted;
      await new Promise((r) => setTimeout(r, 100));

      const delayChanged = new Promise<number>((resolve) => {
        core!.onSyncDelayChange = (delay) => resolve(delay);
      });

      await server.setDelay(300);
      const delay = await delayChanged;

      expect(delay).toBe(300);
    });
  });

  // ===== Client State =====

  describe("client state", () => {
    it("sets volume locally and reflects in state", async () => {
      await connectCore();

      core!.setVolume(55);
      expect(core!.volume).toBe(55);
    });

    it("sets muted locally and reflects in state", async () => {
      await connectCore();

      core!.setMuted(true);
      expect(core!.muted).toBe(true);
    });

    it("tracks sync delay changes", async () => {
      await connectCore({ syncDelay: 200 });

      expect(core!.getSyncDelayMs()).toBe(200);

      core!.setSyncDelay(350);
      expect(core!.getSyncDelayMs()).toBe(350);
    });

    it("clamps sync delay to valid range", async () => {
      await connectCore();

      core!.setSyncDelay(9999);
      expect(core!.getSyncDelayMs()).toBe(5000);

      core!.setSyncDelay(-100);
      expect(core!.getSyncDelayMs()).toBe(0);
    });
  });

  // ===== Disconnect =====

  describe("disconnect", () => {
    it("disconnects cleanly", async () => {
      await connectCore();

      expect(core!.isConnected).toBe(true);

      core!.disconnect("user_request");

      expect(core!.isConnected).toBe(false);
    });

    it("resets state on disconnect", async () => {
      await connectCore();

      core!.setVolume(50);
      core!.setMuted(true);

      core!.disconnect();

      expect(core!.volume).toBe(100); // reset
      expect(core!.muted).toBe(false); // reset
      expect(core!.isPlaying).toBe(false);
    });
  });

  // ===== Full Lifecycle =====

  describe("full session lifecycle", () => {
    it("handles connect → stream → audio → end → disconnect", async () => {
      const chunks: DecodedAudioChunk[] = [];
      const events: string[] = [];

      await connectCore();

      core!.onAudioData = (chunk) => chunks.push(chunk);
      core!.onStreamStart = () => events.push("stream-start");
      core!.onStreamEnd = () => events.push("stream-end");

      // 1. Start stream
      await server.streamStart();
      await waitFor(() => events.includes("stream-start"), 3000);

      // 2. Send audio
      await server.sendAudio(20);
      await server.sendAudio(20);
      await waitFor(() => chunks.length >= 1, 3000);

      // 3. End stream
      await server.streamEnd();
      await waitFor(() => events.includes("stream-end"), 3000);

      // 4. Disconnect
      core!.disconnect();

      // Verify
      expect(events).toContain("stream-start");
      expect(events).toContain("stream-end");
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(core!.isPlaying).toBe(false);
      expect(core!.isConnected).toBe(false);
    });
  });
});
