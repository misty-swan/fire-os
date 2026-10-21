import { expect, request as playwrightRequest, test, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { acceptInvitationViaUi, adminApiData, apiHeaders, BASE, inviteNewMember, isPhone, newUserContext, uniqueEmail } from "./helpers";

/**
 * 外部障害・通信断・管理者不在の代替運用の演習（T084、NFR-04。docs/08 AT-NFR-04・CT-07・TC-17、docs/07 §1/§5/§7、D08/D17）。
 *
 * 6つの障害を「別のscenario」として順に注入し、各scenarioで「誤った成功表示を出さない」「代替経路が実際に使える」
 * 「アプリを災害時の唯一の連絡系統として扱わない」を観測する。runbook（ops/outage-runbook.md・ops/admin-handover.md・
 * ops/contact-flow.md）の各手順は、この試験が実際に押した画面要素・見た文言で書いている（別担当の机上確認用）。
 *
 * 注入の方法（本番に登録される試験用APIは一切足さない。docs/16「テストのためだけのAPIは本番へ登録しない」）:
 *  1. Googleのみ停止: Google系の全ホスト（maps.googleapis.com / *.google.com / fonts.googleapis.com / gstatic）への
 *     リクエストをpage.routeで遮断する。※実地図（Maps JS）は未接続（MapPageはプレースホルダー＝T021/V05の残）
 *     のため、ここで観測できるのは「施設一覧の経路がGoogleに依存しないこと」と「字形フォントが落ちても操作できること」まで。
 *  2. AIのみ停止: e2eの環境には報告書生成のAI bindingが無い（TEST_AI_FAKE=1でも報告書生成の応答は契約外＝保留になる。
 *     reports.specと同じ既存の条件）。これを「AIだけが使えない」状態として使い、保留表示と手動作成の経路を実際に通す。
 *  3. API保存応答の消失: 点検保存（API-14）のリクエストをroute.fetch()でサーバーへ届け（適用される）、応答だけを
 *     route.abort()で捨てる（offline-sync.specの応答不明と同じ方式）。画面は保存済みと言わず、端末下書き（同じ送信鍵）から
 *     同期の状況（SCR-27）で照会・再送して、業務効果が1回だけであることをAPIで断言する。
 *  4. Queue障害: e2e（wrangler dev）ではQueueの送信失敗を外から注入できない（注入には本番コードへの試験経路が要る）。
 *     送信失敗そのものはworkers試験（tests/jobs.test.ts queue_send_failure_does_not_lose_the_job_and_cron_recovers_it）で
 *     観測する。ここでは「jobがまだ処理されていない間（Queueが届けない間と同じ見え方）」に画面が処理中＝完了ではない、
 *     と表示し続けることを、ローカルCronを回す前の時点で観測する。
 *  5. 通知の到達不明: 文書化済みの試験/デモ用規約（班=「連絡先未登録」の団員は宛先参照がunknown:になり、
 *     inapp providerが結果unknownを返す。docs/03 §1.1。notifications.specと同じ）で到達不明を作る。
 *  6. 正担当の管理者不在: 架空の正担当・副担当の管理者を作り、副担当が正担当の全セッションを失効（API-38の画面）させ、
 *     副担当だけで団員追加と招待発行を続ける。正担当の開いていた画面は次の操作でログインへ戻る。
 *
 * 観測値（ブリーフの4断言）:
 *  - falseSavedOrDeliveredMessages: 障害を注入した操作の結果表示までの間（障害窓）に、画面に現れた成功の文言
 *    （保存しました/送信しました/届きました/完了しました等）の数。DOMの変化を全て監視して数える（2.6秒で消える
 *    トーストも取りこぼさない）。代替経路（手動作成・同期・副担当の操作）の成功は窓の外で、サーバーの状態で裏付ける。
 *  - applicationAsOnlyDispatchChannel: 出動・通知の画面に「正式な連絡/指令は既存の系統」で「アプリは補助」という注記が
 *    無い、または「指令を送信した・全員に届いた」と主張する文言がある場合にtrue。
 *  - mapFailureListStillUsable / manualReportAvailable: 見えるだけでなく、実際に一覧から施設を開き、手動で帳票を作れたとき。
 */

test.setTimeout(600_000); // 6scenario＋招待受領2名（二要素あり）＋Cron待ち

/** 成功の文言（誤成功の検出）。「完了ではありません」等の否定形には当たらない形にする */
// 「配送の処理を終えました」「配送処理済み」は、要確認の併記（「（」が続く）が無い＝緑の完了表示のときだけ数える
// （到達不明・失敗があるのに緑で「終えた」と出すことを誤成功として検出する。レビュー裁定R10）
const SUCCESS_PATTERN = "保存しました|送信しました|送信済み|届きました|到達しました|配信しました|配送しました|完了しました|連絡が完了|全員に届|配送の処理を終えました(?!（)|配送処理済み(?!（)";
/** アプリが正式な指令/連絡の手段であると主張する文言（出てはいけない） */
const DISPATCH_CLAIM = /出動指令を送信|指令を送信しました|全員に(届|連絡)|連絡が完了|安否.{0,6}確認済/;

/** ローカル開発用のCron手動トリガ（本番は毎分自動で走る同じhandleScheduled。docs/03 §1.1-14） */
async function runLocalCron(request: APIRequestContext): Promise<void> {
  await request.fetch(`${BASE}/cdn-cgi/local/scheduled`);
}

/**
 * 画面に現れた成功の文言を全て拾う（MutationObserver。ページ遷移ごとに入れ直す）。
 * 障害窓（fault.label≠null）の間に拾ったものだけを誤成功として数える。
 */
async function watchSuccessMessages(context: BrowserContext, onSeen: (snippet: string) => void): Promise<void> {
  await context.exposeBinding("__foSuccessSeen", (_source, snippet: string) => onSeen(snippet));
  await context.addInitScript((pattern: string) => {
    const re = new RegExp(pattern);
    const w = window as unknown as { __foSuccessSeen?: (s: string) => void };
    const report = (text: string | null) => {
      if (!text) return;
      const m = re.exec(text);
      if (m) void w.__foSuccessSeen?.(text.slice(Math.max(0, m.index - 24), m.index + 32));
    };
    const start = () => {
      new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === "characterData") report(r.target.textContent);
          r.addedNodes.forEach((n) => report(n.textContent));
        }
      }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      report(document.body?.textContent ?? null);
    };
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start);
  }, SUCCESS_PATTERN);
}

/** アプリと同じschema（src/client/offline/store.ts v1）で、その利用者の端末下書きを読む（offline-sync.specと同じ） */
async function draftRows(page: Page, userId: string): Promise<{ operationCode: string; status: string }[]> {
  return page.evaluate(async (userId) => {
    const exists = await new Promise<boolean>((resolve) => {
      const req = indexedDB.open("fireos-drafts");
      req.onsuccess = () => { const db = req.result; const ok = db.objectStoreNames.contains("drafts"); db.close(); resolve(ok); };
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    });
    if (!exists) return [];
    return new Promise<{ operationCode: string; status: string }[]>((resolve, reject) => {
      const open = indexedDB.open("fireos-drafts");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(["drafts"], "readonly");
        const rows = tx.objectStore("drafts").index("by_user").getAll(IDBKeyRange.only(userId));
        tx.oncomplete = () => {
          db.close();
          resolve((rows.result as { operationCode: string; status: string }[]).map((r) => ({ operationCode: r.operationCode, status: r.status })));
        };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }, userId);
}

/** 画面の本文に「正式な連絡/指令は既存系統・アプリは補助」の注記があり、指令/到達を主張する文言が無いか */
async function formalContactNoteShown(page: Page): Promise<{ note: boolean; claim: boolean }> {
  const text = (await page.locator("#main").textContent()) ?? "";
  return { note: /正式な(指令|連絡)/.test(text) && /補助/.test(text), claim: DISPATCH_CLAIM.test(text) };
}

/**
 * scenario 6で作った架空の管理者を、試験の成否・タイムアウトにかかわらず一般の団員へ戻す（レビューA-M2）。
 * 共有のD1に管理者が残ると、member-admin.specの「最後の管理者は停止できない」等の前提が崩れ、
 * 初期管理者が実際に停止されて後続の試験が連鎖して落ちる（T084初回のフルe2eで71件失敗した原因）。
 * - 試験本体のfixtureの`request`はタイムアウト時に先に破棄されるため、管理者のstorageStateで自前のcontextを作る
 * - 全員分を試行してから失敗をまとめて報告する（1人目の失敗で2人目が残らないように）
 */
const ADMIN_STATE = "tests/e2e/.state/admin-storage.json";
const drillAdminIds: string[] = [];
test.afterEach(async () => {
  if (drillAdminIds.length === 0) return;
  const api = await playwrightRequest.newContext({ baseURL: BASE, storageState: ADMIN_STATE });
  const failures: string[] = [];
  try {
    for (const memberId of drillAdminIds.splice(0)) {
      try {
        const list = await api.get(`${BASE}/api/v1/members?limit=200`, { headers: apiHeaders() });
        const rows = ((await list.json()) as { data: { id: string; version: number; roleCodes?: string[]; account: { authzVersion: number } | null }[] }).data;
        const row = rows.find((r) => r.id === memberId);
        if (!row || !(row.roleCodes ?? []).includes("admin")) continue; // 管理者になっていない（役割付与の前に落ちた）
        const res = await api.put(`${BASE}/api/v1/members/${memberId}/roles`, {
          headers: apiHeaders({ "idempotency-key": crypto.randomUUID() }),
          data: JSON.stringify({
            version: row.version, expectedAuthzVersion: row.account?.authzVersion ?? 1, roleCodes: ["member"], scopes: [],
            reason: "e2e: 障害演習の終了（架空の管理者を一般の団員へ戻す）",
          }),
        });
        if (res.status() !== 200) failures.push(`${memberId}: ${res.status()} ${await res.text()}`);
      } catch (e) {
        failures.push(`${memberId}: ${String(e)}`);
      }
    }
  } finally {
    await api.dispose();
  }
  expect(failures, "演習の管理者を一般の団員へ戻せなかった（共有D1に管理者が残る）").toEqual([]);
});

// 幅: 両方（scenario1のGoogle全断時の代替経路がスマホ/PCで導線違い）
test("outage_never_claims_dispatch_or_saved_success", async ({ page, browser, request }, testInfo) => {
  const viewport = testInfo.project.use.viewport!;
  const phone = isPhone(viewport);
  const tag = crypto.randomUUID().slice(0, 6);
  page.on("dialog", (d) => void d.accept()); // 未保存離脱の確認（beforeunload）は「離れる」扱い

  // --- 誤成功の監視（障害窓の間だけ数える） ---
  const fault: { label: string | null } = { label: null };
  const falseHits: string[] = [];
  // 陽性対照（レビューB-I1）: 障害窓の外で拾った成功表示も、そのときの段階名つきで別に記録する。
  // 障害解除後の通常の保存（手動帳票の「保存しました」）をこの記録で拾えたことを断言し、検出器が実際に
  // 動いている（恒真の0ではない）ことを示す
  const outsideHits: string[] = [];
  const phase: { label: string } = { label: "seed" };
  const onSeen = (snippet: string) => {
    if (fault.label) falseHits.push(`${fault.label}: ${snippet}`);
    else outsideHits.push(`${phase.label}: ${snippet}`);
  };
  // 窓を閉じる前に少し待つ（exposeBindingの呼出しは非同期で、閉じた直後に届く検出を取りこぼさない。レビューA-M3）
  const closeFaultWindow = async (p: Page = page) => {
    await p.waitForTimeout(1_500);
    fault.label = null;
  };
  await watchSuccessMessages(page.context(), onSeen);
  const dispatchChecks: { screen: string; note: boolean; claim: boolean }[] = [];

  // --- seed（API。業務操作は以下すべてUI）: 管理者の団員ID、施設＋承認済み様式、過去の活動＋実績、
  //     到達不明になる団員と通知の源の予定、模擬出動 ---
  const me = await adminApiData<{ profile: { memberId: string } }>(page.request, "GET", "/api/v1/me");
  expect(me.status).toBe(200);
  const adminMemberId = me.data.data.profile.memberId;
  const managementNumber = `OUT-${tag}`;
  const facility = await adminApiData<{ id: string }>(page.request, "POST", "/api/v1/facilities", {
    type: "hydrant", latitude: 30.377, longitude: 130.664, locationSource: "架空市台帳",
    locationNote: `障害演習 ${tag}`, managementNumber,
  });
  expect(facility.status).toBe(201);
  const facilityId = facility.data.data.id;
  const tpl = await adminApiData<{ id: string; versions: { id: string }[] }>(page.request, "POST", "/api/v1/inspection-templates", {
    name: `様式 ${tag}`, targetType: "facility",
    itemSchema: [{ code: "exterior", label: "本体の外観", valueType: "select", required: true, allowedResults: ["ok", "needs_review"] }],
  });
  expect(tpl.status).toBe(201);
  await adminApiData(page.request, "POST", `/api/v1/inspection-templates/${tpl.data.data.id}/decision`, { version: 1, templateVersionId: tpl.data.data.versions[0]!.id, decision: "request_review", reason: "x" });
  await adminApiData(page.request, "POST", `/api/v1/inspection-templates/${tpl.data.data.id}/decision`, { version: 2, templateVersionId: tpl.data.data.versions[0]!.id, decision: "approve", reason: "x" });

  // =====================================================================================
  // scenario 1: Googleのみ停止 → 施設一覧で探して開き、点検へ進める（TC-17。地図に依存しない経路）
  // =====================================================================================
  let googleRequests = 0;
  await page.route(/(^https?:\/\/([a-z0-9-]+\.)*(google\.com|googleapis\.com|gstatic\.com)\/)/, (route) => {
    googleRequests++;
    return route.abort();
  });
  fault.label = "google";
  await page.goto("/app/map");
  await expect(page.getByText("施設一覧を取得中…")).toBeHidden({ timeout: 30_000 });
  const listRow = page.getByRole("button", { name: new RegExp(`障害演習 ${tag}`) });
  if (phone) {
    await page.getByRole("button", { name: "一覧", exact: true }).click();
    await listRow.click();
    // スマホの一覧の行は施設詳細（SCR-05）へ
    await expect(page).toHaveURL(new RegExp(`/app/facilities/${facilityId}$`), { timeout: 15_000 });
    await expect(page.getByText(managementNumber).first()).toBeVisible();
  } else {
    // PCは右パネルの一覧で検索して選ぶ→詳細（座標・管理番号）→点検を依頼
    await page.getByPlaceholder("施設名・管理番号・住所").fill(managementNumber);
    await listRow.click();
    await expect(page.getByText("座標（外部マップへ送る値）")).toBeVisible();
    await expect(page.getByText(managementNumber).first()).toBeVisible();
  }
  // 一覧から開いた先（スマホ=施設詳細のURL、PC=右パネルの詳細）に、選んだ施設の管理番号が見えていること。
  // 待つ断言の成否で決める（isVisible()は待たずに一瞬で判定し、first()が非表示の要素を掴むと揺れる）
  const mapFailureListStillUsable = await expect(page.getByText(managementNumber).locator("visible=true").first())
    .toBeVisible({ timeout: 10_000 })
    .then(() => (phone ? new URL(page.url()).pathname === `/app/facilities/${facilityId}` : true))
    .catch(() => false);
  await closeFaultWindow();
  await page.unroute(/(^https?:\/\/([a-z0-9-]+\.)*(google\.com|googleapis\.com|gstatic\.com)\/)/);
  testInfo.annotations.push({ type: "google-blocked-requests", description: String(googleRequests) });

  // =====================================================================================
  // scenario 3: API保存応答の消失（点検保存がサーバーに届き、応答だけが失われる）
  //   → 保存済みと言わない → 端末下書き（同じ送信鍵）→ 同期の状況で照会・再送 → 効果は1回
  // =====================================================================================
  await page.goto(`/app/facilities/${facilityId}/inspections/new`);
  await expect(page.getByRole("heading", { name: "点検登録" })).toBeVisible();
  await page.getByRole("button", { name: `様式 ${tag}` }).click();
  await page.getByRole("button", { name: "良好" }).click();
  await page.getByRole("button", { name: /写真・メモへ進む/ }).click();
  await page.getByLabel("メモ・特記事項").fill(`応答消失の演習（架空） ${tag}`);
  await page.getByRole("button", { name: /確認へ進む/ }).click();
  let forwarded = 0;
  await page.route("**/api/v1/facilities/*/inspections", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    forwarded++;
    await route.fetch(); // サーバーへは届く（適用される）
    await route.abort(); // 応答だけを捨てる
  });
  fault.label = "api-response-lost";
  await page.getByRole("button", { name: "点検を保存" }).click();
  await expect(page.getByText(/結果を確認できません/)).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(3_000); // 遅れて出る成功表示（トースト）が無いことも窓の中で見る
  await closeFaultWindow();
  await page.unroute("**/api/v1/facilities/*/inspections");
  expect(forwarded).toBe(1);
  // サーバーには1件ある（応答が失われただけ）。画面は保存済みと言っていない
  const afterLoss = await adminApiData<{ id: string }[]>(page.request, "GET", `/api/v1/facilities/${facilityId}/inspections`);
  expect(afterLoss.data.data).toHaveLength(1);
  // 結果不明の操作は同じ送信鍵のまま端末下書きに置かれる（SCR-27から照会・再送できる）
  await expect.poll(async () => (await draftRows(page, adminMemberId)).filter((r) => r.operationCode === "facility_inspection.create").length, { timeout: 15_000 }).toBe(1);
  // 同期の状況（SCR-27）で照会・再送する（起動時同期が先に走ることもある。どちらでも結果は同じ）
  await page.goto("/app/sync");
  await expect(async () => {
    const syncNow = page.getByRole("button", { name: "今すぐ同期" });
    if (await syncNow.isEnabled().catch(() => false)) await syncNow.click();
    await expect(page.getByText("同期待ちの入力はありません。")).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  expect(await draftRows(page, adminMemberId)).toHaveLength(0);
  // 同じ送信鍵の再送は新しい点検を作らない（業務効果は1回）
  const afterSync = await adminApiData<{ id: string }[]>(page.request, "GET", `/api/v1/facilities/${facilityId}/inspections`);
  expect(afterSync.data.data).toHaveLength(1);

  // =====================================================================================
  // scenario 4＋2: Queueが届けない間の見え方（処理中＝完了ではない）→ AIのみ停止（保留）→ 手動で帳票を作る
  // =====================================================================================
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const activity = await adminApiData<{ id: string }>(page.request, "POST", "/api/v1/activities", {
    title: `障害演習の訓練 ${tag}`, kind: "訓練",
    plannedStartsAt: ago(3 * 864e5), plannedEndsAt: ago(3 * 864e5 - 2 * 3600e3),
    locationText: "架空市第三分団詰所", ownerMemberId: adminMemberId, audienceMemberIds: [adminMemberId],
  });
  expect(activity.status).toBe(201);
  const activityId = activity.data.data.id;
  expect((await adminApiData(page.request, "PATCH", `/api/v1/activities/${activityId}`, { version: 1, status: "scheduled" })).status).toBe(200);
  const activityDetail = await adminApiData<{ version: number }>(page.request, "GET", `/api/v1/activities/${activityId}`);
  const result = await adminApiData(page.request, "POST", `/api/v1/activities/${activityId}/actual-results`, {
    activityVersion: activityDetail.data.data.version, content: `放水訓練を実施 ${tag}`,
    actualStartsAt: ago(3 * 864e5 - 3600e3),
    participants: [{ memberId: adminMemberId, actualStatus: "participated" }], attachmentIds: [],
  });
  expect(result.status).toBe(201);

  await page.goto(`/app/reports?activity=${activityId}`);
  await expect(page.getByText("この活動の報告書")).toBeVisible();
  fault.label = "queue-not-delivered";
  await page.getByRole("button", { name: "AIで下書き生成" }).click();
  // Cronを回す前（jobが処理されていない間）は「処理中であり完了ではありません」
  await expect(page.getByText("AIが下書きを作成しています")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/処理中であり完了ではありません/)).toBeVisible();
  fault.label = "ai-down";
  await expect(async () => {
    await runLocalCron(page.request);
    await expect(page.getByText("保留（AIだけで決めない）")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 120_000 });
  await expect(page.getByText(/この環境ではAIを使えないため/)).toBeVisible();
  await closeFaultWindow();
  // 手動作成（AIが止まったままでも人の入力で作れる。API-62）。障害窓の外の正当な保存＝陽性対照の段階
  phase.label = "control:manual-report";
  await page.getByRole("button", { name: "手動で作成" }).click();
  await page.getByLabel("実施内容").fill(`放水訓練を実施した（手動作成・架空） ${tag}`);
  await page.getByRole("button", { name: "下書きを作成" }).click();
  await expect(page).toHaveURL(/\/app\/reports\/[^/]+\/draft$/, { timeout: 15_000 });
  const reportId = new URL(page.url()).pathname.split("/")[3]!;
  const report = await adminApiData<{ report: { id: string }; versions: { text: string; modelId?: string | null }[] }>(page.request, "GET", `/api/v1/reports/${reportId}`);
  phase.label = "after-manual-report";
  const manualReportAvailable = report.status === 200 && report.data.data.versions.some((v) => v.text.includes(`手動作成・架空） ${tag}`));

  // =====================================================================================
  // scenario 5: 通知の到達不明 → 「到達不明」と表示し、送信済み/到達とは言わない。正式連絡は既存系統の注記
  // =====================================================================================
  const unreachable = await adminApiData<{ id: string }>(page.request, "POST", "/api/v1/members", {
    displayName: `架空 連絡不明 ${tag}`, status: "active", rank: "団員", squad: "連絡先未登録",
  });
  expect(unreachable.status).toBe(201);
  const upcoming = await adminApiData<{ id: string }>(page.request, "POST", "/api/v1/activities", {
    title: `障害演習の招集 ${tag}`, kind: "訓練", plannedStartsAt: new Date(Date.now() + 7 * 864e5).toISOString(),
    locationText: "架空市中央公園", ownerMemberId: adminMemberId, audienceMemberIds: [unreachable.data.data.id],
  });
  expect(upcoming.status).toBe(201);
  expect((await adminApiData(page.request, "PATCH", `/api/v1/activities/${upcoming.data.data.id}`, { version: 1, status: "scheduled", reason: "対象を確定して公開" })).status).toBe(200);

  await page.goto("/app/tasks-notifications/notifications/new");
  await page.getByLabel("通知の源").selectOption("activity");
  const sourceSelect = page.getByLabel("抽出する予定");
  await sourceSelect.selectOption((await sourceSelect.locator("option", { hasText: `障害演習の招集 ${tag}` }).getAttribute("value"))!);
  await expect(page.getByLabel("本文")).toHaveValue(/出欠確認/);
  await page.getByRole("button", { name: "下書きを作成" }).click();
  await expect(page.getByLabel("承認前の確認").getByText(/対象者（1人/)).toBeVisible();
  dispatchChecks.push({ screen: "通知の承認前確認", ...(await formalContactNoteShown(page)) });
  await page.getByRole("button", { name: "承認する" }).click();
  fault.label = "delivery-unknown";
  await page.getByRole("dialog", { name: "この通知を承認して送信しますか" }).getByRole("button", { name: "承認する" }).click();
  const results = page.getByLabel("配送結果");
  await expect(async () => {
    await runLocalCron(page.request);
    // 「結果を確認」は到達不明が1人以上のときだけ出る（凡例の「到達不明」は0人でも出るため、こちらで待つ）
    await expect(results.getByRole("button", { name: "結果を確認" })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  // 受付済み0人・到達不明1人（受付≠到達。承認だけで届いたとは数えない）
  await expect(results.locator("li", { hasText: "送信先で受け付けた" })).toContainText("0人");
  await expect(results.locator("li", { hasText: "結果が確認できず人確認が必要" })).toContainText("1人");
  await results.getByRole("button", { name: "結果を確認" }).click();
  await expect(results.getByText(`架空 連絡不明 ${tag}`).first()).toBeVisible();
  await expect(results.getByText(/対象者に直接確認してください/)).toBeVisible();
  await page.waitForTimeout(3_000);
  await closeFaultWindow();
  dispatchChecks.push({ screen: "通知の配送結果", ...(await formalContactNoteShown(page)) });

  // 出動の画面（一覧・詳細）にも「正式な指令ではない・補助」の注記があり、指令送信を主張しない
  const incident = await adminApiData<{ id: string }>(page.request, "POST", "/api/v1/incidents", {
    kind: "simulation", occurredAt: new Date().toISOString(), summary: `障害演習の模擬出動 ${tag}`,
  });
  expect(incident.status).toBe(201);
  await page.goto("/app/incidents");
  await expect(page.getByText(/正式な指令ではありません/)).toBeVisible();
  dispatchChecks.push({ screen: "出動一覧", ...(await formalContactNoteShown(page)) });
  await page.goto(`/app/incidents/${incident.data.data.id}`);
  await expect(page.getByText(`障害演習の模擬出動 ${tag}`).first()).toBeVisible();
  dispatchChecks.push({ screen: "出動詳細", ...(await formalContactNoteShown(page)) });
  await page.goto("/app/tasks-notifications");
  await expect(page.locator("#main")).toBeVisible();
  dispatchChecks.push({ screen: "タスク・通知", ...(await formalContactNoteShown(page)) });

  // =====================================================================================
  // scenario 6: 正担当の管理者不在 → 副担当が正担当のセッションを失効させ、団員追加と招待発行を続ける
  // =====================================================================================
  const makeAdmin = async (label: string) => {
    const email = uniqueEmail(`e2e-out-${label}-${tag}`);
    const name = `架空 ${label === "primary" ? "正担当" : "副担当"}管理者 ${tag}`;
    const invited = await inviteNewMember(request, name, email);
    const ctx = await newUserContext(browser, viewport);
    await watchSuccessMessages(ctx, onSeen);
    const p = await ctx.newPage();
    p.on("dialog", (d) => void d.accept());
    await acceptInvitationViaUi(p, email, invited.token, { mfa: true }); // 管理操作は二要素必須
    const rows = (await adminApiData<{ id: string; version: number; account: { authzVersion: number } | null }[]>(request, "GET", "/api/v1/members?limit=200")).data.data;
    const row = rows.find((r) => r.id === invited.memberId)!;
    drillAdminIds.push(invited.memberId); // 付与の前に登録（付与後に落ちても afterEach が戻す）
    const roles = await adminApiData(request, "PUT", `/api/v1/members/${invited.memberId}/roles`, {
      version: row.version, expectedAuthzVersion: row.account?.authzVersion ?? 1, roleCodes: ["admin"], scopes: [],
      reason: `e2e: 障害演習の${label === "primary" ? "正担当" : "副担当"}管理者（架空）`,
    });
    expect(roles.status).toBe(200);
    return { ctx, page: p, name, memberId: invited.memberId };
  };
  const primary = await makeAdmin("primary");
  const deputy = await makeAdmin("deputy");
  // 正担当は管理画面を開いている（この後、不在＝端末紛失の申告）
  await primary.page.goto("/app/admin");
  await expect(primary.page.getByRole("list", { name: "管理する団員" })).toBeVisible();

  // 副担当が管理画面で正担当を選び、全セッションを失効させる（ops/admin-handover.md の手順）
  await deputy.page.goto("/app/admin");
  await deputy.page.getByRole("list", { name: "管理する団員" }).getByRole("button", { name: new RegExp(primary.name) }).click();
  await expect(deputy.page.getByRole("heading", { name: new RegExp(`${primary.name}.*の管理`) })).toBeVisible();
  await deputy.page.getByRole("button", { name: "全セッションを失効させる" }).click();
  const revoke = deputy.page.getByRole("dialog", { name: "全セッションの失効" });
  await revoke.getByLabel("理由").fill("正担当の不在・端末紛失の申告（架空の演習）");
  await revoke.getByRole("button", { name: "失効させる" }).click();
  await expect(deputy.page.getByText("全端末のログインを解除しました")).toBeVisible();

  // 正担当の開いていた画面は、次の操作でログインへ戻る（失効が次の要求で効く）
  fault.label = "primary-admin-absent";
  await primary.page.goto("/app/admin");
  await expect(primary.page).toHaveURL(/\/login/, { timeout: 15_000 });
  await closeFaultWindow(primary.page);

  // 副担当だけで業務を続ける: 団員を追加し、その団員へ招待を発行する
  const newcomer = `架空 新入団員 ${tag}`;
  await deputy.page.goto("/app/members");
  await deputy.page.getByRole("button", { name: "団員を追加" }).click();
  const add = deputy.page.getByRole("dialog", { name: "団員を追加" });
  await add.getByLabel("氏名").fill(newcomer);
  await add.getByLabel("役職").fill("団員");
  await add.getByLabel("班").fill("2班");
  await add.getByRole("button", { name: "団員を登録" }).click();
  await expect(deputy.page.getByRole("list", { name: "団員一覧" }).getByText(newcomer)).toBeVisible();
  await deputy.page.goto("/app/admin");
  await deputy.page.getByRole("list", { name: "管理する団員" }).getByRole("button", { name: new RegExp(newcomer) }).click();
  await deputy.page.getByLabel("招待先のメールアドレス").fill(uniqueEmail(`e2e-out-new-${tag}`));
  await deputy.page.getByRole("button", { name: "招待を発行する" }).click();
  await expect(deputy.page.getByLabel("招待リンク")).toContainText("/login#invite=");
  const deputyContinued = await deputy.page.getByLabel("招待リンク").isVisible();
  expect(deputyContinued).toBe(true);
  await primary.ctx.close();
  await deputy.ctx.close();

  // --- まとめ（ブリーフの4断言） ---
  const falseSavedOrDeliveredMessages = falseHits.length;
  // 陽性対照: 障害解除後の手動帳票の保存（「保存しました」トースト）を同じ検出器が拾っている
  const detectorCaughtKnownSuccess = outsideHits.some((h) => h.startsWith("control:manual-report:") && h.includes("保存しました"));
  testInfo.annotations.push({ type: "outside-window-hits", description: JSON.stringify(outsideHits) });
  const applicationAsOnlyDispatchChannel = dispatchChecks.some((c) => !c.note || c.claim);
  testInfo.annotations.push({ type: "false-success-hits", description: JSON.stringify(falseHits) });
  testInfo.annotations.push({ type: "dispatch-checks", description: JSON.stringify(dispatchChecks) });
  console.log(`[T084] falseHits=${JSON.stringify(falseHits)} outsideHits=${JSON.stringify(outsideHits)} dispatchChecks=${JSON.stringify(dispatchChecks)} googleBlocked=${googleRequests}`);

  expect(detectorCaughtKnownSuccess, "誤成功の検出器が既知の成功表示を拾えていない（検出器の故障＝0件が恒真になる）").toBe(true);
  expect(mapFailureListStillUsable).toBe(true);
  expect(manualReportAvailable).toBe(true);
  expect(falseSavedOrDeliveredMessages).toBe(0);
  expect(applicationAsOnlyDispatchChannel).toBe(false);
});
