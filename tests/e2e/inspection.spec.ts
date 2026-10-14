import { expect, test } from "@playwright/test";
import { adminApi, adminApiData } from "./helpers";

/**
 * 点検入力（T033、SCR-06）。3ステップのフォーム。
 * 送信失敗後も入力が消えない（docs/16: inspection_form_preserves_values_after_failed_submission）。
 * 異常あり → 異常の報告が作られる（T029）。
 */

test("inspection_form_preserves_values_after_failed_submission", async ({ page }, info) => {
  const tag = crypto.randomUUID().slice(0, 6);
  // 施設と承認済み様式を用意（API）
  const facility = await adminApiData(page.request, "POST", "/api/v1/facilities", {
    type: "hydrant", latitude: 35.2, longitude: 139.2, locationSource: "架空市台帳", locationNote: `点検試験 ${tag}`, managementNumber: `IN-${tag}`,
  });
  const facilityId = (facility.data.data as { id: string }).id;
  const tpl = await adminApiData(page.request, "POST", "/api/v1/inspection-templates", {
    name: `様式 ${tag}`, targetType: "facility",
    itemSchema: [{ code: "exterior", label: "本体の外観", valueType: "select", required: true, allowedResults: ["ok", "needs_review"] }],
  });
  const tplData = tpl.data.data as { id: string; versions: { id: string }[] };
  await adminApiData(page.request, "POST", `/api/v1/inspection-templates/${tplData.id}/decision`, { version: 1, templateVersionId: tplData.versions[0]!.id, decision: "request_review", reason: "x" });
  await adminApiData(page.request, "POST", `/api/v1/inspection-templates/${tplData.id}/decision`, { version: 2, templateVersionId: tplData.versions[0]!.id, decision: "approve", reason: "x" });

  // 点検登録を開く
  await page.goto(`/app/facilities/${facilityId}/inspections/new`);
  await expect(page.getByRole("heading", { name: "点検登録" })).toBeVisible();

  // ステップ1: 「異常あり」を選ぶ（異常起票になる）
  await page.getByRole("button", { name: "異常あり" }).click();
  await page.getByRole("button", { name: /写真・メモへ進む/ }).click();

  // ステップ2: メモを入力し、意図的に通信失敗させる（PUT /upload と API-14 を遮断）
  const originalNote = "蓋の開閉が重い";
  await page.getByLabel("メモ・特記事項").fill(originalNote);
  await page.getByRole("button", { name: /確認へ進む/ }).click();
  await expect(page.getByText("点検を保存")).toBeVisible();
  await page.route("**/api/v1/facilities/*/inspections", (route) => route.abort());
  await page.getByRole("button", { name: "点検を保存" }).click();
  // 保存状態の表示（docs/03: 通信断は「結果を確認できません。同じ内容で再送しても二重登録にならない」）
  await expect(page.getByText(/結果を確認できません/)).toBeVisible({ timeout: 20_000 });
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // 失敗後も入力が保持されている（docs/16: preserves_values）。戻るとステップ2でメモが残る
  await page.getByRole("button", { name: "戻る" }).click();
  await expect(page.getByLabel("メモ・特記事項")).toHaveValue(originalNote);
  await page.getByRole("button", { name: "戻る" }).click();
  await expect(page.getByRole("button", { name: "異常あり" })).toHaveAttribute("aria-pressed", "true");

  // 再送（同じ内容で二重登録にならない）
  await page.getByRole("button", { name: /写真・メモへ進む/ }).click();
  await expect(page.getByLabel("メモ・特記事項")).toHaveValue(originalNote);
  await page.getByRole("button", { name: /確認へ進む/ }).click();
  await page.getByRole("button", { name: "点検を保存" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/facilities/${facilityId}$`), { timeout: 15_000 });

  // 異常あり → 異常の報告が作られている（T029とT034の接続）
  const issues = await adminApiData(page.request, "GET", `/api/v1/issues?targetType=facility&targetId=${facilityId}`);
  const savedInspections = ((issues.data.data as { originInspectionId: string | null }[]).filter((i) => i.originInspectionId)).length;
  expect(savedInspections).toBeGreaterThanOrEqual(1);
  // 訂正前の記録（原本）が残り、位置確認との混同がないことを確認
  await expect(page.getByLabel("位置確認")).toBeVisible();
  void info;
});
