// 冪等性のための正規化ハッシュ（docs/05 §2）。
// 形式（キー順・空白）が違っても意味が同じJSONは同じhash、別の意味なら別のhashになる。

/** キーを辞書順に並べた決定的なJSON。undefinedは落とし、NaN/Infinityは拒否する。 */
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

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CanonicalRequest {
  method: string;
  path: string;
  /** 更新対象の版（無い操作はnull） */
  baseVersion?: number | null;
  /** 対象ID（pathに含まれない場合） */
  target?: string | null;
  body?: unknown;
}

/** method/path/対象/baseVersion/本文を含むSHA256。同じ鍵を別の操作や別の版で再利用すると別hashになる。 */
export async function canonicalRequestHash(req: CanonicalRequest): Promise<string> {
  return sha256Hex(
    canonicalJson({
      method: req.method.toUpperCase(),
      path: req.path.replace(/\/+$/, "") || "/",
      baseVersion: req.baseVersion ?? null,
      target: req.target ?? null,
      body: req.body ?? null,
    }),
  );
}
