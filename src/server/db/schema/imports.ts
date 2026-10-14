import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { rootColumns } from "./core";

// 施設CSV取込み（docs/04 §3.5、drizzle/0010_imports.sql）。制約の正本はSQL。

export const importBatches = sqliteTable("import_batches", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  attachmentId: text("attachment_id").notNull(),
  templateVersion: text("template_version").notNull(),
  status: text("status", { enum: ["pending", "parsing", "ready", "failed", "committing", "committed"] }).notNull(),
  inputHash: text("input_hash"),
  previewHash: text("preview_hash"),
  totalRows: integer("total_rows"),
  validRows: integer("valid_rows"),
  errorRows: integer("error_rows"),
  baseDatasetRevision: integer("base_dataset_revision"),
  committedRows: integer("committed_rows"),
  commitVersion: integer("commit_version"),
  errorCode: text("error_code"),
  conflictResolution: text("conflict_resolution", { enum: ["skip", "overwrite"] }),
  ...rootColumns,
});

export const importRows = sqliteTable("import_rows", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  batchId: text("batch_id").notNull(),
  rowNo: integer("row_no").notNull(),
  normalizedJson: text("normalized_json"),
  error: text("error"),
  committedFacilityId: text("committed_facility_id"),
  createdAt: text("created_at").notNull(),
});
