import type { AppEnv } from "../env";
import { BUDGET_POLICY, type BudgetPolicy } from "../../shared/budget-policy";
import { METRIC_SERVICES, dayUtcOf, type MetricService } from "./metrics";

/**
 * 課金予兆の評価と上限停止（T080、docs/07 §8、docs/14 D11、docs/08 AT-NFR-08）。
 *
 * - 閾値の正本は config/budget-development.json（**開発設定・実団体の承認済みではない**。D11の
 *   推奨案を検証設定として固定）。評価そのものは純関数 evaluateBudget（docs/16 T080のInterface）。
 * - 停止（budget exhaustion → 高価な呼び出しの停止）は、AI分類・報告書生成等の**高価な呼び出しにだけ**
 *   効く（handlers/classification・handlers/reportが expensiveCallGate を呼ぶ）。既存記録の読取は
 *   止めない。解除は手順（ops/cost-alerts.mdのD1更新コマンド。新APIは作らない）。
 * - **アラートの自動送信は作らない**（通知送信は本文/対象の明示承認を要するため。Global Constraints）。
 *   アラート経路は「監査ログへの記録（entity_type='budget'）＋管理画面の運用パネル＋ops/cost-alerts.mdの
 *   手順」で、人が運用する。判定→適用（状態＋監査）は**1つのD1 batch**で原子的に行い、記録経路が
 *   失敗しても停止状態を壊さない（半適用を作らない。tests/budget.test.tsが注入で検査）。
 * - 使用量のうち Workers/D1/Maps はアプリ内では計測できない（実Cloudflareのダッシュボード/請求で確認）。
 *   未計上のサービスを0と偽装せず、BudgetState.usageComplete=false と costSource の常時注記で示す
 *   （実provider請求との照合は未実施＝実Cloudflare未接続）。
 */

export type { BudgetPolicy };

/** 評価の入力（docs/16 T080のUsageSnapshot）。当日（UTC暦日）の使用量と当月のtokens累計をservice別に集めたもの */
export interface UsageSnapshot {
  day: string;
  /** AI呼出しの試行（ai.callsの既知合計。usageの未知/既知と無関係に1試行=1） */
  aiCallsKnown: number;
  /** 呼出し失敗（ai.call_failed。失敗率の元データ。割算はopsが月次に算出） */
  aiCallsFailed: number;
  /** usage未知を含むtokens等の合計には入らない行数（0と偽装しないための別枠） */
  aiTokensInput: number;
  aiTokensOutput: number;
  /** 当月初日（UTC）以降のtokens累計（month-to-date。月額の費用試算に使う。unknownは含まず、前月末の行は含めない。review round 1） */
  monthAiTokensInput: number;
  monthAiTokensOutput: number;
  /** providerの応答制限（429。ai.rate_limited） */
  aiRateLimited: number;
  /** 通知の配送試行（notification.deliveries） */
  notifications: number;
  /** 配送不明（unknown。stuck→unknown＋providerで成否不明） */
  deliveryUnknown: number;
  /** R2へ新規保存したbytes（r2.bytes.stored。既存不変キーの再利用は増分0なので計上しない） */
  r2BytesStored: number;
  /** job滞留の兆候（lease失効。jobs.lease_expired） */
  jobLeaseExpired: number;
  /** 同期操作の拒否（sync.rejected） */
  syncRejections: number;
  /** 添付の検査で拒否＝スキャン不能（attachments.scan_rejected） */
  scanRejected: number;
  /** unknown（amount NULL）の行数。合計に偽装されず別枠で見える */
  unknownRows: number;
  /** アプリ内では計測できず、実Cloudflareのダッシュボード/請求での確認にしかならないサービス */
  unmeasuredServices: readonly MetricService[];
  /** 急増判定の基準（今日より前の日のAI呼出し。spikeWindowDays日分） */
  priorAiCalls: { day: string; known: number }[];
}

/** 評価の結果（docs/16 T080のBudgetState）。status/reasonsは管理画面・監査にそのまま載る語彙 */
export interface BudgetState {
  policyVersion: string;
  status: "normal" | "warn" | "stopped";
  /** 閾値超過の理由コード。日本語への対応は管理画面（OperationsPanel）が持つ */
  reasons: string[];
  /** 高価な呼び出し（AI分類・報告書生成）を許すか。stoppedのときfalse（既存記録の読取は止めない） */
  expensiveCallsAllowed: boolean;
  /** 記録済みusage×固定単価の下限試算（USD）。単価が未固定・usage未知でも偽装せず出典を示す */
  costEstimateUsd: number | null;
  costSource: string;
  /** 未知の使用量・未計測サービスが無いときだけtrue（現設定では常にfalse。実計測の空白を偽装しない） */
  usageComplete: boolean;
  unknownUsageCount: number;
  evaluatedAt: string;
}

/** 理由コードの語彙（監査metadata・budget_state.reasons_json・管理画面の対応表が使う） */
export const BUDGET_REASON_CODES = [
  "daily_ai_calls_over",
  "daily_notifications_over",
  "ai_rate_limited_over",
  "monthly_cost_estimate_over",
  "ai_calls_spike",
  "job_lease_expired_over",
  "delivery_unknown_over",
  "sync_rejections_over",
  "scan_rejected_over",
] as const;

/** 停止にする理由（docs/16 T080「高価な呼び出しの停止」）。これ以外（急増・監視項目）は予兆＝warnで止めない */
const STOP_REASONS: ReadonlySet<string> = new Set([
  "daily_ai_calls_over",
  "daily_notifications_over",
  "ai_rate_limited_over",
  "monthly_cost_estimate_over",
]);

/** アプリ内では計測できず、実Cloudflareのダッシュボード/請求での確認になるサービス（docs/07 §8） */
export const UNMEASURED_SERVICES: readonly MetricService[] =
  METRIC_SERVICES.filter((s) => s === "workers" || s === "d1" || s === "maps");

/**
 * 使用量のsnapshotを作る（当日＋当月のtokens累計＋急増判定の基準日。1本の集計SQLでusage_metricsを読む）。
 * 取得窓は「急増判定の直近spikeWindowDays日」と「当月初日（UTC）」の早い方（review round 1）:
 * 月額の費用上限がmonth-to-dateのtokensで判定されるため、当月初日以降の全行が必要。
 * 使い切りの集計であり、usage_metrics自体は追記型（更新・削除しない。opsが月次で実請求と照合する）。
 */
export async function buildUsageSnapshot(env: Pick<AppEnv, "DB">, opts: { now?: Date } = {}): Promise<UsageSnapshot> {
  const now = opts.now ?? new Date();
  const today = dayUtcOf(now);
  const spikeStart = dayUtcOf(new Date(now.getTime() - BUDGET_POLICY.spikeWindowDays * 24 * 3_600_000));
  const monthStart = `${today.slice(0, 7)}-01`;
  const windowStart = spikeStart < monthStart ? spikeStart : monthStart;
  const rows = (
    await env.DB.prepare(
      "SELECT day, service, metric, " +
        "SUM(CASE WHEN amount_known = 1 THEN amount ELSE 0 END) AS known_amount, " +
        "SUM(CASE WHEN amount_known = 0 THEN 1 ELSE 0 END) AS unknown_rows " +
        "FROM usage_metrics WHERE day >= ? AND day <= ? GROUP BY day, service, metric",
    ).bind(windowStart, today)
      .all<{ day: string; service: string; metric: string; known_amount: number; unknown_rows: number }>()
  ).results;

  const priorAiCalls: { day: string; known: number }[] = [];
  // 当月初日以降（今日を除く）のtokens累計。今日の分はsnapに集計してから合算する
  const monthTokensBeforeToday = { input: 0, output: 0 };
  const snap = {
    day: today,
    aiCallsKnown: 0,
    aiCallsFailed: 0,
    aiTokensInput: 0,
    aiTokensOutput: 0,
    aiRateLimited: 0,
    notifications: 0,
    deliveryUnknown: 0,
    r2BytesStored: 0,
    jobLeaseExpired: 0,
    syncRejections: 0,
    scanRejected: 0,
    unknownRows: 0,
  };
  for (const r of rows) {
    snap.unknownRows += r.unknown_rows;
    if (r.day !== today) {
      // 今日より前は2つに使う: 急増判定の基準（直近spikeWindowDays日のAI呼出しのみ。取得窓を
      //   当月初日まで広げてもbaselineの意味は変えない）と、当月初日以降のtokens（月累計。前月末は含めない）
      if (r.day >= spikeStart && r.service === "ai" && r.metric === "ai.calls") {
        priorAiCalls.push({ day: r.day, known: r.known_amount });
      }
      if (r.day >= monthStart && r.service === "ai") {
        if (r.metric === "ai.tokens.input") monthTokensBeforeToday.input += r.known_amount;
        else if (r.metric === "ai.tokens.output") monthTokensBeforeToday.output += r.known_amount;
      }
      continue;
    }
    if (r.service === "ai") {
      if (r.metric === "ai.calls") snap.aiCallsKnown += r.known_amount;
      else if (r.metric === "ai.call_failed") snap.aiCallsFailed += r.known_amount;
      else if (r.metric === "ai.tokens.input") snap.aiTokensInput += r.known_amount;
      else if (r.metric === "ai.tokens.output") snap.aiTokensOutput += r.known_amount;
      else if (r.metric === "ai.rate_limited") snap.aiRateLimited += r.known_amount;
    } else if (r.service === "notification") {
      if (r.metric === "notification.deliveries") snap.notifications += r.known_amount;
      else if (r.metric === "notification.delivery_unknown") snap.deliveryUnknown += r.known_amount;
    } else if (r.service === "r2") {
      // bytes=実保存量。scan_rejected=スキャン不能（検査拒否。監視のみの計上）
      if (r.metric === "r2.bytes.stored") snap.r2BytesStored += r.known_amount;
      else if (r.metric === "attachments.scan_rejected") snap.scanRejected += r.known_amount;
    } else if (r.service === "d1") {
      // 監視のみの計上（jobs=job滞留の兆候、sync=同期の拒否。DB側の行として記録）
      if (r.metric === "jobs.lease_expired") snap.jobLeaseExpired += r.known_amount;
      else if (r.metric === "sync.rejected") snap.syncRejections += r.known_amount;
    }
  }
  return {
    ...snap,
    monthAiTokensInput: monthTokensBeforeToday.input + snap.aiTokensInput,
    monthAiTokensOutput: monthTokensBeforeToday.output + snap.aiTokensOutput,
    unmeasuredServices: UNMEASURED_SERVICES,
    priorAiCalls: priorAiCalls.sort((x, y) => (x.day < y.day ? -1 : 1)),
  };
}

/** 費用の出典（管理画面・監査・試験が「実請求との照合は未実施」を示し続けるための常時注記） */
export const budgetCostSource = (policy: BudgetPolicy): string =>
  `記録済みusage×開発設定(${policy.version})の単価による下限試算。${policy.priceSource}。実請求とは照合していません`;

/**
 * 使用量とpolicyから予兆・上限超過を評価する（純関数。docs/16 T080のInterface）。
 * 停止（stopped）にするのは「日次枠・通知枠・429許容・費用試算」の超過のみ。急増（spike）と
 * 監視項目（job滞留・配送不明・同期の拒否・スキャン不能。review round 1）は予兆として warn にする
 * （**監視項目は停止に使わない**。docs/07 §8の「監視」は気づきのため。docs/14 D11「実測＋月額/急増通知」）。
 */
export function evaluateBudget(usage: UsageSnapshot, policy: BudgetPolicy, opts: { now?: Date } = {}): BudgetState {
  const reasons: string[] = [];
  if (usage.aiCallsKnown > policy.dailyAiCallCap) reasons.push("daily_ai_calls_over");
  if (usage.notifications > policy.dailyNotificationCap) reasons.push("daily_notifications_over");
  if (usage.aiRateLimited > policy.maxRateLimitedPerDay) reasons.push("ai_rate_limited_over");

  // 費用の下限試算: 当月初日以降の記録済みusage（month-to-date。月額の上限と比較する。review round 1）。
  // 単価が固定されている分だけ（LLM等の未固定単価は含まない＝勝手に推計しない）
  const priceIn = policy.prices.aiInputUsdPerMTokens;
  const priceOut = policy.prices.aiOutputUsdPerMTokens;
  const costEstimateUsd =
    priceIn === null && priceOut === null
      ? null
      : Math.round(((usage.monthAiTokensInput * (priceIn ?? 0) + usage.monthAiTokensOutput * (priceOut ?? 0)) / 1_000_000) * 1e6) / 1e6;
  if (costEstimateUsd !== null && costEstimateUsd > policy.monthlyLimitUsd) reasons.push("monthly_cost_estimate_over");

  // 急増: 基準日（window内の平均）と比べてspikeFactor倍超。立ち上げ期の誤検知をspikeMinCallsで避ける
  const baseline =
    usage.priorAiCalls.length > 0 ? usage.priorAiCalls.reduce((sum, d) => sum + d.known, 0) / usage.priorAiCalls.length : 0;
  if (usage.aiCallsKnown > policy.spikeMinCalls && baseline > 0 && usage.aiCallsKnown > policy.spikeFactor * baseline) {
    reasons.push("ai_calls_spike");
  }

  // 監視のみの項目（review round 1。超過はwarn＝気づき。停止には使わない。ops/cost-alerts.md §1）
  if (usage.jobLeaseExpired > policy.monitors.maxJobLeaseExpiredPerDay) reasons.push("job_lease_expired_over");
  if (usage.deliveryUnknown > policy.monitors.maxDeliveryUnknownPerDay) reasons.push("delivery_unknown_over");
  if (usage.syncRejections > policy.monitors.maxSyncRejectionsPerDay) reasons.push("sync_rejections_over");
  if (usage.scanRejected > policy.monitors.maxScanRejectedPerDay) reasons.push("scan_rejected_over");

  const stopped = reasons.some((r) => STOP_REASONS.has(r));
  const status = stopped ? "stopped" : reasons.length > 0 ? "warn" : "normal";
  return {
    policyVersion: policy.version,
    status,
    reasons,
    expensiveCallsAllowed: status !== "stopped",
    costEstimateUsd,
    costSource: budgetCostSource(policy),
    usageComplete: usage.unknownRows === 0 && usage.unmeasuredServices.length === 0,
    unknownUsageCount: usage.unknownRows,
    evaluatedAt: (opts.now ?? new Date()).toISOString(),
  };
}

// --- 状態の永続化（budget_state単一行＋監査。履歴の正本は監査） ---

export interface PersistedBudgetState {
  status: "normal" | "warn" | "stopped";
  source: "auto" | "manual";
  reasons: string[];
  policyVersion: string;
  updatedAt: string;
}

const isStatus = (v: string): v is PersistedBudgetState["status"] => v === "normal" || v === "warn" || v === "stopped";

/** 現在の状態を読む（行が無い=normal/autoとして扱う。migrationでseed行は作らない） */
export async function readPersistedBudgetState(env: Pick<AppEnv, "DB">): Promise<PersistedBudgetState | null> {
  const row = await env.DB.prepare(
    "SELECT status, source, reasons_json, policy_version, updated_at FROM budget_state WHERE id = 'global'",
  ).first<{ status: string; source: string; reasons_json: string; policy_version: string; updated_at: string }>();
  if (!row || !isStatus(row.status)) return null;
  return {
    status: row.status,
    source: row.source === "manual" ? "manual" : "auto",
    reasons: JSON.parse(row.reasons_json) as string[],
    policyVersion: row.policy_version,
    updatedAt: row.updated_at,
  };
}

export interface BudgetApplyInput {
  decision: BudgetState;
  /** 起動元。auto=評価経路（jobのゲート）/ manual=運用手順 */
  source: "auto" | "manual";
  /** 監査行のunit（コード経路ではjobのunit。監査はunit必須のため、opsの手順は直接D1更新で監査を自分で入れる） */
  auditUnitId: string | null;
  /** 監査metadataのnote（コード形式。例: job:ai.classify） */
  note: string;
}

const CODE_LIKE = /^[A-Za-z0-9_.:-]{1,100}$/;

/**
 * 評価の結果を状態へ適用する（docs/16 T080の評価→停止の確定）。
 *
 * - **手動停止は自動解除しない**: 現在 stopped/source=manual のときは、評価が正常でも
 *   stoppedのままにする（解除はops/cost-alerts.mdの手順。評価が自動で解除すると、運用が
 *   止めた意味が消える）。自動停止（source=auto）は使用量が枠内に戻る評価で解ける
 *   （日次枠の超過は翌日に自然解除。docs/07 §8「通常月次確認＋急増/上限接近通知」）。
 * - 状態の更新と監査（budget.stop/budget.resume/budget.alert）を**1つのD1 batch**で確定する。
 *   監査へ書けないときは適用ごと失敗し、停止状態を半適用で壊さない（tests/budget.test.tsが
 *   監査への書込失敗を注入して検査する）。状態が変わらない適用は何も書かない（監査の不在＝変化なし）。
 */
export async function applyBudgetDecision(
  env: Pick<AppEnv, "DB">,
  input: BudgetApplyInput,
  opts: { now?: Date } = {},
): Promise<{ changed: boolean; state: PersistedBudgetState }> {
  const now = (opts.now ?? new Date()).toISOString();
  if (!CODE_LIKE.test(input.note)) throw new Error("applyBudgetDecision: note must be code-like");
  const current = await readPersistedBudgetState(env);
  // 手動停止は評価が正常でも解けない（解除は手順）
  const manualHold = current?.status === "stopped" && current.source === "manual";
  const targetStatus = manualHold ? "stopped" : input.decision.status;
  const targetSource = targetStatus === "stopped" ? (manualHold ? "manual" : input.source) : "auto";
  const target: PersistedBudgetState = {
    status: targetStatus,
    source: targetSource,
    // 手動停止中は評価の理由で上書きしない（手動停止は評価によって一切変えない。解除は手順）
    reasons: manualHold && current ? current.reasons : input.decision.reasons,
    policyVersion: input.decision.policyVersion,
    updatedAt: now,
  };
  const currentStatus: PersistedBudgetState["status"] = current?.status ?? "normal";
  const changed =
    current === null || current.status !== target.status || current.source !== target.source ||
    JSON.stringify(current.reasons) !== JSON.stringify(target.reasons) ||
    current.policyVersion !== target.policyVersion;
  if (!changed) return { changed: false, state: target };

  // 監査はstatusが動くときだけ（同じstatusでのreasons更新は監査を増やさない）
  const transitioned = current === null || current.status !== target.status;
  const action = !transitioned
    ? null
    : target.status === "stopped"
      ? "budget.stop"
      : currentStatus === "stopped"
        ? "budget.resume"
        : "budget.alert";
  const statements = [
    env.DB.prepare(
      "INSERT INTO budget_state (id, status, source, reasons_json, policy_version, updated_by, updated_at) " +
        "VALUES ('global', ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (id) DO UPDATE SET status = excluded.status, source = excluded.source, reasons_json = excluded.reasons_json, " +
        "policy_version = excluded.policy_version, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    ).bind(target.status, target.source, JSON.stringify(target.reasons), target.policyVersion, input.source === "manual" ? "ops" : "evaluation", now),
  ];
  if (action && input.auditUnitId) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO audit_logs (id, unit_id, actor_kind, actor_user_id, action, entity_type, entity_id, mutation_id, occurred_at, metadata_json) " +
          "VALUES (?, ?, 'system', NULL, ?, 'budget', ?, ?, ?, ?)",
      ).bind(
        crypto.randomUUID(),
        input.auditUnitId,
        action,
        target.policyVersion,
        crypto.randomUUID(),
        now,
        // 監査のmetadataはスカラーのみ（AuditLog DTO。配列は載せられないため理由コードはカンマ結合。コードのみ）
        JSON.stringify({
          from: currentStatus, to: target.status, source: target.source,
          reasons: target.reasons.length > 0 ? target.reasons.join(",") : "none", note: input.note,
        }),
      ),
    );
  }
  await env.DB.batch(statements);
  return { changed: true, state: target };
}

export interface BudgetGateResult {
  allowed: boolean;
  status: "normal" | "warn" | "stopped";
  reasons: string[];
}

/**
 * 高価な呼び出し（AI分類・報告書生成・出典つき回答〔API-76〕・横断アシスタント〔API-77〕）の前で
 * 使うゲート（T080。review round 1でRAG/アシスタントにも接続）。毎回使用量を再評価し、
 * 判定→適用（監査込み）を行ってから「呼んでよいか」を返す。既存記録の読取は止めない
 * （このゲートを読み取り経路には置かない。AIを伴わない検索・一覧・詳細はそのまま使える）。
 */
export async function expensiveCallGate(
  env: AppEnv,
  via: { unitId: string; source: string },
): Promise<BudgetGateResult> {
  const decision = evaluateBudget(await buildUsageSnapshot(env), BUDGET_POLICY);
  const applied = await applyBudgetDecision(env, {
    decision,
    source: "auto",
    auditUnitId: via.unitId,
    note: via.source,
  });
  return { allowed: applied.state.status !== "stopped", status: applied.state.status, reasons: decision.reasons };
}
