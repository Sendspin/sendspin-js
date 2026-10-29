import { describe, expect, it, vi } from "vitest";
import {
  AiosendspinServer,
  awaitProcessExit,
  reportDeferredViolations,
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

describe("non-compliance check", () => {
  const rejectionLine = JSON.stringify({
    log: {
      level: "ERROR",
      name: "aiosendspin",
      message:
        "rejecting non-compliant client Test: client/hello sent an undefined field",
    },
  });

  function serverThatLogged(line: string): AiosendspinServer {
    const server = new AiosendspinServer();
    (server as any).recordStderrLine(line);
    return server;
  }

  it("fails a normal test on non-compliance", async () => {
    await expect(
      serverThatLogged(rejectionLine).close({ name: "normal" }),
    ).rejects.toThrow(/undefined field/);
  });

  it("defers non-compliance from an it.fails test and reports it once", async () => {
    await serverThatLogged(rejectionLine).close({
      name: "expected",
      fails: true,
    });
    expect(reportDeferredViolations).toThrow(/expected: .*undefined field/s);
    expect(reportDeferredViolations).not.toThrow();
  });
});
