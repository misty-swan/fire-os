import { expect, test } from "@playwright/test";
import { BASE, acceptInvitationViaUi, adminApiData, apiHeaders, inviteNewMember, newUserContext, uniqueEmail } from "./helpers";

/**
 * 活動分析（T060、SCR-26、AT-ACT-06/DASH-02）。
 * - 条件の明示: 検証設定（D05案・未承認）の年度注記と、絞り込み中の条件チップを出す
 * - 数値と元データの一致（traces sources）: 集計の元データ（sources）から元活動/出動の詳細へ辿れ、
 *   団員別の行から同じ条件の活動一覧（API-05 actual=true&memberId）へ辿れる。無効(voided)の出動は集計外
 * - 月次/年度/団員別の切替。両プロジェクト（phone-360 / desktop-1280）で確認する
 * 期待値は独自の種別（kindタグ）と団員スコープで、他の試験が同じ分団にseedしても成立する形にする。
 */
/** API-52応答（画面の写しの照合用。型は画面/ワーカー試験と同じ最小限） */
interface AnalyticsApiShape {
  totals: { operationCount: number; memberCount: number; knownDurationMinutes: number };
  sources: { activities: { id: string }[]; incidents: { id: string }[] };
}

test("analytics_shows_conditions_and_traces_sources", async ({ browser, request }, testInfo) => {
  test.setTimeout(300_000);
  const viewport = testInfo.project.use.viewport!;
  const tag = crypto.randomUUID().slice(0, 6);
  const kindTag = `analytics-${tag}`;
  const iso = (s: string) => new Date(s).toISOString();

  // --- 招待受領で一般団員（この人の実参加だけが団員別の行になる。他の試験に混ざらない新規団員） ---
  const email = uniqueEmail(`e2e-analytics-${tag}`);
  const { memberId, token } = await inviteNewMember(request, `架空 分析確認 ${tag}`, email);
  const ctx = await newUserContext(browser, viewport);
  const page = await ctx.newPage();
  await acceptInvitationViaUi(page, email, token, { mfa: false });
  await expect(page).toHaveURL(/\/app$/);

  const recordOwn = async (incidentId: string, status: string) => {
    const res = await ctx.request.fetch(`${BASE}/api/v1/incidents/${incidentId}/participants/${memberId}`, {
      method: "PUT",
      headers: apiHeaders({ "idempotency-key": crypto.randomUUID() }),
      data: JSON.stringify({ version: 0, attendanceStatus: status }),
    });
    expect([200, 201]).toContain(res.status());
  };

  // --- seed: 1) リンク対（活動＋出動=同一operation。時間あり120分） ---
  const act1 = await adminApiData<{ id: string; version: number }>(request, "POST", "/api/v1/activities", {
    title: `秋季の水防訓練 ${tag}`, kind: kindTag, plannedStartsAt: iso("2026-05-20T01:00:00.000Z"),
    locationText: "架空市堤防", ownerMemberId: memberId, audienceMemberIds: [memberId],
  });
  expect(act1.status).toBe(201);
  expect((await adminApiData(request, "PATCH", `/api/v1/activities/${act1.data.data.id}`, {
    version: 1, status: "scheduled", reason: "対象を確定して公開",
  })).status).toBe(200);
  expect((await adminApiData(request, "POST", `/api/v1/activities/${act1.data.data.id}/actual-results`, {
    activityVersion: 2, content: "堤防の点検と水防訓練を実施（架空）。",
    actualStartsAt: iso("2026-05-20T01:00:00.000Z"), actualEndsAt: iso("2026-05-20T03:00:00.000Z"),
    participants: [{ memberId, actualStatus: "participated" }], attachmentIds: [],
  })).status).toBe(201);
  const inc1 = await adminApiData<{ id: string; operationId: string }>(request, "POST", "/api/v1/incidents", {
    kind: "training", occurredAt: iso("2026-05-20T02:30:00.000Z"), summary: `水防訓練に伴う出動記録 ${tag}`, activityId: act1.data.data.id,
  });
  expect(inc1.status).toBe(201);
  await recordOwn(inc1.data.data.id, "arrived"); // 同じoperationに団員が二重に現れる（延べ参加の重複除去の対象）

  // --- seed: 2) 時間未入力の活動（実績はあるが全体時間が無い。0時間ではなく「未入力」） ---
  const act2 = await adminApiData<{ id: string }>(request, "POST", "/api/v1/activities", {
    title: `昼間の巡回点呼 ${tag}`, kind: kindTag, plannedStartsAt: iso("2026-06-10T01:00:00.000Z"),
    locationText: "架空市中央公園", ownerMemberId: memberId, audienceMemberIds: [memberId],
  });
  expect(act2.status).toBe(201);
  expect((await adminApiData(request, "PATCH", `/api/v1/activities/${act2.data.data.id}`, {
    version: 1, status: "scheduled", reason: "対象を確定して公開",
  })).status).toBe(200);
  expect((await adminApiData(request, "POST", `/api/v1/activities/${act2.data.data.id}/actual-results`, {
    activityVersion: 2, content: "巡回を実施（終了時刻は未記録）。",
    participants: [{ memberId, actualStatus: "participated" }], attachmentIds: [],
  })).status).toBe(201);

  // --- seed: 3) 単独の出動（活動なし＝時間の記録が無い出来事。これも「未入力」） ---
  const inc2 = await adminApiData<{ id: string }>(request, "POST", "/api/v1/incidents", {
    kind: "training", occurredAt: iso("2026-07-08T00:00:00.000Z"), summary: `通信訓練の参集 ${tag}`,
  });
  expect(inc2.status).toBe(201);
  await recordOwn(inc2.data.data.id, "mobilizing");

  // --- seed: 4) 無効(voided)の出動。集計には現れず、出動一覧には表示され続ける（docs/05 API-21） ---
  const incVoid = await adminApiData<{ id: string; version: number }>(request, "POST", "/api/v1/incidents", {
    kind: "simulation", occurredAt: iso("2026-08-01T00:00:00.000Z"), summary: `誤登録の出動 ${tag}`,
  });
  expect(incVoid.status).toBe(201);
  await recordOwn(incVoid.data.data.id, "mobilizing");
  expect((await adminApiData(request, "PATCH", `/api/v1/incidents/${incVoid.data.data.id}`, {
    version: 1, status: "voided", reason: "誤登録のため無効化",
  })).status).toBe(200);

  // --- seed: 5) 昨年度（FY2025=〜2026-03-31 JST）の活動。年度の切り替えで確認する ---
  const actPrev = await adminApiData<{ id: string }>(request, "POST", "/api/v1/activities", {
    title: `昨年度の終了式 ${tag}`, kind: kindTag, plannedStartsAt: iso("2026-03-20T01:00:00.000Z"),
    locationText: "架空市公会堂", ownerMemberId: memberId, audienceMemberIds: [memberId],
  });
  expect(actPrev.status).toBe(201);
  expect((await adminApiData(request, "PATCH", `/api/v1/activities/${actPrev.data.data.id}`, {
    version: 1, status: "scheduled", reason: "対象を確定して公開",
  })).status).toBe(200);
  expect((await adminApiData(request, "POST", `/api/v1/activities/${actPrev.data.data.id}/actual-results`, {
    activityVersion: 2, content: "終了式を実施（架空）。",
    actualStartsAt: iso("2026-03-20T01:00:00.000Z"), actualEndsAt: iso("2026-03-20T02:00:00.000Z"),
    participants: [{ memberId, actualStatus: "participated" }], attachmentIds: [],
  })).status).toBe(201);

  // --- 条件の明示: 検証設定の注記と種別タグのチップ。種別指定時は出動を含めない（出来事=この種別の活動2件） ---
  await page.goto(`/app/analytics?fy=2026&kind=${encodeURIComponent(kindTag)}`);
  await expect(page.getByText("検証設定（D05案・未承認）")).toBeVisible();
  await expect(page.getByTestId("analytics-total-operations-value")).toHaveText("2");
  await expect(page.getByText(`種別: ${kindTag}`)).toBeVisible();

  // --- 条件を外すと出動も数えられる。期待値は直前に本人のセッションでAPI-52を読んで取る
  // （他の試験が同じ分団にseedしても成立する形。画面はAPIの値を写していることの確認） ---
  const apiRes = await ctx.request.fetch(`${BASE}/api/v1/analytics?fiscalYear=2026`, { headers: { origin: BASE } });
  expect(apiRes.status()).toBe(200);
  const expected = ((await apiRes.json()) as { data: AnalyticsApiShape }).data;
  await page.goto(`/app/analytics?fy=2026`);
  await expect(page.getByTestId("analytics-total-operations-value")).toHaveText(String(expected.totals.operationCount));
  await expect(page.getByTestId("analytics-total-members-value")).toHaveText(String(expected.totals.memberCount));
  await expect(page.getByText(`誤登録の出動 ${tag}`)).toHaveCount(0); // voidedは元データに出ない
  const act1Row = page.getByTestId(`analytics-source-activity-${act1.data.data.id}`);
  await expect(act1Row).toBeVisible();
  await expect(page.getByTestId(`analytics-source-incident-${inc1.data.data.id}`)).toBeVisible();
  await expect(page.getByTestId(`analytics-source-incident-${inc2.data.data.id}`)).toBeVisible();

  // --- 月次: この団員のリンク対は2026-05に1行で載る（種別タグで他の試験のseedと混ざらない）。
  // 活動と出動が同じ出来事として1件に纏まっていることは workers試験（tests/analytics.test.ts）で確認済み ---
  const mayRow = page.getByTestId("analytics-month-2026-05");
  await expect(mayRow).toBeVisible();
  await mayRow.getByRole("link", { name: "活動" }).click();
  await expect(page).toHaveURL(/\/app\/activities\?from=.*to=.*actual=true/);
  await expect(page.getByRole("link", { name: new RegExp(`秋季の水防訓練 ${tag}`) })).toBeVisible();

  // --- 団員別: この団員は出来事3件・実績時間2時間・未入力2件（0時間と表示しない）。行から同じ条件の活動一覧へ ---
  await page.goto(`/app/analytics?fy=2026&view=members`);
  const memberRow = page.getByTestId("analytics-member-row").filter({ hasText: `架空 分析確認 ${tag}` });
  await expect(memberRow).toBeVisible();
  await expect(memberRow).toContainText("3件");
  await expect(memberRow).toContainText("2時間");
  await expect(memberRow).toContainText("未入力2件");
  await memberRow.click();
  await expect(page).toHaveURL(/\/app\/activities\?.*actual=true.*memberId=/);
  const listRows = page.locator("main a[href^='/app/activities/']:not([href*='/new']):not([href*='/edit'])");
  await expect(listRows).toHaveCount(2); // この団員の実参加した活動だけ（時間あり/未入力の2件）
  await expect(page.getByRole("link", { name: new RegExp(`昼間の巡回点呼 ${tag}`) })).toBeVisible();

  // --- 元データから元活動/出動の詳細へ辿る（SCR-26「元活動/出動/operation参照」） ---
  await page.goto(`/app/analytics?fy=2026`);
  await act1Row.click();
  await expect(page).toHaveURL(new RegExp(`/app/activities/${act1.data.data.id}$`));
  await expect(page.getByText(`秋季の水防訓練 ${tag}`)).toBeVisible();
  await page.goto(`/app/analytics?fy=2026`);
  await page.getByTestId(`analytics-source-incident-${inc1.data.data.id}`).click();
  await expect(page).toHaveURL(new RegExp(`/app/incidents/${inc1.data.data.id}$`));

  // --- 年度の切替: 検証設定（4月始まり）の境界で2025年度には昨年度の活動だけが載る ---
  await page.goto(`/app/analytics?fy=2025&kind=${encodeURIComponent(kindTag)}`);
  await expect(page.getByTestId("analytics-total-operations-value")).toHaveText("1");
  await expect(page.getByTestId(`analytics-source-activity-${actPrev.data.data.id}`)).toBeVisible();
  await expect(page.getByText(`秋季の水防訓練 ${tag}`)).toHaveCount(0);
  // 集計の条件（年度）が画面に明示される（条件チップ側。セレクトのoptionは除く）
  await expect(page.getByLabel("集計の条件").getByText("2025年度")).toBeVisible();
});
