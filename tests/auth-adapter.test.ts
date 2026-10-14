import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { assertAuthEnv } from "../src/server/auth/config";
import { createAuthService } from "../src/server/auth/adapter";
import { BASE, GOOD_PASSWORD, INVITATION_HEADER, directAuth, directBrowser, seedInvitation, uniqueEmail, workerBrowser, type Browser } from "./helpers/auth";
import { createFixture, type TestFixture } from "./helpers/fixture";
import { secretFromUri, totpCode } from "./helpers/totp";

/**
 * T007 / V01: Better Auth 1.7.7 + D1 が Workers(workerd)で動くことの確認。
 * ここは「ローカルのworkerd＋ローカルD1」の確認。実Cloudflare(staging)の確認は tests/live/auth-workers.test.ts と
 * docs/evidence/V01-auth.md（未実施の間は未完了と書く）。
 */
let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const signUp = (b: Browser, email: string, token?: string, password = GOOD_PASSWORD) =>
  b.json("POST", "/api/auth/sign-up/email", { email, password, name: "団員" }, token ? { [INVITATION_HEADER]: token } : {});

/** 招待を作り、本人のブラウザで登録まで進める（認証identityができ、セッションが付く） */
async function invitedAccount(b: Browser, person: "unlinked" | "member" = "unlinked") {
  const p = fx.units.a.people[person];
  const email = uniqueEmail(person);
  const token = await seedInvitation({ unitId: p.unitId, memberId: p.memberId!, email, createdBy: fx.units.a.people.admin.userId });
  const res = await signUp(b, email, token);
  return { email, token, res };
}

describe("認証ライブラリ (T007 / V01)", () => {
  it("auth_works_in_workers_without_public_signup", async () => {
    const worker = await workerBrowser();

    // 自由なsign-up: 招待tokenなし/別のメール宛tokenは登録できない
    const email = uniqueEmail("free");
    const publicSignup = await signUp(worker, email);
    expect(publicSignup.status).toBe(403);
    expect(JSON.stringify(publicSignup.data)).toContain("INVITATION_REQUIRED");
    const p = fx.units.a.people.unlinked;
    const tokenForOther = await seedInvitation({ unitId: p.unitId, memberId: p.memberId!, email: uniqueEmail("other"), createdBy: null, kind: "invite" });
    const wrongEmail = await signUp(worker, email, tokenForOther);
    expect(wrongEmail.status).toBe(403);
    // 招待されたメール宛でも、招待tokenを知らなければ登録できない（メールを知っているだけでは足りない）
    const invitedEmail = uniqueEmail("guess");
    const realToken = await seedInvitation({ unitId: p.unitId, memberId: p.memberId!, email: invitedEmail, createdBy: null });
    expect((await signUp(worker, invitedEmail)).status).toBe(403);
    expect((await signUp(worker, invitedEmail, "x".repeat(40))).status).toBe(403);
    expect(realToken.length).toBeGreaterThan(16);
    // 登録に失敗したので認証identityは作られていない
    const created = await env.DB.prepare("SELECT count(*) AS n FROM auth_users WHERE email = ?").bind(email).first<{ n: number }>();
    expect(created!.n).toBe(0);

    // 招待どおりの登録は通り、セッションが付く（HttpOnly）
    const invited = await invitedAccount(worker);
    expect(invited.res.status).toBe(200);
    const setCookie = invited.res.res.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    // ログイン → ログアウト → セッションは無い
    const { service } = directAuth();
    const browser = await directBrowser(service);
    const login = await browser.json("POST", "/api/auth/sign-in/email", { email: invited.email, password: GOOD_PASSWORD });
    expect(login.status).toBe(200);
    const session = await service.session(new Request(`${BASE}/x`, { headers: { cookie: browser.cookieHeader() } }));
    expect(session?.email).toBe(invited.email);
    const crossOriginMutation = await browser.json("POST", "/api/auth/sign-out", {}, { origin: "http://evil.example" });
    expect(crossOriginMutation.status).not.toBe(200);
    const stillIn = await service.session(new Request(`${BASE}/x`, { headers: { cookie: browser.cookieHeader() } }));
    expect(stillIn).not.toBeNull();
    const logout = await browser.json("POST", "/api/auth/sign-out", {});
    expect(logout.status).toBe(200);
    const afterLogoutSession = await service.session(new Request(`${BASE}/x`, { headers: { cookie: browser.cookieHeader() } }));

    expect(login.status).toBe(200);
    expect(publicSignup.status).not.toBe(200);
    expect(crossOriginMutation.status).not.toBe(200);
    expect(afterLogoutSession).toBeNull();
  });

  it("only_contracted_auth_endpoints_are_reachable_and_cross_origin_writes_are_refused", async () => {
    const worker = await workerBrowser();
    for (const [method, path] of [["POST", "/api/auth/update-user"], ["POST", "/api/auth/delete-user"], ["POST", "/api/auth/sign-in/social"], ["GET", "/api/auth/reset-password/abc"], ["POST", "/api/auth/change-email"]] as const) {
      const r = await worker.json(method, path, method === "POST" ? {} : undefined);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.res.headers.get("content-type")).toContain("application/json");
    }
    // 契約にある経路は届く（認証なしのget-sessionはnullを返す）
    expect((await worker.json("GET", "/api/auth/get-session")).status).toBe(200);
    // 他originからの変更要求は、認証経路でも業務APIでも 403
    const evilAuth = await worker.json("POST", "/api/auth/sign-in/email", { email: uniqueEmail("x"), password: "wrong-password-123" }, { origin: "http://evil.example" });
    expect(evilAuth.status).toBe(403);
    const evilBusiness = await worker.json("POST", "/api/v1/members", { displayName: "x", status: "active" }, { origin: "http://evil.example", "idempotency-key": "k1" });
    expect(evilBusiness.status).toBe(403);
    expect(JSON.stringify(evilBusiness.data)).toContain("cross_origin");
    const noOriginCrossSite = await worker.json("POST", "/api/v1/members", { displayName: "x", status: "active" }, { origin: "", "sec-fetch-site": "cross-site", "idempotency-key": "k2" });
    expect(noOriginCrossSite.status).toBe(403);
  });

  it("login_wrong_password_is_rejected_and_unknown_user_looks_the_same", async () => {
    const { service } = directAuth();
    const b = await directBrowser(service);
    const { email } = await invitedAccount(await workerBrowser());
    const wrong = await b.json("POST", "/api/auth/sign-in/email", { email, password: "wrong-password-123" });
    const unknown = await b.json("POST", "/api/auth/sign-in/email", { email: uniqueEmail("nobody"), password: "wrong-password-123" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(JSON.stringify(wrong.data)).toBe(JSON.stringify(unknown.data)); // 登録の有無を応答から推測させない
  });

  it("password_policy_and_hashed_storage", async () => {
    const worker = await workerBrowser();
    const p = fx.units.a.people.unlinked;
    const email = uniqueEmail("short");
    const token = await seedInvitation({ unitId: p.unitId, memberId: p.memberId!, email, createdBy: null });
    const short = await signUp(worker, email, token, "short-pw");
    expect(short.status).toBe(400);
    const ok = await signUp(worker, email, token);
    expect(ok.status).toBe(200);
    const acct = await env.DB.prepare(
      "SELECT a.password FROM auth_accounts a JOIN auth_users u ON u.id = a.user_id WHERE u.email = ?",
    ).bind(email).first<{ password: string }>();
    expect(acct!.password).not.toContain(GOOD_PASSWORD); // 平文で保存しない
    expect(acct!.password.length).toBeGreaterThan(40);
  });

  it("password_reset_token_is_hashed_one_time_and_revokes_old_sessions", async () => {
    const captured: { email: string; token: string }[] = [];
    const { service } = directAuth(captured);
    const worker = await workerBrowser();
    const { email } = await invitedAccount(worker);
    const device1 = await directBrowser(service);
    await device1.json("POST", "/api/auth/sign-in/email", { email, password: GOOD_PASSWORD });
    const has = (b: Browser) => service.session(new Request(`${BASE}/x`, { headers: { cookie: b.cookieHeader() } }));
    expect(await has(device1)).not.toBeNull();

    const reset = await device1.json("POST", "/api/auth/request-password-reset", { email });
    expect(reset.status).toBe(200);
    // 未登録メールでも同じ応答（登録の有無を漏らさない）
    const unknown = await device1.json("POST", "/api/auth/request-password-reset", { email: uniqueEmail("nobody") });
    expect(JSON.stringify(unknown.data)).toBe(JSON.stringify(reset.data));
    expect(captured).toHaveLength(1);
    const token = captured[0]!.token;
    // DBには再設定tokenを平文で置かない
    const leaked = await env.DB.prepare("SELECT count(*) AS n FROM auth_verifications WHERE identifier LIKE ?").bind(`%${token}%`).first<{ n: number }>();
    expect(leaked!.n).toBe(0);

    const newPassword = "another-strong-pass-2";
    const done = await device1.json("POST", "/api/auth/reset-password", { newPassword, token });
    expect(done.status).toBe(200);
    const reused = await device1.json("POST", "/api/auth/reset-password", { newPassword: "third-strong-pass-3", token });
    expect(reused.status).not.toBe(200); // 一回限り
    expect(await has(device1)).toBeNull(); // 旧セッションは失効

    const oldLogin = await (await directBrowser(service)).json("POST", "/api/auth/sign-in/email", { email, password: GOOD_PASSWORD });
    expect(oldLogin.status).toBe(401);
    const newLogin = await (await directBrowser(service)).json("POST", "/api/auth/sign-in/email", { email, password: newPassword });
    expect(newLogin.status).toBe(200);
  });

  it("totp_second_factor_and_one_time_backup_codes", async () => {
    const { service } = directAuth();
    const worker = await workerBrowser();
    const { email } = await invitedAccount(worker);

    const b1 = await directBrowser(service);
    await b1.json("POST", "/api/auth/sign-in/email", { email, password: GOOD_PASSWORD });
    // 有効化にはパスワードの再確認が要る。検証するまでは有効にならない
    const noPw = await b1.json("POST", "/api/auth/two-factor/enable", {});
    expect(noPw.status).toBe(400);
    const enable = await b1.json<{ totpURI: string; backupCodes: string[] }>("POST", "/api/auth/two-factor/enable", { password: GOOD_PASSWORD });
    expect(enable.status).toBe(200);
    const secret = secretFromUri(enable.data.totpURI);
    const codes = enable.data.backupCodes;
    expect(codes.length).toBe(8);
    const before = await env.DB.prepare("SELECT two_factor_enabled AS e FROM auth_users WHERE email = ?").bind(email).first<{ e: number }>();
    expect(Boolean(before!.e)).toBe(false);
    expect((await b1.json("POST", "/api/auth/two-factor/verify-totp", { code: "000000" })).status).toBe(401);
    expect((await b1.json("POST", "/api/auth/two-factor/verify-totp", { code: await totpCode(secret) })).status).toBe(200);
    const after = await env.DB.prepare("SELECT two_factor_enabled AS e FROM auth_users WHERE email = ?").bind(email).first<{ e: number }>();
    expect(Boolean(after!.e)).toBe(true);
    // 回復コードは平文で保存されない
    const stored = await env.DB.prepare("SELECT t.backup_codes AS c FROM auth_two_factors t JOIN auth_users u ON u.id = t.user_id WHERE u.email = ?").bind(email).first<{ c: string }>();
    for (const code of codes) expect(stored!.c).not.toContain(code);

    // 別の端末でログイン: パスワードだけではセッションにならない
    const b2 = await directBrowser(service);
    const login = await b2.json<{ twoFactorRedirect?: boolean }>("POST", "/api/auth/sign-in/email", { email, password: GOOD_PASSWORD });
    expect(login.data.twoFactorRedirect).toBe(true);
    const sessionOf = (b: Browser) => service.session(new Request(`${BASE}/x`, { headers: { cookie: b.cookieHeader() } }));
    expect(await sessionOf(b2)).toBeNull();
    // 回復コードで入れる。同じ回復コードの再利用は拒否
    const used = await b2.json("POST", "/api/auth/two-factor/verify-backup-code", { code: codes[0] });
    expect(used.status).toBe(200);
    expect((await sessionOf(b2))?.twoFactorEnabled).toBe(true);

    const b3 = await directBrowser(service);
    await b3.json("POST", "/api/auth/sign-in/email", { email, password: GOOD_PASSWORD });
    const reused = await b3.json("POST", "/api/auth/two-factor/verify-backup-code", { code: codes[0] });
    expect(reused.status).not.toBe(200);
    expect(await sessionOf(b3)).toBeNull();
    // 未使用のコードは使える
    const b4 = await directBrowser(service);
    await b4.json("POST", "/api/auth/sign-in/email", { email, password: GOOD_PASSWORD });
    expect((await b4.json("POST", "/api/auth/two-factor/verify-backup-code", { code: codes[1] })).status).toBe(200);
  });

  it("mfa_cannot_be_turned_off_or_bypassed_and_enabling_it_revokes_older_sessions", async () => {
    const { service } = directAuth();
    const worker = await workerBrowser();
    const { email } = await invitedAccount(worker);
    const sessionOf = (b: Browser) => service.session(new Request(`${BASE}/x`, { headers: { cookie: b.cookieHeader() } }));
    // MFA設定前に別端末(パスワードだけ)でログインしていたセッション
    const old = await directBrowser(service);
    await old.json("POST", "/api/auth/sign-in/email", { email, password: GOOD_PASSWORD });
    const b1 = await directBrowser(service);
    await b1.json("POST", "/api/auth/sign-in/email", { email, password: GOOD_PASSWORD });
    const enable = await b1.json<{ totpURI: string; backupCodes: string[] }>("POST", "/api/auth/two-factor/enable", { password: GOOD_PASSWORD });
    const secret = secretFromUri(enable.data.totpURI);
    // 信頼端末(30日間コード不要)の要求は受け付けない
    const trust = await b1.json("POST", "/api/auth/two-factor/verify-totp", { code: await totpCode(secret), trustDevice: true });
    expect(trust.status).toBe(400);
    expect((await b1.json("POST", "/api/auth/two-factor/verify-totp", { code: await totpCode(secret) })).status).toBe(200);
    // 有効化を確定したら、それ以前に作られた他のセッションは失効する（パスワードだけで作られたセッションを残さない）
    expect(await sessionOf(old)).toBeNull();
    expect(await sessionOf(b1)).not.toBeNull();
  });

  it("verify_totp_only_revokes_other_sessions_when_it_actually_enables_mfa", async () => {
    const { service } = directAuth();
    const worker = await workerBrowser();
    const { email } = await invitedAccount(worker);
    const sessionOf = (b: Browser) => service.session(new Request(`${BASE}/x`, { headers: { cookie: b.cookieHeader() } }));
    const a = await directBrowser(service);
    await a.json("POST", "/api/auth/sign-in/email", { email, password: GOOD_PASSWORD });
    const enable = await a.json<{ totpURI: string }>("POST", "/api/auth/two-factor/enable", { password: GOOD_PASSWORD });
    const secret = secretFromUri(enable.data.totpURI);
    // 有効化の確定前に、誤ったコードを送っても、他のセッションは消えない
    const other = await directBrowser(service);
    await other.json("POST", "/api/auth/sign-in/email", { email, password: GOOD_PASSWORD });
    expect((await a.json("POST", "/api/auth/two-factor/verify-totp", { code: "000000" })).status).toBe(401);
    expect(await sessionOf(other)).not.toBeNull();
    expect((await a.json("POST", "/api/auth/two-factor/verify-totp", { code: await totpCode(secret) })).status).toBe(200);
    expect(await sessionOf(other)).toBeNull(); // 有効化の確定では、旧セッションが消える
    // 有効化済みの利用者が、ログイン中に誤ったコード/正しいコードで呼んでも、他端末を巻き込まない（強制ログアウトの経路にしない）
    const second = await directBrowser(service);
    await second.json("POST", "/api/auth/sign-in/email", { email, password: GOOD_PASSWORD });
    await second.json("POST", "/api/auth/two-factor/verify-totp", { code: await totpCode(secret, Date.now(), -1) }); // 二要素のログイン確認
    expect(await sessionOf(second)).not.toBeNull();
    expect((await a.json("POST", "/api/auth/two-factor/verify-totp", { code: "000000" })).status).toBe(401);
    expect(await sessionOf(second)).not.toBeNull();
    expect(await sessionOf(a)).not.toBeNull();
  });

  it("mfa_management_endpoints_require_the_password_and_there_is_no_disable_path", async () => {
    const worker = await workerBrowser();
    const p = fx.units.a.people.unlinked;
    const email = uniqueEmail("mfa-ep");
    const token = await seedInvitation({ unitId: p.unitId, memberId: p.memberId!, email, createdBy: null });
    expect((await signUp(worker, email, token)).status).toBe(200);
    // 二要素の解除は公開しない（契約外 → 404）。回復コードの再発行・URI再表示はパスワードの再確認が要る
    expect((await worker.json("POST", "/api/auth/two-factor/disable", { password: GOOD_PASSWORD })).status).toBe(404);
    expect((await worker.json("POST", "/api/auth/two-factor/get-totp-uri", {})).status).toBe(400);
    const enable = await worker.json<{ totpURI: string; backupCodes: string[] }>("POST", "/api/auth/two-factor/enable", { password: GOOD_PASSWORD });
    expect((await worker.json("POST", "/api/auth/two-factor/verify-totp", { code: await totpCode(secretFromUri(enable.data.totpURI)) })).status).toBe(200);
    expect((await worker.json("POST", "/api/auth/two-factor/generate-backup-codes", {})).status).toBe(400); // 有効化後でも、パスワード無しは拒否
    expect((await worker.json("POST", "/api/auth/two-factor/get-totp-uri", {})).status).toBe(400);
    const wrongPw = await worker.json<{ code?: string }>("POST", "/api/auth/two-factor/generate-backup-codes", { password: "wrong-password-123" });
    expect(wrongPw.status).toBe(400);
    expect(wrongPw.data.code).toBe("INVALID_PASSWORD");
    // 再発行すると旧い回復コードは使えない
    const regen = await worker.json<{ backupCodes: string[] }>("POST", "/api/auth/two-factor/generate-backup-codes", { password: GOOD_PASSWORD });
    expect(regen.status).toBe(200);
    const { service } = directAuth();
    const other = await directBrowser(service);
    await other.json("POST", "/api/auth/sign-in/email", { email, password: GOOD_PASSWORD });
    expect((await other.json("POST", "/api/auth/two-factor/verify-backup-code", { code: enable.data.backupCodes[0] })).status).not.toBe(200);
    expect((await other.json("POST", "/api/auth/two-factor/verify-backup-code", { code: regen.data.backupCodes[0] })).status).toBe(200);
  });

  it("revoke_all_deletes_every_session_of_the_identity", async () => {
    const { service } = directAuth();
    const { email } = await invitedAccount(await workerBrowser());
    const devices = [await directBrowser(service), await directBrowser(service)];
    for (const d of devices) await d.json("POST", "/api/auth/sign-in/email", { email, password: GOOD_PASSWORD });
    const sess = (b: Browser) => service.session(new Request(`${BASE}/x`, { headers: { cookie: b.cookieHeader() } }));
    const identity = await sess(devices[0]!);
    expect(identity).not.toBeNull();
    expect(await sess(devices[1]!)).not.toBeNull();
    await service.revokeAll(identity!.authId);
    expect(await sess(devices[0]!)).toBeNull();
    expect(await sess(devices[1]!)).toBeNull();
  });

  it("sign_in_is_rate_limited_per_ip_in_d1", async () => {
    const { service } = directAuth();
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const b = await directBrowser(service, ip);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await b.json("POST", "/api/auth/sign-in/email", { email: uniqueEmail("x"), password: "wrong-password-123" })).status);
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
    const row = await env.DB.prepare("SELECT count(*) AS n FROM auth_rate_limits").first<{ n: number }>();
    expect(row!.n).toBeGreaterThan(0);
  });

  it("measures_password_hash_cost_for_v01", async () => {
    const { service } = directAuth();
    const p = fx.units.a.people.unlinked;
    const email = uniqueEmail("cost");
    const token = await seedInvitation({ unitId: p.unitId, memberId: p.memberId!, email, createdBy: null });
    const b = await directBrowser(service);
    const t0 = performance.now();
    const up = await signUp(b, email, token);
    const signUpMs = performance.now() - t0;
    expect(up.status).toBe(200);
    const b2 = await directBrowser(service);
    const t1 = performance.now();
    const login = await b2.json("POST", "/api/auth/sign-in/email", { email, password: GOOD_PASSWORD });
    const loginMs = performance.now() - t1;
    expect(login.status).toBe(200);
    // 実CPU時間は実Workersでしか測れない（ローカルworkerdの壁時計は目安）。値は docs/evidence/V01-auth.md に記録する
    console.log(JSON.stringify({ v01: "ローカルworkerdの壁時計(ms)", signUpMs: Math.round(signUpMs), loginMs: Math.round(loginMs) }));
    expect(loginMs).toBeLessThan(5000);
  });

  it("https_environments_issue_secure_httponly_samesite_cookies", async () => {
    // staging/production相当の設定（https）。局所のhttp試験では確認できないSecure属性を、設定の段階で確認する
    const origin = "https://fireos-staging.example.invalid";
    const service = createAuthService({ DB: env.DB, APP_ENV: "staging", BETTER_AUTH_SECRET: "s".repeat(40), AUTH_BASE_URL: origin });
    const p = fx.units.a.people.unlinked;
    const email = uniqueEmail("secure");
    const token = await seedInvitation({ unitId: p.unitId, memberId: p.memberId!, email, createdBy: null });
    const res = await service.handle(new Request(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", [INVITATION_HEADER]: token, "cf-connecting-ip": "203.0.113.77" },
      body: JSON.stringify({ email, password: GOOD_PASSWORD, name: "団員" }),
    }));
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().join("\n");
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/__Secure-fireos/); // https では __Secure- 接頭辞つき
    // http の origin からの要求（別のorigin扱い）は拒否される
    const bad = await service.handle(new Request(`${origin}/api/auth/sign-out`, { method: "POST", headers: { origin: "http://fireos-staging.example.invalid", cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), "content-type": "application/json" }, body: "{}" }));
    expect(bad.status).toBe(403);
  });

  it("auth_env_misconfiguration_is_rejected_at_startup", () => {
    const base = { DB: env.DB, APP_ENV: "production" as const, BETTER_AUTH_SECRET: "x".repeat(40), AUTH_BASE_URL: "https://fireos.example.invalid" };
    expect(() => assertAuthEnv(base)).not.toThrow();
    expect(() => assertAuthEnv({ ...base, BETTER_AUTH_SECRET: "short" })).toThrow(/32文字/);
    expect(() => assertAuthEnv({ ...base, BETTER_AUTH_SECRET: "dev-only-" + "y".repeat(40) })).toThrow(/開発用/);
    expect(() => assertAuthEnv({ ...base, AUTH_BASE_URL: "http://fireos.example.invalid" })).toThrow(/https/);
    expect(() => assertAuthEnv({ ...base, APP_ENV: "local", BETTER_AUTH_SECRET: "dev-only-" + "y".repeat(40), AUTH_BASE_URL: "http://localhost:8787" })).not.toThrow();
    expect(() => createAuthService({ ...base, BETTER_AUTH_SECRET: "" })).toThrow();
  });
});
