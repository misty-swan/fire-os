import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { rootColumns } from "./core";

// 点検・異常（docs/04 §3.3、drizzle/0013_inspections_issues.sql）。制約の正本はSQL。
// 原本は追記型（UPDATEで書換えない）。訂正は新原本＋seriesの現在版ポインタ切替。

export const inspectionSeries = sqliteTable("inspection_series", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  facilityId: text("facility_id"),
  vehicleId: text("vehicle_id"),
  equipmentId: text("equipment_id"),
  currentFacilityInspectionId: text("current_facility_inspection_id"),
  currentAssetInspectionId: text("current_asset_inspection_id"),
  ...rootColumns,
});

export const facilityInspections = sqliteTable(
  "facility_inspections",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    seriesId: text("series_id").notNull(),
    facilityId: text("facility_id").notNull(),
    templateVersionId: text("template_version_id").notNull(),
    inspectorMemberId: text("inspector_member_id").notNull(),
    inspectedAt: text("inspected_at").notNull(),
    result: text("result", { enum: ["ok", "needs_review", "unknown"] }).notNull(),
    note: text("note").notNull(),
    locationVersion: integer("location_version").notNull(),
    supersedesId: text("supersedes_id"),
    correctionReason: text("correction_reason"),
    ...rootColumns,
  },
  (t) => [index("idx_facility_inspections_facility").on(t.facilityId, t.inspectedAt, t.id)],
);

export const assetInspections = sqliteTable(
  "asset_inspections",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    seriesId: text("series_id").notNull(),
    vehicleId: text("vehicle_id"),
    equipmentId: text("equipment_id"),
    templateVersionId: text("template_version_id").notNull(),
    inspectorMemberId: text("inspector_member_id").notNull(),
    inspectedAt: text("inspected_at").notNull(),
    result: text("result", { enum: ["ok", "needs_review", "unknown"] }).notNull(),
    note: text("note").notNull(),
    supersedesId: text("supersedes_id"),
    correctionReason: text("correction_reason"),
    ...rootColumns,
  },
  (t) => [index("idx_asset_inspections_vehicle").on(t.vehicleId, t.inspectedAt, t.id)],
);

export const inspectionItems = sqliteTable("inspection_items", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  facilityInspectionId: text("facility_inspection_id"),
  assetInspectionId: text("asset_inspection_id"),
  itemCode: text("item_code").notNull(),
  result: text("result").notNull(),
  valueJson: text("value_json"),
  note: text("note"),
  createdAt: text("created_at").notNull(),
});

export const issues = sqliteTable(
  "issues",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    facilityId: text("facility_id"),
    vehicleId: text("vehicle_id"),
    equipmentId: text("equipment_id"),
    sourceFacilityInspectionId: text("source_facility_inspection_id"),
    sourceAssetInspectionId: text("source_asset_inspection_id"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    reportedBy: text("reported_by").notNull(),
    assigneeMemberId: text("assignee_member_id"),
    status: text("status", { enum: ["reported", "under_review", "in_progress", "resolved", "closed"] }).notNull(),
    confirmedCategory: text("confirmed_category"),
    ...rootColumns,
  },
  (t) => [index("idx_issues_unit_status").on(t.unitId, t.status, t.id)],
);

export const issueEvents = sqliteTable(
  "issue_events",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    issueId: text("issue_id").notNull(),
    action: text("action").notNull(),
    beforeJson: text("before_json").notNull(),
    afterJson: text("after_json").notNull(),
    note: text("note"),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_issue_events_issue").on(t.issueId, t.createdAt)],
);
