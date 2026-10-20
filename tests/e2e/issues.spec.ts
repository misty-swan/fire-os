import { expect, test } from "@playwright/test";
import { adminApiData } from "./helpers";

/**
 * 異常一覧（T034、SCR-07）。状態は文字と色で表す。
 * 状態の操作（担当変更→確認→対応→終了→再開）はUI（API-17の画面）から行う。位置の確認・点検結果・
 * 異常対応を混同しない（docs/16: issue_state_does_not_appear_as_location_verified）。
 */

// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("issue_state_does_not_appear_as_location_verified", async ({ page }) => {
  test.setTimeout(120_000);
  const tag = crypto.randomUUID().slice(0, 6);
  // 未確認位置の施設 + needs_review点検（起点異常つき）
  const facility = await adminApiData(page.request, "POST", "/api/v1/facilities", {
    type: "hydrant", latitude: 35.3, longitude: 139.3, locationSource: "架空市台帳", locationNote: `異常試験 ${tag}`, managementNumber: `IS-${tag}`,
  });
  const facilityId = (facility.data.data as { id: string }).id;
  const tpl = await adminApiData(page.request, "POST", "/api/v1/inspection-templates", {
    name: `様式 ${tag}`, targetType: "facility",
    itemSchema: [{ code: "exterior", label: "本体の外観", valueType: "select", required: true, allowedResults: ["ok", "needs_review"] }],
  });
  const tplData = tpl.data.data as { id: string; versions: { id: string }[] };
  await adminApiData(page.request, "POST", `/api/v1/inspection-templates/${tplData.id}/decision`, { version: 1, templateVersionId: tplData.versions[0]!.id, decision: "request_review", reason: "x" });
  await adminApiData(page.request, "POST", `/api/v1/inspection-templates/${tplData.id}/decision`, { version: 2, templateVersionId: tplData.versions[0]!.id, decision: "approve", reason: "x" });

  const me = await adminApiData(page.request, "GET", "/api/v1/me");
  const meData = me.data.data as { profile: { memberId: string; displayName: string } };
  const memberId = meData.profile.memberId;
  const meName = meData.profile.displayName;
  await adminApiData(page.request, "POST", `/api/v1/facilities/${facilityId}/inspections`, {
    templateVersionId: tplData.versions[0]!.id, inspectedAt: new Date().toISOString(),
    inspectorMemberId: memberId, result: "needs_review",
    checkItems: [{ code: "exterior", result: "needs_review" }], note: `蓋の開閉不良 ${tag}`, createIssue: true, attachmentIds: [],
  });

  // 異常一覧を開く。件名は起票で固定（「点検で異常を確認」）のため、カードはdescription（メモ）で絞る
  await page.goto("/app/issues");
  await expect(page.getByText("点検で異常を確認").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(`蓋の開閉不良 ${tag}`).first()).toBeVisible();

  // 自分の異常のカード（他の試験の異常が混ざるためメモで絞る）。行を押すと展開して操作が出る
  const card = page.locator(".hairline.rounded-card", { hasText: `蓋の開閉不良 ${tag}` }).first();
  await card.getByRole("button", { name: "点検で異常を確認" }).click();
  const actions = card.getByLabel("異常の操作");

  // 担当の変更（UI → API-17 assigneeMemberId）。先頭の選択肢は「未担当」なので自分を選ぶ
  await actions.getByRole("combobox").selectOption({ label: meName });
  await actions.getByRole("button", { name: "担当を更新" }).click();
  await expect(actions.getByRole("button", { name: "担当を外す" })).toBeVisible({ timeout: 10_000 });

  // reported → under_review（UI操作。完了したら一覧が再読込され、次の操作が出る）
  await actions.getByRole("button", { name: "確認する" }).click();
  await expect(actions.getByRole("button", { name: "対応開始" })).toBeVisible({ timeout: 10_000 });

  // under_review → in_progress → resolved
  await actions.getByRole("button", { name: "対応開始" }).click();
  await expect(actions.getByRole("button", { name: "対応実施" })).toBeVisible({ timeout: 10_000 });
  await actions.getByRole("button", { name: "対応実施" }).click();
  await expect(actions.getByRole("button", { name: "確認終了" })).toBeVisible({ timeout: 10_000 });

  // resolved → closed（終了は理由入力必須の確認ダイアログ。既定フォーカスは「戻る」）
  await actions.getByRole("button", { name: "確認終了" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "戻る" })).toBeFocused();
  await dialog.getByLabel("理由（必須）").fill("修繕が済み、現地で確認を終えた");
  await dialog.getByRole("button", { name: "確認終了" }).click();
  await expect(actions.getByRole("button", { name: "再開" })).toBeVisible({ timeout: 10_000 });

  // closed → under_review（再開も理由必須）。under_reviewの操作（対応開始）が再び出る
  await actions.getByRole("button", { name: "再開" }).click();
  await page.getByRole("dialog").getByLabel("理由（必須）").fill("再確認が必要になった");
  await page.getByRole("dialog").getByRole("button", { name: "再開" }).click();
  await expect(actions.getByRole("button", { name: "対応開始" })).toBeVisible({ timeout: 10_000 });

  // 施設詳細で「位置：未確認」と「異常対応」の導線が混同されず表示される
  await page.goto(`/app/facilities/${facilityId}`);
  await expect(page.getByText("位置：未確認")).toBeVisible();
  await expect(page.getByText("異常一覧へ").first()).toBeVisible();
  // 異常報告の枠（件数と最新の件名・状態）
  await expect(page.getByText(/異常報告あり（1件）/)).toBeVisible();
  // 使用可能（AI判定）の表示は存在しない（docs/16: toHaveCount(0)）
  expect(await page.getByText("使用可能（AI判定）").count()).toBe(0);
});
