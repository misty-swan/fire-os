-- 0015_activities: 活動（予定）ドメイン（docs/04 §3.2 活動ブロック、T035）。
-- operationsは活動(activities)と出動(incidents、T040)で共用する共通の出来事root（docs/04:85）。
-- 中止で既存出欠を削除せず、operationをcountable=0にする（docs/11 §3「集計は無効なoperationを除く」）。
-- activity_actual_participants（実参加、docs/04:93）とincidents（docs/04:94）はT037/T040で追加する。

-- 共通の出来事root。集計の正本ID（docs/04「共通出来事。無効時countable=0、集計正本ID」）
CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  -- 出来事の種別コード。活動から作ったrootは'activity'、出動は'incident'（T040）。列挙はdocs/04に無いためコード形式の長さだけ拘束する
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 100),
  -- 子root（activities/incidents）の状態を写す。状態の正はdocs/11の子側の列挙
  status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 100),
  countable INTEGER NOT NULL CHECK (countable IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  UNIQUE (unit_id, id)
);

-- 予定（docs/04:86「operation_id UNIQUE/FK、日時順序、担当同unit」）
CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 200),
  planned_starts_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', planned_starts_at) IS planned_starts_at),
  planned_ends_at TEXT CHECK (planned_ends_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', planned_ends_at) IS planned_ends_at),
  location_text TEXT NOT NULL CHECK (length(location_text) BETWEEN 1 AND 200),
  owner_member_id TEXT NOT NULL,
  -- docs/11 開催: draft→scheduled/cancelled、scheduled→in_progress/cancelled、in_progress→completed、completed→in_progress。cancelledは終端
  status TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  response_due_at TEXT CHECK (response_due_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', response_due_at) IS response_due_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- 日時順序（docs/04「日時順序」。終了は開始以降）
  CHECK (planned_ends_at IS NULL OR planned_ends_at >= planned_starts_at),
  UNIQUE (unit_id, id),
  UNIQUE (unit_id, operation_id),
  FOREIGN KEY (unit_id, operation_id) REFERENCES operations (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, owner_member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT
);
-- 索引契約（docs/04 §4）: activities(unit_id,planned_starts_at,id)と全FK子列
CREATE INDEX idx_activities_unit_planned ON activities (unit_id, planned_starts_at, id);
CREATE INDEX idx_activities_owner ON activities (owner_member_id);

-- 対象者のsnapshot（docs/04:87「未回答母数は現在の名簿全件ではなく対象snapshot」）。名簿変更で母数を変えない
CREATE TABLE activity_audience (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  activity_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  UNIQUE (activity_id, member_id),
  FOREIGN KEY (unit_id, activity_id) REFERENCES activities (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_activity_audience_member ON activity_audience (member_id, activity_id);

-- 開催状態の履歴（docs/04:88「activity FK、追記、取消も保持」）。
-- 初行（作成）はprevious=next=初期状態(draft)。公開済の内容変更は同じ状態どうしの行に理由を残す
CREATE TABLE activity_events (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  activity_id TEXT NOT NULL,
  previous_status TEXT NOT NULL CHECK (previous_status IN ('draft', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  next_status TEXT NOT NULL CHECK (next_status IN ('draft', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, activity_id) REFERENCES activities (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_activity_events_activity ON activity_events (activity_id, created_at);

-- 出欠（docs/04:89「組合せUNIQUE、対象者FK/同unit、回答版あり。actual_statusは実参加表へ分離」）。
-- 回答の競合ガード用にversionを持つ（docs/05 API-08「version(未作成0)」）。API-08/41の実装はT036
CREATE TABLE activity_attendance (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  activity_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  -- docs/11 出欠: unanswered/attending/absent/undecided間の変更（受付中のみ）。未回答は行なしでも表現し未定と区別
  response TEXT NOT NULL CHECK (response IN ('unanswered', 'attending', 'absent', 'undecided')),
  responded_at TEXT CHECK (responded_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', responded_at) IS responded_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  UNIQUE (activity_id, member_id),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, activity_id) REFERENCES activities (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT
);
-- 索引契約（docs/04 §4「参加…(member_id,activity_id)」）
CREATE INDEX idx_activity_attendance_member ON activity_attendance (member_id, activity_id);

-- 出欠の履歴（docs/04:90「attendance FK、本人/代理操作者を記録」。API-08/41はT036）
CREATE TABLE attendance_events (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  attendance_id TEXT NOT NULL,
  response TEXT NOT NULL CHECK (response IN ('unanswered', 'attending', 'absent', 'undecided')),
  -- 代理回答のときの対象団員（本人回答はNULL）。D05の承認済scopeはサービス層で検査
  proxy_for_member_id TEXT,
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, attendance_id) REFERENCES activity_attendance (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_attendance_events_attendance ON attendance_events (attendance_id, created_at);

-- 実績root（docs/04:91「activity_id UNIQUE/FK。revision pointerは同親の版のみ」）。API-09/42/43はT037
CREATE TABLE activity_results (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  activity_id TEXT NOT NULL,
  -- 現在の訂正版へのポインタ。同親(result)の版のみを指すことはサービス層と同一mutationで検査（inspection_seriesと同じ方式）
  current_revision_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  UNIQUE (unit_id, id),
  UNIQUE (unit_id, activity_id),
  FOREIGN KEY (unit_id, activity_id) REFERENCES activities (unit_id, id) ON DELETE RESTRICT
);

-- 実績の版（docs/04:92「result/revision UNIQUE、両時刻存在時ends>=starts、未知はNULLで保留、訂正は理由必須」。API-42はT037）
CREATE TABLE activity_result_revisions (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  result_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  actual_starts_at TEXT CHECK (actual_starts_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', actual_starts_at) IS actual_starts_at),
  actual_ends_at TEXT CHECK (actual_ends_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', actual_ends_at) IS actual_ends_at),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
  -- 訂正の元版。訂正枝は一つだけ（inspectionのsupersedes_idと同じ二重防御）
  supersedes_id TEXT UNIQUE,
  correction_reason TEXT CHECK (correction_reason IS NULL OR length(correction_reason) BETWEEN 1 AND 2000),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  -- 両時刻が存在するときは終了が開始以降（未知の時刻はNULLで保留）
  CHECK (actual_ends_at IS NULL OR actual_starts_at IS NULL OR actual_ends_at >= actual_starts_at),
  -- 訂正（元版の指し替え）には理由が要る
  CHECK ((supersedes_id IS NULL) = (correction_reason IS NULL)),
  UNIQUE (result_id, revision_no),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, result_id) REFERENCES activity_results (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_activity_result_revisions_result ON activity_result_revisions (result_id, revision_no);
