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
    it("defaults to 100", () => {
      expect(sm.volume).toBe(100);
    });

    it("clamps volume to 0-100", () => {
      sm.volume = 150;
      expect(sm.volume).toBe(100);

      sm.volume = -10;
      expect(sm.volume).toBe(0);
    });

    it("sets volume within range", () => {
      sm.volume = 42;
      expect(sm.volume).toBe(42);
    });
  });

  describe("muted", () => {
    it("defaults to false", () => {
      expect(sm.muted).toBe(false);
    });

    it("can be toggled", () => {
      sm.muted = true;
      expect(sm.muted).toBe(true);

      sm.muted = false;
      expect(sm.muted).toBe(false);
    });
  });

  describe("playerState", () => {
    it("defaults to synchronized", () => {
      expect(sm.playerState).toBe("synchronized");
    });

    it("can be set to error", () => {
      sm.playerState = "error";
      expect(sm.playerState).toBe("error");
    });
  });

  describe("isPlaying", () => {
    it("defaults to false", () => {
      expect(sm.isPlaying).toBe(false);
    });

    it("can be toggled", () => {
      sm.isPlaying = true;
      expect(sm.isPlaying).toBe(true);
    });
  });

  describe("stream format", () => {
    it("defaults to null", () => {
      expect(sm.currentStreamFormat).toBeNull();
    });

    it("stores stream format", () => {
      sm.currentStreamFormat = {
        codec: "pcm",
        sample_rate: 48000,
        channels: 2,
        bit_depth: 16,
      };
      expect(sm.currentStreamFormat?.codec).toBe("pcm");
      expect(sm.currentStreamFormat?.sample_rate).toBe(48000);
    });
  });

  describe("stream generation", () => {
    it("starts at 0", () => {
      expect(sm.streamGeneration).toBe(0);
    });

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
    it("fires on volume change", () => {
      const cb = vi.fn();
      const sm2 = new StateManager(cb);

      sm2.volume = 50;

      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ volume: 50 }),
      );
    });

    it("fires on muted change", () => {
      const cb = vi.fn();
      const sm2 = new StateManager(cb);

      sm2.muted = true;

      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ muted: true }),
      );
    });

    it("fires on isPlaying change", () => {
      const cb = vi.fn();
      const sm2 = new StateManager(cb);

      sm2.isPlaying = true;

      expect(cb).toHaveBeenCalledWith(
        expect.objectContaining({ isPlaying: true }),
      );
    });

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
    it("defaults to empty", () => {
      expect(sm.serverState).toEqual({});
    });

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
  });

  describe("group state", () => {
    it("defaults to empty", () => {
      expect(sm.groupState).toEqual({});
    });

    it("merges delta updates", () => {
      sm.updateGroupState({
        playback_state: "playing",
        group_id: "g1",
      });

      expect(sm.groupState.playback_state).toBe("playing");
      expect(sm.groupState.group_id).toBe("g1");

      sm.updateGroupState({
        group_name: "Living Room",
      });

      expect(sm.groupState.playback_state).toBe("playing");
      expect(sm.groupState.group_name).toBe("Living Room");
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
    it("tracks and clears time sync interval", () => {
      const intervalId = setInterval(() => {}, 1000) as unknown as number;
      sm.setTimeSyncInterval(intervalId);

      // Should not throw
      sm.clearTimeSyncInterval();
    });

    it("tracks and clears state update interval", () => {
      const intervalId = setInterval(() => {}, 1000) as unknown as number;
      sm.setStateUpdateInterval(intervalId);

      sm.clearStateUpdateInterval();
    });

    it("clearAllIntervals clears both", () => {
      const id1 = setInterval(() => {}, 1000) as unknown as number;
      const id2 = setInterval(() => {}, 1000) as unknown as number;
      sm.setTimeSyncInterval(id1);
      sm.setStateUpdateInterval(id2);

      sm.clearAllIntervals();
    });
  });
});
