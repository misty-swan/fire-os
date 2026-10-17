import { z } from "zod";
import rawPolicy from "../../config/budget-development.json";

/**
 * 課金上限の開発設定（T080、docs/14 D11、docs/07 §8）。
 *
 * config/budget-development.jsonの正本を検査して共有モジュール化したもの。サーバー
 * （src/server/observability/budget.ts）と管理画面（OperationsPanel）の双方で同じ値を使う。
 * **実団体の承認済みではない**（approved: false。D11未了承の開発用の検証設定）。実請求との
 * 照合は未実施（実Cloudflare未接続）。数値の出典と根拠は docs/evidence/cost-estimate.md。
 */

export const BudgetPolicySchema = z.object({
  /** 設定の版（閾値を変えるときは進めて、理由をconfigのbasisとops/cost-alerts.mdに残す） */
  version: z.string().min(1).max(100),
  /** 固定日（YYYY-MM-DD） */
  setAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** 未承認であることの明記（trueにできない。了承はD11で別途記録する） */
  approved: z.literal(false),
  currency: z.literal("USD"),
  /** 月額の費用上限（USD。D11推奨案のWorkers Paid $5基本を含む開発設定） */
  monthlyLimitUsd: z.number().positive(),
  /** AI呼出し（高価な呼び出し）の1日あたりの枠（回） */
  dailyAiCallCap: z.number().int().positive(),
  /** 通知配送の1日あたりの枠（通） */
  dailyNotificationCap: z.number().int().positive(),
  /** 急増判定: 直近spikeWindowDays日の平均の何倍で「急増」にするか */
  spikeFactor: z.number().positive(),
  spikeWindowDays: z.number().int().min(1).max(30),
  /** 急増判定の下限（この回数未満の日は急増と判定しない。立ち上げ期の誤検知を避ける） */
  spikeMinCalls: z.number().int().min(0),
  /** providerの応答制限（429）の許容件数/日 */
  maxRateLimitedPerDay: z.number().int().min(0),
  /** 記録済みusage×固定単価の下限試算に使う単価。未固定のものはnull（勝手に推計しない） */
  prices: z.object({
    aiInputUsdPerMTokens: z.number().min(0).nullable(),
    aiOutputUsdPerMTokens: z.number().min(0).nullable(),
  }),
  /** 単価の出典（管理画面にそのまま出す。docs/06 §2と同じ記録形式） */
  priceSource: z.string().min(1).max(500),
  /** 設定の根拠と限界（未承認・照合未実施の明記） */
  basis: z.string().min(1).max(1000),
});

export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;

/** 起動時に検査する（形が壊れた設定で静かに運用しない）。正本はconfig/budget-development.json */
export const BUDGET_POLICY: BudgetPolicy = BudgetPolicySchema.parse(rawPolicy);
