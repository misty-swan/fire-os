import { spawnSync } from "node:child_process";

/**
 * scripts/backup-manifest.ts / scripts/restore-verify.ts 共通のwrangler起動ヘルパ（T079）。
 * CLIはローカルのwrangler（未ログインで使える--local系コマンド）経由でD1/R2に触る。
 * 実Cloudflareへの操作はops/backup-restore.mdの手順（wranglerにログインした別端末）で行う。
 */

export interface D1Resultset {
  results: Record<string, unknown>[];
  success: boolean;
  meta: { duration: number };
}

export class WranglerError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** wranglerコマンドを実行し、stdoutのJSONを返す（バナー等はstderrへ出る） */
export function wranglerJson(args: string[]): unknown {
  const res = spawnSync("npx", ["wrangler", ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 * 512 });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new WranglerError(`wrangler ${args.join(" ")} が失敗しました (exit=${res.status})`, res.stderr);
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new WranglerError(`wrangler ${args.join(" ")} の出力をJSONとして読めませんでした`, res.stderr);
  }
}

/** wrangler d1 execute --local --json の結果（複数文は文ごとの配列） */
export function d1Query(db: string, query: { command?: string; file?: string }, persistTo?: string): D1Resultset[] {
  const args = ["d1", "execute", db, "--local", "--json"];
  if (persistTo) args.push("--persist-to", persistTo);
  if (query.command) args.push("--command", query.command);
  if (query.file) args.push("--file", query.file);
  const out = wranglerJson(args);
  return (Array.isArray(out) ? out : [out]) as D1Resultset[];
}
