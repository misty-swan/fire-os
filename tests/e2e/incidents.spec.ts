import { expect, test } from "@playwright/test";
import { acceptInvitationViaUi, adminApiData, inviteNewMember, newUserContext, uniqueEmail } from "./helpers";

/**
 * 出動一覧・登録・参集・帰還・関連履歴画面（T044、SCR-11/12/22）。
 * 幹部（PER-04）が模擬出動を登録し（SCR-22）、自分の参集・帰還を画面から記録し（API-23）、
 * 既存活動を検索してリンクし（API-71。リンク後は出動と活動が同じ出来事operationに属する）、
 * 車両・機材の使用履歴を編集し（API-57）、資産の使用履歴から元の出動へ戻れることを確認する。
 * すべての業務操作はUI経由で行う（API直叩きは団員・役割・資産のseed作成と検証読みだけ。PH2レビューの指摘）。
 */

/** datetime-local入力欄と同じ形式で、現在からoffsetMsだけ離れた日時を作る（端末の横軸） */
const localInput = (offsetMs: number) => {
  const d = new Date(Date.now() + offsetMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("incident_detail_traces_activity_vehicle_and_equipment", async ({ page, browser, request }, testInfo) => {
  test.setTimeout(300_000);
  const viewport = testInfo.project.use.viewport!;
  const tag = crypto.randomUUID().slice(0, 6);

  // --- seed: 幹部（PER-04）と車両・資機材。ここだけAPI（業務操作は以下すべてUI） ---
  const officerName = `架空 幹部 ${tag}`;
  const officerEmail = uniqueEmail("e2e-inc-o");
  const officer = await inviteNewMember(request, officerName, officerEmail);
  const vehicleRes = await adminApiData(request, "POST", "/api/v1/vehicles", {
    assetCode: `E2E-V-${tag}`, name: `ポンプ車 ${tag}`, status: "運用",
  });
  expect(vehicleRes.status).toBe(201);
  const vehicleId = (vehicleRes.data.data as { id: string }).id;
  const equipmentRes = await adminApiData(request, "POST", "/api/v1/equipment", {
    assetCode: `E2E-E-${tag}`, name: `ホース ${tag}`, quantity: 4, quantityUnit: "本", storage: { note: "詰所" },
  });
  expect(equipmentRes.status).toBe(201);
  const equipmentId = (equipmentRes.data.data as { id: string }).id;

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
    reason: "e2e: 幹部（PER-04保持）として出動記録を操作する",
    scopes: [],
  });
  expect(roles.status).toBe(200);

  // --- 1) 関連先の既存活動を先に作る（SCR-10。UI → API-06） ---
  await officerPage.goto("/app/activities/new");
  await officerPage.getByLabel("件名").fill(`操法訓練 ${tag}`);
  await officerPage.getByLabel("種別").selectOption("訓練");
  await officerPage.getByLabel("開始日時").fill(localInput(-2 * 3600e3));
  await officerPage.getByLabel("場所").fill("第三分団詰所・前庭");
  await officerPage.getByRole("button", { name: "登録する" }).click();
  // 「new」も [^/]+ に一致してしまうため、詳細画面のUUIDに変わるまで待つ
  await expect(officerPage).toHaveURL(/\/app\/activities\/(?!new)[^/]+$/, { timeout: 15_000 });
  const activityUrl = officerPage.url();
  const activityId = activityUrl.split("/").pop()!;

  // --- 2) 模擬出動を登録する（SCR-22。UI → API-22。最初は活動と未リンク・使用履歴も空） ---
  await officerPage.goto("/app/incidents/new");
  await expect(officerPage.getByText("正式な指令").first()).toBeVisible(); // 正式連絡に依存しない旨（D08）
  await officerPage.getByRole("button", { name: "模擬", exact: true }).click();
  await officerPage.getByLabel("発生日時").fill(localInput(-3600e3));
  await officerPage.getByLabel("概要").fill(`第三分団詰所へ参集の模擬出動 ${tag}`);
  await officerPage.getByRole("button", { name: "登録する" }).click();
  await expect(officerPage).toHaveURL(/\/app\/incidents\/(?!new)[^/]+$/, { timeout: 15_000 });
  const incidentUrl = officerPage.url();
  const incidentId = incidentUrl.split("/").pop()!;

  // 種別（模擬）は目立つ文字で区分される（docs/03 SCR-11）。状態は種別と別に表示する
  await expect(officerPage.getByText("模擬").first()).toBeVisible();
  await expect(officerPage.getByText("記録中").first()).toBeVisible();

  // --- 3) 自分の参集→帰還を記録する（UI → API-23。時刻は未入力のまま＝未知は捏造しない） ---
  await officerPage.getByRole("button", { name: "自分の参集を記録" }).click();
  const selfForm = officerPage.getByLabel("自分の参集の記録");
  await selfForm.getByRole("button", { name: "参集済", exact: true }).click();
  // フォーム下端のボタンはスマホでは固定ナビに半分隠れて当たり判定が安定しないためキーボードで保存
  await selfForm.getByRole("button", { name: "記録を保存" }).focus();
  await officerPage.keyboard.press("Enter");
  await expect(officerPage.getByText("保存しました")).toBeVisible();
  await expect(officerPage.getByText("参集済").first()).toBeVisible({ timeout: 15_000 });

  // 帰還のみ事後記録（到着時刻は空のまま。docs/11「欠落時刻を捏造しない」）
  await officerPage.getByRole("button", { name: "帰還を記録" }).click();
  const returnForm = officerPage.getByLabel("自分の帰還の記録");
  await returnForm.getByRole("button", { name: "記録を保存" }).focus();
  await officerPage.keyboard.press("Enter");
  await expect(officerPage.getByText("保存しました").first()).toBeVisible();
  // 固定語彙「帰還記録」（docs/11:34）
  await expect(officerPage.getByText("帰還記録").first()).toBeVisible({ timeout: 15_000 });
  await expect(officerPage.getByText("未記載").first()).toBeVisible();

  // --- 4) 既存活動を検索してリンクする（UI → API-71） ---
  await officerPage.getByRole("button", { name: "関連活動を探す" }).click();
  const linkForm = officerPage.getByLabel("関連活動の検索");
  await linkForm.getByLabel("活動を探す").fill(`操法訓練 ${tag}`);
  await linkForm.getByRole("button", { name: new RegExp(`操法訓練 ${tag}`) }).click();
  await linkForm.getByLabel("関連付ける理由（必須）").fill("訓練中の模擬出動のため記録を関連付ける");
  // 活動の最新の版（operation版）を確認してからでないと実行できない（両rootロックのため）
  await expect(linkForm.getByText("版を確認済み")).toBeVisible({ timeout: 15_000 });
  await linkForm.getByRole("button", { name: "関連付ける" }).click();
  await expect(officerPage.getByText("保存しました").first()).toBeVisible();
  // 関連活動カードに活動の題と詳細への導線が出る
  await expect(officerPage.getByRole("link", { name: new RegExp(`操法訓練 ${tag}`) })).toBeVisible({ timeout: 15_000 });

  // リンク後、出動と活動は同じ出来事（operation）に属する（docs/04:94「リンク時operation一致」。
  // 画面に出ないIDの検証なのでAPIの読み出しで確認する）
  const detailRes = await adminApiData(request, "GET", `/api/v1/incidents/${incidentId}`);
  expect(detailRes.status).toBe(200);
  const detail = detailRes.data.data as { operationId: string; activity: { operationId: string; id: string } | null };
  const incidentOperationId = detail.operationId;
  const linkedActivityOperationId = detail.activity!.operationId;
  expect(linkedActivityOperationId).toBe(incidentOperationId);
  expect(detail.activity!.id).toBe(activityId);

  // 相互導線: 活動の詳細からも関連する出動へ辿れる
  await officerPage.goto(activityUrl);
  await officerPage.getByRole("link", { name: "関連する出動記録" }).click();
  await expect(officerPage).toHaveURL(new RegExp(`/app/incidents\\?activity=${activityId}$`));
  await expect(officerPage.getByText(`第三分団詰所へ参集の模擬出動 ${tag}`)).toBeVisible();
  await officerPage.getByRole("link", { name: new RegExp(`第三分団詰所へ参集の模擬出動 ${tag}`) }).click();
  await expect(officerPage).toHaveURL(new RegExp(`/app/incidents/${incidentId}$`));

  // --- 5) 車両・機材の使用履歴を編集する（UI → API-57。全有効集合PUT） ---
  await officerPage.getByRole("button", { name: "使用履歴を編集" }).click();
  const usageForm = officerPage.getByLabel("使用履歴の編集");
  await usageForm.getByRole("button", { name: "行を追加" }).click();
  await usageForm.getByLabel("使用履歴 1行目の対象").selectOption(`vehicle:${vehicleId}`);
  await usageForm.getByLabel("使用履歴 1行目の数量").fill("1");
  await usageForm.getByRole("button", { name: "行を追加" }).click();
  await usageForm.getByLabel("使用履歴 2行目の対象").selectOption(`equipment:${equipmentId}`);
  await usageForm.getByLabel("使用履歴 2行目の数量").fill("2");
  await usageForm.getByLabel("編集の理由（必須）").fill("模擬出動での使用を記録");
  // フォーム下端はスマホで隠れるためキーボードで保存（activities.specと同じ配慮）
  await usageForm.getByRole("button", { name: "使用履歴を保存" }).focus();
  await officerPage.keyboard.press("Enter");
  await expect(officerPage.getByText("保存しました").first()).toBeVisible();
  // 編集後、車両・機材の行が使用履歴カードに出る（対象・数量）
  await expect(officerPage.getByText(`ポンプ車 ${tag}`)).toBeVisible({ timeout: 15_000 });
  await expect(officerPage.getByText(`ホース ${tag}`)).toBeVisible();

  // --- 6) 資産の使用履歴から元の出動へ戻る（AST-05） ---
  await officerPage.getByRole("link", { name: new RegExp(`ポンプ車 ${tag}`) }).click();
  await expect(officerPage).toHaveURL(new RegExp(`/app/assets/vehicle/${vehicleId}`));
  await expect(officerPage.getByText("使用履歴", { exact: true })).toBeVisible();
  await expect(officerPage.getByText("数量 1")).toBeVisible(); // 出動で記録した使用が資産側にも出る
  await expect(officerPage.getByText("元の出動記録に戻る")).toBeVisible();
  await officerPage.getByRole("link", { name: "元の出動記録に戻る" }).click();
  await expect(officerPage).toHaveURL(new RegExp(`/app/incidents/${incidentId}$`));
  await expect(officerPage.getByText("模擬").first()).toBeVisible();
});

// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("incident_new_draft_usage_rows_are_guarded_by_leave_confirm", async ({ page, browser, request }, testInfo) => {
  test.setTimeout(240_000);
  const viewport = testInfo.project.use.viewport!;
  const tag = crypto.randomUUID().slice(0, 6);

  // --- seed: 幹部と車両。ここだけAPI（業務操作は以下すべてUI） ---
  const officerName = `架空 幹部 ${tag}`;
  const officerEmail = uniqueEmail("e2e-inc-u");
  const officer = await inviteNewMember(request, officerName, officerEmail);
  const vehicleRes = await adminApiData(request, "POST", "/api/v1/vehicles", {
    assetCode: `E2E-VU-${tag}`, name: `ポンプ車 ${tag}`, status: "運用",
  });
  expect(vehicleRes.status).toBe(201);
  const vehicleId = (vehicleRes.data.data as { id: string }).id;

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
    reason: "e2e: 幹部（PER-04保持）として出動記録を操作する",
    scopes: [],
  });
  expect(roles.status).toBe(200);

  // --- 1) 出動登録フォームで、使用資産の行だけ入力する（発生日時・概要など他の必須欄は触らない） ---
  await officerPage.goto("/app/incidents/new");
  await expect(officerPage.getByText("正式な指令").first()).toBeVisible();
  const usageCard = officerPage.getByLabel("使用履歴の下書き");
  await usageCard.getByRole("button", { name: "行を追加" }).click();
  await usageCard.getByLabel("使用履歴 1行目の対象").selectOption(`vehicle:${vehicleId}`);
  await usageCard.getByLabel("使用履歴 1行目の数量").fill("1");

  // --- 2) 保存せずに戻ると、使用資産の下書きも離脱確認の対象（docs/03:78「既定=編集に戻る」） ---
  await officerPage.getByRole("link", { name: "戻る", exact: true }).click();
  const leaveDialog = officerPage.getByRole("dialog", { name: "保存されていない変更があります" });
  await expect(leaveDialog).toBeVisible();
  await leaveDialog.getByRole("button", { name: "編集に戻る" }).click();
  await expect(usageCard.getByLabel("使用履歴 1行目の数量")).toHaveValue("1"); // 戻れば入力は保持される

  // --- 3) 保存せずに移動するを選ぶと、実際に一覧へ離れる ---
  await officerPage.getByRole("link", { name: "戻る", exact: true }).click();
  await leaveDialog.getByRole("button", { name: "保存せずに移動する" }).click();
  await expect(officerPage).toHaveURL(/\/app\/incidents$/);
});
