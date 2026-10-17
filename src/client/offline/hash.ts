/**
 * payloadHashの計算（T077、docs/07端末保持「payloadはSHA-256」）。
 *
 * 形式の正本は src/server/mutations/hash.ts（キー辞書順・空白なしの正規化JSONのSHA-256）と同じだが、
 * サーバーはpayloadHashを再計算しない（src/server/sync/allowlist.tsの注記どおり、本文の正本はpayloadそのもの
 * ＋元APIの契約検査）。この値は端末側の整合用（下書きの編集検出・表示）のため、クライアントで完結する。
 */

/** キーを辞書順に並べた決定的なJSON。undefinedは落とす（サーバーのcanonicalJsonと同じ形） */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJson: 有限でない数値は扱えません");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: 未対応の型 ${typeof value}`);
  }
}

/** SHA-256（16進64桁）。Web Crypto（ブラウザ・Workers共通） */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 下書きpayloadのhash。store.putの検査（16進64桁）と一致させる */
export function payloadHashOf(payload: Record<string, unknown>): Promise<string> {
  return sha256Hex(canonicalJson(payload));
}
