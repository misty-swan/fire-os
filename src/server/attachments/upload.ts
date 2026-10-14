import { Attachment, AttachmentDraft, UploadAttempt, UploadIntent } from "../../shared/contracts/assets";
import { Job } from "../../shared/contracts/common";
import type { AppEnv } from "../env";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { enqueueJobStatement } from "../jobs/store";
import "../jobs/handlers/attachment"; // 検査job handlerの登録（Cron/Queueと同じ登録点）
import { requirePermission } from "../routes/invitations";
import { resolvePrincipal } from "../auth/principal";
import {
  ATTACHMENT_LIMITS,
  CONTENT_TYPE_LIMITS,
  SENSITIVE_TARGET_TYPES,
  newUploadToken,
  readBodyCapped,
  sha256OfBytes,
  stagingKeyFor,
  uploadTokenHash,
} from "./sizes";

/**
 * intent対象として存在確認できる業務表（PH2時点）。表がまだ無い種別（activity等）はPH3以降に追加する。
 * 多態の点検(inspection)・issues等は、その表ができるタスクでここへ追加する。
 */
export const ATTACHMENT_TARGET_TABLES: Record<string, string> = {
  facility: "facilities",
  vehicle: "vehicles",
  equipment: "equipment",
};

interface AttachmentRow {
  id: string; unit_id: string; owner_user_id: string; owner_member_id: string; status: string;
  content_type: string; byte_size: number; expires_at: string; upload_token_hash: string;
  selected_upload_attempt_id: string | null; version: number; staging_key: string | null;
  ready_key: string | null; sha256: string | null; classification: string;
}

export async function loadAttachment(env: Pick<AppEnv, "DB">, id: string, unitId: string): Promise<AttachmentRow | null> {
  const row = await env.DB.prepare("SELECT * FROM attachments WHERE id = ?").bind(id).first<AttachmentRow>();
  return row && row.unit_id === unitId ? row : null;
}

/** 期限切れのpending_uploadをexpiredへ動かす（docs/11の添付遷移「期限切れ→expired」） */
async function expireIfStale(env: Pick<AppEnv, "DB">, att: AttachmentRow): Promise<void> {
  if (att.status === "pending_upload" && att.expires_at <= new Date().toISOString()) {
    await env.DB.prepare(
      "UPDATE attachments SET status = 'expired', version = version + 1, updated_at = ? WHERE id = ? AND unit_id = ? AND status = 'pending_upload'",
    ).bind(new Date().toISOString(), att.id, att.unit_id).run();
    throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "attachment", reason: "upload_window_expired" }]);
  }
}

/** T015: 予約・intent・転送・完了確定のAPI群。取得/リンク/削除はT017（routes/attachments.ts） */
export function registerUploadRoutes(app: ApiApp): void {
  // --- API-98 予約（親がまだ無い添付を先に預けられるようにする。15分案） ---
  defineRoute(app, "API-98", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-98");
    if (body.intendedEntityType === "attachment_draft") {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "intendedEntityType", reason: "unsupported_entity_type" }]);
    }
    // 親が指定されているときは、親の存在・所属・作成権を確かめる（存在しない親への予約を作らない）
    if (body.parentType && body.parentId) {
      const table = ATTACHMENT_TARGET_TABLES[body.parentType];
      if (!table) throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "parentType", reason: "unsupported_entity_type" }]);
      const exists = await c.env.DB.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND unit_id = ?`).bind(body.parentId, p.unitId).first();
      if (!exists) throw new HttpError("NOT_FOUND");
      requirePermission(p, "PER-04", { unitId: p.unitId, type: body.parentType, id: body.parentId });
    } else {
      // 親なし（これから作る業務への添付）。報告は全役割に許す（PER-04の本人報告）
      requirePermission(p, "PER-04", { unitId: p.unitId, type: "member", id: p.memberId, ownerMemberId: p.memberId });
    }
    const id = crypto.randomUUID();
    const result = await executeMutation(c.env, p, {
      operationCode: "attachment.draft.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/attachment-drafts", body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [],
      created: [{ table: "attachment_drafts", id }],
      statements: (ctx) => [
        c.env.DB.prepare(
          "INSERT INTO attachment_drafts (id, unit_id, intended_entity_type, parent_type, parent_id, owner_user_id, status, expires_at, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, 'human')",
        ).bind(
          id, p.unitId, body.intendedEntityType, body.parentType ?? null, body.parentId ?? null, p.userId,
          new Date(new Date(ctx.now).getTime() + ATTACHMENT_LIMITS.intentTtlMs).toISOString(),
          ctx.attempt, ctx.now, ctx.now, p.userId,
        ),
      ],
      audit: { action: "attachment.draft.create", entityType: "attachment_draft", entityId: id, metadata: { intended: body.intendedEntityType } },
      event: { entityType: "attachment_draft", entityId: id, entityVersion: 1, eventType: "attachment_draft.created", payload: { intended: body.intendedEntityType } },
      response: {
        status: 201,
        sql: "SELECT json_object('id', id, 'version', version, 'expiresAt', expires_at) FROM attachment_drafts WHERE id = ?",
        binds: [id],
        decode: (j) => AttachmentDraft.parse(j),
      },
    });
    return ok(c, result.data, {}, 201);
  });

  // --- API-26 intent（添付本体の予約。形式・容量・対象を検査して転送tokenを1回だけ返す） ---
  defineRoute(app, "API-26", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-26");
    const limit = CONTENT_TYPE_LIMITS[body.contentType];
    if (!limit) throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "contentType", reason: "unsupported_content_type" }]);
    if (body.byteSize > limit.max) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "byteSize", reason: "byte_size_over_limit" }]);
    }

    const conditions: { existsSql: string; binds: unknown[]; failCode: "INVALID_TRANSITION" | "NOT_FOUND" }[] = [];
    if (body.target.type === "attachment_draft") {
      const draft = await c.env.DB.prepare("SELECT id, unit_id, owner_user_id, status, expires_at FROM attachment_drafts WHERE id = ?")
        .bind(body.target.id)
        .first<{ id: string; unit_id: string; owner_user_id: string; status: string; expires_at: string }>();
      if (!draft || draft.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
      if (draft.owner_user_id !== p.userId) throw new HttpError("FORBIDDEN"); // 予約は作った人だけが使える
      if (draft.status !== "prepared") {
        throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "target", reason: "draft_already_consumed" }]);
      }
      if (draft.expires_at <= new Date().toISOString()) {
        throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "target", reason: "draft_expired" }]);
      }
      conditions.push({
        existsSql: "SELECT 1 FROM attachment_drafts WHERE id = ? AND unit_id = ? AND status = 'prepared' AND expires_at > ?",
        binds: [draft.id, p.unitId, new Date().toISOString()],
        failCode: "INVALID_TRANSITION",
      });
    } else {
      const table = ATTACHMENT_TARGET_TABLES[body.target.type];
      if (!table) throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "target.type", reason: "unsupported_entity_type" }]);
      const exists = await c.env.DB.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND unit_id = ?`).bind(body.target.id, p.unitId).first();
      if (!exists) throw new HttpError("NOT_FOUND");
      requirePermission(p, "PER-04", { unitId: p.unitId, type: body.target.type, id: body.target.id });
      conditions.push({ existsSql: `SELECT 1 FROM ${table} WHERE id = ? AND unit_id = ?`, binds: [body.target.id, p.unitId], failCode: "NOT_FOUND" });
    }

    const id = crypto.randomUUID();
    const token = newUploadToken();
    const tokenHash = await uploadTokenHash(token);
    const classification = SENSITIVE_TARGET_TYPES.has(body.target.type) ? "sensitive" : "basic";
    const result = await executeMutation(c.env, p, {
      operationCode: "attachment.intent.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/attachments/upload-intents", body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [],
      created: [{ table: "attachments", id }],
      conditions,
      statements: (ctx) => [
        c.env.DB.prepare(
          "INSERT INTO attachments (id, unit_id, owner_user_id, owner_member_id, intent_target_type, intent_target_id, draft_id, content_type, byte_size, status, expires_at, classification, upload_token_hash, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_upload', ?, ?, ?, ?, ?, ?, ?, 'human')",
        ).bind(
          id, p.unitId, p.userId, p.memberId, body.target.type, body.target.id,
          body.target.type === "attachment_draft" ? body.target.id : null,
          body.contentType, body.byteSize,
          new Date(new Date(ctx.now).getTime() + ATTACHMENT_LIMITS.intentTtlMs).toISOString(),
          classification, tokenHash, ctx.attempt, ctx.now, ctx.now, p.userId,
        ),
      ],
      audit: { action: "attachment.intent.create", entityType: "attachment", entityId: id, metadata: { target: body.target.type, classification } },
      event: { entityType: "attachment", entityId: id, entityVersion: 1, eventType: "attachment.intent_created", payload: { target: body.target.type, classification } },
      // 生tokenは応答の一回だけ。同じ鍵の再送・冪等の保存応答には含めない（invitationsと同じ方針）
      response: {
        status: 201,
        sql: "SELECT json_object('id', id, 'version', version, 'uploadPath', '/api/v1/attachments/' || id || '/upload', 'uploadToken', NULL, 'expiresAt', expires_at) FROM attachments WHERE id = ?",
        binds: [id],
        decode: (j) => UploadIntent.parse(j),
      },
    });
    return ok(c, { ...result.data, uploadToken: result.replayed ? null : token }, {}, 201);
  });

  // --- API-83 転送（バイナリ。試行ごとに別の不変staging keyへ。実測容量で打ち切る） ---
  defineRoute(app, "API-83", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, headers } = await parseApiRequest(c, "API-83");
    const att = await loadAttachment(c.env, params.id, p.unitId);
    if (!att) throw new HttpError("NOT_FOUND");
    requirePermission(p, "PER-04", { unitId: att.unit_id, type: "attachment", id: att.id, ownerMemberId: att.owner_member_id });
    // tokenは契約で必須。生tokenは保存せずhashで照合する
    if ((await uploadTokenHash(headers["x-upload-token"])) !== att.upload_token_hash) throw new HttpError("FORBIDDEN");

    await expireIfStale(c.env, att);
    if (att.status !== "pending_upload") {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "attachment", reason: "upload_already_completed" }]);
    }
    const limit = CONTENT_TYPE_LIMITS[att.content_type]!.max;
    const read = await readBodyCapped(c.req.raw.body, limit);
    if ("over" in read) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "(body)", reason: "actual_size_over_limit" }]);
    }
    const digest = await sha256OfBytes(read.bytes);
    const attemptId = crypto.randomUUID();
    const key = stagingKeyFor(att.unit_id, att.id, attemptId);
    // R2に保存してからD1へ書く。D1が失敗したオブジェクトは孤児として回収対象になる（docs/07 §3.2）
    await c.env.FILES.put(key, read.bytes as BufferSource, { sha256: digest });
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ATTACHMENT_LIMITS.intentTtlMs).toISOString();
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO upload_attempts (id, unit_id, attachment_id, staging_key, byte_size, sha256, status, expires_at, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?, ?, ?, ?, 'human')",
        ).bind(attemptId, att.unit_id, att.id, key, read.size, digest, expiresAt, nowIso, nowIso, p.userId),
        c.env.DB.prepare(
          "INSERT INTO attachment_events (id, unit_id, attachment_id, action, details, actor_user_id, actor_kind, created_at) VALUES (?, ?, ?, 'upload.received', ?, ?, 'human', ?)",
        ).bind(crypto.randomUUID(), att.unit_id, att.id, JSON.stringify({ attemptId, size: read.size }), p.userId, nowIso),
      ]);
    } catch (err) {
      // 試行の台帳が残らない転送は無効（completionのHEAD検査で受理されない）。孤児は回収対象
      console.error(JSON.stringify({ event: "upload_attempt_record_failed", attachmentId: att.id, key, error: String(err) }));
      throw new HttpError("INTERNAL_ERROR");
    }
    return ok(c, UploadAttempt.parse({ id: attemptId, sha256: digest, size: read.size, version: 1 }));
  });

  // --- API-84 完了（試行を版ガードで選び、検査jobを同じbatchで登録する） ---
  defineRoute(app, "API-84", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-84");
    const att = await loadAttachment(c.env, params.id, p.unitId);
    if (!att) throw new HttpError("NOT_FOUND");
    requirePermission(p, "PER-04", { unitId: att.unit_id, type: "attachment", id: att.id, ownerMemberId: att.owner_member_id });
    await expireIfStale(c.env, att);
    if (att.status !== "pending_upload") {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "attachment", reason: "attempt_already_selected" }]);
    }
    const attempt = await c.env.DB.prepare("SELECT * FROM upload_attempts WHERE id = ? AND attachment_id = ? AND unit_id = ?")
      .bind(body.uploadAttemptId, att.id, att.unit_id)
      .first<{ id: string; staging_key: string; byte_size: number; sha256: string; status: string; expires_at: string }>();
    if (!attempt) throw new HttpError("NOT_FOUND");
    if (attempt.sha256 !== body.sha256) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "sha256", reason: "attempt_hash_mismatch" }]);
    }
    if (attempt.status !== "uploaded") {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "uploadAttemptId", reason: "attempt_already_selected" }]);
    }
    if (attempt.expires_at <= new Date().toISOString()) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "uploadAttemptId", reason: "attempt_expired" }]);
    }
    // 実体HEAD：転送したはずのオブジェクトが本当にR2にあり容量が一致することを確かめてから検査へ回す
    const head = await c.env.FILES.head(attempt.staging_key);
    if (!head || head.size !== attempt.byte_size) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "uploadAttemptId", reason: "attempt_object_missing" }]);
    }

    // 検査job（T016のhandlerが実行する）。業務の確定と同じbatchで登録し、確定後にQueueへ起動の合図を送る
    const job = enqueueJobStatement(c.env, {
      unitId: att.unit_id,
      kind: "attachment.inspect",
      sourceType: "attachment",
      sourceId: att.id,
      sourceVersion: body.version + 1,
      configVersion: "v1",
      requestedBy: p.userId,
    });
    const result = await executeMutation(c.env, p, {
      operationCode: "attachment.upload.complete",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/attachments/${att.id}/completion`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{ table: "attachments", id: att.id, expectedVersion: body.version, allowedStates: { column: "status", values: ["pending_upload"] } }],
      conditions: [
        { existsSql: "SELECT 1 FROM attachments WHERE id = ? AND unit_id = ? AND selected_upload_attempt_id IS NULL", binds: [att.id, att.unit_id], failCode: "INVALID_TRANSITION" },
        { existsSql: "SELECT 1 FROM upload_attempts WHERE id = ? AND attachment_id = ? AND status = 'uploaded'", binds: [attempt.id, att.id], failCode: "INVALID_TRANSITION" },
      ],
      statements: (ctx) => [
        c.env.DB.prepare(
          "UPDATE upload_attempts SET status = 'selected', version = version + 1, updated_at = ?, last_mutation_token = ? WHERE id = ? AND status = 'uploaded'",
        ).bind(ctx.now, ctx.attempt, attempt.id),
        c.env.DB.prepare(
          "UPDATE upload_attempts SET status = 'superseded', version = version + 1, updated_at = ?, last_mutation_token = ? WHERE attachment_id = ? AND id <> ? AND status = 'uploaded'",
        ).bind(ctx.now, ctx.attempt, att.id, attempt.id),
        c.env.DB.prepare(
          "UPDATE attachments SET status = 'uploaded', selected_upload_attempt_id = ?, staging_key = ?, sha256 = ?, version = version + 1, updated_at = ?, last_mutation_token = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ? AND status = 'pending_upload'",
        ).bind(attempt.id, attempt.staging_key, attempt.sha256, ctx.now, ctx.attempt, att.id, att.unit_id, body.version),
        c.env.DB.prepare(
          "INSERT INTO attachment_events (id, unit_id, attachment_id, action, details, actor_user_id, actor_kind, created_at) VALUES (?, ?, ?, 'upload.selected', ?, ?, 'human', ?)",
        ).bind(crypto.randomUUID(), att.unit_id, att.id, JSON.stringify({ attemptId: attempt.id }), p.userId, ctx.now),
        job.statement,
      ],
      audit: { action: "attachment.upload.complete", entityType: "attachment", entityId: att.id, metadata: { attemptId: attempt.id } },
      event: { entityType: "attachment", entityId: att.id, entityVersion: body.version + 1, eventType: "attachment.upload_completed", payload: { attemptId: attempt.id } },
      response: {
        status: 202,
        sql: "SELECT json_object(" +
          "'attachment', json_object('id', a.id, 'version', a.version, 'status', a.status, 'contentType', a.content_type, 'byteSize', a.byte_size, 'sha256', a.sha256, 'classification', a.classification, 'expiresAt', a.expires_at), " +
          "'job', json_object('id', j.id, 'status', j.status, 'attempts', j.attempts, 'errorCode', j.error_code, 'resultRef', j.result_ref)) " +
          "FROM attachments a LEFT JOIN jobs j ON j.source_type = 'attachment' AND j.source_id = a.id AND j.kind = 'attachment.inspect' " +
          "WHERE a.id = ? AND a.unit_id = ? ORDER BY j.created_at DESC LIMIT 1",
        binds: [att.id, att.unit_id],
        decode: (j) => {
          const v = j as { attachment: unknown; job: unknown };
          return { attachment: Attachment.parse(v.attachment), job: Job.parse(v.job) };
        },
      },
    });
    // 起動の合図（正本はD1。Cronも回収するので送信失敗は握りつぶす）
    try {
      await c.env.JOBS_QUEUE.send({ jobId: job.id });
    } catch (err) {
      console.error(JSON.stringify({ event: "job_queue_send_failed", jobId: job.id, error: String(err) }));
    }
    return ok(c, result.data, {}, 202);
  });
}
