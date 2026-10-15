import {
  LLM_MODEL, REPORT_PROMPT_VERSION, buildActivityData, jstDateTime, runReportLlm,
  type ReportDraftCandidate, type ReportGenerationInput,
} from "../ai/llm";
import type { AppEnv } from "../env";
import { canonicalJson, sha256Hex } from "../mutations/hash";
import type { ReportTemplate } from "./templates";

/**
 * 報告書下書きの生成（T057、docs/05 API-32、docs/06 §4、docs/14 D12/D16）。
 *
 * - **サーバー値の正本性**（docs/16 T057）: 人数・時刻・使用資産等の数値は、サーバーが元実績
 *   （activity_result_revisions＋activity_actual_participants＋resource_usages）から計算し、
 *   LLMに渡すのは文章化に必要な最小限だけ。LLMの出力がサーバー値と矛盾すれば候補を破棄する。
 * - 機微最小化（docs/14 D12）: participantは「参加N名」等の集計値のみ。氏名・連絡先・資産名を渡さない。
 * - 欠落（actualEndsAt等）は「未記載」のままmissingFieldsへ記録し、補完しない（docs/06 §4）。
 * - jobのdedupe_keyは「unit|ai.report|activityId|activityVersion|resultVersion|様式版」。
 *   実行時にこのキーを再構成して一致検査することで、activity/resultの**両方**の版が
 *   受付時と一致した結果だけを採用できる（stale検査。docs/11 永続ジョブ）。
 */

export const REPORT_JOB_KIND = "ai.report";

/** API-32の受付（routes/report-generation）とjob実行時のstale検査（handlers/report）で共有する */
export function reportJobDedupeKey(
  unitId: string, activityId: string, activityVersion: number, resultVersion: number, templateVersion: string,
): string {
  return [unitId, REPORT_JOB_KIND, activityId, activityVersion, resultVersion, templateVersion].join("|");
}

interface ActivityRow {
  title: string; kind: string; location_text: string; planned_starts_at: string;
  version: number; operation_id: string;
}
interface ResultRow {
  id: string; version: number; current_revision_id: string | null;
}
interface RevisionRow {
  revision_no: number; actual_starts_at: string | null; actual_ends_at: string | null; content: string;
}

/**
 * 元実績を読み、最小化input（ReportGenerationInput）を組み立てる。
 * 実績・活動が読めない（受付後に消えた等。DELETEは拒否されるため通常起こらない）ときはnull。
 */
export async function buildReportGenerationInput(
  env: AppEnv, unitId: string, activityId: string, template: ReportTemplate,
): Promise<ReportGenerationInput | null> {
  const activity = await env.DB.prepare(
    "SELECT a.title, a.kind, a.location_text, a.planned_starts_at, a.version, a.operation_id " +
      "FROM activities a WHERE a.id = ? AND a.unit_id = ?",
  ).bind(activityId, unitId).first<ActivityRow>();
  if (!activity) return null;
  const result = await env.DB.prepare(
    "SELECT id, version, current_revision_id FROM activity_results WHERE unit_id = ? AND activity_id = ?",
  ).bind(unitId, activityId).first<ResultRow>();
  if (!result?.current_revision_id) return null;
  const revision = await env.DB.prepare(
    "SELECT revision_no, actual_starts_at, actual_ends_at, content FROM activity_result_revisions WHERE id = ? AND unit_id = ?",
  ).bind(result.current_revision_id, unitId).first<RevisionRow>();
  if (!revision) return null; // pointerは同親の版のみを指す（activity-resultsと同じ前提）

  // 参加人数は実参加（participated）行の数。行が無い＝未記載（0名とは区別せず、人数は書かせない。docs/16 T057）
  const participatedRows = (await env.DB.prepare(
    "SELECT count(*) AS n FROM activity_actual_participants WHERE result_revision_id = ? AND unit_id = ? AND actual_status = 'participated'",
  ).bind(result.current_revision_id, unitId).first<{ n: number }>())!.n;
  const participantCount = participatedRows > 0 ? participatedRows : null;

  // 使用資産は種別の集計だけ（資産名・台帳の詳細は渡さない＝最小化。docs/14 D12）
  const usageCounts = (await env.DB.prepare(
    "SELECT " +
      "COALESCE(sum(CASE WHEN vehicle_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS vehicles, " +
      "COALESCE(sum(CASE WHEN equipment_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS equipment " +
      "FROM resource_usages WHERE operation_id = ? AND unit_id = ? AND status = 'active'",
  ).bind(activity.operation_id, unitId).first<{ vehicles: number; equipment: number }>())!;
  const resourceParts: string[] = [];
  if (usageCounts.vehicles > 0) resourceParts.push(`車両${usageCounts.vehicles}台`);
  if (usageCounts.equipment > 0) resourceParts.push(`機材${usageCounts.equipment}件`);
  const resourceSummary = resourceParts.length > 0 ? resourceParts.join("・") : null;

  // サーバー値が元実績に無い項目（未記載のままmissingFieldsへ。補完しない＝docs/06 §4）
  const missingValues: string[] = [];
  if (revision.actual_starts_at === null) missingValues.push("actualStartsAt");
  if (revision.actual_ends_at === null) missingValues.push("actualEndsAt");
  if (participantCount === null) missingValues.push("participantCount");

  return {
    template: {
      version: template.version, title: template.title, sourceRef: template.sourceRef, fictionalNote: template.fictionalNote,
    },
    activity: {
      title: activity.title, kind: activity.kind, locationText: activity.location_text,
      plannedStartsAtJst: jstDateTime(activity.planned_starts_at),
    },
    result: {
      content: revision.content,
      actualStartsAtJst: revision.actual_starts_at === null ? null : jstDateTime(revision.actual_starts_at),
      actualEndsAtJst: revision.actual_ends_at === null ? null : jstDateTime(revision.actual_ends_at),
    },
    serverValues: { participantCount, resourceSummary },
    missingValues,
    sourceVersions: {
      activityVersion: activity.version,
      resultVersion: result.version,
      resultRevisionNo: revision.revision_no,
    },
    sourceVersion: result.version,
  };
}

/**
 * 報告書下書きの候補を生成する（docs/16 T057のInterface。generateReportDraft(env,input)→Candidate）。
 * 検証を通過した本文だけが返る（捏造・構造不適合は例外＝jobの保留へ）。この関数はD1へ書かない。
 */
export async function generateReportDraft(env: AppEnv, input: ReportGenerationInput): Promise<ReportDraftCandidate> {
  const llm = await runReportLlm(env, input);
  return {
    text: llm.text,
    missingFields: [...input.missingValues],
    sourceVersions: input.sourceVersions,
    // model_idはdocs/04:147「AI生成時のモデル（カタログ名）」どおり要求カタログ名を記録する
    // （T053のai_evaluations.model_id=JEV_MODELと同じ方針。実モデル版はV04の実測で固定後に一致させる）
    model: LLM_MODEL,
    promptVersion: REPORT_PROMPT_VERSION,
    sourceVersion: input.sourceVersion,
    usage: llm.usage,
    fabricatedFacts: [], // 捏造はrunReportLlmが例外で破棄するため、返る候補は常に検証済み
  };
}

/** 最小化inputのhash（docs/06 §3「最小化inputのhashと参照版を記録」。handlers/reportが保存する） */
export async function reportGenerationInputHash(input: ReportGenerationInput): Promise<string> {
  return sha256Hex(canonicalJson(buildActivityData(input)));
}
