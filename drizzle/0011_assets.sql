-- 0011_assets: 車両と資機材の台帳（T025、docs/04 §3.2、D15）
-- 車両は保管先が施設のみ。資機材は施設/車両のどちらか一方（外部保管は双方NULL+備考）。
-- 使用による在庫の自動減算はしない（docs/04 §3.2、D15）。物理削除はしない（参照履歴を守る）。

CREATE TABLE vehicles (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  asset_code TEXT NOT NULL CHECK (length(asset_code) BETWEEN 1 AND 100),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 100),
  storage_facility_id TEXT,
  -- 論理廃止（docs/03 SCR-14: 物理削除で履歴を消さない）
  archived_at TEXT CHECK (archived_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', archived_at) IS archived_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  UNIQUE (unit_id, asset_code),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, storage_facility_id) REFERENCES facilities (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_vehicles_unit ON vehicles (unit_id, asset_code);

CREATE TABLE equipment (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  asset_code TEXT NOT NULL CHECK (length(asset_code) BETWEEN 1 AND 100),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- 数量機材（D15: 個体と数量行を区別。負は不可）
  quantity REAL NOT NULL CHECK (quantity >= 0),
  quantity_unit TEXT NOT NULL CHECK (length(quantity_unit) BETWEEN 1 AND 50),
  status TEXT NOT NULL CHECK (length(status) BETWEEN 1 AND 100),
  storage_facility_id TEXT,
  storage_vehicle_id TEXT,
  storage_note TEXT CHECK (storage_note IS NULL OR length(storage_note) BETWEEN 1 AND 1000),
  archived_at TEXT CHECK (archived_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', archived_at) IS archived_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- 保管先は施設/車両のどちらか一方。外部保管は双方NULL+備考必須
  CHECK (NOT (storage_facility_id IS NOT NULL AND storage_vehicle_id IS NOT NULL)),
  CHECK (storage_facility_id IS NOT NULL OR storage_vehicle_id IS NOT NULL OR storage_note IS NOT NULL),
  UNIQUE (unit_id, asset_code),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, storage_facility_id) REFERENCES facilities (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, storage_vehicle_id) REFERENCES vehicles (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_equipment_unit ON equipment (unit_id, asset_code);
