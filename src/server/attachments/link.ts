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
  /**
   * リンク先の行が同じbatchのINSERTで作られる場合（点検: docs/05 AttachmentTargetのinspection）。
   * 対象の存在条件を付けず、「行が作られたこと」はMutationSpec.createdの検査が担保する。
   */
  targetCreatedInBatch?: boolean;
}

/** リンク先として存在確認できる業務表（PH2時点。inspection等は対象行を同batchで作るため対象外） */
export const LINK_ENTITY_TABLES: Record<string, string> = {
  facility: "facilities",
  vehicle: "vehicles",
  equipment: "equipment",
};

/** リンクで機微(sensitive)を基本とする対象（docs/10 §3。点検・異常は現場写真を含み得る） */
export const SENSITIVE_LINK_TARGETS = new Set(["inspection", "issue"]);

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

/** リンクINSERTの共通文。SELECT〜WHEREで二重INSERTを防ぐ。allowSensitive=falseはsensitiveを除外する（docs/10 §3） */
export const insertLinkSql = (allowSensitive: boolean) =>
  "INSERT INTO attachment_links (id, unit_id, attachment_id, entity_type, entity_id, linked_by, created_at, updated_at, created_by, actor_kind) " +
  "SELECT ?, ?, a.id, ?, ?, ?, ?, ?, ?, 'human' FROM attachments a WHERE a.unit_id = ? AND a.status = 'ready' " +
  (allowSensitive ? "" : "AND a.classification <> 'sensitive' ") + "AND ";

export async function planAttachmentLinks(
  env: Pick<AppEnv, "DB">,
  unitId: string,
  actorUserId: string,
  input: AttachmentLinkInput,
): Promise<LinkPlan> {
  const sensitiveTarget = SENSITIVE_LINK_TARGETS.has(input.target.type);
  if (!input.targetCreatedInBatch && !LINK_ENTITY_TABLES[input.target.type]) {
    throw new Error(`planAttachmentLinks: リンク先の種別が未対応です: ${input.target.type}`);
  }
  const ids = [...(input.attachmentIds ?? [])];
  if (!input.draftId && ids.length === 0) throw new Error("planAttachmentLinks: draftId か attachmentIds のどちらかが必要です");
  const duplicateOn = ["index:uq_attachment_links_active"] as const;
  const conditions: ExtraCondition[] = [];

  // 予約の消費は版ガードで一回に限る。現在の版を読んでおく（作成直後は1。消費は最初で最後）
  let draftRoot: RootGuard | undefined;
  if (input.draftId) {
    const draft = await env.DB.prepare("SELECT id, unit_id, version, status, expires_at, intended_entity_type FROM attachment_drafts WHERE id = ?")
      .bind(input.draftId)
      .first<{ id: string; unit_id: string; version: number; status: string; expires_at: string; intended_entity_type: string }>();
    if (!draft || draft.unit_id !== unitId) throw new HttpError("NOT_FOUND");
    if (draft.status !== "prepared") {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "attachmentDraftId", reason: "draft_already_consumed" }]);
    }
    if (draft.expires_at <= new Date().toISOString()) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "attachmentDraftId", reason: "draft_expired" }]);
    }
    // 予約の意図（intended_entity_type）と実際のリンク先の一致（docs/05「最終link先を検査」）
    if (draft.intended_entity_type !== input.target.type) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "attachmentDraftId", reason: "draft_intended_mismatch" }]);
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
  if (!input.targetCreatedInBatch) {
    const table = LINK_ENTITY_TABLES[input.target.type]!;
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
      // 点検・異常へのリンクはsensitiveを基本とするため、basicの引上げ対象にもする（docs/10 §3）
      existsSql: sensitiveTarget
        ? "SELECT 1 FROM attachments WHERE id = ? AND unit_id = ? AND status = 'ready'"
        : "SELECT 1 FROM attachments WHERE id = ? AND unit_id = ? AND status = 'ready' AND classification <> 'sensitive'",
      binds: [id, unitId],
      failCode: "ATTACHMENT_NOT_READY",
    });
  }

  const statements = (ctx: MutationContext): D1PreparedStatement[] => {
    const stmts: D1PreparedStatement[] = [];
    if (sensitiveTarget) {
      // 移動セマンティクス: sensitiveの対象へリンクするときは、同じ添付の他の有効リンクを先に外す
      // （写真の所在を1つの対象へ決定論化。jobの自動リンクで施設へ付いた写真を点検保存で移す等。docs/10 §3。
      //   自動リンクの移動のための無条件DELETEで、手動のunlink（tombstone）の規則は適用しない。
      //   条件（ready検査）が同じbatchの前提で通っているため、INSERTが0行のままリンクだけ消えることはない）
      if (input.draftId) {
        stmts.push(
          env.DB.prepare(
            "DELETE FROM attachment_links WHERE unit_id = ? AND unlinked_at IS NULL AND attachment_id IN (SELECT id FROM attachments WHERE draft_id = ? AND unit_id = ?)",
          ).bind(unitId, input.draftId, unitId),
        );
      }
      for (const id of ids) {
        stmts.push(
          env.DB.prepare("DELETE FROM attachment_links WHERE attachment_id = ? AND unit_id = ? AND unlinked_at IS NULL").bind(id, unitId),
        );
      }
      // basicの添付をsensitiveへ引き上げる（引下げはしない。docs/10 §4と矛盾しない）
      if (input.draftId) {
        stmts.push(
          env.DB.prepare(
            "UPDATE attachments SET classification = 'sensitive', updated_at = ? WHERE draft_id = ? AND unit_id = ? AND classification = 'basic'",
          ).bind(ctx.now, input.draftId, unitId),
        );
      }
      for (const id of ids) {
        stmts.push(
          env.DB.prepare(
            "UPDATE attachments SET classification = 'sensitive', updated_at = ? WHERE id = ? AND unit_id = ? AND classification = 'basic'",
          ).bind(ctx.now, id, unitId),
        );
      }
    }
    if (input.draftId && draftRoot) {
      stmts.push(
        env.DB.prepare(
          "UPDATE attachment_drafts SET status = 'consumed', consumed_entity_id = ?, version = version + 1, updated_at = ?, last_mutation_token = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ? AND status = 'prepared'",
        ).bind(input.target.id, ctx.now, ctx.attempt, input.draftId, unitId, draftRoot.expectedVersion),
      );
      stmts.push(
        env.DB.prepare(
          insertLinkSql(sensitiveTarget) +
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
          insertLinkSql(sensitiveTarget) +
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
