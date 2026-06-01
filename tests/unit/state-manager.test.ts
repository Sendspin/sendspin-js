/**
 * Unit tests for StateManager.
 *
 * Tests the observable state store that tracks player state,
 * volume, stream format, and server/group state.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { StateManager } from "../../src/core/state-manager";

describe("StateManager", () => {
  let sm: StateManager;

  beforeEach(() => {
    sm = new StateManager();
  });

  afterEach(() => {
    sm.reset();
  });

  describe("volume", () => {
    it("clamps volume to 0-100", () => {
      sm.volume = 150;
      expect(sm.volume).toBe(100);

      sm.volume = -10;
      expect(sm.volume).toBe(0);
    });
  });

  describe("stream generation", () => {
    it("increments on resetStreamAnchors", () => {
      sm.resetStreamAnchors();
      expect(sm.streamGeneration).toBe(1);

      sm.resetStreamAnchors();
      expect(sm.streamGeneration).toBe(2);
    });

    it("resets stream anchors", () => {
      sm.streamStartServerTime = 12345;
      sm.streamStartAudioTime = 67890;

      sm.resetStreamAnchors();

      expect(sm.streamStartServerTime).toBe(0);
      expect(sm.streamStartAudioTime).toBe(0);
    });
  });

  describe("onStateChange callback", () => {
    it("includes full state in callback", () => {
      const cb = vi.fn();
      const sm2 = new StateManager(cb);

      sm2.volume = 75;

      expect(cb).toHaveBeenCalledWith({
        isPlaying: false,
        volume: 75,
        muted: false,
        playerState: "synchronized",
        serverState: {},
        groupState: {},
      });
    });
  });

  describe("server state", () => {
    it("merges delta updates", () => {
      sm.updateServerState({
        metadata: { title: "Song A", artist: "Artist A" },
      });

      expect(sm.serverState.metadata?.title).toBe("Song A");

      // Merge another field without losing existing
      sm.updateServerState({
        controller: { supported_commands: ["play", "pause"] },
      });

      expect(sm.serverState.metadata?.title).toBe("Song A");
      expect(sm.serverState.controller?.supported_commands).toEqual([
        "play",
        "pause",
      ]);
    });

    it("handles null values by deleting keys", () => {
      sm.updateServerState({
        metadata: { title: "Song A" },
      });

      sm.updateServerState({
        metadata: null as any,
      });

      expect(sm.serverState.metadata).toBeUndefined();
    });

    it("merges nested fields without dropping siblings", () => {
      sm.updateServerState({
        metadata: { title: "Song A", artist: "Artist A" },
      });

      sm.updateServerState({ metadata: { artist: "Artist B" } });

      expect(sm.serverState.metadata).toEqual({
        title: "Song A",
        artist: "Artist B",
      });
    });

    it("clears a nested key with null while keeping siblings", () => {
      sm.updateServerState({
        metadata: { title: "Song A", artist: "Artist A" },
      });

      sm.updateServerState({ metadata: { artist: null } });

      expect(sm.serverState.metadata).toEqual({ title: "Song A" });
    });
  });

  describe("reset", () => {
    it("resets all state to defaults", () => {
      sm.volume = 42;
      sm.muted = true;
      sm.playerState = "error";
      sm.isPlaying = true;
      sm.currentStreamFormat = {
        codec: "pcm",
        sample_rate: 48000,
        channels: 2,
      };
      sm.updateServerState({
        metadata: { title: "Song" },
      });
      sm.updateGroupState({
        playback_state: "playing",
      });

      sm.reset();

      expect(sm.volume).toBe(100);
      expect(sm.muted).toBe(false);
      expect(sm.playerState).toBe("synchronized");
      expect(sm.isPlaying).toBe(false);
      expect(sm.currentStreamFormat).toBeNull();
      expect(sm.serverState).toEqual({});
      expect(sm.groupState).toEqual({});
    });
  });

  describe("interval management", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("clears the tracked time sync interval", () => {
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      const id = setInterval(() => {}, 1000) as unknown as number;
      sm.setTimeSyncInterval(id);

      sm.clearTimeSyncInterval();

      expect(clearSpy).toHaveBeenCalledWith(id);
    });

    it("clears the tracked state update interval", () => {
      const clearSpy = vi.spyOn(globalThis, "clearInterval");
      const id = setInterval(() => {}, 1000) as unknown as number;
      sm.setStateUpdateInterval(id);

      sm.clearStateUpdateInterval();

      expect(clearSpy).toHaveBeenCalledWith(id);
    });

    it("clearAllIntervals clears both tracked intervals", () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      const id1 = setInterval(() => {}, 1000) as unknown as number;
      const id2 = setInterval(() => {}, 1000) as unknown as number;
      sm.setTimeSyncInterval(id1);
      sm.setStateUpdateInterval(id2);

      sm.clearAllIntervals();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(id1);
      expect(clearIntervalSpy).toHaveBeenCalledWith(id2);
    });
  });
});
