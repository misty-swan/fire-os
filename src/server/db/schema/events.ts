import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 横断整合性の表（冪等/assertion/監査/outbox）。制約の正本は drizzle/0001_core.sql。

export const idempotencyRecords = sqliteTable("idempotency_records", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  operationCode: text("operation_code").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  canonicalRequestHash: text("canonical_request_hash").notNull(),
  state: text("state", { enum: ["reserved", "completed", "expired"] }).notNull(),
  responseStatus: integer("response_status"),
  responseJson: text("response_json"),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const mutationAssertions = sqliteTable("mutation_assertions", {
  attemptToken: text("attempt_token").notNull(),
  seq: integer("seq").notNull(),
  ok: integer("ok").notNull(),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
  actorUserId: text("actor_user_id"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  mutationId: text("mutation_id").notNull(),
  occurredAt: text("occurred_at").notNull(),
  metadataJson: text("metadata_json").notNull(),
});

export const domainEvents = sqliteTable("domain_events", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  mutationId: text("mutation_id").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  entityVersion: integer("entity_version").notNull(),
  eventType: text("event_type").notNull(),
  payloadMinimal: text("payload_minimal").notNull(),
  sequence: integer("sequence").notNull(),
  createdAt: text("created_at").notNull(),
});
