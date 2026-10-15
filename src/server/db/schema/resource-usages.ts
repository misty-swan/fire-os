import { index, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { rootColumns } from "./core";

// 車両/機材の使用履歴（docs/04:100、drizzle/0018_resource_usages.sql、T042）。制約の正本はSQL。

/**
 * 使用履歴。operation（活動/出動で共用する出来事root）ごとの有効(active)集合を全置換するPUT
 * （API-57、src/server/routes/resource-usages.ts）で書く。来なかった既存行はcancelledで残し
 * （物理削除しない）、集計はactiveだけを数える（docs/11 §3「集計は無効なoperationを除く」の使用履歴版）。
 * 在庫の自動減算はしない（docs/04:100・docs/14 D15）。
 */
export const resourceUsages = sqliteTable(
  "resource_usages",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    operationId: text("operation_id").notNull(),
    /** 対象ちょうど一つ（docs/04:100。Target契約のvehicle/equipmentを片側FKへ） */
    vehicleId: text("vehicle_id"),
    equipmentId: text("equipment_id"),
    quantity: real("quantity").notNull(),
    usedFrom: text("used_from"),
    usedTo: text("used_to"),
    recordedByMemberId: text("recorded_by_member_id").notNull(),
    status: text("status", { enum: ["active", "cancelled"] }).notNull(),
    ...rootColumns,
  },
  (t) => [
    index("idx_resource_usages_operation").on(t.operationId),
    index("idx_resource_usages_vehicle").on(t.vehicleId),
    index("idx_resource_usages_equipment").on(t.equipmentId),
  ],
);

/** 使用履歴の履歴（docs/04:100「追記履歴、operation更新と同commit」。incident_eventsと同じ前後JSON） */
export const resourceUsageEvents = sqliteTable(
  "resource_usage_events",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    usageId: text("usage_id").notNull(),
    action: text("action").notNull(),
    beforeJson: text("before_json").notNull(),
    afterJson: text("after_json").notNull(),
    reason: text("reason"),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_resource_usage_events_usage").on(t.usageId, t.createdAt)],
);
