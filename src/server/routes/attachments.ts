import { authorize } from "../auth/authorize";
import { resolvePrincipal } from "../auth/principal";
import { isAnnouncementVisible } from "./announcements";
import { isDocumentVisible } from "../documents/authorized";
import { HttpError, defineRoute, parseApiRequest, type ApiApp } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { enqueueJobStatement } from "../jobs/store";
import { loadAttachment } from "../attachments/upload";
import { requirePermission } from "./invitations";

/**
 * 添付の取得・unlink・削除（T017、docs/07 §3.6〜3.7）。
 * 取得は Workers が毎回最新のリンク/状態/認可を確認してから private R2 をstream配信する（署名GETへredirectしない）。
 */
export function registerAttachmentRoutes(app: ApiApp): void {
  // --- API-27 取得（binary）。ready かつ閲覧できる有効リンクが1つ以上あるときだけ配信する ---
  defineRoute(app, "API-27", async (c) => {
    const p = await resolvePrincipal(c);
    const { params } = await parseApiRequest(c, "API-27");
    const att = await loadAttachment(c.env, params.id, p.unitId);
    if (!att) throw new HttpError("NOT_FOUND");

    // 状態: ready だけ配信。検査待ちは未完成であることを返し、拒否・削除済み・期限切れは存在を明かさない
    if (att.status === "pending_upload" || att.status === "uploaded" || att.status === "checking") {
      throw new HttpError("ATTACHMENT_NOT_READY");
    }
    if (att.status !== "ready") throw new HttpError("NOT_FOUND");
    if (!att.ready_key || !att.sha256) throw new HttpError("INTERNAL_ERROR");

    // ACLの再検査: 有効なリンク（同一unit・未unlink）が1つ以上あり、その対象を閲覧できること。
    // unlink（権限の引下げ・削除）の直後の新規要求を拒否する（既に取得済みのデータ・開始済みstreamは回収できない。docs/07 §3.6）
    // 文書（entity_type=document）のリンクは、検索・引用と同じ文書可視性の正本
    // （src/server/documents/authorized.ts。deny優先ACL＋撤回除外）で再検査する。撤回・ACL失効は
    // 索引やlinkの削除を待たず即404になる（docs/06 §5.5「引用原文取得でも現ACLを検査」。docs/10 §4）
    const links = await c.env.DB.prepare(
      "SELECT entity_type, entity_id FROM attachment_links WHERE attachment_id = ? AND unit_id = ? AND unlinked_at IS NULL",
    ).bind(att.id, att.unit_id).all<{ entity_type: string; entity_id: string }>();
    let visible = false;
    for (const l of links.results) {
      if (l.entity_type === "document") {
        if (await isDocumentVisible(c.env, p, l.entity_id)) { visible = true; break; }
      } else if (l.entity_type === "announcement") {
        // お知らせの添付はAPI-24と同じ可視規則（対象者・下書きは管理者のみ。T091-S7）
        if (await isAnnouncementVisible(c.env, p, l.entity_id)) { visible = true; break; }
      } else if (authorize(p, "PER-01", { unitId: att.unit_id, type: l.entity_type, id: l.entity_id }).allowed) {
        visible = true; break;
      }
    }
    if (links.results.length === 0 || !visible) throw new HttpError("NOT_FOUND"); // 対象の存在と閲覧可否を分けない

    const obj = await c.env.FILES.get(att.ready_key);
    if (!obj) {
      // readyの実体が無いのは復旧が必要な不整合。取得できない事実だけを返す
      console.error(JSON.stringify({ event: "ready_object_missing", attachmentId: att.id, key: att.ready_key }));
      throw new HttpError("INTERNAL_ERROR");
    }
    // 機微内容を共有キャッシュへ残さない。偽装を防ぐため内容の型を明示する
    const headers: Record<string, string> = {
      "content-type": att.content_type,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    };
    // 危険形式(PDF/CSV)はダウンロードさせる（ブラウザで実行/表示しない）
    if (att.content_type === "application/pdf" || att.content_type === "text/csv") {
      const ext = att.content_type === "text/csv" ? "csv" : "pdf";
      headers["content-disposition"] = `attachment; filename="attachment-${att.id}.${ext}"`;
    }
    return new Response(obj.body, { headers });
  });

  // --- API-85 削除（有効リンクがあるときは422。D1 tombstone→遅延jobでR2削除） ---
  defineRoute(app, "API-85", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-85");
    const att = await loadAttachment(c.env, params.id, p.unitId);
    if (!att) throw new HttpError("NOT_FOUND");
    requirePermission(p, "PER-04", { unitId: att.unit_id, type: "attachment", id: att.id, ownerMemberId: att.owner_member_id });
    const cleanupJob = enqueueJobStatement(c.env, {
      unitId: att.unit_id, kind: "attachment.cleanup", sourceType: "attachment", sourceId: att.id,
      sourceVersion: body.version + 1, configVersion: "v1", requestedBy: p.userId,
    });
    await executeMutation(c.env, p, {
      operationCode: "attachment.delete",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "DELETE", path: `/attachments/${att.id}`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{
        table: "attachments", id: att.id, expectedVersion: body.version,
        allowedStates: { column: "status", values: ["ready", "rejected", "expired", "uploaded", "checking"] },
      }],
      conditions: [
        // 有効リンクがある削除は承認unlinkの後にする（docs/07 §3.7）
        {
          existsSql:
            "SELECT 1 FROM attachments a WHERE a.id = ? AND a.unit_id = ? AND NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.attachment_id = a.id AND l.unlinked_at IS NULL)",
          binds: [att.id, att.unit_id],
          failCode: "INVALID_TRANSITION",
        },
      ],
      statements: (ctx) => [
        c.env.DB.prepare(
          "UPDATE attachments SET status = 'deleting', version = version + 1, updated_at = ?, last_mutation_token = ? WHERE id = ? AND unit_id = ? AND version = ?",
        ).bind(ctx.now, ctx.attempt, att.id, att.unit_id, body.version),
        c.env.DB.prepare(
          "INSERT INTO attachment_events (id, unit_id, attachment_id, action, details, actor_user_id, actor_kind, created_at) VALUES (?, ?, ?, 'delete.requested', ?, ?, 'human', ?)",
        ).bind(crypto.randomUUID(), att.unit_id, att.id, JSON.stringify({}), p.userId, ctx.now),
        // R2削除は遅延job（D1 tombstone の後に実体を消す。jobが失敗してもtombstoneのまま再試行される）
        cleanupJob.statement,
      ],
      audit: { action: "attachment.delete", entityType: "attachment", entityId: att.id },
      event: { entityType: "attachment", entityId: att.id, entityVersion: body.version + 1, eventType: "attachment.delete_requested" },
      response: {
        status: 200,
        sql: "SELECT json_object('id', id, 'status', status, 'version', version) FROM attachments WHERE id = ?",
        binds: [att.id],
        decode: (j) => j as { id: string; status: string; version: number },
      },
    });
    // 起動の合図（失敗してもCronが回収する）
    try {
      await c.env.JOBS_QUEUE.send({ jobId: cleanupJob.id });
    } catch (err) {
      console.error(JSON.stringify({ event: "job_queue_send_failed", jobId: cleanupJob.id, error: String(err) }));
    }
    // 204はJSON envelopeの外（docs/05 §1）。冪等の記録には上の応答が保存され、再送も204になる
    return c.body(null, 204);
  });

  // --- API-101 unlink（元対象の編集権。linkはtombstoneとして残す） ---
  defineRoute(app, "API-101", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-101");
    const link = await c.env.DB.prepare("SELECT * FROM attachment_links WHERE id = ? AND unit_id = ? AND attachment_id = ?")
      .bind(params.linkId, p.unitId, params.id)
      .first<{ id: string; unit_id: string; attachment_id: string; entity_type: string; entity_id: string; version: number; unlinked_at: string | null }>();
    if (!link) throw new HttpError("NOT_FOUND");
    // リンク先の業務対象を編集できる者が外せる（docs/10 のPER-03）
    requirePermission(p, "PER-03", { unitId: link.unit_id, type: link.entity_type, id: link.entity_id });
    await executeMutation(c.env, p, {
      operationCode: "attachment.link.remove",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "DELETE", path: `/attachments/${params.id}/links/${params.linkId}`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{ table: "attachment_links", id: link.id, expectedVersion: body.version }],
      conditions: [
        // unlink済みへの再実行は版は一致しても0行更新になる。書込前の状態で422にする（docs/07 §3.6の遷移）
        {
          existsSql: "SELECT 1 FROM attachment_links WHERE id = ? AND unit_id = ? AND unlinked_at IS NULL",
          binds: [link.id, link.unit_id],
          failCode: "INVALID_TRANSITION",
        },
      ],
      statements: (ctx) => [
        c.env.DB.prepare(
          "UPDATE attachment_links SET unlinked_at = ?, unlink_reason = ?, version = version + 1, updated_at = ?, last_mutation_token = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ? AND unlinked_at IS NULL",
        ).bind(ctx.now, body.reason, ctx.now, ctx.attempt, link.id, link.unit_id, body.version),
        c.env.DB.prepare(
          "INSERT INTO attachment_events (id, unit_id, attachment_id, action, details, actor_user_id, actor_kind, created_at) VALUES (?, ?, ?, 'link.removed', ?, ?, 'human', ?)",
        ).bind(crypto.randomUUID(), link.unit_id, link.attachment_id, JSON.stringify({ linkId: link.id, entityType: link.entity_type }), p.userId, ctx.now),
      ],
      audit: { action: "attachment.link.remove", entityType: "attachment", entityId: link.attachment_id, metadata: { linkId: link.id, target: link.entity_type } },
      event: { entityType: "attachment", entityId: link.attachment_id, entityVersion: body.version + 1, eventType: "attachment.link_removed", payload: { linkId: link.id } },
      response: {
        status: 200,
        sql: "SELECT json_object('id', id, 'unlinked', json('true')) FROM attachment_links WHERE id = ?",
        binds: [link.id],
        decode: (j) => j as { id: string; unlinked: boolean },
      },
    });
    return c.body(null, 204);
  });
}
