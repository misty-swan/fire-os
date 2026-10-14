import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { rootColumns } from "./core";

// 添付（docs/04 §3.3、drizzle/0008_attachments.sql）。制約の正本はSQL。ここは列名と型だけ。
// 状態はdocs/11の添付遷移（pending_upload→uploaded→checking→ready/rejected、期限→expired、ready→deleting→deleted）。

/** 親作成前の予約（API-98）。prepared→consumed は一回 */
export const attachmentDrafts = sqliteTable("attachment_drafts", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  intendedEntityType: text("intended_entity_type").notNull(),
  parentType: text("parent_type"),
  parentId: text("parent_id"),
  ownerUserId: text("owner_user_id").notNull(),
  status: text("status", { enum: ["prepared", "consumed"] }).notNull(),
  expiresAt: text("expires_at").notNull(),
  consumedEntityId: text("consumed_entity_id"),
  ...rootColumns,
});

/** 添付本体（API-26のintentで1行） */
export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    ownerMemberId: text("owner_member_id").notNull(),
    intentTargetType: text("intent_target_type").notNull(),
    intentTargetId: text("intent_target_id").notNull(),
    draftId: text("draft_id"),
    selectedUploadAttemptId: text("selected_upload_attempt_id"),
    stagingKey: text("staging_key"),
    readyKey: text("ready_key"),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256"),
    status: text("status", {
      enum: ["pending_upload", "uploaded", "checking", "ready", "rejected", "expired", "deleting", "deleted"],
    }).notNull(),
    expiresAt: text("expires_at").notNull(),
    classification: text("classification", { enum: ["basic", "personal", "sensitive"] }).notNull(),
    uploadTokenHash: text("upload_token_hash").notNull(),
    ...rootColumns,
  },
  (t) => [index("idx_attachments_unit_status").on(t.unitId, t.status)],
);

/** 転送の試行。試行ごとに別の不変staging key */
export const uploadAttempts = sqliteTable(
  "upload_attempts",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    attachmentId: text("attachment_id").notNull(),
    stagingKey: text("staging_key").notNull().unique(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    status: text("status", { enum: ["uploaded", "selected", "superseded", "rejected"] }).notNull(),
    expiresAt: text("expires_at").notNull(),
    ...rootColumns,
  },
  (t) => [index("idx_upload_attempts_attachment").on(t.attachmentId, t.status)],
);

/** 業務へのリンク。有効な(attachment, entity)は一つ。unlinkは行を残す */
export const attachmentLinks = sqliteTable(
  "attachment_links",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    attachmentId: text("attachment_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    linkedBy: text("linked_by").notNull(),
    unlinkedAt: text("unlinked_at"),
    unlinkReason: text("unlink_reason"),
    ...rootColumns,
  },
  (t) => [index("idx_attachment_links_entity").on(t.unitId, t.entityType, t.entityId)],
);

/** 検査/リンク/削除の履歴（追記型） */
export const attachmentEvents = sqliteTable(
  "attachment_events",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    attachmentId: text("attachment_id").notNull(),
    action: text("action").notNull(),
    details: text("details").notNull(),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_attachment_events_attachment").on(t.attachmentId, t.createdAt)],
);
