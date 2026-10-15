import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { rootColumns } from "./core";

// 通知（docs/04 §3.4 139-142行、drizzle/0022_notifications.sql、T050）。制約の正本はSQL。
// 承認（API-64）でdraft→approvedと配送job登録を同一batchで行い、deliveries行の生成・provider呼出し・
// approved→dispatching遷移はT051の配送handlerが行う（docs/16 T050裁定）。

/**
 * 通知承認root。本文（bodyRevision）と対象（notification_recipients＋audienceHash）を承認のために固定し、
 * 変更時は新draftを作る（docs/04「承認した本文と対象を固定、変更時新draft」）。
 * 源（sourceType/sourceId）は多形参照のためFKを置かず、draft作成時にサービス層で実在を検査する。
 */
export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    /** 源の種別（未回答者抽出=activity／お知らせ=announcement／点検期限=inspection_due） */
    sourceType: text("source_type", { enum: ["activity", "announcement", "inspection_due"] }).notNull(),
    sourceId: text("source_id").notNull(),
    /** 承認した本文（{"body": テキスト}のJSON。変更しない） */
    bodyRevision: text("body_revision").notNull(),
    /** 対象の固定hash（memberId整列配列の正規化JSONのSHA-256。API-64の一致検査に使う） */
    audienceHash: text("audience_hash").notNull(),
    /** draft→approved/cancelled、approved→dispatching→finished/failed（docs/11。遷移表はstates.ts） */
    status: text("status", { enum: ["draft", "approved", "cancelled", "dispatching", "finished", "failed"] }).notNull(),
    approvedBy: text("approved_by"),
    approvedAt: text("approved_at"),
    /** 期限（T051の配送が配信直前の対象除外に使う。docs/07 §5） */
    expiresAt: text("expires_at"),
    ...rootColumns,
  },
  (t) => [
    index("idx_notifications_source").on(t.sourceType, t.sourceId),
    index("idx_notifications_status").on(t.unitId, t.status, t.id),
  ],
);

/**
 * 対象者（中間表）。宛先はaddress_ref（参照。例: member:<memberId>#inbox）だけを保存し、
 * 連絡先生値・氏名を複製しない（docs/04「連絡先生値をジョブへ複製しない」）。
 * readAtは本人（API-100）だけが付け、配送（deliveries）と分離する。
 */
export const notificationRecipients = sqliteTable(
  "notification_recipients",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    notificationId: text("notification_id").notNull(),
    memberId: text("member_id").notNull(),
    /** D13の検証設定（アプリ内一経路。実チャネルの拡張はD13了承後。docs/16 T050） */
    channel: text("channel", { enum: ["inapp"] }).notNull(),
    addressRef: text("address_ref").notNull(),
    readAt: text("read_at"),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_notification_recipients_member").on(t.memberId, t.notificationId),
    index("idx_notification_recipients_notification").on(t.notificationId),
  ],
);

/**
 * 配送（docs/04:141）。deliveryKeyは再試行で固定、current行のattemptCountを増分し、
 * 各試行はnotification_eventsへ追記する。T050では書き込まない（T051の配送handler）。
 */
export const notificationDeliveries = sqliteTable(
  "notification_deliveries",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    recipientId: text("recipient_id").notNull(),
    deliveryKey: text("delivery_key").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    status: text("status", { enum: ["pending", "sending", "provider_accepted", "failed", "unknown", "retry_wait"] }).notNull(),
    providerId: text("provider_id"),
    lastErrorCode: text("last_error_code"),
    nextAttemptAt: text("next_attempt_at"),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("idx_notification_deliveries_status").on(t.status, t.nextAttemptAt),
    index("idx_notification_deliveries_recipient").on(t.recipientId),
  ],
);

/** 承認/取消/期限/配送全体の履歴（追記型。REPLACE拒否トリガーは0022） */
export const notificationEvents = sqliteTable(
  "notification_events",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    notificationId: text("notification_id").notNull(),
    action: text("action").notNull(),
    details: text("details").notNull(),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_notification_events_notification").on(t.notificationId, t.createdAt)],
);
