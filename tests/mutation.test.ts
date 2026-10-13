import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import mutationSql from "./fixtures/mutation.sql?raw";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";
import { errorStatus } from "../src/shared/contracts/common";
import { HttpError } from "../src/server/http";
import { canonicalJson, canonicalRequestHash } from "../src/server/mutations/hash";
import {
  IDEMPOTENCY_TTL_MS, executeMutation, expireIdempotencyRecords, type MutationResult, type MutationSpec, type Principal,
} from "../src/server/mutations/execute";

interface IssueDto { id: string; status: string; version: number }

let fx: TestFixture;
const uuid = () => crypto.randomUUID();

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch(
    mutationSql.split(";").map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean).map((s) => env.DB.prepare(s)),
  );
  fx = await createFixture("two-units");
});

afterEach(async () => {
  // 成功でも失敗でも内部の検査行(assertion)は残らない
  const n = await env.DB.prepare("SELECT count(*) AS n FROM mutation_assertions").first<{ n: number }>();
  expect(n!.n).toBe(0);
});

const principalOf = (i: Identity, authzVersion = 1): Principal => ({
  userId: i.userId, memberId: i.memberId!, unitId: i.unitId, authzVersion,
});

async function newIssue(unitId: string, status = "reported"): Promise<string> {
  const id = uuid();
  await env.DB.prepare("INSERT INTO t_issues (id, unit_id, status) VALUES (?, ?, ?)").bind(id, unitId, status).run();
  return id;
}

interface SpecOpts {
  key?: string;
  expectedVersion?: number;
  to?: string;
  /** 失敗を注入する位置（statementsの何番目に壊れた文を挿すか） */
  failAt?: number;
  /** UPDATEで使うunit（別unitを狙う試験用） */
  updateUnit?: string;
  bodyExtra?: Record<string, unknown>;
}

async function transitionSpec(p: Principal, issueId: string, o: SpecOpts = {}): Promise<MutationSpec<IssueDto>> {
  const expectedVersion = o.expectedVersion ?? 1;
  const to = o.to ?? "under_review";
  const requestHash = await canonicalRequestHash({
    method: "PATCH", path: `/issues/${issueId}`, baseVersion: expectedVersion, body: { status: to, ...o.bodyExtra },
  });
  return {
    operationCode: "test.issue.transition",
    key: o.key ?? uuid(),
    requestHash,
    expectedAuthzVersion: p.authzVersion,
    roots: [{ table: "t_issues", id: issueId, expectedVersion }],
    statements: (ctx) => {
      const stmts = [
        env.DB.prepare(
          "UPDATE t_issues SET status = ?, version = version + 1, last_mutation_token = ? WHERE id = ? AND unit_id = ? AND version = ? AND status = 'reported'",
        ).bind(to, ctx.attempt, issueId, o.updateUnit ?? p.unitId, expectedVersion),
        env.DB.prepare(
          "INSERT INTO t_issue_events (id, issue_id, unit_id, mutation_id, from_status, to_status) VALUES (?, ?, ?, ?, 'reported', ?)",
        ).bind(uuid(), issueId, p.unitId, ctx.mutationId, to),
      ];
      if (o.failAt !== undefined) {
        // to_status のCHECKに違反する壊れた文。指定位置に挿す
        stmts.splice(
          o.failAt, 0,
          env.DB.prepare(
            "INSERT INTO t_issue_events (id, issue_id, unit_id, mutation_id, from_status, to_status) VALUES (?, ?, ?, ?, 'reported', 'INVALID')",
          ).bind(uuid(), issueId, p.unitId, ctx.mutationId),
        );
      }
      return stmts;
    },
    audit: { action: "issue.transition", entityType: "issue", entityId: issueId, metadata: { to } },
    event: { entityType: "issue", entityId: issueId, entityVersion: expectedVersion + 1, eventType: "issue.transitioned", payload: { to } },
    response: {
      status: 200,
      sql: "SELECT json_object('id', id, 'status', status, 'version', version) FROM t_issues WHERE id = ?",
      binds: [issueId],
      decode: (json) => json as IssueDto,
    },
  };
}

interface Outcome { status: number; code?: string; result?: MutationResult<IssueDto> }
async function attempt(run: () => Promise<MutationResult<IssueDto>>): Promise<Outcome> {
  try {
    const result = await run();
    return { status: result.status, result };
  } catch (e) {
    if (e instanceof HttpError) return { status: errorStatus[e.code], code: e.code };
    throw e;
  }
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
}

/** 業務の観測値。失敗した更新の前後でこれが完全に同じであること */
async function snapshot(unitId: string, issueId: string) {
  return {
    issue: await env.DB.prepare("SELECT status, version, last_mutation_token FROM t_issues WHERE id = ?").bind(issueId).first(),
    children: await count("SELECT count(*) AS n FROM t_issue_events WHERE issue_id = ?", issueId),
    audits: await count("SELECT count(*) AS n FROM audit_logs WHERE unit_id = ? AND entity_id = ?", unitId, issueId),
    events: await count("SELECT count(*) AS n FROM domain_events WHERE unit_id = ? AND entity_id = ?", unitId, issueId),
    idempotency: await count("SELECT count(*) AS n FROM idempotency_records WHERE unit_id = ?", unitId),
    sequence: (await env.DB.prepare("SELECT event_sequence AS n FROM units WHERE id = ?").bind(unitId).first<{ n: number }>())!.n,
  };
}

describe("executeMutation (T004)", () => {
  it("losing_update_leaves_no_child_audit_or_event", async () => {
    const admin = fx.units.a.people.admin;
    const p = principalOf(admin);
    const issueId = await newIssue(p.unitId);

    // 同じversionの2更新を同時に送る
    const [first, second] = await Promise.all([
      attempt(async () => executeMutation(env, p, await transitionSpec(p, issueId, { to: "under_review" }))),
      attempt(async () => executeMutation(env, p, await transitionSpec(p, issueId, { to: "in_progress" }))),
    ]);
    const statuses = [first.status, second.status];
    const childCount = await count("SELECT count(*) AS n FROM t_issue_events WHERE issue_id = ?", issueId);
    const successAuditCount = await count("SELECT count(*) AS n FROM audit_logs WHERE entity_id = ?", issueId);
    const outboxCount = await count("SELECT count(*) AS n FROM domain_events WHERE entity_id = ?", issueId);

    expect(statuses.sort()).toEqual([200, 409]);
    expect(childCount).toBe(1);
    expect(successAuditCount).toBe(1);
    expect(outboxCount).toBe(1);
    // 負けた側は競合として報告される（DB障害を409に偽装していない）
    expect([first, second].find((o) => o.status === 409)!.code).toBe("VERSION_CONFLICT");

    // 同じ鍵で別本文 → 409 IDEMPOTENCY_MISMATCH
    const key = uuid();
    const issue2 = await newIssue(p.unitId);
    await executeMutation(env, p, await transitionSpec(p, issue2, { key, to: "under_review" }));
    const mismatchedReplay = await attempt(async () => executeMutation(env, p, await transitionSpec(p, issue2, { key, to: "in_progress" })));
    expect(mismatchedReplay.status).toBe(409);
    expect(mismatchedReplay.code).toBe("IDEMPOTENCY_MISMATCH");

    // 途中のSQLが失敗したbatchは何も残さない
    const issue3 = await newIssue(p.unitId);
    const beforeFailedBatch = await snapshot(p.unitId, issue3);
    const failed = await attempt(async () => executeMutation(env, p, await transitionSpec(p, issue3, { failAt: 1 })));
    const afterFailedBatch = await snapshot(p.unitId, issue3);
    expect(failed.status).toBe(500); // 業務の競合ではなく内部障害として扱う
    expect(afterFailedBatch).toEqual(beforeFailedBatch);
  });

  it("failure_at_every_sql_position_rolls_back_everything", async () => {
    const p = principalOf(fx.units.a.people.admin);
    // statementsは [UPDATE, 子INSERT]。壊れた文を先頭/中間/末尾に挿す
    for (const failAt of [0, 1, 2]) {
      const issueId = await newIssue(p.unitId);
      const before = await snapshot(p.unitId, issueId);
      const out = await attempt(async () => executeMutation(env, p, await transitionSpec(p, issueId, { failAt })));
      expect(out.status, `failAt=${failAt}`).toBe(500);
      expect(await snapshot(p.unitId, issueId), `failAt=${failAt}`).toEqual(before);
    }
  });

  it("root_update_matching_zero_rows_is_a_conflict_and_leaves_nothing", async () => {
    const p = principalOf(fx.units.a.people.admin);
    const issueId = await newIssue(p.unitId);
    const before = await snapshot(p.unitId, issueId);
    const out = await attempt(async () => executeMutation(env, p, await transitionSpec(p, issueId, { expectedVersion: 5 })));
    expect(out).toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    expect(await snapshot(p.unitId, issueId)).toEqual(before);
  });

  it("success_writes_child_audit_event_and_idempotency_in_one_batch", async () => {
    const p = principalOf(fx.units.a.people.admin);
    const issueId = await newIssue(p.unitId);
    const seqBefore = (await snapshot(p.unitId, issueId)).sequence;
    const key = uuid();
    const res = await executeMutation(env, p, await transitionSpec(p, issueId, { key }));

    expect(res).toMatchObject({ status: 200, replayed: false, data: { id: issueId, status: "under_review", version: 2 } });
    const after = await snapshot(p.unitId, issueId);
    expect(after).toMatchObject({ children: 1, audits: 1, events: 1, sequence: seqBefore + 1 });
    const rec = (await fx.rows("idempotency_records", { actor_user_id: p.userId, idempotency_key: key }))[0]!;
    expect(rec.state).toBe("completed");
    expect(rec.response_status).toBe(200);
    // イベントは unit の連番、監査と同じ mutation_id で結ばれる
    const ev = (await fx.rows("domain_events", { entity_id: issueId }))[0]!;
    const audit = (await fx.rows("audit_logs", { entity_id: issueId }))[0]!;
    expect(ev.sequence).toBe(seqBefore + 1);
    expect(ev.mutation_id).toBe(audit.mutation_id);
    expect(audit.actor_user_id).toBe(p.userId);
  });

  it("same_key_and_body_replays_the_original_response_with_one_effect", async () => {
    const p = principalOf(fx.units.a.people.admin);
    const issueId = await newIssue(p.unitId);
    const key = uuid();
    const first = await executeMutation(env, p, await transitionSpec(p, issueId, { key }));
    // 応答が届かなかったとして同じ鍵・同じ本文で再送
    const retry = await executeMutation(env, p, await transitionSpec(p, issueId, { key }));
    expect(retry.replayed).toBe(true);
    expect(retry.status).toBe(first.status);
    expect(retry.data).toEqual(first.data);
    expect(await count("SELECT count(*) AS n FROM t_issue_events WHERE issue_id = ?", issueId)).toBe(1);
    expect(await count("SELECT count(*) AS n FROM audit_logs WHERE entity_id = ?", issueId)).toBe(1);
  });

  it("same_key_concurrent_requests_apply_the_effect_once", async () => {
    const p = principalOf(fx.units.a.people.admin);
    const issueId = await newIssue(p.unitId);
    const key = uuid();
    const [a, b] = await Promise.all([
      attempt(async () => executeMutation(env, p, await transitionSpec(p, issueId, { key }))),
      attempt(async () => executeMutation(env, p, await transitionSpec(p, issueId, { key }))),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.result!.replayed, b.result!.replayed].sort()).toEqual([false, true]);
    expect(await count("SELECT count(*) AS n FROM t_issue_events WHERE issue_id = ?", issueId)).toBe(1);
  });

  it("replay_rechecks_current_authorization_and_never_returns_stale_data", async () => {
    const p = principalOf(fx.units.a.people.officer);
    const issueId = await newIssue(p.unitId);
    const key = uuid();
    await executeMutation(env, p, await transitionSpec(p, issueId, { key }));
    // 失権（停止＋認可版の増分）
    await env.DB.prepare("UPDATE users SET status = 'disabled', disabled_at = ?, authz_version = authz_version + 1 WHERE id = ?")
      .bind("2026-10-13T01:00:00.000Z", p.userId).run();
    const out = await attempt(async () => executeMutation(env, p, await transitionSpec(p, issueId, { key })));
    expect(out).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(out.result).toBeUndefined();
  });

  it("changed_authz_version_or_suspended_user_is_forbidden_without_effects", async () => {
    // 認可判定の後に権限版が変わった
    const op = fx.units.a.people.operator;
    const p = principalOf(op);
    await env.DB.prepare("UPDATE users SET authz_version = authz_version + 1 WHERE id = ?").bind(p.userId).run();
    const issueId = await newIssue(p.unitId);
    const before = await snapshot(p.unitId, issueId);
    const out = await attempt(async () => executeMutation(env, p, await transitionSpec(p, issueId))); // p.authzVersion=1は古い
    expect(out).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await snapshot(p.unitId, issueId)).toEqual(before);

    // 停止ユーザー（fixtureでは authz_version=2）
    const suspended = principalOf(fx.units.a.people.suspended, 2);
    const out2 = await attempt(async () => executeMutation(env, suspended, await transitionSpec(suspended, issueId)));
    expect(out2).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await snapshot(p.unitId, issueId)).toEqual(before);
  });

  it("other_units_row_is_not_found_and_untouched", async () => {
    const p = principalOf(fx.units.a.people.admin);
    const issueOfB = await newIssue(fx.units.b.id);
    const before = await snapshot(fx.units.b.id, issueOfB);
    const out = await attempt(async () => executeMutation(env, p, await transitionSpec(p, issueOfB)));
    expect(out).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await snapshot(fx.units.b.id, issueOfB)).toEqual(before);
  });

  it("key_older_than_7_days_is_rejected_and_never_reexecuted", async () => {
    const p = principalOf(fx.units.a.people.admin);
    const issueId = await newIssue(p.unitId);
    const key = uuid();
    await executeMutation(env, p, await transitionSpec(p, issueId, { key }), { clock: fx.clock });
    fx.clock.advance(IDEMPOTENCY_TTL_MS + 1000);
    const out = await attempt(async () => executeMutation(env, p, await transitionSpec(p, issueId, { key }), { clock: fx.clock }));
    expect(out).toMatchObject({ status: 409, code: "IDEMPOTENCY_MISMATCH" });
    expect((await snapshot(p.unitId, issueId)).issue).toMatchObject({ version: 2 });
    expect(await count("SELECT count(*) AS n FROM t_issue_events WHERE issue_id = ?", issueId)).toBe(1);
  });

  it("extra_conditions_fail_with_their_own_code_and_leave_nothing", async () => {
    const p = principalOf(fx.units.a.people.admin);
    const issueId = await newIssue(p.unitId);
    const before = await snapshot(p.unitId, issueId);
    const spec = await transitionSpec(p, issueId);
    // 対象ユーザーの認可版が古い、のような追加検査
    spec.conditions = [{ existsSql: "SELECT 1 FROM users WHERE id = ? AND authz_version = ?", binds: [p.userId, 999], failCode: "VERSION_CONFLICT" }];
    expect(await attempt(() => executeMutation(env, p, spec))).toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    expect(await snapshot(p.unitId, issueId)).toEqual(before);
  });

  it("event_sequence_is_consecutive_per_unit", async () => {
    const p = principalOf(fx.units.b.people.admin);
    const start = (await env.DB.prepare("SELECT event_sequence AS n FROM units WHERE id = ?").bind(p.unitId).first<{ n: number }>())!.n;
    const ids = [await newIssue(p.unitId), await newIssue(p.unitId), await newIssue(p.unitId)];
    for (const id of ids) await executeMutation(env, p, await transitionSpec(p, id));
    const seqs = (await Promise.all(ids.map((id) => fx.rows("domain_events", { entity_id: id })))).map((r) => r[0]!.sequence);
    expect(seqs).toEqual([start + 1, start + 2, start + 3]);
  });

  it("audit_and_event_payloads_must_be_small_primitives_not_copies_of_the_request", async () => {
    const p = principalOf(fx.units.a.people.admin);
    const issueId = await newIssue(p.unitId);
    const before = await snapshot(p.unitId, issueId);
    const spec = await transitionSpec(p, issueId);
    spec.audit.metadata = { note: "あ".repeat(2000) }; // 本文のような長い値は監査へ複製しない
    await expect(executeMutation(env, p, spec)).rejects.toThrow(/metadata/);
    const nested = await transitionSpec(p, issueId);
    (nested.event as { payload: unknown }).payload = { body: { name: "架空 太郎" } };
    await expect(executeMutation(env, p, nested)).rejects.toThrow(/payload/);
    expect(await snapshot(p.unitId, issueId)).toEqual(before);
  });
});

describe("executeMutation review fixes (PH0 review round 1)", () => {
  it("failures_in_infrastructure_statements_also_roll_back_everything", async () => {
    const p = principalOf(fx.units.a.people.admin);
    // 基盤側の文での失敗: 監査(action長すぎ→CHECK)、event(版0→CHECK)、応答SQLがNULL(確定のCHECK)
    const cases: [string, (s: MutationSpec<IssueDto>) => void][] = [
      ["audit", (s) => { s.audit.action = "x".repeat(101); }],
      ["event", (s) => { s.event.entityVersion = 0; }],
      ["response", (s) => { s.response.sql = "SELECT NULL"; }],
    ];
    for (const [name, mutate] of cases) {
      const issueId = await newIssue(p.unitId);
      const before = await snapshot(p.unitId, issueId);
      const spec = await transitionSpec(p, issueId);
      mutate(spec);
      const out = await attempt(() => executeMutation(env, p, spec));
      expect(out.status, name).toBe(500);
      expect(await snapshot(p.unitId, issueId), name).toEqual(before);
    }
  });

  it("matching_version_but_wrong_state_is_invalid_transition_not_500", async () => {
    const p = principalOf(fx.units.a.people.admin);
    const issueId = await newIssue(p.unitId, "in_progress"); // version=1 のまま、許可された前の状態(reported)ではない
    const before = await snapshot(p.unitId, issueId);
    const out = await attempt(async () => executeMutation(env, p, await transitionSpec(p, issueId)));
    expect(out).toMatchObject({ status: 422, code: "INVALID_TRANSITION" });
    expect(await snapshot(p.unitId, issueId)).toEqual(before);
  });

  it("business_unique_violation_is_duplicate_not_500", async () => {
    const p = principalOf(fx.units.a.people.admin);
    const issueId = await newIssue(p.unitId);
    const dupId = uuid();
    await env.DB.prepare("INSERT INTO t_issue_events (id, issue_id, unit_id, mutation_id, from_status, to_status) VALUES (?, ?, ?, ?, 'reported', 'reported')")
      .bind(dupId, issueId, p.unitId, uuid()).run();
    const spec = await transitionSpec(p, issueId);
    const base = spec.statements;
    spec.statements = (ctx) => [
      ...base(ctx),
      env.DB.prepare("INSERT INTO t_issue_events (id, issue_id, unit_id, mutation_id, from_status, to_status) VALUES (?, ?, ?, ?, 'reported', 'under_review')")
        .bind(dupId, issueId, p.unitId, ctx.mutationId),
    ];
    expect(await attempt(() => executeMutation(env, p, spec))).toMatchObject({ status: 409, code: "DUPLICATE" });
  });

  it("resending_an_old_base_version_with_a_new_key_after_a_real_update_conflicts", async () => {
    const p = principalOf(fx.units.a.people.admin);
    const issueId = await newIssue(p.unitId);
    await executeMutation(env, p, await transitionSpec(p, issueId)); // v1→v2
    const out = await attempt(async () => executeMutation(env, p, await transitionSpec(p, issueId, { expectedVersion: 1 })));
    expect(out).toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
    expect(await count("SELECT count(*) AS n FROM t_issue_events WHERE issue_id = ?", issueId)).toBe(1);
  });

  it("replay_after_only_an_authz_version_bump_is_forbidden_before_revealing_mismatch", async () => {
    const op = fx.units.b.people.operator;
    const p = principalOf(op);
    const issueId = await newIssue(p.unitId);
    const key = uuid();
    await executeMutation(env, p, await transitionSpec(p, issueId, { key }));
    await env.DB.prepare("UPDATE users SET authz_version = authz_version + 1 WHERE id = ?").bind(p.userId).run();
    // 同じ本文の再送も、別本文の再送も、まず403（鍵の存在や本文の違いを明かさない）
    expect(await attempt(async () => executeMutation(env, p, await transitionSpec(p, issueId, { key })))).toMatchObject({ status: 403 });
    expect(await attempt(async () => executeMutation(env, p, await transitionSpec(p, issueId, { key, to: "in_progress" })))).toMatchObject({ status: 403 });
  });

  it("conditions_are_preconditions_evaluated_before_the_writes", async () => {
    const p = principalOf(fx.units.b.people.admin);
    const issueId = await newIssue(p.unitId);
    const spec = await transitionSpec(p, issueId);
    // statementsが status を変える行を、書込前の状態で検査する（前提条件）。書込後の状態なら偽になるはず
    spec.conditions = [{ existsSql: "SELECT 1 FROM t_issues WHERE id = ? AND status = 'reported'", binds: [issueId], failCode: "VERSION_CONFLICT" }];
    expect((await executeMutation(env, p, spec)).status).toBe(200);
  });

  it("audit_metadata_rejects_free_text_such_as_names", async () => {
    const p = principalOf(fx.units.a.people.admin);
    const spec = await transitionSpec(p, await newIssue(p.unitId));
    spec.audit.metadata = { name: "架空 太郎" };
    await expect(executeMutation(env, p, spec)).rejects.toThrow(/ID・コード形式/);
  });

  it("expired_idempotency_records_lose_their_response_body_but_keep_rejecting_the_key", async () => {
    const p = principalOf(fx.units.b.people.officer);
    const issueId = await newIssue(p.unitId);
    const key = uuid();
    fx.clock.set("2026-10-13T00:00:00.000Z");
    await executeMutation(env, p, await transitionSpec(p, issueId, { key }), { clock: fx.clock });
    fx.clock.advance(IDEMPOTENCY_TTL_MS + 1000);
    expect(await expireIdempotencyRecords(env, fx.clock.now().toISOString())).toBeGreaterThanOrEqual(1);
    const rec = (await fx.rows("idempotency_records", { actor_user_id: p.userId, idempotency_key: key }))[0]!;
    expect(rec).toMatchObject({ state: "expired", response_json: null, response_status: null });
    const out = await attempt(async () => executeMutation(env, p, await transitionSpec(p, issueId, { key }), { clock: fx.clock }));
    expect(out).toMatchObject({ status: 409, code: "IDEMPOTENCY_MISMATCH" });
  });
});

describe("canonical request hash (T004)", () => {
  it("ignores_key_order_and_whitespace_but_not_meaning", async () => {
    const base = { method: "PATCH", path: "/issues/1", baseVersion: 3, body: { a: 1, b: { c: [1, 2], d: "x" } } };
    const reordered = { ...base, body: { b: { d: "x", c: [1, 2] }, a: 1 } };
    expect(await canonicalRequestHash(base)).toBe(await canonicalRequestHash(reordered));
    expect(await canonicalRequestHash({ ...base, method: "patch", path: "/issues/1/" })).toBe(await canonicalRequestHash(base));
    // 意味が違えば別hash（method/path/baseVersion/本文/配列順）
    for (const changed of [
      { ...base, method: "PUT" }, { ...base, path: "/issues/2" }, { ...base, baseVersion: 4 },
      { ...base, body: { a: 2, b: { c: [1, 2], d: "x" } } }, { ...base, body: { a: 1, b: { c: [2, 1], d: "x" } } },
    ]) expect(await canonicalRequestHash(changed)).not.toBe(await canonicalRequestHash(base));
    expect(await canonicalRequestHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects_non_finite_numbers", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(canonicalJson({ b: undefined, a: 1 })).toBe('{"a":1}');
  });
});
