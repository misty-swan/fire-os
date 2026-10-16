import { expect, test } from "@playwright/test";
import { acceptInvitationViaUi, adminApiData, inviteNewMember, newUserContext, uniqueEmail } from "./helpers";

/**
 * 出動詳細の更新配信と再同期（T073、SCR-12）。
 * 2つの端末（別ブラウザ文脈＝別利用者の別端末）で同じ出動記録を開き、片方の端末が画面から状態を変えると、
 * もう片方の画面は**自分の操作なしで**変わることを確かめる（poll輸送・docs/05 §8・docs/evidence/V06-realtime.md）。
 * さらに、片方の端末の役割を変えて認可版を進め（cursorが409 RESYNC_REQUIREDになる状態）、その後の変更も
 * 届くこと（snapshotの取り直しで回復する）を**実ブラウザの画面で**確かめる。オフラインの捏造はしない。
 */

test("incident_detail_receives_remote_updates_and_resyncs_after_role_change", async ({ browser, request }, testInfo) => {
  test.setTimeout(300_000);
  const viewport = testInfo.project.use.viewport!;
  const tag = crypto.randomUUID().slice(0, 6);

  // --- seed: 幹部2名（PER-04。状態の変更はUIから行う。seedの役割付与だけAPI） ---
  // 役割の付与はアカウントが付いた団員にだけできる（member-roles）。先に招待を受領させてから付与する
  const officerAEmail = uniqueEmail("e2e-rt-a");
  const officerBEmail = uniqueEmail("e2e-rt-b");
  const officerA = await inviteNewMember(request, `架空 指令 ${tag}`, officerAEmail);
  const officerB = await inviteNewMember(request, `架空 記録 ${tag}`, officerBEmail);

  // --- 端末A: 招待を受領し、模擬出動を登録する（SCR-22 → SCR-12） ---
  const ctxA = await newUserContext(browser, viewport);
  const pageA = await ctxA.newPage();
  await acceptInvitationViaUi(pageA, officerAEmail, officerA.token, { mfa: false });
  // --- 端末B: 別端末（別利用者）。招待を受領だけ済ませておく ---
  const ctxB = await newUserContext(browser, viewport);
  const pageB = await ctxB.newPage();
  await acceptInvitationViaUi(pageB, officerBEmail, officerB.token, { mfa: false });

  for (const [officer, reason] of [
    [officerA, "e2e: 出動の状態を変更する幹部（端末A）"],
    [officerB, "e2e: 出動の状態を変更する幹部（端末B）"],
  ] as const) {
    const rows = (await adminApiData(request, "GET", "/api/v1/members?limit=200")).data.data as {
      id: string; version: number; account: { authzVersion: number } | null;
    }[];
    const row = rows.find((r) => r.id === officer.memberId)!;
    const res = await adminApiData(request, "PUT", `/api/v1/members/${officer.memberId}/roles`, {
      version: row.version,
      expectedAuthzVersion: row.account?.authzVersion ?? 1,
      roleCodes: ["officer"],
      reason,
      scopes: [],
    });
    expect(res.status).toBe(200);
  }

  // --- 端末A: 模擬出動を登録する ---
  await pageA.goto("/app/incidents/new");
  await expect(pageA.getByText("正式な指令").first()).toBeVisible();
  await pageA.getByRole("button", { name: "模擬", exact: true }).click();
  const occurred = new Date(Date.now() - 3600e3);
  const p = (n: number) => String(n).padStart(2, "0");
  await pageA.getByLabel("発生日時").fill(
    `${occurred.getFullYear()}-${p(occurred.getMonth() + 1)}-${p(occurred.getDate())}T${p(occurred.getHours())}:${p(occurred.getMinutes())}`,
  );
  await pageA.getByLabel("概要").fill(`更新配信の確認用 出動 ${tag}`);
  await pageA.getByRole("button", { name: "登録する" }).click();
  await expect(pageA).toHaveURL(/\/app\/incidents\/(?!new)[^/]+$/, { timeout: 15_000 });
  const incidentId = pageA.url().split("/").pop()!;
  await expect(pageA.getByText("記録中", { exact: true }).first()).toBeVisible();
  // 同期の札（T073で実接続。プレースホルダーの文言から変わっている）
  await expect(pageA.getByText("オンライン・この記録を同期中")).toBeVisible();

  // --- 端末B: 同じ出動記録を開き、画面から「出動中」へ変更する ---
  await pageB.goto(`/app/incidents/${incidentId}`);
  await expect(pageB.getByText("記録中", { exact: true }).first()).toBeVisible();
  await pageB.getByRole("button", { name: "出動中にする" }).click();
  await pageB.getByLabel("理由（必須）").fill("隊長の指示で出動（架空）");
  // フォーム下端はスマホで隠れ得るためキーボードで確定する（incidents.specと同じ配慮）
  await pageB.getByRole("button", { name: "変更する" }).focus();
  await pageB.keyboard.press("Enter");
  await expect(pageB.getByText("保存しました").first()).toBeVisible();

  // --- 端末Aは操作なしで「出動中」に変わる（poll輸送の配信。再読込はしない） ---
  await expect(pageA.getByText("出動中", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(pageA.getByText("オンライン・この記録を同期中")).toBeVisible();

  // --- 端末Aの役割に「担当」を加える（users.authz_versionが進む＝開いたままのcursorが409になる状態） ---
  const rowsA = (await adminApiData(request, "GET", "/api/v1/members?limit=200")).data.data as {
    id: string; version: number; account: { authzVersion: number } | null;
  }[];
  const rowA = rowsA.find((r) => r.id === officerA.memberId)!;
  const grant = await adminApiData(request, "PUT", `/api/v1/members/${officerA.memberId}/roles`, {
    version: rowA.version,
    expectedAuthzVersion: rowA.account?.authzVersion ?? 1,
    roleCodes: ["officer", "operator"],
    reason: "e2e: 認可版を進めて、開いているcursorの再同期（409→snapshot）を確認する",
    scopes: [],
  });
  expect(grant.status).toBe(200);

  // --- 端末Bがさらに「終了」へ。端末Aは再同期を挟んでも続きを受け取れる ---
  await pageB.getByRole("button", { name: "終了する" }).click();
  await pageB.getByLabel("理由（必須）").fill("訓練を終了（架空）");
  await pageB.getByRole("button", { name: "変更する" }).focus();
  await pageB.keyboard.press("Enter");
  await expect(pageB.getByText("保存しました").first()).toBeVisible();
  await expect(pageA.getByText("終了", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  // 履歴にも2回分の状態変更が載る（読み直しが実データに届いている）
  await expect(pageA.getByText("出動中 → 終了")).toBeVisible();
  await expect(pageA.getByText("オンライン・この記録を同期中")).toBeVisible();
});
