-- 0020_inspection_schedules: 点検期限（docs/04:119、T048）。
-- ブリーフ表記の0018は0018=resource_usages／0019=announcementsで使用済みのため、実在最大0019の次を
-- 採番した（docs/14 D23の採番規則。docs/16 T048に記録）。
-- 期限は業務日（JST暦日 YYYY-MM-DD。docs/04 §1「日付期限は業務日TEXTと明示し瞬間値と混同しない」、docs/14 D06）。
-- 対象はfacility/vehicle/equipmentのちょうど一つで、対象ごとに1行（部分一意索引。0014のinspection_seriesと同じ方式）。
-- 超過の検出（src/server/jobs/handlers/inspection-due.ts。Cron毎分でhandleScheduledから呼ぶ）は
-- SELECT＋重複排除INSERTで安価・冪等とし、結果を inspection_due_detections（追記型）へ記録する。
-- 通知はT050がこの表を源にしてdraftを作るため、T048では通知を作らない（docs/16 T048の裁定）。

-- 点検期限（docs/04:119「対象一つ、周期正、期限はAsia/Tokyo日付、D06の期限規則」）
CREATE TABLE inspection_schedules (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  -- 対象ちょうど一つ（docs/04:119。3種の片側のみ。facilityはAPI-56の対象外だが表はdocs/04どおり持つ）
  facility_id TEXT,
  vehicle_id TEXT,
  equipment_id TEXT,
  -- 業務日（YYYY-MM-DD。瞬間値と混同しない。docs/04 §1・D06）
  next_due_date TEXT NOT NULL CHECK (strftime('%Y-%m-%d', next_due_date) IS next_due_date),
  -- 周期（日数。正。未設定はNULL。docs/04:119「周期正」）
  interval_days INTEGER CHECK (interval_days IS NULL OR interval_days >= 1),
  -- 業務日のタイムゾーンはD06でAsia/Tokyoに固定（docs/04:119「期限はAsia/Tokyo日付」。他はAPI入力で400）
  timezone TEXT NOT NULL CHECK (timezone = 'Asia/Tokyo'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- 対象はfacility/vehicle/equipmentのちょうど一つ
  CHECK ((CASE WHEN facility_id IS NOT NULL THEN 1 ELSE 0 END
        + CASE WHEN vehicle_id IS NOT NULL THEN 1 ELSE 0 END
        + CASE WHEN equipment_id IS NOT NULL THEN 1 ELSE 0 END) = 1),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, facility_id) REFERENCES facilities (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, vehicle_id) REFERENCES vehicles (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, equipment_id) REFERENCES equipment (unit_id, id) ON DELETE RESTRICT
);
-- 対象一つ（docs/04:119）を0014と同じ部分一意索引で担保（並行の初回作成で同対象に2行を作らない）
CREATE UNIQUE INDEX uq_schedule_facility ON inspection_schedules (facility_id) WHERE facility_id IS NOT NULL;
CREATE UNIQUE INDEX uq_schedule_vehicle ON inspection_schedules (vehicle_id) WHERE vehicle_id IS NOT NULL;
CREATE UNIQUE INDEX uq_schedule_equipment ON inspection_schedules (equipment_id) WHERE equipment_id IS NOT NULL;
-- 検出の走査（next_due_date < 今日JST）と対象側参照（docs/04 §4「全FK子列」）
CREATE INDEX idx_schedules_due ON inspection_schedules (next_due_date);
CREATE INDEX idx_schedules_facility ON inspection_schedules (facility_id);
CREATE INDEX idx_schedules_vehicle ON inspection_schedules (vehicle_id);
CREATE INDEX idx_schedules_equipment ON inspection_schedules (equipment_id);

-- 期限超過の検出ログ（T048。追記型。T050が通知draftの源にする）。
-- 重複検出防止の鍵は「対象×予定版×期限日」（docs/16 T048「重複キーを対象/予定版/期限に固定」）。
-- 周期変更などで予定が変われば（版が進めば）新しい鍵として再度検出でき、旧版の行は残る。
CREATE TABLE inspection_due_detections (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  -- 対象（多形参照。audit_logs.entity_idと同じくFKを置かない。実在は検出のSELECTで確認する）
  target_type TEXT NOT NULL CHECK (target_type IN ('facility', 'vehicle', 'equipment')),
  target_id TEXT NOT NULL,
  -- 検出した時点のschedule（追記の参照先。scheduleは削除しない運用のためFKで整合を保つ）
  schedule_id TEXT NOT NULL,
  schedule_version INTEGER NOT NULL CHECK (schedule_version >= 1),
  due_date TEXT NOT NULL CHECK (strftime('%Y-%m-%d', due_date) IS due_date),
  detected_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', detected_at) IS detected_at),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  -- 検出はCron（system）だけが書く
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  UNIQUE (unit_id, target_type, target_id, schedule_version, due_date),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, schedule_id) REFERENCES inspection_schedules (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_due_detections_target ON inspection_due_detections (target_type, target_id);

-- 追記専用の保護（0003と同じ方式。INSERT OR REPLACEによる書換えを拒否する。
-- 検出の重複排除は自然キーのUNIQUE＋ON CONFLICT DO NOTHINGで行い、idの衝突は起きないため両立する）
CREATE TRIGGER inspection_due_detections_no_replace BEFORE INSERT ON inspection_due_detections
WHEN EXISTS (SELECT 1 FROM inspection_due_detections WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'inspection_due_detections is append-only'); END;
