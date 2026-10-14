import { defineConfig, devices } from "@playwright/test";

// 360px(スマホ)と1280px(PC)の2サイズで確認する。実体は wrangler dev(ローカルのWorkers＋ローカルD1)。
// 起動前に scripts/e2e-prepare.ts がD1を作り直し、初期管理者の招待tokenを発行する。
// setup プロジェクトが管理者アカウント（招待受領→二要素認証）を実際の経路で作り、各試験はそのセッションを使う。
// workers=1：認証の回数制限や共有の局所DBを試験同士で食い合わないため。
const ADMIN_STATE = "tests/e2e/.state/admin-storage.json";

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  use: { baseURL: "http://localhost:8787" },
  webServer: {
    command: "tsx scripts/e2e-prepare.ts && npm run build && npx wrangler dev --port 8787 --persist-to .wrangler/e2e",
    url: "http://localhost:8787/app",
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "phone-360",
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.ts/,
      use: { ...devices["Pixel 5"], viewport: { width: 360, height: 740 }, storageState: ADMIN_STATE },
    },
    {
      name: "desktop-1280",
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.ts/,
      use: { viewport: { width: 1280, height: 800 }, storageState: ADMIN_STATE },
    },
  ],
});
