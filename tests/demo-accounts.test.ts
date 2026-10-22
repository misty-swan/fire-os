import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { DEMO_SEED_IDS, parseDemoSeedArgs, seedDemo } from "../scripts/seed-demo";
import { DEMO_ACCOUNTS, demoAccountStatements, generateDemoPassword, type DemoCredential } from "../src/server/auth/demo-accounts";
import { workerBrowser } from "./helpers/auth";

/**
 * 体験アカウント3本（営業デモTask4。固定資格情報・パスワードだけのログイン・MFAなし）。
 *
 * - 3役割（admin/officer/member）の団員行＋認証identity（auth_users/auth_accounts）＋監査をseedが作る。
 *   **ハッシュ方式の一致は機械保証**する: 投入したパスワードで実際のログインAPI（/api/auth/sign-in/email）を
 *   通す＝better-authのverifyPasswordが検証できる形式でしか200にならない（手書きの暗号実装は試験が落ちる）。
 * - 規則不変の固定: admin体験アカウントも二要素は未有効のままなので、PER-07の操作（API-33招待発行）は
 *   実認可経路（resolvePrincipal → authorize）で `mfa_required` で拒否される（PER-06/07/08の二要素必須を変えない）。
 * - 架空検査準拠: メールは全部 @example.test、氏名は「架空」付き（実データ混入の入口を作らない）。
 * - 適用は実デモと同じ順: migration → 架空データseed（seedDemo＝実デモのunit/団員/役割の土台）→
 *   demoAccountStatements をD1 batchで適用。CLI（scripts/seed-demo.ts）は同じ純関数をSQLへ直列化して使う。
 */

/** 試験専用の固定パスワード（better-authの下限12以上。本物の資格情報はseed実行時に生成され一度だけ表示される） */
const TEST_PASSWORD = "demo-hands-on-pass-1";

/** 資格情報は正本（DEMO_ACCOUNTS）の3件に試験用パスワードを合わせただけ */
const credentials: DemoCredential[] = DEMO_ACCOUNTS.map((a) => ({ email: a.email, memberName: a.memberName, role: a.role, password: TEST_PASSWORD }));

const signIn = async (email: string, password = TEST_PASSWORD) => {
  const b = await workerBrowser();
  const res = await b.json("POST", "/api/auth/sign-in/email", { email, password });
  return { b, res };
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // 実デモと同じ土台（宮之浦分団・団員・役割）を作ってから、体験アカウントの文を適用する
  await seedDemo(env);
  const stmts = await demoAccountStatements({ unitId: DEMO_SEED_IDS.unit, now: new Date(), credentials });
  await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.binds)));
});

describe("体験アカウント3本（営業デモTask4）", () => {
  it("generated_passwords_are_16_plus_unambiguous_characters", () => {
    const a = generateDemoPassword();
    expect(a.length).toBeGreaterThanOrEqual(16);
    expect(a).toMatch(/^[A-Za-z0-9]+$/); // 紛らわしい記号を含まない（口頭で伝えられる資格情報）
    expect(generateDemoPassword()).not.toBe(a); // 実行ごとに新しく生成する
  });

  it("all_three_accounts_sign_in_through_the_real_endpoint_and_get_a_session", async () => {
    for (const c of credentials) {
      const { b, res } = await signIn(c.email);
      expect(res.status, `${c.email} のログイン`).toBe(200);
      // パスワード検証を通ったセッションが、実認可経路（resolvePrincipal）でも業務利用者として解決される
      const me = await b.json<{ data?: { roles?: string[] } }>("GET", "/api/v1/me");
      expect(me.status, `${c.email} のセッション`).toBe(200);
      expect(me.data.data?.roles).toEqual([c.role]);
    }
  });

  it("wrong_password_is_rejected_the_same_way_as_unknown_users", async () => {
    const wrong = await signIn(DEMO_ACCOUNTS[0]!.email, "wrong-password-123");
    expect(wrong.res.status).toBe(401);
  });

  it("admin_without_mfa_is_denied_mfa_required_on_a_per07_operation", async () => {
    // 3アカウントとも二要素は未有効のまま（MFA無しで作る。解除経路は公開しないため後から変えられない）
    for (const c of credentials) {
      const row = await env.DB.prepare("SELECT two_factor_enabled AS e FROM auth_users WHERE email = ?").bind(c.email).first<{ e: number }>();
      expect(row!.e, c.email).toBe(0);
    }
    // adminでPER-07（API-33招待発行）を呼ぶと、実認可経路で mfa_required で拒否される（規則不変の固定）
    const { b } = await signIn(DEMO_ACCOUNTS[0]!.email);
    const denied = await b.json<{ error?: { details?: { field?: string; reason?: string }[] } }>("POST", "/api/v1/invitations", {
      memberId: DEMO_ACCOUNTS[2]!.ids.member,
      email: "invitee@example.test",
      expiresInHours: 24,
    }, { "idempotency-key": crypto.randomUUID() });
    expect(denied.status).toBe(403);
    expect(denied.data.error?.details?.[0]?.reason).toBe("mfa_required");
  });

  it("demo_admin_cannot_enable_two_factor_or_change_password", async () => {
    // T091-S1: 共有パスワードの体験アカウントが二要素を自己登録すると mfa_required が外れ、他の訪問者を締め出せた
    const { b } = await signIn(DEMO_ACCOUNTS[0]!.email);
    const enable = await b.json<{ code?: string }>("POST", "/api/auth/two-factor/enable", { password: TEST_PASSWORD });
    expect(enable.status).toBe(403);
    expect(enable.data.code).toBe("DEMO_ACCOUNT_LOCKED");
    const verify = await b.json("POST", "/api/auth/two-factor/verify-totp", { code: "000000" });
    expect(verify.status).toBe(403);
    const change = await b.json("POST", "/api/auth/change-password", { currentPassword: TEST_PASSWORD, newPassword: "another-pass-12345" });
    expect(change.status).toBe(403);
    // two_factor_enabled は 0 のまま、API-33 は引き続き mfa_required
    const row = await env.DB.prepare("SELECT two_factor_enabled AS e FROM auth_users WHERE email = ?").bind(DEMO_ACCOUNTS[0]!.email).first<{ e: number }>();
    expect(row!.e).toBe(0);
    const inv = await b.json<{ error?: { details?: { reason?: string }[] } }>("POST", "/api/v1/invitations", {
      memberId: DEMO_ACCOUNTS[2]!.ids.member,
      email: "invitee2@example.test",
      expiresInHours: 24,
    }, { "idempotency-key": crypto.randomUUID() });
    expect(inv.status).toBe(403);
    expect(inv.data.error?.details?.[0]?.reason).toBe("mfa_required");
    // パスワードも変わらず、同じ資格情報で再サインインできる
    expect((await signIn(DEMO_ACCOUNTS[0]!.email)).res.status).toBe(200);
  });

  it("member_account_creates_roster_role_and_audit_rows", async () => {
    const m = DEMO_ACCOUNTS[2]!;
    const row = await env.DB.prepare(
      "SELECT m.display_name, m.rank, u.auth_id, a.email FROM members m JOIN users u ON u.id = m.user_id JOIN auth_users a ON a.id = u.auth_id WHERE m.id = ?",
    ).bind(m.ids.member).first<{ display_name: string; rank: string; auth_id: string; email: string }>();
    expect(row).not.toBeNull();
    expect(row!.display_name).toContain("架空"); // fixtures作法（実在の人物に読めない）
    expect(row!.rank).toBe("団員");
    expect(row!.email).toBe(m.email);
    // 役割はroles表の実IDで付く（member）。admin/officerも同様に1役割ずつ
    const roles = await env.DB.prepare(
      "SELECT r.code FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.member_id = ? AND mr.revoked_at IS NULL",
    ).bind(m.ids.member).all<{ code: string }>();
    expect(roles.results.map((r) => r.code)).toEqual(["member"]);
    // 監査（system主体）に作成が残る。メール・パスワードは載せない
    const audit = await env.DB.prepare(
      "SELECT actor_kind, action, metadata_json FROM audit_logs WHERE action = 'demo.account_created' AND entity_id = ?",
    ).bind(m.ids.member).all<{ actor_kind: string; action: string; metadata_json: string }>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0]!.actor_kind).toBe("system");
    expect(audit.results[0]!.metadata_json).not.toContain(TEST_PASSWORD);
    expect(audit.results[0]!.metadata_json).not.toContain(m.email);
  });

  it("all_account_emails_stay_on_the_example_test_domain", async () => {
    for (const a of DEMO_ACCOUNTS) expect(a.email.endsWith("@example.test"), a.email).toBe(true);
    const rows = await env.DB.prepare(
      `SELECT email FROM auth_users WHERE id IN (${DEMO_ACCOUNTS.map(() => "?").join(", ")})`,
    ).bind(...DEMO_ACCOUNTS.map((a) => a.ids.authUser)).all<{ email: string }>();
    expect(rows.results).toHaveLength(DEMO_ACCOUNTS.length);
    for (const r of rows.results) expect(r.email.endsWith("@example.test"), r.email).toBe(true);
  });
});

describe("seed-demo CLIの引数解析（parseDemoSeedArgs。純関数）", () => {
  it("demo_password_flag_without_a_value_is_a_usage_error_not_silent_random_generation", () => {
    const parsed = parseDemoSeedArgs(["--persist-to", ".wrangler/demo", "--demo-password"]);
    if (!("usageError" in parsed)) throw new Error("値なしの--demo-passwordは拒否されるべき");
    expect(parsed.usageError).toContain("--demo-password <値>"); // 正しい使い方を案内する
  });

  it("short_password_and_missing_persist_stay_usage_errors", () => {
    const short = parseDemoSeedArgs(["--persist-to", ".wrangler/demo", "--demo-password", "short"]);
    if (!("usageError" in short)) throw new Error("12文字未満は拒否されるべき");
    expect(short.usageError).toContain("12文字以上");
    const noPersist = parseDemoSeedArgs(["--demo-password", "long-enough-password"]);
    if (!("usageError" in noPersist)) throw new Error("--persist-to無しは使い方の誤りになるべき");
    expect(noPersist.usageError).toContain("使い方:");
  });

  it("valid_args_parse_to_persist_and_fixed_password_and_omitting_the_flag_stays_random", () => {
    const fixed = parseDemoSeedArgs(["--persist-to", ".wrangler/demo", "--demo-password", TEST_PASSWORD]);
    if (!("persist" in fixed)) throw new Error("正常な引数は使い方の誤りになってはいけない"); // --remote経路（remoteDemo）でないことの絞り込みも兼ねる
    expect(fixed.persist).toBe(".wrangler/demo");
    expect(fixed.fixedDemoPassword).toBe(TEST_PASSWORD);
    const random = parseDemoSeedArgs(["--persist-to", ".wrangler/demo"]);
    if ("usageError" in random) throw new Error("--demo-password省略は普通に通るべき");
    expect(random.fixedDemoPassword).toBeUndefined(); // ランダム生成へ落ちる（既定の経路）
  });
});
