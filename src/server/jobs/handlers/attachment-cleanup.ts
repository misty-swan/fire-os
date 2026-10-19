import type { AppEnv } from "../../env";
import { ATTACHMENT_LIMITS } from "../../attachments/sizes";
import { registerJobHandler } from "../runner";
import type { JobOutcome, LeasedJob } from "../store";

/**
 * 添付の実体削除（T017、docs/07 §3.7）。
 * API-85がD1をtombstone（status='deleting'）にした後に走り、R2の実体を消して 'deleted' へ確定する。
 * 復元（T079）への保護は「削除前にR2状態の別複製を作る」ことで満たす（docs/14 D10。manifestは
 * 削除猶予中のready keyとhashを記録する＝ops/backup-restore.md §1。このjobが削除条件を持つ表は作らない）。
 */
export async function cleanupAttachment(job: LeasedJob, env: AppEnv): Promise<JobOutcome> {
  const att = await env.DB.prepare("SELECT id, unit_id, status, version, staging_key, ready_key FROM attachments WHERE id = ?")
    .bind(job.sourceId)
    .first<{ id: string; unit_id: string; status: string; version: number; staging_key: string | null; ready_key: string | null }>();
  if (!att || att.unit_id !== job.unitId) return { kind: "stale", errorCode: "attachment_missing" };
  if (att.status === "deleted") return { kind: "succeeded" };
  if (att.status !== "deleting") return { kind: "stale", errorCode: "unexpected_status" };
  if (att.version !== job.sourceVersion) return { kind: "stale", errorCode: "source_changed" };

  // R2を先に消し、その後にD1を確定する（R2に残るより「実体が無いtombstone」の方が安全。docs/07 §3.7の照合順序）
  for (const key of [att.staging_key, att.ready_key]) {
    if (key) {
      try {
        await env.FILES.delete(key);
      } catch {
        return { kind: "retryable", errorCode: "r2_delete_failed" };
      }
    }
  }
  const res = await env.DB.batch([
    env.DB.prepare(
      "UPDATE attachments SET status = 'deleted', staging_key = NULL, ready_key = NULL, version = version + 1, updated_at = ? " +
        "WHERE id = ? AND unit_id = ? AND version = ? AND status = 'deleting'",
    ).bind(new Date().toISOString(), att.id, att.unit_id, att.version),
    env.DB.prepare(
      "INSERT INTO attachment_events (id, unit_id, attachment_id, action, details, actor_kind, created_at) VALUES (?, ?, ?, 'deleted', '{}', 'system', ?)",
    ).bind(crypto.randomUUID(), att.unit_id, att.id, new Date().toISOString()),
  ]);
  if ((res[0]?.meta.changes ?? 0) !== 1) return { kind: "stale", errorCode: "source_changed" };
  return { kind: "succeeded" };
}

registerJobHandler("attachment.cleanup", cleanupAttachment);

/**
 * 期限切れ・孤児の回収（Cronから。docs/07 §3.7）。
 * - intentの期限が過ぎた pending_upload を expired へ（転送も完了もできない）
 * - 選ばれず期限が過ぎた転送試行のstaging実体を消す
 * - R2へ書いた後にD1が失敗して台帳に残らなかったstaging実体（孤児）を、R2の staging/ 一覧と台帳の照合で消す
 *   （API-83はR2→D1の順で書く。T085レビューB-I4/DOC-01で未実装を発見して追加）。転送の窓（intent期限）を
 *   過ぎたものだけを対象にし、転送中・完了確定前の実体には触れない
 */
export async function sweepAttachments(env: AppEnv, nowIso: string): Promise<{ expired: number; collected: number; orphans: number }> {
  const expired = await env.DB.prepare(
    "UPDATE attachments SET status = 'expired', version = version + 1, updated_at = ? WHERE status = 'pending_upload' AND expires_at <= ?",
  ).bind(nowIso, nowIso).run();
  let collected = 0;
  const attempts = await env.DB.prepare(
    "SELECT a.id, a.staging_key, a.unit_id FROM upload_attempts a " +
      "JOIN attachments t ON t.id = a.attachment_id AND t.unit_id = a.unit_id " +
      "WHERE a.status = 'uploaded' AND a.expires_at <= ? AND (t.selected_upload_attempt_id IS NULL OR t.selected_upload_attempt_id <> a.id) LIMIT 50",
  ).bind(nowIso).all<{ id: string; staging_key: string; unit_id: string }>();
  for (const a of attempts.results) {
    try {
      await env.FILES.delete(a.staging_key);
      await env.DB.prepare(
        "UPDATE upload_attempts SET status = 'superseded', updated_at = ? WHERE id = ? AND status = 'uploaded'",
      ).bind(nowIso, a.id).run();
      collected++;
    } catch {
      // 次のCronで再試行（状態はuploadedのまま）
    }
  }
  // 孤児の回収は15分ごと（毎分のCronで毎回R2を一覧しない。T085レビューN1）
  const orphans = new Date(nowIso).getUTCMinutes() % STAGING_SWEEP_LIMITS.everyMinutes === 0 ? await sweepOrphanStagingObjects(env, nowIso) : 0;
  return { expired: expired.meta.changes ?? 0, collected, orphans };
}

/** 孤児回収の続き位置（R2の一覧cursor）。staging/ の外に置く小さなオブジェクト（migration不要。T085レビューN1） */
export const STAGING_SWEEP_CURSOR_KEY = "_system/staging-orphan-sweep-cursor";
/** 1回の回収で見る量（ページ数×1ページの件数）。全体はcursorで続きから回り、最後まで行ったら先頭へ戻る */
export const STAGING_SWEEP_LIMITS = { pagesPerRun: 5, pageSize: 100, everyMinutes: 15 } as const;

/**
 * 台帳（upload_attempts／attachments）のどこからも参照されないstaging実体を消す（T085レビューB-I4/DOC-01、N1）。
 * - 前回の続き（R2に保存したcursor）から最大 pagesPerRun×pageSize 件を見る。最後まで行ったらcursorを消して次回は先頭から
 *   （staging/が1,000件を超えても、後ろの孤児にいずれ届く。毎回先頭からだと届かなかった）
 * - 転送の窓（intent期限）を過ぎたものだけを対象にし、転送中・完了確定前の実体には触れない
 * - cursorが失効していたら先頭からやり直す
 */
export async function sweepOrphanStagingObjects(env: AppEnv, nowIso: string): Promise<number> {
  const cutoff = new Date(new Date(nowIso).getTime() - ATTACHMENT_LIMITS.intentTtlMs);
  let removed = 0;
  const saved = await env.FILES.get(STAGING_SWEEP_CURSOR_KEY);
  let cursor: string | undefined = saved ? (await saved.text()) || undefined : undefined;
  for (let page = 0; page < STAGING_SWEEP_LIMITS.pagesPerRun; page++) {
    let listed: R2Objects;
    try {
      listed = await env.FILES.list({ prefix: "staging/", cursor, limit: STAGING_SWEEP_LIMITS.pageSize });
    } catch {
      if (!cursor) throw new Error("staging list failed");
      cursor = undefined; // 失効したcursor。先頭から
      continue;
    }
    const old = listed.objects.filter((o) => o.uploaded <= cutoff).map((o) => o.key);
    for (let i = 0; i < old.length; i += 45) {
      const chunk = old.slice(i, i + 45);
      const marks = chunk.map(() => "?").join(", ");
      const referenced = new Set(
        (await env.DB.prepare(
          `SELECT staging_key AS k FROM upload_attempts WHERE staging_key IN (${marks}) UNION SELECT staging_key AS k FROM attachments WHERE staging_key IN (${marks})`,
        ).bind(...chunk, ...chunk).all<{ k: string }>()).results.map((r) => r.k),
      );
      for (const key of chunk) {
        if (referenced.has(key)) continue;
        try {
          await env.FILES.delete(key);
          removed++;
        } catch {
          // 次の巡回で再試行
        }
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
    if (!cursor) break;
  }
  if (cursor) await env.FILES.put(STAGING_SWEEP_CURSOR_KEY, cursor);
  else await env.FILES.delete(STAGING_SWEEP_CURSOR_KEY);
  return removed;
}
