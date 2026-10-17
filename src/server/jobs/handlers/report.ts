import {
  REPORT_JOB_KIND, buildReportGenerationInput, generateReportDraft, reportGenerationInputHash, reportJobDedupeKey,
} from "../../reports/generate";
import { getReportTemplate, type ReportTemplate } from "../../reports/templates";
import { LlmOutputError, AiRunError, type ReportDraftCandidate } from "../../ai/llm";
import type { AppEnv } from "../../env";
import { expensiveCallGate } from "../../observability/budget";
import { recordMetricSafe } from "../../observability/metrics";
import { registerJobHandler } from "../runner";
import type { JobOutcome, LeasedJob } from "../store";

/**
 * 報告書下書き生成job（T057、docs/05 API-32、docs/06 §3/§4、docs/11 永続ジョブ、docs/14 D12/D16）。
 * API-32が登録する ai.report job（dedupe_key=`unit|ai.report|activityId|activityVersion|resultVersion|様式版`）を受ける。
 *
 * 実行時の送信条件の再検査（docs/06 §3「workerは現在の送信許可・元版を再検査し、最小化inputのhashと
 * 参照版を記録」）:
 *  ①元版の現行version一致（activityとactivity_resultsの両方。dedupe_keyを現行版で再構成して一致検査。
 *    実行中の元実績変更はstaleになり、**stale jobは報告書versionsを作らない**＝docs/16 T057）
 *  ②送信許可の再検査（依頼者が今も有効な同unit団員。失っていたらstale。T053のclassificationと同じ型）
 *  ③様式の再検査（allowlist外・hash不一致は受理しない。templates.tsが422を投げる形なのでstaleへ変換）
 *  ④inputは最小化（実績本文＋サーバー集計値のみ。氏名・連絡先を含めない＝docs/14 D12）し、hashを記録
 *
 * 出力は最終事実ではない: LLMの下書きを**新draft版（revision_no=1、model_id付き）として保存するだけ**で、
 * 承認（T058）まで申請・配布されない（docs/11「人編集→新版→承認→配布の順」。docs/06 §4）。
 * env.AIが無い（local）場合はmanual_review ai_unavailable（存在確認して偽の下書きを作らない）。
 * localTestAi（Jev専用の応答形）は分岐しない: e2e（TEST_AI_FAKE=1）でも報告書生成は保留に落ちる
 * （実AI bindingが無い環境で偽の報告書を作らないため。docs/evidence/V04-llm.mdに記録）。
 * 同じjobの再実行では外部推論の完全一回性を保証しない（docs/06 §3。retry_waitからの再実行時に
 * 前回の保存が無いことが前提。保存とsucceeded確定の間のプロセス死では重複版が残りうる＝限界をdocsに記録）。
 */

export async function reportJob(job: LeasedJob, env: AppEnv): Promise<JobOutcome> {
  const stale = (errorCode: string): JobOutcome => ({ kind: "stale", errorCode });

  // ①元版の現行version一致（activityと実績の両方。dedupe_keyの再構成で一致検査＝docs/16 T057）
  const activity = await env.DB.prepare(
    "SELECT version FROM activities WHERE id = ? AND unit_id = ?",
  ).bind(job.sourceId, job.unitId).first<{ version: number }>();
  if (!activity) return stale("source_missing");
  const result = await env.DB.prepare(
    "SELECT version, current_revision_id FROM activity_results WHERE unit_id = ? AND activity_id = ?",
  ).bind(job.unitId, job.sourceId).first<{ version: number; current_revision_id: string | null }>();
  if (!result?.current_revision_id) return stale("source_missing");
  const expectedKey = reportJobDedupeKey(job.unitId, job.sourceId, activity.version, result.version, job.configVersion);
  if (job.dedupeKey !== expectedKey) return stale("source_changed");

  // ②送信許可の再検査: 依頼者が今も有効な同unit団員か（権限を失った結果は採用できない＝docs/11 stale）
  if (!job.requestedBy) return stale("requester_unauthorized");
  const requester = await env.DB.prepare(
    "SELECT 1 FROM users u JOIN members m ON m.user_id = u.id " +
      "WHERE u.id = ? AND u.status = 'active' AND m.status = 'active' AND m.unit_id = ?",
  ).bind(job.requestedBy, job.unitId).first();
  if (!requester) return stale("requester_unauthorized");

  // ③様式の再検査（allowlist。受付後にallowlistから外れた版の結果は採用できない）
  let template: ReportTemplate;
  try {
    template = await getReportTemplate(job.configVersion);
  } catch {
    return stale("template_version_unknown");
  }

  // ④最小化inputの組み立てとhash（docs/06 §3）
  const input = await buildReportGenerationInput(env, job.unitId, job.sourceId, template);
  if (!input) return stale("source_missing");
  const inputHash = await reportGenerationInputHash(input);

  // 課金上限の停止ゲート（T080）: 高価なAI呼出しの前に使用量を再評価し、停止中は呼ばずに保留へ
  // （docs/07 §8、docs/14 D11。既存記録（元実績・報告書）の読取は止めない。解除はops/cost-alerts.mdの手順）
  const gate = await expensiveCallGate(env, { unitId: job.unitId, jobKind: REPORT_JOB_KIND, jobId: job.id });
  if (!gate.allowed) return { kind: "manual_review", errorCode: "budget_stopped" };

  // 使用量の計上（T080。観測は業務を止めない。試行1回=1。usageの既知/未知・失敗/429を別metricで計上する。
  //   jobの再実行で呼出しがやり直されると試行分が重複計上され得る＝近似であることをdocs/07 §8に記録）
  await recordMetricSafe(env, { service: "ai", metric: "ai.calls", unit: "count", amount: 1, source: "job:ai.report" });

  // env.AIの存在確認（localには無い。無い環境では保留にして偽の下書きを作らない＝src/server/env.tsの契約）
  if (!env.AI) return { kind: "manual_review", errorCode: "ai_unavailable" };

  let candidate: ReportDraftCandidate;
  try {
    candidate = await generateReportDraft(env, input);
  } catch (err) {
    if (err instanceof LlmOutputError) {
      // 呼出し自体は起きた（課金対象の可能性）。usageは未知として計上する（0と偽装しない）
      await recordMetricSafe(env, { service: "ai", metric: "ai.tokens.input", unit: "tokens", amount: null, source: "job:ai.report" });
      // 構造不適合（限定retry後）・入力上限・捏造はすべて保留。原本（元実績）はそのまま残る
      return { kind: "manual_review", errorCode: err.reason };
    }
    if (err instanceof AiRunError) {
      // providerの応答制限（429）は別metric（予兆の監視対象。docs/07 §8。実providerでの区分確定はV04）
      const rateLimited = /429/.test(String(err));
      await recordMetricSafe(env, {
        service: "ai", metric: rateLimited ? "ai.rate_limited" : "ai.call_failed", unit: "count", amount: 1, source: "job:ai.report",
      });
      return { kind: "retryable", errorCode: "ai_run_failed" }; // 一時失敗は再試行
    }
    throw err; // runnerがretryable handler_errorにする
  }
  // usageの計上（既知はtokens、未知はNULL。docs/16 T080「unknown使用量を0と偽装しない」）
  await recordMetricSafe(env, {
    service: "ai", metric: "ai.tokens.input", unit: "tokens",
    amount: candidate.usage ? candidate.usage.promptTokens : null, source: "job:ai.report",
  });
  await recordMetricSafe(env, {
    service: "ai", metric: "ai.tokens.output", unit: "tokens",
    amount: candidate.usage ? candidate.usage.completionTokens : null, source: "job:ai.report",
  });

  // ⑤保存（T056のAPI-62と同じDML順序。rootはAI初回生成として新規に作る＝1活動に複数帳票可。docs/04 ER。
  //  kindはAI生成も'manual'のまま＝docs/14 D25（CHECK拡張はしない。AIの区別は版のmodel_id/prompt_version/
  //  input_hash/usage_jsonの生成証跡で付く。docs/04:146注記どおり）
  const reportId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  await env.DB.batch([
    // root（循環FKのためdraft pointerはNULLで作り、初版INSERT後に向ける。docs/04:146）
    env.DB.prepare(
      "INSERT INTO reports (id, unit_id, activity_id, kind, current_draft_version_id, current_approved_version_id, version, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
        "VALUES (?, ?, ?, 'manual', NULL, NULL, 1, NULL, ?, ?, NULL, 'system')",
    ).bind(reportId, job.unitId, job.sourceId, nowIso, nowIso),
    // 初版（revision_no=1。draft。生成の証跡＝model/prompt版/最小化input hash/usageを版に保存する）
    env.DB.prepare(
      "INSERT INTO report_versions (id, unit_id, report_id, template_version, revision_no, text, missing_fields, source_versions, model_id, prompt_version, input_hash, usage_json, status, approved_by, approved_at, version, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
        "VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, NULL, 1, NULL, ?, ?, NULL, 'system')",
    ).bind(
      versionId, job.unitId, reportId, input.template.version, candidate.text,
      JSON.stringify(candidate.missingFields), JSON.stringify(candidate.sourceVersions),
      candidate.model, candidate.promptVersion, inputHash,
      candidate.usage ? JSON.stringify(candidate.usage) : null, nowIso, nowIso,
    ),
    env.DB.prepare(
      "UPDATE reports SET current_draft_version_id = ?, updated_at = ? WHERE id = ? AND unit_id = ? AND current_draft_version_id IS NULL",
    ).bind(versionId, nowIso, reportId, job.unitId),
  ]);
  return { kind: "succeeded", resultRef: `report_version:${versionId}` };
}

// job登録（Cron/Queueと同じ登録点。routes/report-generation.ts経由でWorkerに読み込まれる）
registerJobHandler(REPORT_JOB_KIND, reportJob);
