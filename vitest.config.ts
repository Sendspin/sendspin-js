import { defineConfig } from "vitest/config";

// E2E tests stack a 10s server waitForClient, an 8s time-sync wait, and
// various handshake sleeps. Stay well above the inner timeouts so a hung
// probe surfaces its own diagnostic instead of a generic vitest timeout.
const TEST_TIMEOUT = 30000;

export default defineConfig({
  test: {
    testTimeout: TEST_TIMEOUT,
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          testTimeout: TEST_TIMEOUT,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          testTimeout: TEST_TIMEOUT,
          // Each E2E file spawns its own Python aiosendspin server. Serialize
          // file execution so find_free_port allocations cannot race between
          // parallel workers.
          fileParallelism: false,
        },
      },
    ],
  },
});
