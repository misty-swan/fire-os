import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import "../src/server/auth/disable"; // job handler の登録（Cron/Queueと同じ登録）
import { commitDisable } from "../src/server/auth/disable";
import type { AuthzPrincipal } from "../src/server/auth/principal";
import type { ApiContext } from "../src/server/http";
import { runDueJobs } from "../src/server/jobs/runner";
import { commitRoleReplacement } from "../src/server/routes/member-roles";
import { loginAs, signInAnotherDevice } from "./helpers/auth";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const FAULT = { "x-test-fault": "revoke-all" };
const authzOf = async (userId: string) => (await env.DB.prepare("SELECT authz_version AS v FROM users WHERE id = ?").bind(userId).first<{ v: number }>())!.v;
const memberVersion = async (memberId: string) => (await env.DB.prepare("SELECT version AS v FROM members WHERE id = ?").bind(memberId).first<{ v: number }>())!.v;

async function stop(fx: TestFixture, who: Identity, target: Identity, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return fx.client(who).request(
    "PATCH", `/api/v1/members/${target.memberId}`,
    { version: await memberVersion(target.memberId!), status: "retired", reason: "転居による退団", ...extra }, { ...idem(), ...headers },
  );
}
const putRoles = async (fx: TestFixture, who: Identity, target: Identity, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fx.client(who).request(
    "PUT", `/api/v1/members/${target.memberId}/roles`,
    { version: await memberVersion(target.memberId!), expectedAuthzVersion: await authzOf(target.userId), reason: "役割の見直し", scopes: [], ...body }, { ...idem(), ...headers },
  );

describe("権限変更・利用停止・失効 (T012)", () => {
  it("disabled_user_is_denied_even_if_library_revoke_fails", async () => {
    const fx = await createFixture("two-units");
    const { admin, member } = fx.units.a.people;
    // 2端末でログイン済み
    const phone = await loginAs(member);
    const pc = await signInAnotherDevice(phone);
    expect((await phone.json("GET", "/api/v1/me")).status).toBe(200);
    expect((await pc.json("GET", "/api/v1/me")).status).toBe(200);
    const authzVersionBefore = await authzOf(member.userId);

    // 停止。認証ライブラリの失効には障害を注入する
    const res = await stop(fx, admin, member, {}, FAULT);
    expect(res.status).toBe(200);
    const authzVersionAfter = await authzOf(member.userId);

    // 旧Cookie・再ログインとも業務に入れない（ライブラリ側のセッションは残っているが業務認可が遮断）
    const remaining = await env.DB.prepare("SELECT count(*) AS n FROM auth_sessions WHERE user_id = ?").bind(phone.authId).first<{ n: number }>();
    expect(remaining!.n).toBeGreaterThan(0); // 失効に失敗した状態を作れている
    const statuses = [
      (await phone.json("GET", "/api/v1/me")).status,
      (await pc.json("GET", "/api/v1/members")).status,
      (await pc.json("GET", `/api/v1/jobs/${crypto.randomUUID()}`)).status,
    ];
    const allBusinessRequestsDenied = statuses.every((s) => s === 401 || s === 403);
    const relogin = await signInAnotherDevice(phone).catch((e: Error) => e);
    expect(relogin).toBeInstanceOf(Error); // 停止後の新しいセッションは作れない

    // 失効の再試行は永続jobに残り、実行すれば全セッションが消える
    const jobs = await env.DB.prepare("SELECT id, status FROM jobs WHERE kind = 'auth.revoke_sessions' AND source_id = ?").bind(member.userId).all<{ id: string; status: string }>();
    const revocationRecoveryJobCount = jobs.results.length;
    expect(jobs.results[0]!.status).toBe("queued");
    await runDueJobs(env);
    expect((await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(jobs.results[0]!.id).first<{ status: string }>())!.status).toBe("succeeded");
    expect((await env.DB.prepare("SELECT count(*) AS n FROM auth_sessions WHERE user_id = ?").bind(phone.authId).first<{ n: number }>())!.n).toBe(0);

    // 最後の管理者の降格・停止、自己昇格は拒否
    const lastAdminDemotion = await putRoles(fx, admin, admin, { roleCodes: ["member"] });
    expect((await stop(fx, admin, admin)).status).toBe(422);
    const selfScope = await putRoles(fx, admin, admin, {
      roleCodes: ["admin"], scopes: [{ entityType: "member", entityId: fx.units.a.people.operator.memberId, permissions: ["PER-06"] }],
    });
    expect(selfScope.status).toBe(403);
    expect(((await selfScope.json()) as { error: { details: { reason: string }[] } }).error.details[0]!.reason).toBe("self_escalation");

    expect(allBusinessRequestsDenied).toBe(true);
    expect(authzVersionAfter).toBe(authzVersionBefore + 1);
    expect(lastAdminDemotion.status).not.toBe(200);
    expect(revocationRecoveryJobCount).toBe(1);
  });

  it("stop_without_fault_revokes_sessions_immediately_and_records_the_reason_on_the_row", async () => {
    const fx = await createFixture("two-units");
    const { admin, member } = fx.units.a.people;
    const phone = await loginAs(member);
    const res = await stop(fx, admin, member);
    expect(res.status).toBe(200);
    expect((await phone.json("GET", "/api/v1/me")).status).toBe(401);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM auth_sessions WHERE user_id = ?").bind(phone.authId).first<{ n: number }>())!.n).toBe(0);
    // 即時に失効できたので、再試行jobは完了している（取り残さない）
    expect((await env.DB.prepare("SELECT status FROM jobs WHERE kind = 'auth.revoke_sessions' AND source_id = ?").bind(member.userId).first<{ status: string }>())!.status).toBe("succeeded");
    // 理由は変更された行に残り、監査/outboxには本文を複製しない。過去の履歴（団員行）は残る
    const row = await env.DB.prepare("SELECT status, status_reason FROM members WHERE id = ?").bind(member.memberId).first<{ status: string; status_reason: string }>();
    expect(row).toMatchObject({ status: "retired", status_reason: "転居による退団" });
    const user = await env.DB.prepare("SELECT status, disabled_reason, disabled_at FROM users WHERE id = ?").bind(member.userId).first<{ status: string; disabled_reason: string; disabled_at: string }>();
    expect(user).toMatchObject({ status: "disabled", disabled_reason: "転居による退団" });
    const dump = JSON.stringify([(await env.DB.prepare("SELECT metadata_json FROM audit_logs").all()).results, (await env.DB.prepare("SELECT payload_minimal FROM domain_events").all()).results]);
    expect(dump).not.toContain("転居");
    expect((await env.DB.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'member.disable' AND entity_id = ?").bind(member.memberId).first<{ n: number }>())!.n).toBe(1);
    // 理由が無い停止は拒否、旧い版・停止済みへの再停止は拒否
    expect((await fx.client(admin).request("PATCH", `/api/v1/members/${fx.units.a.people.operator.memberId}`, { version: 1, status: "paused" }, idem())).status).toBe(400);
    expect((await stop(fx, admin, member)).status).toBe(400); // 既に退団（変更なし）
    // 一般団員・別unitの管理者は停止できない
    expect((await stop(fx, fx.units.a.people.officer, fx.units.a.people.operator)).status).toBe(403);
    expect((await stop(fx, fx.units.b.people.admin, fx.units.a.people.operator)).status).toBe(404);
    // 停止したアカウントを復活させる経路は無い（再有効化は未提供）
    expect((await fx.client(admin).request("PATCH", `/api/v1/members/${member.memberId}`, { version: await memberVersion(member.memberId!), status: "active", reason: "復帰" }, idem())).status).toBe(422);
  });

  it("role_replacement_bumps_authz_version_and_rejects_unsafe_changes", async () => {
    const fx = await createFixture("two-units");
    const { admin, officer, operator, member } = fx.units.a.people;
    const other = fx.units.a.people.suspended; // 停止済みは対象外
    // 役割の全置換: operator → officer。旧役割は取消され履歴が残る。認可版が増える
    const before = await authzOf(operator.userId);
    const ok = await putRoles(fx, admin, operator, { roleCodes: ["officer"], scopes: [{ entityType: "member", entityId: member.memberId, permissions: ["PER-06"] }] });
    expect(ok.status).toBe(200);
    const body = ((await ok.json()) as { data: { authzVersion: number; roleCodes: string[]; scopes: { entityId: string; expiresAt: string | null }[] } }).data;
    expect(body.authzVersion).toBe(before + 1);
    expect(body.roleCodes).toEqual(["officer"]);
    expect(body.scopes).toEqual([{ entityType: "member", entityId: member.memberId, permissions: ["PER-06"], expiresAt: null }]);
    const hist = await env.DB.prepare("SELECT r.code, mr.revoked_at, mr.change_reason FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.member_id = ? ORDER BY mr.created_at, r.code").bind(operator.memberId).all<{ code: string; revoked_at: string | null; change_reason: string | null }>();
    expect(hist.results.find((h) => h.code === "operator")!.revoked_at).not.toBeNull();
    expect(hist.results.find((h) => h.code === "officer")!.revoked_at).toBeNull();
    // 変更後の主体は次の要求から新しい役割・担当で判定される（旧い担当は残らない）
    const fresh = await fx.client(operator).request("GET", "/api/v1/me");
    expect(((await fresh.json()) as { data: { roles: string[]; authzVersion: number } }).data).toMatchObject({ roles: ["officer"], authzVersion: before + 1 });
    expect((await env.DB.prepare("SELECT count(*) AS n FROM scope_assignments WHERE member_id = ? AND revoked_at IS NULL AND entity_type = 'facility'").bind(operator.memberId).first<{ n: number }>())!.n).toBe(0);
    const audit = await env.DB.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'member.roles.replace' AND entity_id = ?").bind(operator.memberId).first<{ metadata_json: string }>();
    expect(audit!.metadata_json).not.toContain("見直し");

    // 古い版・古い認可版は409、別unitは404、管理者以外は403、停止済み・未リンクは422
    expect((await fx.client(admin).request("PUT", `/api/v1/members/${officer.memberId}/roles`, { version: 99, expectedAuthzVersion: await authzOf(officer.userId), roleCodes: ["member"], scopes: [], reason: "x" }, idem())).status).toBe(409);
    expect((await fx.client(admin).request("PUT", `/api/v1/members/${officer.memberId}/roles`, { version: await memberVersion(officer.memberId!), expectedAuthzVersion: 99, roleCodes: ["member"], scopes: [], reason: "x" }, idem())).status).toBe(409);
    expect((await putRoles(fx, fx.units.b.people.admin, officer, { roleCodes: ["member"] })).status).toBe(404);
    expect((await putRoles(fx, officer, member, { roleCodes: ["admin"] })).status).toBe(403);
    expect((await putRoles(fx, member, member, { roleCodes: ["admin"] })).status).toBe(403); // 自己昇格
    expect((await putRoles(fx, admin, other, { roleCodes: ["member"] })).status).toBe(422);
    const unlinked = fx.units.a.people.unlinked;
    expect((await fx.client(admin).request("PUT", `/api/v1/members/${unlinked.memberId}/roles`, { version: 1, expectedAuthzVersion: 1, roleCodes: ["member"], scopes: [], reason: "x" }, idem())).status).toBe(422);
    // 担当の対象は同じunitの団員だけ・未対応の対象種別は拒否（存在しない/別unitのIDを許さない）
    expect((await putRoles(fx, admin, member, { roleCodes: ["member"], scopes: [{ entityType: "member", entityId: fx.units.b.people.member.memberId, permissions: ["PER-06"] }] })).status).toBe(404);
    expect((await putRoles(fx, admin, member, { roleCodes: ["member"], scopes: [{ entityType: "facility", entityId: crypto.randomUUID(), permissions: ["PER-03"] }] })).status).toBe(422);
    expect((await putRoles(fx, admin, member, { roleCodes: ["member"], scopes: [{ entityType: "member", entityId: operator.memberId, permissions: ["PER-03"] }] })).status).toBe(422);
    // 同じ鍵の再送は同じ結果（二重に認可版を増やさない）
    const key = crypto.randomUUID();
    const payload = { version: await memberVersion(member.memberId!), expectedAuthzVersion: await authzOf(member.userId), roleCodes: ["operator"], scopes: [], reason: "r" };
    const v0 = await authzOf(member.userId);
    const r1 = await fx.client(admin).request("PUT", `/api/v1/members/${member.memberId}/roles`, payload, { "idempotency-key": key });
    const r2 = await fx.client(admin).request("PUT", `/api/v1/members/${member.memberId}/roles`, payload, { "idempotency-key": key });
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(await authzOf(member.userId)).toBe(v0 + 1);
    // 管理者を二人にすれば、一人の降格は許される
    expect((await putRoles(fx, admin, officer, { roleCodes: ["admin"] })).status).toBe(200);
    expect((await putRoles(fx, officer, admin, { roleCodes: ["member"] })).status).toBe(200); // officerは今adminなので、もう一人のadminを降格できる
  });

  it("last_admin_guard_also_holds_inside_the_commit_batch", async () => {
    // 事前の確認（理由つき422）を通った後に、もう一人の管理者が外れた状況を作り、確定のbatchを直接呼ぶ。
    // 事前確認だけでは、同時に二人の管理者が自分を外すと管理者が0人になる
    const ctx = { env, req: { header: () => undefined } } as unknown as ApiContext;
    const asP = (i: Identity) => ({ userId: i.userId, memberId: i.memberId!, unitId: i.unitId, authzVersion: 1 }) as unknown as AuthzPrincipal;

    const fx = await createFixture("two-units");
    const { admin, officer } = fx.units.a.people;
    expect((await putRoles(fx, admin, officer, { roleCodes: ["admin"] })).status).toBe(200); // 管理者は二人
    // 相手の管理者(officer)が先に外れた（停止）
    await env.DB.prepare("UPDATE users SET status = 'disabled', disabled_at = ?, authz_version = authz_version + 1 WHERE id = ?").bind("2026-10-13T01:00:00.000Z", officer.userId).run();
    await env.DB.prepare("UPDATE members SET status = 'retired' WHERE id = ?").bind(officer.memberId).run();
    await expect(
      commitDisable(ctx, asP(admin), {
        memberId: admin.memberId!, version: await memberVersion(admin.memberId!), expectedAuthzVersion: 1, status: "retired", reason: "同時",
        key: crypto.randomUUID(), requestHash: "a".repeat(64),
      }, { user_id: admin.userId, auth_id: "x" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect((await env.DB.prepare("SELECT status FROM users WHERE id = ?").bind(admin.userId).first<{ status: string }>())!.status).toBe("active");

    const fx2 = await createFixture("two-units");
    const { admin: a2, officer: o2 } = fx2.units.a.people;
    expect((await putRoles(fx2, a2, o2, { roleCodes: ["admin"] })).status).toBe(200);
    await env.DB.prepare("UPDATE member_roles SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL").bind("2026-10-13T01:00:00.000Z", o2.memberId).run();
    await expect(
      commitRoleReplacement(ctx, asP(a2), {
        memberId: a2.memberId!, targetUserId: a2.userId, version: await memberVersion(a2.memberId!), expectedAuthzVersion: 1,
        newRoles: ["member"], scopes: [], reason: "同時", key: crypto.randomUUID(), requestHash: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    const roles = await env.DB.prepare("SELECT count(*) AS n FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.member_id = ? AND r.code = 'admin' AND mr.revoked_at IS NULL").bind(a2.memberId).first<{ n: number }>();
    expect(roles!.n).toBe(1); // 取り消されていない（batch全体がロールバック）
  });

  it("last_admin_refusals_carry_a_reason", async () => {
    const fx = await createFixture("two-units");
    const { admin } = fx.units.a.people;
    const res = await stop(fx, admin, admin);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { details: { reason: string }[] } }).error.details[0]!.reason).toBe("last_admin");
    const demote = await putRoles(fx, admin, admin, { roleCodes: ["member"] });
    expect(demote.status).toBe(422);
    expect(((await demote.json()) as { error: { details: { reason: string }[] } }).error.details[0]!.reason).toBe("last_admin");
  });

  it("session_revocation_api_revokes_all_sessions_and_bumps_authz_version", async () => {
    const fx = await createFixture("two-units");
    const { admin, member, operator } = fx.units.a.people;
    const phone = await loginAs(member);
    const pc = await signInAnotherDevice(phone);
    const v0 = await authzOf(member.userId);
    const res = await fx.client(admin).request("POST", `/api/v1/users/${member.userId}/session-revocations`, { expectedAuthzVersion: v0, reason: "端末紛失" }, idem());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ userId: member.userId, authzVersion: v0 + 1, sessionRevocation: "completed" });
    expect((await phone.json("GET", "/api/v1/me")).status).toBe(401);
    expect((await pc.json("GET", "/api/v1/me")).status).toBe(401);
    // 停止ではないので、再ログインして使える
    const again = await signInAnotherDevice(phone);
    expect((await again.json("GET", "/api/v1/me")).status).toBe(200);
    // 失効に失敗したら pending（業務側はすでに旧セッションを拒否し、再試行jobが残る）
    const v1 = await authzOf(member.userId);
    const failed = await fx.client(admin).request("POST", `/api/v1/users/${member.userId}/session-revocations`, { expectedAuthzVersion: v1, reason: "再", }, { ...idem(), ...FAULT });
    expect(((await failed.json()) as { data: { sessionRevocation: string } }).data.sessionRevocation).toBe("pending");
    expect((await again.json("GET", "/api/v1/me")).status).toBe(401);
    // 本人は自分のセッションを失効できる／他人のは管理者だけ／別unitは404／古い認可版は409
    const own = await loginAs(operator);
    const vo = await authzOf(operator.userId);
    expect((await fx.client(operator).request("POST", `/api/v1/users/${operator.userId}/session-revocations`, { expectedAuthzVersion: vo, reason: "自分" }, idem())).status).toBe(200);
    expect((await own.json("GET", "/api/v1/me")).status).toBe(401);
    expect((await fx.client(operator).request("POST", `/api/v1/users/${member.userId}/session-revocations`, { expectedAuthzVersion: await authzOf(member.userId), reason: "他人" }, idem())).status).toBe(403);
    expect((await fx.client(fx.units.b.people.admin).request("POST", `/api/v1/users/${member.userId}/session-revocations`, { expectedAuthzVersion: await authzOf(member.userId), reason: "x" }, idem())).status).toBe(404);
    expect((await fx.client(admin).request("POST", `/api/v1/users/${member.userId}/session-revocations`, { expectedAuthzVersion: 1, reason: "x" }, idem())).status).toBe(409);
  });
});
