import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

interface MemberDto {
  id: string; version: number; displayName: string; rank: string | null; squad: string | null; qualifications: string[];
  joinedOn: string | null; status: string; hasAccount: boolean; roleCodes?: string[]; invitation?: { id: string } | null;
  privateFields?: Record<string, string>;
}
const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const NOW = "2026-10-13T00:00:00.000Z";

async function create(who: Identity, body: Record<string, unknown>) {
  const r = await fx.client(who).request("POST", "/api/v1/members", body, idem());
  return { status: r.status, body: (await r.json()) as { data?: MemberDto; error?: { code: string; details: { field: string; reason: string }[] } } };
}
async function list(who: Identity, query = "") {
  const r = await fx.client(who).request("GET", `/api/v1/members${query}`);
  const j = (await r.json()) as { data?: MemberDto[]; meta?: { nextCursor?: string }; error?: unknown };
  return { status: r.status, rows: j.data ?? [], next: j.meta?.nextCursor, raw: j };
}
const patch = (who: Identity, id: string, body: Record<string, unknown>) =>
  fx.client(who).request("PATCH", `/api/v1/members/${id}`, body, idem());

async function seedPrivate(memberId: string, unitId: string, fields: Record<string, string>, by: string) {
  await env.DB.prepare(
    "INSERT INTO member_private_profiles (id, unit_id, member_id, allowed_fields, created_at, updated_at, created_by, actor_kind) VALUES (?,?,?,?,?,?,?,?)",
  ).bind(crypto.randomUUID(), unitId, memberId, JSON.stringify(fields), NOW, NOW, by, "human").run();
}

describe("名簿 (T011)", () => {
  it("private_fields_never_leak_to_roster", async () => {
    const a = fx.units.a;
    const { admin, officer, operator, member, suspended } = a.people;
    // 管理者が連絡先つきで登録（登録時の入力は管理者にも許す。読み返しは別の権限）
    const made = await create(admin, {
      displayName: "架空 新規団員", status: "active", rank: "団員", squad: "2班", qualifications: ["普通救命"], joinedOn: "2022-04-01",
      privateFields: { phone: "090-0000-0001", emergencyContact: "架空 家族 090-0000-0002" },
    });
    expect(made.status).toBe(201);
    expect(made.body.data!.privateFields).toBeUndefined(); // 応答(冪等の保存対象)にも許可列を載せない
    expect(made.body.data).toMatchObject({ displayName: "架空 新規団員", squad: "2班", qualifications: ["普通救命"], joinedOn: "2022-04-01", hasAccount: false, version: 1 });

    // 本人の許可列は本人にだけ。管理者・幹部・担当者・一般団員・別unitには出ない
    await seedPrivate(member.memberId!, a.id, { phone: "090-1111-2222" }, admin.userId);
    const ofMember = (rows: MemberDto[]) => rows.find((r) => r.id === member.memberId);
    const viewers = { admin, officer, operator } as const;
    const leaked: string[] = [];
    for (const [name, who] of Object.entries(viewers)) {
      const { rows, status } = await list(who);
      expect(status, name).toBe(200);
      for (const r of rows) if (r.privateFields !== undefined) leaked.push(`${name}:${r.id}`);
    }
    const self = await list(member);
    expect(ofMember(self.rows)!.privateFields).toEqual({ phone: "090-1111-2222" });
    expect(self.rows.filter((r) => r.id !== member.memberId && r.privateFields !== undefined)).toEqual([]);
    expect(leaked).toEqual([]);
    // 別unitの名簿は見えない
    const b = await list(fx.units.b.people.admin);
    expect(b.rows.some((r) => r.id === member.memberId)).toBe(false);

    // 未知の列の更新は400、旧い版の変更は409
    const unknownColumn = await patch(admin, made.body.data!.id, { version: 1, role: "admin" });
    const unknownPrivate = await patch(member, member.memberId!, { version: 1, privateFields: { ssn: "x" } });
    expect(unknownPrivate.status).toBe(400);
    const ok = await patch(admin, made.body.data!.id, { version: 1, rank: "班長" });
    expect(ok.status).toBe(200);
    const staleEdit = await patch(admin, made.body.data!.id, { version: 1, rank: "部長" });

    // 退団は論理状態。履歴の参照（招待・監査）は残り、DBは物理削除を拒否する
    const retire = await patch(admin, made.body.data!.id, { version: 2, status: "retired" });
    expect(retire.status).toBe(200);
    await env.DB.prepare("INSERT INTO invitations (id, unit_id, member_id, kind, email_hash, token_hash, status, expires_at, intended_authz, created_at, updated_at, created_by, actor_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), a.id, made.body.data!.id, "invite", "a".repeat(64), "b".repeat(64), "pending", "2099-01-01T00:00:00.000Z", "{}", NOW, NOW, admin.userId, "human").run();
    const stillThere = await env.DB.prepare("SELECT status FROM members WHERE id = ?").bind(made.body.data!.id).first<{ status: string }>();
    const historyReferencesRemain = stillThere?.status === "retired" && (await env.DB.prepare("SELECT count(*) AS n FROM audit_logs WHERE entity_id = ?").bind(made.body.data!.id).first<{ n: number }>())!.n >= 2;
    await expect(env.DB.prepare("DELETE FROM members WHERE id = ?").bind(made.body.data!.id).run()).rejects.toThrow(/FOREIGN KEY/);

    expect(ofMember(self.rows)!.privateFields).toBeDefined();
    expect(unknownColumn.status).toBe(400);
    expect(staleEdit.status).toBe(409);
    expect(historyReferencesRemain).toBe(true);
  });

  it("scoped_holder_can_read_private_fields_and_the_view_is_audited", async () => {
    const f = await createFixture("two-units");
    const a = f.units.a;
    await seedPrivate(a.people.member.memberId!, a.id, { phone: "090-3333-4444", emergencyContact: "架空 連絡先" }, a.people.admin.userId);
    await env.DB.prepare(
      "INSERT INTO scope_assignments (id, unit_id, member_id, entity_type, entity_id, permissions, created_at, updated_at, created_by, actor_kind) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).bind(crypto.randomUUID(), a.id, a.people.officer.memberId, "member", a.people.member.memberId, '["PER-06"]', NOW, NOW, a.people.admin.userId, "human").run();
    const r = await f.client(a.people.officer).request("GET", "/api/v1/members");
    const rows = ((await r.json()) as { data: MemberDto[] }).data;
    expect(rows.find((x) => x.id === a.people.member.memberId)!.privateFields).toEqual({ phone: "090-3333-4444", emergencyContact: "架空 連絡先" });
    expect(rows.filter((x) => x.privateFields).length).toBe(1); // 担当を持つ対象だけ
    // 他人の許可列を返したことは監査に残る（内容は残さない）
    const audits = await env.DB.prepare("SELECT metadata_json, actor_user_id FROM audit_logs WHERE action = 'member.private.view' AND entity_id = ?").bind(a.people.member.memberId).all<{ metadata_json: string; actor_user_id: string }>();
    expect(audits.results).toHaveLength(1);
    expect(audits.results[0]!.actor_user_id).toBe(a.people.officer.userId);
    expect(audits.results[0]!.metadata_json).not.toContain("090");
    // 本人が自分の許可列を見ても監査は増えない
    await f.client(a.people.member).request("GET", "/api/v1/members");
    const after = await env.DB.prepare("SELECT count(*) AS n FROM audit_logs WHERE action = 'member.private.view' AND entity_id = ?").bind(a.people.member.memberId).first<{ n: number }>();
    expect(after!.n).toBe(1);
  });

  it("who_may_change_what_is_enforced_by_the_server", async () => {
    const a = fx.units.a;
    const m = (await create(a.people.admin, { displayName: "架空 権限確認", status: "active" })).body.data!;
    // 登録・基本項目の変更は管理者だけ（一般/担当者/幹部は403）
    for (const who of ["member", "operator", "officer"] as const) {
      expect((await create(a.people[who], { displayName: "x", status: "active" })).status, who).toBe(403);
      expect((await patch(a.people[who], m.id, { version: m.version, rank: "x" })).status, who).toBe(403);
    }
    // 他人の許可列は、管理者でも担当(scope)なしでは変更できない（本人は自分の分を変更できる）
    expect((await patch(a.people.admin, a.people.member.memberId!, { version: 1, privateFields: { phone: "090-9999-9999" } })).status).toBe(403);
    const own = await fx.client(a.people.member).request("GET", "/api/v1/members");
    const mine = ((await own.json()) as { data: MemberDto[] }).data.find((r) => r.id === a.people.member.memberId)!;
    const edited = await patch(a.people.member, mine.id, { version: mine.version, privateFields: { phone: "090-5555-6666" } });
    expect(edited.status).toBe(200);
    const re = ((await (await fx.client(a.people.member).request("GET", "/api/v1/members")).json()) as { data: MemberDto[] }).data.find((r) => r.id === mine.id)!;
    expect(re.privateFields).toEqual({ phone: "090-5555-6666" });
    expect(re.version).toBe(mine.version + 1);
    // 本人でも基本項目（役職）は変更できない
    expect((await patch(a.people.member, mine.id, { version: re.version, rank: "分団長" })).status).toBe(403);
    // 別unitの団員は存在を明かさず404
    expect((await patch(a.people.admin, fx.units.b.people.member.memberId!, { version: 1, rank: "x" })).status).toBe(404);
    // 許可列の削除(null)
    const removed = await patch(a.people.member, mine.id, { version: re.version, privateFields: { phone: null } });
    expect(removed.status).toBe(200);
    // 全ての許可列を削除したら、空の許可列を返さない（privateFields自体が現れない）
    const afterRemove = ((await (await fx.client(a.people.member).request("GET", "/api/v1/members")).json()) as { data: MemberDto[] }).data.find((r) => r.id === mine.id)!;
    expect(afterRemove.privateFields).toBeUndefined();
    // 監査・outboxに氏名・連絡先の本文を複製しない
    const dump = JSON.stringify([
      (await env.DB.prepare("SELECT metadata_json FROM audit_logs").all()).results,
      (await env.DB.prepare("SELECT payload_minimal FROM domain_events").all()).results,
    ]);
    for (const secret of ["架空 権限確認", "090-5555-6666", "090-9999-9999", "090-0000-0001"]) expect(dump).not.toContain(secret);
    // 在団→休団など、アカウントのある団員の状態変更は利用停止の手順(T012)で行う。ここでは拒否して成功と見せない
    const linked = await patch(a.people.admin, a.people.operator.memberId!, { version: 1, status: "paused" });
    expect(linked.status).toBe(422);
  });

  it("db_rejects_unapproved_private_columns_and_duplicate_profiles", async () => {
    const a = fx.units.a;
    const ins = (fields: unknown, memberId = a.people.suspended.memberId!) =>
      env.DB.prepare("INSERT INTO member_private_profiles (id, unit_id, member_id, allowed_fields, created_at, updated_at, created_by, actor_kind) VALUES (?,?,?,?,?,?,?,?)")
        .bind(crypto.randomUUID(), a.id, memberId, JSON.stringify(fields), NOW, NOW, a.people.admin.userId, "human").run();
    await expect(ins({ homeAddress: "x" })).rejects.toThrow(/field not allowed/); // 未承認列
    await expect(ins({ phone: 123 })).rejects.toThrow(/field not allowed/); // 型
    await expect(ins({ phone: "x".repeat(201) })).rejects.toThrow(/field not allowed/); // 長さ
    await expect(ins({ phone: "090" }, fx.units.b.people.member.memberId!)).rejects.toThrow(/FOREIGN KEY/); // 別unitの団員（複合FK）
    await ins({ phone: "090-0000-0000" });
    await expect(ins({ phone: "090-1" })).rejects.toThrow(/UNIQUE/); // 団員ごとに1件
    await expect(
      env.DB.prepare("UPDATE member_private_profiles SET allowed_fields = ? WHERE member_id = ?").bind('{"ssn":"1"}', a.people.suspended.memberId).run(),
    ).rejects.toThrow(/field not allowed/);
  });

  it("list_filters_and_keyset_paging_are_applied_on_the_server", async () => {
    const f = await createFixture("two-units");
    const admin = f.units.a.people.admin;
    for (let i = 0; i < 5; i++) {
      await f.client(admin).request("POST", "/api/v1/members", { displayName: `架空 試験${i}`, status: "active", squad: i % 2 ? "1班" : "3班", qualifications: i === 0 ? ["上級救命"] : [] }, idem());
    }
    const get = async (q: string) => {
      const r = await f.client(admin).request("GET", `/api/v1/members${q}`);
      return (await r.json()) as { data: MemberDto[]; meta: { nextCursor?: string } };
    };
    const p1 = await get("?limit=2&q=試験");
    const p2 = await get(`?limit=2&q=試験&cursor=${encodeURIComponent(p1.meta.nextCursor!)}`);
    const p3 = await get(`?limit=2&q=試験&cursor=${encodeURIComponent(p2.meta.nextCursor!)}`);
    const names = [...p1.data, ...p2.data, ...p3.data].map((r) => r.displayName);
    expect(names).toEqual(["架空 試験0", "架空 試験1", "架空 試験2", "架空 試験3", "架空 試験4"]);
    expect(p3.meta.nextCursor).toBeUndefined();
    expect((await get("?squad=3班&q=試験")).data.map((r) => r.displayName)).toEqual(["架空 試験0", "架空 試験2", "架空 試験4"]);
    expect((await get("?q=上級救命")).data.map((r) => r.displayName)).toEqual(["架空 試験0"]);
    expect((await get("?status=retired")).data).toEqual([]);
    // 同名の団員がいても、ページをまたいで重複・欠落しない（並びは名前→IDの安定したkeyset）
    for (let i = 0; i < 3; i++) await f.client(admin).request("POST", "/api/v1/members", { displayName: "架空 同名", status: "active" }, idem());
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const pg = await get(`?limit=1&q=同名${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      seen.push(...pg.data.map((r) => r.id));
      cursor = pg.meta.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect((await f.client(admin).request("GET", "/api/v1/members?cursor=not-a-cursor")).status).toBe(400);
    // 管理権を持つ者にだけ roleCodes / invitation が付く
    const adminRow = (await get("")).data.find((r) => r.id === f.units.a.people.admin.memberId)!;
    expect(adminRow.roleCodes).toEqual(["admin"]);
    const asMember = (await (await f.client(f.units.a.people.member).request("GET", "/api/v1/members")).json()) as { data: MemberDto[] };
    expect(asMember.data.every((r) => r.roleCodes === undefined && r.invitation === undefined)).toBe(true);
    // 停止ユーザーは名簿も取得できない
    expect((await f.client(f.units.a.people.suspended).request("GET", "/api/v1/members")).status).toBe(401);
  });
});
