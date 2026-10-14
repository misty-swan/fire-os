-- 0008_attachments: 添付の予約・アップロード試行・本体・リンク・履歴（T015/T017、docs/04 §3.3、docs/07 §3）
-- 予約(attachment_drafts)→intent(attachments)→試行(upload_attempts)→検査(ready)→リンク(attachment_links)の順。
-- R2の鍵は不変。staging_key/ready_keyは鍵自体がURLになるため応答に出さない（SECRET/内部値の扱い、docs/10 §3）。

-- 親作成前の予約（15分案）。prepared→consumed は一回だけ。期限後はupload/確定不可
CREATE TABLE attachment_drafts (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  intended_entity_type TEXT NOT NULL CHECK (length(intended_entity_type) BETWEEN 1 AND 100),
  parent_type TEXT CHECK (parent_type IS NULL OR length(parent_type) BETWEEN 1 AND 100),
  parent_id TEXT,
  owner_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'consumed')),
  expires_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  consumed_entity_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  CHECK ((parent_type IS NULL) = (parent_id IS NULL)),
  CHECK (status = 'consumed' OR consumed_entity_id IS NULL)
);
CREATE INDEX idx_attachment_drafts_owner ON attachment_drafts (unit_id, owner_user_id, status);

-- 添付の本体（intentで1行）。statusはdocs/11の添付遷移。readyのときだけsha256とready_keyを持つ
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  owner_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- 認可(PER-04)の対象に使う申請者。団員が消えても履歴は残すためRESTRICT
  owner_member_id TEXT NOT NULL,
  intent_target_type TEXT NOT NULL CHECK (length(intent_target_type) BETWEEN 1 AND 100),
  intent_target_id TEXT NOT NULL,
  draft_id TEXT,
  selected_upload_attempt_id TEXT,
  staging_key TEXT CHECK (staging_key IS NULL OR length(staging_key) BETWEEN 1 AND 500),
  ready_key TEXT CHECK (ready_key IS NULL OR length(ready_key) BETWEEN 1 AND 500),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/csv')),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending_upload', 'uploaded', 'checking', 'ready', 'rejected', 'expired', 'deleting', 'deleted')),
  expires_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  -- 分類（docs/10 §3のPERSONAL/SENSITIVE相当。基本BASIC、点検・異常はSENSITIVE）
  classification TEXT NOT NULL CHECK (classification IN ('basic', 'personal', 'sensitive')),
  -- 転送検証用のtokenはhashでだけ持つ（生tokenをDBに保存しない）
  upload_token_hash TEXT NOT NULL CHECK (length(upload_token_hash) = 64),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  CHECK (status <> 'ready' OR (sha256 IS NOT NULL AND ready_key IS NOT NULL)),
  -- 子(upload_attempts/attachment_links/attachment_events)の複合FKの受け口
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, owner_member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_attachments_unit_status ON attachments (unit_id, status);
CREATE INDEX idx_attachments_owner ON attachments (unit_id, owner_user_id);
-- ready_keyは内容を固定する鍵。重複は許さない（同じ内容の再検査は既存を見つけて再利用する）
CREATE UNIQUE INDEX uq_attachments_ready_key ON attachments (ready_key) WHERE ready_key IS NOT NULL;

-- 転送の試行。試行ごとに別の不変staging key。選択された試行だけが検査に進む
CREATE TABLE upload_attempts (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  attachment_id TEXT NOT NULL,
  staging_key TEXT NOT NULL UNIQUE CHECK (length(staging_key) BETWEEN 1 AND 500),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  -- uploaded=completion待ち / selected=選択済(検査対象) / superseded=他が選ばれた / rejected=検査不合格
  status TEXT NOT NULL CHECK (status IN ('uploaded', 'selected', 'superseded', 'rejected')),
  expires_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  FOREIGN KEY (unit_id, attachment_id) REFERENCES attachments (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_upload_attempts_attachment ON upload_attempts (attachment_id, status);

-- 業務へのリンク。有効な(attachment, entity)の組合せは一つ。unlinkは行を残して理由を書く
CREATE TABLE attachment_links (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  attachment_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 100),
  entity_id TEXT NOT NULL,
  linked_by TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  unlinked_at TEXT CHECK (unlinked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', unlinked_at) IS unlinked_at),
  unlink_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  CHECK (unlinked_at IS NULL OR unlink_reason IS NOT NULL),
  FOREIGN KEY (unit_id, attachment_id) REFERENCES attachments (unit_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX uq_attachment_links_active ON attachment_links (attachment_id, entity_type, entity_id) WHERE unlinked_at IS NULL;
CREATE INDEX idx_attachment_links_entity ON attachment_links (unit_id, entity_type, entity_id);

-- 検査/リンク/削除の履歴（追記型。detailsはID・コード形式のみ）
CREATE TABLE attachment_events (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  attachment_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  details TEXT NOT NULL CHECK (json_valid(details)),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  FOREIGN KEY (unit_id, attachment_id) REFERENCES attachments (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_attachment_events_attachment ON attachment_events (attachment_id, created_at);
