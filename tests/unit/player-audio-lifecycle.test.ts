import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SendspinPlayer } from "../../src/index";

class FakeAudioContext {
  state: "running" | "suspended" | "closed" = "running";
  currentTime = 0;
  destination = {};
  createGain() {
    return { gain: { value: 1, setTargetAtTime() {} }, connect() {} };
  }
  suspend() {
    this.state = "suspended";
    return Promise.resolve();
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

const contexts: FakeAudioContext[] = [];

function createPlayer(): SendspinPlayer {
  return new SendspinPlayer({ webSocket: {} as never, storage: null });
}

beforeEach(() => {
  contexts.length = 0;
  vi.stubGlobal("navigator", {});
  vi.stubGlobal("AudioContext", function () {
    const ctx = new FakeAudioContext();
    contexts.push(ctx);
    return ctx;
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SendspinPlayer audio lifecycle", () => {
  it("keeps its AudioContext running across disconnect", async () => {
    const player = createPlayer();
    await player.unlock();

    player.disconnect("user_request");
    expect(contexts[0].state).toBe("running");

    await player.unlock();
    expect(contexts).toHaveLength(1);
  });

  it("closes its AudioContext on destroy", async () => {
    const player = createPlayer();
    await player.unlock();

    player.destroy("user_request");

    expect(contexts[0].state).toBe("closed");
  });
});
