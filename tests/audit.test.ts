import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { GOOD_PASSWORD, directAuth, directBrowser, loginAs, signInAnotherDevice, workerBrowser } from "./helpers/auth";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";
import { secretFromUri, totpCode } from "./helpers/totp";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

interface AuditDto {
  id: string; occurredAt: string; actorKind: string; actorId: string | null; action: string; entityType: string; entityId: string;
  mutationId: string; entityVersion: number | null; eventType: string | null; metadata: Record<string, unknown>;
}
const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const SECRETS = ["架空 監査確認", "090-0000-1111", "audit-secret@example.test", "監査試験の理由", "誤発行テスト"];

async function listAudit(fx: TestFixture, who: Identity, query = "") {
  const r = await fx.client(who).request("GET", `/api/v1/audit-logs${query}`);
  const j = (await r.json()) as { data?: AuditDto[]; meta?: { nextCursor?: string } };
  return { status: r.status, rows: j.data ?? [], next: j.meta?.nextCursor };
}

describe("監査 (T014)", () => {
  it("audit_is_append_only_and_scope_filtered", async () => {
    const fx = await createFixture("two-units");
    const { admin, member, operator, officer } = fx.units.a.people;
    const c = fx.client(admin);
    // 台帳(名簿)・権限・停止の操作を行う
    const made = await c.request("POST", "/api/v1/members", { displayName: "架空 監査確認", status: "active", privateFields: { phone: "090-0000-1111" } }, idem());
    const newMember = ((await made.json()) as { data: { id: string } }).data.id;
    const inv = await c.request("POST", "/api/v1/invitations", { memberId: newMember, email: "audit-secret@example.test", expiresInHours: 24 }, idem());
    const invitation = ((await inv.json()) as { data: { id: string; version: number } }).data;
    await c.request("POST", `/api/v1/invitations/${invitation.id}/cancel`, { version: invitation.version, reason: "誤発行テスト" }, idem());
    const roles = await c.request("PUT", `/api/v1/members/${operator.memberId}/roles`, { version: 1, expectedAuthzVersion: 1, roleCodes: ["officer"], scopes: [], reason: "監査試験の理由" }, idem());
    expect(roles.status).toBe(200);
    const memberDenied = (await listAudit(fx, member)).status; // 停止する前の一般団員
    // 失敗した操作（旧い版・権限なし）は監査に残らない
    const before = (await listAudit(fx, admin)).rows.length;
    expect((await c.request("PATCH", `/api/v1/members/${newMember}`, { version: 99, rank: "x" }, idem())).status).toBe(409);
    expect((await fx.client(member).request("PATCH", `/api/v1/members/${newMember}`, { version: 1, rank: "x" }, idem())).status).toBe(403);
    const stop = await c.request("PATCH", `/api/v1/members/${member.memberId}`, { version: 1, status: "paused", reason: "監査試験の理由" }, idem());
    expect(stop.status).toBe(200);

    // 担当者（actor）別の検索：成功した操作が、操作の順に一回ずつ追跡できる
    const mine = await listAudit(fx, admin, `?actorId=${admin.userId}&limit=100`);
    expect(mine.status).toBe(200);
    const successfulActions = [...mine.rows].reverse().map((r) => r.action);
    const expectedActions = ["member.create", "invitation.create", "invitation.cancel", "member.roles.replace", "member.disable"];
    const duplicateOperationIds = mine.rows.map((r) => r.mutationId).filter((m, i, a) => a.indexOf(m) !== i);
    const sensitiveBodiesInLog = SECRETS.filter((s) => JSON.stringify(mine.rows).includes(s));
    // 新しい順。version追跡：outboxの版と結びつく
    expect(mine.rows[0]!.action).toBe("member.disable");
    expect(mine.rows.find((r) => r.action === "member.roles.replace")).toMatchObject({ entityType: "member", entityId: operator.memberId, entityVersion: 2, eventType: "member.roles.replaced", actorId: admin.userId });
    expect(mine.rows.every((r) => r.actorKind === "human")).toBe(true);
    // 失敗した操作（旧い版409・権限なし403）は、その対象の監査に何も残していない
    expect(mine.rows.filter((r) => r.entityId === newMember).map((r) => r.action)).toEqual(["invitation.create", "invitation.cancel", "member.create"].filter((a) => a === "member.create"));
    expect(before).toBeGreaterThan(0);

    // 一般役割・別unitは参照できない。監査の更新/削除の経路は存在しない
    const denied = [] as number[];
    denied.push(memberDenied);
    for (const who of [operator, officer]) denied.push((await listAudit(fx, who)).status);
    const reasonBody = (await (await fx.client(officer).request("GET", "/api/v1/audit-logs")).json()) as { error: { code: string; details: { reason: string }[] } };
    expect(reasonBody.error).toMatchObject({ code: "FORBIDDEN", details: [{ reason: "role" }] }); // 権限不足（二要素欠如の403とは別の理由）
    const otherUnit = await listAudit(fx, fx.units.b.people.admin);
    const updateAuditRoute = await c.request("PATCH", `/api/v1/audit-logs/${mine.rows[0]!.id}`, { action: "x" }, idem());
    const deleteAuditRoute = await c.request("DELETE", `/api/v1/audit-logs/${mine.rows[0]!.id}`, undefined, idem());
    const postAuditRoute = await c.request("POST", "/api/v1/audit-logs", { action: "x" }, idem());

    expect(successfulActions).toEqual(expectedActions);
    expect(duplicateOperationIds).toEqual([]);
    expect(sensitiveBodiesInLog).toEqual([]);
    expect(updateAuditRoute.status).toBe(404);
    expect(deleteAuditRoute.status).toBe(404);
    expect(postAuditRoute.status).toBe(404);
    expect(denied).toEqual([403, 403, 403]);
    expect(otherUnit.status).toBe(200);
    expect(otherUnit.rows.some((r) => mine.rows.some((m) => m.id === r.id))).toBe(false); // 別unitの管理者に、この分団の監査は見えない
    // DB自体も追記専用（トリガー）：直接のUPDATE/DELETEは失敗する
    await expect(env.DB.prepare("UPDATE audit_logs SET action = 'x' WHERE id = ?").bind(mine.rows[0]!.id).run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare("DELETE FROM audit_logs WHERE id = ?").bind(mine.rows[0]!.id).run()).rejects.toThrow(/append-only/);
  });

  it("audit_search_filters_and_keyset_paging_are_stable", async () => {
    const fx = await createFixture("two-units");
    const { admin } = fx.units.a.people;
    const c = fx.client(admin);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await c.request("POST", "/api/v1/members", { displayName: `架空 履歴${i}`, status: "active" }, idem());
      ids.push(((await r.json()) as { data: { id: string } }).data.id);
    }
    // ページング中に新しい監査が増えても、取りこぼし・重複が出ない（新しい順のkeyset）
    const p1 = await listAudit(fx, admin, "?limit=2");
    await c.request("POST", "/api/v1/members", { displayName: "架空 履歴後から", status: "active" }, idem());
    const p2 = await listAudit(fx, admin, `?limit=2&cursor=${encodeURIComponent(p1.next!)}`);
    const p3 = await listAudit(fx, admin, `?limit=2&cursor=${encodeURIComponent(p2.next!)}`);
    const seen = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(p1.rows.map((r) => r.entityId)).toEqual([ids[4], ids[3]]);
    expect(p2.rows.map((r) => r.entityId)).toEqual([ids[2], ids[1]]);
    // 絞り込み：対象・対象種別・期間・行為者
    const byEntity = await listAudit(fx, admin, `?entityId=${ids[2]}`);
    expect(byEntity.rows.map((r) => r.action)).toEqual(["member.create"]);
    expect((await listAudit(fx, admin, "?entityType=invitation")).rows).toEqual([]);
    const all = await listAudit(fx, admin, "?limit=200&entityType=member");
    const times = all.rows.map((r) => r.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
    const mid = times[2]!;
    expect((await listAudit(fx, admin, `?limit=200&from=${encodeURIComponent(mid)}`)).rows.every((r) => r.occurredAt >= mid)).toBe(true);
    expect((await listAudit(fx, admin, `?limit=200&to=${encodeURIComponent(mid)}`)).rows.every((r) => r.occurredAt <= mid)).toBe(true);
    expect((await listAudit(fx, admin, `?actorId=${crypto.randomUUID()}`)).rows).toEqual([]);
    // 契約に無い絞り込み・壊れたcursorは400
    expect((await c.request("GET", "/api/v1/audit-logs?unitId=x")).status).toBe(400);
    expect((await c.request("GET", "/api/v1/audit-logs?cursor=broken")).status).toBe(400);
  });

  it("audit_requires_mfa_for_a_real_admin_session", async () => {
    const fx = await createFixture("two-units");
    const { admin } = fx.units.a.people;
    const noMfa = await loginAs(admin);
    expect((await noMfa.json("GET", "/api/v1/audit-logs")).status).toBe(403);
    const withMfa = await loginAs(admin, { mfa: true });
    const r = await withMfa.json<{ data: unknown[] }>("GET", "/api/v1/audit-logs");
    expect(r.status).toBe(200);
  });

  /**
   * 認証イベント（サインイン成功/失敗・二要素の設定変更・パスワード再設定）が監査に残る（PH1-A2。T086）。
   * T014の設計に従う: 追記のみ・本文を複製しない（パスワード・再設定token・TOTPの秘密・セッションtokenは
   * 載せない）・管理者は監査APIの既存フィルタ（entityType/entityId）で読める。帰属できない試行
   * （未登録メールなど）はunit帰属が必須のため書かれない（その防御はIP単位の回数制限が担う）。
   */
  it("authentication_events_are_recorded_in_audit_without_secrets", async () => {
    const fx = await createFixture("two-units");
    const { admin, member } = fx.units.a.people;
    // 一般団員の業務userに実セッションを持たせる（loginAsは招待→登録→users.auth_id結び付けまで行う）
    const first = await loginAs(member);
    // 別端末でのサインイン成功 → auth.sign_in (result=success)
    await signInAnotherDevice(first);
    // 誤パスワードのサインイン失敗 → auth.sign_in (result=failure)
    const wrong = await workerBrowser();
    const failed = await wrong.json("POST", "/api/auth/sign-in/email", { email: first.email, password: "wrong-password-123" });
    expect(failed.status).toBe(401);

    // 二要素の設定変更（enable=秘密の発行 → verify-totp=有効化の確定）
    const { service, captured } = directAuth();
    const b = await directBrowser(service);
    await b.json("POST", "/api/auth/sign-in/email", { email: first.email, password: GOOD_PASSWORD });
    const enable = await b.json<{ totpURI: string }>("POST", "/api/auth/two-factor/enable", { password: GOOD_PASSWORD });
    expect(enable.status).toBe(200);
    const totpSecret = secretFromUri(enable.data.totpURI);
    expect((await b.json("POST", "/api/auth/two-factor/verify-totp", { code: await totpCode(totpSecret) })).status).toBe(200);

    // パスワード再設定（要求 → 完了。tokenは配送の捕捉だけで、監査には載せない）
    await b.json("POST", "/api/auth/request-password-reset", { email: first.email });
    expect(captured.length).toBeGreaterThan(0);
    const resetToken = captured[0]!.token;
    const done = await b.json("POST", "/api/auth/reset-password", { newPassword: "re-audited-strong-9", token: resetToken });
    expect(done.status).toBe(200);

    // 管理者が監査APIの既存フィルタ（entityType/entityId）で本人（user）単位の認証記録を読める
    const mine = await listAudit(fx, admin, `?entityType=user&entityId=${member.userId}&limit=100`);
    expect(mine.status).toBe(200);
    const rows = mine.rows.map((r) => ({ action: r.action, meta: JSON.stringify(r.metadata) }));
    const has = (action: string, ...needles: string[]) =>
      rows.some((r) => r.action === action && needles.every((n) => r.meta.includes(n)));
    expect(has("auth.sign_in", '"success"')).toBe(true);
    expect(has("auth.sign_in", '"failure"')).toBe(true);
    expect(has("auth.two_factor.setup_started")).toBe(true);
    expect(has("auth.two_factor.enabled")).toBe(true);
    expect(has("auth.password_reset_requested")).toBe(true);
    expect(has("auth.password_reset_completed")).toBe(true);
    // 行為者も対象も本人のuser行（actorIdフィルタでも辿れる）
    expect(mine.rows.every((r) => r.entityType === "user" && r.entityId === member.userId)).toBe(true);
    expect(mine.rows.every((r) => r.actorKind === "human" && r.actorId === member.userId)).toBe(true);

    // 認証の秘密（パスワード・再設定token・TOTPの秘密）は監査に載せない
    const all = JSON.stringify(mine.rows);
    for (const s of [GOOD_PASSWORD, "wrong-password-123", "re-audited-strong-9", resetToken, totpSecret]) {
      expect(all.includes(s)).toBe(false);
    }

    // 未登録メールのサインイン試行は書かない（unit帰属が無いため。防御はIP単位の回数制限）
    const signInRows = async () =>
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE unit_id = ? AND action = 'auth.sign_in'").bind(fx.units.a.id).first<{ n: number }>())!.n;
    const before = await signInRows();
    const unknown = await workerBrowser();
    await unknown.json("POST", "/api/auth/sign-in/email", { email: `nobody-${crypto.randomUUID().slice(0, 8)}@example.test`, password: "wrong-password-123" });
    expect(await signInRows()).toBe(before);
  });
});
