import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { aiSourceTypes } from "../../../shared/contracts/ai";
import { aiProposalStates } from "../../../shared/states";
import { rootColumns } from "./core";

// AI評価と人の決定（docs/04 §3.4 143-145行、drizzle/0023_ai.sql）。制約の正本はSQL。
// ai_evaluationsは追記型（jobが出す候補の保存。UPDATEしない。statusの遷移はdocs/11 AI提案で、
// 承認/却下はT054がreview_decisionsへ別行として保存する）。review_decisionsはroot可変表
// （API-31の版ガード用。T054）。
// 評価の実行履歴（ai_evaluation_runs/ai_evaluation_cases、docs/04 §3.4 155行）は0026（T061）。

export const aiEvaluations = sqliteTable("ai_evaluations", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  jobId: text("job_id").notNull(),
  sourceType: text("source_type", { enum: aiSourceTypes }).notNull(),
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

// 評価の実行履歴（docs/04 §3.4 155行、drizzle/0026。T061）。統計のみで個人本文は複製しない
// （失敗例はai_evaluation_casesがdataset行idで参照）。gate_passedは成功した実行だけが持ち、
// 未実施・失敗を合格と表示しない（docs/06 §6、docs/14 D12）。
export const aiEvaluationRuns = sqliteTable("ai_evaluation_runs", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  kind: text("kind", { enum: ["classification", "report"] }).notNull(),
  datasetVersion: text("dataset_version").notNull(),
  questionVersion: text("question_version").notNull(),
  modelId: text("model_id").notNull(),
  datasetRef: text("dataset_ref").notNull(),
  datasetSha256: text("dataset_sha256").notNull(),
  caseCount: integer("case_count").notNull(),
  labelsJson: text("labels_json").notNull(),
  outputsJson: text("outputs_json").notNull(),
  metricsJson: text("metrics_json"),
  gatePassed: integer("gate_passed", { mode: "boolean" }),
  status: text("status", { enum: ["succeeded", "failed"] }).notNull(),
  errorCode: text("error_code"),
  jobId: text("job_id").notNull(),
  runByUserId: text("run_by_user_id").notNull(),
  actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
  executedAt: text("executed_at").notNull(),
  createdAt: text("created_at").notNull(),
});

export const aiEvaluationCases = sqliteTable("ai_evaluation_cases", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  runId: text("run_id").notNull(),
  caseRef: text("case_ref").notNull(),
  expected: text("expected").notNull(),
  predicted: text("predicted"),
  passed: integer("passed", { mode: "boolean" }).notNull(),
  latencyMs: integer("latency_ms"),
  note: text("note"),
  createdAt: text("created_at").notNull(),
});
