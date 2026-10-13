import { defineConfig, devices } from "@playwright/test";

// 360px(スマホ)と1280px(PC)の2サイズでshellを確認する。実体は wrangler dev(ローカルのWorkers)。
export default defineConfig({
  testDir: "tests/e2e",
  use: { baseURL: "http://localhost:8787" },
  webServer: {
    command: "npm run build && npx wrangler dev --port 8787",
    url: "http://localhost:8787/app",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: "phone-360", use: { ...devices["Pixel 5"], viewport: { width: 360, height: 740 } } },
    { name: "desktop-1280", use: { viewport: { width: 1280, height: 800 } } },
  ],
});
