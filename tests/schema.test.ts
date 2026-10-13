import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import * as core from "../src/server/db/schema/core";
import { createFixture, type TestFixture } from "./helpers/fixture";

const NOW = "2026-10-13T00:00:00.000Z";
const uuid = () => crypto.randomUUID();

async function foreignKeyViolations() {
  const res = await env.DB.prepare("PRAGMA foreign_key_check").all();
  return res.results;
}
const run = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).run();

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

describe("core schema (T003)", () => {
  it("cross_unit_fk_and_zero_row_guard_are_enforced", async () => {
    const { a, b } = fx.units;
    const memberOfA = a.people.member.memberId!;
    const adminOfA = a.people.admin.userId;

    // 別unit(B)として、A分団の団員へ役割を付ける → 複合FKで拒否
    const crossUnitInsert = run(
      "INSERT INTO member_roles (id, unit_id, member_id, role_id, granted_by, created_at, updated_at, created_by, actor_kind) VALUES (?,?,?,?,?,?,?,?,?)",
      uuid(), b.id, memberOfA, "00000000-0000-4000-8000-000000000101", adminOfA, NOW, NOW, adminOfA, "human",
    );
    // 同じ団員×同じ役割の有効行を2件目として追加 → 部分UNIQUEで拒否（adminは既に admin role を持つ）
    const duplicateActiveRole = run(
      "INSERT INTO member_roles (id, unit_id, member_id, role_id, granted_by, created_at, updated_at, created_by, actor_kind) VALUES (?,?,?,?,?,?,?,?,?)",
      uuid(), a.id, a.people.admin.memberId, "00000000-0000-4000-8000-000000000104", adminOfA, NOW, NOW, adminOfA, "human",
    );
    // 比較更新が0行だったことを表す assertion(ok=0) → CHECKで拒否（0行更新を成功扱いにしない）
    const invalidAssertion = run("INSERT INTO mutation_assertions (attempt_token, seq, ok) VALUES (?,?,?)", uuid(), 1, 0);

    await expect(crossUnitInsert).rejects.toThrow();
    await expect(duplicateActiveRole).rejects.toThrow();
    await expect(invalidAssertion).rejects.toThrow();
    expect(await foreignKeyViolations()).toEqual([]);
  });

  it("fixture_has_two_units_four_roles_suspended_and_scopes_with_fictional_names", async () => {
    const { a, b } = fx.units;
    expect(a.id).not.toBe(b.id);
    const roles = await fx.rows("roles");
    expect(roles.map((r) => r.code).sort()).toEqual(["admin", "member", "officer", "operator"]);
    for (const unit of [a, b]) {
      const members = await fx.rows("members", { unit_id: unit.id });
      expect(members).toHaveLength(6);
      const suspended = (await fx.rows("users", { id: unit.people.suspended.userId }))[0]!;
      expect(suspended.status).toBe("disabled");
      expect(suspended.authz_version).toBe(2);
      expect(members.every((m) => String(m.display_name).startsWith("架空"))).toBe(true);
      const scopes = await fx.rows("scope_assignments", { member_id: unit.people.operator.memberId });
      expect(scopes.map((s) => s.entity_id)).toEqual([unit.scopeIn.entityId]);
      expect(scopes.map((s) => s.entity_id)).not.toContain(unit.scopeOut.entityId);
    }
    // 未登録の団員はuserを持たない
    expect((await fx.rows("members", { id: a.people.unlinked.memberId }))[0]!.user_id).toBeNull();
  });

  it("check_constraints_reject_invalid_values", async () => {
    const adminA = fx.units.a.people.admin.userId;
    const unit = fx.units.a.id;
    const member = (over: Record<string, unknown>) => {
      const v = { id: uuid(), unit_id: unit, user_id: null, display_name: "架空 追加", rank: null, joined_at: null, status: "active", created_at: NOW, updated_at: NOW, created_by: adminA, actor_kind: "human", ...over };
      return run(
        "INSERT INTO members (id, unit_id, user_id, display_name, rank, joined_at, status, created_at, updated_at, created_by, actor_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        v.id, v.unit_id, v.user_id, v.display_name, v.rank, v.joined_at, v.status, v.created_at, v.updated_at, v.created_by, v.actor_kind,
      );
    };
    await expect(member({})).resolves.toBeDefined();
    await expect(member({ status: "deleted" })).rejects.toThrow(); // 状態は列挙
    await expect(member({ created_at: "2026-10-13 00:00:00" })).rejects.toThrow(); // UTC ISO固定ms形式のみ
    await expect(member({ created_at: "2026-13-45T00:00:00.000Z" })).rejects.toThrow(); // 存在しない日付
    await expect(member({ created_at: "2026-10-13T00:00:00Z" })).rejects.toThrow(); // ミリ秒なしは正規形でない
    await expect(member({ created_by: null })).rejects.toThrow(); // humanはcreated_by必須
    await expect(member({ unit_id: uuid() })).rejects.toThrow(); // 存在しないunit
    await expect(member({ display_name: "" })).rejects.toThrow();
    // users: 停止状態と停止時刻は対
    await expect(run("INSERT INTO users (id, auth_id, status, authz_version, disabled_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", uuid(), uuid(), "disabled", 1, null, NOW, NOW)).rejects.toThrow();
    // 1 user = 1 団員
    await expect(member({ user_id: fx.units.a.people.admin.userId })).rejects.toThrow();
    // scope: permissionsはJSON配列
    await expect(run(
      "INSERT INTO scope_assignments (id, unit_id, member_id, entity_type, entity_id, permissions, created_at, updated_at, created_by, actor_kind) VALUES (?,?,?,?,?,?,?,?,?,?)",
      uuid(), unit, fx.units.a.people.member.memberId, "facility", uuid(), "not json", NOW, NOW, adminA, "human",
    )).rejects.toThrow();
    expect(await foreignKeyViolations()).toEqual([]);
  });

  it("audit_logs_and_domain_events_are_append_only", async () => {
    const adminA = fx.units.a.people.admin.userId;
    const unit = fx.units.a.id;
    const auditId = uuid();
    await run(
      "INSERT INTO audit_logs (id, unit_id, actor_kind, actor_user_id, action, entity_type, entity_id, mutation_id, occurred_at, metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
      auditId, unit, "human", adminA, "test.create", "member", uuid(), uuid(), NOW, "{}",
    );
    await expect(run("UPDATE audit_logs SET action = 'x' WHERE id = ?", auditId)).rejects.toThrow();
    await expect(run("DELETE FROM audit_logs WHERE id = ?", auditId)).rejects.toThrow();
    // humanはactor必須
    await expect(run(
      "INSERT INTO audit_logs (id, unit_id, actor_kind, actor_user_id, action, entity_type, entity_id, mutation_id, occurred_at, metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?)",
      uuid(), unit, "human", null, "test.create", "member", uuid(), uuid(), NOW, "{}",
    )).rejects.toThrow();

    const eventId = uuid();
    await run(
      "INSERT INTO domain_events (id, unit_id, mutation_id, entity_type, entity_id, entity_version, event_type, payload_minimal, sequence, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      eventId, unit, uuid(), "member", uuid(), 1, "member.created", "{}", 1_000_001, NOW,
    );
    await expect(run("DELETE FROM domain_events WHERE id = ?", eventId)).rejects.toThrow();
    // unit内で同じ sequence は使えない
    await expect(run(
      "INSERT INTO domain_events (id, unit_id, mutation_id, entity_type, entity_id, entity_version, event_type, payload_minimal, sequence, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      uuid(), unit, uuid(), "member", uuid(), 1, "member.created", "{}", 1_000_001, NOW,
    )).rejects.toThrow();
  });

  it("idempotency_records_reserve_then_complete_and_never_overwrite_key", async () => {
    const adminA = fx.units.a.people.admin.userId;
    const base = [uuid(), fx.units.a.id, adminA, "test.op", "key-1", "a".repeat(64)];
    const insert = (state: string, status: number | null, json: string | null) =>
      run(
        "INSERT INTO idempotency_records (id, unit_id, actor_user_id, operation_code, idempotency_key, canonical_request_hash, state, response_status, response_json, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        ...base.map((v, i) => (i === 0 ? uuid() : v)), state, status, json, NOW, "2026-10-20T00:00:00.000Z",
      );
    await expect(insert("reserved", null, null)).resolves.toBeDefined();
    // 同じ user+operation+key は2件目を作れない
    await expect(insert("reserved", null, null)).rejects.toThrow();
    // 予約中に応答を持てない／完了なのに応答がない、は不整合
    const other = (state: string, status: number | null, json: string | null, key: string) =>
      run(
        "INSERT INTO idempotency_records (id, unit_id, actor_user_id, operation_code, idempotency_key, canonical_request_hash, state, response_status, response_json, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        uuid(), fx.units.a.id, adminA, "test.op", key, "b".repeat(64), state, status, json, NOW, NOW,
      );
    await expect(other("reserved", 200, "{}", "k2")).rejects.toThrow();
    await expect(other("completed", null, null, "k3")).rejects.toThrow();
    await expect(other("completed", 200, '{"ok":true}', "k4")).resolves.toBeDefined();
    // 7日経過後の本文消去（expired）は許可。鍵とhashは残る
    await expect(other("expired", null, null, "k5")).resolves.toBeDefined();
  });

  it("ts_schema_columns_match_migrated_tables", async () => {
    for (const table of Object.values(core).filter((t) => typeof t === "object" && "id" in (t as object))) {
      const name = getTableName(table as never);
      const expected = Object.values(getTableColumns(table as never)).map((c) => (c as { name: string }).name).sort();
      const info = await env.DB.prepare(`PRAGMA table_info(${name})`).all();
      const actual = info.results.map((r) => String(r.name)).sort();
      expect(actual, `${name} の列がTS定義と一致しません`).toEqual(expected);
    }
  });

  it("migrations_apply_to_an_empty_db_and_are_reapplicable", async () => {
    const tables = async () =>
      (await env.DB_FRESH.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name").all()).results.map((r) => String(r.name));
    expect(await tables()).toEqual([]);
    await applyD1Migrations(env.DB_FRESH, env.TEST_MIGRATIONS);
    const first = await tables();
    expect(first).toEqual(expect.arrayContaining(["units", "users", "members", "roles", "member_roles", "scope_assignments", "idempotency_records", "mutation_assertions", "audit_logs", "domain_events"]));
    await applyD1Migrations(env.DB_FRESH, env.TEST_MIGRATIONS); // 再適用しても失敗・重複しない
    expect(await tables()).toEqual(first);
    expect((await env.DB_FRESH.prepare("SELECT count(*) AS n FROM roles").first<{ n: number }>())!.n).toBe(4);
  });
});
