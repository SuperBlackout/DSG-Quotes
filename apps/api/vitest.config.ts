import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // Integration tests share one Postgres database and truncate between tests.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
