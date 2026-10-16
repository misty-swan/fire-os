import type { AppEnv } from "../../env";
import { registerJobHandler } from "../runner";
import type { JobOutcome, LeasedJob } from "../store";

/**
 * 文書索引job（T066、docs/06 §5、docs/10 §4、docs/04:152、docs/16 T066）。T063がenqueueした
 * document.index（承認時・API-75）/ document.deindex（撤回時・API-92）/ document.reindex（ACL変更時・API-99）
 * の3種を受ける（source_type='document_version' / source_id=versionId / config_version='v1' /
 * dedupe_key=`unit|kind|documentId|versionId`）。3種を1つのhandlerにまとめ、**実行時に現状態と
 * 突き合わせて収束させる**（jobの実行順・再実行・遅延に依存しない冪等。docs/16 T063「job実行時に
 * この関数の結果と突き合わせる」方式のT066実装）。
 *
 * 現状態との突き合わせ（docs/06 §5.2「承認済有効版だけをchunk化/索引化」）:
 * - **索引化の対象は「承認済み（status='approved'）＋非withdrawn」の版だけ**。ACL（document_acl）は
 *   索引化の条件にしない（ACLは人ごとの差で、検索時のunit前置＋authorizedDocumentVersions再検査で
 *   毎回D1の現ACLに突き合わせる。システム主体の可視判定を索引側に置くと、allow行の付け替えで
 *   索引が取りこぼされるため。docs/16 T066のプリフライト裁定3）。
 * - document.index が失権中（superseded/withdrawn）の版を指したときは**索引化しない**でstale
 *   （error_code=document_version_not_indexable。staleIndexActivated=false）。
 * - document.reindex が失権中の版を指したときは deindex と同じ回収（FTS行の削除＋removed）をする
 *   （ACL変更と撤回が競合したとき、どちらが先に走っても索引が現状態へ収束する）。
 * - document.deindex は現状態によらず常に回収する（撤回は終端で、回収を怠るとFTS行が残る）。
 *
 * 冪等（jobは再実行されてよい。lease失効後の再実行・重複実行で効果0）:
 * - index/reindexは「**FTS行の全削除＋現chunksからの再投入＋index_status/index_keyの更新**」を
 *   1つのD1 batchで確定する（重複実行でもFTS行数・chunk状態は不変）。
 * - deindexは「FTS行の全削除＋index_status='removed'＋index_key=NULL」を1つのD1 batchで確定する。
 * - chunksのindex_status（pending/indexed/removed）が**現在状態の正本**（docs/16 T066のプリフライト
 *   裁定4）。検索（src/server/search/adapter.ts）はindex_status='indexed'かつ現ACL可視のみを返す。
 *
 * 遅延・失敗の可視化: FTS更新の失敗はjobのerror_code（短コード）で落とし、result_refに
 * `indexed:<FTS行数>` / `removed:<chunk行数>` を残す（CSV解析job・抽出jobのresult_ref流儀）。
 * 抽出job（document.extract）がまだ走っていない版はchunksが確定していないため、retryableで
 * 待ってから索引化する（chunks 0件を黙って確定しない。docs/16 T064「index job側でchunksが
 * 有ることを確認してから索引化が安全」）。
 */

/** FTS仮想表（drizzle/0028_search_index.sql。trigram。T065選定のd1_fts用） */
export const FTS_TABLE = "document_chunks_fts";
/** index_keyの前置（索引方式とconfig版。FTS行との対応は <前置>/<chunkId>） */
export const INDEX_KEY_PREFIX = "d1_fts:v1";

interface VersionStateRow {
  id: string; unit_id: string; document_id: string; revision_no: number;
  status: string; document_status: string;
}

/** 抽出jobがまだ確定していないか（queued/retry_wait/running。chunks 0件の黙確定を防ぐ） */
async function extractJobInFlight(env: AppEnv, unitId: string, versionId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 FROM jobs WHERE unit_id = ? AND kind = 'document.extract' AND source_id = ? " +
      "AND status IN ('queued', 'retry_wait', 'running') LIMIT 1",
  ).bind(unitId, versionId).first();
  return row !== null;
}

/**
 * 索引jobの本体（document.index/deindex/reindexの3種。JobHandlerと同じ引数順。
 * ブリーフ表記のindexDocument(env,job)に対し、registerJobHandlerのJobHandler
 * （(job,env)=>Promise<JobOutcome>）に直接登録できるよう引数順を合わせた〔docs/16 T066に記録〕）。
 */
export async function indexDocument(job: LeasedJob, env: AppEnv): Promise<JobOutcome> {
  const stale = (errorCode: string): JobOutcome => ({ kind: "stale", errorCode });
  if (job.kind !== "document.index" && job.kind !== "document.deindex" && job.kind !== "document.reindex") {
    return { kind: "manual_review", errorCode: "unexpected_kind" };
  }

  // ①版と文書の現状態（版はappend-onlyなので欠落は「最初から存在しない」job＝stale）
  const version = await env.DB.prepare(
    "SELECT v.id, v.unit_id, v.document_id, v.revision_no, v.status, d.status AS document_status " +
      "FROM document_versions v JOIN documents d ON d.unit_id = v.unit_id AND d.id = v.document_id WHERE v.id = ?",
  ).bind(job.sourceId).first<VersionStateRow>();
  if (!version || version.unit_id !== job.unitId) return stale("document_version_missing");
  // revision_noは不変。jobが別の版を指している（構造的な取り違い）ならこの結果は使えない
  if (version.revision_no !== job.sourceVersion) return stale("source_changed");
  // ②現状態との突き合わせ（承認済み＋非withdrawnだけが索引化の対象。ACLは検索時に再検査）
  const indexable = version.status === "approved" && version.document_status !== "withdrawn";

  // ③回収（deindex、または失権中のreindex）: FTS行の全削除＋chunksをremovedへ。1つのbatchで冪等。
  // 確定数はbatch後のCOUNTで取る（batch内のmeta.changesはFTS仮想表のDELETEで信頼できる計上にならない）
  if (job.kind === "document.deindex" || (job.kind === "document.reindex" && !indexable)) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM ${FTS_TABLE} WHERE unit_id = ? AND version_id = ?`).bind(job.unitId, version.id),
      env.DB.prepare(
        "UPDATE document_chunks SET index_status = 'removed', index_key = NULL, updated_at = ? " +
          "WHERE unit_id = ? AND version_id = ? AND index_status <> 'removed'",
      ).bind(new Date().toISOString(), job.unitId, version.id),
    ]);
    const removed = await env.DB.prepare(
      "SELECT count(*) AS n FROM document_chunks WHERE unit_id = ? AND version_id = ? AND index_status = 'removed'",
    ).bind(job.unitId, version.id).first<{ n: number }>();
    return { kind: "succeeded", resultRef: `removed:${removed?.n ?? 0}` };
  }

  // ④失権中のindex jobは索引化しない（承認時の前提が崩れている。staleIndexActivated=false）
  if (job.kind === "document.index" && !indexable) return stale("document_version_not_indexable");

  // ⑤抽出jobがまだ走っているならchunksの確定を待つ（chunks 0件の黙確定を防ぐ）
  const chunkCount = await env.DB.prepare(
    "SELECT count(*) AS n FROM document_chunks WHERE unit_id = ? AND version_id = ?",
  ).bind(job.unitId, version.id).first<{ n: number }>();
  if ((chunkCount?.n ?? 0) === 0 && (await extractJobInFlight(env, job.unitId, version.id))) {
    return { kind: "retryable", errorCode: "chunks_pending" };
  }

  // ⑥索引の再構築（index/reindex。FTS行の全削除＋現chunksからの再投入＋indexedへ切替）。
  // 1つのD1 batchで確定する（FTSとchunksの状態が同時に動く。重複実行でも効果0）
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM ${FTS_TABLE} WHERE unit_id = ? AND version_id = ?`).bind(job.unitId, version.id),
    env.DB.prepare(
      `INSERT INTO ${FTS_TABLE} (chunk_id, unit_id, version_id, document_id, page_no, chunk_no, text) ` +
        "SELECT c.id, c.unit_id, c.version_id, ?, c.page_no, c.chunk_no, c.text " +
        "FROM document_chunks c WHERE c.unit_id = ? AND c.version_id = ? ORDER BY c.chunk_no",
    ).bind(version.document_id, job.unitId, version.id),
    env.DB.prepare(
      "UPDATE document_chunks SET index_status = 'indexed', index_key = ? || '/' || id, updated_at = ? " +
        "WHERE unit_id = ? AND version_id = ?",
    ).bind(INDEX_KEY_PREFIX, new Date().toISOString(), job.unitId, version.id),
  ]);
  const indexed = await env.DB.prepare(
    `SELECT count(*) AS n FROM ${FTS_TABLE} WHERE unit_id = ? AND version_id = ?`,
  ).bind(job.unitId, version.id).first<{ n: number }>();
  return { kind: "succeeded", resultRef: `indexed:${indexed?.n ?? 0}` };
}

// Cron/Queueと同じ登録点（3種のjob kindを同じhandlerへ）。routes/documents.ts経由でWorkerに読み込まれる
registerJobHandler("document.index", indexDocument);
registerJobHandler("document.deindex", indexDocument);
registerJobHandler("document.reindex", indexDocument);
