import { BaseSequencer, type TestSpecification } from "vitest/node";
import { defineConfig } from "vitest/config";

/** Alphabetical file order so test/zz-route-coverage.test.ts always runs after every other file. */
class AlphaSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // Integration tests share one Postgres database and truncate between tests.
    fileParallelism: false,
    sequence: { sequencer: AlphaSequencer },
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
