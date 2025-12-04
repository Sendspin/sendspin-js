import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    globals: true,
    testTimeout: 20000, // 20 second timeout for time sync tests
  },
});
