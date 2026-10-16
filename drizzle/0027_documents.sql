-- 0027_documents: 許諾文書の原本・版・ACL・chunk（docs/04 §3.4 149-152行、docs/06 §5、T062）。
-- ブリーフ表記の0023は0023=ai（T053）で使用済みのため、実在最大0026（T061）の次を連番で採番した
-- （docs/14 D23の採番規則。docs/16 T062に記録）。T064にmigrationが無いためdocument_chunksもここで
-- 全部作る（0022/0024と同じ裁定「新ドメインのDDLはその最初の保存タスクで作る」。T064は書込のみ）。
-- 版の状態（docs/11 報告書/文書版）: document_versionsはreport_versionsと同じcontentVersionStatesのCHECK。
-- 文書rootのstatus（docs/11「文書全体のstatusは各機能タスクで列挙」のT062実装。D03未承認の検証設定）:
-- draft（作成直後。承認版はまだ）→ approved（T063の承認で有効承認版あり。RAG対象）→ withdrawn（撤回。終端）。

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  -- 分類（docs/04:149「classification:T」。自由記述の短い語。ACL改訂と一緒にAPI-99で変わる）
  classification TEXT NOT NULL CHECK (length(classification) BETWEEN 1 AND 100),
  -- docs/11「承認版とdraftの別pointer」「承認済pointerは次版承認まで保持」。T062はdraftのみ切替る
  current_version_id TEXT,
  current_draft_version_id TEXT,
  -- 文書全体の状態（上の注記どおりT062で列挙。draft/approved/withdrawn）
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'withdrawn')),
  -- ACL・分類の改訂版（API-75/99の応答契約がpolicyVersionを返すため。docs/04:149には無い列をT062で追加。
  -- docs/04の該当行を同じコミットで更新。API-99のACL変更で増分する。docs/16 T062に記録）
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  UNIQUE (unit_id, id),
  -- 循環参照（versions側からもdocumentsへFK）のためDMLの順序は「root(NULL付きINSERT)→版→pointer切替」
  FOREIGN KEY (unit_id, current_version_id) REFERENCES document_versions (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, current_draft_version_id) REFERENCES document_versions (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_documents_unit_status ON documents (unit_id, status, id);

CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  -- 原本添付への直接参照（docs/04:150「attachment_id:T」。同unit・readyのみ受理はサービス層の検査）。
  -- 取得（API-27のACL再検査）の経路は同じ(document, attachment)のattachment_links行を版作成時に1本
  -- 作る（docs/16 T062の裁定: 直参照とlink併用。linkはAPI-101のunlink・撤回時の遮断に使える）
  attachment_id TEXT NOT NULL,
  -- docs/11 報告書/文書版（report_versionsと同じ語彙。T062はdraftで作るだけ。承認はT063）
  status TEXT NOT NULL CHECK (status IN ('draft', 'in_review', 'approved', 'changes_requested', 'superseded', 'withdrawn')),
  approved_by TEXT,
  approved_at TEXT CHECK (approved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', approved_at) IS approved_at),
  -- 許諾の出典（必須。docs/04:150「license_ref:T」。API-74の契約必須。無い版は作れない）
  license_ref TEXT NOT NULL CHECK (length(license_ref) BETWEEN 1 AND 200),
  -- 原本のsha256（版作成時に添付から固定。後続の版作成でも書変わらない＝原本不変の検証点）
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- 承認記録（approved_by/approved_at）は、承認されたことがある版（approved。superseded/withdrawnへ
  -- 遷んだ後も保持）だけが持つ。T063でin-place拡張（0022/T051と同じ前例。docs/16 T063に記録）:
  -- T062作成時の「approvedだけ」の語のままだと、旧承認版のapproved→superseded遷移（docs/11。
  -- 承認列は不変のままstatusだけ遷める）がこのCHECKで失敗し、docs/11の状態機械と両立しないため
  CHECK (status IN ('approved', 'superseded', 'withdrawn') = (approved_by IS NOT NULL)),
  CHECK (status IN ('approved', 'superseded', 'withdrawn') = (approved_at IS NOT NULL)),
  -- 「文書/版UNIQUE」（docs/04:150）。unit一致を含める（docs/04 §1の複合原則）
  UNIQUE (unit_id, document_id, revision_no),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, document_id) REFERENCES documents (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, attachment_id) REFERENCES attachments (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_document_versions_document ON document_versions (document_id, revision_no);

-- 版の内容は常に不変（docs/04:150「承認原本不変」＝docs/11「旧版不変」。改版は常に新draft版を作り、
-- 旧版の原本参照・許諾・hashは決して書換えない。承認操作（T063）が更新できるのはstatus/approved列と共通列だけ）
CREATE TRIGGER document_versions_content_immutable BEFORE UPDATE ON document_versions
WHEN NEW.document_id IS NOT OLD.document_id
  OR NEW.revision_no IS NOT OLD.revision_no
  OR NEW.attachment_id IS NOT OLD.attachment_id
  OR NEW.license_ref IS NOT OLD.license_ref
  OR NEW.content_hash IS NOT OLD.content_hash
BEGIN SELECT RAISE(ABORT, 'document_versions: version content is immutable'); END;

-- 承認済み（approved以降）の版は承認記録ごと不変（0024と同じ流儀。docs/11 approved→superseded/withdrawnの
-- status遷移だけが後続操作で許される）
CREATE TRIGGER document_versions_approved_immutable_upd BEFORE UPDATE ON document_versions
WHEN OLD.status IN ('approved', 'superseded', 'withdrawn') AND (
  NEW.approved_by IS NOT OLD.approved_by OR NEW.approved_at IS NOT OLD.approved_at
)
BEGIN SELECT RAISE(ABORT, 'document_versions: approved version is immutable'); END;

-- 版は削除しない（docs/04 §4「履歴/承認/原本をCASCADEで消さない」。撤回はstatus=withdrawnで表現）
CREATE TRIGGER document_versions_no_delete BEFORE DELETE ON document_versions
BEGIN SELECT RAISE(ABORT, 'document_versions: version is append-only'); END;

-- 文書ACL（docs/04:151「member/role片方、同unit、effect allow/deny、deny優先」。D03/D20未承認の検証設定）。
-- 現在のACLは全置換で管理する（API-99＝T063）。投影は一覧/詳細の両方に前置する（docs/10 §3）。
-- ACL行が無い文書は同unitのPER-01保持者に見える既定（API経由の作成では必須1件以上のため、
-- 既定が効くのは直接INSERTや将来の経路だけ。docs/16 T062に記録）
CREATE TABLE document_acl (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL,
  member_id TEXT,
  role_id TEXT,
  -- 許可の語（T062では読取可否の判定に行の存在とeffectのみを使いpermission値は記録する。
  -- 細分化はT063以降のACL管理で確定する。docs/16 T062に記録）
  permission TEXT NOT NULL CHECK (length(permission) BETWEEN 1 AND 100),
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  CHECK (actor_kind = 'human' OR actor_user_id IS NULL),
  -- member/role片方（docs/04:151）
  CHECK ((member_id IS NOT NULL) + (role_id IS NOT NULL) = 1),
  -- memberは同unitの団員（roleはunitに属さない全unit共通の語）。FKの受け口はattachments等と同じ複合
  FOREIGN KEY (unit_id, member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, document_id) REFERENCES documents (unit_id, id) ON DELETE RESTRICT,
  UNIQUE (unit_id, id)
);
CREATE INDEX idx_document_acl_document ON document_acl (document_id);

-- 抽出chunk（docs/04:152。RAGの根拠の最小単位。T064の抽出job handlerが書込する。T062では作成のみ）。
-- index_statusの語彙はT064で抽出/索引方式（D16）と一緒に確定するため、ここでは長さだけ拘束する
-- （docs/16 T062に記録）。textはdocs/04 §1のBody上限と同じ20,000。
CREATE TABLE document_chunks (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  version_id TEXT NOT NULL,
  chunk_no INTEGER NOT NULL CHECK (chunk_no >= 1),
  page_no INTEGER CHECK (page_no IS NULL OR page_no >= 1),
  section TEXT CHECK (section IS NULL OR length(section) BETWEEN 1 AND 200),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 20000),
  -- 抽出原文への位置保持（docs/06 §5「ページ/節/文字offsetを保持」のJSON。語彙はT064で確定:
  -- {contentHash,extractorVersion,pageNo,start,end}。chunk.text=頁テキスト.slice(start,end)が常に成立する）
  source_offsets TEXT NOT NULL CHECK (json_valid(source_offsets)),
  -- 索引の処理状態（語彙はT064で確定。docs/04:152と同一コミットで整合。docs/16 T064に記録）:
  -- pending=抽出済みで索引化待ち（検索可能を意味しない。T066が承認済み+ACLで別途絞る）/
  -- indexed=T066の索引化が完了 / removed=索引から外れた（T066が設定）
  index_status TEXT NOT NULL CHECK (index_status IN ('pending', 'indexed', 'removed')),
  index_key TEXT CHECK (index_key IS NULL OR length(index_key) BETWEEN 1 AND 500),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- 版/chunk UNIQUE（docs/04:152）
  UNIQUE (unit_id, version_id, chunk_no),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, version_id) REFERENCES document_versions (unit_id, id) ON DELETE RESTRICT
);
-- docs/04 §4の索引契約: document_chunks(version_id, index_status)
CREATE INDEX idx_document_chunks_version_index ON document_chunks (version_id, index_status);
