import { expect, test } from "@playwright/test";
import { adminApiData, apiHeaders, BASE } from "./helpers";

/**
 * 巡回計画（T071、SCR-25 /app/patrol-plans。docs/03 SCR-25「対象施設/日/順序/計画案/人の確定」）。
 *
 * メニューの「巡回計画」タイルから入り、案の作成（API-78）→順序の編集（上下移動）→人の確定
 * （API-79 decision=confirm。確認ダイアログで日付・順序・対象施設を明示）→確定済み表示（終端）＋注記、
 * さらに別の案の取消（cancel。理由必須）までをUIで完走させる。
 *
 * - **UIから操作できない完了操作を作らない**: 確定・取消は画面の操作で行い、API直接の確定は行わない。
 * - **確定直後にタスク・出動・通知・点検が増えないこと（autoDispatchCount=0相当）はAPI検証読みで断言する**
 *   （tasks=API-102 / incidents=API-21 / notifications=API-67 / inspections=API-44の件数を確定の前後で比較）。
 * - 順序の候補はサーバーの最近傍順（南から北）。seedの施設3件を南北の直線上に置いて決定的にする。
 * - seedはAPI経由（施設3件。他の試験が作った施設もあるため、管理番号に試験固有のタグを含めて識別する）。
 */

test("patrol_ui_completes_draft_order_and_human_confirm_without_auto_dispatch", async ({ page }) => {
  test.setTimeout(300_000);
  const tag = crypto.randomUUID().slice(0, 6);
  const date = "2026-11-01";
  const objective = `水利の定期巡回 ${tag}`;
  const cancelObjective = `夜間の巡回 ${tag}`;

  // --- seed: 巡回の対象になる架空の施設3件（南北の直線上。約220m間隔。最近傍順を決定的にする） ---
  const mk = async (n: string, lat: number) => {
    const res = await adminApiData<{ id: string }>(page.request, "POST", "/api/v1/facilities", {
      type: "hydrant", managementNumber: n, latitude: lat, longitude: 139.65,
      locationSource: "架空市台帳", locationNote: `巡回計画の試験用施設 ${n}`,
    });
    expect(res.status).toBe(201);
    return res.data.data.id;
  };
  const fa = await mk(`PAT-${tag}-A`, 35.0);
  const fb = await mk(`PAT-${tag}-B`, 34.998);
  const fc = await mk(`PAT-${tag}-C`, 34.996);

  // 確定前後の効果の件数（タスク・出動・通知・点検。autoDispatchCount=0相当の検証読み）
  const countOf = async (path: string) => {
    const res = await page.request.fetch(`${BASE}${path}`, { headers: apiHeaders() });
    expect(res.ok()).toBeTruthy();
    return ((await res.json()) as { data: unknown[] }).data.length;
  };
  const effectCount = async () =>
    (await countOf("/api/v1/tasks/me?limit=200")) +
    (await countOf("/api/v1/incidents?limit=200")) +
    (await countOf("/api/v1/notifications/me?limit=200")) +
    (await countOf(`/api/v1/facilities/${fa}/inspections?limit=200`)) +
    (await countOf(`/api/v1/facilities/${fb}/inspections?limit=200`)) +
    (await countOf(`/api/v1/facilities/${fc}/inspections?limit=200`));

  // --- 1) メニューの「巡回計画」タイルから入り、未実装プレースホルダーが無いことを確認する ---
  await page.goto("/app/menu");
  await page.locator("#main").getByRole("link", { name: "巡回計画" }).click();
  await expect(page).toHaveURL(/\/app\/patrol-plans$/);
  await expect(page.getByText("未実装")).toHaveCount(0);
  // 常時注記（計画確定を実災害の指令/設備安全判断にしない）
  await expect(page.getByText(/実災害の指令や設備の安全判断ではありません/).first()).toBeVisible();

  // --- 2) 案の作成（日付・目的・対象施設3件） ---
  await page.getByLabel("巡回日").fill(date);
  await page.getByLabel("目的").fill(objective);
  for (const n of [`PAT-${tag}-A`, `PAT-${tag}-B`, `PAT-${tag}-C`]) {
    await page.getByLabel(`消火栓 ${n}`).check();
  }
  await page.getByRole("button", { name: "計画案を作成する" }).click();
  await expect(page.getByText("保存しました")).toBeVisible();

  const plansSection = page.locator('section[aria-label="作成した計画"]');
  const card = plansSection.locator("div.hairline").filter({ hasText: objective });
  await expect(card).toHaveCount(1);
  await expect(card.getByText("案", { exact: true })).toBeVisible();

  // --- 3) 候補順の提案（最近傍順: 南のC→B→A）と順序の編集（上下移動） ---
  const rows = card.getByRole("list", { name: "巡回順" }).locator("li");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText(`PAT-${tag}-C`);
  await expect(rows.nth(1)).toContainText(`PAT-${tag}-B`);
  await expect(rows.nth(2)).toContainText(`PAT-${tag}-A`);
  // 上下移動（押下領域44px）でBを先頭へ。DTOのfacilityNameは管理番号か識別名（接頭辞なし）
  await card.getByRole("button", { name: `PAT-${tag}-B を上へ移動` }).click();
  await expect(rows.nth(0)).toContainText(`PAT-${tag}-B`);
  await expect(rows.nth(1)).toContainText(`PAT-${tag}-C`);
  await expect(rows.nth(2)).toContainText(`PAT-${tag}-A`);
  await expect(card.getByText("順序を変更しています（まだ保存されていません）")).toBeVisible();

  // --- 4) 確定（確認ダイアログで日付・順序・対象施設を明示。効果が無い旨の注記も出す） ---
  const effectsBeforeConfirm = await effectCount();
  await card.getByRole("button", { name: "この順序で確定する" }).click();
  const dialog = page.getByRole("dialog", { name: "この巡回順で確定しますか" });
  await expect(dialog.getByText(`巡回日: ${date}`)).toBeVisible();
  await expect(dialog.locator("ol li")).toHaveText([
    `PAT-${tag}-B`,
    `PAT-${tag}-C`,
    `PAT-${tag}-A`,
  ]);
  await expect(dialog.getByText(/出動・タスク・通知は自動では作られません/)).toBeVisible();
  await dialog.getByRole("button", { name: "確定する" }).click();

  // 確定済み表示（終端。並べ替えの操作は消える）
  await expect(card.getByText("確定済み").first()).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText(/確定済みの計画はもう変わりません/)).toBeVisible();
  await expect(card.getByRole("button", { name: /を上へ移動/ })).toHaveCount(0);
  await expect(card.getByRole("button", { name: /を下へ移動/ })).toHaveCount(0);
  // 確定後に人が選んだ順序で表示される
  const confirmedRows = card.getByRole("list", { name: "巡回順" }).locator("li");
  await expect(confirmedRows.nth(0)).toContainText(`PAT-${tag}-B`);
  await expect(confirmedRows.nth(1)).toContainText(`PAT-${tag}-C`);
  await expect(confirmedRows.nth(2)).toContainText(`PAT-${tag}-A`);

  // --- 5) autoDispatchCount=0相当の検証読み: 確定の前後でタスク・出動・通知・点検が増えていない ---
  const effectsAfterConfirm = await effectCount();
  expect(effectsAfterConfirm).toBe(effectsBeforeConfirm);

  // --- 6) 別の案の取消（cancel。理由必須。取り消した案は終端） ---
  await page.getByLabel("巡回日").fill(date);
  await page.getByLabel("目的").fill(cancelObjective);
  await page.getByLabel(`消火栓 PAT-${tag}-A`).check();
  await page.getByRole("button", { name: "計画案を作成する" }).click();
  await expect(page.getByText("保存しました")).toBeVisible();
  const card2 = plansSection.locator("div.hairline").filter({ hasText: cancelObjective });
  await expect(card2).toHaveCount(1);
  await card2.getByRole("button", { name: "案を取り消す" }).click();
  const cancelDialog = page.getByRole("dialog", { name: "この案を取り消しますか" });
  // 理由が無いときは実行できない（理由必須）
  await expect(cancelDialog.getByRole("button", { name: "取り消す" })).toBeDisabled();
  await cancelDialog.getByLabel("取り消しの理由（必須）").fill("雨天順延のため（e2eの架空取消）");
  await cancelDialog.getByRole("button", { name: "取り消す" }).click();
  await expect(card2.getByText("取り消し済み").first()).toBeVisible({ timeout: 15_000 });
  await expect(card2.getByRole("button", { name: "この順序で確定する" })).toHaveCount(0);
});
