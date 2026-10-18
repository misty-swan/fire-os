import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { adminApiData, BASE } from "./helpers";

/**
 * 文書・規程（T069、SCR-24 /app/documents。docs/03 §2 SCR-24「許諾原本の登録/版/承認/撤回/ACL/閲覧」）。
 *
 * 管理者（PER-11＋幹部・管理者の管理操作）がメニューの「文書・規程」タイルから入り、
 * 文書作成（ACLつき）→架空原本（日本語3頁のPDF。tests/fixtures/documents/sample-ja.pdf。
 * 中身は架空の訓練資料）の添付→許諾根拠（licenseRef）つきの版作成→抽出→申請→承認→検索→
 * ACL変更→撤回→旧引用（原文添付）が開けなくなるまでのライフサイクルをUIで完結させる。
 *
 * - 検索の検証読みはAPI-76（POST /search/rag。SCR-28の画面はT070のため未実装）で行う。
 *   撤回後の `withdrawnSearchHits`（応答のcitations）は空配列（T063の即時検索遮断。索引削除を待たない）。
 * - 旧引用リンクは版の原文添付（API-27 /attachments/:id/content）。撤回後は404になる
 *   （T063「撤回後は一覧・詳細・原文・版の全GETが404」）。
 * - 抽出・索引のjob（document.extract / document.index）は本番では毎分のCronが回収する。ローカルの
 *   wrangler devはCronを自動発火しないため、開発用トリガ `/cdn-cgi/local/scheduled` で同じ経路を
 *   明示的に走らせる（notifications.specと同じ流儀。localのQueue経路も併走する）。
 * - 業務操作はUI経由（seedの団員1名だけAPI。announcements.specと同じ流儀）。
 */

// ChromiumのAndroidエミュレーションはファイル選択でレイアウトビューポートを広げたまま戻らないことがある
// （announcements.specと同じ配慮）。画面幅の確認は360pxのまま行うため、入力方式だけデスクトップに合わせる。
test.use({ isMobile: false, hasTouch: false });

/** ローカル開発用のCron手動トリガ（本番は毎分自動で走る同じhandleScheduled。docs/03 §1.1-14） */
async function runLocalCron(request: APIRequestContext): Promise<void> {
  await request.fetch(`${BASE}/cdn-cgi/local/scheduled`);
}

/** 検証読み: API-76で検索し、応答の引用（＝検索hit。SCR-28の画面はT070のため未実装）を返す */
async function searchCitations(request: APIRequestContext, query: string): Promise<unknown[]> {
  const res = await adminApiData<{ citations: unknown[]; abstained: boolean }>(request, "POST", "/api/v1/search/rag", { query });
  expect(res.status).toBe(200);
  return res.data.data.citations;
}

test("withdrawn_document_disappears_from_search_and_citation", async ({ page, request }) => {
  test.setTimeout(300_000);
  const tag = crypto.randomUUID().slice(0, 6);
  const title = `訓練用の給水要領（架空） ${tag}`;
  const licenseRef = `架空市消防団 検証用許諾 ${tag}`;
  // 抽出fixture（T064）。日本語3頁の架空訓練資料。「給水活動」を含むためtrigram検索の語になる
  const pdf = readFileSync(new URL("../fixtures/documents/sample-ja.pdf", import.meta.url));

  // --- seed: ACLの対象にする団員（招待を受けない名簿のみの団員。notifications.specと同じ作り方） ---
  const member = await adminApiData<{ id: string }>(request, "POST", "/api/v1/members", {
    displayName: `架空 文書閲覧者 ${tag}`, status: "active", rank: "団員", squad: "1班",
  });
  expect(member.status).toBe(201);

  // --- 1) メニューの「文書・規程」タイルから一覧へ入り、未実装プレースホルダーが無いことを確認して作成フォームへ ---
  await page.goto("/app/menu");
  await page.locator("#main").getByRole("link", { name: "文書・規程" }).click();
  await expect(page).toHaveURL(/\/app\/documents$/);
  await expect(page.getByText("未実装")).toHaveCount(0);
  await page.getByRole("link", { name: "文書を作成" }).click();
  await expect(page).toHaveURL(/\/app\/documents\/new$/);

  await page.getByLabel("題名").fill(title);
  await page.getByLabel("分類").fill("訓練資料");
  // ACL（deny優先）: 初期行は自分（許可）。seed団員の閲覧も許可する
  await page.getByRole("button", { name: "対象を追加" }).click();
  await page.getByLabel("対象の団員2").selectOption({ label: `架空 文書閲覧者 ${tag}` });
  // 保存の応答を待ってから可視フィードバックを断言する（T083 R4。旧断言「トーストが見える」は
  // 応答が遅いと保存成功でも落っていた＝トースト〔2.6秒で自動消失〕への固定時間依存のフレーク。
  // 応答の確定後にrole=statusへスコープして待つため、成功の可視フィードバックの意味は保ったまま
  // 待ち合わせを時間に依存させない）
  const created = page.waitForResponse((r) => r.url().endsWith("/api/v1/documents") && r.request().method() === "POST");
  await page.getByRole("button", { name: "文書を作成する" }).click();
  expect((await created).status()).toBe(201);
  await expect(page.getByRole("status").filter({ hasText: "保存しました" }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/app\/documents\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const documentId = new URL(page.url()).pathname.split("/").pop()!;
  await expect(page.getByText("下書き").first()).toBeVisible(); // 文書の状態ピル（承認前）
  await expect(page.getByText("閲覧許可の改訂 第1版", { exact: true })).toBeVisible(); // policyVersion

  // --- 2) 版の作成: 架空原本（PDF）を添付→検査（job）→許諾根拠を入れて版を作る（API-74。202=受付） ---
  await page.setInputFiles('input[type="file"]', { name: "sample-ja.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(async () => {
    await runLocalCron(request);
    await expect(page.getByText("準備完了")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 120_000 });
  await page.getByLabel("許諾の出典（必須）").fill(licenseRef);
  await page.getByRole("button", { name: "版を作成する" }).click();
  await expect(page.getByText(/第1版/).first()).toBeVisible({ timeout: 15_000 });

  // 抽出job（document.extract）の完了を画面（抽出状態）で待つ。202=受付で完了ではない
  await expect(async () => {
    await runLocalCron(request);
    await expect(page.getByText(/抽出済み/)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 120_000 });

  // 指定試験のassertion: 許諾根拠（licenseRef）が版に表示される
  await expect(page.getByText("許諾根拠")).toBeVisible();

  // --- 3) 申請（定型理由で1クリック）→ 承認（確認ダイアログで対象版を明示。API-75） ---
  await page.getByRole("button", { name: "承認を申請する" }).click();
  await expect(page.getByText("審査中")).toBeVisible({ timeout: 15_000 }); // 版の状態ピル in_review
  await page.getByRole("button", { name: "承認する" }).first().click();
  const approveDialog = page.getByRole("dialog", { name: "この版を承認しますか" });
  await expect(approveDialog.getByText("対象版 第1版", { exact: true })).toBeVisible(); // 承認対象の版を明示
  await approveDialog.getByLabel("承認の理由（必須）").fill("内容を確認しました（e2eの架空承認）");
  await approveDialog.getByRole("button", { name: "承認する" }).click();
  // 承認済pointer（current_version_id）とdraft pointerは別表示（docs/11「承認版とdraftの別pointer」）
  await expect(page.getByText("有効な承認版 第1版")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("承認済み").first()).toBeVisible(); // 文書の状態ピル

  // 索引job（document.index）の完了を画面（索引状態）で待つ
  await expect(async () => {
    await runLocalCron(request);
    await expect(page.getByText(/索引済み/)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 120_000 });

  // 検索の検証読み（API-76）: 承認・索引化された版がhitする
  await expect(async () => {
    await runLocalCron(request);
    expect((await searchCitations(request, "給水活動")).length).toBeGreaterThan(0);
  }).toPass({ timeout: 120_000 });

  // --- 4) ACL変更（API-99）: 分類の変更。確認ダイアログに差分と緩和方向の注記を出してから行う ---
  const citationsAfterApprove = await searchCitations(request, "給水活動");
  expect(citationsAfterApprove.length).toBeGreaterThan(0);
  await page.getByLabel("分類（変更後）").fill("訓練資料・改訂");
  // ACL変更も同じく応答待ち→トーストの順（T083 R4。上の文書作成と同じ理由）
  const accessPolicyPatched = page.waitForResponse((r) => r.url().endsWith("/access-policy") && r.request().method() === "PATCH");
  await page.getByRole("button", { name: "閲覧許可を変更する" }).click();
  const aclDialog = page.getByRole("dialog", { name: "閲覧の許可を変更しますか" });
  await expect(aclDialog.getByText(/広がる/)).toBeVisible(); // 緩和方向の注記（変更は承認として記録される）
  await aclDialog.getByRole("button", { name: "変更する" }).click();
  expect((await accessPolicyPatched).status()).toBe(200);
  await expect(page.getByRole("status").filter({ hasText: "保存しました" }).first()).toBeVisible();
  await expect(page.getByText("閲覧許可の改訂 第2版", { exact: true })).toBeVisible({ timeout: 15_000 }); // policy_version増分
  // ACL変更（分類のみ。緩和方向のACL変更なし）でも検索はまだhitする
  expect((await searchCitations(request, "給水活動")).length).toBeGreaterThan(0);

  // 撤回の前に、版の原文添付（旧引用リンクの本体。API-27）を検証読みで控える
  const detail = await adminApiData<{ original: { attachmentId: string } | null }>(request, "GET", `/api/v1/documents/${documentId}`);
  expect(detail.status).toBe(200);
  const originalAttachmentId = detail.data.data.original?.attachmentId;
  expect(originalAttachmentId).toBeTruthy();

  // --- 5) 撤回（API-92。理由必須・確認ダイアログ。撤回後はこの詳細も開けなくなる旨を出す） ---
  await page.getByRole("button", { name: "文書を撤回する" }).click();
  const withdrawDialog = page.getByRole("dialog", { name: "この文書を撤回しますか" });
  await expect(withdrawDialog.getByText(/詳細も開けなく/)).toBeVisible();
  await withdrawDialog.getByLabel("撤回の理由（必須）").fill("誤って古い資料を登録したため（e2eの架空撤回）");
  await withdrawDialog.getByRole("button", { name: "撤回する" }).click();
  // 撤回後は詳細が404になるため、画面は一覧へ戻る。一覧の行からも消える（T063）
  await expect(page).toHaveURL(/\/app\/documents$/, { timeout: 15_000 });
  await expect(page.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);

  // --- 6) 検証読み（API）: 検索から消え、旧引用（原文添付）も開けない ---
  const withdrawnSearchHits = await searchCitations(request, "給水活動");
  expect(withdrawnSearchHits).toEqual([]);
  const citeRes = await request.fetch(`${BASE}/api/v1/attachments/${originalAttachmentId}/content`, { headers: { origin: BASE } });
  const oldCitationAccessible = citeRes.ok();
  expect(oldCitationAccessible).toBe(false);
});

/**
 * 抽出不能の表示（PH5レビューB中2。T069完了条件「処理中/抽出不能/失効を明示」の画面側の実測）。
 * 画像だけのPDF（tests/fixtures/documents/image-only-ja.pdf。テキスト演算子が1つも無い=抽出不能スキャン相当。
 * T064のfixture流儀）を原本にした版は、抽出job（document.extract）がdocument_ocr_requiredで保留
 * （manual_review・chunk 0件＝捏造テキストを作らない=T064のfail-closed）になり、版パネルが
 * 「抽出不能（error_codeの日本語）」を出す（DocumentVersionPanel.tsxのJOB_ERROR_LABELS）。
 * この画面で版を作るため依頼job（API-86）を追跡でき、表示分岐の回帰（「抽出済み」等への誤表示）を検知する。
 */
test("image_only_pdf_version_shows_unextractable_reason", async ({ page, request }) => {
  test.setTimeout(180_000);
  const tag = crypto.randomUUID().slice(0, 6);
  const title = `画像だけの訓練資料（架空） ${tag}`;
  const licenseRef = `架空市消防団 検証用許諾 ${tag}`;
  const pdf = readFileSync(new URL("../fixtures/documents/image-only-ja.pdf", import.meta.url));

  await page.goto("/app/documents/new");
  await page.getByLabel("題名").fill(title);
  await page.getByLabel("分類").fill("訓練資料");
  await page.getByRole("button", { name: "文書を作成する" }).click();
  await expect(page).toHaveURL(/\/app\/documents\/[0-9a-f-]{36}$/, { timeout: 15_000 });

  // 原本の添付→検査job（T069本体試験と同じ流儀。jobは開発用トリガで回す）
  await page.setInputFiles('input[type="file"]', { name: "image-only-ja.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(async () => {
    await runLocalCron(request);
    await expect(page.getByText("準備完了")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 120_000 });
  await page.getByLabel("許諾の出典（必須）").fill(licenseRef);
  await page.getByRole("button", { name: "版を作成する" }).click();
  await expect(page.getByText(/第1版/).first()).toBeVisible({ timeout: 15_000 });

  // 抽出jobの完了を画面（抽出状態）で待つ。画像だけのPDFは「抽出不能（error_codeの日本語）」で保留になる
  await expect(async () => {
    await runLocalCron(request);
    await expect(page.getByText(/抽出不能（画像だけのPDFのため抽出できません/)).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 120_000 });

  // 検証読み: 承認・索引の無い版は検索にも乗らない（抽出不能を検索可能と偽装しない。T064）
  expect(await searchCitations(request, tag)).toEqual([]);
});
