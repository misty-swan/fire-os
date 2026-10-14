import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { PERMISSION_CODES, POLICY_VERSION, authorize, filterAuthorized, type PermissionCode, type ResourceRef, type RoleCode } from "../src/server/auth/authorize";
import { resolvePrincipal, type AuthzPrincipal } from "../src/server/auth/principal";
import type { AppBindings } from "../src/server/env";
import { HttpError, onError } from "../src/server/http";
import { createApp } from "../src/server/index";
import { loginAs } from "./helpers/auth";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

/** resolvePrincipal を本物の経路で呼ぶ小さなアプリ（x-test-identity か Cookie） */
const probe = new Hono<AppBindings>();
probe.get("/p", async (c) => c.json(await resolvePrincipal(c)));
probe.onError(onError);
const principalOf = async (identity: Identity): Promise<AuthzPrincipal> => {
  const res = await probe.fetch(new Request("http://example.com/p", { headers: { "x-test-identity": JSON.stringify(identity) } }), env);
  expect(res.status).toBe(200);
  return (await res.json()) as AuthzPrincipal;
};

const ROLE_PERSON: Record<RoleCode, "member" | "operator" | "officer" | "admin"> = { member: "member", operator: "operator", officer: "officer", admin: "admin" };

/**
 * 期待表（docs/10 の○/△を「最小権限の既定」で実行可能にしたもの。実装の RULES を写さず、ここに独立に書く）。
 * 列は [担当内, 担当外, 本人の対象, 別unit]。Y=許可 -=拒否。operator が担当を持つのは PER-03/04 の担当内だけ（fixture）。
 */
const EXPECTED: Record<PermissionCode, Record<RoleCode, string>> = {
  "PER-01": { member: "YYY-", operator: "YYY-", officer: "YYY-", admin: "YYY-" },
  "PER-02": { member: "--Y-", operator: "--Y-", officer: "--Y-", admin: "--Y-" },
  "PER-03": { member: "----", operator: "Y---", officer: "YYY-", admin: "YYY-" },
  "PER-04": { member: "--Y-", operator: "Y---", officer: "YYY-", admin: "YYY-" },
  "PER-05": { member: "----", operator: "----", officer: "YYY-", admin: "YYY-" },
  "PER-06": { member: "----", operator: "----", officer: "----", admin: "----" }, // 型が 'facility' のとき。名簿の型は別の試験
  "PER-07": { member: "----", operator: "----", officer: "----", admin: "YYY-" },
  "PER-08": { member: "----", operator: "----", officer: "----", admin: "YYY-" },
  "PER-09": { member: "--Y-", operator: "----", officer: "YYY-", admin: "YYY-" },
  "PER-10": { member: "----", operator: "----", officer: "YYY-", admin: "YYY-" },
  "PER-11": { member: "YYY-", operator: "YYY-", officer: "YYY-", admin: "YYY-" },
  "PER-12": { member: "--Y-", operator: "----", officer: "YYY-", admin: "YYY-" },
  "PER-13": { member: "YYY-", operator: "YYY-", officer: "YYY-", admin: "YYY-" },
  "PER-14": { member: "----", operator: "----", officer: "YYY-", admin: "YYY-" },
};

function contexts(p: AuthzPrincipal): ResourceRef[] {
  const other = fx.units.a.people.suspended.memberId!; // 他人の対象
  const a = fx.units.a;
  return [
    { unitId: a.id, type: "facility", id: a.scopeIn.entityId, ownerMemberId: other },
    { unitId: a.id, type: "facility", id: a.scopeOut.entityId, ownerMemberId: other },
    { unitId: a.id, type: "facility", id: crypto.randomUUID(), ownerMemberId: p.memberId },
    { unitId: fx.units.b.id, type: "facility", id: a.scopeIn.entityId, ownerMemberId: other },
  ];
}

describe("認可 (T008)", () => {
  it("admin_role_does_not_bypass_sensitive_scope", async () => {
    // 1) PER-01〜14 × 4役割 × (担当内/担当外/本人/別unit) の許可・拒否表が期待どおり
    const mismatches: string[] = [];
    for (const role of ["member", "operator", "officer", "admin"] as const) {
      const p = await principalOf(fx.units.a.people[ROLE_PERSON[role]]);
      expect(p.roles).toEqual([role]);
      for (const code of PERMISSION_CODES) {
        const got = contexts(p).map((t) => (authorize(p, code, t).allowed ? "Y" : "-")).join("");
        if (got !== EXPECTED[code][role]) mismatches.push(`${role} ${code}: 期待 ${EXPECTED[code][role]} / 実際 ${got}`);
      }
    }
    expect(mismatches).toEqual([]);

    // 2) 担当外の行は一覧に残らない（絞り込みはサーバー側）
    const operator = await principalOf(fx.units.a.people.operator);
    const candidates = [fx.units.a.scopeIn, fx.units.a.scopeOut].map((s) => ({ unitId: fx.units.a.id, type: s.entityType, id: s.entityId }));
    const visible = filterAuthorized(operator, "PER-03", candidates).map((r) => r.id);
    const outOfScopeRows = visible.filter((id) => id === fx.units.a.scopeOut.entityId);
    expect(visible).toEqual([fx.units.a.scopeIn.entityId]);

    // 3) 管理者でも、他人の名簿の許可列は開かない。本人と、その団員を対象にした担当を持つ者だけ
    const admin = await principalOf(fx.units.a.people.admin);
    const target = fx.units.a.people.member;
    const privateOf = (p: AuthzPrincipal, m: Identity): ResourceRef => ({ unitId: m.unitId, type: "member_private", id: m.memberId!, ownerMemberId: m.memberId! });
    expect(authorize(admin, "PER-06", privateOf(admin, target)).allowed).toBe(false);
    expect(authorize(admin, "PER-06", privateOf(admin, fx.units.a.people.admin)).allowed).toBe(true); // 本人
    // 名簿の基本項目(氏名・役職・状態)の登録/変更は管理者
    expect(authorize(admin, "PER-06", { unitId: admin.unitId, type: "member", id: target.memberId! }).allowed).toBe(true);
    const officer = await principalOf(fx.units.a.people.officer);
    expect(authorize(officer, "PER-06", { unitId: admin.unitId, type: "member", id: target.memberId! }).allowed).toBe(false);
    // 担当(scope)を明示すると、その団員の許可列だけ開く
    await env.DB.prepare(
      "INSERT INTO scope_assignments (id, unit_id, member_id, entity_type, entity_id, permissions, created_at, updated_at, created_by, actor_kind) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).bind(crypto.randomUUID(), admin.unitId, admin.memberId, "member", target.memberId, '["PER-06"]', "2026-10-13T00:00:00.000Z", "2026-10-13T00:00:00.000Z", admin.userId, "human").run();
    const adminWithScope = await principalOf(fx.units.a.people.admin);
    expect(authorize(adminWithScope, "PER-06", privateOf(adminWithScope, target)).allowed).toBe(true);
    expect(authorize(adminWithScope, "PER-06", privateOf(adminWithScope, fx.units.a.people.operator)).allowed).toBe(false);

    // 4) API-01 が返す列は契約どおりで、内部の列（authId/メール/hash）を含まない
    const me = await fx.client(fx.units.a.people.member).request("GET", "/api/v1/me");
    const body = (await me.json()) as { data: Record<string, unknown> };
    const privateFieldNames = Object.keys(body.data).filter((k) => !["profile", "unitName", "roles", "authzVersion", "policyVersion", "mfaEnabled", "mfaRequired"].includes(k));
    expect(JSON.stringify(body)).not.toMatch(/authId|auth_id|email|password|token/i);

    // 5) ログイン後に停止すると、次の要求から 401（Cookieは有効でも業務は拒否）
    const session = await loginAs(fx.units.a.people.member);
    const before = await session.json("GET", "/api/v1/me");
    expect(before.status).toBe(200);
    await env.DB.prepare("UPDATE users SET status = 'disabled', disabled_at = ?, authz_version = authz_version + 1 WHERE id = ?")
      .bind("2026-10-13T01:00:00.000Z", fx.units.a.people.member.userId).run();
    const afterDisable = await session.json("GET", "/api/v1/me");

    // 6) 要求の自己申告（query/ヘッダー）の unitId は受け付けない
    // /me は入力を取らないので、契約外のunitIdは400（理由 unknown_field）。変更系の本文に unitId を足しても同じく拒否され、何も作られない
    const claim = await fx.client(fx.units.a.people.admin).request("GET", `/api/v1/me?unitId=${fx.units.b.id}`);
    expect(((await claim.json()) as { error: { code: string; details: { reason: string }[] } }).error).toMatchObject({ code: "VALIDATION_ERROR", details: [{ reason: "unknown_field" }] });
    const bodyClaim = await fx.client(fx.units.a.people.admin).request("POST", "/api/v1/members", { displayName: "x", status: "active", unitId: fx.units.b.id }, { "idempotency-key": crypto.randomUUID() });
    expect(bodyClaim.status).toBe(400);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM members WHERE unit_id = ? AND display_name = 'x'").bind(fx.units.b.id).first<{ n: number }>())!.n).toBe(0);
    const clientSuppliedUnitAccepted = claim.status === 200 || bodyClaim.status === 201;
    const header = await fx.client(fx.units.a.people.admin).request("GET", "/api/v1/me", undefined, { "x-unit-id": fx.units.b.id, "x-role": "admin" });
    expect(((await header.json()) as { data: { unitName: string } }).data.unitName).toBe("架空市 第一分団");

    expect(outOfScopeRows).toEqual([]);
    expect(privateFieldNames).toEqual([]);
    expect(afterDisable.status).toBe(401);
    expect(clientSuppliedUnitAccepted).toBe(false);
  });

  it("admin_actions_require_mfa", async () => {
    const admin = await principalOf(fx.units.a.people.admin);
    const ref = { unitId: admin.unitId, type: "member", id: crypto.randomUUID() };
    expect(authorize(admin, "PER-07", ref).allowed).toBe(true);
    expect(authorize({ ...admin, mfaEnabled: false }, "PER-07", ref)).toEqual({ allowed: false, reason: "mfa_required" });
    expect(authorize({ ...admin, mfaEnabled: false }, "PER-08", ref)).toEqual({ allowed: false, reason: "mfa_required" });
    // 名簿の登録・変更（管理者の操作）も二要素が済むまで拒否。本人の許可列の編集は管理者操作ではないので対象外
    expect(authorize({ ...admin, mfaEnabled: false }, "PER-06", { unitId: admin.unitId, type: "member", id: ref.id })).toEqual({ allowed: false, reason: "mfa_required" });
    expect(authorize({ ...admin, mfaEnabled: false }, "PER-06", { unitId: admin.unitId, type: "member_private", id: admin.memberId, ownerMemberId: admin.memberId }).allowed).toBe(true);
    // 二要素が要らない操作は影響を受けない
    expect(authorize({ ...admin, mfaEnabled: false }, "PER-01", ref).allowed).toBe(true);
  });

  it("revoked_role_scope_and_status_changes_apply_on_the_next_request_without_version_bump", async () => {
    const f2 = await createFixture("two-units"); // この試験専用の分団（他の試験の状態を壊さない）
    const op = f2.units.a.people.operator;
    const read = async (id: Identity) => (await probe.fetch(new Request("http://example.com/p", { headers: { "x-test-identity": JSON.stringify(id) } }), env));
    const before = (await (await read(op)).json()) as AuthzPrincipal;
    expect(before.scopes).toHaveLength(1);
    expect(before.roles).toEqual(["operator"]);

    // 認可版を変えずに担当を取り消す／期限切れにする → 次の要求から効く
    await env.DB.prepare("UPDATE scope_assignments SET revoked_at = ? WHERE member_id = ?").bind("2026-10-13T00:30:00.000Z", op.memberId).run();
    expect(((await (await read(op)).json()) as AuthzPrincipal).scopes).toEqual([]);
    await env.DB.prepare("UPDATE scope_assignments SET revoked_at = NULL, expires_at = ? WHERE member_id = ?").bind("2020-01-01T00:00:00.000Z", op.memberId).run();
    expect(((await (await read(op)).json()) as AuthzPrincipal).scopes).toEqual([]);

    await env.DB.prepare("UPDATE member_roles SET revoked_at = ? WHERE member_id = ?").bind("2026-10-13T00:30:00.000Z", op.memberId).run();
    const afterRole = (await (await read(op)).json()) as AuthzPrincipal;
    expect(afterRole.roles).toEqual([]);
    expect(afterRole.authzVersion).toBe(before.authzVersion); // 版は変わっていないのに反映される
    // 役割が無ければ、担当(scope)があっても何もできない
    expect(authorize(afterRole, "PER-03", { unitId: afterRole.unitId, type: "facility", id: f2.units.a.scopeIn.entityId }).allowed).toBe(false);

    // 団員の休団・退団、分団の停止も次の要求から 401
    for (const status of ["paused", "retired"]) {
      await env.DB.prepare("UPDATE members SET status = ? WHERE id = ?").bind(status, op.memberId).run();
      expect((await read(op)).status).toBe(401);
    }
    await env.DB.prepare("UPDATE members SET status = 'active' WHERE id = ?").bind(op.memberId).run();
    await env.DB.prepare("UPDATE units SET status = 'disabled' WHERE id = ?").bind(op.unitId).run();
    expect((await read(op)).status).toBe(401);
    await env.DB.prepare("UPDATE units SET status = 'active' WHERE id = ?").bind(op.unitId).run();
    expect((await read(op)).status).toBe(200);
  });

  it("unlinked_identity_and_forged_test_header_never_get_business_access", async () => {
    // 招待を受領していない認証identity（団員にリンクされていない）は、セッションが有効でも業務アクセスなし
    const p = fx.units.b.people.unlinked;
    const email = `orphan-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const { workerBrowser, seedInvitation, GOOD_PASSWORD, INVITATION_HEADER } = await import("./helpers/auth");
    const token = await seedInvitation({ unitId: p.unitId, memberId: p.memberId!, email, createdBy: null });
    const b = await workerBrowser();
    expect((await b.json("POST", "/api/auth/sign-up/email", { email, password: GOOD_PASSWORD, name: "x" }, { [INVITATION_HEADER]: token })).status).toBe(200);
    const me = await b.json<{ error: { details: { reason: string }[] } }>("GET", "/api/v1/me");
    expect(me.status).toBe(401);
    expect(me.data.error.details[0]!.reason).toBe("account_not_linked");

    // 試験用ヘッダーは local かつ TEST_AUTH=1 以外では無視される（本番系の設定での再現）
    const hardened = { ...env, APP_ENV: "staging", BETTER_AUTH_SECRET: "k".repeat(40), AUTH_BASE_URL: "https://fireos-staging.example.invalid" } as unknown as typeof env;
    const forged = await createApp(hardened).fetch(
      new Request("https://fireos-staging.example.invalid/api/v1/me", { headers: { "x-test-identity": JSON.stringify(fx.units.a.people.admin) } }),
      hardened,
    );
    expect(forged.status).toBe(401);
    const noTestAuth = { ...env, TEST_AUTH: undefined } as unknown as typeof env;
    const forged2 = await createApp(noTestAuth).fetch(
      new Request("http://example.com/api/v1/me", { headers: { "x-test-identity": JSON.stringify(fx.units.a.people.admin) } }),
      noTestAuth,
    );
    expect(forged2.status).toBe(401);
  });

  it("me_returns_current_profile_roles_authz_version_and_policy_version", async () => {
    const res = await fx.client(fx.units.a.people.officer).request("GET", "/api/v1/me");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { data } = (await res.json()) as { data: Record<string, unknown> };
    expect(data).toMatchObject({
      profile: { memberId: fx.units.a.people.officer.memberId, displayName: "架空 幹部", rank: "副分団長" },
      unitName: "架空市 第一分団",
      roles: ["officer"],
      authzVersion: 1,
      policyVersion: POLICY_VERSION,
      mfaRequired: false,
    });
    // 停止ユーザー・未登録団員は 401
    expect((await fx.client(fx.units.a.people.suspended).request("GET", "/api/v1/me")).status).toBe(401);
    expect((await fx.client({ ...fx.units.a.people.unlinked, userId: crypto.randomUUID() }).request("GET", "/api/v1/me")).status).toBe(401);
    expect((await fx.client(fx.units.a.people.admin).request("GET", "/api/v1/me")).status).toBe(200);
    expect(HttpError).toBeDefined();
  });
});
