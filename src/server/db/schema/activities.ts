import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { rootColumns } from "./core";

// 活動（予定）ドメイン（docs/04 §3.2、drizzle/0015_activities.sql）。制約の正本はSQL。

/** 共通の出来事root。活動(activities)と出動(incidents、T040)で共用する。中止でcountable=0（docs/11 §3） */
export const operations = sqliteTable("operations", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  countable: integer("countable", { mode: "boolean" }).notNull(),
  ...rootColumns,
});

export const activities = sqliteTable(
  "activities",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    operationId: text("operation_id").notNull(),
    title: text("title").notNull(),
    kind: text("kind").notNull(),
    plannedStartsAt: text("planned_starts_at").notNull(),
    plannedEndsAt: text("planned_ends_at"),
    locationText: text("location_text").notNull(),
    ownerMemberId: text("owner_member_id").notNull(),
    status: text("status", { enum: ["draft", "scheduled", "in_progress", "completed", "cancelled"] }).notNull(),
    responseDueAt: text("response_due_at"),
    ...rootColumns,
  },
  (t) => [
    index("idx_activities_unit_planned").on(t.unitId, t.plannedStartsAt, t.id),
    index("idx_activities_owner").on(t.ownerMemberId),
  ],
);

/** 対象者のsnapshot（docs/04「未回答母数は現在の名簿全件ではなく対象snapshot」） */
export const activityAudience = sqliteTable(
  "activity_audience",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    activityId: text("activity_id").notNull(),
    memberId: text("member_id").notNull(),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_activity_audience_member").on(t.memberId, t.activityId)],
);

/** 開催状態の履歴（追記型）。初行（作成）はprevious=next=初期状態。公開済の内容変更も残す */
export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    activityId: text("activity_id").notNull(),
    previousStatus: text("previous_status", { enum: ["draft", "scheduled", "in_progress", "completed", "cancelled"] }).notNull(),
    nextStatus: text("next_status", { enum: ["draft", "scheduled", "in_progress", "completed", "cancelled"] }).notNull(),
    reason: text("reason"),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_activity_events_activity").on(t.activityId, t.createdAt)],
);

/** 出欠（docs/04「組合せUNIQUE、対象者FK/同unit、回答版あり」。API-08/41はT036） */
export const activityAttendance = sqliteTable(
  "activity_attendance",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    activityId: text("activity_id").notNull(),
    memberId: text("member_id").notNull(),
    response: text("response", { enum: ["unanswered", "attending", "absent", "undecided"] }).notNull(),
    respondedAt: text("responded_at"),
    ...rootColumns,
  },
  (t) => [index("idx_activity_attendance_member").on(t.memberId, t.activityId)],
);

/** 出欠の履歴（本人/代理操作者を記録。API-08/41はT036） */
export const attendanceEvents = sqliteTable(
  "attendance_events",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    attendanceId: text("attendance_id").notNull(),
    response: text("response", { enum: ["unanswered", "attending", "absent", "undecided"] }).notNull(),
    proxyForMemberId: text("proxy_for_member_id"),
    reason: text("reason"),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_attendance_events_attendance").on(t.attendanceId, t.createdAt)],
);

/** 実績root（activity_id UNIQUE。現在版ポインタはT037で接続） */
export const activityResults = sqliteTable("activity_results", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  activityId: text("activity_id").notNull(),
  currentRevisionId: text("current_revision_id"),
  ...rootColumns,
});

/** 実績の版（追記型。訂正は理由必須。API-42はT037） */
export const activityResultRevisions = sqliteTable(
  "activity_result_revisions",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    resultId: text("result_id").notNull(),
    revisionNo: integer("revision_no").notNull(),
    actualStartsAt: text("actual_starts_at"),
    actualEndsAt: text("actual_ends_at"),
    content: text("content").notNull(),
    supersedesId: text("supersedes_id"),
    correctionReason: text("correction_reason"),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_activity_result_revisions_result").on(t.resultId, t.revisionNo)],
);
