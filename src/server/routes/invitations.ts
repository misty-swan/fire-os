import { Invitation, roleCodes } from "../../shared/contracts/auth";
import { authServiceFor } from "../auth/adapter";
import { authorize, type PermissionCode, type ResourceRef } from "../auth/authorize";
import { emailHash, tokenHash } from "../auth/config";
import { resolvePrincipal, type AuthzPrincipal } from "../auth/principal";
import { newInvitationToken, userIdForAuth } from "../auth/tokens";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";

/** 権限が無ければ403。理由コードだけを details に出す（対象の存在は明かさない） */
export function requirePermission(p: AuthzPrincipal, action: PermissionCode, target: ResourceRef): void {
  const a = authorize(p, action, target);
  if (!a.allowed) throw new HttpError("FORBIDDEN", undefined, [{ field: "permission", reason: a.reason }]);
}

const INVITATION_JSON =
  "SELECT json_object('id', id, 'version', version, 'memberId', member_id, 'status', status, 'expiresAt', expires_at, 'token', NULL) FROM invitations WHERE id = ?";

/** API-33/34/35: 招待の発行・取消・受領 */
export function registerInvitationRoutes(app: ApiApp): void {
  // --- API-33 発行（再発行は旧い有効な招待を同じbatchで取消す） ---
  defineRoute(app, "API-33", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-33");
    requirePermission(p, "PER-07", { unitId: p.unitId, type: "member", id: body.memberId });

    const member = await c.env.DB.prepare("SELECT version, status, user_id FROM members WHERE id = ? AND unit_id = ?")
      .bind(body.memberId, p.unitId).first<{ version: number; status: string; user_id: string | null }>();
    if (!member) throw new HttpError("NOT_FOUND"); // 別unitも同じ応答
    if (member.user_id) throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "memberId", reason: "member_already_linked" }]);
    if (member.status !== "active") throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "memberId", reason: "member_not_active" }]);

    const token = newInvitationToken();
    const invitationId = crypto.randomUUID();
    const newEmailHash = await emailHash(body.email);
    const newTokenHash = await tokenHash(token);
    const result = await executeMutation(c.env, p, {
      operationCode: "invitation.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/invitations", body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{ table: "members", id: body.memberId, expectedVersion: member.version, allowedStates: { column: "status", values: ["active"] } }],
      conditions: [
        { existsSql: "SELECT 1 FROM members WHERE id = ? AND unit_id = ? AND user_id IS NULL", binds: [body.memberId, p.unitId], failCode: "INVALID_TRANSITION" },
      ],
      duplicateOn: ["index:uq_invitations_pending_member", "invitations.token_hash"],
      statements: (ctx) => {
        const expiresAt = new Date(new Date(ctx.now).getTime() + body.expiresInHours * 3600_000).toISOString();
        return [
          c.env.DB.prepare(
            "UPDATE invitations SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'reissued', version = version + 1, updated_at = ?, last_mutation_token = ? " +
              "WHERE member_id = ? AND unit_id = ? AND status = 'pending'",
          ).bind(ctx.now, ctx.now, ctx.attempt, body.memberId, p.unitId),
          c.env.DB.prepare(
            "INSERT INTO invitations (id, unit_id, member_id, kind, email_hash, token_hash, status, expires_at, intended_authz, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
              "VALUES (?, ?, ?, 'invite', ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 'human')",
          ).bind(
            invitationId, p.unitId, body.memberId, newEmailHash, newTokenHash, expiresAt,
            JSON.stringify({ roleCodes: ["member"] }), ctx.attempt, ctx.now, ctx.now, p.userId,
          ),
          c.env.DB.prepare(
            "UPDATE members SET version = version + 1, last_mutation_token = ?, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ? AND user_id IS NULL AND status = 'active'",
          ).bind(ctx.attempt, ctx.now, body.memberId, p.unitId, member.version),
        ];
      },
      audit: { action: "invitation.create", entityType: "invitation", entityId: invitationId, metadata: { memberId: body.memberId, kind: "invite" } },
      event: { entityType: "invitation", entityId: invitationId, entityVersion: 1, eventType: "invitation.created", payload: { memberId: body.memberId } },
      response: { status: 201, sql: INVITATION_JSON, binds: [invitationId], decode: (j) => Invitation.parse(j) },
    });
    // 生tokenはこの応答の一回だけ。同じ鍵の再送（replayed）ではtokenを再表示しない（DBに保存した応答にも含めない）
    return ok(c, { ...result.data, token: result.replayed ? null : token }, {}, 201);
  });

  // --- API-34 取消 ---
  defineRoute(app, "API-34", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-34");
    requirePermission(p, "PER-07", { unitId: p.unitId, type: "invitation", id: params.id });
    const result = await executeMutation(c.env, p, {
      operationCode: "invitation.cancel",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/invitations/${params.id}/cancel`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{ table: "invitations", id: params.id, expectedVersion: body.version, allowedStates: { column: "status", values: ["pending"] } }],
      statements: (ctx) => [
        c.env.DB.prepare(
          "UPDATE invitations SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, version = version + 1, updated_at = ?, last_mutation_token = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ? AND status = 'pending'",
        ).bind(ctx.now, body.reason, ctx.now, ctx.attempt, params.id, p.unitId, body.version),
      ],
      // 取消理由の本文は監査に複製しない（invitationsの行に持つ）
      audit: { action: "invitation.cancel", entityType: "invitation", entityId: params.id },
      event: { entityType: "invitation", entityId: params.id, entityVersion: body.version + 1, eventType: "invitation.cancelled" },
      response: { status: 200, sql: INVITATION_JSON, binds: [params.id], decode: (j) => Invitation.parse(j) },
    });
    return ok(c, result.data);
  });

  // --- API-35 受領（実行主体そのものをこのbatchで作る：users作成＋団員リンク＋招待消費＋役割付与） ---
  defineRoute(app, "API-35", async (c) => {
    const identity = await authServiceFor(c.env).session(c.req.raw);
    if (!identity) throw new HttpError("UNAUTHENTICATED", undefined, [{ field: "session", reason: "no_session" }]);
    const { body, headers } = await parseApiRequest(c, "API-35");
    // 自己申告のidentityは、セッションが確認したidentityと一致しなければ拒否
    if (body.verifiedAuthIdentity !== identity.authId) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "verifiedAuthIdentity", reason: "session_mismatch" }]);
    }
    const nowIso = new Date().toISOString();
    const inv = await c.env.DB.prepare(
      "SELECT id, unit_id, member_id, kind, email_hash, status, expires_at, intended_authz, version, created_by FROM invitations WHERE token_hash = ?",
    ).bind(await tokenHash(body.token)).first<{
      id: string; unit_id: string; member_id: string; kind: string; email_hash: string; status: string;
      expires_at: string; intended_authz: string; version: number; created_by: string | null;
    }>();
    if (!inv) throw new HttpError("NOT_FOUND");
    // 招待先のメールと、所有確認済みの認証identityのメールが一致すること（別人は理由を知らされない）
    if (inv.email_hash !== (await emailHash(identity.email))) {
      throw new HttpError("FORBIDDEN", undefined, [{ field: "token", reason: "identity_mismatch" }]);
    }
    const userId = await userIdForAuth(identity.authId);
    const key = headers["idempotency-key"];
    // 同じ鍵の再送は、再実行せず保存済みの結果を返す（下のexecuteMutationが判定）。状態の事前検査は初回だけ
    const replay = await c.env.DB.prepare(
      "SELECT 1 FROM idempotency_records WHERE actor_user_id = ? AND operation_code = 'invitation.accept' AND idempotency_key = ?",
    ).bind(userId, key).first();
    const member = await c.env.DB.prepare("SELECT version, status, user_id FROM members WHERE id = ? AND unit_id = ?")
      .bind(inv.member_id, inv.unit_id).first<{ version: number; status: string; user_id: string | null }>();
    if (!replay) {
      if (inv.status === "consumed") throw new HttpError("VERSION_CONFLICT", undefined, [{ field: "token", reason: "already_used" }]);
      if (inv.status === "cancelled") throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "token", reason: "cancelled" }]);
      if (inv.expires_at <= nowIso) throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "token", reason: "expired" }]);
      if (!member || member.user_id) throw new HttpError("DUPLICATE", undefined, [{ field: "token", reason: "member_already_linked" }]);
      if (member.status !== "active") throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "token", reason: "member_not_active" }]);
      const existing = await c.env.DB.prepare("SELECT 1 FROM users WHERE auth_id = ?").bind(identity.authId).first();
      if (existing) throw new HttpError("DUPLICATE", undefined, [{ field: "verifiedAuthIdentity", reason: "identity_already_linked" }]);
    }
    const intended = (JSON.parse(inv.intended_authz) as { roleCodes?: string[] }).roleCodes ?? [];
    const roles = intended.filter((r): r is (typeof roleCodes)[number] => (roleCodes as readonly string[]).includes(r));
    if (roles.length === 0) throw new HttpError("INTERNAL_ERROR");
    const memberVersion = member?.version ?? 0;

    const principal = { userId, memberId: inv.member_id, unitId: inv.unit_id, authzVersion: 1 };
    const result = await executeMutation(c.env, principal, {
      operationCode: "invitation.accept",
      key,
      requestHash: await canonicalRequestHash({ method: "POST", path: "/invitations/accept", body: { token: body.token, verifiedAuthIdentity: body.verifiedAuthIdentity } }),
      expectedAuthzVersion: 1,
      roots: [
        { table: "invitations", id: inv.id, expectedVersion: inv.version, allowedStates: { column: "status", values: ["pending"] } },
        { table: "members", id: inv.member_id, expectedVersion: memberVersion, allowedStates: { column: "status", values: ["active"] } },
      ],
      // 業務の利用者(users)の作成と団員へのリンクは、認可版の検査より前に同じbatchで行う
      prelude: (ctx) => [
        c.env.DB.prepare("INSERT INTO users (id, auth_id, status, authz_version, created_at, updated_at) VALUES (?, ?, 'active', 1, ?, ?)")
          .bind(userId, identity.authId, ctx.now, ctx.now),
        c.env.DB.prepare(
          "UPDATE members SET user_id = ?, version = version + 1, last_mutation_token = ?, updated_at = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ? AND user_id IS NULL AND status = 'active'",
        ).bind(userId, ctx.attempt, ctx.now, inv.member_id, inv.unit_id, memberVersion),
      ],
      conditions: [
        {
          existsSql: "SELECT 1 FROM invitations WHERE id = ? AND status = 'pending' AND expires_at > ? AND email_hash = ? AND token_hash = ?",
          binds: [inv.id, nowIso, inv.email_hash, await tokenHash(body.token)],
          failCode: "INVALID_TRANSITION",
        },
        { existsSql: "SELECT 1 FROM auth_users WHERE id = ? AND email = ?", binds: [identity.authId, identity.email], failCode: "VERSION_CONFLICT" },
      ],
      duplicateOn: ["users.auth_id", "users.id", "members.user_id"],
      statements: (ctx) => [
        c.env.DB.prepare(
          "UPDATE invitations SET status = 'consumed', consumed_at = ?, consumed_by_user_id = ?, version = version + 1, updated_at = ?, last_mutation_token = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ? AND status = 'pending'",
        ).bind(ctx.now, userId, ctx.now, ctx.attempt, inv.id, inv.unit_id, inv.version),
        // 役割は招待に記された値だけ（受領者の自己申告では決まらない）。初期管理者は自分自身が付与者になる
        ...roles.map((code) =>
          c.env.DB.prepare(
            "INSERT INTO member_roles (id, unit_id, member_id, role_id, granted_by, created_at, updated_at, created_by, actor_kind) " +
              "SELECT ?, ?, ?, id, ?, ?, ?, ?, 'human' FROM roles WHERE code = ?",
          ).bind(crypto.randomUUID(), inv.unit_id, inv.member_id, inv.created_by ?? userId, ctx.now, ctx.now, userId, code),
        ),
      ],
      audit: { action: "invitation.accept", entityType: "invitation", entityId: inv.id, metadata: { memberId: inv.member_id, kind: inv.kind } },
      event: { entityType: "invitation", entityId: inv.id, entityVersion: inv.version + 1, eventType: "invitation.accepted", payload: { memberId: inv.member_id } },
      response: {
        status: 200,
        sql: "SELECT json_object('memberId', ?, 'linked', json('true'), 'roleCodes', json(?), 'authzVersion', (SELECT authz_version FROM users WHERE id = ?))",
        binds: [inv.member_id, JSON.stringify(roles), userId],
        decode: (j) => j as never,
      },
    });
    return ok(c, result.data);
  });
}
