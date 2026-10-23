import { AiEvaluation, AssistantCandidateOutput, type AiEvaluationDto, type AssistantReadResultDto, AssistantReadResultViewDto } from "../../shared/contracts/ai";
import { Job } from "../../shared/contracts/common";
import { isKnownQuestionVersion } from "../ai/questions";
import type { AuthzPrincipal } from "../auth/principal";
import { authorize } from "../auth/authorize";
import { resolvePrincipal } from "../auth/principal";
import { isDocumentVisible } from "../documents/authorized";
import type { AppEnv } from "../env";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { enqueueJob } from "../jobs/store";
import "../jobs/handlers/classification"; // 分類job handlerの登録（Cron/Queueと同じ登録点）
import { sha256Hex } from "../mutations/hash";
import { requirePermission } from "./invitations";

/**
 * AI分類の依頼（API-29）と候補の一覧（API-30）（T053、docs/05 API-29/30、docs/06 §2/§3、
 * docs/10 PER-09/PER-10、docs/14 D12）。
 *
 * - API-29（PER-09＝入力元の全読取権＋送信許可）: 源の実在・同unit・現行版を検査し、
 *   永続job（ai.classify）を1本だけ登録する（同一元版＋質問版のdedupe＝docs/06 §3）。
 *   業務rootを持たないjob受付のためexecuteMutationを使わない（jobs.dedupe_keyが冪等の正本。
 *   docs/05 §2「AI job dedupeはAPI冪等キーと役割が異なる」。Idempotency-Keyは契約どおり必須で、
 *   同じ鍵の再送は同じdedupe_keyの既存jobを返す）。実行はjob handlerが行い、202は受付で完了ではない。
 * - API-30（PER-10）: 候補（ai_evaluations）の一覧。status/sourceTypeで絞り、作成降順の
 *   安定keyset（HMAC署名cursor。条件を変えた続き取得・改変cursorは409 SNAPSHOT_CHANGED）。
 *   assistant源のreadResultsは要求者の現可視性で要約を伏せる（maskReadResults。PH5レビューA中1。
 *   非可視文書・撤回済み文書の本文はPER-10保持者にも返さない）。
 *   候補は最終事実ではないため、確定（approve等）はAPI-31（T054）だけが行う。
 */

/** 源の現行版とPER-09本人分の判定用団員を引く（handlers/classificationのloadSourceと同じ版の定義） */
async function loadSourceRef(env: AppEnv, sourceType: string, unitId: string, sourceId: string): Promise<{ version: number; ownerMemberId: string | null } | null> {
  if (sourceType === "facility_inspection" || sourceType === "asset_inspection") {
    const table = sourceType === "facility_inspection" ? "facility_inspections" : "asset_inspections";
    const row = await env.DB.prepare(
      `SELECT i.inspector_member_id, s.version AS series_version
         FROM ${table} i JOIN inspection_series s ON s.id = i.series_id AND s.unit_id = i.unit_id
        WHERE i.id = ? AND i.unit_id = ?`,
    ).bind(sourceId, unitId).first<{ inspector_member_id: string; series_version: number }>();
    return row ? { version: row.series_version, ownerMemberId: row.inspector_member_id } : null;
  }
  if (sourceType === "issue") {
    const row = await env.DB.prepare(
      "SELECT i.version, m.id AS reporter_member_id FROM issues i " +
        "LEFT JOIN members m ON m.user_id = i.reported_by AND m.unit_id = i.unit_id " +
        "WHERE i.id = ? AND i.unit_id = ?",
    ).bind(sourceId, unitId).first<{ version: number; reporter_member_id: string | null }>();
    return row ? { version: row.version, ownerMemberId: row.reporter_member_id } : null;
  }
  return null;
}

// --- 署名付きcursor（notifications.ts（API-67）と同じ流儀。条件を変えた続き取得・改変cursorは409） ---

interface ReviewCursor {
  filterHash: string;
  createdAt: string;
  id: string;
}

const signingKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(`ai-review-cursor:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (ch) => ch.charCodeAt(0));

async function encodeCursor(key: CryptoKey, cursor: ReviewCursor): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(cursor)));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

async function decodeCursor(key: CryptoKey, value: string): Promise<ReviewCursor | null> {
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", key, unb64url(sig) as BufferSource, new TextEncoder().encode(payload));
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(unb64url(payload))) as ReviewCursor;
    if (typeof parsed.filterHash !== "string" || typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * API-30のassistant行のreadResultsを、要求者の**現時点の**可視性で伏せる（PH5レビューA中1）。
 * 文書の参照はisDocumentVisible（src/server/documents/authorized.ts＝単一の正本）で毎要求再検査し、
 * 非可視（ACLのdeny・allow一致無し・撤回済みを含む）なら{type,id,masked:true}だけを返す
 * （要約本文＝文書chunkの先頭2,000字は返さない。docs/10 §4「過去の閲覧許可を永続権限とみなさない」）。
 * unit内の参照（issue/activity/点検。PER-01で可視）は現行どおり全文を返す。保存値（output_json）は
 * 変えない＝API-30の応答投影だけを伏せる（承認のstale検査はreferencesで行うため影響しない）。
 */
async function maskReadResults(
  readResults: readonly AssistantReadResultDto[],
  visible: ReadonlyMap<string, boolean>,
): Promise<AssistantReadResultViewDto[]> {
  return readResults.map((r) => {
    if (r.type !== "document") return r;
    if (visible.get(r.id)) return r;
    return { type: r.type, id: r.id, masked: true } satisfies AssistantReadResultViewDto;
  });
}

/**
 * T091-S8: 見えない文書を参照した行は、回答本文（answer）が非公開文書の内容を含み得る
 * （要約を回答へ引用するため）。readResultsだけ伏せても本文が漏れるので、行単位で
 * answerを固定の伏せ文へ置換し、提案効果を空にし、隠し文書の参照を落とす。
 * 文書の可視判定はidごとに1回（Map）で、readResultsの伏せと共有する。保存値は変えない。
 */
export const MASKED_ASSISTANT_ANSWER = "閲覧できない文書を参照しているため、この回答は表示しません";

async function projectAssistantOutput(env: AppEnv, viewer: AuthzPrincipal, parsed: ReturnType<typeof AssistantCandidateOutput.parse>) {
  const ids = new Set<string>();
  for (const r of parsed.readResults) if (r.type === "document") ids.add(r.id);
  for (const r of parsed.references) if (r.type === "document") ids.add(r.id);
  const visible = new Map<string, boolean>();
  await Promise.all([...ids].map(async (id) => visible.set(id, await isDocumentVisible(env, viewer, id))));
  const readResults = await maskReadResults(parsed.readResults, visible);
  const hidden = new Set([...ids].filter((id) => !visible.get(id)));
  if (hidden.size === 0) return { ...parsed, readResults };
  return {
    ...parsed,
    answer: MASKED_ASSISTANT_ANSWER,
    proposedEffects: [],
    references: parsed.references.filter((r) => !(r.type === "document" && hidden.has(r.id))),
    readResults,
  };
}

export function registerClassificationRoutes(app: ApiApp): void {  // --- API-29: 分類の依頼（202=永続jobの受付。docs/05 §1「202は業務完了と表示しない」） ---
  defineRoute(app, "API-29", async (c) => {
    const p = await resolvePrincipal(c);
    const { body } = await parseApiRequest(c, "API-29");
    // 質問はサーバー固定（docs/06 §2）。未知の版は400（黙って別の質問で送らない）
    if (!isKnownQuestionVersion(body.questionVersion)) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "questionVersion", reason: "unknown_question_version" }]);
    }
    // 源の実在・同unit（存在しない/別unitは同じ404。存在を明かさない）
    const source = await loadSourceRef(c.env, body.sourceType, p.unitId, body.sourceId);
    if (!source) throw new HttpError("NOT_FOUND");
    // PER-09（送信許可）＋入力元の読取権（docs/10 PER-09「入力元の全読取権＋送信許可。検索/生成で昇格しない」。
    // 読取権はPER-01（点検・異常の一覧/閲覧）を同じ対象で評価する。AIで読める範囲を広げない）
    requirePermission(p, "PER-09", { unitId: p.unitId, type: body.sourceType, id: body.sourceId, ownerMemberId: source.ownerMemberId ?? undefined });
    requirePermission(p, "PER-01", { unitId: p.unitId, type: body.sourceType, id: body.sourceId, ownerMemberId: source.ownerMemberId ?? undefined });
    // 元版の一致（旧版は409。実行時にもhandlerが再検査する＝docs/06 §3）
    if (source.version !== body.sourceVersion) throw new HttpError("VERSION_CONFLICT");

    // dedupe_key=`unit|ai.classify|sourceType|sourceId|sourceVersion|questionVersion`（既定の形そのもの。
    // 同一元版＋質問版の再依頼は既存jobを返す＝docs/06 §3「同一元版＋質問版dedupe」）
    const job = await enqueueJob(c.env, {
      unitId: p.unitId,
      kind: "ai.classify",
      sourceType: body.sourceType,
      sourceId: body.sourceId,
      sourceVersion: body.sourceVersion,
      configVersion: body.questionVersion,
      requestedBy: p.userId,
    });
    return ok(c, Job.parse({ id: job.id, status: job.status, attempts: job.attempts, errorCode: job.errorCode, resultRef: job.resultRef }), {}, 202);
  });

  // --- API-30: 候補の一覧（PER-10。候補は最終事実ではない。確定はAPI-31＝T054） ---
  defineRoute(app, "API-30", async (c) => {
    const p = await resolvePrincipal(c);
    const { query } = await parseApiRequest(c, "API-30");
    requirePermission(p, "PER-10", { unitId: p.unitId, type: "ai_evaluation" });

    const where = ["unit_id = ?"];
    const binds: unknown[] = [p.unitId];
    if (query.status) {
      where.push("status = ?");
      binds.push(query.status);
    }
    if (query.sourceType) {
      where.push("source_type = ?");
      binds.push(query.sourceType);
    }

    const key = await signingKey(c.env.BETTER_AUTH_SECRET);
    const { cursor: cursorValue, ...filterOnly } = query;
    const filterHash = await sha256Hex(JSON.stringify(filterOnly));
    if (cursorValue) {
      const cursor = await decodeCursor(key, cursorValue);
      if (!cursor || cursor.filterHash !== filterHash) throw new HttpError("SNAPSHOT_CHANGED");
      // 新しい順（作成降順）の続き。同時刻はid降順で並べ、取りこぼしも重複も作らない
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    const rows = (
      await c.env.DB.prepare(
        `SELECT id, unit_id, job_id, source_type, source_id, source_version, input_hash, input_snapshot_ref,
                question_version, model_id, actual_model_version, output_json, status, usage_json, created_at
           FROM ai_evaluations WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ).bind(...binds, query.limit + 1).all<{
        id: string; unit_id: string; job_id: string; source_type: string; source_id: string; source_version: number;
        input_hash: string; input_snapshot_ref: string | null; question_version: string; model_id: string;
        actual_model_version: string | null; output_json: string; status: string; usage_json: string | null; created_at: string;
      }>()
    ).results;

    const toDto = async (r: (typeof rows)[number]): Promise<AiEvaluationDto> => {
      // assistant源のoutputJsonは要求者の現可視性でreadResultsを伏せてから契約に通す（A中1）。
      // 分類源は従来どおり原文を契約へ通す
      const raw = JSON.parse(r.output_json);
      const outputJson =
        r.source_type === "assistant"
          ? await (async () => {
              const parsed = AssistantCandidateOutput.parse(raw);
              return projectAssistantOutput(c.env, p, parsed);
            })()
          : raw;
      return AiEvaluation.parse({
        id: r.id,
        jobId: r.job_id,
        sourceType: r.source_type,
        sourceId: r.source_id,
        sourceVersion: r.source_version,
        inputHash: r.input_hash,
        inputSnapshotRef: r.input_snapshot_ref,
        questionVersion: r.question_version,
        modelId: r.model_id,
        actualModelVersion: r.actual_model_version,
        outputJson,
        status: r.status,
        usageJson: r.usage_json ? JSON.parse(r.usage_json) : null,
        createdAt: r.created_at,
      });
    };

    const items = await Promise.all(rows.slice(0, query.limit).map(toDto));
    if (rows.length > query.limit) {
      const last = items[items.length - 1]!;
      return ok(c, items, { nextCursor: await encodeCursor(key, { filterHash, createdAt: last.createdAt, id: last.id }) });
    }
    return ok(c, items);
  });
}
