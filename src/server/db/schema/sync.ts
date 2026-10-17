import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 通信断同期の冪等台帳（docs/04:167、drizzle/0031_sync.sql、T076）。制約の正本はSQL。
// 書込みは元業務mutationと同一batch（mutations/execute.tsのMutationSpec.sideEffects）だけ。
// 行は一度書いたら更新・削除しない（docs/05 §2「同期effectは別UNIQUEを恒久保持し」の本体）。

export const syncOperations = sqliteTable("sync_operations", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  /** 操作者。照会（API-82）は本人だけ。他人の操作は存在も明かさない（docs/05 API-82「PER-13本人」） */
  userId: text("user_id").notNull(),
  deviceId: text("device_id").notNull(),
  clientOperationId: text("client_operation_id").notNull(),
  /** 元操作（T076のallowlist: 点検保存/訂正・本人出欠・参集。src/server/sync/allowlist.ts） */
  operationCode: text("operation_code").notNull(),
  /** 元対象（facility/activity/incident/点検原本。多形参照のためFKを置かない） */
  targetId: text("target_id").notNull(),
  /** 元対象の版（新規作成は0。docs/05 SyncCommand「VersionOrZero」。docs/04はI?なのでNULLも許す） */
  baseVersion: integer("base_version"),
  /** 同期コマンドの正規化hash。同キー別本文の検出に使い、元APIのhashはidempotency_records側に保存される */
  requestHash: text("request_hash").notNull(),
  /** サーバーが確定させる終端だけ（local_draft/pending/sendingは端末側の状態。現在書込むのはapplied） */
  status: text("status", { enum: ["applied", "conflict", "rejected"] }).notNull(),
  /** 保存した応答（SyncOperation={id,status}のJSON。業務本文・個人情報は複製しない） */
  resultJson: text("result_json").notNull(),
  createdAt: text("created_at").notNull(),
  /** 冪等と同じ7日。期限後の同キー再送はkey_expiredで拒否し、人は新しい操作を作る（docs/05 §2、D14） */
  expiresAt: text("expires_at").notNull(),
  // docs/04:167「user_id/device_id/client_operation_id UNIQUE」は恒久保持の本体。
  // SQLのUNIQUE制約（0031）が正で、drizzle側では宣言しない（二重定義を避ける）
});
