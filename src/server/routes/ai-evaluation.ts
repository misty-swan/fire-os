import { EvaluationRun, type EvaluationRunDto } from "../../shared/contracts/ai";
import { Job } from "../../shared/contracts/common";
import { kindOfDatasetVersion } from "../ai/evaluation";
import "../ai/evaluation"; // 評価job handlerの登録（Cron/Queueと同じ登録点）
import { REPORT_PROMPT_VERSION } from "../ai/llm";
import { isKnownQuestionVersion } from "../ai/questions";
import { resolvePrincipal } from "../auth/principal";
import type { AppEnv } from "../env";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { enqueueJob } from "../jobs/store";
import { sha256Hex } from "../mutations/hash";
import { requirePermission } from "./invitations";

/**
 * AI評価の実行（API-89）と実行履歴の一覧（API-88）（T061、docs/05 API-88/89、docs/06 §6、docs/14 D12）。
 *
 * - API-89（PER-08運用）: 固定holdout（コミット済みの架空dataset。人手ラベル＋記録済みの予測）の
 *   評価job（evaluation.run）を1本だけ登録する。202は受付で完了ではない（docs/05 §1）。
 *   業務rootを持たないjob受付のためexecuteMutationを使わない（jobs.dedupe_keyが冪等の正本。
 *   API-29/32と同じ流儀）。同じ（dataset, 質問版, モデル）の再依頼は同じjobを返す。
 *   **実モデルでの実行はV04の未実施手順**。このjobは記録済み出力の再計算で、実測ではない
 *   （docs/evidence/ai-evaluation.md）。
 * - API-88（PER-08）: 実行履歴の一覧。modelId/datasetVersionで絞り、作成降順の安定keyset
 *   （HMAC署名cursor。条件を変えた続き取得・改変cursorは409 SNAPSHOT_CHANGED）。
 *   gate_passedがNULL/failedの実行を合格と表示しないのは表示側（SCR-17のAiEvaluationPanel）の責務。
 */

// --- 署名付きcursor（ai-classification.ts（API-30）と同じ流儀。条件を変えた続き取得・改変cursorは409） ---

interface RunCursor {
  filterHash: string;
  createdAt: string;
  id: string;
}

const signingKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(`ai-evaluation-cursor:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (ch) => ch.charCodeAt(0));

async function encodeCursor(key: CryptoKey, cursor: RunCursor): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(cursor)));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

async function decodeCursor(key: CryptoKey, value: string): Promise<RunCursor | null> {
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", key, unb64url(sig) as BufferSource, new TextEncoder().encode(payload));
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(unb64url(payload))) as RunCursor;
    if (typeof parsed.filterHash !== "string" || typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function registerAiEvaluationRoutes(app: ApiApp): void {
  // --- API-89: 評価の実行（202=永続jobの受付。docs/05 §1「202は業務完了と表示しない」） ---
  defineRoute(app, "API-89", async (c) => {
    const p = await resolvePrincipal(c);
    const { body } = await parseApiRequest(c, "API-89");
    requirePermission(p, "PER-08", { unitId: p.unitId, type: "ai_evaluation_run" });
    // dataset版はサーバー固定（コミット済みfixtureのみ）。未知の版は400（黙って別のdatasetで評価しない）
    const kind = kindOfDatasetVersion(body.datasetVersion);
    if (!kind) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "datasetVersion", reason: "unknown_dataset_version" }]);
    }
    // 質問版（分類=docs/06 §2のサーバー固定質問。報告書=プロンプト構造の版）
    const knownQuestion =
      kind === "classification" ? isKnownQuestionVersion(body.questionVersion) : body.questionVersion === REPORT_PROMPT_VERSION;
    if (!knownQuestion) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "questionVersion", reason: "unknown_question_version" }]);
    }
    // dedupe_keyの構成要素に「|」を許さない（handlerがkeyからmodelIdを取り出すため）
    if (body.modelId.includes("|")) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "modelId", reason: "invalid_character" }]);
    }

    // dedupe_key=`unit|evaluation.run|datasetVersion|questionVersion|modelId`。
    // 同じ（dataset, 質問版, モデル）の再依頼は同じjobを返す（docs/06 §3「同一元版＋質問版dedupe」の評価版）。
    // 再評価はdataset版を進めたときに行う（同じ版の上書き評価は作らない＝履歴の追記型）。
    const job = await enqueueJob(c.env, {
      unitId: p.unitId,
      kind: "evaluation.run",
      sourceType: "evaluation",
      sourceId: body.datasetVersion,
      sourceVersion: 1,
      configVersion: body.questionVersion,
      requestedBy: p.userId,
      dedupeKey: `${p.unitId}|evaluation.run|${body.datasetVersion}|${body.questionVersion}|${body.modelId}`,
    });
    return ok(c, Job.parse({ id: job.id, status: job.status, attempts: job.attempts, errorCode: job.errorCode, resultRef: job.resultRef }), {}, 202);
  });

  // --- API-88: 実行履歴の一覧（PER-08） ---
  defineRoute(app, "API-88", async (c) => {
    const p = await resolvePrincipal(c);
    const { query } = await parseApiRequest(c, "API-88");
    requirePermission(p, "PER-08", { unitId: p.unitId, type: "ai_evaluation" });

    const where = ["unit_id = ?"];
    const binds: unknown[] = [p.unitId];
    if (query.modelId) {
      where.push("model_id = ?");
      binds.push(query.modelId);
    }
    if (query.datasetVersion) {
      where.push("dataset_version = ?");
      binds.push(query.datasetVersion);
    }

    const key = await signingKey(c.env.BETTER_AUTH_SECRET);
    const { cursor: cursorValue, ...filterOnly } = query;
    const filterHash = await sha256Hex(JSON.stringify(filterOnly));
    if (cursorValue) {
      const cursor = await decodeCursor(key, cursorValue);
      if (!cursor || cursor.filterHash !== filterHash) throw new HttpError("SNAPSHOT_CHANGED");
      // 新しい順（作成降順）の続き。同時刻はid降順で並べ、取りこぼしも重複も作らない（API-30と同じ）
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    const rows = (
      await c.env.DB.prepare(
        `SELECT id, unit_id, job_id, kind, dataset_version, question_version, model_id, dataset_ref, dataset_sha256,
                case_count, labels_json, outputs_json, metrics_json, gate_passed, status, error_code,
                run_by_user_id, executed_at, created_at
           FROM ai_evaluation_runs WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).bind(...binds, query.limit + 1).all<{
        id: string; unit_id: string; job_id: string; kind: string; dataset_version: string; question_version: string;
        model_id: string; dataset_ref: string; dataset_sha256: string; case_count: number; labels_json: string;
        outputs_json: string; metrics_json: string | null; gate_passed: number | null; status: string;
        error_code: string | null; run_by_user_id: string; executed_at: string; created_at: string;
      }>()
    ).results;

    const toDto = (r: (typeof rows)[number]): EvaluationRunDto =>
      EvaluationRun.parse({
        id: r.id,
        jobId: r.job_id,
        kind: r.kind,
        datasetVersion: r.dataset_version,
        questionVersion: r.question_version,
        modelId: r.model_id,
        datasetRef: r.dataset_ref,
        datasetSha256: r.dataset_sha256,
        caseCount: r.case_count,
        labels: JSON.parse(r.labels_json),
        outputs: JSON.parse(r.outputs_json),
        metrics: r.metrics_json ? JSON.parse(r.metrics_json) : null,
        gatePassed: r.gate_passed === null ? null : r.gate_passed === 1,
        status: r.status,
        errorCode: r.error_code,
        runByUserId: r.run_by_user_id,
        executedAt: r.executed_at,
        createdAt: r.created_at,
      });

    const items = rows.slice(0, query.limit).map(toDto);
    if (rows.length > query.limit) {
      const last = items[items.length - 1]!;
      return ok(c, items, { nextCursor: await encodeCursor(key, { filterHash, createdAt: last.createdAt, id: last.id }) });
    }
    return ok(c, items);
  });
}
