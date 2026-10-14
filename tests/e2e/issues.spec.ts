import { expect, test } from "@playwright/test";
import { adminApi, adminApiData } from "./helpers";

/**
 * 異常一覧（T034、SCR-07）。状態は文字と色で表す。
 * 位置の確認・点検結果・異常対応を混同しない（docs/16: issue_state_does_not_appear_as_location_verified）。
 */

test("issue_state_does_not_appear_as_location_verified", async ({ page }) => {
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
  const memberId = (me.data.data as { profile: { memberId: string } }).profile.memberId;
  await adminApiData(page.request, "POST", `/api/v1/facilities/${facilityId}/inspections`, {
    templateVersionId: tplData.versions[0]!.id, inspectedAt: new Date().toISOString(),
    inspectorMemberId: memberId, result: "needs_review",
    checkItems: [{ code: "exterior", result: "needs_review" }], note: "蓋の開閉不良", createIssue: true, attachmentIds: [],
  });

  // 異常一覧を開く
  await page.goto("/app/issues");
  await expect(page.getByText("点検で異常を確認").first()).toBeVisible({ timeout: 10_000 });
  // 状態チップ（文字）が見える: 確認待ち
  await expect(page.getByText("確認待ち").first()).toBeVisible();

  // 担当変更→終了→再開を操作する（API-17を直接叩き、一覧の文字が変わることを確認）
  const issues = await adminApiData(page.request, "GET", `/api/v1/issues?targetType=facility&targetId=${facilityId}`);
  const issue = (issues.data.data as { id: string; version: number; status: string }[])[0]!;
  let v = issue.version;
  for (const [status, reason] of [["under_review", "確認を始めた"], ["in_progress", "修繕を始めた"], ["resolved", "修繕した"], ["closed", "確認を終了"]] as const) {
    const r = await adminApiData(page.request, "PATCH", `/api/v1/issues/${issue.id}`, { version: v, status, reason });
    expect(r.status).toBe(200);
    v = (r.data.data as { version: number }).version;
  }
  await page.reload();
  // 終了（確認終了）の文字が表示される
  await expect(page.getByText("確認終了").first()).toBeVisible();

  // 施設詳細で「位置：未確認」と「異常対応：確認終了」が混同されず表示される
  await page.goto(`/app/facilities/${facilityId}`);
  await expect(page.getByText("位置：未確認")).toBeVisible();
  await expect(page.getByText("異常一覧へ")).toBeVisible();
  // 使用可能（AI判定）の表示は存在しない（docs/16: toHaveCount(0)）
  expect(await page.getByText("使用可能（AI判定）").count()).toBe(0);
});
