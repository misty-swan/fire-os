import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  acceptInvitationViaUi,
  adminApiData,
  apiHeaders,
  BASE,
  inviteNewMember,
  isPhone,
  newUserContext,
  uniqueEmail,
} from "./helpers";

/**
 * 横断journey（T085。docs/16 T085本文の4動線: 点検→異常→AI→task→通知／活動・出動→使用→集計→帳票／
 * 文書→引用→失効／offline→競合復旧）。
 *
 * 個々の機能の試験（各spec・workers試験）が1機能ずつ確かめたことを、**画面の操作で機能をまたいで**つなぎ、
 * 前の機能の結果が次の機能の入力として正しく渡ることを確かめる。
 * - データはすべて架空。seedは実APIだけ（直接INSERTしない）。業務の操作は画面から行い、効果の確認だけAPIで読む。
 * - AIは試験専用のfake（TEST_AI_FAKE=1。playwright.config.tsのwebServerだけが付ける）。実モデルの品質はここでは測らない
 *   （実モデルの評価はV04の残手順。acceptance-results.mdの「未実施」）。
 * - jobは本番では毎分のCronが回収する。ローカルは開発用トリガ /cdn-cgi/local/scheduled で同じ経路を走らせる。
 */

/** ローカル開発用のCron手動トリガ（本番は毎分自動で走る同じhandleScheduled。docs/03 §1.1-14） */
async function runLocalCron(request: APIRequestContext): Promise<void> {
  await request.fetch(`${BASE}/cdn-cgi/local/scheduled`);
}

/** 承認済みの点検様式を作る（API-95→97） */
async function approvedFacilityTemplate(request: APIRequestContext, name: string) {
  const tpl = await adminApiData<{ id: string; versions: { id: string }[] }>(request, "POST", "/api/v1/inspection-templates", {
    name, targetType: "facility",
    itemSchema: [{ code: "exterior", label: "本体の外観", valueType: "select", required: true, allowedResults: ["ok", "needs_review"] }],
  });
  expect(tpl.status).toBe(201);
  const t = tpl.data.data;
  await adminApiData(request, "POST", `/api/v1/inspection-templates/${t.id}/decision`, { version: 1, templateVersionId: t.versions[0]!.id, decision: "request_review", reason: "架空の確認" });
  const ok = await adminApiData(request, "POST", `/api/v1/inspection-templates/${t.id}/decision`, { version: 2, templateVersionId: t.versions[0]!.id, decision: "approve", reason: "架空の承認" });
  expect(ok.status).toBe(200);
  return t;
}

/** 本人のセッションでAPIを読む（検証読み） */
async function readAs<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.fetch(`${BASE}${path}`, { headers: apiHeaders() });
  expect(res.status(), path).toBe(200);
  return ((await res.json()) as { data: T }).data;
}

/** datetime-local入力欄と同じ形式で、現在からoffsetMsだけ離れた日時を作る（端末の横軸） */
const localInput = (offsetMs: number) => {
  const d = new Date(Date.now() + offsetMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

// =====================================================================================
// J1 点検 → 異常 → AI → タスク → 通知
// =====================================================================================
test("journey_inspection_anomaly_ai_task_notification", async ({ page, browser, request }, testInfo) => {
  test.setTimeout(420_000);
  const viewport = testInfo.project.use.viewport!;
  const tag = crypto.randomUUID().slice(0, 6);
  const note = `吸水口のキャップが外れていた（架空） ${tag}`;
  const taskTitle = `キャップの交換手配 ${tag}`;

  // --- seed: 担当の団員（招待受領で本人の画面を持つ）、施設、承認済み様式 ---
  const memberName = `架空 点検担当 ${tag}`;
  const email = uniqueEmail(`e2e-j1-${tag}`);
  const member = await inviteNewMember(request, memberName, email);
  const memberCtx = await newUserContext(browser, viewport);
  const memberPage = await memberCtx.newPage();
  await acceptInvitationViaUi(memberPage, email, member.token, { mfa: false });
  const facility = await adminApiData<{ id: string }>(request, "POST", "/api/v1/facilities", {
    type: "cistern", latitude: 35.31, longitude: 139.31, locationSource: "架空市台帳", locationNote: `journey1 ${tag}`, managementNumber: `J1-${tag}`,
  });
  const facilityId = facility.data.data.id;
  await approvedFacilityTemplate(request, `J1様式 ${tag}`);

  // --- 1) 点検（SCR-06）: 異常ありで保存すると、同じ確定で起点の異常が作られる ---
  await page.goto(`/app/facilities/${facilityId}/inspections/new`);
  await page.getByRole("button", { name: `J1様式 ${tag}` }).click();
  await page.getByRole("button", { name: "異常あり" }).click();
  await page.getByRole("button", { name: /写真・メモへ進む/ }).click();
  await page.getByLabel("メモ・特記事項").fill(note);
  await page.getByRole("button", { name: /確認へ進む/ }).click();
  await page.getByRole("button", { name: "点検を保存" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/facilities/${facilityId}$`), { timeout: 20_000 });

  // --- 2) 異常（SCR-07）: 点検の起点つきで「確認待ち」に現れる。AIの判定で状態は変わっていない ---
  const issues = await adminApiData<{ id: string; status: string; originInspectionId: string | null; confirmedCategory: string | null }[]>(
    request, "GET", `/api/v1/issues?targetType=facility&targetId=${facilityId}`,
  );
  expect(issues.data.data).toHaveLength(1);
  const issue = issues.data.data[0]!;
  expect(issue).toMatchObject({ status: "reported", confirmedCategory: null });
  expect(issue.originInspectionId).toBeTruthy();
  await page.goto("/app/issues");
  await expect(page.getByText(note).first()).toBeVisible({ timeout: 15_000 });

  // --- 3) AI（SCR-18）: 施設詳細の導線から分類を依頼 → 候補 → 人が確定してタスクを担当へ ---
  await page.goto(`/app/facilities/${facilityId}`);
  await page.getByRole("link", { name: "AI分類をレビュー" }).click();
  await expect(page).toHaveURL(/\/app\/ai\/reviews/);
  await page.getByRole("button", { name: "AI分類を依頼" }).click();
  const candidate = page.getByRole("link", { name: /分類の候補 v1/ }).first();
  await expect(async () => {
    await runLocalCron(request);
    await expect(candidate).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 90_000 });
  await candidate.click();
  await expect(page.getByText(note)).toBeVisible();
  await page.getByLabel("承認後の確定分類").selectOption("equipment_issue");
  await page.getByLabel("タスクの題名").fill(taskTitle);
  await page.getByLabel("タスクの担当").selectOption({ label: memberName });
  await page.getByRole("button", { name: "修正して承認" }).click();
  const dialog = page.getByRole("dialog", { name: "このAI候補を確定しますか" });
  await expect(dialog.getByText(taskTitle)).toBeVisible();
  await dialog.getByRole("button", { name: "修正して承認" }).click();
  await expect(page.getByText("修正承認済み").first()).toBeVisible({ timeout: 15_000 });
  const afterAi = await adminApiData<{ id: string; confirmedCategory: string | null }[]>(request, "GET", `/api/v1/issues?targetType=facility&targetId=${facilityId}`);
  expect(afterAi.data.data[0]!.confirmedCategory).toBe("equipment_issue"); // 人の確定だけが異常に入る

  // AIの承認は通知を勝手に送らない（担当の受信箱はまだ空。通知の源は予定・お知らせ・点検期限で、人の承認が要る）
  const inboxBefore = await readAs<{ body: string }[]>(memberPage, "/api/v1/notifications/me?limit=200");
  expect(inboxBefore.filter((n) => n.body.includes(tag))).toHaveLength(0);

  // --- 4) タスク（SCR-21）: 担当の画面に届き、着手できる ---
  await memberPage.goto("/app/tasks-notifications?tab=tasks");
  const taskRow = memberPage.getByRole("list", { name: "自分のタスク" }).getByRole("listitem").filter({ hasText: taskTitle });
  await expect(taskRow).toBeVisible({ timeout: 15_000 });
  await taskRow.getByRole("button", { name: "着手" }).click();
  await expect(taskRow.getByText("着手中", { exact: true })).toBeVisible({ timeout: 15_000 });

  // --- 5) 通知（SCR-21）: 異常のお知らせを担当へ公開し、その内容の通知を人が作って承認する ---
  // 公開済みのお知らせは対象者にだけ見える（管理者も同じ）。作成者の管理者も対象に含めて源として選べるようにする
  const adminMe = await adminApiData<{ profile: { memberId: string } }>(request, "GET", "/api/v1/me");
  const ann = await adminApiData<{ id: string; version: number }>(request, "POST", "/api/v1/announcements", {
    title: `貯水槽の異常と交換の連絡 ${tag}`, body: `${note}。キャップの交換を手配します。`, audienceMemberIds: [member.memberId, adminMe.data.data.profile.memberId],
  });
  expect(ann.status).toBe(201);
  expect((await adminApiData(request, "PATCH", `/api/v1/announcements/${ann.data.data.id}`, { version: ann.data.data.version, status: "published" })).status).toBe(200);
  await page.goto("/app/tasks-notifications/notifications/new");
  await page.getByLabel("通知の源").selectOption("announcement");
  const annSelect = page.getByLabel("通知するお知らせ");
  await annSelect.selectOption((await annSelect.locator("option", { hasText: `貯水槽の異常と交換の連絡 ${tag}` }).getAttribute("value"))!);
  await page.getByLabel("本文").fill(`点検で見つかった異常の連絡です（架空） ${tag}`);
  await page.getByRole("button", { name: "下書きを作成" }).click();
  await expect(page.getByLabel("承認前の確認").getByText(`点検で見つかった異常の連絡です（架空） ${tag}`)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "承認する" }).click();
  const approve = page.getByRole("dialog", { name: "この通知を承認して送信しますか" });
  await expect(approve.getByText(memberName)).toBeVisible();
  await approve.getByRole("button", { name: "承認する" }).click();
  await expect(page.getByText(/処理中/).first()).toBeVisible();
  await expect(async () => {
    await runLocalCron(request);
    await expect(page.getByLabel("配送結果").getByText("受付済み").first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });

  // --- 6) 担当が通知を読み（本人既読）、タスクを完了する ---
  await memberPage.goto("/app/tasks-notifications");
  await memberPage.getByRole("link", { name: new RegExp(`点検で見つかった異常の連絡です（架空） ${tag}`) }).click();
  await expect(memberPage.getByText("この通知は未読です")).toBeVisible();
  await memberPage.getByRole("button", { name: "内容を確認" }).click();
  await expect(memberPage.getByText("既読").first()).toBeVisible({ timeout: 15_000 });
  await memberPage.goto("/app/tasks-notifications?tab=tasks");
  await taskRow.getByRole("button", { name: "完了する" }).click();
  await expect(taskRow).toHaveCount(0, { timeout: 15_000 });

  // 最後に効果を確かめる: タスクは1件で完了、通知は承認された1通だけが届き既読
  const tasksDone = await readAs<{ title: string; status: string }[]>(memberPage, "/api/v1/tasks/me?status=done&limit=200");
  expect(tasksDone.filter((t) => t.title === taskTitle)).toHaveLength(1);
  const inbox = await readAs<{ body: string; myReadAt: string | null }[]>(memberPage, "/api/v1/notifications/me?limit=200");
  const mine = inbox.filter((n) => n.body.includes(tag));
  expect(mine).toHaveLength(1);
  expect(mine[0]!.myReadAt).not.toBeNull();
  await memberCtx.close();
});

// =====================================================================================
// J2 活動・出動 → 使用 → 集計 → 帳票
// =====================================================================================
test("journey_activity_incident_usage_analytics_report", async ({ page, request }) => {
  test.setTimeout(420_000);
  const tag = crypto.randomUUID().slice(0, 6);
  const memberName = `架空 集計対象 ${tag}`;
  const now = new Date();
  // 業務の年度（検証設定: 4月始まり・JST）。活動は2日前（当年度内）に置く
  const jst = new Date(now.getTime() + 9 * 3600e3 - 2 * 864e5);
  const fy = jst.getUTCMonth() >= 3 ? jst.getUTCFullYear() : jst.getUTCFullYear() - 1;

  // --- seed: 名簿の団員、車両、過去の活動（公開済み）と実績（2時間・実参加1名） ---
  const member = await adminApiData<{ id: string }>(request, "POST", "/api/v1/members", { displayName: memberName, status: "active", rank: "団員", squad: "3班" });
  expect(member.status).toBe(201);
  const memberId = member.data.data.id;
  const vehicle = await adminApiData<{ id: string }>(request, "POST", "/api/v1/vehicles", { assetCode: `J2-${tag}`, name: `架空 小型ポンプ車 ${tag}`, status: "運用" });
  const vehicleId = vehicle.data.data.id;
  const me = await adminApiData<{ profile: { memberId: string } }>(request, "GET", "/api/v1/me");
  const startsAt = new Date(now.getTime() - 2 * 864e5).toISOString();
  const endsAt = new Date(now.getTime() - 2 * 864e5 + 2 * 3600e3).toISOString();
  const activity = await adminApiData<{ id: string }>(request, "POST", "/api/v1/activities", {
    title: `夜間の放水訓練 ${tag}`, kind: "訓練", plannedStartsAt: startsAt, locationText: "架空市河川敷",
    ownerMemberId: me.data.data.profile.memberId, audienceMemberIds: [memberId],
  });
  const activityId = activity.data.data.id;
  expect((await adminApiData(request, "PATCH", `/api/v1/activities/${activityId}`, { version: 1, status: "scheduled" })).status).toBe(200);
  expect((await adminApiData(request, "POST", `/api/v1/activities/${activityId}/actual-results`, {
    activityVersion: 2, content: `放水訓練を実施（架空） ${tag}`, actualStartsAt: startsAt, actualEndsAt: endsAt,
    participants: [{ memberId, actualStatus: "participated" }], attachmentIds: [],
  })).status).toBe(201);

  // --- 1) 出動（SCR-22→SCR-12）: 訓練中の模擬出動を登録し、活動へ関連付ける（同じ出来事） ---
  await page.goto("/app/incidents/new");
  await page.getByRole("button", { name: "模擬", exact: true }).click();
  await page.getByLabel("発生日時").fill(localInput(-2 * 864e5 + 3600e3));
  await page.getByLabel("概要").fill(`放水訓練中の模擬出動 ${tag}`);
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page).toHaveURL(/\/app\/incidents\/(?!new)[^/]+$/, { timeout: 15_000 });
  const incidentId = page.url().split("/").pop()!;
  await page.getByRole("button", { name: "関連活動を探す" }).click();
  const linkForm = page.getByLabel("関連活動の検索");
  await linkForm.getByLabel("活動を探す").fill(`夜間の放水訓練 ${tag}`);
  await linkForm.getByRole("button", { name: new RegExp(`夜間の放水訓練 ${tag}`) }).click();
  await linkForm.getByLabel("関連付ける理由（必須）").fill("訓練中の模擬出動を同じ出来事として記録する");
  await expect(linkForm.getByText("版を確認済み")).toBeVisible({ timeout: 15_000 });
  await linkForm.getByRole("button", { name: "関連付ける" }).click();
  await expect(page.getByRole("link", { name: new RegExp(`夜間の放水訓練 ${tag}`) })).toBeVisible({ timeout: 15_000 });

  // --- 2) 使用（SCR-12→SCR-14）: 車両の使用を記録し、資産側の使用履歴から元の出動へ戻れる ---
  await page.getByRole("button", { name: "使用履歴を編集" }).click();
  const usageForm = page.getByLabel("使用履歴の編集");
  await usageForm.getByRole("button", { name: "行を追加" }).click();
  await usageForm.getByLabel("使用履歴 1行目の対象").selectOption(`vehicle:${vehicleId}`);
  await usageForm.getByLabel("使用履歴 1行目の数量").fill("1");
  await usageForm.getByLabel("編集の理由（必須）").fill("放水訓練での使用を記録");
  await usageForm.getByRole("button", { name: "使用履歴を保存" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(`架空 小型ポンプ車 ${tag}`)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("link", { name: new RegExp(`架空 小型ポンプ車 ${tag}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/app/assets/vehicle/${vehicleId}`));
  await page.getByRole("link", { name: "元の出動記録に戻る" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/incidents/${incidentId}$`));
  const inc = await adminApiData<{ operationId: string; activity: { operationId: string } | null }>(request, "GET", `/api/v1/incidents/${incidentId}`);
  expect(inc.data.data.activity!.operationId).toBe(inc.data.data.operationId); // 活動と出動は同じ出来事

  // --- 3) 集計（SCR-26）: 団員別では活動と出動が1件の出来事として数えられ（二重計上なし）、時間は実績の2時間 ---
  const api52 = await adminApiData<{ totals: { operationCount: number } }>(request, "GET", `/api/v1/analytics?fiscalYear=${fy}&memberId=${memberId}`);
  expect(api52.status).toBe(200);
  expect(api52.data.data.totals.operationCount).toBe(1);
  await page.goto(`/app/analytics?fy=${fy}&view=members`);
  const memberRow = page.getByTestId("analytics-member-row").filter({ hasText: memberName });
  await expect(memberRow).toBeVisible({ timeout: 15_000 });
  await expect(memberRow).toContainText("1件");
  await expect(memberRow).toContainText("2時間");
  await page.goto(`/app/analytics?fy=${fy}`);
  await expect(page.getByTestId(`analytics-source-activity-${activityId}`)).toBeVisible();
  await expect(page.getByTestId(`analytics-source-incident-${incidentId}`)).toBeVisible();

  // --- 4) 帳票（SCR-09→SCR-19）: 手動の下書き→申請→承認→出力。人数・日時はサーバーが実績から決める ---
  await page.goto(`/app/activities/${activityId}`);
  await page.getByRole("link", { name: "報告書を作る" }).click();
  await page.getByRole("button", { name: "手動で作成" }).click();
  await page.getByLabel("実施内容").fill(`放水訓練と模擬出動を実施した（架空） ${tag}`);
  await page.getByRole("button", { name: "下書きを作成" }).click();
  await expect(page).toHaveURL(/\/app\/reports\/[^/]+\/draft$/, { timeout: 15_000 });
  const reportId = new URL(page.url()).pathname.split("/")[3]!;
  await page.getByRole("button", { name: "班長に確認を依頼" }).click();
  await expect(page.getByText("確認待ち").first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "承認する" }).click();
  await page.getByRole("dialog", { name: "この版を承認しますか" }).getByRole("button", { name: "承認する" }).click();
  await expect(page.getByText("承認済み").first()).toBeVisible({ timeout: 15_000 });
  const csv = await request.fetch(`${BASE}/api/v1/reports/${reportId}/content?format=csv`, { headers: { origin: BASE } });
  expect(csv.status()).toBe(200);
  const [header, values] = (await csv.text()).replace(/^﻿/, "").trim().split(/\r?\n/).map((l) => l.split(","));
  const col = (name: string) => values![header!.indexOf(name)];
  expect(col("activityTitle")).toBe(`夜間の放水訓練 ${tag}`);
  expect(col("participantCount")).toBe("1"); // 集計と同じ実参加の人数（本文の記述ではなく実績から）
});

// =====================================================================================
// J3 文書 → 引用 → 失効
// =====================================================================================
test("journey_document_citation_withdrawal", async ({ page, request }) => {
  test.setTimeout(420_000);
  const tag = crypto.randomUUID().slice(0, 6);
  const { readFileSync } = await import("node:fs");
  const pdf = readFileSync(new URL("../fixtures/documents/sample-ja.pdf", import.meta.url));
  const me = await adminApiData<{ profile: { memberId: string } }>(request, "GET", "/api/v1/me");
  const docTitle = `給水の手引き（架空） ${tag}`;

  // --- seed: 文書（許諾つきの版を作り、抽出job→申請→承認→索引jobまで。documents.specと同じライフサイクルをAPIで） ---
  const doc = await adminApiData<{ id: string; version: number }>(request, "POST", "/api/v1/documents", {
    title: docTitle, classification: "訓練資料", acl: [{ memberId: me.data.data.profile.memberId, permission: "read", effect: "allow" }],
  });
  expect(doc.status).toBe(201);
  const documentId = doc.data.data.id;
  const intent = await adminApiData<{ id: string; uploadToken: string }>(request, "POST", "/api/v1/attachments/upload-intents", {
    target: { type: "document", id: documentId }, contentType: "application/pdf", byteSize: pdf.byteLength,
  });
  const put = await request.fetch(`${BASE}/api/v1/attachments/${intent.data.data.id}/upload`, {
    method: "PUT", headers: { ...apiHeaders(), "content-type": "application/pdf", "x-upload-token": intent.data.data.uploadToken }, data: pdf,
  });
  const attempt = (await put.json()) as { data: { id: string; sha256: string } };
  const done = await adminApiData<{ job: { id: string } }>(request, "POST", `/api/v1/attachments/${intent.data.data.id}/completion`, {
    version: 1, uploadAttemptId: attempt.data.id, sha256: attempt.data.sha256,
  });
  const waitJob = async (jobId: string) => expect(async () => {
    await runLocalCron(request);
    const job = await adminApiData<{ status: string }>(request, "GET", `/api/v1/jobs/${jobId}`);
    expect(job.data.data.status).toBe("succeeded");
  }).toPass({ timeout: 120_000 });
  await waitJob(done.data.data.job.id);
  const version = await adminApiData<{ version: { revisionNo: number }; job: { id: string } }>(request, "POST", `/api/v1/documents/${documentId}/versions`, {
    version: doc.data.data.version, attachmentId: intent.data.data.id, licenseRef: `架空市消防団 検証用許諾 ${tag}`,
  });
  await waitJob(version.data.data.job.id);
  const docNow = await adminApiData<{ document: { version: number } }>(request, "GET", `/api/v1/documents/${documentId}`);
  await adminApiData(request, "POST", `/api/v1/documents/${documentId}/decision`, {
    version: docNow.data.data.document.version, documentVersion: version.data.data.version.revisionNo, decision: "request_review", reason: "確認をお願いします（架空）",
  });
  const approved = await adminApiData<{ indexJobId: string | null }>(request, "POST", `/api/v1/documents/${documentId}/decision`, {
    version: docNow.data.data.document.version, documentVersion: version.data.data.version.revisionNo, decision: "approve", reason: "確認しました（架空）",
  });
  expect(approved.status).toBe(200);
  await waitJob(approved.data.data.indexJobId!);

  // --- 1) 引用（SCR-28）: 質問すると、この文書が出典（参照元・版）として示され、原文を開ける ---
  await page.goto("/app/assistant");
  await page.getByPlaceholder("質問や依頼を入力").fill("給水活動");
  await page.getByRole("button", { name: "送信" }).click();
  await expect(page.getByText("AIによる回答（出典つき）").first()).toBeVisible({ timeout: 30_000 });
  const answer = page.getByText(docTitle).first();
  await expect(answer).toBeVisible();
  const original = await adminApiData<{ original: { attachmentId: string } | null }>(request, "GET", `/api/v1/documents/${documentId}`);
  const attachmentId = original.data.data.original!.attachmentId;
  expect((await request.fetch(`${BASE}/api/v1/attachments/${attachmentId}/content`, { headers: { origin: BASE } })).ok()).toBe(true);

  // --- 2) 失効（SCR-24）: 文書の画面から撤回する（理由必須・確認ダイアログ） ---
  await page.goto(`/app/documents/${documentId}`);
  // 画面下端のボタンはスマホでは固定ナビに隠れて当たり判定が安定しないため、キーボードで押す（incidents.specと同じ配慮）
  await page.getByRole("button", { name: "文書を撤回する" }).focus();
  await page.keyboard.press("Enter");
  const withdraw = page.getByRole("dialog", { name: "この文書を撤回しますか" });
  await withdraw.getByLabel("撤回の理由（必須）").fill("改訂版に差し替えるため（架空）");
  await withdraw.getByRole("button", { name: "撤回する" }).click();
  await expect(page).toHaveURL(/\/app\/documents$/, { timeout: 15_000 });

  // --- 3) 失効後の引用: 同じ質問でこの文書は出典にならず、前の引用の原文も開けない（索引の削除を待たない即時遮断） ---
  await page.goto("/app/assistant");
  await page.getByPlaceholder("質問や依頼を入力").fill("給水活動");
  await page.getByRole("button", { name: "送信" }).click();
  await expect(page.getByText(/AIによる回答（出典つき）|確認できない（根拠が足りません）/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(docTitle)).toHaveCount(0);
  const hits = await adminApiData<{ citations: { documentId?: string; title?: string }[] }>(request, "POST", "/api/v1/search/rag", { query: "給水活動" });
  expect(JSON.stringify(hits.data.data.citations)).not.toContain(documentId);
  expect((await request.fetch(`${BASE}/api/v1/attachments/${attachmentId}/content`, { headers: { origin: BASE } })).ok()).toBe(false);
  // 索引の後始末（deindex job）が回った後も結果は同じ
  await runLocalCron(request);
  const after = await adminApiData<{ citations: unknown[] }>(request, "POST", "/api/v1/search/rag", { query: "給水活動" });
  expect(JSON.stringify(after.data.data.citations)).not.toContain(documentId);
});

// =====================================================================================
// J4 offline → 競合 → 復旧（点検の訂正。T033の訂正画面とT077の同期をつなぐ）
// =====================================================================================
test("journey_offline_correction_conflict_recovery", async ({ browser, request }, testInfo) => {
  test.setTimeout(420_000);
  const viewport = testInfo.project.use.viewport!;
  const appHeading = isPhone(viewport) ? { level: 2 as const, name: "ホーム" } : { level: 1 as const, name: "ダッシュボード" };
  const tag = crypto.randomUUID().slice(0, 6);
  const name = `架空 点検訂正 ${tag}`;

  // --- seed: 幹部の団員A（招待受領）、施設、承認済み様式、管理者が記録した点検の原本 ---
  const email = uniqueEmail(`e2e-j4-${tag}`);
  const a = await inviteNewMember(request, name, email);
  const facility = await adminApiData<{ id: string }>(request, "POST", "/api/v1/facilities", {
    type: "hydrant", latitude: 35.41, longitude: 139.41, locationSource: "架空市台帳", locationNote: `journey4 ${tag}`, managementNumber: `J4-${tag}`,
  });
  const facilityId = facility.data.data.id;
  const tpl = await approvedFacilityTemplate(request, `J4様式 ${tag}`);
  const me = await adminApiData<{ profile: { memberId: string } }>(request, "GET", "/api/v1/me");
  const made = await adminApiData<{ id: string; seriesVersion: number }>(request, "POST", `/api/v1/facilities/${facilityId}/inspections`, {
    templateVersionId: tpl.versions[0]!.id, inspectedAt: new Date(Date.now() - 864e5).toISOString(), inspectorMemberId: me.data.data.profile.memberId,
    result: "ok", checkItems: [{ code: "exterior", result: "ok" }], note: `原本（架空） ${tag}`, createIssue: false, attachmentIds: [],
  });
  expect(made.status).toBe(201);
  const originalId = made.data.data.id;

  const ctx = await newUserContext(browser, viewport);
  const page = await ctx.newPage();
  page.on("dialog", (d) => void d.accept());
  await acceptInvitationViaUi(page, email, a.token, { mfa: false });
  const rows = await adminApiData<{ id: string; version: number; account?: { authzVersion: number } }[]>(request, "GET", `/api/v1/members?q=${encodeURIComponent(name)}`);
  const row = rows.data.data.find((r) => r.id === a.memberId)!;
  await adminApiData(request, "PUT", `/api/v1/members/${a.memberId}/roles`, {
    version: row.version, expectedAuthzVersion: row.account!.authzVersion, roleCodes: ["officer"], scopes: [], reason: "e2e: 点検を訂正できる幹部として試験する（架空）",
  });
  await page.reload();
  await expect(page.getByRole("heading", appHeading)).toBeVisible({ timeout: 20_000 });

  // --- 1) 通信断: この端末から訂正と同期の送信だけが届かない ---
  let offline = true;
  await ctx.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const write = route.request().method() === "POST" && (/\/inspections\/facility\/[^/]+\/corrections$/.test(path) || path === "/api/v1/sync/commands");
    if (offline && write) return route.abort();
    return route.fallback();
  });
  await page.goto(`/app/facilities/${facilityId}`);
  await page.getByRole("link", { name: "点検を訂正する" }).click();
  await page.getByRole("button", { name: "異常あり" }).click();
  await page.getByRole("button", { name: /写真・メモへ進む/ }).click();
  await page.getByRole("button", { name: /確認へ進む/ }).click();
  await page.getByLabel("訂正の理由（必須）").fill("通信が切れた現場での訂正（架空）");
  await page.getByRole("button", { name: "訂正を保存" }).click();
  await expect(page.getByText(/結果を確認できません/)).toBeVisible({ timeout: 20_000 });
  // 結果不明の訂正は端末の下書きとして残る（SCR-27の未同期に出る）
  await page.goto("/app/sync");
  await expect(page.getByText(/点検の訂正/).first()).toBeVisible({ timeout: 15_000 });

  // --- 2) 別の端末（管理者）が同じ点検を先に訂正する（系列の版が進む） ---
  const other = await adminApiData<{ id: string }>(request, "POST", `/api/v1/inspections/facility/${originalId}/corrections`, {
    seriesVersion: made.data.data.seriesVersion, supersedesId: originalId, reason: "別端末での訂正（架空）",
    templateVersionId: tpl.versions[0]!.id, inspectedAt: new Date(Date.now() - 864e5).toISOString(), inspectorMemberId: me.data.data.profile.memberId,
    result: "ok", checkItems: [{ code: "exterior", result: "ok" }], note: `別端末の訂正（架空） ${tag}`, createIssue: false, attachmentIds: [],
  });
  expect(other.status).toBe(201);

  // --- 3) 再接続: 同期は競合で止まり、後勝ちで上書きしない（下書きは端末に残り、人が決める） ---
  offline = false;
  await expect(async () => {
    const syncNow = page.getByRole("button", { name: "今すぐ同期" });
    if (await syncNow.isEnabled().catch(() => false)) await syncNow.click();
    await expect(page.getByText("競合", { exact: true }).first()).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  const midway = await adminApiData<{ id: string; isCurrent: boolean; note: string }[]>(request, "GET", `/api/v1/facilities/${facilityId}/inspections`);
  expect(midway.data.data).toHaveLength(2); // 原本＋別端末の訂正。この端末の訂正は適用されていない
  expect(midway.data.data.find((r) => r.isCurrent)!.id).toBe(other.data.data.id);
  // 点検の訂正は現値の取得手段が無いことを正直に示し、旧版のまま送り直す操作は出さない
  await expect(page.getByText(/点検の単件取得が未提供/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "現値の版で送り直す" })).toBeDisabled();

  // --- 4) 復旧: 下書きを破棄し、現在の記録（別端末の訂正）から改めて訂正する ---
  await page.getByRole("button", { name: "破棄" }).click();
  await page.getByRole("button", { name: "破棄する" }).click();
  await expect(page.getByText("同期待ちの入力はありません")).toBeVisible({ timeout: 15_000 });
  await page.goto(`/app/facilities/${facilityId}`);
  await page.getByRole("link", { name: "点検を訂正する" }).click();
  await page.getByRole("button", { name: "異常あり" }).click();
  await page.getByRole("button", { name: /写真・メモへ進む/ }).click();
  await expect(page.getByLabel("メモ・特記事項")).toHaveValue(`別端末の訂正（架空） ${tag}`); // 現在の記録から始まる
  await page.getByRole("button", { name: /確認へ進む/ }).click();
  await page.getByLabel("訂正の理由（必須）").fill("現在の記録を確認して訂正し直した（架空）");
  await page.getByRole("button", { name: "訂正を保存" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/facilities/${facilityId}$`), { timeout: 20_000 });
  const final = await adminApiData<{ id: string; isCurrent: boolean; supersedesId: string | null; result: string }[]>(request, "GET", `/api/v1/facilities/${facilityId}/inspections`);
  expect(final.data.data).toHaveLength(3); // 原本 → 別端末の訂正 → この端末の訂正（一本の履歴。枝分かれ・上書きなし）
  const current = final.data.data.find((r) => r.isCurrent)!;
  expect(current).toMatchObject({ supersedesId: other.data.data.id, result: "needs_review" });
  await ctx.close();
});
