import type { Context } from "hono";
import type { AppBindings } from "../env";
import type { Principal } from "../mutations/execute";

/**
 * 実行主体（誰が操作しているか）を求める入口。
 * PH0では本物の認証(Better Auth)が無いため、試験専用の注入だけを実装する。
 *  - APP_ENV=local かつ TEST_AUTH=1 のときだけ x-test-identity ヘッダー({userId})を受け付ける
 *  - ヘッダーの値は userId の指定にだけ使い、所属・認可版・停止の判定は必ずDBから引く
 *  - 本番/staging/demoのwrangler設定にはTEST_AUTHを置かない
 * T007/T008で本物のセッション認証と最新認可に置き換える（この関数の呼び出し側は変えない）。
 */
export async function getPrincipal(c: Context<AppBindings>): Promise<Principal | null> {
  if (c.env.APP_ENV !== "local" || c.env.TEST_AUTH !== "1") return null;
  const header = c.req.header("x-test-identity");
  if (!header) return null;
  let userId: unknown;
  try {
    userId = (JSON.parse(header) as { userId?: unknown }).userId;
  } catch {
    return null;
  }
  if (typeof userId !== "string") return null;
  const row = await c.env.DB.prepare(
    "SELECT u.id AS user_id, u.authz_version, m.id AS member_id, m.unit_id FROM users u JOIN members m ON m.user_id = u.id " +
      "WHERE u.id = ? AND u.status = 'active' AND m.status = 'active'",
  )
    .bind(userId)
    .first<{ user_id: string; authz_version: number; member_id: string; unit_id: string }>();
  if (!row) return null;
  return { userId: row.user_id, memberId: row.member_id, unitId: row.unit_id, authzVersion: row.authz_version };
}
