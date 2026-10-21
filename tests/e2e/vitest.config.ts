import { BaseSequencer } from "vitest/node";
import { defineConfig } from "vitest/config";

/** Alphabetical order so api/zz-coverage.e2e.test.ts runs after every file that records route hits. */
class AlphaSequencer extends BaseSequencer {
  override async sort(files: Parameters<BaseSequencer["sort"]>[0]) {
    return [...files].sort((a, b) => a[1].localeCompare(b[1]));
  }
}

export default defineConfig({
  test: {
    include: ["api/**/*.e2e.test.ts"],
    globalSetup: ["api/support/global-setup.ts"],
    // All files share one Postgres database and truncate it; run them one after another.
    fileParallelism: false,
    sequence: { sequencer: AlphaSequencer },
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
