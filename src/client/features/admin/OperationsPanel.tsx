import { useCallback, useEffect, useState } from "react";
import type { ApiResponse } from "../../../shared/contracts/registry";
import type { EvaluationRunDto } from "../../../shared/contracts/ai";
import { ApiError, apiCall } from "../../api";
import { Banner, Button, Card, Chip, Icon, Notice } from "../../components/ui";
import { BUDGET_POLICY } from "../../../shared/budget-policy";

type AuditLogRow = ApiResponse<"API-93">[number];
type LoadState = "loading" | "error" | "forbidden";

/** 理由コードの表示名（コードのまま見せない。未知のコードはそのまま出す） */
const REASON_LABEL: Record<string, string> = {
  daily_ai_calls_over: "AI呼び出しの1日の枠を超過",
  daily_notifications_over: "通知の1日の枠を超過",
  ai_rate_limited_over: "AIサービスの応答制限（429）が許容を超過",
  monthly_cost_estimate_over: "費用の試算が月額の上限を超過",
  ai_calls_spike: "使用量が急増",
  job_lease_expired_over: "処理が止まった作業（job滞留）が多発",
  delivery_unknown_over: "届いたか分からない通知が多発",
  sync_rejections_over: "端末からの同期の拒否が多発",
  scan_rejected_over: "検査で読めなかった写真が多発",
};
/** 費用・停止の記録（監査）の表示名 */
const ACTION_LABEL: Record<string, string> = {
  "budget.stop": "上限超過により、高価なAI呼び出しを停止",
  "budget.resume": "高価なAI呼び出しの停止を解除",
  "budget.alert": "費用の予兆（しきい値の接近・急増）を記録",
};
const jst = (iso: string) =>
  new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const usd = (v: number) => `$${v.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0")}`;

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-w-[9rem] flex-col gap-0.5 rounded-xl bg-white/[.04] px-3 py-2">
      <span className="text-[11px] font-bold text-ink-muted">{label}</span>
      <span className="text-[15px] font-bold tabular-nums">{value}</span>
      {hint && <span className="text-[11px] text-ink-muted">{hint}</span>}
    </div>
  );
}

/**
 * 運用（費用と障害）のパネル（T080、SCR-17に追加。docs/07 §8、docs/14 D11、NFR-08）。
 *
 * - **データ源は既存のAPIだけ**（新規endpointは作らない）: 費用はAI評価の実行履歴（API-88）の
 *   記録済みusage（tokens・costUsd/costSource）、障害は同じ実行履歴の失敗と監査（API-93）の
 *   費用・停止の記録。上限・しきい値は開発設定（config/budget-development.json）を共有モジュール
 *   （src/shared/budget-policy.ts）経由で表示する。動的な使用量を読むAPIは無いため、現在の
 *   使用量・停止状態は画面からは照会できない（正直に注記する。取得できるように見せない）。
 * - **実provider請求との照合は未実施**（実Cloudflare未接続）: 表示する費用は記録済みusage×
 *   開発設定の単価の試算で、実際の請求額ではない。Workers・D1・地図の利用量はこのアプリの中では
 *   計測できず（Cloudflareの管理画面での確認が必要）、その旨を常に表示する（0と偽装しない）。
 * - 上限の数値は開発用の検証設定で、実団体の承認済みではない（AI評価パネルの
 *   「実モデルでの品質評価は未実施」常時表示と同じ作法）。
 */
export function OperationsPanel({ enabled }: { enabled: boolean }) {
  const [runs, setRuns] = useState<EvaluationRunDto[] | LoadState>("loading");
  const [audit, setAudit] = useState<AuditLogRow[] | LoadState>("loading");
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    if (!enabled) return;
    setRuns("loading");
    setAudit("loading");
    const take = async <T,>(id: "API-88" | "API-93", query: Record<string, unknown>): Promise<T[] | LoadState> => {
      try {
        const r = await apiCall(id, { query });
        return r.data as T[];
      } catch (e) {
        return e instanceof ApiError && e.status === 403 ? "forbidden" : "error";
      }
    };
    setRuns(await take<EvaluationRunDto>("API-88", { limit: 20 }));
    setAudit(await take<AuditLogRow>("API-93", { entityType: "budget", limit: 10 }));
  }, [enabled]); // enabledを捕捉する（二要素認証の設定後に読み直す）
  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load, reloadKey]);

  const runsOk = Array.isArray(runs);
  const succeeded = runsOk ? runs.filter((r) => r.status === "succeeded") : [];
  const failedRuns = runsOk ? runs.filter((r) => r.status !== "succeeded") : [];
  // 記録済みusageの合計。costUsdが無い実行（単価未固定・usage未知）は合計に入れない（勝手に推計しない）
  const tokensTotal = succeeded.reduce((sum, r) => sum + (r.metrics ? r.metrics.promptTokens + r.metrics.completionTokens : 0), 0);
  const costRuns = succeeded.filter((r) => r.metrics?.costUsd != null);
  const costTotal = costRuns.reduce((sum, r) => sum + (r.metrics!.costUsd ?? 0), 0);
  const costSource = costRuns[0]?.metrics?.costSource ?? BUDGET_POLICY.priceSource;
  const auditOk = Array.isArray(audit);

  if (runs === "forbidden" || audit === "forbidden") {
    return (
      <Card className="flex flex-col gap-3.5 p-4 lg:p-5">
        <h3 className="flex items-center gap-2 text-[15px] font-bold">
          <Icon name="monitoring" className="text-[20px] text-ink-muted" />
          運用（費用と障害）
        </h3>
        <Notice tone="warning" icon="lock" role="status">この情報は管理者だけが表示できます。</Notice>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-3.5 p-4 lg:p-5">
      <h3 className="flex items-center gap-2 text-[15px] font-bold">
        <Icon name="monitoring" className="text-[20px] text-ink-muted" />
        運用（費用と障害）
      </h3>
      {!enabled && (
        <Notice tone="warning" icon="lock" role="status">二要素認証の設定が済むまで、この情報は表示できません。</Notice>
      )}
      {enabled && (
        <>
      {/* 常時注記（AI評価パネルの「実モデルでの品質評価は未実施」と同じ作法） */}
      <Banner tone="warning" eyebrow="NOT MEASURED" role="status" title="実際の請求との照合は未実施です">
        <p>
          ここに表示する費用は、このアプリが記録した使用量に開発設定の単価を掛けた試算で、実際の請求額ではありません。
          実際の請求はCloudflareの管理画面（請求）で確認する必要があり、照合はまだ行っていません。
        </p>
        <p>
          サーバー（Workers）・データベース（D1）・地図の利用量はこのアプリの中では計測できません
          （管理画面での確認が必要です）。計測できない分を0と表示する代わりに「未計上」として示します。
        </p>
      </Banner>

      {/* 費用（AI評価の実行履歴＝記録済みusageの既存の読み取り経路） */}
      <div className="flex flex-col gap-2">
        <p className="text-[12px] font-bold text-ink-sub">AI利用の費用と失敗（評価の実行履歴から）</p>
        {runs === "loading" && <p role="status" className="text-[13px] text-ink-muted">読み込んでいます…</p>}
        {runs === "error" && <Notice tone="warning" icon="error" role="status">実行履歴を取得できませんでした。</Notice>}
        {runsOk && (
          <>
            <div className="flex flex-wrap gap-2">
              <Figure label="実行（成功）" value={`${succeeded.length}件`} />
              <Figure label="実行（失敗・未判定）" value={`${failedRuns.length}件`} hint="失敗を合格とは数えない" />
              <Figure label="tokens（記録済みusage）" value={tokensTotal.toLocaleString("ja-JP")} />
              <Figure
                label="費用の試算（単価固定分のみ）"
                value={costRuns.length > 0 ? usd(costTotal) : "—"}
                hint={costRuns.length > 0 ? `記録済みの${costRuns.length}件のみ` : "単価が固定された記録がまだ無い"}
              />
              {/* Workers・D1・地図はアプリ内では計測できない（0と偽装せず「未計上」と示す。docs/03） */}
              <Figure label="Workers・D1・地図の利用量" value="未計上" hint="Cloudflare管理画面で確認" />
            </div>
            <p className="text-[11px] leading-[1.6] text-ink-muted">費用の出典: {costSource}</p>
            <p className="text-[11px] leading-[1.6] text-ink-muted">表示は最新の実行20件分の合計です。</p>
            {failedRuns.length > 0 && (
              <ul aria-label="失敗した実行" className="flex flex-col gap-1.5">
                {failedRuns.slice(0, 5).map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                    <Chip tone="alert" icon="cancel">失敗</Chip>
                    <span className="font-bold">{r.kind === "classification" ? "分類holdout" : "報告書holdout"}</span>
                    <span className="text-ink-muted">{jst(r.executedAt)} · 理由コード: {r.errorCode ?? "unknown"}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {/* 障害・費用の記録（監査＝既存の読み取り経路。アラートの自動送信は無く、この記録と手順で人が運用する） */}
      <div className="flex flex-col gap-2 border-t border-white/5 pt-3.5">
        <p className="text-[12px] font-bold text-ink-sub">費用・停止の記録（監査）</p>
        <p className="text-[12px] leading-[1.6] text-ink-muted">
          上限の接近・超過は自動で通知されません。この記録と下のしきい値を見て、運用手順（ops/cost-alerts.md）に従って対応します。
          表示は最新の監査10件分のみです。
        </p>
        {audit === "loading" && <p role="status" className="text-[13px] text-ink-muted">読み込んでいます…</p>}
        {audit === "error" && <Notice tone="warning" icon="error" role="status">記録を取得できませんでした。</Notice>}
        {auditOk && audit.length === 0 && <p className="text-[13px] text-ink-muted">費用・停止の記録はまだありません。</p>}
        {auditOk && audit.length > 0 && (
          <ul aria-label="費用と停止の記録" className="flex flex-col gap-2">
            {audit.map((row) => {
              const meta = row.metadata as { to?: string; reasons?: string };
              const reasons = (meta.reasons ?? "").split(",").filter((c) => c.length > 0 && c !== "none");
              return (
                <li key={row.id} className="flex flex-col gap-1 rounded-xl border border-white/10 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {meta.to === "stopped" ? (
                      <Chip tone="alert" icon="pause_circle">停止中の記録</Chip>
                    ) : meta.to === "normal" ? (
                      <Chip tone="ok" icon="check_circle">解除の記録</Chip>
                    ) : (
                      <Chip tone="attention" icon="warning">予兆の記録</Chip>
                    )}
                    <span className="text-[13px] font-bold">{ACTION_LABEL[row.action] ?? row.action}</span>
                    <span className="text-[11px] text-ink-muted">{jst(row.occurredAt)}</span>
                  </div>
                  {reasons.length > 0 && (
                    <p className="text-[12px] text-ink-sub">理由: {reasons.map((c) => REASON_LABEL[c] ?? c).join("・")}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 上限・しきい値（開発設定。未承認である旨を常時表示） */}
      <div className="flex flex-col gap-2 border-t border-white/5 pt-3.5">
        <p className="text-[12px] font-bold text-ink-sub">上限としきい値（開発用の検証設定）</p>
        <div className="flex flex-wrap gap-2">
          <Figure label="月額の費用上限（試算）" value={`$${BUDGET_POLICY.monthlyLimitUsd}`} hint="実団体の承認済みではない" />
          <Figure label="AI呼び出しの1日の枠" value={`${BUDGET_POLICY.dailyAiCallCap.toLocaleString("ja-JP")}回`} hint="超えるとAIを停止" />
          <Figure label="通知の1日の枠" value={`${BUDGET_POLICY.dailyNotificationCap.toLocaleString("ja-JP")}通`} hint="超えるとAIを停止" />
          <Figure label="応答制限（429）の許容" value={`${BUDGET_POLICY.maxRateLimitedPerDay}件/日`} hint="超えるとAIを停止" />
          <Figure
            label="急増の判定"
            value={`平均の${BUDGET_POLICY.spikeFactor}倍`}
            hint={`直近${BUDGET_POLICY.spikeWindowDays}日・1日${BUDGET_POLICY.spikeMinCalls}回未満は判定しない`}
          />
        </div>
        <p className="text-[11px] leading-[1.6] text-ink-muted">単価の出典: {BUDGET_POLICY.priceSource}</p>
        <p className="text-[12px] font-bold text-ink-sub">監視項目（超えてもAIは止まりません。気づきのため）</p>
        <div className="flex flex-wrap gap-2">
          <Figure label="処理が止まった作業" value={`${BUDGET_POLICY.monitors.maxJobLeaseExpiredPerDay}件/日`} hint="滞留の兆候" />
          <Figure label="届いたか分からない通知" value={`${BUDGET_POLICY.monitors.maxDeliveryUnknownPerDay}件/日`} />
          <Figure label="同期の拒否" value={`${BUDGET_POLICY.monitors.maxSyncRejectionsPerDay}件/日`} />
          <Figure label="検査で読めなかった写真" value={`${BUDGET_POLICY.monitors.maxScanRejectedPerDay}件/日`} />
        </div>
        <p className="text-[11px] leading-[1.6] text-ink-muted">
          これらの現在の値は、この画面では確認できません（運用コマンドでの確認になります。手順は運用手順の書類に記載）。
        </p>
      </div>

      {/* 停止と解除の案内（照会用のAPIは無いため、現在の状態は表示しない＝取得できるように見せない） */}
      <div className="flex flex-col gap-2 border-t border-white/5 pt-3.5">
        <p className="text-[12px] font-bold text-ink-sub">停止と解除</p>
        <p className="text-[12px] leading-[1.6] text-ink-muted">
          上限を超えると、AIによる分類・報告書の下書き生成が「保留」に、出典つきの回答とアシスタントへの質問は「使えない（503）」になります
          （いずれもAIを呼ばないため、停止中にAIの費用は増えません）。既存の記録の閲覧や登録は止まりません。
          解除は、サーバーの状態を更新する運用手順（ops/cost-alerts.md）で行います。
        </p>
        <Notice tone="info" icon="visibility_off" role="status">
          現在の停止状態は、この画面からは確認できません（照会用の仕組みがまだ無いため）。停止したときは上の「費用・停止の記録」に現れます。
        </Notice>
      </div>

      <div>
        <Button variant="secondary" disabled={!enabled} onClick={() => setReloadKey((k) => k + 1)} className="!h-[38px] max-lg:min-h-11 !text-[12px]">
          表示を再読み込み
        </Button>
      </div>
        </>
      )}
    </Card>
  );
}
