import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { proposeAssistantAction } from "../src/server/ai/assistant";
import { localTestAi } from "../src/server/ai/local-fake";
import { chunkDocument } from "../src/server/documents/chunk";
import type { AppEnv } from "../src/server/env";
import type { ApiContext } from "../src/server/http";
import { sha256Hex } from "../src/server/mutations/hash";
import "../src/server/jobs/handlers/classification"; // 分類job handlerの登録（Cron/Queueと同じ登録点）
import { runDueJobs } from "../src/server/jobs/runner";
import { answerRag } from "../src/server/search/rag";
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

// --- 出典つき回答（API-76）・横断アシスタント（API-77）の試験用（tests/rag.test.ts・assistant.test.tsと同じ最小ctx） ---

const aiCtx = (who: Identity, ai: NonNullable<AppEnv["AI"]> | undefined): ApiContext =>
  ({
    env: { ...env, AI: ai },
    req: { header: (name: string) => (name === "x-test-identity" ? JSON.stringify({ userId: who.userId }) : undefined) },
    get: () => "budget-test",
  }) as unknown as ApiContext;

const errCodeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return "no_error";
  } catch (err) {
    return String((err as { code?: string }).code ?? "other");
  }
};

/** 呼出し回数を数えるfake（localTestAiの決定的応答をそのまま使う） */
const countingLocalAi = () => {
  const fake = localTestAi({ ...env, TEST_AI_FAKE: "1" })!;
  let calls = 0;
  const counting = {
    run: async (model: string, input: unknown) => {
      calls++;
      return fake.run(model, input as never);
    },
  };
  return { ai: counting as unknown as NonNullable<AppEnv["AI"]>, callsOf: () => calls };
};

/** RAGの根拠文書（approved版＋FTS索引行。tests/rag.test.tsのinsertTestDocument縮小版。ACL行なし＝既定可視） */
const insertRagDocument = async (
  unitId: string,
  owner: { userId: string; memberId: string },
  title: string,
  pageText: string,
): Promise<void> => {
  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const contentHash = await sha256Hex(`budget-test:${title}`);
  const now = "2026-10-16T00:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO attachments (id, unit_id, owner_user_id, owner_member_id, intent_target_type, intent_target_id, content_type, byte_size, sha256, status, expires_at, classification, upload_token_hash, ready_key, created_at, updated_at, actor_kind) " +
        "VALUES (?, ?, ?, ?, 'document', ?, 'application/pdf', 1024, ?, 'ready', '2027-10-16T00:00:00.000Z', 'basic', ?, ?, ?, ?, 'system')",
    ).bind(attachmentId, unitId, owner.userId, owner.memberId, documentId, contentHash, "0".repeat(64), `budget-test/${documentId}.pdf`, now, now),
    env.DB.prepare(
      "INSERT INTO documents (id, unit_id, title, classification, status, policy_version, created_at, updated_at, actor_kind) VALUES (?, ?, ?, '訓練資料（架空）', 'approved', 1, ?, ?, 'system')",
    ).bind(documentId, unitId, title, now, now),
    env.DB.prepare(
      "INSERT INTO document_versions (id, unit_id, document_id, revision_no, attachment_id, status, approved_by, approved_at, license_ref, content_hash, created_at, updated_at, actor_kind) VALUES (?, ?, ?, 1, ?, 'approved', ?, ?, '架空・自団体作成（検証用）', ?, ?, ?, 'system')",
    ).bind(versionId, unitId, documentId, attachmentId, owner.userId, now, contentHash, now, now),
  ]);
  const chunks = chunkDocument({
    versionId, documentId, unitId, contentHash, extractorVersion: "budget-test",
    pages: [{ pageNo: 1, text: pageText }],
  });
  const chunkStmts: D1PreparedStatement[] = [];
  const ftsStmts: D1PreparedStatement[] = [];
  for (const chunk of chunks) {
    const chunkId = crypto.randomUUID();
    chunkStmts.push(
      env.DB.prepare(
        "INSERT INTO document_chunks (id, unit_id, version_id, chunk_no, page_no, section, text, source_offsets, index_status, index_key, created_at, updated_at, actor_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'indexed', ?, ?, ?, 'system')",
      ).bind(chunkId, unitId, versionId, chunk.chunkNo, chunk.pageNo, chunk.section, chunk.text, JSON.stringify(chunk.sourceOffsets), `budget-test:v1/${chunkId}`, now, now),
    );
    ftsStmts.push(
      env.DB.prepare(
        "INSERT INTO document_chunks_fts (chunk_id, unit_id, version_id, document_id, page_no, chunk_no, text) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(chunkId, unitId, versionId, documentId, chunk.pageNo, chunk.chunkNo, chunk.text),
    );
  }
  await env.DB.batch(chunkStmts);
  await env.DB.batch(ftsStmts);
};

// --- 計上の読み取り ---

const knownSum = async (service: string, metric: string): Promise<number> =>
  (await env.DB.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS n FROM usage_metrics WHERE service = ? AND metric = ? AND amount_known = 1",
  ).bind(service, metric).first<{ n: number }>())!.n;

const unknownRowCount = async (): Promise<number> =>
  (await env.DB.prepare("SELECT count(*) AS n FROM usage_metrics WHERE amount_known = 0").first<{ n: number }>())!.n;

const budgetAuditRows = async (action: string, unitId?: string) =>
  fx.rows("audit_logs", unitId ? { action, entity_type: "budget", unit_id: unitId } : { action, entity_type: "budget" });

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

  it("rag_and_assistant_are_metered_and_stopped_by_budget", async () => {
    const a = fx.units.a;
    const b = fx.units.b;
    const adminB = b.people.admin;

    // --- 準備: RAGの根拠文書（unit B・ACL行なし＝既定可視）と、横断のcontextRefにする異常 ---
    await insertRagDocument(b.id, { userId: adminB.userId!, memberId: adminB.memberId! }, "格納箱の点検要領（架空）", "格納箱の前には資材を置かないこと。\n点検の結果は記録すること。");
    const issue = await createIssue(adminB, "横断試験の異常（架空）");
    const { ai: fakeAi, callsOf } = countingLocalAi();

    // --- 計上（未接続ならai.callsが増えない＝赤） ---
    const callsBefore = await knownSum("ai", "ai.calls");
    const tokensBefore = await knownSum("ai", "ai.tokens.input");
    const rag = await answerRag(aiCtx(adminB, fakeAi), { body: { query: "格納箱" } });
    expect(rag.abstained).toBe(false); // 出典つきの回答（AIを1回呼んでいる）
    expect(callsOf()).toBe(1);
    expect(await knownSum("ai", "ai.calls")).toBe(callsBefore + 1);
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM usage_metrics WHERE service = 'ai' AND metric = 'ai.calls' AND source = 'api:search.rag'").first<{ n: number }>())!.n,
    ).toBe(1);

    const proposal = await proposeAssistantAction(aiCtx(adminB, fakeAi), {
      body: { query: "格納箱", contextRefs: [{ type: "issue", id: issue.id }] },
      headers: { "idempotency-key": crypto.randomUUID() },
    });
    expect(proposal.abstained).toBe(false);
    expect(proposal.proposalId).not.toBeNull();
    expect(callsOf()).toBe(2);
    expect(await knownSum("ai", "ai.calls")).toBe(callsBefore + 2);
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM usage_metrics WHERE service = 'ai' AND metric = 'ai.calls' AND source = 'api:ai.assistant'").first<{ n: number }>())!.n,
    ).toBe(1);
    // usage既知のtokensも計上される（RAGのfake usage=96、assistantのfake usage=120）
    expect(await knownSum("ai", "ai.tokens.input")).toBe(tokensBefore + 96 + 120);

    // --- 停止中は出典つき回答・横断アシスタントも503で止まり、AIは呼ばれない（auditはunit Bに記録） ---
    await recordMetric(env, { service: "ai", metric: "ai.calls", unit: "count", amount: BUDGET_POLICY.dailyAiCallCap, source: "seed:demo-burst-rag" });
    const stoppedDecision = evaluateBudget(await buildUsageSnapshot(env), BUDGET_POLICY);
    expect(stoppedDecision.status).toBe("stopped");
    await applyBudgetDecision(env, { decision: stoppedDecision, source: "auto", auditUnitId: b.id, note: "test:stop-rag" });
    expect(await budgetAuditRows("budget.stop", b.id)).toHaveLength(1);
    const callsWhenStopped = callsOf();
    expect(await errCodeOf(() => answerRag(aiCtx(adminB, fakeAi), { body: { query: "格納箱" } }))).toBe("DEPENDENCY_UNAVAILABLE");
    expect(await errCodeOf(() => proposeAssistantAction(aiCtx(adminB, fakeAi), {
      body: { query: "格納箱", contextRefs: [{ type: "issue", id: issue.id }] },
      headers: { "idempotency-key": crypto.randomUUID() },
    }))).toBe("DEPENDENCY_UNAVAILABLE");
    expect(callsOf()).toBe(callsWhenStopped); // 停止中のAI呼出しは0

    // --- 解除: 当日の急増を除いて（実環境では日が変わる。usage_metricsは観測データなので試験内で日経過を相当させる）評価が枠内に戻れば、次の呼出しで自然解除され呼べる ---
    await env.DB.prepare("DELETE FROM usage_metrics WHERE source = 'seed:demo-burst-rag'").run();
    const ragAfter = await answerRag(aiCtx(adminB, fakeAi), { body: { query: "格納箱" } });
    expect(ragAfter.abstained).toBe(false);
    expect(callsOf()).toBe(callsWhenStopped + 1);
    expect(await budgetAuditRows("budget.resume", b.id)).toHaveLength(1);
    // 最後の断言（このケースの要点）: 停止中のAI消費は0・計上は既存経路と同じ表に載る
    expect(knownSum("ai", "ai.calls")).resolves.toBeGreaterThan(0);
  });

  it("monitor_counters_are_aggregated_and_warn_but_do_not_stop", async () => {
    // 監視項目（review round 1）: job滞留（lease失効）・配送不明・同期の拒否・検査不能（scan rejected）。
    // 既存の成果点がusage_metricsへcount計上し、しきい値超過は「予兆（warn）」＝停止にはしない
    await recordMetric(env, { service: "d1", metric: "jobs.lease_expired", unit: "count", amount: 3, source: "seed:monitor" });
    await recordMetric(env, { service: "notification", metric: "notification.delivery_unknown", unit: "count", amount: 2, source: "seed:monitor" });
    await recordMetric(env, { service: "d1", metric: "sync.rejected", unit: "count", amount: 1, source: "seed:monitor" });
    await recordMetric(env, { service: "r2", metric: "attachments.scan_rejected", unit: "count", amount: 1, source: "seed:monitor" });
    await recordMetric(env, { service: "ai", metric: "ai.call_failed", unit: "count", amount: 1, source: "seed:monitor" });

    const snapshot = await buildUsageSnapshot(env);
    expect(snapshot.jobLeaseExpired).toBe(3);
    expect(snapshot.deliveryUnknown).toBe(2);
    expect(snapshot.syncRejections).toBe(1);
    expect(snapshot.scanRejected).toBe(1);
    expect(snapshot.aiCallsFailed).toBe(1); // 失敗率の元データ（割算はopsが月次に算出。ops/cost-alerts.md §未実装）

    // しきい値内は理由なし
    const normal = evaluateBudget(snapshot, BUDGET_POLICY);
    expect(normal.reasons).toEqual([]);
    expect(normal.status).toBe("normal");
    // しきい値超過はwarn（停止しない。どれが停止対象かはconfig/ops/cost-alerts.mdに明記）
    const warned = evaluateBudget({
      ...snapshot,
      jobLeaseExpired: BUDGET_POLICY.monitors.maxJobLeaseExpiredPerDay + 1,
      deliveryUnknown: BUDGET_POLICY.monitors.maxDeliveryUnknownPerDay + 1,
      syncRejections: BUDGET_POLICY.monitors.maxSyncRejectionsPerDay + 1,
      scanRejected: BUDGET_POLICY.monitors.maxScanRejectedPerDay + 1,
    }, BUDGET_POLICY);
    expect(warned.status).toBe("warn");
    expect(warned.expensiveCallsAllowed).toBe(true); // 監視項目だけで高価な呼び出しは止めない
    expect(warned.reasons).toEqual(expect.arrayContaining([
      "job_lease_expired_over", "delivery_unknown_over", "sync_rejections_over", "scan_rejected_over",
    ]));
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

    // 月累計（month-to-date）の費用試算が月額上限を超えると停止（review round 1で月累計判定に統一）。
    // 当日のtokensだけでは発火しない量でも、当月の累計で判定する（units-review-1の月次実績に相当する注入）
    const costly = evaluateBudget({ ...snapshot, monthAiTokensInput: 200_000_000 }, BUDGET_POLICY); // 単価固定分のみの下限試算
    expect(costly.reasons).toContain("monthly_cost_estimate_over");
    expect(costly.expensiveCallsAllowed).toBe(false);
    // 対照: 当日のtokensが多く見えても月累計が上限未満なら費用理由では止めない（日次の枠は別理由で効く）
    const notCostlyYet = evaluateBudget({ ...snapshot, aiTokensInput: 200_000_000, monthAiTokensInput: 1_000_000 }, BUDGET_POLICY);
    expect(notCostlyYet.reasons).not.toContain("monthly_cost_estimate_over");

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
    expect(await budgetAuditRows("budget.stop", a.id)).toHaveLength(0);
    await env.DB.prepare("DROP TRIGGER budget_test_fail_audit").run();
    // 再適用は成功し、失敗attemptの残留がない（budget.stopの監査は1本だけ）
    const applied = await applyBudgetDecision(env, { decision: stoppedDecision, source: "auto", auditUnitId: a.id, note: "test:stop" });
    expect(applied.changed).toBe(true);
    expect((await readPersistedBudgetState(env))!.status).toBe("stopped");
    const stopRows = await budgetAuditRows("budget.stop", a.id);
    expect(stopRows).toHaveLength(1);
    expect(stopRows[0]!.actor_kind).toBe("system");
    expect(JSON.parse(stopRows[0]!.metadata_json as string)).toMatchObject({ to: "stopped" });
    // 再適用は冪等（停止済みで同じ判定なら監査を増やさない）
    expect((await applyBudgetDecision(env, { decision: stoppedDecision, source: "auto", auditUnitId: a.id, note: "test:stop" })).changed).toBe(false);
    expect(await budgetAuditRows("budget.stop", a.id)).toHaveLength(1);

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
    expect(await budgetAuditRows("budget.resume", a.id)).toHaveLength(1);

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
    const gate = await expensiveCallGate(env, { unitId: a.id, source: "test:gate-check" });
    expect(gate.allowed).toBe(false); // 当日の急増が残っているため、解除しても直ちに再停止する（保護）

    // --- 最終断言（brief） ---
    expect(expensiveCallsAfterLimit).toBe(0);
    expect(existingRecordsReadable).toBe(true);
    expect(unknownRows.every((r) => r.amount === null)).toBe(true); // unknownUsageMarkedZero=false
    expect(piiInMetrics).toEqual([]);
  });

  it("monthly_cost_estimate_is_computed_from_month_to_date_tokens_not_single_day", async () => {
    // 月額の費用上限は「当月初日（UTC）以降の累計（month-to-date）」で判定する（review round 1）。
    // 旧実装は当日のtokensだけを月額上限と比べていたため、月額上限が実質発火しなかった。
    // 同一月内の2日で、各日のtokensは上限未満・月累計は超過 → monthly_cost_estimate_over で停止。
    // 前月末（2026-02-28）の大量行は月累計に含めない（月初境界。当日が月初の週でも取得窓が前月に跨る）。
    const now = new Date("2026-03-05T12:00:00.000Z");
    const evalAt = async () => evaluateBudget(await buildUsageSnapshot(env, { now }), BUDGET_POLICY);
    const seedTokens = async (isoDay: string, amount: number) =>
      recordMetric(env, { service: "ai", metric: "ai.tokens.input", unit: "tokens", amount, source: "seed:month-mtd" }, { now: new Date(isoDay) });

    // 前月末の大量行（誤って月累計に入ると単独で上限超になる量）と、当月1日分（上限未満）
    await seedTokens("2026-02-28T10:00:00.000Z", 200_000_000);
    await seedTokens("2026-03-04T10:00:00.000Z", 60_000_000);

    // 1日分のtokensは費用上限未満（60M×$0.042/M=$2.52 < $5）。月累計もまだ未満 → 停止しない
    const beforeOver = await evalAt();
    expect(beforeOver.reasons).not.toContain("monthly_cost_estimate_over");
    expect(beforeOver.status).not.toBe("stopped");

    // 当月の2日目を足すと月累計$5.04 > $5 → monthly_cost_estimate_over で停止
    await seedTokens("2026-03-05T10:00:00.000Z", 60_000_000);
    const afterOver = await evalAt();
    expect(afterOver.reasons).toContain("monthly_cost_estimate_over");
    expect(afterOver.status).toBe("stopped");
    expect(afterOver.expensiveCallsAllowed).toBe(false);

    // snapshotの月累計は当月初日以降の全行（120M）。前月末の200Mは含まない
    const snap = await buildUsageSnapshot(env, { now });
    expect(snap.monthAiTokensInput).toBe(120_000_000);
    expect(snap.aiTokensInput).toBe(60_000_000); // 当日の集計（日次の意味）は変わらない
  });

  it("spike_baseline_keeps_recent_window_even_when_query_window_extends_to_month_start", async () => {
    // 取得窓を当月初日まで広げても、急増判定の基準（直近spikeWindowDays日の平均）の意味は変えない:
    // 窓の中で基準期間より前の日のAI呼出しはbaselineに入れない（review round 1）。
    const now = new Date("2026-03-15T12:00:00.000Z"); // 急増の基準期間=03-08〜03-14。取得窓は当月初日03-01から
    const seedCalls = async (isoDay: string, amount: number) =>
      recordMetric(env, { service: "ai", metric: "ai.calls", unit: "count", amount, source: "seed:month-spike" }, { now: new Date(isoDay) });
    await seedCalls("2026-03-03T10:00:00.000Z", 60); // 当月初日以降だが急増の基準期間より前
    await seedCalls("2026-03-10T10:00:00.000Z", 10); // 基準期間内
    const snap = await buildUsageSnapshot(env, { now });
    expect(snap.priorAiCalls).toEqual([{ day: "2026-03-10", known: 10 }]);
  });
});
