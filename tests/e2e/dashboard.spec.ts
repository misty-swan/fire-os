import { expect, test, type APIRequestContext } from "@playwright/test";
import { BASE, acceptInvitationViaUi, adminApiData, apiHeaders, inviteNewMember, newUserContext, uniqueEmail } from "./helpers";

/**
 * ホーム（SCR-02）の指標とドリルダウン（T047、DASH-01/AT-DASH-01）。
 * タイルの数値と遷移先一覧の件数が同じ条件で一致することをUIで確認する:
 * 次回予定のダイヤル→これからの予定の一覧、本人未回答→?unanswered=trueの一覧、確認待ちの異常→点検管理?status=reported、
 * 点検期限（T048で接続）→/app/assets?due=overdue（車両＋資機材の件数の和）、
 * 通知（T052で接続）→タスク・通知画面の未読絞り、自分のタスク（T052で接続）→タスクタブ。
 * 期待値は直前に本人のセッションでAPI-28を読んで取る（他の試験が同じunitにseedしても成立する形）。
 * 通知のseedも実API経由（API-63 draft→API-64承認→ローカルCronトリガで配送。既読にはしない＝未読が残る）。
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** ローカル開発用のCron手動トリガ（本番は毎分自動で走る同じhandleScheduled。notifications.spec.tsと同じ。docs/03 §1.1-14） */
async function runLocalCron(request: APIRequestContext): Promise<void> {
  await request.fetch(`${BASE}/cdn-cgi/local/scheduled`);
}

/** 本人のセッションで一覧API（cursorのkeyset）を最後のページまで読み、行を全部集める（件数を切り捨てない。tests/dashboard.test.tsのwalkと同じ流儀） */
async function walkAll<T>(session: APIRequestContext, path: string, query: Record<string, string> = {}): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams(query);
    params.set("limit", "200");
    if (cursor) params.set("cursor", cursor);
    const res = await session.fetch(`${BASE}${path}?${params.toString()}`, { headers: { origin: BASE } });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data: T[]; meta?: { nextCursor?: string } };
    rows.push(...body.data);
    cursor = body.meta?.nextCursor ?? null;
    if (!cursor) return rows;
  }
  throw new Error("一覧の読み切りが50ページで終わりません");
}

// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("home_metrics_drill_down_to_matching_lists", async ({ browser, request }, testInfo) => {
  test.setTimeout(300_000);
  const viewport = testInfo.project.use.viewport!;
  const tag = crypto.randomUUID().slice(0, 6);
  const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

  // --- 招待受領で一般団員（この人自身がホームを見る。出欠・お知らせの対象者）。名前は他の試験の検索と被らないように ---
  const email = uniqueEmail(`e2e-dash-${tag}`);
  const { memberId, token } = await inviteNewMember(request, `架空 ホーム確認 ${tag}`, email);
  const ctx = await newUserContext(browser, viewport);
  const page = await ctx.newPage();
  await acceptInvitationViaUi(page, email, token, { mfa: false });
  await expect(page).toHaveURL(/\/app$/); // ログイン直後の行き先はホーム（SCR-02）

  // --- seed: 予定。近い方（未回答）/遠い方（「未定」と回答）/過去（集計外） ---
  for (const [title, days] of [["近い方の訓練", 2], ["遠い方の訓練", 5], ["もう過ぎた訓練", -3]] as const) {
    const made = await adminApiData<{ id: string; version: number }>(request, "POST", "/api/v1/activities", {
      title: `${title} ${tag}`, kind: "訓練", plannedStartsAt: iso(days), locationText: "架空市中央公園",
      ownerMemberId: memberId, audienceMemberIds: [memberId],
    });
    expect(made.status).toBe(201);
    const published = await adminApiData(request, "PATCH", `/api/v1/activities/${made.data.data.id}`, {
      version: 1, status: "scheduled", reason: "対象を確定して公開",
    });
    expect(published.status).toBe(200);
  }
  // 遠い方の出欠を「未定」で回答（未回答の件数から外れる。docs/11「未定と未回答は区別」）。回答は本人のセッションで
  const upcoming = await adminApiData<{ id: string; title: string }[]>(
    request, "GET", `/api/v1/activities?from=${encodeURIComponent(iso(0))}&status=scheduled&limit=200`,
  );
  const far = upcoming.data.data.find((r) => r.title.startsWith(`遠い方の訓練 ${tag}`));
  expect(far).toBeTruthy();
  // 近い方は未回答のまま（通知draftの源=未回答者抽出の対象にする。docs/16 T050）
  const near = upcoming.data.data.find((r) => r.title.startsWith(`近い方の訓練 ${tag}`));
  expect(near).toBeTruthy();
  const answered = await ctx.request.fetch(`${BASE}/api/v1/activities/${far!.id}/attendance/me`, {
    method: "PUT",
    headers: apiHeaders({ "idempotency-key": crypto.randomUUID() }),
    data: JSON.stringify({ version: 0, response: "undecided" }),
  });
  expect(answered.status()).toBe(201);

  // --- seed: 異常。確認待ち1件・確認終了1件（起点なしの手動起票） ---
  const facility = await adminApiData<{ id: string }>(request, "POST", "/api/v1/facilities", {
    type: "hydrant", latitude: 35.72, longitude: 139.72, locationSource: "架空市台帳",
    locationNote: "ホーム試験の施設", managementNumber: `K-${tag}`,
  });
  expect(facility.status).toBe(201);
  const issueOpen = await adminApiData<{ id: string }>(request, "POST", "/api/v1/issues", {
    target: { type: "facility", id: facility.data.data.id }, title: `開閉不良 ${tag}`, description: "ホームから確認待ち件数で見える異常", attachmentIds: [],
  });
  expect(issueOpen.status).toBe(201);
  const issueClosed = await adminApiData<{ id: string }>(request, "POST", "/api/v1/issues", {
    target: { type: "facility", id: facility.data.data.id }, title: `ホース不足 ${tag}`, description: "確認終了まで進んだ異常", attachmentIds: [],
  });
  expect(issueClosed.status).toBe(201);
  expect((await adminApiData(request, "PATCH", `/api/v1/issues/${issueClosed.data.data.id}`, { version: 1, status: "under_review", reason: "確認した" })).status).toBe(200);
  expect((await adminApiData(request, "PATCH", `/api/v1/issues/${issueClosed.data.data.id}`, { version: 2, status: "closed", reason: "対応を確認した" })).status).toBe(200);

  // --- seed: お知らせ。本人宛てに公開1件（ホームのお知らせ欄の先頭に載る） ---
  const notice = await adminApiData<{ id: string }>(request, "POST", "/api/v1/announcements", {
    title: `秋季火災予防運動のお知らせ ${tag}`, body: `10/25（日）に巡回します。${tag}`, audienceMemberIds: [memberId],
  });
  expect(notice.status).toBe(201);
  expect((await adminApiData(request, "PATCH", `/api/v1/announcements/${notice.data.data.id}`, { version: 1, status: "published" })).status).toBe(200);

  // --- seed: 自分のタスク（API-68。myTasks指標＝担当の対応中タスクの対象。対応中のまま残す） ---
  const taskMade = await adminApiData<{ id: string }>(request, "POST", "/api/v1/tasks", {
    title: `消火栓の表示板確認 ${tag}`, assigneeMemberId: memberId, dueDate: "2026-12-01",
  });
  expect(taskMade.status).toBe(201);

  // --- seed: 通知（実API経由。API-63 draft→API-64承認→ローカルCronトリガで配送。既読操作はしない＝未読が残る）。
  // 源=「近い方の訓練」の未回答者抽出（対象=本人だけ。遠い方は未定回答済みで対象外）。本文はtag入りで一覧の行を特定できる ---
  const draft = await adminApiData<{ id: string; version: number; bodyHash: string; audienceHash: string }>(
    request, "POST", "/api/v1/notifications/drafts",
    { source: { type: "activity", id: near!.id }, channels: ["inapp"], body: `出欠の回答は予定ページからお願いします ${tag}` },
  );
  expect(draft.status).toBe(201);
  const approved = await adminApiData(request, "POST", `/api/v1/notifications/${draft.data.data.id}/approval`, {
    version: draft.data.data.version, bodyHash: draft.data.data.bodyHash,
    audienceHash: draft.data.data.audienceHash, decision: "approve",
  });
  expect(approved.status).toBe(202);
  // 配送jobの回収（本番=毎分Cron。docs/03 §1.1-14）をローカルでは開発用トリガで走らせ、本人の未読一覧に載るまで待つ
  await expect(async () => {
    await runLocalCron(request);
    const rows = await walkAll<{ id: string; myReadAt: string | null }>(ctx.request, "/api/v1/notifications/me", { unread: "true" });
    expect(rows.some((r) => r.id === draft.data.data.id && r.myReadAt === null)).toBe(true);
  }).toPass({ timeout: 30_000 });

  // --- 期待値: 本人のセッションでAPI-28を読む（画面はこの値を写しているはず。全指標が同じunit scope） ---
  const dashRes = await ctx.request.fetch(`${BASE}/api/v1/dashboard`, { headers: { origin: BASE } });
  expect(dashRes.status()).toBe(200);
  const dash = ((await dashRes.json()) as {
    data: {
      nextActivity: { count: number; title: string | null };
      myUnanswered: { count: number };
      openIssues: { count: number };
      inspectionDue: { count: number };
      notifications: { count: number };
      myTasks: { count: number };
    };
  }).data;
  expect(dash.nextActivity.title).toBeTruthy();
  // 通知・自分のタスクも同じunit scope。href先の一覧（API-67 unread／API-102。最後のページまで読む）の件数と一致する
  const unreadRows = await walkAll<{ id: string; myReadAt: string | null }>(ctx.request, "/api/v1/notifications/me", { unread: "true" });
  expect(dash.notifications.count).toBe(unreadRows.length);
  expect(unreadRows.every((r) => r.myReadAt === null)).toBe(true);
  const myTaskRows = await walkAll<{ id: string; status: string }>(ctx.request, "/api/v1/tasks/me");
  expect(dash.myTasks.count).toBe(myTaskRows.length);
  expect(myTaskRows.every((r) => ["open", "assigned", "in_progress"].includes(r.status))).toBe(true);
  /** 一覧ページの活動行（/app/activities/new の登録ボタンは除く） */
  const activityRows = page.locator("main a[href^='/app/activities/']:not([href='/app/activities/new'])");

  // --- ダイヤル: 次回予定が載り、押すと同じ条件（これからの予定）の一覧＝件数も一致 ---
  await page.goto("/app");
  const dial = page.getByRole("link", { name: new RegExp(escapeRe(dash.nextActivity.title!)) });
  await expect(dial).toBeVisible();
  await dial.click();
  await expect(page).toHaveURL(/\/app\/activities\?/);
  await expect(activityRows).toHaveCount(dash.nextActivity.count, { timeout: 15_000 });
  await expect(page.getByRole("link", { name: new RegExp(`近い方の訓練 ${tag}`) })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(`もう過ぎた訓練 ${tag}`) })).toHaveCount(0);

  // --- 本人未回答: タイルの数値→一覧の件数が同じ（未定と答えた遠い方は入らない） ---
  await page.goto("/app");
  const unansweredTile = page.getByRole("link", { name: /本人未回答/ });
  await expect(unansweredTile).toBeVisible();
  await expect(unansweredTile.getByText(String(dash.myUnanswered.count), { exact: true })).toBeVisible();
  await unansweredTile.click();
  await expect(page).toHaveURL(/\/app\/activities\?.*unanswered=true/);
  await expect(activityRows).toHaveCount(dash.myUnanswered.count, { timeout: 15_000 });
  await expect(page.getByRole("link", { name: new RegExp(`近い方の訓練 ${tag}`) })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(`遠い方の訓練 ${tag}`) })).toHaveCount(0);

  // --- 確認待ちの異常: タイルの数値→点検管理の確認待ちチップの件数が同じ（確認終了は入らない） ---
  await page.goto("/app");
  const issueTile = page.getByRole("link", { name: /確認待ちの異常/ });
  await expect(issueTile).toBeVisible();
  await expect(issueTile.getByText(String(dash.openIssues.count), { exact: true })).toBeVisible();
  await issueTile.click();
  await expect(page).toHaveURL(/\/app\/issues\?status=reported/);
  await expect(page.getByText(`開閉不良 ${tag}`)).toBeVisible();
  await expect(page.getByText(`ホース不足 ${tag}`)).toHaveCount(0);
  // 一覧の状態チップ（文字＋件数）がホームの数値と一致する
  await expect(page.getByRole("button", { name: /^確認待ち/ })).toHaveText(new RegExp(`確認待ち\\s*${dash.openIssues.count}$`));

  // --- お知らせ欄（prototypeホーム）。行を押すと詳細へ ---
  await page.goto("/app");
  await page.getByRole("link", { name: new RegExp(`秋季火災予防運動のお知らせ ${tag}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/app/announcements/${notice.data.data.id}$`));

  // --- 接続済みの指標タイル（点検期限=T048、通知・自分のタスク=T052）は数値と一覧へのリンクになる ---
  await page.goto("/app");
  const dueTile = page.getByTestId("metric-inspectionDue");
  await expect(dueTile).toBeVisible();
  await expect(dueTile).toHaveAttribute("href", "/app/assets?due=overdue");
  const notificationTile = page.getByTestId("metric-notifications");
  await expect(notificationTile).toBeVisible();
  await expect(notificationTile).toHaveAttribute("href", "/app/tasks-notifications?tab=notifications&unread=true");
  await expect(notificationTile.getByText(String(dash.notifications.count), { exact: true })).toBeVisible();
  const myTasksTile = page.getByTestId("metric-myTasks");
  await expect(myTasksTile).toBeVisible();
  await expect(myTasksTile).toHaveAttribute("href", "/app/tasks-notifications?tab=tasks");
  await expect(myTasksTile.getByText(String(dash.myTasks.count), { exact: true })).toBeVisible();

  // --- 通知タイル: 押すと未読の自分宛通知（API-67 unread=trueと同じ条件）が開き、行数が一致する ---
  await notificationTile.click();
  await expect(page).toHaveURL(/\/app\/tasks-notifications\?tab=notifications&unread=true$/);
  const notificationRows = page.getByRole("list", { name: "自分宛の通知" }).getByRole("listitem");
  await expect(notificationRows).toHaveCount(dash.notifications.count, { timeout: 15_000 });
  await expect(page.getByText(new RegExp(escapeRe(`出欠の回答は予定ページからお願いします ${tag}`)))).toBeVisible();

  // --- 自分のタスクタイル: 押すと対応中の担当タスク（API-102のstatus省略と同じ条件）が開き、行数が一致する ---
  await page.goto("/app");
  await myTasksTile.click();
  await expect(page).toHaveURL(/\/app\/tasks-notifications\?tab=tasks$/);
  const taskRows = page.getByRole("list", { name: "自分のタスク" }).getByRole("listitem");
  await expect(taskRows).toHaveCount(dash.myTasks.count, { timeout: 15_000 });
  await expect(page.getByText(new RegExp(escapeRe(`消火栓の表示板確認 ${tag}`)))).toBeVisible();

  // --- 点検期限のタイル（T048）: 押すと資産一覧が超過資産の絞り込みで開き、車両＋資機材の件数の和が一致する ---
  await page.goto("/app");
  await dueTile.click();
  await expect(page).toHaveURL(new RegExp(`/app/assets\\?due=overdue$`));
  await expect(page.getByText("点検期限を超過した資産だけ表示中")).toBeVisible();
  // 数値＝一覧件数（docs/05 API-28）。一覧側の件数は車両・資機材の2つのタブの和（読み込み中の「—」が消えるまで待つ）
  const tabNumber = async (key: "vehicle" | "equipment") => {
    const label = key === "vehicle" ? "車両" : "資機材";
    const tab = page.getByTestId(`assets-tab-${key}`);
    await expect(tab).toHaveText(new RegExp(`^${label}\\s*\\d+$`), { timeout: 15_000 });
    return Number((await tab.textContent())!.match(/(\d+)$/)![1]);
  };
  expect((await tabNumber("vehicle")) + (await tabNumber("equipment"))).toBe(dash.inspectionDue.count);
});
