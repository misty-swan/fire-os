-- 0018_resource_usages: 車両/機材の使用履歴（docs/04:100、T042）。
-- operations（0015で作成。活動/出動で共用）ごとの有効(active)集合を全置換するPUT（API-57）で書き、
-- 来なかった既存行はstatus='cancelled'で残す（docs/05 §1「ResourceUsageListのPUTはoperation版をガードし
-- 全有効集合を更新、抜けた既存行はcancelled＋イベントで保持」。物理削除はしない）。
-- 在庫の自動減算はしない（docs/04:100・docs/14 D15。台帳のequipment.quantityは使用で動かさない）。

-- 使用履歴（docs/04:100「対象ちょうど一つ、quantity>0、時間順序、同unit。active/cancelled、
-- 訂正/取消はresource_usage_eventsへ変更前後を追記、operation版も増分、物理削除しない」）
CREATE TABLE resource_usages (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  -- 出来事root（activities/incidentsがoperation_id UNIQUEで共用。docs/04:85。docs/05 API-57のURL対象）
  operation_id TEXT NOT NULL,
  -- 対象ちょうど一つ（docs/04:100。Target契約のvehicle/equipmentを片側FKへ。両NULL/両あり不可）
  vehicle_id TEXT,
  equipment_id TEXT,
  quantity REAL NOT NULL CHECK (quantity > 0),
  used_from TEXT CHECK (used_from IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', used_from) IS used_from),
  used_to TEXT CHECK (used_to IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', used_to) IS used_to),
  recorded_by_member_id TEXT NOT NULL,
  -- cancelledは終端（docs/04:100「active/cancelled」。行は残り、集計から外れる＝docs/11 §3の使用履歴版）
  status TEXT NOT NULL CHECK (status IN ('active', 'cancelled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- 既知時間の順序（docs/04:100「時間順序」。片方未知は保留。0016/0017の参集・実参加と同じ規則）
  CHECK (used_to IS NULL OR used_from IS NULL OR used_to >= used_from),
  -- 対象ちょうど一つ（docs/04:100。片側FKの排他）
  CHECK ((vehicle_id IS NULL) != (equipment_id IS NULL)),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, operation_id) REFERENCES operations (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, vehicle_id) REFERENCES vehicles (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, equipment_id) REFERENCES equipment (unit_id, id) ON DELETE RESTRICT
);
-- 索引契約（docs/04 §4「全FK子列」。出来事root側はUNIQUE(unit_id,operation_id)…ではなく行集合なので通常索引）
CREATE INDEX idx_resource_usages_operation ON resource_usages (operation_id);
CREATE INDEX idx_resource_usages_vehicle ON resource_usages (vehicle_id);
CREATE INDEX idx_resource_usages_equipment ON resource_usages (equipment_id);

-- 使用履歴の履歴（docs/04:100「usage FK、追記履歴、operation更新と同commit」。incident_eventsと同じ
-- オブジェクトJSONの前後保持。対象・数量・時間・状態の小さな値だけを残す）
CREATE TABLE resource_usage_events (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  usage_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  before_json TEXT NOT NULL CHECK (json_valid(before_json) AND json_type(before_json) = 'object'),
  after_json TEXT NOT NULL CHECK (json_valid(after_json) AND json_type(after_json) = 'object'),
  -- 訂正・取消の理由（docs/05 API-57のreason。API-69/39/40と同じくDBのCHECK 1〜2000に揃える）
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, usage_id) REFERENCES resource_usages (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_resource_usage_events_usage ON resource_usage_events (usage_id, created_at);
