-- 0029_rag_answers: 出典付きRAG回答と引用の保存（docs/04 §3.4 154-155行のrag_answers/rag_citations、
-- docs/06 §5、docs/10 §4、T067）。ブリーフ表記の0030は0028がT066の索引で使用済みのため、実在最大0028
-- （T066）の次を連番で採番した（docs/14 D23の採番規則。docs/16 T067に記録）。
-- 回答のフロー（docs/16 T067）: 質問→許可chunk検索（T066のport）→生成（T057のLLM基盤）→構造/引用span検証
-- →出力前の現ACL再検査（authorizedDocumentVersions）→本表への保存（1つのD1 batch）→応答。
-- **API-76は読み取り専用POST（Idempotency-Key不要。docs/05 §2）だが、応答の記録として本表へ行を作る**
-- （全文ログ保持D10/D12。監査は既存の検索系と同じく書かない＝本表が回答ログの正本）。

-- 回答ログ（docs/04:154「requester_member_id, query_hash, answer, status, model_id, source_versions」。
-- 追記型＝docs/04 §1の中間表共通列付き。UPDATEしない。DELETEしない）
CREATE TABLE rag_answers (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  -- 回答を依頼した団員（API-76の実行者。回答の再取得でもACL再検査はこの主体で行う〔docs/04:154〕。
  -- 過去回答の再表示契約はT067では作らない＝再取得は原文GET経由の現ACL検査に任せる）
  requester_member_id TEXT NOT NULL,
  -- 質問本文のSHA-256（生の質問は氏名等を含み得るため全文を保存しない＝docs/04:154に質問本文の列は無い。
  -- 回答本文だけがdocs/04:154「全文ログ保持D10/D12」の保存対象。docs/16 T067に記録）
  query_hash TEXT NOT NULL CHECK (length(query_hash) = 64),
  -- 回答本文（引用付き回答、または固定文言の保留応答。1〜20,000＝docs/04 §1のBody上限）
  answer TEXT NOT NULL CHECK (length(answer) BETWEEN 1 AND 20000),
  -- docs/16 T067裁定1のstatus語彙（正本はsrc/shared/states.tsのragAnswerStates＝docs/11 §2「RAG回答」行。
  -- D中2で正本を明記。保存後の遷移は無い〔追記型。API-76は都度新行〕）:
  --   answered  = 引用span検証と出力前ACL再検査を通った回答（citations>=1）
  --   abstained = 根拠不足・検索0件・引用span検証不可（限定retry後も不適合）。「確認できない」応答
  --   withheld  = 出力前再検査で引用元が失権し回答を出せない（生成中の撤回を含む。answered→withheld
  --               の辺＝出力前再検査での失効。docs/16 T067・docs/11 §2）。応答は引用0
  status TEXT NOT NULL CHECK (status IN ('answered', 'abstained', 'withheld')),
  -- 要求したモデル（カタログ名。T053/T057と同じ方針。実モデル版はV04で確定後に一致させる）
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 200),
  -- 引用元の版（重複除去の配列。docs/04:154「source_versions:J」＝根拠版の記録）
  source_versions TEXT NOT NULL CHECK (json_valid(source_versions) AND json_type(source_versions) = 'array'),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  -- 確認日時（docs/16 T067「回答/根拠版/確認日時を保存」。共通列のcreated_atが正本）
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  CHECK (actor_kind = 'human' OR actor_user_id IS NULL),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, requester_member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT
);
-- 回答ログの時系列照会と依頼者別の照合（運用・監査参照用。API-76は都度新行のため一覧契約は無い）
CREATE INDEX idx_rag_answers_unit_created ON rag_answers (unit_id, created_at, id);
CREATE INDEX idx_rag_answers_requester ON rag_answers (unit_id, requester_member_id, id);

-- 引用（docs/04:155「answer_id, chunk_id, quoted_span, page_no, section。両FK、版/ページ/原文を辿れる引用」。
-- 追記型。chunk行は不変（document_versions_no_delete）のため本行のchunk参照は版/ページ/原文へ常に辿れる）
CREATE TABLE rag_citations (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  answer_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  -- 引用された文字列そのもの（chunk.textの部分列。**サーバーが正規化なしの完全一致を検証済み**
  -- ＝docs/06 §5.4「生成した引用を原文位置と突合し」。応答DTOのquotedSpan {start,end}は本列の
  -- chunk.text内の位置で、slice(start,end)が本列と常に一致する）
  quoted_span TEXT NOT NULL CHECK (length(quoted_span) BETWEEN 1 AND 20000),
  -- 引用時点の所在（chunk行の複製＝引用時点のスナップショット。docs/04:155「page_no/section」）
  page_no INTEGER CHECK (page_no IS NULL OR page_no >= 1),
  section TEXT CHECK (section IS NULL OR length(section) BETWEEN 1 AND 200),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  CHECK (actor_kind = 'human' OR actor_user_id IS NULL),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, answer_id) REFERENCES rag_answers (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, chunk_id) REFERENCES document_chunks (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_rag_citations_answer ON rag_citations (unit_id, answer_id);
CREATE INDEX idx_rag_citations_chunk ON rag_citations (unit_id, chunk_id);
