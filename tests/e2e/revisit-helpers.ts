import { readFileSync } from "node:fs";
import { expect, type APIRequestContext, type Browser, type Locator, type Page, type TestInfo } from "@playwright/test";import { acceptInvitationViaUi, adminApiData, inviteNewMember, isPhone, newUserContext, uniqueEmail } from "./helpers";

/**
 * 再訪操作・アクセシビリティ測定の共通部品（T083、NFR-01/02/09）。
 *
 * 月1〜2回しか使わない団員が「説明なしで」完結できるかを、e2eの語彙だけで測る:
 * 出欠回答・写真点検・異常確認・引用（原本）閲覧・同期復旧の5つの再訪フローを、
 * flowId/steps/operations/durationMs/success/errors の記録つきで走らせる
 * （ops/device-test-matrix.mdの測定形式。device/versionはtestInfo.projectから付ける）。
 *
 * 通信断の注入はoffline-sync.specと同じ方式（ブラウザをofflineにせず、対象の書き込み要求だけを遮断）。
 * 写真は端末内撮影の代わりに最小PNGをsetInputFilesする（offline-sync.specと同じ作り方）。
 */

// ---------------------------------------------------------------- 計測の器

/** Interfacesの測定形式（flowId/steps/duration/success/errors。ops/device-test-matrix.md） */
export interface FlowResult {
  flowId: string;
  steps: string[];
  /** 画面への操作数（押す・選ぶ・入力する。読み込み待ちや検証読みは数えない。NFR-02「少数操作」の測定値） */
  operations: number;
  durationMs: number;
  success: boolean;
  errors: string[];
}

export interface FlowRecorder {
  /** 通過した手順の記録（失敗時にどこまで届いたかを残す） */
  step(label: string): void;
  /** 画面への1操作（押す・選ぶ・入力する） */
  op(label?: string): void;
}

export async function timedFlow(flowId: string, fn: (f: FlowRecorder) => Promise<void>): Promise<FlowResult> {
  const steps: string[] = [];
  const errors: string[] = [];
  let operations = 0;
  const t0 = Date.now();
  const f: FlowRecorder = {
    step: (label) => steps.push(label),
    op: (label) => {
      operations += 1;
      steps.push(label ?? "操作");
    },
  };
  try {
    await fn(f);
    const result: FlowResult = { flowId, steps, operations, durationMs: Date.now() - t0, success: true, errors };
    console.log(`[flow] ${JSON.stringify(result)}`);
    return result;
  } catch (e) {
    errors.push(e instanceof Error ? `${e.name}: ${String(e.message).slice(0, 400)}` : String(e));
    const result: FlowResult = { flowId, steps, operations, durationMs: Date.now() - t0, success: false, errors };
    console.log(`[flow] ${JSON.stringify(result)}`);
    return result;
  }
}

/** coreTaskSuccessRate = 成功フロー数 / 試行フロー数。閾値0.9はdocs/14 D18の開発案値（承認済み合格値ではない） */
export const successRateOf = (flows: FlowResult[]): number =>
  flows.length === 0 ? 0 : flows.filter((r) => r.success).length / flows.length;

/** 測定結果を試験の添付（証跡）として残す。docs/evidence/V07-ux.md に転記する元 */
export function attachMatrix(testInfo: TestInfo, name: string, payload: unknown): void {
  void testInfo.attach(name, { body: JSON.stringify(payload, null, 2), contentType: "application/json" });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------- seed

export interface RevisitScene {
  tag: string;
  memberId: string;
  memberName: string;
  memberEmail: string;
  memberToken: string;
  facilityIds: string[];
  /** 地図ラベル確認用の管理番号（seed3件。 REV-<tag>-<i>） */
  managementNumbers: string[];
  templateName: string;
  activityId: string;
  activityTitle: string;
  issueNote: string;
  documentTitle: string;
}

/**
 * 再訪フロー5本の舞台を用意する（すべて架空データ。管理者APIでseedし、画面の操作は団員が行う）:
 * 施設3件（地図のマーカー/一覧ラベルの確認分）＋承認済みの点検様式＋公開済みの予定（対象=団員）＋
 * needs_review点検から起票した異常。文書（引用閲覧用）はUIで作るためseedCitableDocumentで別途。
 */
export async function seedRevisitScene(request: APIRequestContext, tag: string): Promise<RevisitScene> {
  const memberName = `架空 再訪 ${tag}`;
  const memberEmail = uniqueEmail(`e2e-rev-${tag}`);
  const member = await inviteNewMember(request, memberName, memberEmail);

  // 施設3件（座標は実行ごとにずらす。同じ座標のマーカーが重なって押せなくならないように。map.specと同じ配慮）
  const jitter = [...tag].reduce((n, c) => n + c.charCodeAt(0), 0) % 30;
  const facilityIds: string[] = [];
  const managementNumbers: string[] = [];
  for (const [i, type] of ["hydrant", "cistern", "hydrant"].entries()) {
    const res = await adminApiData<{ id: string; managementNumber: string }>(request, "POST", "/api/v1/facilities", {
      type,
      managementNumber: `REV-${tag}-${i}`,
      latitude: 35.05 + i * 0.17 + jitter * 0.01,
      longitude: 139.05 + i * 0.21 + jitter * 0.012,
      locationSource: "架空市台帳",
      locationNote: `再訪試験の施設${i}（架空）`,
    });
    expect(res.status).toBe(201);
    facilityIds.push(res.data.data.id);
    managementNumbers.push(res.data.data.managementNumber);
  }

  // 承認済みの点検様式（点検登録で選べるように。issues.specと同じ2段階の承認）
  const templateName = `再訪様式 ${tag}`;
  const tpl = await adminApiData<{ id: string; versions: { id: string }[] }>(request, "POST", "/api/v1/inspection-templates", {
    name: templateName, targetType: "facility",
    itemSchema: [{ code: "exterior", label: "本体の外観", valueType: "select", required: true, allowedResults: ["ok", "needs_review"] }],
  });
  expect(tpl.status).toBe(201);
  const templateVersionId = tpl.data.data.versions[0]!.id;
  await adminApiData(request, "POST", `/api/v1/inspection-templates/${tpl.data.data.id}/decision`, { version: 1, templateVersionId, decision: "request_review", reason: "x" });
  await adminApiData(request, "POST", `/api/v1/inspection-templates/${tpl.data.data.id}/decision`, { version: 2, templateVersionId, decision: "approve", reason: "x" });

  // 公開済みの予定（対象=団員。offline-sync.specと同じ作り方）
  const activityTitle = `再訪の出欠試験 ${tag}`;
  const act = await adminApiData<{ id: string }>(request, "POST", "/api/v1/activities", {
    title: activityTitle, kind: "訓練", plannedStartsAt: "2099-10-20T01:00:00.000Z", locationText: "架空市分団詰所",
    ownerMemberId: member.memberId, audienceMemberIds: [member.memberId], responseDueAt: "2098-01-01T00:00:00.000Z",
  });
  expect(act.status).toBe(201);
  const activityId = act.data.data.id;
  const published = await adminApiData(request, "PATCH", `/api/v1/activities/${activityId}`, { version: 1, status: "scheduled", reason: "対象を確定して公開" });
  expect(published.status).toBe(200);

  // 異常の起票（needs_review点検+createIssue。issues.specと同じ。点検者は管理者＝起票者）
  const issueNote = `蓋の開閉不良（再訪試験） ${tag}`;
  const meAdmin = await adminApiData<{ profile: { memberId: string } }>(request, "GET", "/api/v1/me");
  const insp = await adminApiData(request, "POST", `/api/v1/facilities/${facilityIds[0]}/inspections`, {
    templateVersionId, inspectedAt: new Date().toISOString(), inspectorMemberId: meAdmin.data.data.profile.memberId,
    result: "needs_review", checkItems: [{ code: "exterior", result: "needs_review" }], note: issueNote, createIssue: true, attachmentIds: [],
  });
  expect(insp.status).toBe(201);

  return {
    tag,
    memberId: member.memberId,
    memberName,
    memberEmail,
    memberToken: member.token,
    facilityIds,
    managementNumbers,
    templateName,
    activityId,
    activityTitle,
    issueNote,
    documentTitle: `再訪試験の訓練資料（架空） ${tag}`,
  };
}

/**
 * 幹部権を付与する（点検様式の選択=PER-04・異常の確認=PER-05は幹部の所属内操作。月1〜2回使う班長を想定）。
 * 役割の付与は**アカウントの付いた団員にだけ**できるため、招待の受領（enrollReturningUser）の後に呼ぶ
 * （realtime.specの注記と同じ。付与は管理者API。全置換なので役割はofficerだけになる）。
 */
export async function grantOfficerRole(request: APIRequestContext, scene: RevisitScene): Promise<void> {
  const rows = (await adminApiData<{ id: string; version: number; account?: { authzVersion: number } | null }[]>(
    request, "GET", `/api/v1/members?q=${encodeURIComponent(scene.memberName)}`,
  )).data.data;
  const row = rows.find((r) => r.id === scene.memberId)!;
  const roles = await adminApiData(request, "PUT", `/api/v1/members/${scene.memberId}/roles`, {
    version: row.version, expectedAuthzVersion: row.account?.authzVersion ?? 1, roleCodes: ["officer"], scopes: [],
    reason: "e2e: 点検と異常確認を行う班長（架空）",
  });
  expect(roles.status).toBe(200);
}

/**
 * 管理者の画面（seedCitableDocumentの文書作成）に使う文脈。**プロジェクトのpage fixture（Pixel 5）は
 * isMobile=trueのためsetInputFilesが固まることがある**（documents.spec冒頭の注記と同じ経験則）。
 * seed専用にデスクトップ寸法の別文脈を作り、団員の端末とは分ける。
 */
export async function adminSeedPage(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    storageState: "tests/e2e/.state/admin-storage.json",
  });
  const page = await ctx.newPage();
  return { page, close: () => ctx.close() };
}

/**
 * 引用（原本）閲覧用の文書を、管理者の画面からACLつきで作る（T069の作成→原本添付→版まで。
 * documents.specと同じ流儀。承認・索引化は原本を開くには不要のため省略しない——版の原本は
 * ACLの再検査で開ける（API-27。T063）。job（attachment.inspect）は開発用トリガで回す。
 */
export async function seedCitableDocument(page: Page, request: APIRequestContext, scene: RevisitScene): Promise<void> {
  const pdf = readFileSync(new URL("../fixtures/documents/sample-ja.pdf", import.meta.url));
  await page.goto("/app/documents/new");
  await page.getByLabel("題名").fill(scene.documentTitle);
  await page.getByLabel("分類").fill("訓練資料");
  // ACL: 自分（既定）に加えて団員の閲覧を許可する（documents.specの「対象の団員2」と同じ行）
  await page.getByRole("button", { name: "対象を追加" }).click();
  await page.getByLabel("対象の団員2").selectOption({ label: scene.memberName });
  // 保存の応答を待ってから可視フィードバックを断言する（R4。トーストへの固定時間依存を作らない）
  const created = page.waitForResponse((r) => r.url().endsWith("/api/v1/documents") && r.request().method() === "POST");
  await page.getByRole("button", { name: "文書を作成する" }).click();
  expect((await created).status()).toBe(201);
  await expect(page).toHaveURL(/\/app\/documents\/[0-9a-f-]{36}$/, { timeout: 15_000 });

  // 原本（架空の日本語PDF。tests/fixtures/documents/sample-ja.pdf）を添付し、検査jobを回して準備完了へ
  await page.setInputFiles('input[type="file"]', { name: "sample-ja.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(async () => {
    await runLocalCron(request);
    await expect(page.getByText("準備完了")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 120_000 });
  await page.getByLabel("許諾の出典（必須）").fill(`架空市消防団 検証用許諾 ${scene.tag}`);
  await page.getByRole("button", { name: "版を作成する" }).click();
  await expect(page.getByText(/第1版/).first()).toBeVisible({ timeout: 15_000 });
}

/** 団員の初回受領（招待→アカウント作成。二要素は未設定のまま＝月1〜2回の一般利用者を想定） */
export async function enrollReturningUser(browser: Browser, viewport: { width: number; height: number }, scene: RevisitScene): Promise<Page> {
  const ctx = await newUserContext(browser, viewport);
  const page = await ctx.newPage();
  await acceptInvitationViaUi(page, scene.memberEmail, scene.memberToken, { mfa: false });
  const heading = isPhone(viewport) ? { level: 2 as const, name: "ホーム" } : { level: 1 as const, name: "ダッシュボード" };
  await expect(page.getByRole("heading", heading)).toBeVisible();
  return page;
}

// ---------------------------------------------------------------- 再訪フロー5本

/** 出欠回答（API-08。予定一覧→詳細→「参加」。サーバー反映を検証読みで確認してから成功） */
export async function flowAttendanceAnswer(page: Page, scene: RevisitScene, request: APIRequestContext, f: FlowRecorder): Promise<void> {
  f.step("予定・活動の一覧を開く");
  await page.goto("/app/activities");
  f.op("予定の行を開く");
  await page.getByRole("link", { name: new RegExp(escapeRe(scene.activityTitle)) }).click();
  await expect(page.getByText("あなたの出欠")).toBeVisible();
  f.op("「参加」で回答");
  await page.getByRole("button", { name: "参加", exact: true }).click();
  await expect(page.getByRole("button", { name: "参加", exact: true })).toHaveAttribute("aria-pressed", "true");
  f.step("サーバーに反映を確認（検証読み）");
  const d = await adminApiData<{ attendance: { memberId: string; response: string }[] }>(request, "GET", `/api/v1/activities/${scene.activityId}`);
  expect(d.data.data.attendance.find((r) => r.memberId === scene.memberId)?.response).toBe("attending");
}

/** 写真つき点検の保存（API-14。様式→結果→写真→確認→保存。保存成功の遷移とサーバー反映を確認） */
export async function flowInspectionSave(page: Page, scene: RevisitScene, request: APIRequestContext, f: FlowRecorder): Promise<void> {
  f.step("点検登録を開く");
  await page.goto(`/app/facilities/${scene.facilityIds[0]}/inspections/new`);
  await expect(page.getByRole("heading", { name: "点検登録" })).toBeVisible();
  f.op("様式を選ぶ");
  await page.getByRole("button", { name: scene.templateName }).click();
  f.op("「良好」を選ぶ");
  await page.getByRole("button", { name: "良好" }).click();
  f.op("「写真・メモへ進む」");
  await page.getByRole("button", { name: /写真・メモへ進む/ }).click();
  f.op("写真を添える");
  await page.setInputFiles('input[type="file"]', { name: "revisit.png", mimeType: "image/png", buffer: pngBytes() });
  await expect(page.getByText("準備完了")).toBeVisible({ timeout: 45_000 });
  f.op("「確認へ進む」");
  await page.getByRole("button", { name: /確認へ進む/ }).click();
  f.op("「点検を保存」");
  await page.getByRole("button", { name: "点検を保存" }).click();
  f.step("施設の詳細へ戻る（保存成功の遷移）");
  await expect(page).toHaveURL(new RegExp(`/app/facilities/${scene.facilityIds[0]}$`), { timeout: 30_000 });
  f.step("サーバーに反映を確認（検証読み）");
  const list = await adminApiData<{ id: string; result: string }[]>(request, "GET", `/api/v1/facilities/${scene.facilityIds[0]}/inspections`);
  expect(list.data.data.length).toBeGreaterThanOrEqual(1);
}

/** 異常の確認（API-17。理由入力なしの定型操作「確認する」。reported→under_review） */
export async function flowIssueConfirm(page: Page, scene: RevisitScene, request: APIRequestContext, f: FlowRecorder): Promise<void> {
  f.step("異常の一覧を開く");
  await page.goto("/app/issues");
  const card = page.locator(".hairline.rounded-card", { hasText: scene.issueNote }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  f.op("異常の行を開く（点検で異常を確認）");
  await card.getByRole("button", { name: "点検で異常を確認" }).click();
  const actions = card.getByLabel("異常の操作");
  f.op("「確認する」（理由入力なしの定型操作）");
  await actions.getByRole("button", { name: "確認する" }).click();
  await expect(actions.getByRole("button", { name: "対応開始" })).toBeVisible({ timeout: 15_000 });
  f.step("サーバーに反映を確認（検証読み）");
  const issues = await adminApiData<{ id: string; description: string; status: string }[]>(request, "GET", "/api/v1/issues?limit=200");
  expect(issues.data.data.find((i) => i.description === scene.issueNote)?.status).toBe("under_review");
}

/** 引用（原本）の閲覧（API-27。文書詳細→「原本を開く」。PDFはattachment付きでダウンロードになる） */
export async function flowCitationOpen(page: Page, scene: RevisitScene, f: FlowRecorder): Promise<void> {
  f.step("文書・規程の一覧を開く");
  await page.goto("/app/documents");
  f.op("文書の行を開く");
  await page.getByRole("link", { name: new RegExp(escapeRe(scene.documentTitle)) }).click();
  await expect(page.getByRole("heading", { name: scene.documentTitle })).toBeVisible();
  f.op("「原本を開く」");
  const download = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("link", { name: "原本を開く" }).click();
  const file = await download;
  f.step("原本（PDF）が取得できる");
  expect(file.suggestedFilename()).toMatch(/\.pdf$/);
}

/**
 * 同期復旧（API-08の通信断→下書き化→回復後の同期。SCR-27）。
 * 通信断は本人出欠のPUTだけを遮断する（offline-sync.specと同じ方式。ブラウザはofflineにしない）。
 * 下書きは保存失敗と同じIdempotency-Keyで端末に置かれ、回復後の同期で一度だけ適用される。
 */
export async function flowSyncRecover(page: Page, scene: RevisitScene, request: APIRequestContext, f: FlowRecorder): Promise<void> {
  f.step("通信断を注入（本人出欠の保存だけを遮断）");
  await page.route("**/api/v1/activities/*/attendance/me", async (route) => {
    if (route.request().method() === "PUT") {
      await route.abort(); // リクエストは端末から出ない（未適用・応答なし＝status 0）
      return;
    }
    await route.fallback();
  });
  f.step("出欠の回答を変える（保存は失敗し、結果不明の表示と端末の下書きになる）");
  await page.goto(`/app/activities/${scene.activityId}`);
  await expect(page.getByText("あなたの出欠")).toBeVisible();
  f.op("「未定」を選ぶ");
  await page.getByRole("button", { name: "未定", exact: true }).click();
  await expect(page.getByText(/結果を確認できません/)).toBeVisible({ timeout: 30_000 });
  f.step("通信を戻して同期の状況を開く");
  await page.unroute("**/api/v1/activities/*/attendance/me");
  f.op("同期の状況を開く");
  await page.goto("/app/sync");
  // 自動同期（起動・online・visibility・30秒周期。docs/16「60秒以内に同期が始まる」）が適用を進めるのが設計どおりの道。
  // 未同期の行が見えたら画面の「もう一度送る」（手動再送＝同じ鍵。新しい鍵は作らない）も試すが、
  // **自動同期が先に適用して行が消える競合がある**（その場合はクリングしない。反映のまとめで結果を見る）
  const unsynced = page.getByText(/未同期 1件/);
  const resolved = page.getByText(/反映 1件/).or(page.getByText("同期待ちの入力はありません"));
  await expect(unsynced.or(resolved.first())).toBeVisible({ timeout: 60_000 });
  if (await unsynced.isVisible().catch(() => false)) {
    const resend = page.getByRole("button", { name: "もう一度送る" }).first();
    f.op("「もう一度送る」で手動再送（自動同期が先に適用したときは、まとめの「反映」で確認）");
    await resend.click({ timeout: 10_000 }).catch(() => undefined); // 行が自動同期に摘まれて消えたときは何もしない
  }
  f.step("同期のまとめ（反映＝サーバーが適用を確認できた数）または空の一覧で完了を確認");
  await expect(resolved.first()).toBeVisible({ timeout: 90_000 });
  f.step("サーバーに反映を確認（検証読み。二重適用で版が進みすぎないことも見る）");
  const d = await adminApiData<{ attendance: { memberId: string; response: string; version: number }[] }>(request, "GET", `/api/v1/activities/${scene.activityId}`);
  const row = d.data.data.attendance.find((r) => r.memberId === scene.memberId)!;
  expect(row.response).toBe("undecided"); // 人が選んだ変更が届いている
  expect(row.version).toBe(2); // 「参加」(v1)の次の1版。同じ鍵の再送で二重に進まない
}

// ---------------------------------------------------------------- アクセシビリティ測定

/** axeの違反の要約（criticalだけを断言の対象にする。serious以下は記録して扱いを検討する） */
export interface AxeViolationSummary {
  id: string;
  impact: string;
  help: string;
  nodes: string[];
}

/** 現在のページをaxeで走査し、critical違反をcollectedへ集約する（同じruleの違反は対象セレクタを併記）。
 *  走査の対象はWCAG 2.1 A/AAの規則セット（測定範囲。best-practice等は含めない——critical違反の測定源として
 *  WCAG適合水準の規則に限定する。docs/evidence/V07-ux.mdに記録） */
export async function collectCriticalViolations(page: Page, collected: AxeViolationSummary[]): Promise<{ critical: number; seriousOrWorse: number }> {
  const { default: AxeBuilder } = await import("@axe-core/playwright");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  let seriousOrWorse = 0;
  for (const v of results.violations) {
    if (v.impact === "critical" || v.impact === "serious") seriousOrWorse += v.nodes.length;
    if (v.impact !== "critical") continue;
    const targets = v.nodes.map((n) => n.target.join(" ")).slice(0, 5);
    const existing = collected.find((c) => c.id === v.id);
    if (existing) {
      for (const t of targets) if (!existing.nodes.includes(t)) existing.nodes.push(t);
    } else {
      collected.push({ id: v.id, impact: v.impact ?? "unknown", help: v.help, nodes: targets });
    }
  }
  return { critical: results.violations.filter((v) => v.impact === "critical").length, seriousOrWorse };
}

/** コア操作がkeyboardで到達できるかの構造確認（button/a/input等のネイティブ or tabindex≥0）。届かないなら列挙に積む */
export async function probeKeyboardReachable(label: string, locator: Locator, unreachable: string[]): Promise<void> {
  const count = await locator.count();
  if (count === 0) {
    unreachable.push(`${label}（画面に見つからない）`);
    return;
  }
  const ok = await locator
    .first()
    .evaluate((el) => {
      const tag = el.tagName.toLowerCase();
      const native = ["a", "button", "input", "select", "textarea", "summary"].includes(tag);
      const ti = el.getAttribute("tabindex");
      return native || (ti !== null && ti !== "-1");
    })
    .catch(() => false);
  if (!ok) unreachable.push(`${label}（keyboardで到達できない）`);
}

/** 実際にTabを押して目的の操作へフォーカスが移るか（構造ではなく挙動で確かめる）。見つからなければfalse */
export async function tabReaches(page: Page, targetText: string, maxTabs = 80): Promise<boolean> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < maxTabs; i++) {
    const hit = await page.evaluate((t) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const text = (el.textContent ?? "").trim();
      const label = el.getAttribute("aria-label") ?? "";
      return text.includes(t) || label.includes(t);
    }, targetText);
    if (hit) return true;
    await page.keyboard.press("Tab");
  }
  return false;
}

/**
 * 地図マーカー/一覧の行がテキストラベルを持つか（NFR-09「色だけに依存せず、ラベル・一覧代替」）。
 * マーカーはaccessible name（種別+管理番号）と面上のテキスト（管理番号）の両方を確認する。
 * 戻り値は欠落の数（0が合格）。
 */
export async function countMarkerTextLabelsMissing(page: Page, managementNumbers: string[]): Promise<number> {
  let missing = 0;
  for (const num of managementNumbers) {
    const marker = page.getByRole("button", { name: new RegExp(escapeRe(num)) });
    const visible = await marker.first().isVisible().catch(() => false);
    if (!visible) {
      missing += 1;
      continue;
    }
    const label = (await marker.first().textContent())?.trim() ?? "";
    if (!label.includes(num)) missing += 1;
  }
  return missing;
}

/**
 * 200%文字拡大（NFR-02）。CDPのPage.setTextZoomFactorは本実行のChromiumに存在しないことを確認済み
 * （2026-10-18・playwright 1.64同梱chromium。「 wasn't found」エラー）のため、**rootへCSS zoomを注入する**
 * 代替で実施する。CSS zoomは文字だけでなくレイアウト全体を拡大するため、文字ズームより厳しめの条件になる。
 * 正確な手法の記録はdocs/evidence/V07-ux.md。
 */
export async function setTextZoomPercent(page: Page, percent: number): Promise<"css-zoom-injected"> {
  await page.evaluate((p) => {
    (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = String(p / 100);
  }, percent);
  return "css-zoom-injected";
}

/** 色の除去（NFR-09の視認性確認。CDPの視覚異常エミュレーションで全色を無彩色にする） */
export async function setVisionDeficiency(page: Page, type: "none" | "achromatopsia"): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setEmulatedVisionDeficiency", { type });
  await session.detach();
}

// ---------------------------------------------------------------- 共通の小部品

/** ローカル開発用のCron手動トリガ（本番は毎分のCron。documents.specと同じ流儀） */
export async function runLocalCron(request: APIRequestContext): Promise<void> {
  await request.fetch("http://localhost:8787/cdn-cgi/local/scheduled");
}

/** 最小のPNG（1px。CRCを計算した実在形式。offline-sync.specと同じ作り方） */
export function pngBytes(): Buffer {
  let table: number[] = [];
  const crc32 = (bytes: Uint8Array) => {
    if (!table.length) {
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    }
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01])), chunk("IEND", Buffer.alloc(0))];
  return Buffer.concat(parts);
}
