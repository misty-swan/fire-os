import { expect, test, type APIRequestContext } from "@playwright/test";
import { acceptInvitationViaUi, adminApiData, BASE, inviteNewMember, newUserContext, uniqueEmail } from "./helpers";

/**
 * タスク・通知画面（T052、SCR-21 /app/tasks-notifications）。
 * 幹部（PER-12）が未回答者抽出のdraftを作成→本文/対象/人数の承認前確認→取消（draft→cancelled）→
 * 別draftを承認（送信確認ダイアログで本文・対象・人数を明示）→配送結果（受付済み/失敗/到達不明の別表示）→
 * 対象者が自分宛通知を明示操作で既読（API-100）、業務タスクを画面から着手→完了（API-87）までをUIで完結させる。
 *
 * - 「受付済み（provider_accepted）」「到達不明（unknown）」「既読」は別表示（docs/11「受付≠到達≠既読」）。
 *   到達不明は実チャネルが無いため、文書化された試験/デモ用の規約（班が「連絡先未登録」の団員の
 *   宛先参照が unknown: 接頭辞になり、inapp providerが結果unknownを返す。docs/03 §1.1）で再現する。
 * - 無承認送信0: 取消したdraft（1通目）は対象者の一覧に現れない（docs/16 T050「draft/cancelledは
 *   対象者に存在を見せない」）。承認済み（2通目）だけが現れる。
 * - 承認後の配送jobは本番では毎分のCron（handleScheduled→runDueJobs）が回収する。ローカルのwrangler devは
 *   Cronを自動発火しないため（webServer起動時の警告どおり）、開発用トリガ `/cdn-cgi/local/scheduled` で
 *   同じCron経路を明示的に走らせる（本番の挙動は変えない。docs/03 §1.1-14）。
 * - 業務操作はUI経由（seedの団員・役割・予定・タスク作成だけAPI。announcements.specと同じ流儀）。
 */

/** ローカル開発用のCron手動トリガ（本番は毎分自動で走る同じhandleScheduled。docs/03 §1.1-14） */
async function runLocalCron(request: APIRequestContext): Promise<void> {
  await request.fetch(`${BASE}/cdn-cgi/local/scheduled`);
}
// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("notification_ui_distinguishes_accepted_unknown_and_read", async ({ page, browser, request }, testInfo) => {
  test.setTimeout(300_000);
  const viewport = testInfo.project.use.viewport!;
  const tag = crypto.randomUUID().slice(0, 6);

  // --- seed: 幹部（PER-12保持）と対象者の団員2名。片方は宛先が解決できない状態（試験/デモ用の規約） ---
  const officerEmail = uniqueEmail(`e2e-ntf-o-${tag}`);
  const officer = await inviteNewMember(request, `架空 幹部 ${tag}`, officerEmail);
  const memberEmail = uniqueEmail(`e2e-ntf-m-${tag}`);
  const member = await inviteNewMember(request, `架空 団員 ${tag}`, memberEmail);
  // 到達不明になる団員（班=連絡先未登録。受信箱の宛先参照が解決できない状態の再現。ログインはしない）
  const unreachableRes = await adminApiData<{ id: string }>(request, "POST", "/api/v1/members", {
    displayName: `架空 連絡不明 ${tag}`, status: "active", rank: "団員", squad: "連絡先未登録",
  });
  expect(unreachableRes.status).toBe(201);
  const unreachableId = unreachableRes.data.data.id;

  const officerCtx = await newUserContext(browser, viewport);
  const officerPage = await officerCtx.newPage();
  await acceptInvitationViaUi(officerPage, officerEmail, officer.token, { mfa: false });
  const rows = (
    await adminApiData(request, "GET", "/api/v1/members?limit=200")
  ).data.data as { id: string; version: number; account: { authzVersion: number } | null }[];
  const officerRow = rows.find((r) => r.id === officer.memberId)!;
  const roles = await adminApiData(request, "PUT", `/api/v1/members/${officer.memberId}/roles`, {
    version: officerRow.version,
    expectedAuthzVersion: officerRow.account?.authzVersion ?? 1,
    roleCodes: ["officer"],
    reason: "e2e: 幹部（PER-12保持）として通知の作成と承認を行う",
    scopes: [],
  });
  expect(roles.status).toBe(200);

  // --- seed: 出欠確認の対象になる予定（だれも回答しない=全員が未回答抽出の対象）と業務タスク ---
  const startsAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const activity = await adminApiData<{ id: string; version: number }>(request, "POST", "/api/v1/activities", {
    title: `集合時刻の変更 ${tag}`, kind: "訓練", plannedStartsAt: startsAt, locationText: "架空市中央公園",
    ownerMemberId: officer.memberId,
    audienceMemberIds: [officer.memberId, member.memberId, unreachableId],
  });
  expect(activity.status).toBe(201);
  const activityId = activity.data.data.id;
  const publish = await adminApiData(request, "PATCH", `/api/v1/activities/${activityId}`, {
    version: 1, status: "scheduled", reason: "e2e: 対象を確定して公開",
  });
  expect(publish.status).toBe(200);
  const task = await adminApiData<{ id: string }>(request, "POST", "/api/v1/tasks", {
    title: `資機材の注文 ${tag}`, assigneeMemberId: member.memberId, dueDate: "2026-12-01",
  });
  expect(task.status).toBe(201);

  // --- 1) 幹部がメニューの「設定・通知」から入る（SCR-21。スマホ=タイル、PC=サイドバーのADMINグループ） ---
  await officerPage.goto("/app/menu");
  await officerPage.locator("#main").getByRole("link", { name: "設定・通知" }).click();
  await expect(officerPage).toHaveURL(/\/app\/tasks-notifications$/);
  await officerPage.getByRole("link", { name: "通知を作成" }).click();
  await expect(officerPage).toHaveURL(/\/app\/tasks-notifications\/notifications\/new$/);

  // --- 2) 源=未回答者抽出でdraft1を作る（本文は画面で変えられる。API-63） ---
  await officerPage.getByLabel("通知の源").selectOption("activity");
  const sourceSelect = officerPage.getByLabel("抽出する予定");
  await sourceSelect.selectOption((await sourceSelect.locator("option", { hasText: `集合時刻の変更 ${tag}` }).getAttribute("value"))!);
  // 提案対象（未回答者3人）の反映を待ってから本文を変える（対象変更は新draftになる旨の注記が出る）
  //（T085b: 並行実行の負荷で既定5秒を超え得るため、ネットワークを挟む断言は明示タイムアウトに揃える）
  await expect(officerPage.getByText(/対象者（3人/).first()).toBeVisible({ timeout: 15_000 });
  await officerPage.getByLabel("本文").fill(`出欠の回答は締切済みです。${tag}の1通目は取り消します。`);
  await officerPage.getByRole("button", { name: "下書きを作成" }).click();
  // 保存の確認は承認前確認の表示で行う（保存後に即座に承認前確認へ切り替わるため、トーストは遷移で消える）
  const preview1 = officerPage.getByLabel("承認前の確認");
  await expect(preview1.getByText(`${tag}の1通目は取り消します。`)).toBeVisible();
  // 承認前確認の表示のあと、操作ボタンは領域の外（sectionの兄弟）にあるため画面全体から探す
  await expect(preview1.getByText(/3人/).first()).toBeVisible();
  await officerPage.getByRole("button", { name: "取消する" }).click();
  const cancelDialog = officerPage.getByRole("dialog", { name: "この下書きを取消しますか" });
  await expect(cancelDialog.getByText(/3人/).first()).toBeVisible(); // 取消の対象を明示
  await cancelDialog.getByRole("button", { name: "取消する" }).click();
  await expect(officerPage.getByText("保存しました").first()).toBeVisible({ timeout: 15_000 });
  await expect(officerPage.getByText("取消済み").first()).toBeVisible({ timeout: 15_000 });

  // --- 4) 別draft（既定文のまま）を作って承認する。送信確認ダイアログで本文・対象・人数を明示 ---
  await officerPage.getByRole("link", { name: "あらためて作成" }).click();
  await expect(officerPage).toHaveURL(/\/app\/tasks-notifications\/notifications\/new$/);
  await officerPage.getByLabel("通知の源").selectOption("activity");
  const sourceSelect2 = officerPage.getByLabel("抽出する予定");
  await sourceSelect2.selectOption((await sourceSelect2.locator("option", { hasText: `集合時刻の変更 ${tag}` }).getAttribute("value"))!);
  // 源からの既定文が提案欄に反映されるのを待ってから下書きを作る（未入力のまま送らない）
  await expect(officerPage.getByLabel("本文")).toHaveValue(/出欠確認/, { timeout: 15_000 });
  await officerPage.getByRole("button", { name: "下書きを作成" }).click();
  const preview2 = officerPage.getByLabel("承認前の確認");
  await expect(preview2.getByText(/出欠確認/)).toBeVisible(); // 源からの既定文（保存の確認は承認前確認の表示で行う）
  await expect(preview2.getByText(/対象者（3人/).first()).toBeVisible();
  await officerPage.getByRole("button", { name: "承認する" }).click();
  const approveDialog = officerPage.getByRole("dialog", { name: "この通知を承認して送信しますか" });
  await expect(approveDialog.getByText(/出欠確認/)).toBeVisible(); // 本文
  await expect(approveDialog.getByText(/3人/).first()).toBeVisible(); // 人数
  await expect(approveDialog.getByText(`架空 連絡不明 ${tag}`)).toBeVisible(); // 対象者
  await approveDialog.getByRole("button", { name: "承認する" }).click();
  // 承認は202（配送jobの受付）。処理中という表示が出て、完了では扱わない
  await expect(officerPage.getByText(/処理中/).first()).toBeVisible({ timeout: 15_000 });

  // --- 5) 配送結果は受付/到達不明/失敗を別表示する（docs/11「受付≠到達≠既読」）。既読は最初0 ---
  // 承認で登録された配送jobの回収（本番=毎分Cron）を、ローカルでは開発用トリガで走らせる
  const results = officerPage.getByLabel("配送結果");
  await expect(async () => {
    await runLocalCron(request);
    await expect(results.getByText("受付済み").first()).toBeVisible();
  }).toPass({ timeout: 30_000 });
  await expect(results.getByText("到達不明").first()).toBeVisible({ timeout: 15_000 });
  await expect(results.getByText("既読").first()).toBeVisible({ timeout: 15_000 });
  // 既読は最初0（1回だけのDOM読みではなく、確定するまで待つ断言で観測する＝T085b）
  await expect(results.getByTestId("read-count")).toHaveText("0");
  // 到達不明は「結果を確認」の導線で内容（誰が・なぜ）を確認できる（要約と宛先行の2箇所に出るためfirst）
  await results.getByRole("button", { name: "結果を確認" }).click();
  await expect(results.getByText(`架空 連絡不明 ${tag}`).first()).toBeVisible({ timeout: 15_000 });

  // --- 6) 対象者が自分宛通知を開き、明示操作で本人既読（API-100）。取消済みの1通目は現れない ---
  const memberCtx = await newUserContext(browser, viewport);
  const memberPage = await memberCtx.newPage();
  await acceptInvitationViaUi(memberPage, memberEmail, member.token, { mfa: false });
  await memberPage.goto("/app/tasks-notifications");
  await expect(memberPage.getByText(/出欠確認/).first()).toBeVisible({ timeout: 15_000 });
  await expect(memberPage.getByText(/1通目/)).toHaveCount(0); // 無承認送信0（取消済みは存在を見せない）
  await memberPage.getByRole("link", { name: /出欠確認/ }).click();
  await expect(memberPage.getByText("この通知は未読です")).toBeVisible({ timeout: 15_000 });
  await memberPage.getByRole("button", { name: "内容を確認" }).click();
  // 既読は保存後に詳細を読み直して示す（トーストは再読込で入れ替わるため、既読の表示を確認の根拠にする）
  await expect(memberPage.getByText("既読").first()).toBeVisible({ timeout: 15_000 });

  // --- 7) 送信者の配送結果の既読数は、明示既読の実数と一致する（受付/配送/既読を混同しない） ---
  const explicitReadCount = 1;
  await expect(results.getByTestId("read-count")).toHaveText(String(explicitReadCount), { timeout: 30_000 });
  const readCount = Number(await results.getByTestId("read-count").textContent());
  expect(readCount).toBe(explicitReadCount);

  // --- 8) 業務タスクを画面から着手→完了する（API-87。再開だけ理由必須の確認ダイアログ） ---
  // 既読の詳細からタスクタブへ（詳細にはタブが無いため一覧のタスクタブを直接開く）
  await memberPage.goto("/app/tasks-notifications?tab=tasks");
  await expect(memberPage).toHaveURL(/tab=tasks/);
  const taskRow = memberPage.getByRole("list", { name: "自分のタスク" }).getByRole("listitem")
    .filter({ hasText: `資機材の注文 ${tag}` });
  await expect(taskRow).toBeVisible({ timeout: 15_000 });
  await taskRow.getByRole("button", { name: "着手" }).click();
  await expect(taskRow.getByText("着手中", { exact: true })).toBeVisible({ timeout: 15_000 });
  await taskRow.getByRole("button", { name: "完了する" }).click();
  await expect(memberPage.getByText("保存しました").first()).toBeVisible({ timeout: 15_000 });
  // 完了したタスクは対応中の一覧から外れる（ダッシュボードの「自分のタスク」と同じ条件）
  await expect(taskRow).toHaveCount(0, { timeout: 15_000 });
  await memberPage.getByLabel("状態で絞る").selectOption("done");
  const doneRow = memberPage.getByRole("list", { name: "自分のタスク" }).getByRole("listitem")
    .filter({ hasText: `資機材の注文 ${tag}` });
  await expect(doneRow).toBeVisible({ timeout: 15_000 });
  await expect(doneRow.getByText("完了").first()).toBeVisible({ timeout: 15_000 });
  // 完了済みには再開（理由必須の確認ダイアログ）が出る
  await doneRow.getByRole("button", { name: "再開する" }).click();
  const reopenDialog = memberPage.getByRole("dialog", { name: "このタスクを再開しますか" });
  await expect(reopenDialog.getByLabel("再開の理由（必須）")).toBeVisible({ timeout: 15_000 });
  await reopenDialog.getByRole("button", { name: "戻る" }).click();
});

/**
 * 通知の操作で失敗（409など）が表示されること（PH4レビューC 中2）。
 * 承認ダイアログを開いたまま、同じ下書きを別経路（管理者のAPI直操作）で先に承認済みにすると、
 * 画面の承認は409（競合）で拒否される。拒否されたときは「他の操作で更新されています」の案内が出て、
 * ダイアログは開いたまま（成功と失敗を区別しない画面はdocs/03 §1「conflictを区別」に反する）。
 * draftのid/version/hashは作成応答（API-63）から拾う（送信者の一覧を読むAPIは無いため。docs/03 §1.1-14⑥）。
 */
// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("notification_approval_shows_conflict_when_already_approved_elsewhere", async ({ browser, request }, testInfo) => {
  test.setTimeout(180_000);
  const tag = crypto.randomUUID().slice(0, 6);

  // --- seed: 幹部（PER-12保持）と、だれも回答しない予定（未回答抽出の対象=幹部1人） ---
  const officerEmail = uniqueEmail(`e2e-ntf-c-${tag}`);
  const officer = await inviteNewMember(request, `架空 幹部 ${tag}`, officerEmail);
  const startsAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const activity = await adminApiData<{ id: string }>(request, "POST", "/api/v1/activities", {
    title: `出動時の持ち物 ${tag}`, kind: "訓練", plannedStartsAt: startsAt, locationText: "架空市中央公園",
    ownerMemberId: officer.memberId, audienceMemberIds: [officer.memberId],
  });
  expect(activity.status).toBe(201);
  const publish = await adminApiData(request, "PATCH", `/api/v1/activities/${activity.data.data.id}`, {
    version: 1, status: "scheduled", reason: "e2e: 対象を確定して公開",
  });
  expect(publish.status).toBe(200);

  const officerCtx = await newUserContext(browser, testInfo.project.use.viewport!);
  const officerPage = await officerCtx.newPage();
  await acceptInvitationViaUi(officerPage, officerEmail, officer.token, { mfa: false });
  const rows = (
    await adminApiData(request, "GET", "/api/v1/members?limit=200")
  ).data.data as { id: string; version: number; account: { authzVersion: number } | null }[];
  const officerRow = rows.find((r) => r.id === officer.memberId)!;
  const roles = await adminApiData(request, "PUT", `/api/v1/members/${officer.memberId}/roles`, {
    version: officerRow.version,
    expectedAuthzVersion: officerRow.account?.authzVersion ?? 1,
    roleCodes: ["officer"],
    reason: "e2e: 幹部（PER-12保持）として通知を作成する",
    scopes: [],
  });
  expect(roles.status).toBe(200);

  // --- 1) 画面から下書きを作る。作成応答からid/version/hashを拾う（画面は開いたまま残る） ---
  await officerPage.goto("/app/tasks-notifications/notifications/new");
  await officerPage.getByLabel("通知の源").selectOption("activity");
  const sourceSelect = officerPage.getByLabel("抽出する予定");
  await sourceSelect.selectOption((await sourceSelect.locator("option", { hasText: `出動時の持ち物 ${tag}` }).getAttribute("value"))!);
  await expect(officerPage.getByText(/対象者（1人/).first()).toBeVisible({ timeout: 15_000 });
  const draftResponsePromise = officerPage.waitForResponse(
    (r) => r.url().includes("/api/v1/notifications/drafts") && r.request().method() === "POST",
  );
  await officerPage.getByRole("button", { name: "下書きを作成" }).click();
  const draftResponse = (await (await draftResponsePromise).json()) as {
    data: { id: string; version: number; bodyHash: string; audienceHash: string };
  };
  await expect(officerPage.getByText(/出欠確認/).first()).toBeVisible({ timeout: 15_000 }); // 承認前確認に進んでいる

  // --- 2) 別経路（管理者のAPI直操作）で同じ下書きを先に承認済みにする（画面の表示は古いまま） ---
  const approveElsewhere = await adminApiData(request, "POST", `/api/v1/notifications/${draftResponse.data.id}/approval`, {
    version: draftResponse.data.version,
    bodyHash: draftResponse.data.bodyHash,
    audienceHash: draftResponse.data.audienceHash,
    decision: "approve",
  });
  expect([200, 202]).toContain(approveElsewhere.status);

  // --- 3) 画面の承認は409で拒否され、失敗の案内が出る（開いたまま無反応、は起こらない） ---
  await officerPage.getByRole("button", { name: "承認する" }).click();
  const approveDialog = officerPage.getByRole("dialog", { name: "この通知を承認して送信しますか" });
  await approveDialog.getByRole("button", { name: "承認する" }).click();
  await expect(officerPage.getByText("他の操作で更新されています")).toBeVisible({ timeout: 15_000 });
  await expect(approveDialog).toBeVisible(); // 失敗したので承認は進まず、ダイアログは開いたまま案内する
});
