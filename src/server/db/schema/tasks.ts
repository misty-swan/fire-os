import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { rootColumns } from "./core";

// 業務タスク（docs/04:136、drizzle/0021_tasks.sql、T049）。制約の正本はSQL。

/**
 * 業務タスク。手動作成（API-68。sourceDecisionId省略）と承認済みAI起点（T054が同一batchで接続）を
 * 同じ表に保存する。sourceEvaluationId/sourceDecisionIdは参照先表（ai_evaluations/review_decisions）が
 * T053で作成されるためFKではなくサービス層で存在検査する（0021のコメント参照）。
 * effectOperationIdは一意の効果操作ID（部分一意索引uq_task_effect_operation。二重効果0）。
 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    /** 元AI評価（承認済みAI起点のみ。手動はNULL） */
    sourceEvaluationId: text("source_evaluation_id"),
    /** 元異常 */
    sourceIssueId: text("source_issue_id"),
    title: text("title").notNull(),
    assigneeMemberId: text("assignee_member_id"),
    /** open→assigned/in_progress/cancelled、assigned→in_progress/cancelled、in_progress→done、done→in_progress（再開）。cancelledは終端 */
    status: text("status", { enum: ["open", "assigned", "in_progress", "done", "cancelled"] }).notNull(),
    /** 業務日（YYYY-MM-DD。瞬間値と混同しない。docs/04 §1） */
    dueDate: text("due_date"),
    /** 承認済み決定（承認済みAI起点のみ。decisionとeffectは対で必須＝CHECK） */
    sourceDecisionId: text("source_decision_id"),
    /** 一意の効果操作ID（docs/04 effect_operation_id非NULL UNIQUE） */
    effectOperationId: text("effect_operation_id"),
    ...rootColumns,
  },
  (t) => [
    index("idx_tasks_unit_status").on(t.unitId, t.status, t.assigneeMemberId, t.id),
    index("idx_tasks_source_issue").on(t.sourceIssueId),
    index("idx_tasks_source_decision").on(t.sourceDecisionId),
  ],
);

/** 状態履歴（追記型）。状態変更・割当・作成と同じcommitで追記する（docs/04:138） */
export const taskEvents = sqliteTable(
  "task_events",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    taskId: text("task_id").notNull(),
    action: text("action").notNull(),
    beforeJson: text("before_json").notNull(),
    afterJson: text("after_json").notNull(),
    /** 再開・変更の理由（≤2000。API-87のreasonは契約で必須） */
    reason: text("reason"),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_task_events_task").on(t.taskId, t.createdAt)],
);
