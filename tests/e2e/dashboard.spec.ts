import { expect, test } from "@playwright/test";
import { BASE, acceptInvitationViaUi, adminApiData, apiHeaders, inviteNewMember, newUserContext, uniqueEmail } from "./helpers";

/**
 * ホーム（SCR-02）の指標とドリルダウン（T047、DASH-01/AT-DASH-01）。
 * タイルの数値と遷移先一覧の件数が同じ条件で一致することをUIで確認する:
 * 次回予定のダイヤル→これからの予定の一覧、本人未回答→?unanswered=trueの一覧、確認待ちの異常→点検管理?status=reported、
 * 点検期限（T048で接続）→/app/assets?due=overdue（車両＋資機材の件数の和）。
 * 期待値は直前に本人のセッションでAPI-28を読んで取る（他の試験が同じunitにseedしても成立する形）。
 * 通知・自分のタスクは未接続（PH4）で、0件ではなく未接続の表示になる。seedと検証読みだけAPI。
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

  // --- 期待値: 本人のセッションでAPI-28を読む（画面はこの値を写しているはず。全指標が同じunit scope） ---
  const dashRes = await ctx.request.fetch(`${BASE}/api/v1/dashboard`, { headers: { origin: BASE } });
  expect(dashRes.status()).toBe(200);
  const dash = ((await dashRes.json()) as {
    data: {
      nextActivity: { count: number; title: string | null };
      myUnanswered: { count: number };
      openIssues: { count: number };
      inspectionDue: { count: number };
    };
  }).data;
  expect(dash.nextActivity.title).toBeTruthy();
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

  // --- 未接続の指標（通知・自分のタスク=PH4）は0件ではなく未接続と分かる表示。
  // 点検期限（T048で接続）は数値と一覧へのリンク（/app/assets?due=overdue）になる ---
  await page.goto("/app");
  const dueTile = page.getByTestId("metric-inspectionDue");
  await expect(dueTile).toBeVisible();
  await expect(dueTile).toHaveAttribute("href", "/app/assets?due=overdue");
  for (const key of ["notifications", "myTasks"]) {
    const tile = page.getByTestId(`metric-${key}`);
    await expect(tile.getByText("未接続")).toBeVisible();
    await expect(tile.getByText("0件")).toHaveCount(0);
  }

  // --- 点検期限のタイル（T048）: 押すと資産一覧が超過資産の絞り込みで開き、車両＋資機材の件数の和が一致する ---
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
