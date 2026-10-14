import { MemberRoles, roleCodes } from "../../shared/contracts/auth";
import { notLastAdmin, wouldRemoveLastAdmin } from "../auth/disable";
import { resolvePrincipal, type AuthzPrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp, type ApiContext } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { requirePermission } from "./invitations";

/**
 * 担当(scope)を付けられる対象種別と、その対象に意味のある権限。**存在を確認できる種別だけ**を許す
 * （存在しない/別unitのIDに担当を付けない）。施設・資産・活動などは、その表ができるフェーズで追加する。
 */
export const SCOPE_ENTITIES: Record<string, { table: string; permissions: readonly string[] }> = {
  member: { table: "members", permissions: ["PER-06"] },
};

const MEMBER_ROLES_JSON =
  "SELECT json_object('memberId', m.id, 'version', m.version, 'authzVersion', u.authz_version, " +
  "'roleCodes', (SELECT json_group_array(r.code) FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.member_id = m.id AND mr.revoked_at IS NULL), " +
  "'scopes', (SELECT json_group_array(json_object('entityType', s.entity_type, 'entityId', s.entity_id, 'permissions', json(s.permissions), 'expiresAt', s.expires_at)) " +
  "FROM scope_assignments s WHERE s.member_id = m.id AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))) FROM members m JOIN users u ON u.id = m.user_id WHERE m.id = ?";

/** API-37: 役割と担当の全置換（版管理）。最後の管理者の降格・自己昇格は拒否し、成功したら対象の認可版を増やす */
export function registerRoleRoutes(app: ApiApp): void {
  defineRoute(app, "API-37", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-37");
    requirePermission(p, "PER-07", { unitId: p.unitId, type: "member", id: params.id });

    const target = await c.env.DB.prepare(
      "SELECT m.version, m.status, m.user_id, u.status AS user_status FROM members m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ? AND m.unit_id = ?",
    ).bind(params.id, p.unitId).first<{ version: number; status: string; user_id: string | null; user_status: string | null }>();
    if (!target) throw new HttpError("NOT_FOUND");
    if (!target.user_id) throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "memberId", reason: "member_not_linked" }]);
    if (target.status !== "active" || target.user_status !== "active") throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "memberId", reason: "member_not_active" }]);

    const newRoles = [...new Set(body.roleCodes)];
    // 担当の検証：対象種別・権限の組合せ、同じunitに存在すること、期限が未来、重複なし
    const nowIso = new Date().toISOString();
    const seen = new Set<string>();
    const scopes: { entityType: string; entityId: string; permissions: string[]; expiresAt: string | null }[] = [];
    for (const s of body.scopes) {
      const def = SCOPE_ENTITIES[s.entityType];
      if (!def) throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "scopes.entityType", reason: "unsupported_entity_type" }]);
      if (!s.permissions.every((x) => def.permissions.includes(x))) throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "scopes.permissions", reason: "permission_not_applicable" }]);
      const key = `${s.entityType}:${s.entityId}`;
      if (seen.has(key)) throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "scopes", reason: "duplicate_scope" }]);
      seen.add(key);
      const exists = await c.env.DB.prepare(`SELECT 1 FROM ${def.table} WHERE id = ? AND unit_id = ?`).bind(s.entityId, p.unitId).first();
      if (!exists) throw new HttpError("NOT_FOUND");
      const expiresAt = s.expiresAt ? new Date(s.expiresAt).toISOString() : null;
      if (expiresAt && expiresAt <= nowIso) throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "scopes.expiresAt", reason: "already_expired" }]);
      scopes.push({ entityType: s.entityType, entityId: s.entityId, permissions: [...new Set(s.permissions)].sort(), expiresAt });
    }

    // 自己昇格の禁止：自分自身には、今持っている以上の役割・担当を付けられない（降格や取消は可）
    if (params.id === p.memberId) {
      const heldScopes = new Set(p.scopes.map((s) => `${s.entityType}:${s.entityId}:${[...s.permissions].sort().join(",")}`));
      // 今持っている最上位より上の役割を付けるのが昇格（降格や、より低い役割への置換は可）
      const rank = (r: string) => (roleCodes as readonly string[]).indexOf(r);
      const held = Math.max(-1, ...p.roles.map(rank));
      const addsRole = newRoles.some((r) => rank(r) > held);
      const addsScope = scopes.some((s) => !heldScopes.has(`${s.entityType}:${s.entityId}:${s.permissions.join(",")}`));
      if (addsRole || addsScope) throw new HttpError("FORBIDDEN", undefined, [{ field: "permission", reason: "self_escalation" }]);
    }
    // 最後の管理者の降格の禁止
    if (!newRoles.includes("admin") && (await wouldRemoveLastAdmin(c, p.unitId, params.id))) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "roleCodes", reason: "last_admin" }]);
    }

    const result = await commitRoleReplacement(c, p, {
      memberId: params.id, targetUserId: target.user_id, version: body.version, expectedAuthzVersion: body.expectedAuthzVersion,
      newRoles, scopes, reason: body.reason, key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "PUT", path: `/members/${params.id}/roles`, baseVersion: body.version, body }),
    });
    return ok(c, result.data);
  });
}

export interface RoleReplacement {
  memberId: string;
  targetUserId: string;
  /** 団員の版 */
  version: number;
  /** 対象利用者の認可版 */
  expectedAuthzVersion: number;
  newRoles: string[];
  scopes: { entityType: string; entityId: string; permissions: string[]; expiresAt: string | null }[];
  reason: string;
  key: string;
  requestHash: string;
}

/**
 * 確定のbatch。降格で最後の管理者が消えないことをbatch内でも検査する（事前の読取との間の競合に備える）。
 * 事前確認を経ずに直接呼んで、この保護を試験する。
 */
export async function commitRoleReplacement(c: ApiContext, p: AuthzPrincipal, a: RoleReplacement) {
const { memberId, targetUserId, version, newRoles, scopes, reason, key, requestHash } = a;
const authz = a.expectedAuthzVersion;
return executeMutation(c.env, p, {
    operationCode: "member.roles.replace",
    key,
    requestHash,
    expectedAuthzVersion: p.authzVersion,
    roots: [{ table: "members", id: memberId, expectedVersion: version }],
    conditions: [
      {
        existsSql: "SELECT 1 FROM users u JOIN members m ON m.user_id = u.id WHERE m.id = ? AND m.unit_id = ? AND u.status = 'active' AND u.authz_version = ?",
        binds: [memberId, p.unitId, authz],
        failCode: "VERSION_CONFLICT",
      },
      // 降格で最後の管理者が消えないこと（確定の検査。事前の読取との競合を防ぐ）
      ...(newRoles.includes("admin") ? [] : [notLastAdmin(p.unitId, memberId)]),
    ],
    duplicateOn: ["index:uq_member_roles_active", "index:uq_scope_assignments_active"],
    statements: (ctx) => [
      c.env.DB.prepare("UPDATE members SET version = version + 1, last_mutation_token = ?, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ?")
        .bind(ctx.attempt, ctx.now, memberId, p.unitId, version),
      // 認可版の増分：以後、旧い認可版で判定中の他の更新（承認など）は失敗して再認可される
      c.env.DB.prepare("UPDATE users SET authz_version = authz_version + 1, updated_at = ? WHERE id = ? AND status = 'active' AND authz_version = ?")
        .bind(ctx.now, targetUserId, authz),
      // 外れた役割は取消（履歴として残す）、新しい役割は追加
      c.env.DB.prepare(
        "UPDATE member_roles SET revoked_at = ?, change_reason = ?, version = version + 1, updated_at = ?, last_mutation_token = ? " +
          "WHERE member_id = ? AND unit_id = ? AND revoked_at IS NULL AND role_id NOT IN (SELECT id FROM roles WHERE code IN (SELECT value FROM json_each(?)))",
      ).bind(ctx.now, reason, ctx.now, ctx.attempt, memberId, p.unitId, JSON.stringify(newRoles)),
      ...newRoles.map((code) =>
        c.env.DB.prepare(
          "INSERT INTO member_roles (id, unit_id, member_id, role_id, granted_by, change_reason, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "SELECT ?, ?, ?, r.id, ?, ?, ?, ?, ?, ?, 'human' FROM roles r WHERE r.code = ? " +
            "AND NOT EXISTS (SELECT 1 FROM member_roles x WHERE x.member_id = ? AND x.role_id = r.id AND x.revoked_at IS NULL)",
        ).bind(crypto.randomUUID(), p.unitId, memberId, p.userId, reason, ctx.attempt, ctx.now, ctx.now, p.userId, code, memberId),
      ),
      // 担当は全置換：現在の担当を全て取消し、指定どおりに作り直す
      c.env.DB.prepare(
        "UPDATE scope_assignments SET revoked_at = ?, change_reason = ?, version = version + 1, updated_at = ?, last_mutation_token = ? WHERE member_id = ? AND unit_id = ? AND revoked_at IS NULL",
      ).bind(ctx.now, reason, ctx.now, ctx.attempt, memberId, p.unitId),
      ...scopes.map((s) =>
        c.env.DB.prepare(
          "INSERT INTO scope_assignments (id, unit_id, member_id, entity_type, entity_id, permissions, expires_at, change_reason, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human')",
        ).bind(crypto.randomUUID(), p.unitId, memberId, s.entityType, s.entityId, JSON.stringify(s.permissions), s.expiresAt, reason, ctx.attempt, ctx.now, ctx.now, p.userId),
      ),
    ],
    audit: { action: "member.roles.replace", entityType: "member", entityId: memberId, metadata: { roles: [...newRoles].sort().join("."), scopes: scopes.length } },
    event: { entityType: "member", entityId: memberId, entityVersion: version + 1, eventType: "member.roles.replaced", payload: { authzVersion: authz + 1 } },
    response: {
      status: 200,
      sql: MEMBER_ROLES_JSON,
      binds: [memberId],
      decode: (j) => {
        const x = j as { roleCodes: string[]; scopes: { entityType: string; entityId: string }[] };
        const order = (roleCodes as readonly string[]);
        return MemberRoles.parse({
          ...x,
          roleCodes: [...x.roleCodes].sort((a, b) => order.indexOf(a) - order.indexOf(b)),
          scopes: [...x.scopes].sort((a, b) => (a.entityType + a.entityId).localeCompare(b.entityType + b.entityId)),
        });
      },
    },
  });
}
