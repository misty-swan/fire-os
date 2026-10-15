import { expect, test } from "@playwright/test";
import { acceptInvitationViaUi, adminApiData, BASE, inviteNewMember, newUserContext, uniqueEmail } from "./helpers";

/**
 * お知らせの作成・公開・改版・閲覧・本人既読の画面（T046、SCR-16）。
 * 幹部（PER-03）がメニューの「お知らせ」タイルから一覧へ入り、作成→公開先確認→公開→対象者が閲覧/本人既読→
 * 改版（新revision）→対象者の再閲覧（旧版の既読は新版では未確認）→添付解除→未許可roleの直接更新(403)までを
 * UIで完結させる。業務操作はUI経由（団員・役割のseed作成と検証読みだけAPI。PH2レビューの指摘）。
 */

// ChromiumのAndroidエミュレーションはファイル選択でレイアウトビューポートを広げたまま戻らないことがある
// （attachments.specと同じ配慮）。画面幅の確認は360pxのまま行うため、入力方式だけデスクトップに合わせる。
test.use({ isMobile: false, hasTouch: false });

/** 最小のPNG（1px。実写真情報は載せない。attachments.specと同じ生成） */
function pngBytes(): Buffer {
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

test("edited_announcement_requires_new_read", async ({ page, browser, request }, testInfo) => {
  test.setTimeout(300_000);
  const viewport = testInfo.project.use.viewport!;
  const tag = crypto.randomUUID().slice(0, 6);
  const title1 = `秋季訓練の集合時刻のお知らせ ${tag}`;
  const title2 = `${title1}（訂正）`;

  // --- seed: 幹部（PER-03）と対象者の一般団員。ここだけAPI（業務操作は以下すべてUI） ---
  const officerEmail = uniqueEmail(`e2e-ann-o-${tag}`);
  const officer = await inviteNewMember(request, `架空 幹部 ${tag}`, officerEmail);
  const memberEmail = uniqueEmail(`e2e-ann-m-${tag}`);
  const member = await inviteNewMember(request, `架空 団員 ${tag}`, memberEmail);

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
    reason: "e2e: 幹部（PER-03保持）としてお知らせを管理する",
    scopes: [],
  });
  expect(roles.status).toBe(200);

  // --- 1) メニューの「お知らせ」タイルから一覧へ入り、作成フォームを開く（SCR-16） ---
  await officerPage.goto("/app/menu");
  await officerPage.locator("#main").getByRole("link", { name: "お知らせ" }).click();
  await expect(officerPage).toHaveURL(/\/app\/announcements$/);
  await officerPage.getByRole("link", { name: "お知らせを作成" }).click();
  await expect(officerPage).toHaveURL(/\/app\/announcements\/new$/);

  await officerPage.getByLabel("件名").fill(title1);
  await officerPage.getByLabel("本文").fill(`10/25（日）の集合は9時に変更しました。長靴と軍手を持参してください。${tag}`);
  // 対象者（公開先）: 自分（幹部）は初期選択。一般団員を対象に加える
  await officerPage.getByLabel(`架空 団員 ${tag}`).check();
  await officerPage.getByRole("button", { name: "登録する" }).click();
  await expect(officerPage.getByText("保存しました")).toBeVisible();
  await expect(officerPage).toHaveURL(/\/app\/announcements\/(?!new)[^/]+$/, { timeout: 15_000 });
  const announcementUrl = officerPage.url();
  const announcementId = announcementUrl.split("/").pop()!;
  await expect(officerPage.getByText("下書き").first()).toBeVisible();

  // --- 2) 公開は確認ダイアログ（公開先確認）で対象を見てから行う ---
  await officerPage.getByRole("button", { name: "公開する" }).click();
  const publishDialog = officerPage.getByRole("dialog", { name: "このお知らせを公開しますか" });
  await expect(publishDialog.getByText("公開先")).toBeVisible();
  await expect(publishDialog.getByText(`架空 団員 ${tag}`)).toBeVisible();
  await publishDialog.getByRole("button", { name: "公開する" }).click();
  await expect(officerPage.getByText("保存しました").first()).toBeVisible();
  await expect(officerPage.getByText("公開中").first()).toBeVisible({ timeout: 15_000 });

  // --- 3) 幹部が写真を添付する（詳細画面から。対象者に見える形で表示される） ---
  await officerPage.setInputFiles('input[type="file"]', { name: "notice.png", mimeType: "image/png", buffer: pngBytes() });
  await expect(officerPage.getByText("準備完了")).toBeVisible({ timeout: 30_000 });

  // --- 4) 対象者（一般団員）が閲覧し、明示操作で本人既読を取る ---
  const memberCtx = await newUserContext(browser, viewport);
  const memberPage = await memberCtx.newPage();
  await acceptInvitationViaUi(memberPage, memberEmail, member.token, { mfa: false });
  await memberPage.goto("/app/announcements");
  await memberPage.getByRole("link", { name: new RegExp(title1) }).click();
  await expect(memberPage).toHaveURL(new RegExp(`/app/announcements/${announcementId}$`));
  // 公開版の本文と版・添付が対象者に見える
  await expect(memberPage.getByText(new RegExp(title1))).toBeVisible();
  await expect(memberPage.getByText("第1版")).toBeVisible();
  await expect(memberPage.getByAltText("お知らせの添付1")).toBeVisible({ timeout: 15_000 });
  // 既読は自動でなく明示操作（docs/11「既読は版に束縛」）。未確認の表示が出て、確認すると既読になる
  await expect(memberPage.getByText("この版は未確認")).toBeVisible();
  await memberPage.getByRole("button", { name: "内容を確認" }).click();
  await expect(memberPage.getByText("保存しました").first()).toBeVisible();
  await expect(memberPage.getByText("既読").first()).toBeVisible({ timeout: 15_000 });

  // --- 5) 幹部が改版する（title/bodyの変更は新revision。docs/11「編集で新revision」） ---
  await officerPage.getByRole("link", { name: "編集" }).click();
  await expect(officerPage).toHaveURL(new RegExp(`/app/announcements/${announcementId}/edit$`));
  await officerPage.getByLabel("件名").fill(title2);
  await officerPage.getByLabel("本文").fill(`10/25（日）の集合は9時に変更しました。雨天判断は7時に連絡します。${tag}`);
  await officerPage.getByRole("button", { name: "変更を保存" }).click();
  await expect(officerPage.getByText("保存しました").first()).toBeVisible();
  await expect(officerPage).toHaveURL(new RegExp(`/app/announcements/${announcementId}$`), { timeout: 15_000 });
  await expect(officerPage.getByText("第2版").first()).toBeVisible({ timeout: 15_000 });

  // --- 6) 対象者の再閲覧: 旧版の既読は新版では未確認（既読は版に束縛。docs/11 お知らせ行） ---
  await memberPage.goto("/app/announcements");
  await memberPage.getByRole("link", { name: new RegExp(title2) }).click();
  await expect(memberPage.getByText("第2版")).toBeVisible();
  await expect(memberPage.getByText("この版は未確認")).toBeVisible(); // 改版で未読に戻る
  await memberPage.getByRole("button", { name: "内容を確認" }).click();
  await expect(memberPage.getByText("既読").first()).toBeVisible({ timeout: 15_000 });

  // --- 7) 添付の解除は理由必須（API-101）。解除後は対象者にも見えなくなる ---
  await officerPage.getByRole("button", { name: "外す" }).click();
  const unlinkDialog = officerPage.getByRole("dialog", { name: "この添付を外しますか" });
  await unlinkDialog.getByLabel("外す理由（必須）").fill("誤って別の訓練の写真を添付したため");
  await unlinkDialog.getByRole("button", { name: "外す" }).click();
  await expect(officerPage.getByText("保存しました").first()).toBeVisible();
  await expect(officerPage.getByAltText("お知らせの添付1")).toHaveCount(0, { timeout: 15_000 });
  await expect(officerPage.getByRole("button", { name: "外す" })).toHaveCount(0);
  await memberPage.reload();
  await expect(memberPage.getByAltText("お知らせの添付1")).toHaveCount(0, { timeout: 15_000 });

  // --- 8) 未許可role（一般団員）の直接更新は403（docs/10 PER-03。画面には変更操作が出ない） ---
  const listRes = await memberCtx.request.fetch(`${BASE}/api/v1/announcements?limit=200`, { headers: { origin: BASE } });
  expect(listRes.status()).toBe(200);
  const visible = ((await listRes.json()) as { data: { id: string; version: number }[] }).data.find((r) => r.id === announcementId)!;
  const unauthorizedPublish = await memberCtx.request.fetch(`${BASE}/api/v1/announcements/${announcementId}`, {
    method: "PATCH",
    headers: { origin: BASE, "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    data: JSON.stringify({ version: visible.version, status: "archived" }),
  });
  expect(unauthorizedPublish.status()).toBe(403); // docs/10 PER-03: 一般団員の直接更新は403
  // 403の後も公開中のまま（勝手に終了されていない）
  await expect(memberPage.getByText("公開中").first()).toBeVisible();
  // 対象者の画面には公開/編集/終了などの変更操作が出ない（PER-03の操作は幹部だけ。docs/03 §1.1-11）
  await expect(memberPage.getByRole("button", { name: "公開する" })).toHaveCount(0);
  await expect(memberPage.getByRole("link", { name: "編集" })).toHaveCount(0);
  await expect(memberPage.getByRole("button", { name: "終了する" })).toHaveCount(0);
});
