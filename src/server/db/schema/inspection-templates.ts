import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { rootColumns } from "./core";

// 点検様式の版と承認（docs/04 §3.3、drizzle/0012_inspection_templates.sql）。制約の正本はSQL。

export const inspectionTemplates = sqliteTable(
  "inspection_templates",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    name: text("name").notNull(),
    targetType: text("target_type", { enum: ["facility", "vehicle", "equipment"] }).notNull(),
    currentVersionId: text("current_version_id"),
    status: text("status", { enum: ["draft", "active", "retired"] }).notNull(),
    ...rootColumns,
  },
  (t) => [index("idx_inspection_templates_unit").on(t.unitId, t.targetType, t.status)],
);

export const inspectionTemplateVersions = sqliteTable(
  "inspection_template_versions",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    templateId: text("template_id").notNull(),
    revisionNo: integer("revision_no").notNull(),
    itemSchema: text("item_schema").notNull(),
    status: text("status", { enum: ["draft", "in_review", "approved", "changes_requested", "superseded"] }).notNull(),
    approvedByMemberId: text("approved_by_member_id"),
    approvedAt: text("approved_at"),
    ...rootColumns,
  },
  (t) => [index("idx_inspection_template_versions_template").on(t.templateId, t.revisionNo)],
);
