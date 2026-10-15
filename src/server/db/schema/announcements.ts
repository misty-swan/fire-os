import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { rootColumns } from "./core";

// お知らせドメイン（docs/04 §3.4 132-135行、drizzle/0019_announcements.sql）。制約の正本はSQL。

export const announcements = sqliteTable("announcements", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  /** 現在版（1始まり。title/body/対象の変更で増分。既読はこの版に束縛される） */
  revisionNo: integer("revision_no").notNull(),
  /** docs/11 お知らせ: draft→published/archived、published→archived、archivedは終端 */
  status: text("status", { enum: ["draft", "published", "archived"] }).notNull(),
  /** 公開日時。draftでも作成時に指定された公開予定時刻(publishAt)を保持し、公開操作時に確定値として使う */
  publishedAt: text("published_at"),
  ...rootColumns,
});

/** 版（docs/04:133「親/版UNIQUE、変更原本保持」。対象snapshotを同梱。追記のみでUPDATE/DELETEしない） */
export const announcementRevisions = sqliteTable("announcement_revisions", {
  id: text("id").primaryKey(),
  unitId: text("unit_id").notNull(),
  announcementId: text("announcement_id").notNull(),
  revisionNo: integer("revision_no").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  /** 対象の明示snapshot（member_id配列のJSON。版の時点の対象を保持する） */
  audienceSnapshot: text("audience_snapshot").notNull(),
  actorUserId: text("actor_user_id"),
  actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
  createdAt: text("created_at").notNull(),
});

/** 対象（docs/04:134「組合せUNIQUE、対象を明示snapshot」。現在の対象。対象変更で全置換する） */
export const announcementAudience = sqliteTable(
  "announcement_audience",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    announcementId: text("announcement_id").notNull(),
    memberId: text("member_id").notNull(),
    actorUserId: text("actor_user_id"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("idx_announcement_audience_member").on(t.memberId, t.announcementId)],
);

/** 既読（docs/04:135「三つ組UNIQUE、本人のみ、既読と配送を分離」。版に束縛。追記のみで更新/削除しない） */
export const announcementReads = sqliteTable(
  "announcement_reads",
  {
    id: text("id").primaryKey(),
    unitId: text("unit_id").notNull(),
    announcementId: text("announcement_id").notNull(),
    /** 既読を付けた版（docs/11「既読は版に束縛」。改版後は別の行として取り直す） */
    revisionNo: integer("revision_no").notNull(),
    memberId: text("member_id").notNull(),
    readAt: text("read_at").notNull(),
    lastMutationToken: text("last_mutation_token"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    createdBy: text("created_by"),
    actorKind: text("actor_kind", { enum: ["human", "system"] }).notNull(),
  },
  (t) => [index("idx_announcement_reads_member").on(t.memberId, t.announcementId)],
);
