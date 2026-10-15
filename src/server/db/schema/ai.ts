import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { classificationSourceTypes } from "../../../shared/contracts/ai";
import { aiProposalStates } from "../../../shared/states";
import { rootColumns } from "./core";

// AI評価と人の決定（docs/04 §3.4 143-145行、drizzle/0023_ai.sql）。制約の正本はSQL。
// ai_evaluationsは追記型（jobが出す候補の保存。UPDATEしない。statusの遷移はdocs/11 AI提案で、
// 承認/却下はT054がreview_decisionsへ別行として保存する）。review_decisionsはroot可変表
// （API-31の版ガード用。T054）。

export const aiEvaluations = sqliteTable("ai_evaluations", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  jobId: text("job_id").notNull(),
  sourceType: text("source_type", { enum: classificationSourceTypes }).notNull(),
  sourceId: text("source_id").notNull(),
  sourceVersion: integer("source_version").notNull(),
  inputHash: text("input_hash").notNull(),
  inputSnapshotRef: text("input_snapshot_ref"),
  questionVersion: text("question_version").notNull(),
  modelId: text("model_id").notNull(),
  actualModelVersion: text("actual_model_version"),
  outputJson: text("output_json").notNull(),
  status: text("status", { enum: aiProposalStates }).notNull(),
  usageJson: text("usage_json"),
  actorUserId: text("actor_user_id"),
  actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
  createdAt: text("created_at").notNull(),
});

export const reviewDecisions = sqliteTable("review_decisions", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  evaluationId: text("evaluation_id"),
  reportVersionId: text("report_version_id"),
  documentVersionId: text("document_version_id"),
  decision: text("decision", { enum: ["approved", "approved_with_edit", "rejected"] }).notNull(),
  confirmedPayload: text("confirmed_payload").notNull(),
  reviewerMemberId: text("reviewer_member_id").notNull(),
  reviewedAt: text("reviewed_at").notNull(),
  reason: text("reason").notNull(),
  effectOperationId: text("effect_operation_id"),
  ...rootColumns,
});
