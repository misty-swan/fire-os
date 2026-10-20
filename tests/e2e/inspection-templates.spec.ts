import { expect, test } from "@playwright/test";

/**
 * 点検様式の版・承認（T028、SCR-17の点検様式パネル）。
 * 編集で新しい下書き版を作り、申請→承認で現在版が切り替わる。承認済みの版は変わらない。
 */

// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("template_edit_creates_new_draft_version", async ({ page }) => {
  await page.goto("/app/admin");
  const panel = page.getByLabel("点検様式");

  // 様式を作成（検証用の設定。実団体の正式様式ではない旨が表示される）
  await panel.getByRole("button", { name: "様式を追加" }).click();
  const unique = crypto.randomUUID().slice(0, 6);
  await panel.getByLabel("様式名").fill(`試験様式 ${unique}`);
  await panel.getByLabel("項目（JSON）").fill(JSON.stringify([
    { code: "exterior", label: "本体の外観", valueType: "select", required: true, allowedResults: ["ok", "needs_review"] },
  ]));
  await panel.getByRole("button", { name: "作成する" }).click();
  await expect(panel.getByText(`試験様式 ${unique}`)).toBeVisible();
  await expect(panel.getByText("新しい下書き版", { exact: false })).toHaveCount(0); // まだ編集していない

  // 編集 → 新しい下書き版（必須項目の追加）
  const card = panel.locator("div.rounded-card", { hasText: `試験様式 ${unique}` }).last();
  await card.getByRole("button", { name: /編集（新しい版）/ }).click();
  await card.getByLabel("項目（JSON）").fill(JSON.stringify([
    { code: "exterior", label: "本体の外観", valueType: "select", required: true, allowedResults: ["ok", "needs_review"] },
    { code: "water_level", label: "水位", valueType: "number", required: true },
  ]));
  await card.getByRole("button", { name: "新しい下書き版を作成" }).click();
  await expect(page.getByText("新しい下書き版を作成しました")).toBeVisible();
  // 新しい版のラベル「rev2」はトーストと別同期で描画されるため、ポーリング断言で待つ
  // （T083ラウンド4。旧断言はbody.textContentの1回きり評価で、描画が遅い実行ではトースト時に
  // rev2が未描画のままfalseになっていた＝documents.specのトースト断言と同じ非ポーリング断言クラス）
  await expect(card.getByText("rev2")).toBeVisible();

  // 旧版（rev1）は承認済みにならない＝過去の点検の表示が変わらない。申請→承認でrev2だけが承認される
  await card.getByRole("button", { name: "申請" }).last().click();
  await expect(page.getByText("申請しました。")).toBeVisible();
  await card.getByRole("button", { name: "承認" }).click();
  await page.waitForTimeout(300);
  await expect(page.getByText("承認しました。この版が現在の承認版です。")).toBeVisible();
  await expect(card.getByText("現在の承認版")).toHaveCount(1); // 承認済みは1版だけ

  // 未認証の様式として偽装しない旨の注記が常にある（D06未承認）
  await expect(panel.getByText(/検証用の設定/)).toBeVisible();
});
