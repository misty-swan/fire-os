import { sha256Hex } from "../mutations/hash";

/**
 * GIS検索のcursor（T020、docs/05 §5）。filterHash/sortKey/snapshotRevisionをサーバー署名付きで持つopaque値。
 * 署名はBETTER_AUTH_SECRETから導いた鍵のHMAC（cursorの改変は署名不一致で拒否し、条件変更と同じ応答にする）。
 */

export interface GisCursor {
  filterHash: string;
  sortKey: string;
  snapshotRevision: number;
}

export async function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(`gis-cursor:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

export async function encodeGisCursor(key: CryptoKey, cursor: GisCursor): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(cursor)));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

/** 改変・署名不一致・型の不整合は全てnull（呼び出し側は条件変更と同じ拒否にする） */
export async function decodeGisCursor(key: CryptoKey, value: string): Promise<GisCursor | null> {
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", key, unb64url(sig) as BufferSource, new TextEncoder().encode(payload));
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(unb64url(payload))) as GisCursor;
    if (typeof parsed.filterHash !== "string" || typeof parsed.sortKey !== "string" || typeof parsed.snapshotRevision !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 検索条件の指紋。条件が1つでも変わればhashが変わり、cursorは使えなくなる */
export async function filterHashOf(query: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(query));
}
