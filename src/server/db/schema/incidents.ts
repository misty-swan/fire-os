import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { rootColumns } from "./core";

// 出動（模擬・訓練・実出動記録）ドメイン（docs/04:94-97、drizzle/0017_incidents.sql、T040）。
// 制約の正本はSQL。種別（kind）と状態（status）は別契約（docs/11 出動イベントrecording行）。

/** 出動root。activity_id UNIQUE（1活動1出動。operationの付替えはAPI-71＝T043） */
export const incidents = sqliteTable(
  "incidents",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    operationId: text("operation_id").notNull(),
    activityId: text("activity_id"),
    kind: text("kind", { enum: ["simulation", "training", "actual_record"] }).notNull(),
    occurredAt: text("occurred_at").notNull(),
    summary: text("summary").notNull(),
    status: text("status", { enum: ["recording", "active", "closed", "voided"] }).notNull(),
    ...rootColumns,
  },
  (t) => [index("idx_incidents_activity").on(t.activityId)],
);

/** 出動の履歴（追記型。種別訂正/操作元を保持。issue_eventsと同じオブジェクトJSON） */
export const incidentEvents = sqliteTable(
  "incident_events",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    incidentId: text("incident_id").notNull(),
    action: text("action").notNull(),
    beforeJson: text("before_json").notNull(),
    afterJson: text("after_json").notNull(),
    reason: text("reason"),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_incident_events_incident").on(t.incidentId, t.createdAt)],
);

/** 参集（docs/04:96。書込API-23はT041）。既知時刻の順序はSQLのCHECK */
export const incidentParticipants = sqliteTable(
  "incident_participants",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    incidentId: text("incident_id").notNull(),
    memberId: text("member_id").notNull(),
    attendanceStatus: text("attendance_status", {
      enum: ["unconfirmed", "unavailable", "mobilizing", "arrived", "returned"],
    }).notNull(),
    mobilizedAt: text("mobilized_at"),
    arrivedAt: text("arrived_at"),
    returnedAt: text("returned_at"),
    ...rootColumns,
  },
  (t) => [index("idx_incident_participants_member").on(t.memberId, t.incidentId)],
);

/** 参集の履歴（代理入力者/訂正保持。API-23はT041） */
export const incidentParticipantEvents = sqliteTable(
  "incident_participant_events",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    participantId: text("participant_id").notNull(),
    beforeJson: text("before_json").notNull(),
    afterJson: text("after_json").notNull(),
    reason: text("reason"),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_incident_participant_events_participant").on(t.participantId, t.createdAt)],
);
