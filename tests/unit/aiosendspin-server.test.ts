import { describe, expect, it, vi } from "vitest";
import {
  awaitProcessExit,
  type KillableProcess,
} from "../helpers/aiosendspin-server";

describe("awaitProcessExit", () => {
  it("waits for actual exit after forcing a stuck child to stop", async () => {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const proc: KillableProcess = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn((signal: NodeJS.Signals) => {
        expect(signal).toBe("SIGKILL");
        setTimeout(() => {
          proc.signalCode = "SIGKILL";
          resolveDone();
        }, 10);
        return true;
      }),
    };

    await awaitProcessExit(proc, done, 20);

    expect(proc.kill).toHaveBeenCalledOnce();
    expect(proc.signalCode).toBe("SIGKILL");
  });

  it("rejects cleanup when SIGKILL cannot be delivered", async () => {
    const proc: KillableProcess = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => false),
    };

    await expect(
      awaitProcessExit(proc, new Promise<void>(() => undefined), 0),
    ).rejects.toThrow(/SIGKILL/);
  });
});
