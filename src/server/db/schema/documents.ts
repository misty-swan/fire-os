import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { rootColumns } from "./core";

// 許諾文書ドメイン（docs/04 §3.4 149-152行、drizzle/0027_documents.sql）。制約の正本はSQL。
// T064（抽出job handler）にmigrationが無いためdocument_chunksも0027で作成済み（T064は書込のみ）。

/**
 * 文書root（docs/04:149）。draftと承認済pointerを分離（docs/11「承認版とdraftの別pointer」）。
 * policy_versionはACL・分類の改訂版（API-75/99の応答がpolicyVersionを返すためのT062追加列。docs/04同段を更新済み）
 */
export const documents = sqliteTable(
  "documents",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    title: text("title").notNull(),
    classification: text("classification").notNull(),
    /** 有効な承認版（T063の承認だけが切替る。T062では常にNULL） */
    currentVersionId: text("current_version_id"),
    /** 最新のdraft版（版作成で切替る） */
    currentDraftVersionId: text("current_draft_version_id"),
    /** 文書全体の状態（docs/11「各機能タスクで列挙」のT062実装。draft→approved/withdrawnの辺はT063が使う） */
    status: text("status", { enum: ["draft", "approved", "withdrawn"] }).notNull(),
    /** ACL・分類の改訂版（API-99のACL変更で増分。T062では作成時の1固定） */
    policyVersion: integer("policy_version").notNull().default(1),
    ...rootColumns,
  },
  (t) => [index("idx_documents_unit_status").on(t.unitId, t.status, t.id)],
);

/**
 * 文書の版（docs/04:150「文書/版UNIQUE、ready添付、承認原本不変」）。内容列（attachment_id/license_ref/
 * content_hash等）はDBトリガーで不変。status遷移（T063の決定操作）だけが更新を許される。
 * attachmentIdは原本添付への直接参照（取得経路はattachment_links。docs/16 T062の裁定）
 */
export const documentVersions = sqliteTable(
  "document_versions",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    documentId: text("document_id").notNull(),
    /** 文書ごとに1から採番（UNIQUE(unit_id, document_id, revision_no)） */
    revisionNo: integer("revision_no").notNull(),
    attachmentId: text("attachment_id").notNull(),
    status: text("status", { enum: ["draft", "in_review", "approved", "changes_requested", "superseded", "withdrawn"] }).notNull(),
    approvedBy: text("approved_by"),
    approvedAt: text("approved_at"),
    /** 許諾の出典（必須。無い版は作れない） */
    licenseRef: text("license_ref").notNull(),
    /** 原本のsha256（版作成時に添付から固定。原本不変の検証点） */
    contentHash: text("content_hash").notNull(),
    ...rootColumns,
  },
  (t) => [index("idx_document_versions_document").on(t.documentId, t.revisionNo)],
);

/** 文書ACL（docs/04:151「member/role片方、同unit、effect allow/deny、deny優先」。現在値の全置換で管理。API-99＝T063） */
export const documentAcl = sqliteTable(
  "document_acl",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    documentId: text("document_id").notNull(),
    memberId: text("member_id"),
    roleId: text("role_id"),
    /** 許可の語（T062の可視性判定は行の存在とeffectのみ。細分化はT063以降） */
    permission: text("permission").notNull(),
    effect: text("effect", { enum: ["allow", "deny"] }).notNull(),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_document_acl_document").on(t.documentId)],
);

/** 抽出chunk（docs/04:152「版/chunk UNIQUE、無効版を検索対象から除外」。T064の抽出job handlerが書込する） */
export const documentChunks = sqliteTable(
  "document_chunks",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    versionId: text("version_id").notNull(),
    chunkNo: integer("chunk_no").notNull(),
    pageNo: integer("page_no"),
    section: text("section"),
    text: text("text").notNull(),
    /** 抽出原文への位置保持（docs/06 §5「ページ/節/文字offset」。JSON） */
    sourceOffsets: text("source_offsets").notNull(),
    /** 語彙はT064で抽出/索引方式（D16）と一緒に確定（0027では長さだけ拘束） */
    indexStatus: text("index_status").notNull(),
    indexKey: text("index_key"),
    ...rootColumns,
  },
  (t) => [index("idx_document_chunks_version_index").on(t.versionId, t.indexStatus)],
);
