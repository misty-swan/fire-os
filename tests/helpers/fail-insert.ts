import { env } from "cloudflare:workers";

/**
 * 途中失敗の注入（T085レビューB-I4/CT-05）。指定した表へのINSERTを必ず失敗させるトリガーを一時的に置き、
 * 実際のAPI（routeが組み立てる1つのD1 batch）をその文の位置で失敗させる。fnの後は必ずトリガーを外す。
 * vitest workersは試験ファイルごとにD1が分かれるため、他のファイルの試験には影響しない。
 */
export async function withFailingInsert<T>(table: string, fn: () => Promise<T>): Promise<T> {
  const name = `t85_fail_${table}`;
  await env.DB.prepare(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected failure (T085 CT-05)'); END`).run();
  try {
    return await fn();
  } finally {
    await env.DB.prepare(`DROP TRIGGER IF EXISTS ${name}`).run();
  }
}

/** 表ごとの行数（原本・履歴・監査・outboxが失敗で1行も増えていないことの比較用） */
export async function rowCounts(tables: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
  return out;
}

/** 監査・outboxなど、どの業務mutationでも同じbatchに入る共通の表 */
export const COMMON_EFFECT_TABLES = ["audit_logs", "domain_events", "idempotency_records"] as const;
