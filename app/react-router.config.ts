import type { Config } from "@react-router/dev/config";

// Source lives in app/src (not the template's app/app) because this package IS the repo's `app/` folder.
export default {
  appDirectory: "src",
  ssr: true,
} satisfies Config;
