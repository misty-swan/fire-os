-- 0017_incidents: 出動（模擬・訓練・実出動記録）ドメイン（docs/04:94-97、T040）。
-- operationsは0015で作成済みの共通出来事rootをincidentsでも共用する（docs/04:85。T035のコメントどおり）。
-- 種別（kind）と状態（status）は別契約: kindはdocs/04:94の列挙、statusはdocs/11 出動イベントrecording行の列挙。
-- 正式な指令系とは接続せず、出動命令も自動発行しない（docs/11「正式指令を発行しない」、docs/14 D08）。
-- incident_participants/incident_participant_eventsはT041（API-23）が使う。T041のFilesにmigrationが無いため
-- このタスクで一緒に作る（参集は出動に従属する子表で、docs/04 §3.2の出動ブロックとして一括が自然）。

-- 出動root（docs/04:94「operation_id UNIQUE、activity_id UNIQUE/FK、kind simulation/training/actual_record、
-- リンク時operation一致」。operationの付替え（既存活動との統合）はAPI-71＝T043。作成時のactivityIdは
-- 同unitの既存活動の存在検査のみで、operation一致の検査はT043へ委ねる）
CREATE TABLE incidents (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL,
  -- 関連付けた既存活動（任意。UNIQUEなので1活動にリンクできる出動は1件。NULLは複数行可）
  activity_id TEXT,
  -- 種別は模擬/訓練/実出動記録の区分（docs/04:94の列挙）。状態（status）とは独立に訂正できる
  kind TEXT NOT NULL CHECK (kind IN ('simulation', 'training', 'actual_record')),
  occurred_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at) IS occurred_at),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 20000),
  -- docs/11 出動イベントrecording行: recording→active/closed/voided、active→closed、
  -- closed→recording（訂正）、voidedは終端（閲覧のみ）
  status TEXT NOT NULL CHECK (status IN ('recording', 'active', 'closed', 'voided')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  UNIQUE (unit_id, id),
  UNIQUE (unit_id, operation_id),
  UNIQUE (unit_id, activity_id),
  FOREIGN KEY (unit_id, operation_id) REFERENCES operations (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, activity_id) REFERENCES activities (unit_id, id) ON DELETE RESTRICT
);
-- 索引契約（docs/04 §4「全FK子列」。operation_id/activity_id側はUNIQUEの前置でカバー）
CREATE INDEX idx_incidents_activity ON incidents (activity_id);

-- 出動の履歴（docs/04:95「incident FK、種別訂正/操作元を保持」。追記専用。issue_eventsと同じ
-- オブジェクトJSONの前後保持。本文（summary）は複製せず状態・種別など小さな値だけ）
CREATE TABLE incident_events (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  incident_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  before_json TEXT NOT NULL CHECK (json_valid(before_json) AND json_type(before_json) = 'object'),
  after_json TEXT NOT NULL CHECK (json_valid(after_json) AND json_type(after_json) = 'object'),
  -- 訂正・無効化の理由（docs/11「訂正/無効化理由」。API-69のreasonはこのCHECKに揃える）
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, incident_id) REFERENCES incidents (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_incident_events_incident ON incident_events (incident_id, created_at);

-- 参集（docs/04:96「組合せUNIQUE、既知時刻の順序、記録版あり」。docs/11 参集/帰還unconfirmed行。
-- 書込APIはT041（API-23）。個人の時刻は全体の発生日時とは別列で、不明はNULLのまま残す（捏造しない））
CREATE TABLE incident_participants (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  incident_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  attendance_status TEXT NOT NULL CHECK (attendance_status IN ('unconfirmed', 'unavailable', 'mobilizing', 'arrived', 'returned')),
  mobilized_at TEXT CHECK (mobilized_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', mobilized_at) IS mobilized_at),
  arrived_at TEXT CHECK (arrived_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', arrived_at) IS arrived_at),
  returned_at TEXT CHECK (returned_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', returned_at) IS returned_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- 既知時刻の順序（docs/04「既知時刻の順序」。片方未知は保留。0016と同じ規則）
  CHECK (arrived_at IS NULL OR mobilized_at IS NULL OR arrived_at >= mobilized_at),
  CHECK (returned_at IS NULL OR mobilized_at IS NULL OR returned_at >= mobilized_at),
  CHECK (returned_at IS NULL OR arrived_at IS NULL OR returned_at >= arrived_at),
  UNIQUE (incident_id, member_id),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, incident_id) REFERENCES incidents (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT
);
-- 索引契約（docs/04 §4「参加…(member_id,activity_id)」と同じくmember側から引けるように）
CREATE INDEX idx_incident_participants_member ON incident_participants (member_id, incident_id);

-- 参集の履歴（docs/04:97「participant FK、代理入力者/訂正保持」。代理入力の本人/代理はactor列に記録）
CREATE TABLE incident_participant_events (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  participant_id TEXT NOT NULL,
  before_json TEXT NOT NULL CHECK (json_valid(before_json) AND json_type(before_json) = 'object'),
  after_json TEXT NOT NULL CHECK (json_valid(after_json) AND json_type(after_json) = 'object'),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, participant_id) REFERENCES incident_participants (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_incident_participant_events_participant ON incident_participant_events (participant_id, created_at);
