import { expect, test } from "@playwright/test";

// 実ブラウザでの表示確認（360px=スマホ / 1280px=PC）。実体は wrangler dev(ローカルのWorkers)＋ビルド済みReact。
const isPhone = (viewport: { width: number } | null) => (viewport?.width ?? 0) < 1024;

test("shell_layout_matches_the_viewport", async ({ page }, info) => {
  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1, name: "ホーム" })).toBeVisible();
  const phone = isPhone(page.viewportSize());

  const bottomNav = page.getByTestId("bottom-nav");
  const sidebar = page.locator("aside nav[aria-label='主要メニュー']");
  if (phone) {
    await expect(bottomNav).toBeVisible();
    await expect(sidebar).toBeHidden();
    await expect(page.getByRole("button", { name: "メニューを開く" })).toBeVisible();
    // 下部ナビの押せる大きさ（44px以上）
    for (const name of ["ホーム", "地図", "予定・活動", "出動", "管理"]) {
      const box = await bottomNav.getByRole("link", { name }).boundingBox();
      expect(box!.height, name).toBeGreaterThanOrEqual(44);
      expect(box!.width, name).toBeGreaterThanOrEqual(44);
    }
  } else {
    await expect(sidebar).toBeVisible();
    await expect(bottomNav).toBeHidden();
    await expect(page.getByRole("button", { name: "メニューを開く" })).toBeHidden();
    // prototype(Desktop)のサイドバー幅は248px
    expect(Math.round((await page.locator("aside").boundingBox())!.width)).toBe(248);
  }

  // 横スクロールが出ない（360pxでも内容が画面内に収まる）
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `docs/evidence/ph0/shell-${info.project.name}.png`, fullPage: false });
});

test("keyboard_navigation_changes_screens_and_moves_focus_to_main", async ({ page }) => {
  await page.goto("/app");
  const phone = isPhone(page.viewportSize());
  const nav = phone
    ? page.getByTestId("bottom-nav")
    : page.locator("aside nav[aria-label='主要メニュー']");
  const target = nav.getByRole("link", { name: /地図/ }).first();
  await target.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/app\/map$/);
  await expect(page.getByRole("heading", { level: 1, name: "地図" })).toBeVisible();
  await expect(page.locator("#main")).toBeFocused();
  // サブ画面でも直接開ける（SPAのfallback）
  await page.goto("/app/facilities/abc");
  await expect(page.getByRole("heading", { level: 1, name: "施設の詳細" })).toBeVisible();
});

test("mobile_menu_lists_screens_and_closes_with_escape", async ({ page }) => {
  test.skip(!isPhone(page.viewportSize()), "メニューシートはスマホ幅のみ");
  await page.goto("/app");
  const opener = page.getByRole("button", { name: "メニューを開く" });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "メニュー" });
  await expect(dialog.getByRole("link", { name: /団員名簿/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("api_paths_return_json_never_the_spa", async ({ request }) => {
  const res = await request.get("/api/v1/does-not-exist");
  expect(res.status()).toBe(404);
  expect(res.headers()["content-type"]).toContain("application/json");
  expect((await res.json()).error.code).toBe("NOT_FOUND");
  const auth = await request.get("/api/auth/anything");
  expect(auth.headers()["content-type"]).not.toContain("text/html");
});
