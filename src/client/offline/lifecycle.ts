import { getDraftStore, IndexedDbDraftStore } from "./store";
import type { DraftStore } from "./types";

/**
 * 端末下書きのライフサイクル共通処理（T075、docs/07 端末保持・docs/14 D14）。
 *
 * - 期限（7日・D14推奨案の検証設定）の計算と表示文言
 * - ログアウト・ユーザー切替での消去（下書き・写真。PWAのprecacheは消さない。purgeForLogoutのコメント）
 * - 起動時・同期前の期限切れ掃除
 *
 * D14の限界: ここで守れるのは「この端末でログアウト・切替・TTLまで」まで。端末を紛失したあとの
 * offline遠隔消去は保証しない（docs/14 D14で未決。TTL・再認証・端末ロックの併用を提案に含める）。
 */

/** 保持期間（日）。docs/14 D14推奨案「保持7日案」を検証設定として固定したもの。了承済みの扱いはしない */
export const DRAFT_TTL_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** この時刻に作った下書きの期限（ISO）。expiresAtは必ずこの関数か、これと同じ形式のUTC ISOで入れる */
export function draftExpiryFrom(nowIso: string): string {
  return new Date(Date.parse(nowIso) + DRAFT_TTL_DAYS * DAY_MS).toISOString();
}

/**
 * 期限の表示（T077の下書き一覧・保存完了の案内で使う）。色に頼らず文字で伝える（Design System原則②）。
 * 下書き一覧がまだ無い（T077）ため、ここでは文言の単一の源としてだけ置く。
 */
export function draftExpiryLabel(expiresAt: string, now: string): string {
  const remainingDays = Math.ceil((Date.parse(expiresAt) - Date.parse(now)) / DAY_MS);
  if (remainingDays <= 0) return "期限切れ（送信されません）";
  if (remainingDays === 1) return "今日まで";
  return `残り${remainingDays}日`;
}

/** 端末保存の案内（保存時・一覧で使う。検証設定である旨を含める） */
export const DRAFT_RETENTION_NOTICE = `下書きは端末に${DRAFT_TTL_DAYS}日間だけ保存され、ログアウトすると消えます（期限切れの下書きは送信されません）`;

/**
 * ログアウト・ユーザー切替時の消去（MenuPageから呼ぶ）。この端末に残した本人の下書きと写真を消す。
 * purgeはuserIdだけで消すので、分団表示が変わっていてもこの端末に残した本人の分は確実に消える。
 *
 * PWAのprecache（静的shellだけ。T074のe2eで中身を検証済み）は意図的に消さない: 生きたService Workerが
 * 削除済みのcacheを見続けるため、消すとlogout直後の完全読込（navigation・asset）が壊れる
 * （e2e offline-account-switch.spec で ERR_FAILED を確認）。precacheは利用者データ・鍵を含まないので、
 * docs/07の「データと鍵を破棄」の対象外。purgeUserCaches は明示的に呼ぶとき用として残す。
 */
export async function purgeForLogout(userId: string, store: DraftStore = getDraftStore()): Promise<void> {
  // unitId/deviceIdはstore.purgeの一致条件に使われない（userIdだけで消す）。プレースホルダとして空文字を渡す
  await store.purge({ userId, unitId: "", deviceId: "" });
}

/** ログイン直後の掃除（MeGateの取得成功から呼ぶ）。クラッシュ等でログアウト消去が走らなかった他人の下書きを消す */
export async function purgeForeignDrafts(currentUserId: string, store: IndexedDbDraftStore = getDraftStore()): Promise<void> {
  await store.purgeOthers(currentUserId);
}

/** 起動時・同期前の期限切れ掃除。期限切れは送信されず消える（docs/16: 期限後は人が新操作を作る） */
export async function expireDueDrafts(now: string = new Date().toISOString(), store: DraftStore = getDraftStore()): Promise<void> {
  await store.expire(now);
}
