import { sha256Hex } from "../mutations/hash";

/** 招待tokenの生成：256bitの乱数をURL安全なbase64に（43文字）。DBにはhashしか置かない */
export function newInvitationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * 認証identity(authId)から業務 users.id を決める（同じauthIdなら必ず同じ値）。
 * 招待受領の再送（応答が消えた後の同じ鍵の再送）が、同じ利用者の同じ結果として見つかるようにするため。
 * UUID v4 の形に整える（小文字）。
 */
export async function userIdForAuth(authId: string): Promise<string> {
  const h = await sha256Hex(`user:${authId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
