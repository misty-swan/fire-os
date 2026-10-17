import type { AppEnv } from "../../env";
import { enqueueJobStatement } from "../store";
import type { JobOutcome, LeasedJob } from "../store";
import { registerJobHandler } from "../runner";
import { insertLinkSql, LINK_ENTITY_TABLES } from "../../attachments/link";
import { FileScanner } from "../../attachments/scanner";
import { readyKeyFor } from "../../attachments/sizes";
import { recordMetricSafe } from "../../observability/metrics";

/**
 * 添付の検査job（T016）。API-84のcompletionと同じbatchで登録された job(attachment.inspect) を実行する。
 *
 * 流れ: 元版と状態を確認 → checking へ動かす（条件付き更新。取れなければstale）→ stagingを実体検査
 *  → 不合格なら rejected（jobは正しい終端として成功）/ 合格なら不変ready keyへ保存し、**もう一度元版を確認してから** ready へ確定。
 * 失敗（取得できない等）は clean として通さず再試行する（docs/07 §3.4）。
 */
export async function inspectUpload(job: LeasedJob, env: AppEnv): Promise<JobOutcome> {
  const att = await env.DB.prepare(
    "SELECT id, unit_id, status, version, staging_key, sha256, content_type, byte_size, intent_target_type, intent_target_id, owner_user_id FROM attachments WHERE id = ?",
  ).bind(job.sourceId).first<{
    id: string; unit_id: string; status: string; version: number;
    staging_key: string | null; sha256: string | null; content_type: string; byte_size: number;
    intent_target_type: string; intent_target_id: string; owner_user_id: string;
  }>();
  if (!att || att.unit_id !== job.unitId) return { kind: "stale", errorCode: "attachment_missing" };
  // 元版の確認: uploadedの初回だけ版の完全一致を要求する。checkingは検査の途中なので、
  // 自分が対象の検査jobの再試行（unavailable等。docs/07 §3.4）は再入を許す（checkingへの切替は済んでいる）。
  // readyはもう確定済み、その他の状態はこのjobの結果を使えないためstale。
  if (att.status === "uploaded") {
    if (att.version !== job.sourceVersion) return { kind: "stale", errorCode: "source_changed" };
  } else if (att.status === "checking") {
    // 再入OK（下のcheckingへの切替はスキップする）
  } else if (att.status === "ready") {
    return { kind: "stale", errorCode: "already_ready" };
  } else {
    return { kind: "stale", errorCode: "unexpected_status" };
  }
  if (!att.staging_key || !att.sha256) return { kind: "manual_review", errorCode: "missing_selected_object" };

  // checking へ動かす。0行（他が変えた）ならこのjobの結果は使えない。checking再入では切替済みなので続行する
  const nowIso = new Date().toISOString();
  let checkingVersion: number;
  if (att.status === "uploaded") {
    const checking = await env.DB.prepare(
      "UPDATE attachments SET status = 'checking', version = version + 1, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ? AND status = 'uploaded'",
    ).bind(nowIso, att.id, att.unit_id, att.version).run();
    if ((checking.meta.changes ?? 0) !== 1) return { kind: "stale", errorCode: "source_changed" };
    checkingVersion = att.version + 1;
  } else {
    checkingVersion = att.version;
  }

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
      // 検査で拒否された添付は親の予約から外す（拒否された写真のせいで、残りの準備完了した写真も親に渡せなくなるため）
      env.DB.prepare("UPDATE attachments SET draft_id = NULL WHERE id = ? AND draft_id IS NOT NULL").bind(att.id),
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
  // ready確定と同じbatchで、既存の業務対象へ直アップロードされた添付（編集画面のuploader経路。docs/07 §3.5）の
  // 初回リンクを作る。draft経由（attachment_draft対象）は業務mutationが予約を消費してリンクするため、ここでは作らない。
  // 対象表はLINK_ENTITY_TABLES（facility/vehicle/equipment）だけ。点検・異常など業務mutationが条件と監査を
  // 付けてリンクする種別は、ここでは自動リンクしない（未対応表はリンクを作らずスキップ＝既存挙動のまま）。
  const linkTable = LINK_ENTITY_TABLES[att.intent_target_type];
  const linkStatement = linkTable
    ? env.DB.prepare(
        // insertLinkSql(false)と同じ形: sensitiveは基本の対象へリンクしない（docs/10。分類の引下げもしない）。
        // NOT EXISTSは「有効リンクが1本も無い」こと（同対象だけではない。点検保存が先に点検へリンクしていたら
        // 施設へはリンクしない。job→保存/保存→jobのどちらでも最終状態を1本へ決定論化。docs/07 §3.5）。
        // 対象が同unitに存在しなければ0行＝スキップする
        insertLinkSql(false) +
          "a.id = ? AND NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.attachment_id = a.id AND l.unlinked_at IS NULL) " +
          `AND EXISTS (SELECT 1 FROM ${linkTable} t WHERE t.id = ? AND t.unit_id = ?)`,
      ).bind(
        crypto.randomUUID(), att.unit_id, att.intent_target_type, att.intent_target_id,
        // リンクしたのは添付の所有者（intentを作った人）
        att.owner_user_id, nowIso, nowIso, att.owner_user_id, att.unit_id,
        att.id, att.intent_target_id, att.unit_id,
      )
    : null;
  const finalize = await env.DB.batch([
    env.DB.prepare(
      "UPDATE attachments SET status = 'ready', ready_key = ?, sha256 = ?, byte_size = ?, version = version + 1, updated_at = ? " +
        "WHERE id = ? AND unit_id = ? AND version = ? AND status = 'checking'",
    ).bind(readyKey, scan.sha256, scan.bytes.byteLength, nowIso, att.id, att.unit_id, checkingVersion),
    env.DB.prepare(
      "INSERT INTO attachment_events (id, unit_id, attachment_id, action, details, actor_kind, created_at) VALUES (?, ?, ?, 'inspect.passed', ?, 'system', ?)",
    ).bind(crypto.randomUUID(), att.unit_id, att.id, JSON.stringify({ key: readyKey, size: scan.bytes.byteLength }), nowIso),
    // リンク文は親（attachments）のready確定より後に置く。UPDATEが0行（他が変えた）なら a.status='ready' にならず0行で揃う
    ...(linkStatement ? [linkStatement] : []),
  ]);
  if ((finalize[0]?.meta.changes ?? 0) !== 1) {
    // 遅れて確定しようとした案件。ready候補のオブジェクトは孤児として回収対象（D10の遅延削除）
    return { kind: "stale", errorCode: "source_changed" };
  }
  // 使用量の計上（T080）: 新規に保存した分だけ（既存の不変キーの再利用はR2の増分0なので計上しない）。
  // 観測は業務を止めない（docs/07 §8。byte_sizeは検査jobが確定した既知値）
  if (!existing) {
    await recordMetricSafe(env, {
      service: "r2", metric: "r2.bytes.stored", unit: "bytes", amount: scan.bytes.byteLength, source: "job:attachment.inspect",
    });
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
