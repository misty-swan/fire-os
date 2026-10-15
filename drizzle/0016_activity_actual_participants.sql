-- 0016_activity_actual_participants: 実参加（docs/04:93、T037）。
-- 0015で作ったactivity_results/activity_result_revisionsの実参加子表。
-- 出欠(activity_attendance)と実参加は別物で、回答を実参加へコピーしない（docs/11 実参加行）。
-- revisionは不変（訂正は新revision）のため参加行も追記専用。個人時間はD05承認時のみ必須化（今は任意）。
CREATE TABLE activity_actual_participants (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  result_revision_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  -- docs/11 実参加: unconfirmed→participated/absent、訂正はparticipated↔absent/unconfirmed（遷移はrevisionの作り直しで表現）
  actual_status TEXT NOT NULL CHECK (actual_status IN ('unconfirmed', 'participated', 'absent')),
  -- 個人時間は全体時間（activity_result_revisions.actual_*_at）と別列。不明はNULLで保留（捏造しない）
  individual_starts_at TEXT CHECK (individual_starts_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', individual_starts_at) IS individual_starts_at),
  individual_ends_at TEXT CHECK (individual_ends_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', individual_ends_at) IS individual_ends_at),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- 既知の個人時間の順序（docs/04「既知時刻の順序」と同じ規則。片方未知は保留）
  CHECK (individual_ends_at IS NULL OR individual_starts_at IS NULL OR individual_ends_at >= individual_starts_at),
  -- 組合せUNIQUE（docs/04:93「組合せUNIQUE、版/member FK」）
  UNIQUE (result_revision_id, member_id),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, result_revision_id) REFERENCES activity_result_revisions (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT
);
-- 索引契約（docs/04 §4「全FK子列」。result_revision_id側はUNIQUEの前置でカバー）
CREATE INDEX idx_activity_actual_participants_member ON activity_actual_participants (member_id, result_revision_id);
