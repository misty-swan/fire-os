import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { adminApiData } from "./helpers";

/**
 * 点検の入力・訂正（T033の残作業をT085で接続。SCR-06／SCR-23、API-14/20/46、docs/03 SCR-23「資産点検様式/明細/写真/コメント/訂正」）。
 * - 応答が失われた保存を画面から送り直しても二重登録にならない（同じ内容＝同じ送信鍵。docs/03 §1「結果を確認できません」）
 * - 資産（車両）の点検を記録し、履歴から訂正する。訂正は新しい原本で、元の原本は書き換えない（docs/11 §3）
 * データはすべて架空。
 */

async function approvedTemplate(request: APIRequestContext, targetType: "facility" | "vehicle", name: string, code: string, label: string) {
  const tpl = await adminApiData<{ id: string; versions: { id: string }[] }>(request, "POST", "/api/v1/inspection-templates", {
    name, targetType,
    itemSchema: [{ code, label, valueType: "select", required: true, allowedResults: ["ok", "needs_review"] }],
  });
  expect(tpl.status).toBe(201);
  const t = tpl.data.data;
  await adminApiData(request, "POST", `/api/v1/inspection-templates/${t.id}/decision`, { version: 1, templateVersionId: t.versions[0]!.id, decision: "request_review", reason: "架空の確認" });
  const ok = await adminApiData(request, "POST", `/api/v1/inspection-templates/${t.id}/decision`, { version: 2, templateVersionId: t.versions[0]!.id, decision: "approve", reason: "架空の承認" });
  expect(ok.status).toBe(200);
  return t;
}

/** 保存の応答だけを1回失わせる（サーバーには届いて適用される）。戻り値は届いた回数を数える関数 */
async function loseNextResponse(page: Page, pattern: string): Promise<() => number> {
  let forwarded = 0;
  let lost = false;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    forwarded++;
    if (lost) return route.continue();
    lost = true;
    await route.fetch();
    await route.abort();
  });
  return () => forwarded;
}

test("inspection_retry_after_lost_response_registers_once_and_correction_keeps_the_original", async ({ page }) => {
  const tag = crypto.randomUUID().slice(0, 6);
  const facility = await adminApiData<{ id: string }>(page.request, "POST", "/api/v1/facilities", {
    type: "hydrant", latitude: 35.21, longitude: 139.21, locationSource: "架空市台帳", locationNote: `再送試験 ${tag}`, managementNumber: `RT-${tag}`,
  });
  const facilityId = facility.data.data.id;
  await approvedTemplate(page.request, "facility", `再送様式 ${tag}`, "exterior", "本体の外観");

  // --- 1) 点検登録（SCR-06）。保存の応答だけが失われる ---
  await page.goto(`/app/facilities/${facilityId}/inspections/new`);
  await expect(page.getByRole("heading", { name: "点検登録" })).toBeVisible();
  await page.getByRole("button", { name: `再送様式 ${tag}` }).click();
  await page.getByRole("button", { name: "良好" }).click();
  await page.getByRole("button", { name: /写真・メモへ進む/ }).click();
  await page.getByLabel("メモ・特記事項").fill(`再送の確認 ${tag}`);
  await page.getByRole("button", { name: /確認へ進む/ }).click();
  const forwarded = await loseNextResponse(page, "**/api/v1/facilities/*/inspections");
  await page.getByRole("button", { name: "点検を保存" }).click();
  await expect(page.getByText(/結果を確認できません/)).toBeVisible({ timeout: 20_000 });
  // 画面の案内どおり、同じ内容のまま送り直す（ここで二重登録が起きてはいけない）
  await page.getByRole("button", { name: "点検を保存" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/facilities/${facilityId}$`), { timeout: 20_000 });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  expect(forwarded()).toBe(2); // 2回とも届いている
  const afterRetry = await adminApiData<{ id: string; isCurrent: boolean }[]>(page.request, "GET", `/api/v1/facilities/${facilityId}/inspections`);
  expect(afterRetry.data.data).toHaveLength(1); // 業務効果は1回

  // --- 2) 施設詳細（SCR-04）から現在の点検を訂正する（SCR-06の訂正モード。API-46） ---
  const original = afterRetry.data.data[0]!;
  await expect(page.getByRole("link", { name: "点検を訂正する" })).toBeVisible();
  await page.getByRole("link", { name: "点検を訂正する" }).click();
  await expect(page.getByRole("main").getByText("点検の訂正", { exact: true })).toBeVisible();
  // 元の結果が入った状態で始まる（良好）。異常ありに直す
  await expect(page.getByRole("button", { name: "良好" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "異常あり" }).click();
  await page.getByRole("button", { name: /写真・メモへ進む/ }).click();
  await page.getByRole("button", { name: /確認へ進む/ }).click();
  // 理由が無いと保存できない
  await expect(page.getByRole("button", { name: "訂正を保存" })).toBeDisabled();
  await page.getByLabel("訂正の理由（必須）").fill("結果の記入を誤った（架空）");
  await page.getByRole("button", { name: "訂正を保存" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/facilities/${facilityId}$`), { timeout: 20_000 });
  const afterFix = await adminApiData<{ id: string; isCurrent: boolean; supersedesId: string | null; result: string }[]>(page.request, "GET", `/api/v1/facilities/${facilityId}/inspections`);
  expect(afterFix.data.data).toHaveLength(2);
  const current = afterFix.data.data.find((r) => r.isCurrent)!;
  expect(current).toMatchObject({ supersedesId: original.id, result: "needs_review" });
  expect(afterFix.data.data.find((r) => r.id === original.id)).toMatchObject({ isCurrent: false, result: "ok" }); // 原本は不変
  // 施設詳細の点検結果は現在版（訂正後）を示す
  await expect(page.getByLabel("状態").getByText("異常あり")).toBeVisible();
  // 施設詳細に点検の記録が時系列で出る（訂正前の原本は「訂正済み」として残る。MAP-06）
  const facilityHistory = page.getByRole("list", { name: "点検の記録" });
  await expect(facilityHistory.getByRole("listitem")).toHaveCount(2);
  await expect(facilityHistory.getByText("訂正済み")).toBeVisible();
  await expect(facilityHistory.getByText("訂正後の記録")).toBeVisible();
});

test("asset_inspection_records_photo_and_corrects_from_history_without_overwriting", async ({ page }, info) => {
  const tag = crypto.randomUUID().slice(0, 6);
  const vehicle = await adminApiData<{ id: string }>(page.request, "POST", "/api/v1/vehicles", { assetCode: `V-${tag}`, name: `架空ポンプ車 ${tag}`, status: "運用" });
  expect(vehicle.status).toBe(201);
  const vehicleId = vehicle.data.data.id;
  await approvedTemplate(page.request, "vehicle", `車両様式 ${tag}`, "lights", "灯火類");

  // --- 1) 資産の詳細（SCR-14）から点検登録（SCR-23）へ ---
  await page.goto(`/app/assets/vehicle/${vehicleId}`);
  await page.getByRole("link", { name: "点検を記録する" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/assets/vehicle/${vehicleId}/inspection$`));
  await expect(page.getByRole("heading", { name: "資産の点検登録" })).toBeVisible();
  await page.getByRole("button", { name: `車両様式 ${tag}` }).click();
  await page.getByRole("button", { name: "良好" }).click();
  await page.getByRole("button", { name: /写真・メモへ進む/ }).click();

  // 写真（検査が済んだものだけを点検と一緒に保存する）
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await page.locator('input[type="file"]').setInputFiles({ name: "lights.png", mimeType: "image/png", buffer: png });
  await expect(page.getByText("準備完了")).toBeVisible({ timeout: 60_000 });
  await page.getByLabel("メモ・特記事項").fill(`灯火類を確認（架空） ${tag}`);
  await page.getByRole("button", { name: /確認へ進む/ }).click();
  await expect(page.getByText("1件（検査済み）")).toBeVisible();
  // 応答だけが失われても、送り直しで二重登録にならない
  const forwarded = await loseNextResponse(page, "**/api/v1/asset-inspections");
  await page.getByRole("button", { name: "点検を保存" }).click();
  await expect(page.getByText(/結果を確認できません/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "点検を保存" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/assets/vehicle/${vehicleId}$`), { timeout: 20_000 });
  await page.unrouteAll({ behavior: "ignoreErrors" });
  expect(forwarded()).toBe(2);

  type Row = { id: string; isCurrent: boolean; supersedesId: string | null; result: string; note: string };
  const detail1 = await adminApiData<{ inspections: Row[] }>(page.request, "GET", `/api/v1/assets/vehicle/${vehicleId}`);
  expect(detail1.data.data.inspections).toHaveLength(1);
  const original = detail1.data.data.inspections[0]!;

  // --- 2) 履歴（SCR-14）に記録が出る。現在の記録から訂正へ ---
  const history = page.getByRole("list", { name: "点検の記録" });
  await expect(history.getByRole("listitem")).toHaveCount(1);
  await expect(history.getByText("良好")).toBeVisible();
  await history.getByRole("link", { name: "訂正する" }).click();
  await expect(page.getByRole("main").getByText("点検の訂正", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/app/assets/vehicle/${vehicleId}/inspection\\?correct=${original.id}$`));
  await page.getByRole("button", { name: "異常あり" }).click();
  await page.getByRole("button", { name: /写真・メモへ進む/ }).click();
  await expect(page.getByLabel("メモ・特記事項")).toHaveValue(`灯火類を確認（架空） ${tag}`); // 元のメモが入っている
  await page.getByLabel("メモ・特記事項").fill(`左の尾灯が点かない（架空） ${tag}`);
  await page.getByRole("button", { name: /確認へ進む/ }).click();
  await page.getByLabel("訂正の理由（必須）").fill("見落としていた不点灯を追記（架空）");
  await page.getByRole("button", { name: "訂正を保存" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/assets/vehicle/${vehicleId}$`), { timeout: 20_000 });

  // --- 3) 訂正は新しい原本。元の原本は残り、現在版だけが訂正の対象 ---
  const detail2 = await adminApiData<{ inspections: Row[] }>(page.request, "GET", `/api/v1/assets/vehicle/${vehicleId}`);
  const rows = detail2.data.data.inspections;
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ isCurrent: true, supersedesId: original.id, result: "needs_review" });
  expect(rows[1]).toMatchObject({ id: original.id, isCurrent: false, result: "ok", note: `灯火類を確認（架空） ${tag}` });
  await expect(history.getByRole("listitem")).toHaveCount(2);
  await expect(history.getByText("訂正済み")).toBeVisible();
  await expect(history.getByRole("link", { name: "訂正する" })).toHaveCount(1); // 訂正済みの原本には訂正の導線を出さない
  void info;
});
