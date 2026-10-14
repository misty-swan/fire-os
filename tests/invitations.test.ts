import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapAdmin } from "../src/server/auth/bootstrap";
import { reapOrphanIdentities } from "../src/server/auth/orphans";
import { GOOD_PASSWORD, INVITATION_HEADER, uniqueEmail, workerBrowser, type Browser } from "./helpers/auth";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

interface InvitationDto { id: string; version: number; memberId: string; status: string; expiresAt: string; token: string | null }
const idem = () => ({ "idempotency-key": crypto.randomUUID() });

async function newUnlinkedMember(unitId: string, name = "架空 新入団員"): Promise<string> {
  const id = crypto.randomUUID();
  const admin = await env.DB.prepare("SELECT u.id FROM users u JOIN members m ON m.user_id = u.id WHERE m.unit_id = ? LIMIT 1").bind(unitId).first<{ id: string }>();
  await env.DB.prepare(
    "INSERT INTO members (id, unit_id, display_name, status, created_at, updated_at, created_by, actor_kind) VALUES (?,?,?,?,?,?,?,?)",
  ).bind(id, unitId, name, "active", "2026-10-13T00:00:00.000Z", "2026-10-13T00:00:00.000Z", admin!.id, "human").run();
  return id;
}

async function invite(admin: Identity, memberId: string, email: string, hours = 48) {
  return fx.client(admin).request("POST", "/api/v1/invitations", { memberId, email, expiresInHours: hours }, idem());
}
const dataOf = async <T>(r: Response) => ((await r.json()) as { data: T }).data;

/** 招待tokenで登録（認証identityを作る）して、セッション付きのブラウザを返す */
async function register(email: string, token: string): Promise<Browser> {
  const b = await workerBrowser();
  const r = await b.json("POST", "/api/auth/sign-up/email", { email, password: GOOD_PASSWORD, name: "団員" }, { [INVITATION_HEADER]: token });
  expect(r.status).toBe(200);
  return b;
}
const accept = (b: Browser, token: string, authId: string, key = crypto.randomUUID()) =>
  b.json<{ data?: { memberId: string; roleCodes: string[] }; error?: { code: string; details: { reason: string }[] } }>(
    "POST", "/api/v1/invitations/accept", { token, verifiedAuthIdentity: authId }, { "idempotency-key": key },
  );
const authIdOf = async (b: Browser) => ((await b.json<{ user: { id: string } }>("GET", "/api/auth/get-session")).data.user.id);

describe("招待 (T009)", () => {
  it("invitation_has_one_consumer_and_bound_identity", async () => {
    const admin = fx.units.a.people.admin;
    const memberId = await newUnlinkedMember(admin.unitId);
    const email = uniqueEmail("invitee");
    const created = await invite(admin, memberId, email);
    expect(created.status).toBe(201);
    const inv = await dataOf<InvitationDto>(created);
    expect(inv.status).toBe("pending");
    expect(inv.token!.length).toBeGreaterThanOrEqual(43);

    // 生token・メールはどこにも平文で保存されない
    const stored = await env.DB.prepare("SELECT token_hash, email_hash FROM invitations WHERE id = ?").bind(inv.id).first<{ token_hash: string; email_hash: string }>();
    const dump = JSON.stringify([
      await env.DB.prepare("SELECT * FROM invitations").all(),
      await env.DB.prepare("SELECT * FROM idempotency_records").all(),
      await env.DB.prepare("SELECT * FROM audit_logs").all(),
      await env.DB.prepare("SELECT * FROM domain_events").all(),
    ]);
    const storedRawTokens = [inv.token!, email].filter((secret) => dump.includes(secret));
    expect(stored!.token_hash).toMatch(/^[0-9a-f]{64}$/);

    // 登録前（identityだけでも、受領前）は業務アクセスなし
    const invitee = await register(email, inv.token!);
    const authId = await authIdOf(invitee);
    expect((await invitee.json("GET", "/api/v1/me")).status).toBe(401);

    // 別identity（別の招待で登録した人）は、このtokenを使えない
    const otherMember = await newUnlinkedMember(admin.unitId, "架空 別入団員");
    const otherEmail = uniqueEmail("other");
    const otherInv = await dataOf<InvitationDto>(await invite(admin, otherMember, otherEmail));
    const other = await register(otherEmail, otherInv.token!);
    const wrongIdentity = await accept(other, inv.token!, await authIdOf(other));
    expect(wrongIdentity.status).toBe(403);
    expect(wrongIdentity.data.error!.details[0]!.reason).toBe("identity_mismatch");
    // 自分のidentityを偽って申告してもセッションと一致しなければ拒否
    const spoof = await accept(other, otherInv.token!, authId);
    expect(spoof.status).toBe(400);
    expect(spoof.data.error!.details[0]!.reason).toBe("session_mismatch");
    expect((await (await workerBrowser()).json("POST", "/api/v1/invitations/accept", { token: inv.token, verifiedAuthIdentity: authId }, idem())).status).toBe(401);

    // 2つ同時の受領は片方だけ成立
    const k1 = crypto.randomUUID();
    const k2 = crypto.randomUUID();
    const [r1, r2] = await Promise.all([accept(invitee, inv.token!, authId, k1), accept(invitee, inv.token!, authId, k2)]);
    const acceptStatuses = [r1.status, r2.status].sort();
    const linkedMemberCount = (await env.DB.prepare("SELECT count(*) AS n FROM members WHERE id = ? AND user_id IS NOT NULL").bind(memberId).first<{ n: number }>())!.n;

    expect(acceptStatuses).toEqual([200, 409]);
    expect([r1, r2].find((r) => r.status === 409)!.data.error!.code).toBe("VERSION_CONFLICT"); // 敗者は「版の競合」（権限や内部障害ではない）
    expect(linkedMemberCount).toBe(1);
    expect(wrongIdentity.status).not.toBe(200);
    expect(storedRawTokens).toEqual([]);

    // 受領後: 役割は招待に記された member だけ。業務アクセスができる。監査は一回
    const me = await invitee.json<{ data: { roles: string[]; authzVersion: number } }>("GET", "/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.data.data.roles).toEqual(["member"]);
    const audits = await env.DB.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'invitation.accept' AND entity_id = ?").bind(inv.id).first<{ n: number }>();
    expect(audits!.n).toBe(1);
    // 使用済みtokenの再利用は拒否（別の鍵で再送しても同じ）
    expect((await accept(invitee, inv.token!, authId)).status).toBe(409);
    // 成立した受領と同じ鍵の再送は、再実行せず同じ結果
    const winnerKey = r1.status === 200 ? k1 : k2;
    const replay = await accept(invitee, inv.token!, authId, winnerKey);
    expect(replay.status).toBe(200);
    expect(replay.data.data!.memberId).toBe(memberId);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'invitation.accept' AND entity_id = ?").bind(inv.id).first<{ n: number }>())!.n).toBe(1);
  });

  it("expired_cancelled_and_reissued_invitations_cannot_be_used", async () => {
    const admin = fx.units.a.people.admin;
    // 期限切れ
    const m1 = await newUnlinkedMember(admin.unitId);
    const e1 = uniqueEmail("exp");
    const i1 = await dataOf<InvitationDto>(await invite(admin, m1, e1));
    const b1 = await register(e1, i1.token!);
    await env.DB.prepare("UPDATE invitations SET expires_at = ? WHERE id = ?").bind("2020-01-01T00:00:00.000Z", i1.id).run();
    const expired = await accept(b1, i1.token!, await authIdOf(b1));
    expect(expired.status).toBe(422);
    expect(expired.data.error!.details[0]!.reason).toBe("expired");
    // 期限切れ後の新規登録も不可
    expect((await (await workerBrowser()).json("POST", "/api/auth/sign-up/email", { email: uniqueEmail("late"), password: GOOD_PASSWORD, name: "x" }, { [INVITATION_HEADER]: i1.token! })).status).toBe(403);

    // 取消（API-34）後は受領不可。理由は必須、版違いは409、取消済みの再取消は422
    const m2 = await newUnlinkedMember(admin.unitId);
    const e2 = uniqueEmail("cancel");
    const i2 = await dataOf<InvitationDto>(await invite(admin, m2, e2));
    const b2 = await register(e2, i2.token!);
    const noReason = await fx.client(admin).request("POST", `/api/v1/invitations/${i2.id}/cancel`, { version: i2.version }, idem());
    expect(noReason.status).toBe(400);
    const stale = await fx.client(admin).request("POST", `/api/v1/invitations/${i2.id}/cancel`, { version: 99, reason: "誤発行" }, idem());
    expect(stale.status).toBe(409);
    const cancelled = await fx.client(admin).request("POST", `/api/v1/invitations/${i2.id}/cancel`, { version: i2.version, reason: "誤発行" }, idem());
    expect(cancelled.status).toBe(200);
    expect((await dataOf<InvitationDto>(cancelled)).status).toBe("cancelled");
    const afterCancel = await accept(b2, i2.token!, await authIdOf(b2));
    expect(afterCancel.status).toBe(422);
    expect(afterCancel.data.error!.details[0]!.reason).toBe("cancelled");
    const again = await fx.client(admin).request("POST", `/api/v1/invitations/${i2.id}/cancel`, { version: i2.version + 1, reason: "再" }, idem());
    expect(again.status).toBe(422);
    // 監査に取消理由の本文は入らない
    const audit = await env.DB.prepare("SELECT metadata_json FROM audit_logs WHERE action = 'invitation.cancel' AND entity_id = ?").bind(i2.id).first<{ metadata_json: string }>();
    expect(audit!.metadata_json).not.toContain("誤発行");

    // 再発行: 旧い有効な招待は取り消され、有効なのは1件。旧tokenは使えない
    const m3 = await newUnlinkedMember(admin.unitId);
    const e3 = uniqueEmail("reissue");
    const old = await dataOf<InvitationDto>(await invite(admin, m3, e3));
    const fresh = await dataOf<InvitationDto>(await invite(admin, m3, e3));
    expect(fresh.id).not.toBe(old.id);
    const pending = await env.DB.prepare("SELECT count(*) AS n FROM invitations WHERE member_id = ? AND status = 'pending'").bind(m3).first<{ n: number }>();
    expect(pending!.n).toBe(1);
    expect((await (await workerBrowser()).json("POST", "/api/auth/sign-up/email", { email: e3, password: GOOD_PASSWORD, name: "x" }, { [INVITATION_HEADER]: old.token! })).status).toBe(403);
  });

  it("invite_api_enforces_permission_unit_and_member_state", async () => {
    const a = fx.units.a;
    const memberId = await newUnlinkedMember(a.id);
    const body = { memberId, email: uniqueEmail("x"), expiresInHours: 48 };
    // 管理者以外は403（一般団員・担当者・幹部）
    for (const who of ["member", "operator", "officer"] as const) {
      expect((await fx.client(a.people[who]).request("POST", "/api/v1/invitations", body, idem())).status, who).toBe(403);
    }
    // 別unitの団員は存在を明かさず404
    const foreign = await newUnlinkedMember(fx.units.b.id);
    expect((await invite(a.people.admin, foreign, uniqueEmail("f"))).status).toBe(404);
    // 既にリンク済みの団員には招待できない
    const linked = await invite(a.people.admin, a.people.member.memberId!, uniqueEmail("l"));
    expect(linked.status).toBe(422);
    // 休団・退団の団員には招待できない
    const paused = await newUnlinkedMember(a.id);
    await env.DB.prepare("UPDATE members SET status = 'paused' WHERE id = ?").bind(paused).run();
    expect((await invite(a.people.admin, paused, uniqueEmail("p"))).status).toBe(422);
    // 同じ鍵の再送は同じ招待で、tokenは再表示されない
    const key = crypto.randomUUID();
    const m = await newUnlinkedMember(a.id);
    const payload = { memberId: m, email: uniqueEmail("r"), expiresInHours: 24 };
    const first = await fx.client(a.people.admin).request("POST", "/api/v1/invitations", payload, { "idempotency-key": key });
    const replay = await fx.client(a.people.admin).request("POST", "/api/v1/invitations", payload, { "idempotency-key": key });
    const f = await dataOf<InvitationDto>(first);
    const r = await dataOf<InvitationDto>(replay);
    expect(f.token).not.toBeNull();
    expect(r.id).toBe(f.id);
    expect(r.token).toBeNull();
    const count = await env.DB.prepare("SELECT count(*) AS n FROM invitations WHERE member_id = ?").bind(m).first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("bootstrap_admin_is_one_time_and_leaves_no_public_signup", async () => {
    // 空のDB（分団が無い）でだけ実行できる。ここでは別の空DBで確認する
    await applyD1Migrations(env.DB_FRESH, env.TEST_MIGRATIONS);
    const fresh = { ...env, DB: env.DB_FRESH } as unknown as typeof env;
    const email = uniqueEmail("boot");
    const first = await bootstrapAdmin(fresh, { unitName: "架空市 初期分団", adminDisplayName: "架空 初期管理者", email });
    expect(first.token.length).toBeGreaterThanOrEqual(43);
    const row = await env.DB_FRESH.prepare("SELECT kind, status, intended_authz FROM invitations WHERE member_id = ?").bind(first.memberId).first<{ kind: string; status: string; intended_authz: string }>();
    expect(row).toMatchObject({ kind: "bootstrap", status: "pending" });
    expect(JSON.parse(row!.intended_authz)).toEqual({ roleCodes: ["admin"] });
    // 再実行（別の分団を作る・同じ分団に二重に作る）は拒否
    await expect(bootstrapAdmin(fresh, { unitName: "別の分団", adminDisplayName: "x", email: uniqueEmail("b2") })).rejects.toThrow(/already_bootstrapped/);
    // 未使用のまま再発行すると旧tokenは無効、有効は1件
    const reissued = await bootstrapAdmin(fresh, { unitName: "架空市 初期分団", adminDisplayName: "架空 初期管理者", email, reissue: true });
    expect(reissued.token).not.toBe(first.token);
    expect(reissued.memberId).toBe(first.memberId);
    const active = await env.DB_FRESH.prepare("SELECT count(*) AS n FROM invitations WHERE status = 'pending'").first<{ n: number }>();
    expect(active!.n).toBe(1);
    // 監査（システム主体）に発行が残り、tokenとメールは含まない
    const audit = await env.DB_FRESH.prepare("SELECT actor_kind, action, metadata_json FROM audit_logs ORDER BY occurred_at").all<{ actor_kind: string; action: string; metadata_json: string }>();
    expect(audit.results.map((a) => a.action)).toEqual(["bootstrap.issue", "bootstrap.issue"]);
    expect(JSON.stringify(audit.results)).not.toContain(first.token);
    expect(JSON.stringify(audit.results)).not.toContain(email);
  });

  it("orphan_identities_without_a_business_user_are_reaped_after_the_grace_period", async () => {
    const admin = fx.units.a.people.admin;
    const m = await newUnlinkedMember(admin.unitId);
    const e = uniqueEmail("orphan");
    const inv = await dataOf<InvitationDto>(await invite(admin, m, e));
    const b = await register(e, inv.token!);
    const authId = await authIdOf(b);
    const base = new Date();
    // 猶予内は残す
    expect(await reapOrphanIdentities(env, base.toISOString())).toBe(0);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM auth_users WHERE id = ?").bind(authId).first<{ n: number }>())!.n).toBe(1);
    // 猶予（7日）を過ぎたら、業務利用者に結びつかないidentityは消え、セッションも消える（連鎖）
    const later = new Date(base.getTime() + 8 * 24 * 3600 * 1000).toISOString();
    expect(await reapOrphanIdentities(env, later)).toBeGreaterThanOrEqual(1);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM auth_users WHERE id = ?").bind(authId).first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM auth_sessions WHERE user_id = ?").bind(authId).first<{ n: number }>())!.n).toBe(0);
    // 受領済み（業務利用者に結びついた）identityは消さない
    const m2 = await newUnlinkedMember(admin.unitId);
    const e2 = uniqueEmail("kept");
    const i2 = await dataOf<InvitationDto>(await invite(admin, m2, e2));
    const b2 = await register(e2, i2.token!);
    const a2 = await authIdOf(b2);
    expect((await accept(b2, i2.token!, a2)).status).toBe(200);
    await reapOrphanIdentities(env, later);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM auth_users WHERE id = ?").bind(a2).first<{ n: number }>())!.n).toBe(1);
  });
});
