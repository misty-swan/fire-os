import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE, E2E_INSPECTOR_PORT, E2E_PORT } from "./scripts/e2e-port";
import { titlesGrepInvert, triageSummary } from "./scripts/e2e-width-triage";

// 360px(スマホ)と1280px(PC)で確認する。実体は wrangler dev(ローカルのWorkers＋ローカルD1)。
// 起動前に scripts/e2e-prepare.ts がD1を作り直し、初期管理者の招待tokenを発行する。
// setup プロジェクトが管理者アカウント（招待受領→二要素認証）を実際の経路で作り、各試験はそのセッションを使う。
//
// 幅の絞り込み（T085b候補②）: 各試験の宣言直上の「幅:」マーカー（// 幅: 両方 | desktop限定 | phone限定）が正本。
// 画面の配置に依存しない流れ・データ断言の試験は desktop-1280 だけで実行し、幅で変わる断言（isPhone分岐・
// 押下領域44px・ボトムナビ/サイドバーの構成・scrollWidth・prototypeの寸法）を持つ試験だけ両幅で実行する。
// 仕分けの根拠は docs/evidence/e2e-speed.md の仕分け表。マーカーと宣言の数が崩れると設定の読み込みが落ちる
// （scripts/e2e-width-triage.ts の自己検査。新規試験には必ずマーカーを付ける）。
//
// workers=2（T085b候補③）: 試験ごとの架空データ分離（69279d7）と共有D1上の前提の監査が済み、
// D1への直接seed（代理回答scope）はSQLITE_BUSYを限定再試行で吸収するため、並行実行できる。
// （旧来の workers=1 は認証の回数制限や共有の局所DBを試験同士が食い合わないための措置）
const ADMIN_STATE = "tests/e2e/.state/admin-storage.json";
// 受入ゲート（T085。tests/acceptance）はブラウザを使わず、collect-evidence.ts が保存した証跡indexを照合する。
// 業務のe2e（tests/e2e）とは別プロジェクト「acceptance」に置き、他のプロジェクトからは外す。
// CI・collect-evidence は業務のe2eだけを --project で指定して流す（結果照合はCIに入れない＝コントローラ裁定R10）
const E2E_ONLY = /tests\/e2e\//;

export default defineConfig({
  testDir: "tests",
  // vitestの *.test.ts を拾わないよう、Playwrightの対象は e2e の spec/setup と受入ゲートだけ
  testMatch: [/e2e\/.*\.spec\.ts$/, /e2e\/auth\.setup\.ts$/, /acceptance\/.*\.spec\.ts$/],
  workers: 2,
  use: { baseURL: E2E_BASE },
  webServer: {
    // TEST_AI_FAKE=1 は試験専用のfake AI（src/server/ai/local-fake.ts）。localにはAI bindingが無いため、
    // e2eの間だけ分類jobが決定的な候補を作れるようにする（--varはこの webServer にしか付かない。実AIがあれば常に優先）
    // AUTH_BASE_URL は実機のLAN検証で .dev.vars がLAN originに向いていることがあるため、
    // e2eのサーバーだけはlocalhostへ固定する（--varは.dev.varsより強い。auth.setupのsame-origin検査のため）
    // ポートは scripts/e2e-port.ts（既定8797・FIREOS_E2E_PORTで変更。別プロジェクトの8787と並行できる＝T085裁定R19）。
    // AUTH_BASE_URLは同じoriginへ合わせる（auth.setupのsame-origin検査）。inspectorも固定番号にして他のwrangler devと衝突させない
    // 起動時ビルドの省略は不採用（T085b候補⑤。buildは約1秒で削減効果が無く、古い成果物を試験する危険だけが残る）
    command: `tsx scripts/e2e-prepare.ts && npm run build && npx wrangler dev --port ${E2E_PORT} --inspector-port ${E2E_INSPECTOR_PORT} --persist-to .wrangler/e2e --var TEST_AI_FAKE:1 --var AUTH_BASE_URL:${E2E_BASE}`,
    url: `${E2E_BASE}/app`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "phone-360",
      dependencies: ["setup"],
      testIgnore: [/auth\.setup\.ts/, /acceptance\//],
      // desktop限定に仕分けした試験（幅で変わる断言なし）はスマホ幅では実行しない
      grepInvert: titlesGrepInvert(["both", "phone"]),
      use: { ...devices["Pixel 5"], viewport: { width: 360, height: 740 }, storageState: ADMIN_STATE },
    },
    {
      name: "desktop-1280",
      dependencies: ["setup"],
      testIgnore: [/auth\.setup\.ts/, /acceptance\//],
      // phone限定に仕分けした試験（押下領域44px・狭幅の回帰など）はPC幅では実行しない
      grepInvert: titlesGrepInvert(["both", "desktop"]),
      use: { viewport: { width: 1280, height: 800 }, storageState: ADMIN_STATE },
    },
    {
      // タブレット（T083の実端末matrixの768幅）。@tablet-768 のmanifest参照（accessibility/revisit-flows）が
      // 指す2試験だけを768で実行する（T085b④: それ以外のaccessibility試験は768幅では意味を持たないため除外。
      // 768は isPhone(<1024) でスマホレイアウトだが、チップはみ出し回帰は約406px未満でしか起きない等）
      name: "tablet-768",
      dependencies: ["setup"],
      testIgnore: [/auth\.setup\.ts/, /acceptance\//],
      testMatch: /accessibility\.spec\.ts|revisit-flows\.spec\.ts/,
      grepInvert: titlesGrepInvert(["both"]),
      use: { viewport: { width: 768, height: 1024 }, storageState: ADMIN_STATE },
    },
    {
      // 受入ゲート（T085）。ブラウザ・ログイン状態を使わない（setupに依存しない）
      name: "acceptance",
      testMatch: /acceptance\/.*\.spec\.ts$/,
      testIgnore: E2E_ONLY,
    },
  ],
});

// 読み込み時の内訳（自己確認。崩れていれば上の titlesGrepInvert が例外を投げる）
console.log(`[e2e幅仕分け] ${triageSummary()}`);
