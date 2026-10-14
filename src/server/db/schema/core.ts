import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 型付きクエリ用の表定義。制約(CHECK/FK/部分索引/トリガー)の正本は drizzle/*.sql で、
// ここは列の名前と型だけを持つ。tests/schema.test.ts が実DBの列と一致することを検査する。

/** 全root可変表の共通列（docs/04 §1）。 制約の正本は各drizzle/*.sql */
export const rootColumns = {
  version: integer("version").notNull().default(1),
  lastMutationToken: text("last_mutation_token"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  createdBy: text("created_by"),
  actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
};

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  authId: text("auth_id").notNull().unique(),
  status: text("status", { enum: ["active", "disabled"] }).notNull(),
  authzVersion: integer("authz_version").notNull().default(1),
  disabledAt: text("disabled_at"),
  disabledReason: text("disabled_reason"),
  sessionRevokedBefore: text("session_revoked_before"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const units = sqliteTable("units", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status", { enum: ["active", "disabled"] }).notNull(),
  datasetRevision: integer("dataset_revision").notNull().default(1),
  eventSequence: integer("event_sequence").notNull().default(0),
  ...rootColumns,
});

export const roles = sqliteTable("roles", {
  id: text("id").primaryKey(),
  code: text("code", { enum: ["member", "operator", "officer", "admin"] }).notNull().unique(),
  createdAt: text("created_at").notNull(),
});

export const members = sqliteTable(
  "members",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    userId: text("user_id").unique(),
    displayName: text("display_name").notNull(),
    rank: text("rank"),
    joinedAt: text("joined_at"),
    squad: text("squad"),
    /** JSON配列（資格・講習。最大10件） */
    qualifications: text("qualifications").notNull().default("[]"),
    status: text("status", { enum: ["active", "paused", "retired"] }).notNull(),
    statusReason: text("status_reason"),
    ...rootColumns,
  },
  (t) => [index("idx_members_unit_status").on(t.unitId, t.status)],
);

export const memberRoles = sqliteTable("member_roles", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  memberId: text("member_id").notNull(),
  roleId: text("role_id").notNull(),
  grantedBy: text("granted_by").notNull(),
  revokedAt: text("revoked_at"),
  changeReason: text("change_reason"),
  ...rootColumns,
});

export const scopeAssignments = sqliteTable("scope_assignments", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  memberId: text("member_id").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  /** JSON配列（PER-xx） */
  permissions: text("permissions").notNull(),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
  changeReason: text("change_reason"),
  ...rootColumns,
});

/** 名簿の個人情報（D02許可列だけ。トリガーがキーを制限）。allowedFields は {"phone":…,"emergencyContact":…} */
export const memberPrivateProfiles = sqliteTable("member_private_profiles", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  memberId: text("member_id").notNull().unique(),
  allowedFields: text("allowed_fields").notNull(),
  ...rootColumns,
});
