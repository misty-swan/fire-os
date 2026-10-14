import type { AppEnv } from "../../env";
import { enqueueJobStatement } from "../store";
import type { JobOutcome, LeasedJob } from "../store";
import { registerJobHandler } from "../runner";
import { FileScanner } from "../../attachments/scanner";
import { readyKeyFor } from "../../attachments/sizes";

/**
 * 添付の検査job（T016）。API-84のcompletionと同じbatchで登録された job(attachment.inspect) を実行する。
 *
 * 流れ: 元版と状態を確認 → checking へ動かす（条件付き更新。取れなければstale）→ stagingを実体検査
 *  → 不合格なら rejected（jobは正しい終端として成功）/ 合格なら不変ready keyへ保存し、**もう一度元版を確認してから** ready へ確定。
 * 失敗（取得できない等）は clean として通さず再試行する（docs/07 §3.4）。
 */
export async function inspectUpload(job: LeasedJob, env: AppEnv): Promise<JobOutcome> {
  const att = await env.DB.prepare(
    "SELECT id, unit_id, status, version, staging_key, sha256, content_type, byte_size FROM attachments WHERE id = ?",
  ).bind(job.sourceId).first<{
    id: string; unit_id: string; status: string; version: number;
    staging_key: string | null; sha256: string | null; content_type: string; byte_size: number;
  }>();
  if (!att || att.unit_id !== job.unitId) return { kind: "stale", errorCode: "attachment_missing" };
  if (att.version !== job.sourceVersion) return { kind: "stale", errorCode: "source_changed" };
  if (att.status === "ready") return { kind: "stale", errorCode: "already_ready" };
  if (att.status !== "uploaded") return { kind: "stale", errorCode: "unexpected_status" };
  if (!att.staging_key || !att.sha256) return { kind: "manual_review", errorCode: "missing_selected_object" };

  // checking へ動かす。0行（他が変えた）ならこのjobの結果は使えない
  const nowIso = new Date().toISOString();
  const checking = await env.DB.prepare(
    "UPDATE attachments SET status = 'checking', version = version + 1, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ? AND status = 'uploaded'",
  ).bind(nowIso, att.id, att.unit_id, att.version).run();
  if ((checking.meta.changes ?? 0) !== 1) return { kind: "stale", errorCode: "source_changed" };
  const checkingVersion = att.version + 1;

  const scan = await FileScanner.scan({ key: att.staging_key, contentType: att.content_type, sha256: att.sha256 }, env.FILES);

  if (scan.verdict === "unavailable") {
    // 合格でも不合格でもない。checking のまま再試行（上限で手動確認へ）
    return { kind: "retryable", errorCode: "scanner_unavailable" };
  }
  if (scan.verdict === "rejected") {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE attachments SET status = 'rejected', version = version + 1, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ? AND status = 'checking'",
      ).bind(nowIso, att.id, att.unit_id, checkingVersion),
      env.DB.prepare(
        "UPDATE upload_attempts SET status = 'rejected', version = version + 1, updated_at = ? WHERE id = (SELECT selected_upload_attempt_id FROM attachments WHERE id = ?) AND status = 'selected'",
      ).bind(nowIso, att.id),
      env.DB.prepare(
        "INSERT INTO attachment_events (id, unit_id, attachment_id, action, details, actor_kind, created_at) VALUES (?, ?, ?, 'inspect.rejected', ?, 'system', ?)",
      ).bind(crypto.randomUUID(), att.unit_id, att.id, JSON.stringify({ reason: scan.reason }), nowIso),
    ]);
    // 検査=不合格は正しい終端（再試行しない）。jobとしては成功
    return { kind: "succeeded", resultRef: `rejected:${scan.reason}` };
  }

  // clean: 不変ready key（内容hashで固定）へ保存。既にある場合は再利用する
  const readyKey = readyKeyFor(att.unit_id, att.id, scan.sha256);
  const existing = await env.FILES.head(readyKey);
  if (!existing) {
    await env.FILES.put(readyKey, scan.bytes as BufferSource, { sha256: scan.sha256 });
  }
  const stored = await env.FILES.head(readyKey);
  if (!stored || stored.size !== scan.bytes.byteLength) {
    return { kind: "retryable", errorCode: "ready_object_unavailable" };
  }
  // 確定の直前にもう一度元版を確認する（checkingの間に変更が入っていないか）
  const finalize = await env.DB.batch([
    env.DB.prepare(
      "UPDATE attachments SET status = 'ready', ready_key = ?, sha256 = ?, byte_size = ?, version = version + 1, updated_at = ? " +
        "WHERE id = ? AND unit_id = ? AND version = ? AND status = 'checking'",
    ).bind(readyKey, scan.sha256, scan.bytes.byteLength, nowIso, att.id, att.unit_id, checkingVersion),
    env.DB.prepare(
      "INSERT INTO attachment_events (id, unit_id, attachment_id, action, details, actor_kind, created_at) VALUES (?, ?, ?, 'inspect.passed', ?, 'system', ?)",
    ).bind(crypto.randomUUID(), att.unit_id, att.id, JSON.stringify({ key: readyKey, size: scan.bytes.byteLength }), nowIso),
  ]);
  if ((finalize[0]?.meta.changes ?? 0) !== 1) {
    // 遅れて確定しようとした案件。ready候補のオブジェクトは孤児として回収対象（D10の遅延削除）
    return { kind: "stale", errorCode: "source_changed" };
  }
  return { kind: "succeeded", resultRef: readyKey };
}

// Cron/Queueと同じ登録点。routes.ts経由でWorkerに読み込まれる
registerJobHandler("attachment.inspect", inspectUpload);

/** 検査jobの再登録（専用のdedupe keyで。試験や運用手順から使う） */
export function reinspectJobStatement(env: Pick<AppEnv, "DB">, unitId: string, attachmentId: string, sourceVersion: number, key: string) {
  return enqueueJobStatement(env, {
    unitId,
    kind: "attachment.inspect",
    sourceType: "attachment",
    sourceId: attachmentId,
    sourceVersion,
    configVersion: "v1",
    requestedBy: null,
    dedupeKey: key,
  });
}
