import { RevocationResult } from "../../shared/contracts/auth";
import { revocationState, revokeJobStatement, revokeSessionsNow } from "../auth/disable";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { requirePermission } from "./invitations";

/**
 * API-38: 全セッション失効。管理者（PER-07）または本人。認可版を増やして進行中の更新を無効にし、
 * 認証側の全セッションを削除する。失敗したら再試行jobが残り、結果は pending（業務側は旧セッションを既に拒否）。
 */
export function registerRevocationRoutes(app: ApiApp): void {
  defineRoute(app, "API-38", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-38");
    const target = await c.env.DB.prepare(
      "SELECT u.id AS user_id, u.auth_id, m.id AS member_id, m.version FROM users u JOIN members m ON m.user_id = u.id WHERE u.id = ? AND m.unit_id = ?",
    ).bind(params.id, p.unitId).first<{ user_id: string; auth_id: string; member_id: string; version: number }>();
    if (!target) throw new HttpError("NOT_FOUND"); // 別unitも同じ
    if (params.id !== p.userId) requirePermission(p, "PER-07", { unitId: p.unitId, type: "member", id: target.member_id });

    const authzAfter = body.expectedAuthzVersion + 1;
    const job = revokeJobStatement(c, p.unitId, p.userId, target.user_id, authzAfter);
    const result = await executeMutation(c.env, p, {
      operationCode: "user.sessions.revoke",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/users/${params.id}/session-revocations`, target: params.id, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{ table: "members", id: target.member_id, expectedVersion: target.version }],
      conditions: [
        { existsSql: "SELECT 1 FROM users WHERE id = ? AND authz_version = ?", binds: [params.id, body.expectedAuthzVersion], failCode: "VERSION_CONFLICT" },
      ],
      statements: (ctx) => [
        c.env.DB.prepare("UPDATE members SET version = version + 1, last_mutation_token = ?, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ?")
          .bind(ctx.attempt, ctx.now, target.member_id, p.unitId, target.version),
        c.env.DB.prepare("UPDATE users SET authz_version = authz_version + 1, session_revoked_before = ?, updated_at = ? WHERE id = ? AND authz_version = ?")
          .bind(ctx.now, ctx.now, params.id, body.expectedAuthzVersion),
        job,
      ],
      audit: { action: "user.sessions.revoke", entityType: "member", entityId: target.member_id, metadata: { authzVersion: authzAfter } },
      event: { entityType: "member", entityId: target.member_id, entityVersion: target.version + 1, eventType: "user.sessions.revoked", payload: { authzVersion: authzAfter } },
      response: {
        status: 200,
        sql: "SELECT json_object('userId', ?, 'authzVersion', (SELECT authz_version FROM users WHERE id = ?), 'sessionRevocation', 'pending')",
        binds: [params.id, params.id],
        decode: (j) => RevocationResult.parse(j),
      },
    });
    const sessionRevocation = result.replayed
      ? await revocationState(c, params.id, result.data.authzVersion)
      : await revokeSessionsNow(c, target.auth_id, params.id, result.data.authzVersion);
    return ok(c, { ...result.data, sessionRevocation });
  });
}
