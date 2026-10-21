import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Shopify CLI passes HOST; the template maps it to SHOPIFY_APP_URL so Vite's own host option is not broken.
if (process.env.HOST && (!process.env.SHOPIFY_APP_URL || process.env.SHOPIFY_APP_URL === process.env.HOST)) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost").hostname;

const hmrConfig =
  host === "localhost"
    ? { protocol: "ws", host: "localhost", port: 64999, clientPort: 64999 }
    : { protocol: "wss", host, port: parseInt(process.env.FRONTEND_PORT ?? "") || 8002, clientPort: 443 };

export default defineConfig({
  server: {
    allowedHosts: [host],
    cors: { preflightContinue: true },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    // `shared` is a workspace package outside this folder.
    fs: { allow: ["src", "node_modules", "../packages/shared", "../node_modules"] },
  },
  plugins: [reactRouter(), tsconfigPaths()],
  // `shared` ships TypeScript source (main: src/index.ts), so it must be bundled, not externalised.
  ssr: { noExternal: ["shared"] },
  build: { assetsInlineLimit: 0 },
  optimizeDeps: { include: ["@shopify/app-bridge-react"] },
}) satisfies UserConfig;
