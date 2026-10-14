import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { rootColumns } from "./core";

// 車両・資機材（docs/04 §3.2、drizzle/0011_assets.sql）。制約の正本はSQL。

export const vehicles = sqliteTable(
  "vehicles",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    assetCode: text("asset_code").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull(),
    storageFacilityId: text("storage_facility_id"),
    archivedAt: text("archived_at"),
    ...rootColumns,
  },
  (t) => [index("idx_vehicles_unit").on(t.unitId, t.assetCode)],
);

export const equipment = sqliteTable(
  "equipment",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    assetCode: text("asset_code").notNull(),
    name: text("name").notNull(),
    quantity: real("quantity").notNull(),
    quantityUnit: text("quantity_unit").notNull(),
    status: text("status").notNull(),
    storageFacilityId: text("storage_facility_id"),
    storageVehicleId: text("storage_vehicle_id"),
    storageNote: text("storage_note"),
    archivedAt: text("archived_at"),
    ...rootColumns,
  },
  (t) => [index("idx_equipment_unit").on(t.unitId, t.assetCode)],
);

/** 数量の列はDB上はREAL（API応答の丸めはしない） */
