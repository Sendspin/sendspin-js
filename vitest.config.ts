import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // E2E tests stack a 10s server waitForClient, an 8s time-sync wait, and
    // various handshake sleeps. Stay well above the inner timeouts so a hung
    // probe surfaces its own diagnostic instead of a generic vitest timeout.
    testTimeout: 30000,
  },
});
