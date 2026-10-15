import { expect, test } from "@playwright/test";
import { acceptInvitationViaUi, adminApiData, inviteNewMember, newUserContext, uniqueEmail } from "./helpers";

/**
 * 予定一覧・登録・出欠・実績・訂正画面（T039、SCR-08/09/10）。
 * 幹部（PER-03/04）が予定を作成して公開し、団員（PER-02本人のみ）が画面から出欠に回答、
 * 担当（幹部）が**出欠と異なる**実参加を画面から保存・訂正し、履歴検索と旧版表示まで確認する。
 * 「参加予定」（出欠attending）と「実参加」（actual participated）は別表示（docs/11:34の固定語彙）。
 * すべての回答・保存はUI操作で行う（API直叩きで補完しない。PH2レビューの指摘）。
 */

/** datetime-local入力欄と同じ形式で、現在からoffsetMsだけ離れた日時を作る（端末の横軸） */
const localInput = (offsetMs: number) => {
  const d = new Date(Date.now() + offsetMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

test("planned_answer_and_actual_presence_have_separate_labels", async ({ page, browser, request }, testInfo) => {
  test.setTimeout(240_000);
  const viewport = testInfo.project.use.viewport!;
  const tag = crypto.randomUUID().slice(0, 6);

  // 幹部（役割変更はadmin API）と団員を、実際の招待受領で作る
  const officerName = `架空 幹部 ${tag}`;
  const memberName = `架空 団員 ${tag}`;
  const officerEmail = uniqueEmail("e2e-act-o");
  const memberEmail = uniqueEmail("e2e-act-m");
  const officer = await inviteNewMember(request, officerName, officerEmail);
  const member = await inviteNewMember(request, memberName, memberEmail);

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
    reason: "e2e: 幹部（PER-03/04保持）として予定と実績を操作する",
    scopes: [],
  });
  expect(roles.status).toBe(200);

  const memberCtx = await newUserContext(browser, viewport);
  const memberPage = await memberCtx.newPage();
  await acceptInvitationViaUi(memberPage, memberEmail, member.token, { mfa: false });

  // --- 1) 幹部が予定を登録する（SCR-10。UI → API-06。下書きで作られる） ---
  await officerPage.goto("/app/activities/new");
  await officerPage.getByLabel("件名").fill(`操法訓練 ${tag}`);
  await officerPage.getByLabel("種別").selectOption("訓練");
  await officerPage.getByLabel("開始日時").fill(localInput(7 * 864e5));
  await officerPage.getByLabel("終了日時").fill(localInput(7 * 864e5 + 2 * 3600e3));
  await officerPage.getByLabel("場所").fill("第三分団詰所・前庭");
  await officerPage.getByLabel("回答期限").fill(localInput(2 * 864e5));
  // 対象者: 自分（既定で対象）に加えて団員を対象にする（対象snapshot）
  await officerPage.getByRole("checkbox", { name: new RegExp(memberName) }).check();
  await officerPage.getByRole("button", { name: "登録する" }).click();
  // 「new」も [^/]+ に一致してしまうため、詳細画面のUUIDに変わるまで待つ（遷移はトースト表示のあと）
  await expect(officerPage).toHaveURL(/\/app\/activities\/(?!new)[^/]+$/, { timeout: 15_000 });
  const activityUrl = officerPage.url();

  // --- 2) 公開すると出欠の受け付けが始まる（draft→scheduled。UI → API-39） ---
  await expect(officerPage.getByText("下書き").first()).toBeVisible();
  await officerPage.getByRole("button", { name: "予定を公開" }).click();
  await expect(officerPage.getByText("あなたの出欠")).toBeVisible({ timeout: 15_000 });

  // --- 3) 団員が一覧から開いて出欠に「参加」と回答する（SCR-08→09。UI → API-08） ---
  await memberPage.goto("/app/activities");
  await memberPage.getByRole("link", { name: new RegExp(`操法訓練 ${tag}`) }).click();
  await expect(memberPage.getByText("あなたの出欠")).toBeVisible();
  await expect(memberPage.getByText(/^締切/)).toBeVisible();
  await memberPage.getByRole("button", { name: "参加", exact: true }).click();
  await expect(memberPage.getByText("保存しました")).toBeVisible();
  // 回答は選択の見た目と「あなたの回答」に反映される（保存済みと混同しない）
  await expect(memberPage.getByRole("button", { name: "参加", exact: true })).toHaveAttribute("aria-pressed", "true");

  // --- 4) 担当（幹部）が、出欠と**異なる**実参加を保存する（UI → API-09） ---
  await officerPage.goto(activityUrl);
  await expect(officerPage.getByRole("button", { name: "実績を入力" })).toBeVisible();
  await officerPage.getByRole("button", { name: "実績を入力" }).click();
  let form = officerPage.getByLabel("実績の入力");
  await form.getByLabel("活動の内容").fill(`ポンプ車操法を実施 ${tag}`);

  // --- 4a) 未保存の離脱は確認ダイアログ（docs/03:78「既定=編集に戻る」。実績フォームの離脱ガード） ---
  await officerPage.getByRole("link", { name: "戻る", exact: true }).click();
  const leaveDialog = officerPage.getByRole("dialog", { name: "保存されていない変更があります" });
  await expect(leaveDialog).toBeVisible();
  await leaveDialog.getByRole("button", { name: "編集に戻る" }).click();
  await expect(form.getByLabel("活動の内容")).toHaveValue(new RegExp(tag)); // 戻れば入力は保持される
  await officerPage.getByRole("link", { name: "戻る", exact: true }).click();
  await leaveDialog.getByRole("button", { name: "保存せずに移動する" }).click();
  await expect(officerPage).toHaveURL(/\/app\/activities$/); // 保存せずに移動を選ぶと実際に離れる

  // --- 4b) 離脱でフォームは閉じているため開き直し、改めて入力して保存する ---
  await officerPage.goto(activityUrl);
  await officerPage.getByRole("button", { name: "実績を入力" }).click();
  form = officerPage.getByLabel("実績の入力");
  await form.getByLabel("活動の内容").fill(`ポンプ車操法を実施 ${tag}`);
  await form.getByLabel("実施（開始）").fill(localInput(7 * 864e5));
  await form.getByLabel("実施（終了）").fill(localInput(7 * 864e5 + 2 * 3600e3));
  // 団員は出欠「参加」だが実参加は「欠席」、幹部は未回答だが「実参加」→ 別物（docs/11 実参加行）
  await form.getByLabel(`${memberName}さんの実参加`).selectOption("欠席");
  await form.getByLabel(`${officerName}さんの実参加`).selectOption("実参加");
  // フォーム下端のボタンはスマホでは固定ナビに半分隠れてポインタの当たり判定が安定しないため、キーボードで保存する
  await form.getByRole("button", { name: "実績を保存" }).focus();
  await officerPage.keyboard.press("Enter");
  await expect(officerPage.getByText("保存しました")).toBeVisible();

  // --- 5) 「参加予定」（出欠）と「実参加」（実績）は別表示で、表示される人の集合も一致しない ---
  await expect(officerPage.getByText("参加予定")).toBeVisible();
  // 「実参加」は見出しのほか現行版の参加行チップにも出るためfirst（表示の区別自体はこの試験の主題）
  await expect(officerPage.getByText("実参加").first()).toBeVisible();
  const plannedNames = await officerPage.getByRole("list", { name: "参加予定" }).getByRole("listitem").allTextContents();
  const actualNames = await officerPage.getByRole("list", { name: "実参加" }).getByRole("listitem").allTextContents();
  const displayedPlannedAndActualMembersEqual =
    plannedNames.length === actualNames.length && [...plannedNames].sort().every((v, i) => v === [...actualNames].sort()[i]);
  expect(displayedPlannedAndActualMembersEqual).toBe(false);
  // 未知時刻（個人時間）は空欄/未記載と表示し、捏造しない（docs/05 §3）
  await expect(officerPage.getByText("未記載").first()).toBeVisible();

  // --- 6) 実績を訂正する（原本は不変。参加者は全置換。UI → API-42） ---
  await officerPage.getByRole("button", { name: "実績を訂正" }).click();
  const correctForm = officerPage.getByLabel("実績の訂正");
  await expect(correctForm.getByLabel("活動の内容")).toHaveValue(new RegExp(tag));
  await correctForm.getByLabel(`${memberName}さんの実参加`).selectOption("実参加");
  await correctForm.getByLabel("訂正理由").fill("後半から参加していたため欠席扱いを訂正");
  await correctForm.getByRole("button", { name: "訂正を保存" }).focus();
  await officerPage.keyboard.press("Enter");
  await expect(officerPage.getByText("保存しました").first()).toBeVisible();
  await expect(officerPage.getByText("第2版").first()).toBeVisible({ timeout: 15_000 });

  // --- 7) 旧版も追跡できる（API-43。第1版では団員は欠席だった） ---
  await officerPage.getByRole("button", { name: "第1版" }).click();
  await expect(officerPage.getByText("旧版")).toBeVisible();
  await expect(officerPage.getByText("欠席").first()).toBeVisible(); // 初版での団員=欠席が残っている
  await officerPage.getByRole("button", { name: "第2版" }).click();
  await expect(officerPage.getByText(/訂正理由/)).toBeVisible();

  // --- 8) 履歴検索: 実参加で団員を絞ると、訂正後のこの活動が見つかる（T047と同じURLクエリ） ---
  await officerPage.goto(`/app/activities?actual=true&memberId=${member.memberId}`);
  await expect(officerPage.getByText(`操法訓練 ${tag}`)).toBeVisible();

  // 回答前の母数（未回答=対象snapshot−回答あり）も、幹部には分かる（docs/04 対象snapshot）
  await officerPage.goto(activityUrl);
  await expect(officerPage.getByText(/参加 1/)).toBeVisible();
  await expect(officerPage.getByText(/未回答 1/)).toBeVisible();
});
