import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { rootColumns } from "./core";

// 施設と位置確認履歴（docs/04 §3.3、drizzle/0009_facilities.sql）。制約の正本はSQL。

export const facilities = sqliteTable(
  "facilities",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    type: text("type", { enum: ["hydrant", "cistern", "box"] }).notNull(),
    managementNumber: text("management_number"),
    identifyingName: text("identifying_name"),
    latitude: real("latitude").notNull(),
    longitude: real("longitude").notNull(),
    locationNote: text("location_note").notNull(),
    locationSource: text("location_source").notNull(),
    locationVersion: integer("location_version").notNull(),
    verificationStatus: text("verification_status", {
      enum: ["unverified", "pending", "verified", "rejected"],
    }).notNull(),
    lastVerifiedAt: text("last_verified_at"),
    verifiedByMemberId: text("verified_by_member_id"),
    metadata: text("metadata").notNull().default("{}"),
    archivedAt: text("archived_at"),
    ...rootColumns,
  },
  (t) => [index("idx_facilities_unit_type_number").on(t.unitId, t.type, t.managementNumber)],
);

/** 位置の履歴（追記型） */
export const facilityLocationRevisions = sqliteTable(
  "facility_location_revisions",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    facilityId: text("facility_id").notNull(),
    locationVersion: integer("location_version").notNull(),
    eventNo: integer("event_no").notNull(),
    latitude: real("latitude").notNull(),
    longitude: real("longitude").notNull(),
    locationSource: text("location_source").notNull(),
    verificationStatus: text("verification_status", {
      enum: ["unverified", "pending", "verified", "rejected"],
    }).notNull(),
    verifiedByMemberId: text("verified_by_member_id"),
    verifiedAt: text("verified_at"),
    reason: text("reason").notNull(),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_facility_location_revisions_facility").on(t.facilityId, t.locationVersion, t.eventNo)],
);
