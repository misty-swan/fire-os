-- 0028_search_index: D1全文検索（FTS5・trigram）の仮想表（docs/06 §5、docs/04 §3.4/§4、docs/14 D16、T066）。
-- ブリーフ（T066）にmigrationは無いが、T065が選定したd1_fts＋trigramを本番経路へ接続するために
-- FTS仮想表の恒久DDLが要る。実在最大0027（T062〜T064）の次を連番で採番（docs/14 D23の採番規則。
-- T067=0029/T071=0030へ繰り下げ済み＝docs/16の台帳に記録）。
--
-- 方式（docs/evidence/V04-retrieval.md T066節に詳細を記録）:
-- - **単独のFTS5仮想表**（外部contentテーブル方式は使わない）。T065の選定評価
--   （buildEvaluationFtsTables/searchFtsTable。tests/retrieval-selection.test.tsで実測）と同じ
--   列構成で、評価時の実測結果（trigram recall@5=0.581・unauthorizedChunks=0）がそのまま当てはまる。
--   索引の投入/回収はdocument.index/deindex/reindex job（T063がenqueue・T066がhandler）が
--   「全削除＋再投入」の1つのD1 batchで行い、重複を作らない（jobの再実行で効果0）。
-- - **document_chunksとの対応**: FTS行のchunk_id（UNINDEXED列）＝document_chunks.id。
--   document_chunks.index_keyには `d1_fts:v1/<chunkId>` を保存する（T064がNULLで作成。
--   index_key IS NOT NULL ⇔ index_status='indexed'。deindex/reindexの回収時にNULLへ戻す）。
-- - tokenizer='trigram' はconfig/search-development.json（T065選定。unicode61は日本語を
--   分かち書きしない実測のため不採用）と一致する。tokenizerを変える再評価（D16/V04の
--   Vectorize比較等）のときは、新しい仮想表のDDLと全文書の再索引（reindex）を同じ改訂で行う。
-- - 仮想表にはB-tree索引・UNIQUE制約を持てないため、検索時の絞り（v.status='approved'・
--   d.status<>'withdrawn'・c.index_status='indexed'）とhit後のauthorizedDocumentVersions再検査
--   （src/server/documents/authorized.ts＝単一の正本）で毎回D1の現状態に突き合わせる
--   （docs/10 §4「検索前フィルター＋生成前再検査」、docs/06 §5.5「索引削除が遅れてもD1再検査で漏らさない」）。
--   検索可能を意味するのはあくまでdocument_chunks.index_status='indexed'＋現ACL可視であり、
--   index_status（pending/indexed/removed）が現在状態の正本。
CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  chunk_id UNINDEXED,
  unit_id UNINDEXED,
  version_id UNINDEXED,
  document_id UNINDEXED,
  page_no UNINDEXED,
  chunk_no UNINDEXED,
  text,
  tokenize = 'trigram'
);
