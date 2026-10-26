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

    it("rounds volume to an integer", () => {
      sm.volume = 42.6;
      expect(sm.volume).toBe(43);
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
    const controller = {
      supported_commands: ["play", "pause"],
      volume: 50,
      muted: false,
      repeat: "off" as const,
      shuffle: false,
    };

    it("keeps role objects a message omits", () => {
      sm.updateServerState({ metadata: { timestamp: 1, title: "Song A" } });
      sm.updateServerState({ controller });

      expect(sm.serverState.metadata?.title).toBe("Song A");
      expect(sm.serverState.controller).toEqual(controller);
    });

    it("replaces an included role object instead of merging it", () => {
      sm.updateServerState({
        metadata: {
          timestamp: 1,
          title: "Song A",
          album: "Album A",
          progress: {
            track_progress: 1000,
            track_duration: 5000,
            playback_speed: 1000,
          },
        },
      });

      sm.updateServerState({ metadata: { timestamp: 2, title: "Song B" } });

      expect(sm.serverState.metadata).toEqual({
        timestamp: 2,
        title: "Song B",
      });
    });
  });

  describe("scheduled metadata", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("holds a delayed update until its delay passes, then notifies", () => {
      const cb = vi.fn();
      const sm2 = new StateManager(cb);
      sm2.updateServerState({ metadata: { timestamp: 1, title: "Current" } });
      cb.mockClear();

      sm2.updateServerState(
        { metadata: { timestamp: 2, title: "Next" } },
        1000,
      );
      expect(cb).not.toHaveBeenCalled();
      sm2.updateServerState({
        controller: {
          supported_commands: [],
          volume: 50,
          muted: false,
          repeat: "off",
          shuffle: false,
        },
      });
      vi.advanceTimersByTime(999);
      expect(sm2.serverState.metadata?.title).toBe("Current");

      vi.advanceTimersByTime(1);
      expect(sm2.serverState.metadata?.title).toBe("Next");
      expect(cb).toHaveBeenLastCalledWith(
        expect.objectContaining({
          serverState: expect.objectContaining({
            metadata: { timestamp: 2, title: "Next" },
          }),
        }),
      );
    });

    it("replaces the held update with a newer delayed one", () => {
      sm.updateServerState(
        { metadata: { timestamp: 3, title: "Later" } },
        1000,
      );
      sm.updateServerState({ metadata: { timestamp: 2, title: "Next" } }, 500);

      vi.advanceTimersByTime(1000);

      expect(sm.serverState.metadata?.title).toBe("Next");
    });

    it("discards the held update when an immediate one arrives", () => {
      sm.updateServerState({ metadata: { timestamp: 2, title: "Next" } }, 1000);
      sm.updateServerState({ metadata: { timestamp: 1, title: "Current" } });

      vi.advanceTimersByTime(1000);

      expect(sm.serverState.metadata?.title).toBe("Current");
    });

    it("drops the held update when the server state is cleared", () => {
      sm.updateServerState({ metadata: { timestamp: 2, title: "Next" } }, 1000);
      sm.clearConnectionState();

      vi.advanceTimersByTime(1000);

      expect(sm.serverState).toEqual({});
    });
  });

  describe("clearConnectionState", () => {
    it("notifies only when there is server state to clear", () => {
      const cb = vi.fn();
      const sm2 = new StateManager(cb);
      sm2.updateServerState({ metadata: { timestamp: 1, title: "Song" } });
      cb.mockClear();

      sm2.clearConnectionState();
      sm2.clearConnectionState();

      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].serverState).toEqual({});
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

    it("preserves streamGeneration across reset", () => {
      // Generation must keep increasing so late chunks from a previous stream
      // can never match the current generation after a reconnect.
      sm.resetStreamAnchors();
      sm.resetStreamAnchors();
      const generationBefore = sm.streamGeneration;
      expect(generationBefore).toBeGreaterThan(0);

      sm.reset();

      expect(sm.streamGeneration).toBe(generationBefore);
    });
  });

  describe("interval management", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
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
