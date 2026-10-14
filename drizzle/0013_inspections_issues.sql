-- 0013_inspections_issues: 点検の系列・原本・明細と異常（T029〜T032、docs/04 §3.3、docs/11）
-- 原本（点検）は追記型。訂正は新原本＋seriesの現在版ポインタの切替（同一mutation）。訂正枝は一つだけ（supersedes_id非NULL UNIQUE）。

CREATE TABLE inspection_series (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  facility_id TEXT,
  vehicle_id TEXT,
  equipment_id TEXT,
  current_facility_inspection_id TEXT,
  current_asset_inspection_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- 対象はちょうど一つ
  CHECK ((facility_id IS NOT NULL) + (vehicle_id IS NOT NULL) + (equipment_id IS NOT NULL) = 1),
  CHECK ((facility_id IS NOT NULL) = (current_facility_inspection_id IS NOT NULL)),
  CHECK ((vehicle_id IS NOT NULL OR equipment_id IS NOT NULL) = (current_asset_inspection_id IS NOT NULL)),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, facility_id) REFERENCES facilities (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, vehicle_id) REFERENCES vehicles (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, equipment_id) REFERENCES equipment (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_inspection_series_facility ON inspection_series (facility_id);
CREATE INDEX idx_inspection_series_vehicle ON inspection_series (vehicle_id);
CREATE INDEX idx_inspection_series_equipment ON inspection_series (equipment_id);

CREATE TABLE facility_inspections (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  series_id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  template_version_id TEXT NOT NULL REFERENCES inspection_template_versions (id) ON DELETE RESTRICT,
  inspector_member_id TEXT NOT NULL,
  inspected_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', inspected_at) IS inspected_at),
  -- docs/11: 保存原本の値は ok/needs_review/unknown。保存後の値変更は訂正版で行う
  result TEXT NOT NULL CHECK (result IN ('ok', 'needs_review', 'unknown')),
  note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 20000),
  -- 点検時の座標版（docs/04。位置確認とは別の記録）
  location_version INTEGER NOT NULL CHECK (location_version >= 1),
  supersedes_id TEXT UNIQUE,
  correction_reason TEXT CHECK (correction_reason IS NULL OR length(correction_reason) BETWEEN 1 AND 2000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  CHECK ((supersedes_id IS NULL) = (correction_reason IS NULL)),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, series_id) REFERENCES inspection_series (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, facility_id) REFERENCES facilities (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, inspector_member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_facility_inspections_facility ON facility_inspections (facility_id, inspected_at, id);
CREATE INDEX idx_facility_inspections_series ON facility_inspections (series_id);

CREATE TABLE asset_inspections (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  series_id TEXT NOT NULL,
  vehicle_id TEXT,
  equipment_id TEXT,
  template_version_id TEXT NOT NULL REFERENCES inspection_template_versions (id) ON DELETE RESTRICT,
  inspector_member_id TEXT NOT NULL,
  inspected_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', inspected_at) IS inspected_at),
  result TEXT NOT NULL CHECK (result IN ('ok', 'needs_review', 'unknown')),
  note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 20000),
  supersedes_id TEXT UNIQUE,
  correction_reason TEXT CHECK (correction_reason IS NULL OR length(correction_reason) BETWEEN 1 AND 2000),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  CHECK ((vehicle_id IS NOT NULL) + (equipment_id IS NOT NULL) = 1),
  CHECK ((supersedes_id IS NULL) = (correction_reason IS NULL)),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, series_id) REFERENCES inspection_series (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, vehicle_id) REFERENCES vehicles (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, equipment_id) REFERENCES equipment (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, inspector_member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_asset_inspections_vehicle ON asset_inspections (vehicle_id, inspected_at, id);
CREATE INDEX idx_asset_inspections_equipment ON asset_inspections (equipment_id, inspected_at, id);

CREATE TABLE inspection_items (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  facility_inspection_id TEXT,
  asset_inspection_id TEXT,
  item_code TEXT NOT NULL CHECK (length(item_code) BETWEEN 1 AND 100),
  result TEXT NOT NULL CHECK (length(result) BETWEEN 1 AND 100),
  value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  -- 点検先はちょうど一つ
  CHECK ((facility_inspection_id IS NOT NULL) + (asset_inspection_id IS NOT NULL) = 1),
  UNIQUE (facility_inspection_id, item_code),
  UNIQUE (asset_inspection_id, item_code),
  FOREIGN KEY (unit_id, facility_inspection_id) REFERENCES facility_inspections (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, asset_inspection_id) REFERENCES asset_inspections (unit_id, id) ON DELETE RESTRICT
);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  facility_id TEXT,
  vehicle_id TEXT,
  equipment_id TEXT,
  source_facility_inspection_id TEXT,
  source_asset_inspection_id TEXT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 20000),
  reported_by TEXT NOT NULL,
  assignee_member_id TEXT,
  -- docs/11 異常: reported→under_review→in_progress→resolved→closed→under_review（再開）
  status TEXT NOT NULL CHECK (status IN ('reported', 'under_review', 'in_progress', 'resolved', 'closed')),
  confirmed_category TEXT CHECK (confirmed_category IS NULL OR length(confirmed_category) BETWEEN 1 AND 100),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- 対象はちょうど一つ。起点点検は高々一つ
  CHECK ((facility_id IS NOT NULL) + (vehicle_id IS NOT NULL) + (equipment_id IS NOT NULL) = 1),
  CHECK (NOT (source_facility_inspection_id IS NOT NULL AND source_asset_inspection_id IS NOT NULL)),
  -- 手動起票は起点を持たない
  CHECK ((source_facility_inspection_id IS NULL AND source_asset_inspection_id IS NULL) OR reported_by IS NOT NULL),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, facility_id) REFERENCES facilities (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, vehicle_id) REFERENCES vehicles (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, equipment_id) REFERENCES equipment (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, source_facility_inspection_id) REFERENCES facility_inspections (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, source_asset_inspection_id) REFERENCES asset_inspections (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_issues_unit_status ON issues (unit_id, status, id);
CREATE INDEX idx_issues_facility ON issues (facility_id);
CREATE INDEX idx_issues_vehicle ON issues (vehicle_id);
CREATE INDEX idx_issues_equipment ON issues (equipment_id);

CREATE TABLE issue_events (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  issue_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  before_json TEXT NOT NULL CHECK (json_valid(before_json) AND json_type(before_json) = 'object'),
  after_json TEXT NOT NULL CHECK (json_valid(after_json) AND json_type(after_json) = 'object'),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 2000),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'human' OR actor_user_id IS NULL),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, issue_id) REFERENCES issues (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_issue_events_issue ON issue_events (issue_id, created_at);
