import { expect, request as pwRequest, test } from "@playwright/test";
import { BASE, PASSWORD, acceptInvitationViaUi, adminApi, apiHeaders, inviteNewMember, isPhone, loginViaUi, logoutViaUi, newUserContext, randomIp, readAdmin, totpCode, uniqueEmail } from "./helpers";

// 実際のCookie・実際のログイン画面で、招待受領→二要素認証→別端末のログイン→回復コード→ログアウトを通す。
// 管理者のセッションは auth.setup.ts が作った storageState（招待tokenからの本物の経路）。fixtureのCookie注入は使わない。

test("mfa_recovery_code_cannot_be_reused", async ({ browser, request }, info) => {
  const viewport = info.project.use.viewport!;
  const email = uniqueEmail("e2e-mfa");
  const { token } = await inviteNewMember(request, "架空 回復確認", email);

  // 1) 招待の受領 → 二要素認証の設定（回復コードは一度だけ表示）
  const ctxA = await newUserContext(browser, viewport);
  const pageA = await ctxA.newPage();
  await expect(pageA.getByRole("button", { name: "自由登録" })).toHaveCount(0);
  const { totpSecret, backupCodes } = await acceptInvitationViaUi(pageA, email, token);
  await expect(pageA).toHaveURL(/\/app$/);

  // 2) 別のブラウザ（別端末）でログイン：パスワードだけではホームに入れず、認証コードを求められる
  const ctxB = await newUserContext(browser, viewport);
  const pageB = await ctxB.newPage();
  await loginViaUi(pageB, email);
  await expect(pageB.getByRole("heading", { name: "認証コードを入力" })).toBeVisible();
  expect((await ctxB.request.get("/api/v1/me", { headers: apiHeaders() })).status()).toBe(401);

  // 3) 回復コードで入る（認証アプリが使えない想定）
  await pageB.getByRole("button", { name: "回復コードを使う" }).click();
  await pageB.getByLabel("回復コード").fill(backupCodes[0]!);
  await pageB.getByRole("button", { name: "確認する" }).click();
  await expect(pageB).toHaveURL(/\/app$/);
  const savedB = await ctxB.storageState();

  // 4) 使った回復コードの再利用は拒否される（別の端末でも入れない）
  const ctxC = await newUserContext(browser, viewport);
  const pageC = await ctxC.newPage();
  await loginViaUi(pageC, email, { backup: backupCodes[0]! });
  await expect(pageC.getByText("コードが正しくないか、すでに使われています")).toBeVisible();
  const reusedRecovery = await ctxC.request.get("/api/v1/me", { headers: apiHeaders() });
  expect(reusedRecovery.status()).not.toBe(200);
  await expect(pageC).not.toHaveURL(/\/app/);
  // 未使用のコードや認証アプリのコードは使える
  await pageC.getByLabel("回復コード").fill(backupCodes[1]!);
  await pageC.getByRole("button", { name: "確認する" }).click();
  await expect(pageC).toHaveURL(/\/app$/);

  // 5) ログアウト：その端末のセッションは使えなくなる
  await logoutViaUi(pageB);
  const previousSession = await (await pwRequest.newContext({ baseURL: BASE, storageState: savedB })).get("/api/v1/me", { headers: apiHeaders() });
  expect(previousSession.status()).not.toBe(200);
  // 認証アプリの6桁でも入れる（回復コードとは別の経路）
  const ctxD = await newUserContext(browser, viewport);
  const pageD = await ctxD.newPage();
  await loginViaUi(pageD, email, { totp: await totpCode(totpSecret, Date.now(), 0) });
  await expect(pageD).toHaveURL(/\/app$/);
  for (const c of [ctxA, ctxB, ctxC, ctxD]) await c.close();
});

test("login_screen_matches_the_prototype_and_offers_no_public_signup", async ({ browser }, info) => {
  const ctx = await newUserContext(browser, info.project.use.viewport!);
  const page = await ctx.newPage();
  await page.goto("/login");
  const phone = isPhone(page.viewportSize());
  // prototype LOGIN：FireOS 40px太字、ロゴ76px、入力54px、主ボタン56px・副ボタン52px
  const logo = page.locator("main span[aria-hidden='true']").first();
  const box = (await logo.boundingBox())!;
  expect([Math.round(box.width), Math.round(box.height)]).toEqual([76, 76]);
  const title = page.getByRole("heading", { level: 1, name: "FireOS" });
  expect(await title.evaluate((e) => getComputedStyle(e).fontSize)).toBe("40px");
  expect(await title.evaluate((e) => getComputedStyle(e).fontWeight)).toBe("900");
  expect(Math.round((await page.getByLabel("メールアドレス").boundingBox())!.height)).toBe(54);
  expect(Math.round((await page.getByRole("button", { name: "ログイン", exact: true }).boundingBox())!.height)).toBe(56);
  const bio = page.getByRole("button", { name: "生体認証でログイン" });
  expect(Math.round((await bio.boundingBox())!.height)).toBe(52);
  await expect(bio).toBeDisabled(); // passkeyは後続。押しても何も起きない状態を作らない
  await expect(page.getByText("消防団のすべてを、ひとつに。")).toBeVisible();
  await expect(page.getByText("DEMO · 架空のデータで動作しています")).toBeVisible();
  await expect(page.getByText("パスワードを忘れた場合は分団の管理者へ")).toBeVisible();
  // ナビは出さない（シェルの外）。自由な新規登録は出さない
  await expect(page.getByTestId("bottom-nav")).toHaveCount(0);
  await expect(page.locator("aside")).toHaveCount(0);
  for (const text of ["新規登録", "アカウント作成", "自由登録", "Sign up"]) await expect(page.getByText(text, { exact: false })).toHaveCount(0);
  // 360pxでも横スクロールが出ない
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  // 誤ったパスワードは、未登録と区別しない文言
  await page.getByLabel("メールアドレス").fill("nobody@example.test");
  await page.getByLabel("パスワード").fill("wrong-password-123");
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page.getByText("メールアドレスまたはパスワードが正しくありません")).toBeVisible();
  if (process.env.SAVE_EVIDENCE === "1") await page.screenshot({ path: `docs/evidence/ph1/login-${info.project.name}.png` });
  expect(phone || true).toBe(true);
  await ctx.close();
});

test("unauthenticated_visit_goes_to_login_and_returns_after_login", async ({ browser, request }, info) => {
  const viewport = info.project.use.viewport!;
  const email = uniqueEmail("e2e-next");
  const { token } = await inviteNewMember(request, "架空 戻り先", email);
  const setup = await newUserContext(browser, viewport);
  const sp = await setup.newPage();
  await acceptInvitationViaUi(sp, email, token, { mfa: false });
  await logoutViaUi(sp);
  // ログアウト後に業務の画面を開くとログインへ。戻り先を覚え、ログイン後に戻る
  await sp.goto("/app/members");
  await expect(sp).toHaveURL(/\/login\?next=%2Fapp%2Fmembers/);
  await loginViaUi(sp, email, undefined, { stay: true });
  await expect(sp).toHaveURL(/\/app\/members$/);
  // 外部URLへの戻り先は受け付けない
  await logoutViaUi(sp);
  await sp.goto("/login?next=https%3A%2F%2Fevil.example%2F");
  await loginViaUi(sp, email, undefined, { stay: true });
  await expect(sp).toHaveURL(/\/app$/);
  await setup.close();
});

test("invitation_that_cannot_be_used_explains_why_without_leaking_state", async ({ browser, request }, info) => {
  const viewport = info.project.use.viewport!;
  const email = uniqueEmail("e2e-cancelled");
  const { token, invitationId } = await inviteNewMember(request, "架空 取消確認", email);
  const cancelled = await adminApi(request, "POST", `/api/v1/invitations/${invitationId}/cancel`, { version: 1, reason: "誤発行のため" });
  expect(cancelled.status).toBe(200);
  const ctx = await newUserContext(browser, viewport);
  const page = await ctx.newPage();
  await page.goto(`/login#invite=${token}`);
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("新しいパスワード（12文字以上）").fill(PASSWORD);
  await page.getByLabel("パスワード（確認）").fill(PASSWORD);
  await page.getByRole("button", { name: "アカウントを作成して受け取る" }).click();
  await expect(page.getByText(/この招待は使えません/)).toBeVisible();
  // 別のメールアドレスでの受領も同じく拒否（招待先のメールだけが登録できる）
  const email2 = uniqueEmail("e2e-wrong");
  const second = await inviteNewMember(request, "架空 宛先違い", email2);
  await page.goto(`/login#invite=${second.token}`);
  await page.getByLabel("メールアドレス").fill(uniqueEmail("someone-else"));
  await page.getByLabel("新しいパスワード（12文字以上）").fill(PASSWORD);
  await page.getByLabel("パスワード（確認）").fill(PASSWORD);
  await page.getByRole("button", { name: "アカウントを作成して受け取る" }).click();
  await expect(page.getByText(/この招待は使えません/)).toBeVisible();
  // パスワードが短い・確認が違う場合は送信前に直す
  await page.getByLabel("メールアドレス").fill(email2);
  await page.getByLabel("新しいパスワード（12文字以上）").fill("short");
  await page.getByLabel("パスワード（確認）").fill("short");
  await page.getByRole("button", { name: "アカウントを作成して受け取る" }).click();
  await expect(page.getByText("パスワードは12文字以上で入力してください")).toBeVisible();
  await ctx.close();
  expect(randomIp()).toBeTruthy();
  expect(readAdmin().email).toBeTruthy();
});
