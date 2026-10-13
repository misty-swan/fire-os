import { env } from "cloudflare:workers";
import {
  applyD1Migrations, createExecutionContext, createMessageBatch, createScheduledController, getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { jobs as jobsTable } from "../src/server/db/schema/jobs";
import worker, { createApp } from "../src/server/index";
import {
  JOB_LIMITS, completeJob, enqueueJob, findJob, leaseJob, type JobInput, type JobOutcome,
} from "../src/server/jobs/store";
import { clearJobHandlers, handleJob, registerJobHandler, runDueJobs } from "../src/server/jobs/runner";
import { createFixture, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
const uuid = () => crypto.randomUUID();
const iso = () => fx.clock.now().toISOString();
const seconds = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000);

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

beforeEach(async () => {
  // 他の試験のjobを拾わないよう、未完了のjobを全て取消す（lease欄もNULLに戻す）
  await env.DB.prepare(
    "UPDATE jobs SET status = 'cancelled', lease_token = NULL, lease_until = NULL WHERE status IN ('queued', 'running', 'retry_wait')",
  ).run();
  clearJobHandlers();
  fx.clock.set("2026-10-13T00:00:00.000Z");
});

const input = (over: Partial<JobInput> = {}): JobInput => ({
  unitId: fx.units.a.id,
  kind: "test.job",
  sourceType: "activity",
  sourceId: uuid(),
  sourceVersion: 1,
  configVersion: "cfg-1",
  requestedBy: fx.units.a.people.admin.userId,
  ...over,
});
const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const queueStub = () => ({ send: vi.fn(async () => {}) });

describe("persistent jobs (T006)", () => {
  it("lease_expiry_never_duplicates_effect", async () => {
    // --- 同じdedupeで2回登録しても1件 ---
    const same = input();
    const [first, second] = await Promise.all([enqueueJob(env, same, fx.clock.now()), enqueueJob(env, same, fx.clock.now())]);
    const jobCount = await count("SELECT count(*) AS n FROM jobs WHERE dedupe_key = ?", first.dedupeKey);
    expect(second.id).toBe(first.id);

    // --- 2つのrunnerが同時にleaseしても作業権は1つ ---
    const [leaseA, leaseB] = await Promise.all([leaseJob(env, iso()), leaseJob(env, iso())]);
    const activeLeaseCount = await count(
      "SELECT count(*) AS n FROM jobs WHERE id = ? AND status = 'running' AND lease_token IS NOT NULL", first.id,
    );
    expect([leaseA, leaseB].filter(Boolean)).toHaveLength(1);
    const holder = (leaseA ?? leaseB)!;
    // 取れた側の作業権がDBに記録されたもの（後勝ちで別runnerの印に上書きされていない）
    expect((await env.DB.prepare("SELECT lease_token FROM jobs WHERE id = ?").bind(first.id).first<{ lease_token: string }>())!.lease_token).toBe(holder.leaseToken);

    // --- 作業権が切れた後、古いrunnerの結果は確定できない ---
    fx.clock.advance((JOB_LIMITS.leaseSeconds + 1) * 1000);
    expect(await leaseJob(env, iso())).toBeNull(); // 期限切れはretry_waitへ戻り、待機(60秒)が明けるまでは取れない
    expect((await findJob(env, first.id))!.status).toBe("retry_wait");
    fx.clock.advance(JOB_LIMITS.retryDelaysSeconds[0]! * 1000);
    const newHolder = (await leaseJob(env, iso()))!;
    expect(newHolder.attempts).toBe(2);
    const staleLeaseCommit = await completeJob(env, holder, { kind: "succeeded", resultRef: "stale-run" }, iso());
    expect(await completeJob(env, newHolder, { kind: "succeeded", resultRef: "good-run" }, iso())).toBe(true);
    const final = (await findJob(env, first.id))!;
    expect(final.resultRef).toBe("good-run"); // 古いrunnerの結果では上書きされない

    // --- 3回失敗すると手動確認。待機は60秒→300秒 ---
    registerJobHandler("test.fail", async () => ({ kind: "retryable", errorCode: "provider_down" }));
    const failing = await enqueueJob(env, input({ kind: "test.fail" }), fx.clock.now());
    const retryDelaysSeconds: number[] = [];
    for (let i = 0; i < 3; i++) {
      const run = await runDueJobs(env, { clock: fx.clock });
      expect(run.committed).toBe(1);
      const j = (await findJob(env, failing.id))!;
      if (j.status === "retry_wait") {
        retryDelaysSeconds.push(seconds(iso(), j.nextAttemptAt));
        expect((await runDueJobs(env, { clock: fx.clock })).leased).toBe(0); // 待機中は実行しない
        fx.clock.advance(seconds(iso(), j.nextAttemptAt) * 1000);
      }
    }
    const done = (await findJob(env, failing.id))!;
    const attempts = done.attempts;

    expect(jobCount).toBe(1);
    expect(activeLeaseCount).toBe(1);
    expect(staleLeaseCommit).toBe(false);
    expect(attempts).toBe(3);
    expect(retryDelaysSeconds).toEqual([60, 300]);
    expect(done.status).toBe("manual_review");
    expect(done.errorCode).toBe("provider_down");
  });

  it("expired_lease_on_the_last_attempt_goes_to_manual_review", async () => {
    const job = await enqueueJob(env, input(), fx.clock.now());
    for (let attempt = 1; attempt <= JOB_LIMITS.maxAttempts; attempt++) {
      const leased = await leaseJob(env, iso());
      expect(leased?.attempts, `attempt ${attempt}`).toBe(attempt);
      fx.clock.advance((JOB_LIMITS.leaseSeconds + 1) * 1000); // 実行者が消えた
      await leaseJob(env, iso()); // 回収が走る
      fx.clock.advance(301 * 1000);
    }
    const j = (await findJob(env, job.id))!;
    expect(j).toMatchObject({ status: "manual_review", attempts: 3, errorCode: "lease_expired" });
    expect(await leaseJob(env, iso())).toBeNull();
  });

  it("queue_send_failure_does_not_lose_the_job_and_cron_recovers_it", async () => {
    const downQueue = { send: vi.fn(async () => { throw new Error("queue down"); }) };
    const ran: string[] = [];
    registerJobHandler("test.ok", async (job) => { ran.push(job.id); return { kind: "succeeded", resultRef: "ok-1" }; });
    const job = await enqueueJob({ DB: env.DB, JOBS_QUEUE: downQueue as never }, input({ kind: "test.ok" }), new Date());
    expect(downQueue.send).toHaveBeenCalledTimes(1);
    expect(job.status).toBe("queued"); // 送信に失敗してもD1には残る

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "* * * * *", scheduledTime: new Date() }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(ran).toEqual([job.id]);
    expect((await findJob(env, job.id))).toMatchObject({ status: "succeeded", resultRef: "ok-1" });
  });

  it("cron_keeps_recovering_jobs_even_if_the_idempotency_expiry_fails", async () => {
    const ran: string[] = [];
    registerJobHandler("test.ok", async (job) => { ran.push(job.id); return { kind: "succeeded" }; });
    const job = await enqueueJob(env, input({ kind: "test.ok" }), new Date());
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.startsWith("UPDATE idempotency_records")) throw new Error("D1 temporarily unavailable");
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "* * * * *", scheduledTime: new Date() }), { ...env, DB: db } as typeof env, ctx);
    await waitOnExecutionContext(ctx);
    expect(ran).toEqual([job.id]);
  });

  it("enqueue_sends_job_id_only_and_does_not_resend_duplicates", async () => {
    const queue = queueStub();
    const e = { DB: env.DB, JOBS_QUEUE: queue as never };
    const i = input();
    const a = await enqueueJob(e, i, fx.clock.now());
    await enqueueJob(e, i, fx.clock.now());
    expect(queue.send).toHaveBeenCalledTimes(1);
    expect(queue.send).toHaveBeenCalledWith({ jobId: a.id }); // 内容・個人情報・Secretは載せない
  });

  it("queue_consumer_runs_due_jobs_and_acks", async () => {
    registerJobHandler("test.ok", async () => ({ kind: "succeeded", resultRef: "q-1" }));
    const job = await enqueueJob(env, input({ kind: "test.ok" }), new Date());
    const batch = createMessageBatch("fireos-local-jobs", [{ id: "m1", timestamp: new Date(), attempts: 1, body: { jobId: job.id } }]);
    const ctx = createExecutionContext();
    await worker.queue(batch as never, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["m1"]);
    expect((await findJob(env, job.id))!.status).toBe("succeeded");
    // 同じメッセージが再配送されても効果は増えない（実行対象が無いだけ）
    const again = createMessageBatch("fireos-local-jobs", [{ id: "m2", timestamp: new Date(), attempts: 2, body: { jobId: job.id } }]);
    const ctx2 = createExecutionContext();
    await worker.queue(again as never, env, ctx2);
    expect((await getQueueResult(again, ctx2)).explicitAcks).toEqual(["m2"]);
    expect((await findJob(env, job.id))!.attempts).toBe(1);
  });

  it("handler_timeout_exception_and_unknown_kind_are_handled_without_leaking_details", async () => {
    registerJobHandler("test.hang", () => new Promise(() => {}));
    registerJobHandler("test.throw", async () => { throw new Error("secret internal detail: SELECT * FROM users"); });
    const outcomes: Record<string, JobOutcome> = {};
    for (const kind of ["test.hang", "test.throw", "test.unregistered"]) {
      const job = await enqueueJob(env, input({ kind }), fx.clock.now());
      const leased = (await leaseJob(env, iso()))!;
      outcomes[kind] = await handleJob(leased, env, { timeoutMs: 20 });
      await completeJob(env, leased, outcomes[kind]!, iso());
      const row = (await findJob(env, job.id))!;
      expect(JSON.stringify(row)).not.toContain("secret internal detail");
    }
    expect(outcomes["test.hang"]).toEqual({ kind: "retryable", errorCode: "timeout" });
    expect(outcomes["test.throw"]).toEqual({ kind: "retryable", errorCode: "handler_error" });
    expect(outcomes["test.unregistered"]).toEqual({ kind: "manual_review", errorCode: "unknown_kind" });
  });

  it("outcomes_map_to_states_and_a_job_cannot_be_completed_twice", async () => {
    const cases: [JobOutcome, string][] = [
      [{ kind: "succeeded", resultRef: "r" }, "succeeded"],
      [{ kind: "stale", errorCode: "source_changed" }, "stale"],
      [{ kind: "manual_review", errorCode: "needs_human" }, "manual_review"],
      [{ kind: "retryable", errorCode: "temp" }, "retry_wait"],
    ];
    for (const [outcome, expected] of cases) {
      await enqueueJob(env, input(), fx.clock.now());
      const leased = (await leaseJob(env, iso()))!;
      expect(await completeJob(env, leased, outcome, iso())).toBe(true);
      expect((await findJob(env, leased.id))!.status).toBe(expected);
      expect(await completeJob(env, leased, outcome, iso())).toBe(false); // 二重確定は不可
      const row = (await env.DB.prepare("SELECT lease_token, lease_until FROM jobs WHERE id = ?").bind(leased.id).first())!;
      expect(row).toEqual({ lease_token: null, lease_until: null });
    }
  });

  it("handler_error_codes_are_sanitized_and_dedupe_does_not_cross_units", async () => {
    registerJobHandler("test.leaky", async () => ({ kind: "retryable", errorCode: "SELECT * FROM users failed: secret" }));
    registerJobHandler("test.bigref", async () => ({ kind: "succeeded", resultRef: "r".repeat(501) }));
    const leaky = await enqueueJob(env, input({ kind: "test.leaky" }), fx.clock.now());
    const big = await enqueueJob(env, input({ kind: "test.bigref" }), fx.clock.now());
    const run = await runDueJobs(env, { clock: fx.clock });
    expect(run.committed).toBe(2); // 不正な値でもループは止まらず確定できる
    expect((await findJob(env, leaky.id))!.errorCode).toBe("invalid_error_code");
    expect((await findJob(env, big.id))).toMatchObject({ status: "manual_review", errorCode: "invalid_result_ref" });
    // 独自のdedupeKeyはunitで始める決まり。守らないと登録できない（別unitと衝突して黙って抜けるのを防ぐ）
    await expect(enqueueJob(env, input({ dedupeKey: "custom-key-1" }), fx.clock.now())).rejects.toThrow(/unitId/);
    const ok = await enqueueJob(env, input({ dedupeKey: `${fx.units.a.id}|custom-key-1` }), fx.clock.now());
    expect(ok.unitId).toBe(fx.units.a.id);
  });

  it("one_failing_completion_does_not_stop_the_rest_of_the_run", async () => {
    registerJobHandler("test.ok", async () => ({ kind: "succeeded", resultRef: "ok" }));
    const a = await enqueueJob(env, input({ kind: "test.ok" }), fx.clock.now());
    const b = await enqueueJob(env, input({ kind: "test.ok" }), fx.clock.now());
    // 最初の確定(UPDATE ... 'succeeded')だけDB障害にする
    let failOnce = true;
    const db = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (failOnce && sql.includes("status = 'succeeded'")) {
              failOnce = false;
              throw new Error("D1 temporarily unavailable");
            }
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const run = await runDueJobs({ ...env, DB: db } as typeof env, { clock: fx.clock });
    expect(run).toMatchObject({ leased: 2, committed: 1, rejected: 1 });
    const statuses = [(await findJob(env, a.id))!.status, (await findJob(env, b.id))!.status].sort();
    expect(statuses).toEqual(["running", "succeeded"]); // 失敗した方は作業権の期限切れ後に回収される
  });

  it("a_late_runner_cannot_commit_even_before_the_reaper_runs", async () => {
    await enqueueJob(env, input(), fx.clock.now());
    const leased = (await leaseJob(env, iso()))!;
    fx.clock.advance((JOB_LIMITS.leaseSeconds + 1) * 1000);
    // 回収(leaseJob)が走る前でも、期限を過ぎた作業権では確定できない
    expect(await completeJob(env, leased, { kind: "succeeded" }, iso())).toBe(false);
  });

  it("db_constraints_keep_lease_and_attempts_consistent", async () => {
    const job = await enqueueJob(env, input(), fx.clock.now());
    const bad = (sql: string) => expect(env.DB.prepare(sql).bind(job.id).run()).rejects.toThrow();
    await bad("UPDATE jobs SET status = 'running' WHERE id = ?"); // 実行中なのに作業権なし
    await bad("UPDATE jobs SET lease_token = 'x' WHERE id = ?"); // 実行中でないのに作業権あり
    await bad("UPDATE jobs SET attempts = 4 WHERE id = ?"); // 上限超過
    await bad("UPDATE jobs SET status = 'done' WHERE id = ?"); // 状態は列挙
    await bad("UPDATE jobs SET next_attempt_at = '2026-10-13 00:00:00' WHERE id = ?");
  });

  it("ts_schema_matches_migrated_jobs_table", async () => {
    const info = await env.DB.prepare(`PRAGMA table_info(${getTableName(jobsTable)})`).all();
    expect(info.results.map((r) => String(r.name)).sort()).toEqual(
      Object.values(getTableColumns(jobsTable)).map((c) => c.name).sort(),
    );
  });
});

describe("GET /api/v1/jobs/:id (API-86)", () => {
  const get = (identity: Parameters<TestFixture["client"]>[0] | null, id: string) =>
    identity
      ? fx.client(identity).request("GET", `/api/v1/jobs/${id}`)
      : worker.fetch(new Request(`http://example.com/api/v1/jobs/${id}`), env, createExecutionContext());

  it("only_the_requester_can_read_status_and_the_response_has_no_internal_fields", async () => {
    registerJobHandler("test.fail", async () => ({ kind: "retryable", errorCode: "provider_down" }));
    const job = await enqueueJob(env, input({ kind: "test.fail" }), new Date());
    await runDueJobs(env); // 1回失敗させる

    const res = await get(fx.units.a.people.admin, job.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>; meta: { requestId: string } };
    expect(Object.keys(body.data).sort()).toEqual(["attempts", "errorCode", "id", "resultRef", "status"]);
    expect(body.data).toMatchObject({ id: job.id, status: "retry_wait", attempts: 1, errorCode: "provider_down", resultRef: null });
    expect(JSON.stringify(body)).not.toMatch(/lease|dedupe|source|config|requested|unit_id/i);

    // 依頼者以外（同じunitの幹部）・他unitの管理者には存在も明かさない
    expect((await get(fx.units.a.people.officer, job.id)).status).toBe(404);
    expect((await get(fx.units.b.people.admin, job.id)).status).toBe(404);
    expect((await get(fx.units.a.people.admin, uuid())).status).toBe(404);
    // 未認証・不正ID
    expect((await get(null, job.id)).status).toBe(401);
    expect((await get(fx.units.a.people.admin, "not-a-uuid")).status).toBe(400);
  });

  it("test_identity_injection_is_ignored_outside_local_test_mode", async () => {
    const job = await enqueueJob(env, input(), new Date());
    const req = () => new Request(`http://example.com/api/v1/jobs/${job.id}`, {
      headers: { "x-test-identity": JSON.stringify({ userId: fx.units.a.people.admin.userId }) },
    });
    for (const override of [{ APP_ENV: "production" }, { APP_ENV: "staging" }, { TEST_AUTH: undefined }]) {
      const e = { ...env, ...override } as typeof env;
      const res = await createApp(e).fetch(req(), e, createExecutionContext());
      expect(res.status, JSON.stringify(override)).toBe(401);
    }
    // 停止ユーザーは注入しても通らない
    const suspended = fx.units.a.people.suspended;
    expect((await get(suspended, job.id)).status).toBe(401);
    // 分団(unit)が停止されていても通らない
    await env.DB.prepare("UPDATE units SET status = 'disabled' WHERE id = ?").bind(fx.units.a.id).run();
    expect((await get(fx.units.a.people.admin, job.id)).status).toBe(401);
    await env.DB.prepare("UPDATE units SET status = 'active' WHERE id = ?").bind(fx.units.a.id).run();
  });
});
