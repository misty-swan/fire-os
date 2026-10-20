import { expect, test } from "@playwright/test";

// 実ブラウザでの表示確認（360px=スマホ / 1280px=PC）。実体は wrangler dev(ローカルのWorkers)＋ビルド済みReact。
// 期待値は prototype（FireOS Prototype/Desktop.dc.html）の寸法・構成。
const isPhone = (viewport: { width: number } | null) => (viewport?.width ?? 0) < 1024;

// 幅: 両方（ボトムナビ84px・サイドバー248pxなど、幅で変わる構成そのもの）
test("shell_layout_matches_the_viewport", async ({ page }, info) => {
  await page.goto("/app");
  const phone = isPhone(page.viewportSize());
  const bottomNav = page.getByTestId("bottom-nav");
  const sidebar = page.locator("aside");

  if (phone) {
    await expect(page.getByRole("heading", { level: 2, name: "ホーム" })).toBeVisible();
    await expect(bottomNav).toBeVisible();
    await expect(sidebar).toBeHidden();
    // 下部ナビ: 高さ84px、5タブ（ホーム/マップ/予定・活動/AI/メニュー）、押せる大きさ44px以上
    expect(Math.round((await bottomNav.boundingBox())!.height)).toBe(84);
    for (const name of ["ホーム", "マップ", "予定・活動", "AI", "メニュー"]) {
      const box = await bottomNav.getByRole("link", { name }).boundingBox();
      expect(box!.height, name).toBeGreaterThanOrEqual(44);
      expect(box!.width, name).toBeGreaterThanOrEqual(44);
    }
    // ホームの最上段（通信状態・DEMO・通知）。スマホには常設ヘッダーが無い
    await expect(page.locator("main").getByText("オンライン")).toBeVisible();
    await expect(page.locator("header")).toBeHidden();
  } else {
    await expect(page.getByRole("heading", { level: 1, name: "ダッシュボード" })).toBeVisible();
    await expect(sidebar).toBeVisible();
    await expect(bottomNav).toBeHidden();
    // prototype Desktop: サイドバー幅248px、ヘッダー高さ64px
    expect(Math.round((await sidebar.boundingBox())!.width)).toBe(248);
    expect(Math.round((await page.locator("header").boundingBox())!.height)).toBe(64);
    for (const heading of ["OVERVIEW", "OPERATIONS", "ORGANIZATION"]) await expect(sidebar.getByText(heading)).toBeVisible();
    // prototype どおりサイドバー全体がスクロールし、最下部に出動管理と利用者がある
    await page.locator("aside").evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await expect(page.getByRole("link", { name: "出動管理" })).toBeInViewport();
    await expect(page.getByText("架空 管理者")).toBeInViewport(); // API-01 の値（管理者のセッション）
    await expect(page.getByRole("link", { name: "AIアシスタント" })).toBeVisible();
    // 画面全体はスクロールせず、中身だけがスクロールする（100vh固定）
    expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeLessThanOrEqual(0);
  }

  // 横スクロールが出ない（360pxでも内容が画面内に収まる）
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // 証跡の画像は明示したときだけ更新する（通常の試験実行でリポジトリのファイルを書き換えない）
  if (process.env.SAVE_EVIDENCE === "1") await page.screenshot({ path: `docs/evidence/ph0/shell-${info.project.name}.png`, fullPage: false });
});

// 幅: 両方（操作対象がボトムナビ(スマホ)/サイドバー(PC)で分岐）
test("keyboard_navigation_changes_screens_and_moves_focus_to_main", async ({ page }) => {
  await page.goto("/app");
  const phone = isPhone(page.viewportSize());
  const target = phone ? page.getByTestId("bottom-nav").getByRole("link", { name: "マップ" }) : page.locator("aside").getByRole("link", { name: "マップ・水利" });
  await target.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/app\/map$/);
  await expect(page.locator("#main")).toBeFocused();
  if (phone) await expect(page.getByTestId("bottom-nav").getByRole("link", { name: "マップ" })).toHaveAttribute("aria-current", "page");
  else await expect(page.getByRole("heading", { level: 1, name: "消防水利・施設マップ" })).toBeVisible();
  // サブ画面でも直接開ける（SPAのfallback）
  await page.goto("/app/facilities/abc");
  await expect(page.getByRole("heading", { level: phone ? 2 : 1, name: "施設の詳細" })).toBeVisible();
});

// 幅: phone限定（メニュータブはスマホ幅のみの画面。desktopでは実行しない＝T085b設定側の仕分け）
test("mobile_menu_tab_shows_profile_and_tiles", async ({ page }) => {
  await page.goto("/app");
  await page.getByTestId("bottom-nav").getByRole("link", { name: "メニュー" }).click();
  await expect(page).toHaveURL(/\/app\/menu$/);
  await expect(page.getByRole("heading", { level: 2, name: "メニュー" })).toBeVisible();
  await expect(page.getByRole("link", { name: /団員名簿/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /ログアウト/ })).toBeEnabled(); // PH1で有効化
  // 2列グリッド
  const a = await page.getByRole("link", { name: /団員名簿/ }).boundingBox();
  const b = await page.getByRole("link", { name: /車両・資機材/ }).boundingBox();
  expect(b!.x).toBeGreaterThan(a!.x + a!.width - 2);
  expect(Math.abs(b!.y - a!.y)).toBeLessThan(2);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

// 幅: desktop限定（内容の断言のみで幅で変わる構成・寸法は無い。見出しはPCヘッダーのh1）
test("help_screen_shows_concise_guide_chapters_without_placeholder", async ({ page }) => {
  await page.goto("/app/help");
  await expect(page.getByRole("heading", { level: 1, name: "使い方ガイド" })).toBeVisible();
  // USER_GUIDEと同じ章立て（導入/通常利用/点検/通知/承認/通信断/復旧＋困ったとき）
  for (const h of [
    "導入（はじめて使うとき）",
    "通常利用（ホーム・出欠・名簿・お知らせ）",
    "点検（施設・資機材・異常・訂正）",
    "通知（受け取る・送る）",
    "承認（AIの提案・帳票）",
    "通信断（圏外・つながらないとき）",
    "復旧（通信が戻った・競合したとき）",
    "困ったとき",
  ]) {
    await expect(page.getByRole("heading", { level: 3, name: h })).toBeVisible();
  }
  await expect(page.getByText("未実装")).toHaveCount(0);
});

// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("api_paths_return_json_never_the_spa", async ({ request }) => {
  // 末尾スラッシュなしの /api も、assetsのSPA fallbackより先にWorkerへ届く（run_worker_first）
  const bare = await request.get("/api");
  expect(bare.status()).toBe(404);
  expect(bare.headers()["content-type"]).toContain("application/json");
  const res = await request.get("/api/v1/does-not-exist");
  expect(res.status()).toBe(404);
  expect(res.headers()["content-type"]).toContain("application/json");
  expect((await res.json()).error.code).toBe("NOT_FOUND");
  const auth = await request.get("/api/auth/anything");
  expect(auth.headers()["content-type"]).not.toContain("text/html");
});
