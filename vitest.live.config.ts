import { defineConfig } from "vitest/config";

// 実Cloudflare（staging/demo）に対する試験。モックや局所workerdでは代替しない。
// 実行: LIVE_BASE_URL=https://... LIVE_BOOTSTRAP_TOKEN=... LIVE_BOOTSTRAP_EMAIL=... npm run test:live
export default defineConfig({
  test: { include: ["tests/live/**/*.test.ts"], environment: "node", testTimeout: 60_000 },
});
