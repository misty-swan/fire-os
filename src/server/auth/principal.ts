import { HttpError, type ApiContext } from "../http";
import type { Principal } from "../mutations/execute";
import { authServiceFor } from "./adapter";
import type { RoleCode } from "./authorize";

/** 担当(scope)。取消・期限切れは含まない（resolvePrincipalが現時点で有効なものだけを返す） */
export interface ScopeGrant {
  entityType: string;
  entityId: string;
  permissions: string[];
}

/**
 * 認可に使う実行主体。**毎要求D1から引いた最新の状態**。セッションCookieの内容や認証ライブラリのroleは使わない。
 * mutationへ渡す Principal（userId/memberId/unitId/authzVersion）を含む。
 */
export interface AuthzPrincipal extends Principal {
  roles: RoleCode[];
  scopes: ScopeGrant[];
  displayName: string;
  rank: string | null;
  unitName: string;
  /** 認証側で二要素が有効か（管理系の操作の前提。試験用の注入では true） */
  mfaEnabled: boolean;
}

const unauthenticated = (reason: string) => new HttpError("UNAUTHENTICATED", undefined, [{ field: "session", reason }]);

interface PrincipalRow {
  user_id: string;
  authz_version: number;
  user_status: string;
  member_id: string;
  member_status: string;
  unit_id: string;
  unit_status: string;
  display_name: string;
  rank: string | null;
  unit_name: string;
}

const BASE_SQL =
  "SELECT u.id AS user_id, u.authz_version, u.status AS user_status, m.id AS member_id, m.status AS member_status, m.unit_id, " +
  "n.status AS unit_status, m.display_name, m.rank, n.name AS unit_name " +
  "FROM users u JOIN members m ON m.user_id = u.id JOIN units n ON n.id = m.unit_id WHERE ";

/** 試験専用の注入を許す環境か。本番系(demo/staging/production)や TEST_AUTH 未設定では常に false */
export const testIdentityAllowed = (c: ApiContext): boolean => c.env.APP_ENV === "local" && c.env.TEST_AUTH === "1";

/**
 * 実行主体を求める。
 *  1. 認証ライブラリでCookieのセッションを検証し、identity(authId)を得る（Cookie cacheは使わない）
 *  2. 業務の users→members→units を毎回D1から引く。招待を受領していない・停止・退団・分団停止は 401（業務アクセスなし）
 *  3. 役割(member_roles)と担当(scope_assignments)を現時点の有効なものだけ読む
 * 試験専用の x-test-identity({userId}) は testIdentityAllowed のときだけ（userIdの指定にだけ使い、状態は必ずDBから引く）。
 */
export async function resolvePrincipal(c: ApiContext): Promise<AuthzPrincipal> {
  let where: string;
  let key: string;
  let mfaEnabled = false;
  const testHeader = testIdentityAllowed(c) ? c.req.header("x-test-identity") : undefined;
  if (testHeader) {
    let userId: unknown;
    try {
      userId = (JSON.parse(testHeader) as { userId?: unknown }).userId;
    } catch {
      throw unauthenticated("invalid_test_identity");
    }
    if (typeof userId !== "string") throw unauthenticated("invalid_test_identity");
    where = "u.id = ?";
    key = userId;
    mfaEnabled = true;
  } else {
    const identity = await authServiceFor(c.env).session(c.req.raw);
    if (!identity) throw unauthenticated("no_session");
    where = "u.auth_id = ?";
    key = identity.authId;
    mfaEnabled = identity.twoFactorEnabled;
  }

  const row = await c.env.DB.prepare(BASE_SQL + where).bind(key).first<PrincipalRow>();
  if (!row) throw unauthenticated("account_not_linked");
  if (row.user_status !== "active" || row.member_status !== "active" || row.unit_status !== "active") {
    throw unauthenticated("account_disabled");
  }

  const nowIso = new Date().toISOString();
  const [roles, scopes] = await c.env.DB.batch([
    c.env.DB.prepare(
      "SELECT r.code FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.member_id = ? AND mr.unit_id = ? AND mr.revoked_at IS NULL",
    ).bind(row.member_id, row.unit_id),
    c.env.DB.prepare(
      "SELECT entity_type, entity_id, permissions FROM scope_assignments WHERE member_id = ? AND unit_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)",
    ).bind(row.member_id, row.unit_id, nowIso),
  ]);
  return {
    userId: row.user_id,
    memberId: row.member_id,
    unitId: row.unit_id,
    authzVersion: row.authz_version,
    displayName: row.display_name,
    rank: row.rank,
    unitName: row.unit_name,
    mfaEnabled,
    roles: (roles!.results as { code: RoleCode }[]).map((r) => r.code),
    scopes: (scopes!.results as { entity_type: string; entity_id: string; permissions: string }[]).map((s) => ({
      entityType: s.entity_type,
      entityId: s.entity_id,
      permissions: JSON.parse(s.permissions) as string[],
    })),
  };
}
