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
    // TEST_AI_FAKE=1 は試験専用のfake AI（src/server/ai/local-fake.ts）。localにはAI bindingが無いため、
    // e2eの間だけ分類jobが決定的な候補を作れるようにする（--varはこの webServer にしか付かない。実AIがあれば常に優先）
    // AUTH_BASE_URL は実機のLAN検証で .dev.vars がLAN originに向いていることがあるため、
    // e2eのサーバーだけはlocalhostへ固定する（--varは.dev.varsより強い。auth.setupのsame-origin検査のため）
    command: "tsx scripts/e2e-prepare.ts && npm run build && npx wrangler dev --port 8787 --persist-to .wrangler/e2e --var TEST_AI_FAKE:1 --var AUTH_BASE_URL:http://localhost:8787",
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
    {
      // タブレット（T083の実端末matrixの768幅）。既存27specの実行時間を増やさないため、
      // T083の新規2spec（accessibility / revisit-flows）だけをこのプロジェクトで走らせる
      name: "tablet-768",
      dependencies: ["setup"],
      testIgnore: /auth\.setup\.ts/,
      testMatch: /accessibility\.spec\.ts|revisit-flows\.spec\.ts/,
      use: { viewport: { width: 768, height: 1024 }, storageState: ADMIN_STATE },
    },
  ],
});
