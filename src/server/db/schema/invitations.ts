import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 型付きクエリ用の列定義。制約・部分索引の正本は drizzle/0005_invitations.sql（tests/schema.test.ts が列の一致を検査）。
export const invitations = sqliteTable("invitations", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  memberId: text("member_id").notNull(),
  kind: text("kind", { enum: ["invite", "bootstrap"] }).notNull(),
  emailHash: text("email_hash").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  status: text("status", { enum: ["pending", "consumed", "cancelled"] }).notNull(),
  expiresAt: text("expires_at").notNull(),
  consumedAt: text("consumed_at"),
  consumedByUserId: text("consumed_by_user_id"),
  cancelledAt: text("cancelled_at"),
  cancelReason: text("cancel_reason"),
  intendedAuthz: text("intended_authz").notNull(),
  version: integer("version").notNull().default(1),
  lastMutationToken: text("last_mutation_token"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  createdBy: text("created_by"),
  actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
});
