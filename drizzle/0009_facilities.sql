-- 0009_facilities: 施設と位置確認履歴（docs/04 §3.3、T019で使用）。
-- ※本来T019で作る表だが、T017の添付リンク（親へのlinkとACL配信）の試験に親エンティティが必要なため
--   DDLのみT017で先行作成した（docs/16のT017/T019に記録）。API実装はT019/T020。
-- D19案（検証設定・未承認）: 分団×種別×管理番号の一意。座標は有限値の範囲CHECK。

CREATE TABLE facilities (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN ('hydrant', 'cistern', 'box')),
  management_number TEXT CHECK (management_number IS NULL OR length(management_number) BETWEEN 1 AND 100),
  identifying_name TEXT CHECK (identifying_name IS NULL OR length(identifying_name) BETWEEN 1 AND 100),
  latitude REAL NOT NULL CHECK (latitude >= -90 AND latitude <= 90),
  longitude REAL NOT NULL CHECK (longitude >= -180 AND longitude <= 180),
  location_note TEXT NOT NULL CHECK (length(location_note) BETWEEN 1 AND 1000),
  location_source TEXT NOT NULL CHECK (length(location_source) BETWEEN 1 AND 100),
  location_version INTEGER NOT NULL DEFAULT 1 CHECK (location_version >= 1),
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected')),
  last_verified_at TEXT CHECK (last_verified_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', last_verified_at) IS last_verified_at),
  verified_by_member_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata) AND json_type(metadata) = 'object'),
  archived_at TEXT CHECK (archived_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', archived_at) IS archived_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- 番号か識別名のどちらか必須（docs/04、D19）
  CHECK (management_number IS NOT NULL OR identifying_name IS NOT NULL),
  -- 子（位置履歴・点検・異常・資機材の保管先）の複合FKの受け口
  UNIQUE (unit_id, id),
  -- D19案（検証設定）: 分団×種別×管理番号の一意。番号がNULLの行は対象外
  UNIQUE (unit_id, type, management_number)
);
CREATE INDEX idx_facilities_unit_type_number ON facilities (unit_id, type, management_number);
CREATE INDEX idx_facilities_unit_lat ON facilities (unit_id, latitude);

-- 位置の履歴（追記型）。座標/出典の変更でlocation_versionを増分、同版内の確認操作はevent_noを増分する
CREATE TABLE facility_location_revisions (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  facility_id TEXT NOT NULL,
  location_version INTEGER NOT NULL CHECK (location_version >= 1),
  event_no INTEGER NOT NULL CHECK (event_no >= 1),
  latitude REAL NOT NULL CHECK (latitude >= -90 AND latitude <= 90),
  longitude REAL NOT NULL CHECK (longitude >= -180 AND longitude <= 180),
  location_source TEXT NOT NULL CHECK (length(location_source) BETWEEN 1 AND 100),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('unverified', 'pending', 'verified', 'rejected')),
  verified_by_member_id TEXT,
  verified_at TEXT CHECK (verified_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', verified_at) IS verified_at),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  CHECK ((verified_at IS NULL) = (verified_by_member_id IS NULL)),
  UNIQUE (facility_id, location_version, event_no),
  FOREIGN KEY (unit_id, facility_id) REFERENCES facilities (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_facility_location_revisions_facility ON facility_location_revisions (facility_id, location_version, event_no);
