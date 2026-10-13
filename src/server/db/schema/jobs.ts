import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jobStates } from "../../../shared/states";

// 制約の正本は drizzle/0002_jobs.sql。
export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  kind: text("kind").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  sourceVersion: integer("source_version").notNull(),
  configVersion: text("config_version").notNull(),
  dedupeKey: text("dedupe_key").notNull().unique(),
  status: text("status", { enum: jobStates }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  nextAttemptAt: text("next_attempt_at").notNull(),
  leaseToken: text("lease_token"),
  leaseUntil: text("lease_until"),
  errorCode: text("error_code"),
  resultRef: text("result_ref"),
  requestedBy: text("requested_by"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
