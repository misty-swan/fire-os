import type { ClassificationSourceType } from "../../../shared/contracts/ai";
import { localTestAi } from "../../ai/local-fake";
import { isKnownQuestionVersion } from "../../ai/questions";
import {
  JEV_MODEL, JevOutputError, AiRunError, buildStoredCandidate, runJev,
} from "../../ai/jev";
import type { AppEnv } from "../../env";
import { canonicalJson, sha256Hex } from "../../mutations/hash";
import { registerJobHandler } from "../runner";
import type { JobOutcome, LeasedJob } from "../store";

/**
 * Jev分類job（T053、docs/06 §3、docs/11 永続ジョブ、docs/14 D12）。
 * API-29が登録する ai.classify job（dedupe_key=`unit|ai.classify|sourceType|sourceId|sourceVersion|questionVersion`）を受ける。
 *
 * 実行時の送信条件の再検査（docs/06 §3「workerは現在の送信許可・元版を再検査し、最小化inputのhashと
 * 参照版を記録」）:
 *  ①元版の現行version一致（点検はseries版・異常はissue版。変わっていたらstale）
 *  ②送信許可の再検査（依頼者が今も有効な同unit団員。失っていたらstale）
 *  ③inputは最小化（点検のnote＋項目コード/結果、異常はtitle+descriptionのみ。氏名・連絡先を含めない）
 *  ④input_hashとinput_snapshot_refを記録
 *
 * 出力は最終事実ではない: 候補（ClassificationCandidate）をai_evaluationsへ保存するだけで、
 * 設備・異常・点検の状態は一切変更しない（automaticFacilityStateChanges=0。docs/06 §1）。
 * env.AIが無い（local）場合はmanual_review ai_unavailable（存在確認して使う＝src/server/env.ts）。
 * ただし試験専用のfake（local かつ TEST_AI_FAKE=1。e2eのwrangler devだけが付ける＝src/server/ai/local-fake.ts）
 * があるときは実AIの代わりにその決定的な応答で候補を作る（実AI bindingがあれば常に優先）。
 * 同じjobの再実行では既存の評価を返す（外部推論の再課金完全一回性は保証しない＝docs/06 §3の上限/計測管理）。
 */

export const CLASSIFY_JOB_KIND = "ai.classify";
/** 参照版への印（docs/04「input_snapshot_ref」。実体は源の表+版で、本文は複製しない） */
const snapshotRef = (sourceType: string, sourceId: string, sourceVersion: number) =>
  `d1:${sourceType}:${sourceId}@${sourceVersion}`;

interface SourceRef {
  /** 元版の現行version（点検=series版、異常=issues版） */
  version: number;
  /** PER-09本人分（member）の判定に使う団員ID（点検=実施者、異常=報告者の利用者に紐づく団員） */
  ownerMemberId: string | null;
  /** 最小化input（docs/14 D12。氏名・連絡先・実施者/報告者・担当を含まない） */
  state: Record<string, unknown>;
}

/**
 * 源を読み、現行版と最小化inputを組み立てる。源が無い/別unitはnull
 * （存在しない源はjobとしては採用できないためstale。API-29の受付時にも同じ検査がある）。
 */
async function loadSource(env: AppEnv, sourceType: ClassificationSourceType, unitId: string, sourceId: string): Promise<SourceRef | null> {
  if (sourceType === "facility_inspection" || sourceType === "asset_inspection") {
    const table = sourceType === "facility_inspection" ? "facility_inspections" : "asset_inspections";
    const row = await env.DB.prepare(
      `SELECT i.note, i.inspector_member_id, s.version AS series_version
         FROM ${table} i JOIN inspection_series s ON s.id = i.series_id AND s.unit_id = i.unit_id
        WHERE i.id = ? AND i.unit_id = ?`,
    ).bind(sourceId, unitId).first<{ note: string; inspector_member_id: string; series_version: number }>();
    if (!row) return null;
    // 最小化input: 点検のnote＋項目コードと結果だけ（value/備考/実施者は送らない。docs/14 D12）
    const itemsCol = sourceType === "facility_inspection" ? "facility_inspection_id" : "asset_inspection_id";
    const items = (
      await env.DB.prepare(
        `SELECT item_code, result FROM inspection_items WHERE ${itemsCol} = ? AND unit_id = ? ORDER BY item_code`,
      ).bind(sourceId, unitId).all<{ item_code: string; result: string }>()
    ).results;
    return {
      version: row.series_version,
      ownerMemberId: row.inspector_member_id,
      state: { note: row.note, items: items.map((i) => ({ code: i.item_code, result: i.result })) },
    };
  }
  // issue
  const row = await env.DB.prepare(
    "SELECT i.version, i.title, i.description, m.id AS reporter_member_id FROM issues i " +
      "LEFT JOIN members m ON m.user_id = i.reported_by AND m.unit_id = i.unit_id " +
      "WHERE i.id = ? AND i.unit_id = ?",
  ).bind(sourceId, unitId).first<{ version: number; title: string; description: string; reporter_member_id: string | null }>();
  if (!row) return null;
  // 最小化input: 異常のtitle+descriptionだけ（報告者・担当・状態は送らない。docs/14 D12）
  return {
    version: row.version,
    ownerMemberId: row.reporter_member_id,
    state: { title: row.title, description: row.description },
  };
}

/**
 * 分類jobの本体。staleの意味論（docs/11 永続ジョブ）: 元版が変わった（source_changed）・
 * 依頼者が権限を失った（requester_unauthorized）・源が消えた（source_missing）は結果を採用できないため
 * stale＝終端（成功候補も人未承認。docs/11）。
 */
export async function classifyJob(job: LeasedJob, env: AppEnv): Promise<JobOutcome> {
  const stale = (errorCode: string): JobOutcome => ({ kind: "stale", errorCode });
  // 同じjobの再実行は既存の評価を返す（UNIQUE(unit_id, job_id)が二重作成を拒否する前の保険）
  const existing = await env.DB.prepare("SELECT id FROM ai_evaluations WHERE unit_id = ? AND job_id = ?")
    .bind(job.unitId, job.id).first<{ id: string }>();
  if (existing) return { kind: "succeeded", resultRef: `evaluation:${existing.id}` };

  const sourceType = job.sourceType as ClassificationSourceType;
  if (!isKnownQuestionVersion(job.configVersion)) return stale("question_version_unknown"); // 質問版が廃止されていた
  const source = await loadSource(env, sourceType, job.unitId, job.sourceId);
  if (!source) return stale("source_missing");
  if (source.version !== job.sourceVersion) return stale("source_changed"); // ①元版の現行version一致
  // ②送信許可の再検査: 依頼者が今も有効な同unit団員か（権限を失った結果は採用できない＝docs/11 stale）
  if (!job.requestedBy) return stale("requester_unauthorized");
  const requester = await env.DB.prepare(
    "SELECT 1 FROM users u JOIN members m ON m.user_id = u.id " +
      "WHERE u.id = ? AND u.status = 'active' AND m.status = 'active' AND m.unit_id = ?",
  ).bind(job.requestedBy, job.unitId).first();
  if (!requester) return stale("requester_unauthorized");

  // ③最小化inputのhash（docs/06 §3「最小化inputのhashと参照版を記録」）
  const inputHash = await sha256Hex(canonicalJson(source.state));

  // env.AIの存在確認（localには無い。src/server/env.tsの契約どおり、無い環境では保留にして偽の候補を作らない）。
  // ただし試験専用のfake（local かつ TEST_AI_FAKE=1。e2eのwrangler devだけが付ける。src/server/ai/local-fake.ts）
  // があるときだけ、実AIの代わりに決定的なfakeで候補を作る（実AI bindingがあれば常にそちらを優先）
  const ai = env.AI ?? localTestAi(env);
  if (!ai) return { kind: "manual_review", errorCode: "ai_unavailable" };

  let candidate: Awaited<ReturnType<typeof runJev>>["candidate"];
  let validated: Awaited<ReturnType<typeof runJev>>["validated"];
  try {
    const result = await runJev({ ...env, AI: ai }, { state: source.state, sourceVersion: job.sourceVersion });
    candidate = result.candidate;
    validated = result.validated;
  } catch (err) {
    if (err instanceof JevOutputError) return { kind: "manual_review", errorCode: err.reason }; // 壊れ出力/入力上限は保留
    if (err instanceof AiRunError) return { kind: "retryable", errorCode: "ai_run_failed" }; // 一時失敗は再試行
    throw err; // runnerがretryable handler_errorにする
  }

  // ④候補の保存（評価は追記型。statusは常にpending＝人未承認。docs/11 AI提案）
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO ai_evaluations (id, unit_id, job_id, source_type, source_id, source_version, input_hash, input_snapshot_ref, question_version, model_id, actual_model_version, output_json, status, usage_json, actor_kind, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'system', ?)",
    ).bind(
      id, job.unitId, job.id, sourceType, job.sourceId, job.sourceVersion, inputHash,
      snapshotRef(sourceType, job.sourceId, job.sourceVersion),
      job.configVersion, JEV_MODEL, validated.model,
      JSON.stringify(buildStoredCandidate(candidate, validated)),
      candidate.usage ? JSON.stringify(candidate.usage) : null, nowIso,
    ),
  ]);
  return { kind: "succeeded", resultRef: `evaluation:${id}` };
}

// job登録（Cron/Queueと同じ登録点。routes/ai-classification.ts経由でWorkerに読み込まれる）
registerJobHandler(CLASSIFY_JOB_KIND, classifyJob);
