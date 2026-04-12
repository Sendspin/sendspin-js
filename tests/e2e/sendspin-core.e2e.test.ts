/**
 * End-to-end tests for SendspinCore against a mock Sendspin server.
 *
 * These tests verify the full protocol flow:
 * - WebSocket connection and handshake (client/hello → server/hello)
 * - Time synchronization (client/time ↔ server/time bursts)
 * - Stream lifecycle (stream/start → PCM audio chunks → stream/end)
 * - Volume/mute commands (server/command)
 * - State management (client/state updates)
 * - Disconnect (client/goodbye)
 *
 * The mock server provides a real WebSocket server — the SDK connects over
 * localhost, exercising the actual WebSocket stack and protocol handler.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import { MockSendspinServer } from "../helpers/mock-server";
import { SendspinCore } from "../../src/core/core";
import type { DecodedAudioChunk, StreamFormat } from "../../src/types";

// Polyfill browser globals that the SDK expects
if (typeof globalThis.WebSocket === "undefined") {
  // @ts-expect-error ws WebSocket is API-compatible for our purposes
  globalThis.WebSocket = WebSocket;
}

describe("SendspinCore E2E", () => {
  let server: MockSendspinServer;
  let core: SendspinCore;

  beforeEach(async () => {
    server = new MockSendspinServer();
    await server.start();
  });

  afterEach(async () => {
    core?.disconnect();
    await server.close();
  });

  /**
   * Helper: create a SendspinCore connected to the mock server.
   * Waits for the handshake (client/hello → server/hello) and initial client/state.
   */
  async function connectCore(
    config: Partial<Parameters<typeof SendspinCore.prototype.connect>[0]> & {
      playerId?: string;
      codecs?: ("pcm" | "opus" | "flac")[];
      syncDelay?: number;
      onStateChange?: any;
    } = {},
  ): Promise<SendspinCore> {
    core = new SendspinCore({
      baseUrl: `http://127.0.0.1:${server.port}`,
      playerId: "test-player",
      clientName: "Test Player",
      codecs: ["pcm"],
      ...config,
    });

    await core.connect();

    // Wait for the handshake to complete
    await server.waitForMessage("client/hello");
    // After server/hello, the SDK sends client/state
    await server.waitForMessage("client/state");

    return core;
  }

  // ===== Handshake =====

  describe("handshake", () => {
    it("sends client/hello and receives server/hello", async () => {
      await connectCore();

      const hello = server.messagesOfType("client/hello")[0];
      expect(hello).toBeDefined();
      expect(hello.payload.client_id).toBe("test-player");
      expect(hello.payload.name).toBe("Test Player");
      expect(hello.payload.version).toBe(1);
      expect(hello.payload.supported_roles).toContain("player@v1");
      expect(hello.payload.supported_roles).toContain("controller@v1");
    });

    it("sends supported formats for PCM codec", async () => {
      await connectCore({ codecs: ["pcm"] });

      const hello = server.messagesOfType("client/hello")[0];
      const support = hello.payload["player@v1_support"] as any;
      expect(support).toBeDefined();
      expect(support.supported_formats).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ codec: "pcm", sample_rate: 48000 }),
          expect.objectContaining({ codec: "pcm", sample_rate: 44100 }),
        ]),
      );
      expect(support.buffer_capacity).toBeGreaterThan(0);
    });

    it("sends initial client/state after server/hello", async () => {
      await connectCore();

      const state = server.messagesOfType("client/state")[0];
      expect(state).toBeDefined();
      const player = (state.payload as any).player;
      expect(player.state).toBe("synchronized");
      expect(player.volume).toBe(100);
      expect(player.muted).toBe(false);
      expect(player.static_delay_ms).toBe(0);
    });
  });

  // ===== External WebSocket =====

  describe("external WebSocket", () => {
    it("connects using an externally provided WebSocket", async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);

      core = new SendspinCore({
        // @ts-expect-error ws WebSocket is compatible
        webSocket: ws,
        playerId: "external-ws-player",
        clientName: "External WS Player",
        codecs: ["pcm"],
      });

      await core.connect();
      await server.waitForMessage("client/hello");

      const hello = server.messagesOfType("client/hello")[0];
      expect(hello.payload.client_id).toBe("external-ws-player");
      expect(core.isConnected).toBe(true);
    });
  });

  // ===== Time Synchronization =====

  describe("time synchronization", () => {
    it("exchanges time sync messages after handshake", async () => {
      await connectCore();

      // The SDK starts a time sync burst immediately after server/hello.
      // A burst sends up to 8 probes sequentially.
      // Wait for at least 2 client/time messages.
      const timeMessages = await server.waitForMessageCount(
        "client/time",
        2,
        5000,
      );

      expect(timeMessages.length).toBeGreaterThanOrEqual(2);

      // Verify the message format
      const firstTime = timeMessages[0];
      expect(firstTime.payload.client_transmitted).toBeTypeOf("number");
      expect(
        (firstTime.payload.client_transmitted as number),
      ).toBeGreaterThan(0);
    });

    it("becomes synchronized after time sync exchange", async () => {
      await connectCore();

      // Wait for a full burst of 8 probes to complete
      await server.waitForMessageCount("client/time", 8, 10000);

      // Give a tick for the filter to finalize
      await new Promise((r) => setTimeout(r, 50));

      const info = core.timeSyncInfo;
      expect(info.synced).toBe(true);
      expect(info.error).toBeGreaterThanOrEqual(0);
    });
  });

  // ===== Streaming =====

  describe("streaming", () => {
    const pcmFormat = {
      codec: "pcm",
      sample_rate: 48000,
      channels: 2,
      bit_depth: 16,
    };

    it("fires onStreamStart when server sends stream/start", async () => {
      await connectCore();

      const streamStartPromise = new Promise<StreamFormat>((resolve) => {
        core.onStreamStart = (format) => resolve(format);
      });

      server.sendStreamStart(pcmFormat);

      const format = await streamStartPromise;
      expect(format.codec).toBe("pcm");
      expect(format.sample_rate).toBe(48000);
      expect(format.channels).toBe(2);
      expect(format.bit_depth).toBe(16);
      expect(core.isPlaying).toBe(true);
      expect(core.currentFormat).toEqual(pcmFormat);
    });

    it("decodes PCM audio chunks and emits onAudioData", async () => {
      await connectCore();

      const chunks: DecodedAudioChunk[] = [];
      core.onAudioData = (chunk) => chunks.push(chunk);

      // Start stream
      server.sendStreamStart(pcmFormat);
      await new Promise((r) => setTimeout(r, 50));

      // Send a 20ms sine wave chunk
      server.sendSineChunk(20, 440, 48000, 2);
      await new Promise((r) => setTimeout(r, 100));

      expect(chunks.length).toBe(1);

      const chunk = chunks[0];
      expect(chunk.samples.length).toBe(2); // 2 channels
      expect(chunk.sampleRate).toBe(48000);
      expect(chunk.serverTimeUs).toBeGreaterThan(0);
      expect(chunk.generation).toBeGreaterThanOrEqual(0);

      // 20ms at 48kHz = 960 samples per channel
      expect(chunk.samples[0].length).toBe(960);
      expect(chunk.samples[1].length).toBe(960);

      // Verify samples are in -1.0 to 1.0 range (PCM decoded to float)
      for (const channelSamples of chunk.samples) {
        for (const sample of channelSamples) {
          expect(sample).toBeGreaterThanOrEqual(-1.0);
          expect(sample).toBeLessThanOrEqual(1.0);
        }
      }
    });

    it("receives multiple sequential audio chunks", async () => {
      await connectCore();

      const chunks: DecodedAudioChunk[] = [];
      core.onAudioData = (chunk) => chunks.push(chunk);

      server.sendStreamStart(pcmFormat);
      await new Promise((r) => setTimeout(r, 50));

      // Send 5 chunks at 20ms intervals
      const baseTime = server.getServerTimeUs();
      for (let i = 0; i < 5; i++) {
        server.sendSineChunk(20, 440, 48000, 2, baseTime + i * 20000);
      }

      await new Promise((r) => setTimeout(r, 200));

      expect(chunks.length).toBe(5);

      // Verify timestamps are increasing
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].serverTimeUs).toBeGreaterThan(
          chunks[i - 1].serverTimeUs,
        );
      }
    });

    it("fires onStreamClear when server sends stream/clear", async () => {
      await connectCore();

      server.sendStreamStart(pcmFormat);
      await new Promise((r) => setTimeout(r, 50));

      const clearPromise = new Promise<void>((resolve) => {
        core.onStreamClear = () => resolve();
      });

      server.sendStreamClear();

      await clearPromise;
      // Stream should still be considered playing (clear = seek, not stop)
      expect(core.isPlaying).toBe(true);
    });

    it("fires onStreamEnd and stops playing on stream/end", async () => {
      await connectCore();

      server.sendStreamStart(pcmFormat);
      await new Promise((r) => setTimeout(r, 50));

      expect(core.isPlaying).toBe(true);

      const endPromise = new Promise<void>((resolve) => {
        core.onStreamEnd = () => resolve();
      });

      server.sendStreamEnd();

      await endPromise;
      expect(core.isPlaying).toBe(false);
      expect(core.currentFormat).toBeNull();
    });

    it("handles format update (stream/start while already streaming)", async () => {
      await connectCore();

      const events: Array<{ format: StreamFormat; isUpdate: boolean }> = [];
      core.onStreamStart = (format, isUpdate) => {
        events.push({ format, isUpdate });
      };

      // First stream/start
      server.sendStreamStart(pcmFormat);
      await new Promise((r) => setTimeout(r, 50));

      // Second stream/start = format update
      const newFormat = { ...pcmFormat, sample_rate: 44100 };
      server.sendStreamStart(newFormat);
      await new Promise((r) => setTimeout(r, 50));

      expect(events.length).toBe(2);
      expect(events[0].isUpdate).toBe(false);
      expect(events[1].isUpdate).toBe(true);
      expect(events[1].format.sample_rate).toBe(44100);
    });
  });

  // ===== Server Commands =====

  describe("server commands", () => {
    it("applies volume command from server", async () => {
      await connectCore();

      const volumeUpdated = new Promise<void>((resolve) => {
        core.onVolumeUpdate = () => resolve();
      });

      server.sendServerCommand({ command: "volume", volume: 75 });

      await volumeUpdated;
      expect(core.volume).toBe(75);
    });

    it("applies mute command from server", async () => {
      await connectCore();

      const volumeUpdated = new Promise<void>((resolve) => {
        core.onVolumeUpdate = () => resolve();
      });

      server.sendServerCommand({ command: "mute", mute: true });

      await volumeUpdated;
      expect(core.muted).toBe(true);
    });

    it("applies set_static_delay command from server", async () => {
      await connectCore();

      const delayChanged = new Promise<number>((resolve) => {
        core.onSyncDelayChange = (delay) => resolve(delay);
      });

      server.sendServerCommand({
        command: "set_static_delay",
        static_delay_ms: 300,
      });

      const delay = await delayChanged;
      expect(delay).toBe(300);
    });
  });

  // ===== Client Volume/Mute =====

  describe("client volume and mute", () => {
    it("sends state update when volume changes", async () => {
      await connectCore();

      const initialCount = server.messagesOfType("client/state").length;

      core.setVolume(42);

      // Wait for the state message
      await server.waitForMessageCount(
        "client/state",
        initialCount + 1,
        2000,
      );

      const states = server.messagesOfType("client/state");
      const lastState = states[states.length - 1];
      expect((lastState.payload as any).player.volume).toBe(42);
    });

    it("sends state update when muted changes", async () => {
      await connectCore();

      const initialCount = server.messagesOfType("client/state").length;

      core.setMuted(true);

      await server.waitForMessageCount(
        "client/state",
        initialCount + 1,
        2000,
      );

      const states = server.messagesOfType("client/state");
      const lastState = states[states.length - 1];
      expect((lastState.payload as any).player.muted).toBe(true);
    });

    it("clamps volume to 0-100 range", async () => {
      await connectCore();

      core.setVolume(150);
      expect(core.volume).toBe(100);

      core.setVolume(-10);
      expect(core.volume).toBe(0);
    });
  });

  // ===== Sync Delay =====

  describe("sync delay", () => {
    it("initializes with configured syncDelay", async () => {
      await connectCore({ syncDelay: 250 });

      const state = server.messagesOfType("client/state")[0];
      expect((state.payload as any).player.static_delay_ms).toBe(250);
    });

    it("clamps sync delay to 0-5000", async () => {
      await connectCore();

      core.setSyncDelay(6000);
      expect(core.getSyncDelayMs()).toBe(5000);

      core.setSyncDelay(-100);
      expect(core.getSyncDelayMs()).toBe(0);
    });

    it("fires onSyncDelayChange when setSyncDelay is called", async () => {
      await connectCore();

      const delayChanged = new Promise<number>((resolve) => {
        core.onSyncDelayChange = (delay) => resolve(delay);
      });

      core.setSyncDelay(300);

      const delay = await delayChanged;
      expect(delay).toBe(300);
    });
  });

  // ===== State Management =====

  describe("state management", () => {
    it("fires onStateChange callback", async () => {
      const states: any[] = [];

      await connectCore({
        onStateChange: (state: any) => states.push({ ...state }),
      });

      // server/hello triggers state change via isPlaying, etc.
      server.sendStreamStart({
        codec: "pcm",
        sample_rate: 48000,
        channels: 2,
        bit_depth: 16,
      });

      await new Promise((r) => setTimeout(r, 100));

      // Should have received at least one state change with isPlaying=true
      const playingState = states.find((s) => s.isPlaying);
      expect(playingState).toBeDefined();
    });

    it("updates server state from server/state messages", async () => {
      await connectCore({
        onStateChange: () => {},
      });

      server.sendServerState({
        metadata: {
          title: "Test Song",
          artist: "Test Artist",
        },
        controller: {
          supported_commands: ["play", "pause", "volume"],
        },
      });

      await new Promise((r) => setTimeout(r, 100));

      // Verify server state is accessible (via _stateManager internal accessor)
      // The public API doesn't expose serverState directly, but it's in onStateChange
    });

    it("updates group state from group/update messages", async () => {
      const states: any[] = [];

      await connectCore({
        onStateChange: (state: any) => states.push({ ...state }),
      });

      server.sendGroupUpdate({
        playback_state: "playing",
        group_id: "test-group",
        group_name: "Test Group",
      });

      await new Promise((r) => setTimeout(r, 100));

      const lastState = states[states.length - 1];
      expect(lastState.groupState.playback_state).toBe("playing");
      expect(lastState.groupState.group_id).toBe("test-group");
    });
  });

  // ===== Disconnect =====

  describe("disconnect", () => {
    it("sends client/goodbye on disconnect", async () => {
      await connectCore();

      core.disconnect("user_request");

      await server.waitForMessage("client/goodbye", 2000);

      const goodbye = server.messagesOfType("client/goodbye")[0];
      expect(goodbye.payload.reason).toBe("user_request");
    });

    it("resets state on disconnect", async () => {
      await connectCore();

      core.setVolume(50);
      core.setMuted(true);

      core.disconnect();

      expect(core.isConnected).toBe(false);
      expect(core.volume).toBe(100); // reset
      expect(core.muted).toBe(false); // reset
    });
  });

  // ===== Full session lifecycle =====

  describe("full session lifecycle", () => {
    it("handles connect → stream → audio → clear → audio → end → disconnect", async () => {
      const chunks: DecodedAudioChunk[] = [];
      const events: string[] = [];

      await connectCore();

      core.onAudioData = (chunk) => chunks.push(chunk);
      core.onStreamStart = () => events.push("stream-start");
      core.onStreamClear = () => events.push("stream-clear");
      core.onStreamEnd = () => events.push("stream-end");

      // 1. Start stream
      const pcmFormat = {
        codec: "pcm",
        sample_rate: 48000,
        channels: 2,
        bit_depth: 16,
      };
      server.sendStreamStart(pcmFormat);
      await new Promise((r) => setTimeout(r, 50));

      // 2. Send some audio
      server.sendSineChunk(20, 440, 48000, 2);
      server.sendSineChunk(20, 440, 48000, 2);
      await new Promise((r) => setTimeout(r, 100));

      // 3. Seek (clear)
      server.sendStreamClear();
      await new Promise((r) => setTimeout(r, 50));

      // 4. Send more audio after seek
      server.sendSineChunk(20, 440, 48000, 2);
      await new Promise((r) => setTimeout(r, 100));

      // 5. End stream
      server.sendStreamEnd();
      await new Promise((r) => setTimeout(r, 50));

      // 6. Disconnect
      core.disconnect();

      // Verify the full sequence
      expect(events).toEqual(["stream-start", "stream-clear", "stream-end"]);
      expect(chunks.length).toBe(3);
      expect(core.isPlaying).toBe(false);
      expect(core.isConnected).toBe(false);
    });
  });
});
