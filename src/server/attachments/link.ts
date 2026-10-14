import type { AppEnv } from "../env";
import { HttpError } from "../http";
import type { ExtraCondition, MutationContext, RootGuard } from "../mutations/execute";

/**
 * 添付を業務へリンクする（T017、docs/07 §3.5、docs/10 §4）。
 * 親の作成/変更のexecuteMutationへ条件とSQLを足して使う（単独のリンクAPIは無い。添付は業務と同時に確定する）。
 *
 * - draftId: 予約を一回消費し（prepared→consumed）、その予約に紐づく全添付をリンクする
 * - attachmentIds: 既にreadyの添付を個別にリンクする（未検査は422 ATTACHMENT_NOT_READY）
 * - 分類: sensitive（現場写真等）を基本の対象へ付ける操作は拒否する（分類の引下げはしない。docs/10 §4）
 */
export interface AttachmentLinkInput {
  /** リンク先の業務対象（facility/vehicle/equipment等。存在を確認できる種別だけ） */
  target: { type: string; id: string };
  draftId?: string;
  attachmentIds?: string[];
}

/** リンク先として存在確認できる業務表（PH2時点。inspection/issue等はその表ができるタスクで追加） */
export const LINK_ENTITY_TABLES: Record<string, string> = {
  facility: "facilities",
  vehicle: "vehicles",
  equipment: "equipment",
};

export interface LinkPlan {
  /** draftを消費するときだけ。呼び出し元のMutationSpec.rootsへ足す（版ガード） */
  root?: RootGuard;
  /** MutationSpec.conditionsへ足す（書込の前の状態で評価される） */
  conditions: ExtraCondition[];
  /** MutationSpec.duplicateOnへ足す */
  duplicateOn: readonly string[];
  /** MutationSpec.statementsの戻りへ足す（親のINSERTより後に置く） */
  statements: (ctx: MutationContext) => D1PreparedStatement[];
}

const INSERT_LINK =
  "INSERT INTO attachment_links (id, unit_id, attachment_id, entity_type, entity_id, linked_by, created_at, updated_at, created_by, actor_kind) " +
  "SELECT ?, ?, a.id, ?, ?, ?, ?, ?, ?, 'human' FROM attachments a WHERE a.unit_id = ? AND a.status = 'ready' AND a.classification <> 'sensitive' AND ";

export async function planAttachmentLinks(
  env: Pick<AppEnv, "DB">,
  unitId: string,
  actorUserId: string,
  input: AttachmentLinkInput,
): Promise<LinkPlan> {
  const table = LINK_ENTITY_TABLES[input.target.type];
  if (!table) throw new Error(`planAttachmentLinks: リンク先の種別が未対応です: ${input.target.type}`);
  const ids = [...(input.attachmentIds ?? [])];
  if (!input.draftId && ids.length === 0) throw new Error("planAttachmentLinks: draftId か attachmentIds のどちらかが必要です");
  const duplicateOn = ["index:uq_attachment_links_active"] as const;
  const conditions: ExtraCondition[] = [];

  // 予約の消費は版ガードで一回に限る。現在の版を読んでおく（作成直後は1。消費は最初で最後）
  let draftRoot: RootGuard | undefined;
  if (input.draftId) {
    const draft = await env.DB.prepare("SELECT id, unit_id, version, status, expires_at FROM attachment_drafts WHERE id = ?")
      .bind(input.draftId)
      .first<{ id: string; unit_id: string; version: number; status: string; expires_at: string }>();
    if (!draft || draft.unit_id !== unitId) throw new HttpError("NOT_FOUND");
    if (draft.status !== "prepared") {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "attachmentDraftId", reason: "draft_already_consumed" }]);
    }
    if (draft.expires_at <= new Date().toISOString()) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "attachmentDraftId", reason: "draft_expired" }]);
    }
    draftRoot = { table: "attachment_drafts", id: draft.id, expectedVersion: draft.version, allowedStates: { column: "status", values: ["prepared"] } };
    // 予約由来の添付は、全て検査を通ってreadyのものだけリンクする（1つでも未検査があれば422）
    conditions.push({
      existsSql:
        "SELECT 1 FROM (SELECT COUNT(*) AS n FROM attachments a WHERE a.draft_id = ? AND a.unit_id = ? AND a.status <> 'ready') WHERE n = 0",
      binds: [input.draftId, unitId],
      failCode: "ATTACHMENT_NOT_READY",
    });
  }

  // 新規親の作成では親はまだ存在しないので、親の存在条件を付けない（同batchのcreated検査が担保する）
  const isNewParent = !!input.draftId;
  if (!isNewParent) {
    conditions.push({
      existsSql: `SELECT 1 FROM ${table} WHERE id = ? AND unit_id = ?`,
      binds: [input.target.id, unitId],
      failCode: "NOT_FOUND",
    });
  }
  for (const id of ids) {
    conditions.push({
      existsSql: "SELECT 1 FROM attachments WHERE id = ? AND unit_id = ?",
      binds: [id, unitId],
      failCode: "NOT_FOUND",
    });
    conditions.push({
      existsSql: "SELECT 1 FROM attachments WHERE id = ? AND unit_id = ? AND status = 'ready' AND classification <> 'sensitive'",
      binds: [id, unitId],
      failCode: "ATTACHMENT_NOT_READY",
    });
  }

  const statements = (ctx: MutationContext): D1PreparedStatement[] => {
    const stmts: D1PreparedStatement[] = [];
    if (input.draftId && draftRoot) {
      stmts.push(
        env.DB.prepare(
          "UPDATE attachment_drafts SET status = 'consumed', consumed_entity_id = ?, version = version + 1, updated_at = ?, last_mutation_token = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ? AND status = 'prepared'",
        ).bind(input.target.id, ctx.now, ctx.attempt, input.draftId, unitId, draftRoot.expectedVersion),
      );
      stmts.push(
        env.DB.prepare(
          INSERT_LINK +
            "a.draft_id = ? AND NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.attachment_id = a.id AND l.entity_type = ? AND l.entity_id = ? AND l.unlinked_at IS NULL)",
        ).bind(
          crypto.randomUUID(), unitId, input.target.type, input.target.id, actorUserId,
          ctx.now, ctx.now, actorUserId, unitId, input.draftId, input.target.type, input.target.id,
        ),
      );
    }
    for (const id of ids) {
      stmts.push(
        env.DB.prepare(
          INSERT_LINK +
            "a.id = ? AND NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.attachment_id = a.id AND l.entity_type = ? AND l.entity_id = ? AND l.unlinked_at IS NULL)",
        ).bind(
          crypto.randomUUID(), unitId, input.target.type, input.target.id, actorUserId,
          ctx.now, ctx.now, actorUserId, unitId, id, input.target.type, input.target.id,
        ),
      );
    }
    return stmts;
  };

  return { root: draftRoot, conditions, duplicateOn, statements };
}
