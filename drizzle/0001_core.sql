-- 0001_core: 組織・認可・共通基盤表（T003、docs/04 §1〜3.1/3.5）
-- 規約: 時刻はUTC ISO8601固定ms文字列（D1はGLOBパターン長に上限があるため、strftimeで正規形に戻して一致を見る。存在しない日付はstrftimeがNULLを返す。CHECKはNULLを合格とするため = でなく IS で比べる）、JSONはjson_valid、真偽は0/1、IDはサーバー生成UUID。
-- 同unit制約は親の UNIQUE(unit_id,id) と子の複合FKで担保する。履歴/監査は追記専用（トリガー）。
-- ※ docs/04からの変更点は docs/04 §3.1/3.5 と docs/14(D21) に記録。

-- ===== users（unitに属さない。認証本体との結び付きと認可版） =====
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  auth_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  authz_version INTEGER NOT NULL DEFAULT 1 CHECK (authz_version >= 1),
  disabled_at TEXT CHECK (disabled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', disabled_at) IS disabled_at),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  -- 停止状態と停止時刻は常に対（停止変更とauthz_version増分は同一操作で行う）
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);

-- ===== units（分団。初期は1件） =====
CREATE TABLE units (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  dataset_revision INTEGER NOT NULL DEFAULT 1 CHECK (dataset_revision >= 1),
  event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL)
);

-- ===== roles（固定4役割。D03。unitに属さない参照データ） =====
CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (code IN ('member', 'operator', 'officer', 'admin')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at)
);
INSERT INTO roles (id, code, created_at) VALUES
  ('00000000-0000-4000-8000-000000000101', 'member',   '2026-10-13T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000102', 'operator', '2026-10-13T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000103', 'officer',  '2026-10-13T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000000104', 'admin',    '2026-10-13T00:00:00.000Z');

-- ===== members（名簿） =====
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  -- 初期は1 user = 1 団員。未リンクの団員はNULL（NULLは重複可）
  user_id TEXT UNIQUE REFERENCES users (id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  rank TEXT CHECK (rank IS NULL OR length(rank) BETWEEN 1 AND 200),
  joined_at TEXT CHECK (joined_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', joined_at) IS joined_at),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'retired')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  UNIQUE (unit_id, id)
);
CREATE INDEX idx_members_unit_status ON members (unit_id, status);
CREATE INDEX idx_members_created_by ON members (created_by);

-- ===== member_roles（役割の付与。取り消しはrevoked_atで履歴を残す） =====
CREATE TABLE member_roles (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  role_id TEXT NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  granted_by TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  revoked_at TEXT CHECK (revoked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS revoked_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- 同unit: 団員は同じunitのものだけ参照できる
  FOREIGN KEY (unit_id, member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT
);
-- 有効(取消されていない)な同一団員×同一役割は1件まで
CREATE UNIQUE INDEX uq_member_roles_active ON member_roles (member_id, role_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_member_roles_unit_member ON member_roles (unit_id, member_id);
CREATE INDEX idx_member_roles_role ON member_roles (role_id);
CREATE INDEX idx_member_roles_granted_by ON member_roles (granted_by);

-- ===== scope_assignments（対象単位の許可。D03: 固定4役割＋明示scope、拒否優先） =====
CREATE TABLE scope_assignments (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 100),
  entity_id TEXT NOT NULL,
  permissions TEXT NOT NULL CHECK (json_valid(permissions) AND json_type(permissions) = 'array'),
  expires_at TEXT CHECK (expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  revoked_at TEXT CHECK (revoked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', revoked_at) IS revoked_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  FOREIGN KEY (unit_id, member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT
);
-- 有効な同一団員×同一対象のscopeは1件まで（対象の存在/所属はサービス層とmutation内guardで検証）
CREATE UNIQUE INDEX uq_scope_assignments_active ON scope_assignments (member_id, entity_type, entity_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_scope_assignments_unit_member ON scope_assignments (unit_id, member_id);

-- ===== idempotency_records（二重送信防止。業務更新と同一batchで予約→確定） =====
CREATE TABLE idempotency_records (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  operation_code TEXT NOT NULL CHECK (length(operation_code) BETWEEN 1 AND 100),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  canonical_request_hash TEXT NOT NULL CHECK (length(canonical_request_hash) = 64),
  -- reserved: batch先頭で予約した直後 / completed: 応答確定 / expired: 7日経過後。本文は消しても鍵とhashは残し、暗黙の再実行を拒否する
  state TEXT NOT NULL CHECK (state IN ('reserved', 'completed', 'expired')),
  response_status INTEGER CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 599),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  expires_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  CHECK (state <> 'completed' OR (response_status IS NOT NULL AND response_json IS NOT NULL)),
  CHECK (state <> 'reserved' OR (response_status IS NULL AND response_json IS NULL)),
  UNIQUE (actor_user_id, operation_code, idempotency_key)
);
CREATE INDEX idx_idempotency_unit ON idempotency_records (unit_id);
CREATE INDEX idx_idempotency_expires ON idempotency_records (state, expires_at);

-- ===== mutation_assertions（比較更新が0行だったときに batch全体を失敗させる内部表） =====
-- 1つのbatchで複数の検査をするため (attempt_token, seq) を主キーにする（docs/02 §4の補足）。
CREATE TABLE mutation_assertions (
  attempt_token TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  ok INTEGER NOT NULL CHECK (ok = 1),
  PRIMARY KEY (attempt_token, seq)
);

-- ===== audit_logs（追記専用。個人情報本文は複製しない） =====
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  entity_type TEXT NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 100),
  entity_id TEXT NOT NULL,
  -- docs/04では operation_id。業務の「出来事(operations)」と衝突するため mutation_id に改称（D21）
  mutation_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at),
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL)
);
CREATE INDEX idx_audit_unit_occurred ON audit_logs (unit_id, occurred_at, id);
CREATE INDEX idx_audit_actor ON audit_logs (actor_user_id);
CREATE INDEX idx_audit_mutation ON audit_logs (unit_id, mutation_id);
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

-- ===== domain_events（outbox兼用。1 mutation 1 event、unit内で単調採番） =====
CREATE TABLE domain_events (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  mutation_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 100),
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL CHECK (entity_version >= 1),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  payload_minimal TEXT NOT NULL CHECK (json_valid(payload_minimal)),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  UNIQUE (unit_id, sequence),
  UNIQUE (unit_id, mutation_id)
);
CREATE TRIGGER domain_events_no_update BEFORE UPDATE ON domain_events BEGIN SELECT RAISE(ABORT, 'domain_events is append-only'); END;
CREATE TRIGGER domain_events_no_delete BEFORE DELETE ON domain_events BEGIN SELECT RAISE(ABORT, 'domain_events is append-only'); END;
