import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { rootColumns } from "./core";

// 報告書・文書版の元（docs/04 §3.4 146-148行、drizzle/0024_reports.sql）。制約の正本はSQL。

/** 帳票root（docs/04:146「activity_id, kind, current_draft_version_id?, current_approved_version_id?」） */
export const reports = sqliteTable(
  "reports",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    activityId: text("activity_id").notNull(),
    /** T056は手動下書きのみ（AI下書きはT057以降でCHECK拡張） */
    kind: text("kind", { enum: ["manual"] }).notNull(),
    currentDraftVersionId: text("current_draft_version_id"),
    currentApprovedVersionId: text("current_approved_version_id"),
    ...rootColumns,
  },
  (t) => [index("idx_reports_unit_activity").on(t.unitId, t.activityId, t.id)],
);

/**
 * 帳票の版（docs/04:147「report/版UNIQUE、編集/承認版不変」。docs/11「差戻し後/承認後訂正は新draft版、旧版不変」）。
 * 内容列はDBトリガーで不変。status遷移（T058の決定操作）だけが更新を許される。
 */
export const reportVersions = sqliteTable(
  "report_versions",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    reportId: text("report_id").notNull(),
    /** 使用した帳票様式の版（allowlist設定artifact。hash照合はconfig/report-templates/manifest.json） */
    templateVersion: text("template_version").notNull(),
    revisionNo: integer("revision_no").notNull(),
    text: text("text").notNull(),
    /** 様式の必須欄で未記入のもの（サーバー計算） */
    missingFields: text("missing_fields").notNull(),
    /** 参照源の版（サーバーが実績から計算: {activityVersion, resultVersion, resultRevisionNo}） */
    sourceVersions: text("source_versions").notNull(),
    /** AI生成時のモデル（手動下書きはNULL。T057以降） */
    modelId: text("model_id"),
    status: text("status", { enum: ["draft", "in_review", "approved", "changes_requested", "superseded", "withdrawn"] }).notNull(),
    approvedBy: text("approved_by"),
    approvedAt: text("approved_at"),
    ...rootColumns,
  },
  (t) => [index("idx_report_versions_report").on(t.reportId, t.revisionNo)],
);

/**
 * 報告書/文書版の申請・決定履歴（docs/04:148「対象一つ、申請/差戻し/承認/撤回履歴、
 * request_reviewで決定行は作らない」。追記型。書込はT058以降）
 */
export const contentVersionEvents = sqliteTable(
  "content_version_events",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    reportVersionId: text("report_version_id"),
    documentVersionId: text("document_version_id"),
    action: text("action", { enum: ["request_review", "changes_requested", "approved", "superseded", "withdrawn"] }).notNull(),
    reason: text("reason"),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_content_version_events_report").on(t.reportVersionId, t.createdAt),
    index("idx_content_version_events_document").on(t.documentVersionId, t.createdAt),
  ],
);
