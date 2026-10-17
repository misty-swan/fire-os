import type { AppEnv } from "../../env";
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
 * - 選ばれず期限が過ぎた転送試行のstaging実体を消す（D1が失敗して台帳に残らない孤児は、
 *   鍵の前置きごとのR2一覧での照合が必要。T079のバックアップ/復元の照合と一緒に実装する）
 */
export async function sweepAttachments(env: AppEnv, nowIso: string): Promise<{ expired: number; collected: number }> {
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
  return { expired: expired.meta.changes ?? 0, collected };
}
