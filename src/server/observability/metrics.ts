import type { AppEnv } from "../env";

/**
 * 使用量メトリクスの記録（T080、docs/07 §8、docs/14 D11、NFR-08）。
 *
 * - 使用量の記録はD1（drizzle/0032 usage_metrics）で行う。Analytics Engine等の新bindingは
 *   追加しない（4環境へのbinding追加はT080の範囲外。コントローラ裁定）。
 * - **Workers/D1/R2/AI/Maps/通知を別計上**（service列。docs/16 T080「Usageは…別計量」）。
 *   アプリ内で計測できないもの（WorkersのCPU/リクエスト、D1の読み取り行数、Mapsのロード）は
 *   amount=NULLで「未計上であること」を記録し、0と偽装しない。
 * - **メトリクスに個人情報を載せない**（piiInMetrics=[]）: metric/sourceは監査のmetadataと同じ
 *   コード形式（CODE_LIKE）だけを許し、氏名・本文・自由文を載せられないようにする。単位も
 *   count/bytes/tokens/msに限定し、費用（usd）をメトリクスに直接載せない（費用はbudget.tsが
 *   costSource付きの試算として出す。勝手に推計しない）。
 * - 記録は**観測**であり業務の正本ではない: 呼び出し側は recordMetricSafe を使い、記録の失敗で
 *   業務（jobの成否）を壊さない。recordMetricは検査と書込だけを行い、検査違反は呼び出し側の
 *   バグとして投げる（試験が検出する）。
 */

export const METRIC_SERVICES = ["workers", "d1", "r2", "ai", "maps", "notification"] as const;
export type MetricService = (typeof METRIC_SERVICES)[number];
export const METRIC_UNITS = ["count", "bytes", "tokens", "ms"] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

/** 監査/outboxに入れてよい文字列と同じ「ID・コード・状態名の形」（src/server/mutations/execute.tsのCODE_LIKEと同じ語彙） */
const CODE_LIKE = /^[A-Za-z0-9_.:-]{1,100}$/;

export interface MetricInput {
  service: MetricService;
  /** 計上項目のコード（例: ai.calls / ai.tokens.input / notification.deliveries）。自由文は不可 */
  metric: string;
  /** 計上値。nullは「未知」（アプリ内で計測できない。0と偽装しない）。既知の値は0以上の整数 */
  amount: number | null;
  unit: MetricUnit;
  /** 出所のコード（例: job:ai.classify / seed:normal-day）。省略可。自由文は不可 */
  source?: string | null;
}

export class MetricInputError extends Error {
  constructor(reason: string) {
    super(`metric input invalid: ${reason}`);
  }
}

/** UTC暦日のバケット（YYYY-MM-DD。usage_metrics.dayの語彙） */
export const dayUtcOf = (now: Date): string => now.toISOString().slice(0, 10);

function assertMetricInput(input: MetricInput): void {
  if (!(METRIC_SERVICES as readonly string[]).includes(input.service)) {
    throw new MetricInputError(`unknown service: ${String(input.service)}`);
  }
  if (!(METRIC_UNITS as readonly string[]).includes(input.unit)) {
    throw new MetricInputError(`unknown unit: ${String(input.unit)}`);
  }
  if (!CODE_LIKE.test(input.metric)) throw new MetricInputError("metric must be code-like");
  if (input.source !== undefined && input.source !== null && !CODE_LIKE.test(input.source)) {
    throw new MetricInputError("source must be code-like");
  }
  if (input.amount !== null && (!Number.isSafeInteger(input.amount) || input.amount < 0)) {
    throw new MetricInputError("amount must be a non-negative integer (or null=unknown)");
  }
}

/** 使用量を1行計上する（unknownはNULLで保存。0と偽装しない）。検査違反は投げる（呼び出し側のバグ） */
export async function recordMetric(env: Pick<AppEnv, "DB">, input: MetricInput, opts: { now?: Date } = {}): Promise<void> {
  assertMetricInput(input);
  const now = opts.now ?? new Date();
  await env.DB.prepare(
    "INSERT INTO usage_metrics (id, service, metric, day, amount, amount_known, unit, source, recorded_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    crypto.randomUUID(),
    input.service,
    input.metric,
    dayUtcOf(now),
    input.amount,
    input.amount === null ? 0 : 1,
    input.unit,
    input.source ?? null,
    now.toISOString(),
  ).run();
}

/** 観測は業務を止めない。失敗は構造化ログへ（コードだけを載せ、例外の本文は出さない） */
export async function recordMetricSafe(env: Pick<AppEnv, "DB">, input: MetricInput, opts: { now?: Date } = {}): Promise<void> {
  try {
    await recordMetric(env, input, opts);
  } catch {
    console.error(JSON.stringify({ event: "usage_metric_failed", service: input.service, metric: input.metric }));
  }
}
