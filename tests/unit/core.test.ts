/**
 * Unit tests for SendspinCore behaviors that need no live connection:
 * the supported-command guard, the audio-before-format drop, and the
 * teardown paths (disconnect without a connection, resetPlaybackState).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SendspinCore } from "../../src/core/core";
import type { StreamFormat } from "../../src/types";

const PCM_FORMAT: StreamFormat = {
  codec: "pcm",
  sample_rate: 48000,
  channels: 2,
  bit_depth: 16,
};

describe("SendspinCore (offline)", () => {
  let core: SendspinCore;

  beforeEach(() => {
    core = new SendspinCore({ baseUrl: "http://127.0.0.1:9", playerId: "p" });
  });

  describe("sendCommand guard", () => {
    it("throws when the command is not in the server's supported list", () => {
      core._stateManager.updateServerState({
        controller: { supported_commands: ["play"] },
      });
      expect(() => core.sendCommand("pause", undefined)).toThrow(
        /not supported/,
      );
    });

    it("forwards when the server has not declared supported commands", () => {
      expect(() => core.sendCommand("pause", undefined)).not.toThrow();
    });
  });

  describe("handleBinaryMessage", () => {
    it("drops audio chunks that arrive before a stream format is set", () => {
      const onAudioData = vi.fn();
      core.onAudioData = onAudioData;

      core.handleBinaryMessage(new ArrayBuffer(20));

      expect(onAudioData).not.toHaveBeenCalled();
    });
  });

  describe("teardown", () => {
    it("resetPlaybackState clears playback flags without disconnecting", () => {
      core._stateManager.isPlaying = true;
      core._stateManager.currentStreamFormat = PCM_FORMAT;

      core.resetPlaybackState();

      expect(core.isPlaying).toBe(false);
      expect(core.currentFormat).toBeNull();
    });

    it("disconnect resets state even when never connected", () => {
      core._stateManager.volume = 50;
      core._stateManager.muted = true;

      core.disconnect();

      expect(core.volume).toBe(100);
      expect(core.muted).toBe(false);
      expect(core.isPlaying).toBe(false);
      expect(core.isConnected).toBe(false);
    });
  });
});
