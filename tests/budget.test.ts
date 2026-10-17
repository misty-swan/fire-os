import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../src/server/env";
import "../src/server/jobs/handlers/classification"; // 分類job handlerの登録（Cron/Queueと同じ登録点）
import { runDueJobs } from "../src/server/jobs/runner";
import {
  applyBudgetDecision,
  buildUsageSnapshot,
  evaluateBudget,
  expensiveCallGate,
  readPersistedBudgetState,
  type UsageSnapshot,
} from "../src/server/observability/budget";
import { recordMetric } from "../src/server/observability/metrics";
import { BUDGET_POLICY } from "../src/shared/budget-policy";
import { FICTIONAL } from "./fixtures/core";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

/**
 * メトリクス・課金予兆・上限停止（T080、docs/07 §8、docs/14 D11、docs/08 AT-NFR-08）。
 *
 * - 「止めるべきときに高価な呼び出しが止まり、止めても既存の記録が読める」ことを試す。
 *   使用量の記録はD1（0032 usage_metrics。Workers/D1/R2/AI/Maps/通知を別計上）で行い、
 *   Analytics Engine等の新bindingは使わない（4環境へのbinding追加はT080の範囲外）。
 * - unknown（計測できない使用量）を0と偽装しない: amount=NULLで保存し、合計にも数えない
 *   （unknownUsageMarkedZero=false。Workers/D1/Maps等はアプリ内では計測できず、実Cloudflareの
 *   ダッシュボード/請求での確認になる。実provider請求との照合は未実施＝実Cloudflare未接続）。
 * - メトリクスに個人情報を載せない（piiInMetrics=[]）: fixtureのUUID・氏名・本文が
 *   usage_metrics/budget_stateのどこにも現れないことを全行で検査する。
 * - アラートの自動送信は作らない（通知送信は本文/対象の明示承認を要するため）。
 *   代わりに監査ログへの記録＋管理画面の表示＋ops/cost-alerts.mdの手順（人が運用する）。
 *   「アラート送信失敗」の注入は、この記録経路（監査/状態書込）が失敗しても停止状態が壊れないこと
 *   （判定→適用を1つのD1 batchで原子的に行う。失敗時に半適用・失敗attemptの残留がない）を検査する。
 * - 停止はAI分類・報告書生成等の高価な呼び出しだけに効く（既存記録の読取は止めない）。
 *   解除は手順（ops/cost-alerts.mdのD1更新コマンド）。手動停止（source=manual）は評価が正常に
 *   なっても自動解除しない。自動停止（source=auto）は使用量が枠内に戻った評価で解ける。
 */

let fx: TestFixture;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

beforeEach(async () => {
  // 他の試験のjobを拾わないよう、未完了のjobを全て取消す（tests/jev.test.tsと同じ流儀）
  await env.DB.prepare(
    "UPDATE jobs SET status = 'cancelled', lease_token = NULL, lease_until = NULL WHERE status IN ('queued', 'running', 'retry_wait')",
  ).run();
  // jobの受付時刻（next_attempt_at）はenqueueJobの既定＝実時刻で記録されるため、runner用の
  // 固定クロックは実時刻より先に置く（tests/jev.test.tsと同じ流儀）
  fx.clock.set(new Date(Date.now() + 3_600_000).toISOString()); // 実時刻+1時間
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) => (await r.json()) as { data?: unknown; error?: { code: string } };

// --- 源データ（tests/jev.test.tsと同じ既存経路だけを使う） ---

const seedFacility = async (unitId: string, by: string): Promise<string> => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO facilities (id, unit_id, type, management_number, latitude, longitude, location_note, location_source, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, 'hydrant', ?, 35, 139, 'x', '架空台帳', ?, ?, ?, 'human')",
  ).bind(id, unitId, `F-${id.slice(0, 6)}`, now, now, by).run();
  return id;
};

const createIssue = async (who: Identity, title: string): Promise<{ id: string; version: number }> => {
  const facilityId = await seedFacility(who.unitId, who.userId!);
  const res = await fx.client(who).request("POST", "/api/v1/issues", {
    target: { type: "facility", id: facilityId }, title, description: "格納箱の前に資材が置かれていた（架空）", attachmentIds: [],
  }, idem());
  expect(res.status, "異常の起票に失敗").toBe(201);
  const data = ((await json(res)).data!) as { id: string; version: number };
  return { id: data.id, version: data.version };
};

const postClassification = async (who: Identity, sourceId: string, sourceVersion: number) =>
  fx.client(who).request("POST", "/api/v1/ai/classifications", {
    sourceType: "issue", sourceId, sourceVersion, questionVersion: "v1",
  }, idem());

interface JevCall { model: string; input: { state?: unknown; questions?: unknown } }

/** Jevの戻り値形を模倣するfake（呼出しを記録。tests/jev.test.tsと同じ流儀） */
const fakeAi = (respond: (call: JevCall, index: number) => unknown, calls: JevCall[] = []): NonNullable<AppEnv["AI"]> =>
  ({
    run: async (model: string, input: { state: unknown; questions: unknown }) => {
      calls.push({ model, input });
      return respond({ model, input }, calls.length - 1);
    },
  }) as unknown as NonNullable<AppEnv["AI"]>;

const runJobsWithAi = async (ai: NonNullable<AppEnv["AI"]> | undefined) =>
  runDueJobs({ ...env, AI: ai } as typeof env, { clock: fx.clock });

const okAnswer = () => ({
  model: "jev-fake@2026-10-17",
  answers: {
    category: { choice: "no_issue", probabilities: { no_issue: 0.9, other: 0.1 }, confidence: 0.9 },
    needs_check: { noul: 0.1 },
  },
  usage: { prompt_tokens: 120, completion_tokens: 8 },
});

// --- 計上の読み取り ---

const knownSum = async (service: string, metric: string): Promise<number> =>
  (await env.DB.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS n FROM usage_metrics WHERE service = ? AND metric = ? AND amount_known = 1",
  ).bind(service, metric).first<{ n: number }>())!.n;

const unknownRowCount = async (): Promise<number> =>
  (await env.DB.prepare("SELECT count(*) AS n FROM usage_metrics WHERE amount_known = 0").first<{ n: number }>())!.n;

const budgetAuditRows = async (action: string) => fx.rows("audit_logs", { action, entity_type: "budget" });

/** メトリクス/状態の全行をテキスト化してPII（UUID・氏名・本文）を探す */
const collectMetricTexts = async (): Promise<string[]> => {
  const metrics = (await env.DB.prepare("SELECT * FROM usage_metrics").all<Record<string, unknown>>()).results;
  const states = (await env.DB.prepare("SELECT * FROM budget_state").all<Record<string, unknown>>()).results;
  return [...metrics, ...states].map((r) => JSON.stringify(r));
};

const piiStrings = (): string[] => {
  const a = fx.units.a;
  return [
    ...Object.values(a.people).flatMap((p) => [p.memberId ?? "", p.userId ?? ""]),
    ...Object.values(FICTIONAL.people).map((p) => p.displayName),
    "格納箱の前に資材が置かれていた（架空）",
    "予算試験の異常（架空）",
  ].filter((s) => s.length > 0);
};

describe("メトリクス・課金予兆・上限停止 (T080)", () => {
  it("metrics_reject_free_text_and_record_provider_rate_limits", async () => {
    // 入力の検査: 自由文（氏名・本文が載り得るもの）・負の量・未知のservice・費用の直接計上を拒否する。
    // 費用はメトリクスに直接載せず、BudgetStateがcostSource付きの試算として出す（勝手に推計しない）
    await expect(recordMetric(env, { service: "ai", metric: "メモ: 対象の団員と本文", unit: "count", amount: 1 })).rejects.toThrow();
    await expect(recordMetric(env, { service: "ai", metric: "ai.calls", unit: "count", amount: -1 })).rejects.toThrow();
    await expect(recordMetric(env, { service: "ai", metric: "ai.cost_usd" as never, unit: "usd" as never, amount: 1 })).rejects.toThrow();
    await expect(recordMetric(env, { service: "no-such-service" as never, metric: "x", unit: "count", amount: 1 })).rejects.toThrow();

    // unknownはNULLで保存する（0と偽装しない）。knownの0は「測った結果0」なので許す
    await recordMetric(env, { service: "maps", metric: "maps.loads", unit: "count", amount: null, source: "unmeasured:dashboard-only" });
    const unknownRow = (await env.DB.prepare("SELECT amount, amount_known, unit FROM usage_metrics WHERE service = 'maps'").first<{ amount: number | null; amount_known: number; unit: string }>())!;
    expect(unknownRow.amount).toBeNull();
    expect(unknownRow.amount_known).toBe(0);
    const snapshot = await buildUsageSnapshot(env);
    expect(snapshot.unknownRows).toBeGreaterThanOrEqual(1); // 合計には数えない（別枠で見える）

    // 429（providerの応答制限）の記録経路: 呼出し試行は計上し、制限エラーは別metricになる。
    // 呼出し自体がbusinessを壊さない（jobはretry_waitで再試行。usageの記録失敗でも成果は変わらない）
    const a = fx.units.a;
    const admin = a.people.admin;
    const issue = await createIssue(admin, "429記録の試験用（架空）");
    const res = await postClassification(admin, issue.id, issue.version);
    expect(res.status).toBe(202);
    const callsBefore = await knownSum("ai", "ai.calls");
    const rateLimitedBefore = await knownSum("ai", "ai.rate_limited");
    const summary = await runJobsWithAi(fakeAi(() => {
      throw new Error("429 rate limited (fake provider)");
    }));
    expect(summary.committed).toBe(1);
    const jobRow = (await env.DB.prepare("SELECT status, error_code FROM jobs WHERE id = ?").bind(((await json(res)).data! as { id: string }).id).first<{ status: string; error_code: string | null }>())!;
    expect(jobRow.status).toBe("retry_wait"); // 一時失敗は再試行（docs/11）
    expect(jobRow.error_code).toBe("ai_run_failed");
    expect(await knownSum("ai", "ai.calls")).toBe(callsBefore + 1); // 試行は1回
    expect(await knownSum("ai", "ai.rate_limited")).toBe(rateLimitedBefore + 1);
  });

  it("budget_exhaustion_stops_optional_inference_but_preserves_saved_records", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;

    // --- 想定通常量の記録（1日分の通常運転を計上。serviceごとに別計上） ---
    const callsAtStart = await knownSum("ai", "ai.calls");
    const tokensAtStart = await knownSum("ai", "ai.tokens.input");
    await recordMetric(env, { service: "ai", metric: "ai.calls", unit: "count", amount: 30, source: "seed:normal-day" });
    await recordMetric(env, { service: "ai", metric: "ai.tokens.input", unit: "tokens", amount: 36_000, source: "seed:normal-day" });
    await recordMetric(env, { service: "notification", metric: "notification.deliveries", unit: "count", amount: 50, source: "seed:normal-day" });
    await recordMetric(env, { service: "r2", metric: "r2.bytes.stored", unit: "bytes", amount: 2_097_152, source: "seed:normal-day" });
    // unknown（WorkersのCPU/リクエストはアプリ内では計測できない。0と偽装せずNULLで記録する）
    await recordMetric(env, { service: "workers", metric: "workers.cpu_ms", unit: "ms", amount: null, source: "unmeasured:dashboard-only" });
    // usage未知のAI呼出し（usageを返さないモデル/失敗。tokensの合計には数えない）
    await recordMetric(env, { service: "ai", metric: "ai.tokens.input", unit: "tokens", amount: null, source: "seed:usage-unknown" });

    const snapshot = await buildUsageSnapshot(env);
    expect(snapshot.aiCallsKnown).toBe(callsAtStart + 30);
    expect(snapshot.aiTokensInput).toBe(tokensAtStart + 36_000); // unknown分は合計に偽装されない
    expect(snapshot.notifications).toBe(50);
    expect(snapshot.r2BytesStored).toBe(2_097_152);
    expect(snapshot.unmeasuredServices).toContain("workers");
    expect(snapshot.unknownRows).toBeGreaterThanOrEqual(2);

    const normal = evaluateBudget(snapshot, BUDGET_POLICY);
    expect(normal.status).toBe("normal");
    expect(normal.expensiveCallsAllowed).toBe(true);
    expect(normal.usageComplete).toBe(false); // Workers等の未計測があるので「計測は不完全」
    expect(normal.unknownUsageCount).toBeGreaterThanOrEqual(2);
    expect(normal.costEstimateUsd).not.toBeNull();
    expect(normal.costSource).toContain("実請求とは照合していません"); // provider請求との照合は未実施

    // --- 急増/429/日次枠/費用の注入（evaluateBudgetへの注入。閾値はpolicyで決まる） ---
    const prior = Array.from({ length: BUDGET_POLICY.spikeWindowDays }, (_, i) => ({
      day: `2026-10-${String(5 + i).padStart(2, "0")}`, known: 10,
    }));
    const spike = evaluateBudget({ ...snapshot, aiCallsKnown: BUDGET_POLICY.spikeFactor * 10 + 5, priorAiCalls: prior }, BUDGET_POLICY);
    expect(spike.reasons).toContain("ai_calls_spike");
    expect(spike.status).toBe("warn"); // 急増は予兆（アラート対象。停止にしない）
    expect(spike.expensiveCallsAllowed).toBe(true);
    // 検出能力の対照: 少量（しきい値未満）では急増判定を出さない
    const calm = evaluateBudget({ ...snapshot, aiCallsKnown: 5, priorAiCalls: prior }, BUDGET_POLICY);
    expect(calm.reasons).not.toContain("ai_calls_spike");

    const capped = evaluateBudget({ ...snapshot, aiCallsKnown: BUDGET_POLICY.dailyAiCallCap + 1 }, BUDGET_POLICY);
    expect(capped.status).toBe("stopped"); // 日次枠の超過は停止
    expect(capped.reasons).toContain("daily_ai_calls_over");
    expect(capped.expensiveCallsAllowed).toBe(false);

    const limited = evaluateBudget({ ...snapshot, aiRateLimited: BUDGET_POLICY.maxRateLimitedPerDay + 1 }, BUDGET_POLICY);
    expect(limited.status).toBe("stopped"); // 429の多発は停止
    expect(limited.reasons).toContain("ai_rate_limited_over");

    const costly = evaluateBudget({ ...snapshot, aiTokensInput: 200_000_000 }, BUDGET_POLICY); // 単価固定分のみの下限試算
    expect(costly.reasons).toContain("monthly_cost_estimate_over");
    expect(costly.expensiveCallsAllowed).toBe(false);

    // --- 停止前の対照: 通常量では分類が成功し、使用量が計上される ---
    const callsBeforeSuccess = await knownSum("ai", "ai.calls");
    const issue = await createIssue(admin, "予算試験の異常（架空）");
    const res = await postClassification(admin, issue.id, issue.version);
    expect(res.status).toBe(202);
    const job1 = ((await json(res)).data!) as { id: string };
    const aiCalls: JevCall[] = [];
    expect((await runJobsWithAi(fakeAi(() => okAnswer(), aiCalls))).committed).toBe(1);
    expect(aiCalls).toHaveLength(1);
    expect((await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(job1.id).first<{ status: string }>())!.status).toBe("succeeded");
    expect(await knownSum("ai", "ai.calls")).toBe(callsBeforeSuccess + 1); // 呼出しの試行が計上される
    const savedTokens = (await env.DB.prepare(
      "SELECT COALESCE(SUM(amount), 0) AS n FROM usage_metrics WHERE service = 'ai' AND metric = 'ai.tokens.input' AND amount_known = 1",
    ).first<{ n: number }>())!.n;
    expect(savedTokens).toBe(tokensAtStart + 36_000 + 120); // usage既知のtokensが計上される

    // --- 「アラート送信失敗」の注入: 記録経路（監査）が失敗しても停止状態は壊れない ---
    // 公開demo攻撃相当の急増（日次枠を超える量。usage計上のInterface経由で注入する）
    await recordMetric(env, { service: "ai", metric: "ai.calls", unit: "count", amount: BUDGET_POLICY.dailyAiCallCap, source: "seed:demo-burst" });
    const stoppedDecision = evaluateBudget(await buildUsageSnapshot(env), BUDGET_POLICY);
    expect(stoppedDecision.status).toBe("stopped");
    await env.DB.prepare(
      "CREATE TRIGGER budget_test_fail_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    ).run();
    await expect(applyBudgetDecision(env, { decision: stoppedDecision, source: "auto", auditUnitId: a.id, note: "test:stop" }))
      .rejects.toThrow(); // 監査へ書けないときは判定の適用ごと失敗する（半適用を作らない）
    // 状態は壊れていない: 停止はしていない（ゲートの評価が書いたnormal行のみ）し、監査も増えていない
    expect((await readPersistedBudgetState(env))?.status ?? "normal").toBe("normal");
    expect(await budgetAuditRows("budget.stop")).toHaveLength(0);
    await env.DB.prepare("DROP TRIGGER budget_test_fail_audit").run();
    // 再適用は成功し、失敗attemptの残留がない（budget.stopの監査は1本だけ）
    const applied = await applyBudgetDecision(env, { decision: stoppedDecision, source: "auto", auditUnitId: a.id, note: "test:stop" });
    expect(applied.changed).toBe(true);
    expect((await readPersistedBudgetState(env))!.status).toBe("stopped");
    const stopRows = await budgetAuditRows("budget.stop");
    expect(stopRows).toHaveLength(1);
    expect(stopRows[0]!.actor_kind).toBe("system");
    expect(JSON.parse(stopRows[0]!.metadata_json as string)).toMatchObject({ to: "stopped" });
    // 再適用は冪等（停止済みで同じ判定なら監査を増やさない）
    expect((await applyBudgetDecision(env, { decision: stoppedDecision, source: "auto", auditUnitId: a.id, note: "test:stop" })).changed).toBe(false);
    expect(await budgetAuditRows("budget.stop")).toHaveLength(1);

    // --- 停止後の高価な呼び出しは0（既存の記録の読取は止まらない） ---
    const callsAtStop = await knownSum("ai", "ai.calls");
    const aiCallsAtStop = aiCalls.length;
    const issue2 = await createIssue(admin, "停止中の異常（架空）");
    const res2 = await postClassification(admin, issue2.id, issue2.version);
    expect(res2.status).toBe(202);
    const job2 = ((await json(res2)).data!) as { id: string };
    expect((await runJobsWithAi(fakeAi(() => okAnswer(), aiCalls))).committed).toBe(1);
    expect((await env.DB.prepare("SELECT status, error_code FROM jobs WHERE id = ?").bind(job2.id).first<{ status: string; error_code: string | null }>())!)
      .toMatchObject({ status: "manual_review", error_code: "budget_stopped" }); // 呼ばずに保留（AIだけでは決めない語彙）
    const expensiveCallsAfterLimit = aiCalls.length - aiCallsAtStop + (await knownSum("ai", "ai.calls") - callsAtStop);
    expect(expensiveCallsAfterLimit).toBe(0);

    // 既存の記録（保存済みの候補・実行履歴・監査・活動）は停止中も読める
    const candidateList = await fx.client(admin).request("GET", "/api/v1/ai/reviews?status=pending", undefined, idem());
    expect(candidateList.status).toBe(200);
    const candidates = ((await json(candidateList)).data!) as { id: string }[];
    expect(candidates.length).toBeGreaterThanOrEqual(1); // 停止前に保存した候補
    const runsList = await fx.client(admin).request("GET", "/api/v1/ai/evaluation-runs", undefined, idem());
    expect(runsList.status).toBe(200);
    const auditList = await fx.client(admin).request("GET", "/api/v1/audit-logs?entityType=budget", undefined, idem());
    expect(auditList.status).toBe(200);
    expect((((await json(auditList)).data!) as { action: string }[]).some((r) => r.action === "budget.stop")).toBe(true);
    const activityList = await fx.client(admin).request("GET", "/api/v1/activities", undefined, idem());
    expect(activityList.status).toBe(200);
    const existingRecordsReadable =
      candidateList.status === 200 && runsList.status === 200 && auditList.status === 200 && activityList.status === 200;
    expect(existingRecordsReadable).toBe(true);

    // --- unknown使用量は0と偽装されていない & PIIはメトリクスに載っていない ---
    const unknownRows = (await env.DB.prepare("SELECT amount FROM usage_metrics WHERE amount_known = 0").all<{ amount: number | null }>()).results;
    expect(unknownRows.length).toBeGreaterThanOrEqual(2);
    expect(unknownRows.every((r) => r.amount === null)).toBe(true); // unknownUsageMarkedZero=false
    const texts = await collectMetricTexts();
    const piiInMetrics = texts.filter((t) => piiStrings().some((s) => t.includes(s)));
    expect(piiInMetrics).toEqual([]);

    // --- 自動停止は使用量が枠内に戻る評価で解ける（翌日の使用量0として評価） ---
    const tomorrow = new Date(Date.now() + 48 * 3_600_000);
    const nextDayDecision = evaluateBudget(await buildUsageSnapshot(env, { now: tomorrow }), BUDGET_POLICY);
    expect(nextDayDecision.status).toBe("normal");
    const resumed = await applyBudgetDecision(env, { decision: nextDayDecision, source: "auto", auditUnitId: a.id, note: "test:resume" });
    expect(resumed.changed).toBe(true);
    expect(resumed.state.status).toBe("normal");
    expect(await budgetAuditRows("budget.resume")).toHaveLength(1);

    // --- 手動停止（運用手順による停止）は評価が正常でも自動解除しない。解除は手順 ---
    await recordMetric(env, { service: "ai", metric: "ai.calls", unit: "count", amount: BUDGET_POLICY.dailyAiCallCap, source: "seed:demo-burst" });
    await applyBudgetDecision(env, { decision: evaluateBudget(await buildUsageSnapshot(env), BUDGET_POLICY), source: "auto", auditUnitId: a.id, note: "test:stop" });
    await env.DB.prepare(
      "UPDATE budget_state SET status = 'stopped', source = 'manual', updated_by = 'ops-manual-stop', updated_at = ? WHERE id = 'global'",
    ).bind(new Date().toISOString()).run(); // ops/cost-alerts.mdの手順と同じD1更新
    const held = await applyBudgetDecision(env, { decision: nextDayDecision, source: "auto", auditUnitId: a.id, note: "test:hold" });
    expect(held.changed).toBe(false); // 評価が正常でも手動停止は解けない
    expect(held.state.status).toBe("stopped");
    // 解除（手順どおりのD1更新。ops/cost-alerts.md）
    await env.DB.prepare(
      "UPDATE budget_state SET status = 'normal', source = 'auto', reasons_json = '[]', updated_by = 'ops-unstop', updated_at = ? WHERE id = 'global'",
    ).bind(new Date().toISOString()).run();
    const lifted = await applyBudgetDecision(env, { decision: nextDayDecision, source: "auto", auditUnitId: a.id, note: "test:unstop" });
    expect(lifted.changed).toBe(false);
    expect(lifted.state.status).toBe("normal");
    // ゲート単位の復帰確認（実環境での停止復帰演習は未実施。ops/cost-alerts.mdに手順を記録）
    const gate = await expensiveCallGate(env, { unitId: a.id, jobKind: "ai.classify", jobId: "gate-check" });
    expect(gate.allowed).toBe(false); // 当日の急増が残っているため、解除しても直ちに再停止する（保護）

    // --- 最終断言（brief） ---
    expect(expensiveCallsAfterLimit).toBe(0);
    expect(existingRecordsReadable).toBe(true);
    expect(unknownRows.every((r) => r.amount === null)).toBe(true); // unknownUsageMarkedZero=false
    expect(piiInMetrics).toEqual([]);
  });
});
