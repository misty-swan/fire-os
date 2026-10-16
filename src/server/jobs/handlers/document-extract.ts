import type { AppEnv } from "../../env";
import { CHUNK_MAX_PER_VERSION, chunkDocument } from "../../documents/chunk";
import { DocumentExtractError, ExtractStorageError, extractDocument } from "../../documents/extract";
import { registerJobHandler } from "../runner";
import type { JobOutcome, LeasedJob } from "../store";

/**
 * 文書抽出job（T064、docs/06 §5、docs/04:152、docs/11 永続ジョブ）。API-74が登録した
 * document.extract job（kind='document.extract' / source_type='document_version' / source_id=versionId /
 * dedupe_key=`unit|document.extract|documentId|versionId`）を受ける。
 *
 * 実行時の再検査（docs/06 §3流儀）:
 *  ①版が実在し、**withdrawnでない**（撤回・失効はstale。プリフライト裁定1。draft/in_review/approved/
 *    superseded/changes_requestedは抽出してよい=非承認版のchunk計算と検索可能性は別で、
 *    **index_statusは検索可能を意味しない**。検索はT066が承認済み＋authorizedDocumentVersionsで二重に絞る）
 *  ②jobのsourceVersion（revision_no）と版の一致（revision_noは不変なので構造的な取り違いの検出）
 *  ③原本添付がreadyでsha256が版のcontent_hashと一致（原本hash照合。不一致はmanual_review）
 *  ④抽出→chunk化→**document_chunksを1つのD1 batchで確定**（既存chunkは全削除+再INSERTで冪等。
 *    job再実行・lease失効後の再実行でも重複0。UNIQUE(unit_id,version_id,chunk_no)）
 *
 * 画像のみのPDF・壊れたPDF・対応できない要素は**fail-closed**でmanual_reviewにし、chunk本文を
 * 1字も保存しない（OCRは未実装=docs/evidence/V04-retrieval.md。docs/14 D20）。
 */
export async function extractDocumentVersion(job: LeasedJob, env: AppEnv): Promise<JobOutcome> {
  const stale = (errorCode: string): JobOutcome => ({ kind: "stale", errorCode });

  // ①版の実在と非withdrawn（文書rootの撤回=即時に抽出対象から外れる）
  const version = await env.DB.prepare(
    "SELECT v.id, v.unit_id, v.document_id, v.revision_no, v.attachment_id, v.status, v.content_hash, d.status AS document_status " +
      "FROM document_versions v JOIN documents d ON d.unit_id = v.unit_id AND d.id = v.document_id WHERE v.id = ?",
  ).bind(job.sourceId).first<{
    id: string; unit_id: string; document_id: string; revision_no: number; attachment_id: string;
    status: string; content_hash: string; document_status: string;
  }>();
  if (!version || version.unit_id !== job.unitId) return stale("document_version_missing");
  if (version.document_status === "withdrawn" || version.status === "withdrawn") return stale("document_withdrawn");
  // ②jobが指した版（revision_noは不変。不一致は別の版を対象にしたjob=この結果は使えない）
  if (version.revision_no !== job.sourceVersion) return stale("source_changed");

  // ③原本の再検査（ready＋sha256=版のcontent_hash。抽出はこの対が揃ったbytesだけで行う）
  const att = await env.DB.prepare("SELECT id, unit_id, status, sha256 FROM attachments WHERE id = ?")
    .bind(version.attachment_id)
    .first<{ id: string; unit_id: string; status: string; sha256: string | null }>();
  if (!att || att.unit_id !== job.unitId) return { kind: "manual_review", errorCode: "attachment_unavailable" };
  if (att.status !== "ready") return { kind: "manual_review", errorCode: "attachment_not_ready" };
  if (!att.sha256 || att.sha256 !== version.content_hash) return { kind: "manual_review", errorCode: "hash_mismatch" };

  // ④抽出とchunk化（失敗はfail-closedで保留。R2の一時的欠落だけは再試行）
  let extracted;
  try {
    extracted = await extractDocument(env, { versionId: version.id, attachmentId: version.attachment_id });
  } catch (err) {
    if (err instanceof DocumentExtractError) return { kind: "manual_review", errorCode: err.errorCode };
    if (err instanceof ExtractStorageError) return { kind: "retryable", errorCode: "storage_unavailable" };
    throw err; // 予期しない例外はrunnerが再試行扱いにする（例外本文は保存しない）
  }
  const chunks = chunkDocument(extracted);
  if (chunks.length === 0) return { kind: "manual_review", errorCode: "unextractable_document" };
  if (chunks.length > CHUNK_MAX_PER_VERSION) {
    // 捏造や間引きで収めず、人手確認へ（docs/16 T064。上限の根拠は1batchの文数）
    return { kind: "manual_review", errorCode: "chunk_limit_exceeded" };
  }

  // document_chunksを1つのD1 batchで確定（全削除+再INSERT。DELETEが先、INSERTはUNIQUEの順に並ぶ）。
  // ステートメントは1文あたりのbind上限（100）内で8行ずつの複数行INSERTにまとめる
  const nowIso = new Date().toISOString();
  const statements = [
    env.DB.prepare("DELETE FROM document_chunks WHERE unit_id = ? AND version_id = ?").bind(job.unitId, version.id),
  ];
  const VALUES_PLACEHOLDER = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
  for (let at = 0; at < chunks.length; at += 8) {
    const group = chunks.slice(at, at + 8);
    const binds: unknown[] = [];
    for (const chunk of group) {
      binds.push(
        crypto.randomUUID(), // id
        job.unitId,
        version.id,
        chunk.chunkNo,
        chunk.pageNo,
        chunk.section,
        chunk.text,
        JSON.stringify(chunk.sourceOffsets),
        "pending", // index_status（語彙pending/indexed/removed。検索可能を意味しない=T066が絞る）
        nowIso, // created_at
        nowIso, // updated_at
        "system", // actor_kind（抽出jobはシステム書込。created_byはNULL）
      );
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO document_chunks (id, unit_id, version_id, chunk_no, page_no, section, text, source_offsets, index_status, created_at, updated_at, actor_kind) VALUES ${group
          .map(() => VALUES_PLACEHOLDER)
          .join(", ")}`,
      ).bind(...binds),
    );
  }
  await env.DB.batch(statements);
  // result_refに短い要約（CSV解析jobのresult_ref流儀。`ready:<chunk数>:<頁数>`）
  return { kind: "succeeded", resultRef: `ready:${chunks.length}:${extracted.pages.length}` };
}

// Cron/Queueと同じ登録点。routes/documents.ts経由でWorkerに読み込まれる
registerJobHandler("document.extract", extractDocumentVersion);
