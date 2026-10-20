import { expect, test, type APIRequestContext } from "@playwright/test";
import { adminApi, adminApiData, BASE } from "./helpers";

/**
 * AIレビュー（T055、SCR-18 /app/ai/reviews。docs/03 §2 SCR-18「元版変化はstale、効果対象を承認前に表示」、
 * docs/06 §3「レビューには原文、元の版、AI候補、確定予定値、対象タスク/通知、現権限を表示」）。
 *
 * 点検登録（SCR-06）で異常あり→起点異常→施設詳細の導線からSCR-18へ入り、分類を依頼→処理中→
 * 原文/AI候補/要確認（保留度）/効果（確定予定値）を確認→別端末（同じブラウザ文脈のAPI）で元の異常を更新→
 * 旧候補の承認は無効（強制承認の抜け道も無い）→現行版で再生成→編集承認で初めて業務へ反映（タスク1件）。
 *
 * - 元の記録が更新された後の候補は「元の記録が更新されています」を表示し、承認操作を無効にする
 *   （ai_evaluations側のstale遷移は未実装のため、画面が表示時に元の現行版と候補のsource_versionを
 *   比較する＝docs/16 T055裁定。サーバー側の最終防御はAPI-31の409＝T054試験済みで、ここでもAPIで直接確認する）。
 * - タスクは承認された候補からだけ作られる（approvedTaskCount=1）。stale候補・未承認案からは作らない。
 * - 候補の作成は実API経由（API-29→job→ローカルCronトリガ→API-30）のみ。ai_evaluationsの直接INSERTは使わない。
 *   localのwrangler devにはAI bindingが無いため、試験専用のfake AI（src/server/ai/local-fake.ts。
 *   playwright.config.tsのwebServerだけが TEST_AI_FAKE=1 を付ける）が決定的な候補を作る。
 */

/** ローカル開発用のCron手動トリガ（本番は毎分自動で走る同じhandleScheduled。docs/03 §1.1-14） */
async function runLocalCron(request: APIRequestContext): Promise<void> {
  await request.fetch(`${BASE}/cdn-cgi/local/scheduled`);
}

// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("stale_proposal_requires_regeneration_not_forced_approval", async ({ page }) => {
  test.setTimeout(300_000);
  const tag = crypto.randomUUID().slice(0, 6);
  const note = `格納箱の前に資材が置かれていた ${tag}`;
  const taskTitle = `AI分類の確認 ${tag}`;

  // --- seed: 施設と承認済み様式（API。issues.spec.tsと同じ作り方） ---
  const facility = await adminApiData<{ id: string }>(page.request, "POST", "/api/v1/facilities", {
    type: "hydrant", latitude: 35.4, longitude: 139.4, locationSource: "架空市台帳",
    locationNote: `AI試験 ${tag}`, managementNumber: `AI-${tag}`,
  });
  expect(facility.status).toBe(201);
  const facilityId = facility.data.data.id;
  const tpl = await adminApiData<{ id: string; versions: { id: string }[] }>(page.request, "POST", "/api/v1/inspection-templates", {
    name: `様式 ${tag}`, targetType: "facility",
    itemSchema: [{ code: "exterior", label: "本体の外観", valueType: "select", required: true, allowedResults: ["ok", "needs_review"] }],
  });
  expect(tpl.status).toBe(201);
  const tplData = tpl.data.data;
  await adminApiData(page.request, "POST", `/api/v1/inspection-templates/${tplData.id}/decision`, { version: 1, templateVersionId: tplData.versions[0]!.id, decision: "request_review", reason: "x" });
  await adminApiData(page.request, "POST", `/api/v1/inspection-templates/${tplData.id}/decision`, { version: 2, templateVersionId: tplData.versions[0]!.id, decision: "approve", reason: "x" });

  // --- 1) 点検登録（SCR-06）: 異常ありを選ぶとステップ2にAI分類の候補枠（紫）が出る（docs/03 §1.1の語彙） ---
  await page.goto(`/app/facilities/${facilityId}/inspections/new`);
  await page.getByRole("button", { name: `様式 ${tag}` }).click();
  await page.getByRole("button", { name: "異常あり" }).click();
  await page.getByRole("button", { name: /写真・メモへ進む/ }).click();
  await expect(page.getByText("AIによる分類候補")).toBeVisible();
  await page.getByLabel("メモ・特記事項").fill(note);
  await page.getByRole("button", { name: /確認へ進む/ }).click();
  await page.getByRole("button", { name: "点検を保存" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/facilities/${facilityId}$`), { timeout: 15_000 });

  // --- 2) 起点異常（点検の保存で作られた異常）を特定する。未承認の間は確定分類を持たない ---
  const issues = await adminApiData<{ id: string; version: number; confirmedCategory: string | null }[]>(
    page.request, "GET", `/api/v1/issues?targetType=facility&targetId=${facilityId}`,
  );
  expect(issues.data.data).toHaveLength(1); // 新規施設なので起点つきは必ず1件（二重登録の検出も兼ねる）
  const issue = issues.data.data[0]!;
  expect(issue.version).toBe(1);
  expect(issue.confirmedCategory).toBeNull(); // 未承認案を確定済み分類として表示しない（docs/16 T055）

  // --- 3) 施設詳細の異常報告の枠からSCR-18へ（点検→AIレビューの導線。docs/16 T055裁定④） ---
  await page.goto(`/app/facilities/${facilityId}`);
  const reviewLink = page.getByRole("link", { name: "AI分類をレビュー" });
  await expect(reviewLink).toBeVisible();
  await reviewLink.click();
  await expect(page).toHaveURL(/\/app\/ai\/reviews/);

  // --- 4) 分類を依頼（API-29）。202=永続jobの受付で完了ではない（docs/05 §1） ---
  const requestButton = page.getByRole("button", { name: "AI分類を依頼" });
  await expect(requestButton).toBeEnabled();
  await requestButton.click();
  await expect(page.getByText(/処理中/).first()).toBeVisible({ timeout: 15_000 });

  // --- 5) ローカルCronでjobを実行して候補を作る（notifications.specと同じ流儀） ---
  const candidateLink = page.getByRole("link", { name: /分類の候補 v1/ }).first();
  await expect(async () => {
    await runLocalCron(page.request);
    await expect(candidateLink).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 90_000 });
  await candidateLink.click();

  // --- 6) 詳細: 原文／元の版／AI候補／要確認（保留度）／効果（確定予定値）／現権限を表示する ---
  const candidateId = new URL(page.url()).pathname.split("/").pop()!;
  await expect(page.getByText(note)).toBeVisible(); // 原文（issue源はAPI-15の本文）
  await expect(page.getByText("元の版")).toBeVisible();
  await expect(page.getByText("接近障害").first()).toBeVisible(); // AI候補の代表分類（fakeの決定的な値）
  await expect(page.getByText(/保留度/)).toBeVisible(); // 要確認（Jevのnoul。confidenceを正答保証として表示しない）
  await expect(page.getByText("承認後の確定（予定）")).toBeVisible(); // 効果対象の承認前表示（docs/03 SCR-18）
  const categorySelect = page.getByLabel("承認後の確定分類");
  await expect(categorySelect).toHaveValue("access_obstruction"); // 既定はAI候補。人の選択が既定にならない
  await expect(page.getByText(/現権限/)).toBeVisible();

  // --- 7) 別端末で元の異常を更新する（同じブラウザ文脈のAPI＝他端末相当。issues.spec.tsの並行操作の型） ---
  const patched = await adminApiData(page.request, "PATCH", `/api/v1/issues/${issue.id}`, {
    version: issue.version, status: "under_review", reason: "e2e: 別端末で内容を確認した（架空）",
  });
  expect(patched.status).toBe(200);

  // --- 8) 旧候補はstale表示になり、承認操作は無効（強制承認の抜け道も無い。docs/16 T055裁定①） ---
  await page.reload();
  await expect(page.getByText("元の記録が更新されています")).toBeVisible();
  const staleForceApprovalAvailable = await page.getByRole("button", { name: "候補どおり承認" }).isEnabled();
  expect(staleForceApprovalAvailable).toBe(false);
  await expect(page.getByRole("button", { name: "修正して承認" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "却下" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "現行版で再生成" })).toBeEnabled();

  // --- 9) 旧候補を承認しようとしても、サーバーが409で拒否し効果は0（T054の防御をAPI経由でも確認） ---
  const staleApproval = await adminApi(page.request, "POST", `/api/v1/ai/reviews/${candidateId}/decision`, {
    version: 1, sourceVersion: issue.version, decision: "approve", confirmedPayload: {},
  });
  expect(staleApproval.status).toBe(409);
  const tasksAfterStale = await adminApiData<{ title: string }[]>(page.request, "GET", "/api/v1/tasks/me?limit=200");
  expect(tasksAfterStale.data.data.filter((t) => t.title === taskTitle)).toHaveLength(0);

  // --- 10) 現行版で再生成（API-29の再依頼。新しいjob/候補。旧候補はstale表示のまま残る＝docs/11） ---
  await page.getByRole("button", { name: "現行版で再生成" }).click();
  await expect(page.getByText(/処理中/).first()).toBeVisible({ timeout: 15_000 });
  const regeneratedLink = page.getByRole("link", { name: /分類の候補 v2/ }).first();
  await expect(async () => {
    await runLocalCron(page.request);
    await expect(regeneratedLink).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 90_000 });

  // 新しい候補（現行版v2）はstale表示が無く、承認できる
  await regeneratedLink.click();
  await expect(page.getByText("元の記録が更新されています")).toHaveCount(0);
  await expect(page.getByText(`v${issue.version + 1}`).first()).toBeVisible(); // 元の版が現行版と一致
  // 旧候補はstale表示のまま残る（旧決定書換なし。再生成で消さない）
  await page.goto(`/app/ai/reviews/${candidateId}`);
  await expect(page.getByText("元の記録が更新されています")).toBeVisible();

  // --- 11) 編集承認: 人の確定分類をAI候補から変えて承認する（AIは候補を出すだけで、決めるのは人） ---
  await page.goto("/app/ai/reviews?source=issue%3A" + issue.id);
  await page.getByRole("link", { name: /分類の候補 v2/ }).click();
  await page.getByLabel("承認後の確定分類").selectOption("equipment_issue");
  await page.getByLabel("タスクの題名").fill(taskTitle);
  await page.getByRole("button", { name: "修正して承認" }).click();
  const dialog = page.getByRole("dialog", { name: "このAI候補を確定しますか" });
  await expect(dialog.getByText("設備の問題")).toBeVisible(); // 確定予定値（confirmed_categoryになる値）
  await expect(dialog.getByText(taskTitle)).toBeVisible(); // 作られるタスク（担当/期限つき）
  await dialog.getByRole("button", { name: "修正して承認" }).click();
  await expect(page.getByText("保存しました").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("修正承認済み").first()).toBeVisible({ timeout: 15_000 });

  // --- 12) 業務への反映はこの承認だけ: タスクは1件、確定分類は異常側に記録される ---
  const tasks = await adminApiData<{ title: string }[]>(page.request, "GET", "/api/v1/tasks/me?limit=200");
  const approvedTaskCount = tasks.data.data.filter((t) => t.title === taskTitle).length;
  expect(approvedTaskCount).toBe(1);
  const after = await adminApiData<{ confirmedCategory: string | null }[]>(
    page.request, "GET", `/api/v1/issues?targetType=facility&targetId=${facilityId}`,
  );
  expect(after.data.data[0]!.confirmedCategory).toBe("equipment_issue");
});
