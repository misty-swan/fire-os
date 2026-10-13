-- 0005_invitations: 招待（docs/04 §3.1 invitations、docs/07 §2）。
-- tokenとメールは生で持たない（SHA-256のhashのみ）。status と consumed_at/cancelled_at は常に対（CHECK）。
-- kind='bootstrap' は初期管理者用の招待（ops/bootstrap-admin.md）。分団ごとに有効/使用済みは1件だけ。

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('invite', 'bootstrap')),
  email_hash TEXT NOT NULL CHECK (length(email_hash) = 64),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  -- pending=未使用 / consumed=使用済み / cancelled=取消。期限切れはstatusでなく expires_at で判定する（時刻で自然に変わるため）
  status TEXT NOT NULL CHECK (status IN ('pending', 'consumed', 'cancelled')),
  expires_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  consumed_at TEXT CHECK (consumed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', consumed_at) IS consumed_at),
  consumed_by_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  cancelled_at TEXT CHECK (cancelled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', cancelled_at) IS cancelled_at),
  cancel_reason TEXT CHECK (cancel_reason IS NULL OR length(cancel_reason) BETWEEN 1 AND 20000),
  -- 招待を受けた人に与える役割。受領者の自己申告では決まらない（{"roleCodes":["member"]}）
  intended_authz TEXT NOT NULL CHECK (json_valid(intended_authz) AND json_type(intended_authz) = 'object'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK ((status = 'consumed') = (consumed_by_user_id IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  FOREIGN KEY (unit_id, member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT,
  UNIQUE (unit_id, id)
);
-- 一人の団員に有効な招待は1件まで（再発行は旧招待を取消して行う）
CREATE UNIQUE INDEX uq_invitations_pending_member ON invitations (member_id) WHERE status = 'pending';
-- 初期管理者の招待は分団ごとに有効/使用済みを1件まで
CREATE UNIQUE INDEX uq_invitations_bootstrap ON invitations (unit_id) WHERE kind = 'bootstrap' AND status IN ('pending', 'consumed');
CREATE INDEX idx_invitations_unit_member ON invitations (unit_id, member_id);
CREATE INDEX idx_invitations_email ON invitations (email_hash, status);
CREATE INDEX idx_invitations_created_by ON invitations (created_by);
