import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { adminApiData, apiHeaders, BASE, randomIp } from "./helpers";

/**
 * AIアシスタント（T070、SCR-28 /app/assistant。docs/03 §2 SCR-28「権限付き横断検索/RAG、引用原文、
 * 書込/通知提案の確認」。AI-06/AI-07）。
 *
 * 指定試験 `assistant_proposal_requires_explicit_review_of_effects`:
 *   seed（activity＋対象者＋未回答者／異常／承認済み・索引済み文書。e2e内でAPI経由で作り、
 *   jobは開発用トリガ POST /cdn-cgi/local/scheduled で回す。notifications.spec/documents.specと同じ流儀）
 *   → ホームのAI入口から /app/assistant へ（スマホ=ホーム最下部のAIバー、PC=ヘッダーの紫枠ボタン）
 *   → 横断質問 → 根拠（参照元）の表示 → タスクの書込提案 → 差分確認 → 承認（この順で初めてtasksが増える）
 *   → 通知draftの提案 → 承認 → 通知draftが作られる → 別の送信承認（API-64）まで送信0
 *   → 根拠なしの質問は保留（abstained）表示 → 文書撤回後の引用リンクは404案内。
 *
 * - 業務効果（タスク作成・通知draft作成）は人の承認（API-31）の後だけに現れる。承認前に検証読みで
 *   `writesBeforeReview === 0`／`sendsBeforeNotificationApproval === 0` を断言する（docs/06 §1
 *   「データの変更や通知の送信は、必ずあなたの確認を経てから実行」の画面側の実測）。
 * - 通知の実送信は更にAPI-64の送信確認（本文・対象を明示するダイアログ＝T052の通知作成flow流儀）。
 * - 検索・読取はfake AI（TEST_AI_FAKE=1。webServerだけが付ける。読み取り本文からのみ派生＝捏造不能。
 *   提案は質問が明示的に求めるとき〔トリガー語「タスク」/「通知」〕だけ。docs/03 §1.1の規約）で動く。
 * - 業務操作はUI経由を主にし、効果の有無の検証読みだけAPIを使う（documents.specと同じ区分）。
 */

// ChromiumのAndroidエミュレーションは入力方式でレイアウトビューポートが広がったまま戻らないことがある
// （documents.specと同じ配慮）。画面幅の確認は360pxのまま行うため、入力方式だけデスクトップに合わせる。
test.use({ isMobile: false, hasTouch: false });

/** ローカル開発用のCron手動トリガ（本番は毎分自動で走る同じhandleScheduled。docs/03 §1.1-14） */
async function runLocalCron(request: APIRequestContext): Promise<void> {
  await request.fetch(`${BASE}/cdn-cgi/local/scheduled`);
}

/** 検証読み: 一覧API（HMAC keyset）を最後のページまで読んで配列にして返す */
async function apiList<T>(request: APIRequestContext, path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 40; page++) {
    const res: { status: number; data: { data: T[]; meta?: { nextCursor?: string | null } } } = await adminApiData<T[]>(
      request,
      "GET",
      path + (cursor ? `?limit=50&cursor=${encodeURIComponent(cursor)}` : "?limit=50"),
    );
    expect(res.status).toBe(200);
    out.push(...res.data.data);
    cursor = res.data.meta?.nextCursor ?? null;
    if (!cursor) break;
  }
  return out;
}

/** 自分が担当のタスク（API-102。status省略=未完了系。docs/05 API-28のmyTasksと同じ条件） */
const listMyTasks = (request: APIRequestContext) => apiList<{ id: string; title: string }>(request, "/api/v1/tasks/me");

/** 検査済み（ready）の添付を作る（API-26→バイナリPUT→API-84→検査job。 AttachmentUploaderと同じ経路） */
async function uploadReadyAttachment(request: APIRequestContext, documentId: string, pdf: Buffer): Promise<string> {
  const intent = await adminApiData<{ id: string; uploadToken: string }>(request, "POST", "/api/v1/attachments/upload-intents", {
    target: { type: "document", id: documentId },
    contentType: "application/pdf",
    byteSize: pdf.byteLength,
  });
  expect(intent.status).toBe(201);
  const put = await request.fetch(`${BASE}/api/v1/attachments/${intent.data.data.id}/upload`, {
    method: "PUT",
    headers: { origin: BASE, "cf-connecting-ip": randomIp(), "content-type": "application/pdf", "x-upload-token": intent.data.data.uploadToken },
    data: pdf,
  });
  expect(put.ok()).toBeTruthy();
  const attempt = (await put.json()) as { data: { id: string; sha256: string } };
  const done = await adminApiData<{ attachment: { id: string }; job: { id: string } }>(request, "POST", `/api/v1/attachments/${intent.data.data.id}/completion`, {
    version: 1,
    uploadAttemptId: attempt.data.id,
    sha256: attempt.data.sha256,
  });
  expect([202, 200]).toContain(done.status);
  // 検査jobの完了を待つ（jobは本番ではCronが回収する。ローカルは明示トリガ）
  await expect(async () => {
    await runLocalCron(request);
    const job = await adminApiData<{ status: string; resultRef: string | null }>(request, "GET", `/api/v1/jobs/${done.data.data.job.id}`);
    expect(job.data.data.status).toBe("succeeded");
  }).toPass({ timeout: 120_000 });
  return done.data.data.attachment.id;
}

/** 画面の質問欄から質問を送る（提案チップは事前にtoggleする） */
async function ask(page: Page, question: string): Promise<void> {
  await page.getByPlaceholder("質問や依頼を入力").fill(question);
  await page.getByRole("button", { name: "送信" }).click();
}

// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("assistant_proposal_requires_explicit_review_of_effects", async ({ page, request }) => {
  test.setTimeout(420_000);
  const tag = crypto.randomUUID().slice(0, 6);
  const pdf = readFileSync(new URL("../fixtures/documents/sample-ja.pdf", import.meta.url));

  // --- seed（すべてAPI経由。実データは載せない＝架空のみ） -------------------------------------------
  const me = await adminApiData<{ profile: { memberId: string } }>(request, "GET", "/api/v1/me");
  expect(me.status).toBe(200);
  const adminMemberId = me.data.data.profile.memberId;

  // 名簿のみの団員（通知の対象。documents.specと同じ作り方。招待はしない）
  const member2 = await adminApiData<{ id: string }>(request, "POST", "/api/v1/members", {
    displayName: `架空 支援対象 ${tag}`, status: "active", rank: "団員", squad: "2班",
  });
  expect(member2.status).toBe(201);

  // 異常の対象にする車両（API-47）
  const vehicle = await adminApiData<{ id: string }>(request, "POST", "/api/v1/vehicles", {
    assetCode: `e2e-${tag}`, name: `ポンプ車 第9号（架空 ${tag}）`, status: "運用",
  });
  expect(vehicle.status).toBe(201);

  // 異常（API-16。reportedで作られる＝確認待ち。題に「格納箱」を含め、trigram〔3字以上〕の語にする）
  const issueTitle = `格納箱H-07のホース不足（架空 ${tag}）`;
  const issue = await adminApiData<{ id: string }>(request, "POST", "/api/v1/issues", {
    target: { type: "vehicle", id: vehicle.data.data.id },
    title: issueTitle,
    description: `訓練で使う格納箱のホースが1本不足しています。補充の確認が必要です（${tag}）。`,
    attachmentIds: [],
  });
  expect(issue.status).toBe(201);

  // これからの予定（API-06。対象に自分＋名簿のみの団員＝未回答者2名。通知draftの源になる）
  const startsAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  const activity = await adminApiData<{ id: string; version: number }>(request, "POST", "/api/v1/activities", {
    title: `ポンプ訓練の予定（架空 ${tag}）`, kind: "訓練", plannedStartsAt: startsAt,
    locationText: "第三分団詰所・前庭（架空）", ownerMemberId: adminMemberId,
    audienceMemberIds: [adminMemberId, member2.data.data.id],
  });
  expect(activity.status).toBe(201);
  // 作成時はdraftのため公開する（docs/11 activityTransitions。公開は理由不要。UIの「公開する」と同じAPI-39）
  const published = await adminApiData<{ id: string }>(request, "PATCH", `/api/v1/activities/${activity.data.data.id}`, {
    version: activity.data.data.version, status: "scheduled",
  });
  expect(published.status).toBe(200);

  // 文書（API-73→原本→版→承認→索引。documents.specと同じライフサイクルをAPIで）
  const docTitle = `訓練用の給水要領（架空） ${tag}`;
  const doc = await adminApiData<{ id: string; version: number }>(request, "POST", "/api/v1/documents", {
    title: docTitle, classification: "訓練資料",
    acl: [{ memberId: adminMemberId, permission: "read", effect: "allow" }],
  });
  expect(doc.status).toBe(201);
  const attachmentId = await uploadReadyAttachment(request, doc.data.data.id, pdf);
  const version = await adminApiData<{ version: { id: string; revisionNo: number }; job: { id: string } }>(request, "POST", `/api/v1/documents/${doc.data.data.id}/versions`, {
    version: doc.data.data.version, attachmentId, licenseRef: `架空市消防団 検証用許諾 ${tag}`,
  });
  expect([200, 202]).toContain(version.status);
  // 抽出job → 申請 → 承認（document.index job）→ 索引化の完了を待つ
  await expect(async () => {
    await runLocalCron(request);
    const job = await adminApiData<{ status: string }>(request, "GET", `/api/v1/jobs/${version.data.data.job.id}`);
    expect(job.data.data.status).toBe("succeeded");
  }).toPass({ timeout: 120_000 });
  // 版の作成（API-74）は文書rootの版を進めるため、承認の前に現在版を取り直す（UIも詳細読み直し後に操作する）
  const docNow = await adminApiData<{ document: { version: number } }>(request, "GET", `/api/v1/documents/${doc.data.data.id}`);
  expect(docNow.status).toBe(200);
  // 申請（request_review。決定行は作らない）→ 承認（document.index job）
  const requested = await adminApiData(request, "POST", `/api/v1/documents/${doc.data.data.id}/decision`, {
    version: docNow.data.data.document.version, documentVersion: version.data.data.version.revisionNo,
    decision: "request_review", reason: "内容を確認しました。承認の審査をお願いします。",
  });
  expect(requested.status).toBe(200);
  const approved = await adminApiData<{ indexJobId: string | null }>(request, "POST", `/api/v1/documents/${doc.data.data.id}/decision`, {
    version: docNow.data.data.document.version, documentVersion: version.data.data.version.revisionNo, decision: "approve", reason: "内容を確認しました（e2eの架空承認）",
  });
  expect(approved.status).toBe(200);
  await expect(async () => {
    await runLocalCron(request);
    if (!approved.data.data.indexJobId) throw new Error("index job が応答に無い");
    const job = await adminApiData<{ status: string }>(request, "GET", `/api/v1/jobs/${approved.data.data.indexJobId}`);
    expect(job.data.data.status).toBe("succeeded");
  }).toPass({ timeout: 120_000 });
  // 検索に乗ったことの検証読み（API-76。引用元はこの時点では生きている）
  await expect(async () => {
    const hits = await adminApiData<{ citations: unknown[] }>(request, "POST", "/api/v1/search/rag", { query: "給水活動" });
    expect(hits.data.data.citations.length).toBeGreaterThan(0);
  }).toPass({ timeout: 120_000 });

  // --- 1) ホームのAI入口から /app/assistant へ（未実装プレースホルダーの置き換え） -------------------
  await page.goto("/app");
  await page.getByRole("link", { name: "AIアシスタント" }).click();
  await expect(page).toHaveURL(/\/app\/assistant$/);
  await expect(page.getByText("未実装")).toHaveCount(0);
  // prototype語彙: 「団員権限で参照」の注記
  await expect(page.getByText("団員権限で参照")).toBeVisible();

  // --- 2) 横断質問①（出典）→ 根拠（参照元）の表示 -----------------------------------------------
  // 検索（FTS5 trigram）は語ごとにANDのため、出典を取る質問は1語で聞く（docs/06 §5.4。T066の検索条件）
  await ask(page, `給水活動`);
  // AI発言は命令・確定事実として表示しない（docs/03 §1.1の原則③。「AIによる回答（出典つき）」として紫で出す）
  await expect(page.getByText("AIによる回答（出典つき）")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("参照元")).toBeVisible();
  await expect(page.getByText(docTitle).first()).toBeVisible();
  await expect(page.getByText("第1版").first()).toBeVisible(); // 出典版
  await expect(page.getByRole("link", { name: `第1版の文書を開く` }).first()).toBeVisible(); // /app/documents/:id?revision=N
  await expect(page.getByRole("button", { name: "原本を開く" }).first()).toBeVisible(); // 引用原文（API-27）
  // 確認日時・出典版の注記（取得日時と、原文を開くたびに現ACLで再検査する旨）
  await expect(page.getByText(/取得した時点の記録に基づきます/).first()).toBeVisible();

  // --- 3) 横断質問②（提案）→ タスクの書込提案 → 差分確認 → 承認（この順で初めてtasksが増える） ------
  // 承認前に業務効果が無いことを検証読みで断言してから（writesBeforeReview）
  const tasksBefore = (await listMyTasks(request)).filter((t) => t.title.includes(tag));
  const writesBeforeReview = tasksBefore.length;
  expect(writesBeforeReview).toBe(0);

  await page.getByRole("button", { name: new RegExp(issueTitle) }).click(); // 記録を添える（異常のチップ）
  await ask(page, `格納箱 タスク`);
  // 読み取り結果と書込候補は別カード（読み取り結果）
  await expect(page.getByText("読み取り結果").first()).toBeVisible({ timeout: 30_000 });
  // 書込候補（タスク）
  await expect(page.getByText("タスクの候補").first()).toBeVisible();
  await expect(page.getByText(issueTitle).first()).toBeVisible(); // 提案の題は読み取り結果から派生

  // 差分の確認 → 承認（API-31）。この順で初めてtasksが増える
  await page.getByRole("button", { name: "確認して作成" }).click();
  const taskDialog = page.getByRole("dialog", { name: "この候補を作成しますか" }).first();
  // 差分（作られるタスクの題。ダイアログ内では確定予定値の入力欄として確認・修正できる＝T055と同じ考え方）
  await expect(taskDialog.getByLabel("題名")).toHaveValue(issueTitle);
  await expect(taskDialog.getByText("作られるタスク")).toBeVisible();
  await taskDialog.getByRole("button", { name: "作成する" }).click();
  await expect(page.getByText("タスクを作成しました")).toBeVisible({ timeout: 15_000 });
  // 承認後にだけ増える（tag付きの題で数える＝他試験のタスクと食い合わない）
  const tasksAfter = (await listMyTasks(request)).filter((t) => t.title.includes(tag));
  expect(tasksAfter.length).toBe(1);

  // --- 4) 通知draftの提案 → 承認 → 通知draftが作られる → 別の送信承認（API-64）まで送信0 ----------
  await page.getByRole("button", { name: new RegExp(`ポンプ訓練の予定（架空 ${tag}）`) }).click(); // 予定のチップ
  await page.getByRole("button", { name: new RegExp(issueTitle) }).click(); // 異常のチップは外す
  await ask(page, `訓練の 通知`);
  await expect(page.getByText("連絡文の下書き").first()).toBeVisible({ timeout: 30_000 });
  // 承認しても送信はされない旨の注記（prototype「全体への送信は班長以上の権限が必要です」の更新版）
  await expect(page.getByText(/送信は別の承認/).first()).toBeVisible();
  await page.getByRole("button", { name: "確認して作成" }).first().click();
  const notifDialog = page.getByRole("dialog", { name: "この候補を作成しますか" }).first();
  await expect(notifDialog.getByText(/送信は別の承認/)).toBeVisible();
  await expect(notifDialog.getByText("作られる通知の下書き")).toBeVisible();
  await notifDialog.getByRole("button", { name: "作成する" }).click();
  // 作成された通知draftの送信承認（本文・対象を明示してから。T052の送信確認ダイアログ流儀）
  const draftDetail = await page.waitForSelector('[aria-label="作成した通知の下書き"]', { timeout: 15_000 });
  const draftId = await draftDetail.getAttribute("data-notification-id");
  expect(draftId).toBeTruthy();
  await expect(page.getByText("作成した通知の下書き")).toBeVisible();
  // 検証読み: 承認直後・送信承認（API-64）の前に配送は0（draftのまま。deliveriesも無い）
  const draft = await adminApiData<{ status: string; recipients: { deliveryStatus: string | null }[] }>(request, "GET", `/api/v1/notifications/${draftId}`);
  expect(draft.status).toBe(200);
  expect(draft.data.data.status).toBe("draft");
  const sendsBeforeNotificationApproval = draft.data.data.recipients.filter((r) => r.deliveryStatus !== null).length;
  expect(sendsBeforeNotificationApproval).toBe(0);
  // 送信確認ダイアログで本文・対象を明示してから承認（API-64）
  await page.getByRole("button", { name: "送信を承認する" }).click();
  const sendDialog = page.getByRole("dialog", { name: "この通知を承認して送信しますか" });
  await expect(sendDialog.getByText(/対象（2人）/)).toBeVisible();
  await sendDialog.getByRole("button", { name: "承認する" }).click();
  await expect(page.getByText(/配送を準備しています/)).toBeVisible({ timeout: 15_000 });

  // --- 5) 根拠なしの質問は保留（abstained）表示＋手動検索への導線 ----------------------------------
  await page.getByRole("button", { name: new RegExp(`ポンプ訓練の予定（架空 ${tag}）`) }).click(); // チップを外す
  await ask(page, `よすがのしるべについて教えて`);
  await expect(page.getByText("確認できない（根拠が足りません）").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: "文書・規程の一覧を開く" }).first()).toBeVisible();

  // --- 6) 文書撤回後の引用リンクは404案内（T063の即時遮断。引用原文GET＝API-27でも現ACLを検査） ------
  const detail = await adminApiData<{ document: { version: number } }>(request, "GET", `/api/v1/documents/${doc.data.data.id}`);
  expect(detail.status).toBe(200);
  const withdrawn = await adminApiData(request, "POST", `/api/v1/documents/${doc.data.data.id}/withdrawal`, {
    version: detail.data.data.document.version, reason: "誤って古い資料を登録したため（e2eの架空撤回）",
  });
  expect(withdrawn.status).toBe(200);
  // すでに表示している引用（参照元）の「原本を開く」は、開く時点で404になり案内を出す
  await page.getByRole("button", { name: "原本を開く" }).first().click();
  await expect(page.getByText("この出典の原文は開けません").first()).toBeVisible({ timeout: 15_000 });
  // 検証読み: 検索からも消え、原文添付も404（T063）
  const withdrawnHits = await adminApiData<{ citations: unknown[] }>(request, "POST", "/api/v1/search/rag", { query: "給水活動" });
  expect(withdrawnHits.data.data.citations).toEqual([]);
});

/**
 * 入力まわりの押下領域（PH5レビューC中1/中2）。
 * 「記録を添える」の提案チップと質問の送信ボタンは、モバイル（360px）で44px以上の押下領域を持つ
 * （docs/03 §1.1-5・§1.1-19⑩。測り方はmember-admin.specの `ai_evaluation_buttons_meet_touch_target_on_mobile`
 * と同じ。チップは `h-9 … max-lg:min-h-11`〔ReportDraftPage.tsx:751の前例〕、送信ボタンは
 * `size-11 lg:size-10`〔巡回の上下移動と同じ流儀。PCはprototypeどおり40pxが正のためモバイルだけで検査する〕）。
 */
// 幅: phone限定（押下領域44pxの規則はモバイルのみ。PCはprototypeのコンパクト寸法が正＝T085b設定側の仕分け）
test("assistant_input_controls_meet_touch_target_on_mobile", async ({ page, request }) => {
  test.setTimeout(120_000);
  const tag = crypto.randomUUID().slice(0, 6);
  // チップ行（記録を添える）はこれからの予定があるときだけ現れるため、本体試験と同じseedの最小版をAPIで1件作る
  const me = await adminApiData<{ profile: { memberId: string } }>(request, "GET", "/api/v1/me");
  expect(me.status).toBe(200);
  const startsAt = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  const activity = await adminApiData<{ id: string; version: number }>(request, "POST", "/api/v1/activities", {
    title: `押下領域の確認用予定（架空 ${tag}）`, kind: "訓練", plannedStartsAt: startsAt,
    locationText: "第三分団詰所・前庭（架空）", ownerMemberId: me.data.data.profile.memberId,
    audienceMemberIds: [me.data.data.profile.memberId],
  });
  expect(activity.status).toBe(201);
  // 作成時はdraftのため公開する（docs/11 activityTransitions。本体試験と同じAPI-39）
  const published = await adminApiData<{ id: string }>(request, "PATCH", `/api/v1/activities/${activity.data.data.id}`, {
    version: activity.data.data.version, status: "scheduled",
  });
  expect(published.status).toBe(200);

  await page.goto("/app/assistant");
  const chip = page.getByRole("button", { name: new RegExp(`押下領域の確認用予定（架空 ${tag}）`) });
  await expect(chip).toBeVisible();
  const chipHeight = await chip.evaluate((el) => el.getBoundingClientRect().height);
  expect(chipHeight, "「記録を添える」チップのモバイル押下領域は44px以上（docs/03 §1.1-5・§1.1-19⑩）").toBeGreaterThanOrEqual(44);
  const send = page.getByRole("button", { name: "送信" });
  await expect(send).toBeVisible();
  const sendHeight = await send.evaluate((el) => el.getBoundingClientRect().height);
  expect(sendHeight, "質問の送信ボタンのモバイル押下領域は44px以上（docs/03 §1.1-19⑩）").toBeGreaterThanOrEqual(44);
});
