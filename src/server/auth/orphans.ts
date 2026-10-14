import type { AppEnv } from "../env";

/** 孤児identityを残す猶予（案：招待の最長有効期間30日より短く、受領のやり直しに十分な7日） */
export const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 招待で登録したが、受領(API-35)を完了しなかった認証identityを回収する（docs/07 §2）。
 * 業務の利用者(users)に結びついていないidentityは、もともと業務アクセスを持たない。猶予後に削除し、
 * セッション・口座・二要素は外部キーの連鎖で消える。受領済み(users.auth_idがある)は消さない。Cronから呼ぶ。
 */
export async function reapOrphanIdentities(env: Pick<AppEnv, "DB">, nowIso: string): Promise<number> {
  const cutoff = new Date(new Date(nowIso).getTime() - ORPHAN_GRACE_MS).toISOString();
  const res = await env.DB.prepare(
    "DELETE FROM auth_users WHERE created_at < ? AND id NOT IN (SELECT auth_id FROM users)",
  ).bind(cutoff).run();
  return res.meta.changes ?? 0;
}
