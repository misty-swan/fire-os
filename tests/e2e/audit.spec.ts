import { expect, test } from "@playwright/test";
import { inviteNewMember, uniqueEmail } from "./helpers";

// 幅: 両方（監査ログが360pxで横にはみ出さない確認）
test("audit_panel_shows_who_changed_what_without_bodies", async ({ page, request }) => {
  const email = uniqueEmail("audit-secret");
  const name = `架空 監査表示 ${crypto.randomUUID().slice(0, 4)}`;
  await inviteNewMember(request, name, email);

  await page.goto("/app/admin");
  await expect(page.getByRole("heading", { name: "監査ログ" })).toBeVisible();
  await page.getByLabel("対象").selectOption("invitation");
  await page.getByRole("button", { name: "絞り込む" }).click();
  const log = page.getByRole("list", { name: "監査ログ" });
  await expect(log.getByText("招待を発行").first()).toBeVisible();
  // 行為者は名簿から氏名に直して表示、本文（メール）は記録に無い
  await expect(log.getByText("架空 管理者").first()).toBeVisible();
  await expect(page.getByText(email)).toHaveCount(0);
  await log.getByText("招待を発行").first().click();
  await expect(log.getByText("操作ID").first()).toBeVisible();
  await expect(log.getByText("invitation.created").first()).toBeVisible();
  // 横にはみ出さない
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
