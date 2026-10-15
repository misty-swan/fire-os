import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { rootColumns } from "./core";

// 点検期限（docs/04:119、drizzle/0020_inspection_schedules.sql、T048）。制約の正本はSQL。

/**
 * 点検期限のschedule。対象（facility/vehicle/equipment）ごとに1行（一意はSQLの部分一意索引）。
 * 期限は業務日（YYYY-MM-DD。docs/04 §1。瞬間値と混同しない）。書き込みはAPI-56
 * （src/server/routes/inspection-schedules.ts。PUTで全置換・版管理）。
 */
export const inspectionSchedules = sqliteTable(
  "inspection_schedules",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    /** 対象ちょうど一つ（docs/04:119。facilityはAPI-56の対象外だが表はdocs/04どおり持つ） */
    facilityId: text("facility_id"),
    vehicleId: text("vehicle_id"),
    equipmentId: text("equipment_id"),
    /** 業務日（YYYY-MM-DD。docs/14 D06） */
    nextDueDate: text("next_due_date").notNull(),
    /** 周期（日数。未設定はNULL） */
    intervalDays: integer("interval_days"),
    /** 業務日のタイムゾーン（D06でAsia/Tokyo固定） */
    timezone: text("timezone").notNull(),
    ...rootColumns,
  },
  (t) => [
    index("idx_schedules_due").on(t.nextDueDate),
    index("idx_schedules_facility").on(t.facilityId),
    index("idx_schedules_vehicle").on(t.vehicleId),
    index("idx_schedules_equipment").on(t.equipmentId),
  ],
);

/**
 * 期限超過の検出ログ（追記型）。UNIQUE(unit,対象,予定版,期限日)で重複検出を防ぎ、
 * T050が通知draftの源にする（T048では通知を作らない）。書き込みは検出job
 * （src/server/jobs/handlers/inspection-due.ts の detectDueInspections。Cronから呼ぶ）だけ。
 */
export const inspectionDueDetections = sqliteTable(
  "inspection_due_detections",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    /** 検出対象（多形参照。audit_logs.entity_idと同じくFKを置かない） */
    targetType: text("target_type", { enum: ["facility", "vehicle", "equipment"] }).notNull(),
    targetId: text("target_id").notNull(),
    /** 検出した時点のschedule（scheduleは削除しない運用のためFKで整合を保つ） */
    scheduleId: text("schedule_id").notNull(),
    scheduleVersion: integer("schedule_version").notNull(),
    dueDate: text("due_date").notNull(),
    detectedAt: text("detected_at").notNull(),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_due_detections_target").on(t.targetType, t.targetId)],
);
