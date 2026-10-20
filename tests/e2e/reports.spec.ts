import { expect, test, type APIRequestContext } from "@playwright/test";
import { adminApiData, BASE, isPhone } from "./helpers";

/**
 * 報告書の生成・編集・版比較・承認・出力画面（T059、SCR-19 /app/reports/:id/draft、別入口 /app/reports。
 * docs/03 §2 SCR-19「人数/時刻は元実績と比較、承認前配布不可」、docs/06 §4「人編集→新版→承認→配布の順」）。
 *
 * 手動下書き（API-62）→不足欄の「未記載」表示→編集（新draft版）→版比較→申請→承認→PDF/CSV出力→
 * 承認後の再訂正で旧承認版が変わらないこと（docs/11「承認後訂正は新draft版、旧版不変」）までを1本で確認する。
 *
 * - AI生成の依頼（API-32）は押せることを確認し、202は「処理中（完了ではありません）」と表示する（docs/03 §1）。
 *   e2eの環境（TEST_AI_FAKE=1のwrangler dev）には報告書生成のAI bindingが無いため、jobは保留
 *   （manual_review ai_unavailable）に落ちる＝偽の下書きを作らない（T057の設計。docs/evidence/V04-llm.md）。
 *   保留になった後で「手動で作成」の導線を通す（生成が成功したふりをしない）。
 * - 出力（API-61）は承認済み版だけ。downloadイベントでContent-Dispositionのfilename（report-<id>-r<版>.<ext>）
 *   を検査し、出力された版＝承認版（exportedVersionId=approvedVersionId）を確認する。ファイル内容までは断言しない
 *   （PDF/CSVの中身はT058のworkers試験・V07が対象）。
 * - seedは実APIのみ（直接INSERT禁止。ai-review.spec.tsと同じ型）。実績入力のUIそのものはT039（activities.spec.ts）。
 */

/** ローカル開発用のCron手動トリガ（本番は毎分自動で走る同じhandleScheduled。docs/03 §1.1-14） */
async function runLocalCron(request: APIRequestContext): Promise<void> {
  await request.fetch(`${BASE}/cdn-cgi/local/scheduled`);
}

/** API-58の応答（試験で使う列だけに絞った型） */
interface ReportHistoryForTest {
  report: { id: string; currentApprovedVersionId: string | null; currentDraftVersionId: string | null };
  versions: {
    id: string; revisionNo: number; status: string; text: string;
    approvedBy: string | null; approvedAt: string | null;
  }[];
}

test("report_ui_shows_missing_fields_and_only_exports_approved_version", async ({ page }) => {
  test.setTimeout(300_000);
  const tag = crypto.randomUUID().slice(0, 6);

  // --- seed: 管理者（幹部・管理者はPER-03/04/09/10/11を保持）の団員と、過去の活動＋実績（API。実績のUIはT039で試験済み） ---
  const me = await adminApiData<{ profile: { memberId: string } }>(page.request, "GET", "/api/v1/me");
  expect(me.status).toBe(200);
  const adminMemberId = me.data.data.profile.memberId;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const activity = await adminApiData<{ id: string; version: number }>(page.request, "POST", "/api/v1/activities", {
    title: `報告書試験の活動 ${tag}`, kind: "訓練",
    plannedStartsAt: ago(7 * 864e5), plannedEndsAt: ago(7 * 864e5 - 2 * 3600e3),
    locationText: "第三分団詰所・前庭", ownerMemberId: adminMemberId, audienceMemberIds: [adminMemberId],
  });
  expect(activity.status).toBe(201);
  const activityId = activity.data.data.id;
  // 公開（draft→scheduled。公開だけ理由不要＝docs/16 T039）して「過去の活動」として扱う
  const published = await adminApiData(page.request, "PATCH", `/api/v1/activities/${activityId}`, { version: 1, status: "scheduled" });
  expect(published.status).toBe(200);
  const detail = await adminApiData<{ version: number }>(page.request, "GET", `/api/v1/activities/${activityId}`);
  expect(detail.status).toBe(200);
  // 実績。終了時刻（actualEndsAt）は意図的に未記載＝画面の「元実績との比較」で「未記載」を出す（docs/05 §3）
  const createdResult = await adminApiData<{ id: string; version: number }>(
    page.request, "POST", `/api/v1/activities/${activityId}/actual-results`,
    {
      activityVersion: detail.data.data.version,
      content: `ポンプ車操法を実施 ${tag}`,
      actualStartsAt: ago(7 * 864e5 - 3600e3),
      participants: [{ memberId: adminMemberId, actualStatus: "participated" }],
      attachmentIds: [],
    },
  );
  expect(createdResult.status).toBe(201);

  // --- 1) 活動詳細（SCR-09）からの導線: 報告書が無い活動では「報告書を作る」が出る（実績のある活動。docs/03 §3） ---
  await page.goto(`/app/activities/${activityId}`);
  const createLink = page.getByRole("link", { name: "報告書を作る" });
  await expect(createLink).toBeVisible();
  await createLink.click();
  await expect(page).toHaveURL(new RegExp(`/app/reports\\?activity=${activityId}$`));

  // --- 2) この活動の報告書パネル: AI生成を依頼する（API-32。202=受付で報告書の完成ではない。docs/03 §1） ---
  await expect(page.getByText("この活動の報告書")).toBeVisible();
  await page.getByRole("button", { name: "AIで下書き生成" }).click();
  await expect(page.getByText("AIが下書きを作成しています")).toBeVisible({ timeout: 15_000 });

  // --- 3) ローカルCronでjobを消化する。e2eの環境には報告書生成のAIが無いため保留（manual_review）に落ちる ---
  await expect(async () => {
    await runLocalCron(page.request);
    await expect(page.getByText("保留（AIだけで決めない）")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 120_000 });
  // 保留の理由（ai_unavailable）と「手動で作成」の導線が出る（元の実績は変わっていない旨も出す）
  await expect(page.getByText(/この環境ではAIを使えないため/)).toBeVisible();
  const manualButton = page.getByRole("button", { name: "手動で作成" });
  await expect(manualButton).toBeEnabled();

  // --- 4) 手動で下書きを作る（API-62。本文は空白のみ＝様式の必須欄が「未記載」として記録される。
  //      完全な空欄は契約で400（Body min(1)）のため、画面はクライアント検証で送らない＝docs/05 §1） ---
  await manualButton.click();
  const bodyField = page.getByLabel("実施内容");
  await expect(bodyField).toBeVisible();
  await bodyField.fill(" ");
  await page.getByRole("button", { name: "下書きを作成" }).click();
  await expect(page).toHaveURL(/\/app\/reports\/[^/]+\/draft$/, { timeout: 15_000 });
  const reportId = new URL(page.url()).pathname.split("/")[3]!;

  // --- 5) 不足欄は「未記載」として示す（補完しない。docs/06 §4）＋元実績の人数/時刻との比較 ---
  await expect(page.getByText("未記載").first()).toBeVisible();
  await expect(page.getByText(/未記載の欄があります/)).toBeVisible(); // missingFields（様式の必須欄が空白）
  await expect(page.getByText("元の実績との比較")).toBeVisible();
  await expect(page.getByText(/参加人数/).first()).toBeVisible();
  await expect(page.getByText(/終了時刻.*未記載|未記載.*終了時刻/).first()).toBeVisible();

  // 未承認の出力は存在も出力もしない（404＝docs/05 API-61「承認版のみ。未承認はnot 200」）
  const unapprovedExport = await page.request.fetch(
    `${BASE}/api/v1/reports/${reportId}/content?format=pdf`, { headers: { origin: BASE } },
  );
  expect(unapprovedExport.status()).toBe(404);
  // 画面にも承認版が無い間は出力の操作を出さない（押しても何も起きない状態を作らない）
  await expect(page.getByRole("button", { name: "PDFを出力" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "CSVを出力" })).toHaveCount(0);

  // --- 6) 不足修正: 本文を入れて新しい版として保存する（API-59。旧版は不変。docs/11） ---
  await page.getByRole("button", { name: "編集する" }).click();
  await page.getByLabel("実施内容").fill(`ポンプ車操法と放水訓練を実施した ${tag}`);
  await page.getByLabel("訂正の理由").fill("e2e: 空欄だった実施内容を修正した");
  await page.getByRole("button", { name: "新しい版として保存" }).click();
  await expect(page.getByText("保存しました").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "第2版" })).toBeVisible({ timeout: 15_000 });
  // 版比較: 直前の版との差分（行単位の簡易diff）が見える
  await expect(page.getByText("直前の版との差分")).toBeVisible();

  // --- 7) 申請（draft→in_review。決定行は作らない＝docs/11「申請と最終決定の分離」） ---
  await page.getByRole("button", { name: "班長に確認を依頼" }).click();
  await expect(page.getByText("確認待ち").first()).toBeVisible({ timeout: 15_000 });

  // --- 8) 承認（一版一決定。元実績版の再検査＝docs/11「引用元/実績版一致」。承認対象の版を明示してから行う） ---
  await page.getByRole("button", { name: "承認する" }).click();
  const approveDialog = page.getByRole("dialog", { name: "この版を承認しますか" });
  await expect(approveDialog.getByText(/第2版を承認すると/)).toBeVisible();
  // 承認の確定はAPI-60の応答で待つ。旧来の「トースト→『承認済み』」の待ち合わせは、前の保存のトーストが
  // 残っていると先に通り、かつ「承認済み」が**承認前の常時表示**「承認済みの版が無いため…」に部分一致して
  // 先に通るため、直後のAPI-58 GETが承認の確定前に走る競合があった（FLAKE-2a。承認記録の「承認済み」は
  // exact一致で部分一致と区別する）
  const decisionPosted = page.waitForResponse(
    (r) => r.url().endsWith(`/api/v1/reports/${reportId}/decision`) && r.request().method() === "POST",
    { timeout: 30_000 },
  );
  await approveDialog.getByRole("button", { name: "承認する" }).click();
  expect((await decisionPosted).status()).toBe(200);
  await expect(page.getByText("保存しました").first()).toBeVisible({ timeout: 15_000 }); // 成功の可視フィードバック（T083 R4。応答確定後、トーストの寿命2.6秒のうちに）
  await expect(page.getByText("承認済み", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

  // 承認版（currentApprovedVersionId）をAPI-58で確認する
  const afterApprove = await adminApiData<ReportHistoryForTest>(page.request, "GET", `/api/v1/reports/${reportId}`);
  expect(afterApprove.status).toBe(200);
  const approvedVersion = afterApprove.data.data.versions.find((v) => v.id === afterApprove.data.data.report.currentApprovedVersionId);
  expect(approvedVersion).toBeDefined();
  expect(approvedVersion!.status).toBe("approved");
  expect(approvedVersion!.revisionNo).toBe(2);

  // --- 9) 出力（API-61）: 承認版だけがPDF/CSVを出せる。出力された版＝承認版（exportedVersionId=approvedVersionId） ---
  const csvResp = await page.request.fetch(
    `${BASE}/api/v1/reports/${reportId}/content?format=csv`, { headers: { origin: BASE } },
  );
  expect(csvResp.status()).toBe(200);
  expect(csvResp.headers()["content-type"]).toContain("text/csv");
  expect(csvResp.headers()["content-disposition"]).toContain(`-r${approvedVersion!.revisionNo}.csv`);
  const pdfResp = await page.request.fetch(
    `${BASE}/api/v1/reports/${reportId}/content?format=pdf`, { headers: { origin: BASE } },
  );
  expect(pdfResp.status()).toBe(200);
  expect(pdfResp.headers()["content-type"]).toBe("application/pdf");

  // 画面の出力ボタン（downloadイベント。filenameの版が承認版と一致することまで検査する）
  const csvDownloadPromise = page.waitForEvent("download", { timeout: 15_000 });
  await page.getByRole("button", { name: "CSVを出力" }).click();
  const csvFilename = (await csvDownloadPromise).suggestedFilename();
  const exportedRevisionNo = Number(csvFilename.match(/-r(\d+)\.csv$/)![1]);
  // exportedVersionId = approvedVersionId（出力の対象は常に承認済みpointerの版。docs/05 API-61）
  expect(exportedRevisionNo).toBe(approvedVersion!.revisionNo);

  // --- 10) 承認後の再訂正（docs/11「承認後訂正は新draft版」。旧承認版の表示と決定は変わらない） ---
  await page.getByRole("button", { name: "あたらしく訂正する" }).click();
  await page.getByLabel("実施内容").fill(`ポンプ車操法・放水訓練・整備点検を実施した ${tag}`);
  await page.getByLabel("訂正の理由").fill("e2e: 承認後に整備点検の実施を追記した");
  await page.getByRole("button", { name: "新しい版として保存" }).click();
  await expect(page.getByText("保存しました").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "第3版" })).toBeVisible({ timeout: 15_000 });

  // 旧承認版（第2版）の本文と承認記録は不変（previousDecisionChanged=false。docs/11「承認済pointerは次版承認まで保持」）
  await page.getByRole("button", { name: "第2版" }).click();
  await expect(page.getByLabel("第2版の本文").getByText(`ポンプ車操法と放水訓練を実施した ${tag}`)).toBeVisible();
  await expect(page.getByText("承認済み").first()).toBeVisible();

  const afterNewDraft = await adminApiData<ReportHistoryForTest>(page.request, "GET", `/api/v1/reports/${reportId}`);
  expect(afterNewDraft.status).toBe(200);
  const v2 = afterNewDraft.data.data.versions.find((v) => v.id === approvedVersion!.id)!;
  expect(v2.status).toBe("approved");
  expect(v2.approvedBy).toBe(approvedVersion!.approvedBy);
  expect(v2.approvedAt).toBe(approvedVersion!.approvedAt);
  expect(v2.text).toBe(approvedVersion!.text);
  // 出力も引き続き承認版（第2版）。新draft（第3版）を作っただけでは承認済pointerは動かない
  expect(afterNewDraft.data.data.report.currentApprovedVersionId).toBe(approvedVersion!.id);
  const csv2Promise = page.waitForEvent("download", { timeout: 15_000 });
  await page.getByRole("button", { name: "CSVを出力" }).click();
  const csv2Filename = (await csv2Promise).suggestedFilename();
  expect(csv2Filename).toBe(`report-${reportId}-r${approvedVersion!.revisionNo}.csv`);
});

/**
 * 未保存離脱の確認（PH4レビューC 中3）と押下領域（同 中4）。
 * - 手動作成フォーム（manualText）と編集フォーム（editText＋訂正理由）は、入力中に画面を離れると
 *   「保存されていない変更があります」の確認ダイアログを出す（docs/03 §1.1「入力途中の離脱確認」。
 *   activities.specの実績フォームの離脱試験と同じ型。既定=編集に戻る、戻れば入力は保持される）。
 * - 「活動詳細」「元の活動を開く」の紫pillリンクはモバイルで44px以上の押下領域
 *   （docs/03 §1.1-5。AiReviewDetail.tsxの「異常を開く」と同じ `min-h-11 lg:min-h-9` の流儀）。
 *   押下領域の検査はモバイルプロジェクトだけでよい（PCはコンパクト寸法が正のため）。
 * seedは実APIのみ（AI生成を待たないため、手動作成の経路だけを短時間で確認する）。
 */
test("report_forms_warn_on_unsaved_leave_and_links_meet_touch_target", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const tag = crypto.randomUUID().slice(0, 6);
  const viewport = testInfo.project.use.viewport ?? page.viewportSize();

  // --- seed: 過去の活動＋実績（API。実績入力のUIそのものはT039＝activities.spec.tsで試験済み） ---
  const me = await adminApiData<{ profile: { memberId: string } }>(page.request, "GET", "/api/v1/me");
  expect(me.status).toBe(200);
  const adminMemberId = me.data.data.profile.memberId;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const activity = await adminApiData<{ id: string; version: number }>(page.request, "POST", "/api/v1/activities", {
    title: `報告書の離脱試験 ${tag}`, kind: "訓練",
    plannedStartsAt: ago(3 * 864e5), plannedEndsAt: ago(3 * 864e5 - 2 * 3600e3),
    locationText: "第三分団詰所・前庭", ownerMemberId: adminMemberId, audienceMemberIds: [adminMemberId],
  });
  expect(activity.status).toBe(201);
  const activityId = activity.data.data.id;
  const published = await adminApiData(page.request, "PATCH", `/api/v1/activities/${activityId}`, { version: 1, status: "scheduled" });
  expect(published.status).toBe(200);
  const detail = await adminApiData<{ version: number }>(page.request, "GET", `/api/v1/activities/${activityId}`);
  expect(detail.status).toBe(200);
  const createdResult = await adminApiData<{ id: string; version: number }>(
    page.request, "POST", `/api/v1/activities/${activityId}/actual-results`,
    {
      activityVersion: detail.data.data.version,
      content: `ポンプ車操法を実施 ${tag}`,
      actualStartsAt: ago(3 * 864e5 - 3600e3),
      participants: [{ memberId: adminMemberId, actualStatus: "participated" }],
      attachmentIds: [],
    },
  );
  expect(createdResult.status).toBe(201);

  // --- 1) 手動作成フォーム: 入力中に「活動詳細」リンクで離れると確認ダイアログ（既定=編集に戻る） ---
  await page.goto(`/app/reports?activity=${activityId}`);
  const detailLink = page.getByRole("link", { name: "活動詳細" });
  await expect(detailLink).toBeVisible();
  if (isPhone(viewport)) {
    const height = await detailLink.evaluate((el) => el.getBoundingClientRect().height);
    expect(height, "モバイルの押下領域は44px以上（docs/03 §1.1-5）").toBeGreaterThanOrEqual(44);
  }
  await page.getByRole("button", { name: "手動で作成" }).click();
  const manualBody = page.getByLabel("実施内容");
  await manualBody.fill(`手動作成の離脱試験 ${tag}`);
  await detailLink.click();
  const leaveDialog = page.getByRole("dialog", { name: "保存されていない変更があります" });
  await expect(leaveDialog).toBeVisible();
  await leaveDialog.getByRole("button", { name: "編集に戻る" }).click();
  await expect(manualBody).toHaveValue(new RegExp(tag)); // 戻れば入力は保持される
  await detailLink.click();
  await leaveDialog.getByRole("button", { name: "保存せずに移動する" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/activities/${activityId}$`)); // 保存せずに移動すると実際に離れる

  // --- 2) 編集フォーム（本文＋訂正の理由）も同じ離脱確認。詳細の戻るリンク（SubHeader）で離脱する ---
  await page.goto(`/app/reports?activity=${activityId}`);
  await page.getByRole("button", { name: "手動で作成" }).click();
  await page.getByLabel("実施内容").fill(`ポンプ車操法と放水訓練を実施した ${tag}`);
  await page.getByRole("button", { name: "下書きを作成" }).click();
  await expect(page).toHaveURL(/\/app\/reports\/[^/]+\/draft$/, { timeout: 15_000 });
  const sourceLink = page.getByRole("link", { name: "元の活動を開く" });
  await expect(sourceLink).toBeVisible();
  if (isPhone(viewport)) {
    const height = await sourceLink.evaluate((el) => el.getBoundingClientRect().height);
    expect(height, "モバイルの押下領域は44px以上（docs/03 §1.1-5）").toBeGreaterThanOrEqual(44);
  }
  await page.getByRole("button", { name: "編集する" }).click();
  const editBody = page.getByLabel("実施内容");
  await editBody.fill(`追記: 整備点検を実施した ${tag}`);
  const back = page.getByRole("link", { name: "戻る", exact: true });
  await back.click();
  await expect(leaveDialog).toBeVisible();
  await leaveDialog.getByRole("button", { name: "編集に戻る" }).click();
  await expect(editBody).toHaveValue(new RegExp(`追記.*${tag}`)); // 戻れば入力は保持される
  await back.click();
  await leaveDialog.getByRole("button", { name: "保存せずに移動する" }).click();
  await expect(page).toHaveURL(/\/app\/reports$/);
});
