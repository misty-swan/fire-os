import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { useMutation } from "../../useMutation";
import { Banner, Button, Card, Chip, Icon, Notice } from "../../components/ui";
import type { EvaluationMetricsDto, EvaluationRunDto } from "../../../shared/contracts/ai";

/**
 * AI評価の実行履歴・品質/費用/遅延パネル（T061、SCR-17に追加。docs/05 API-88/89、docs/06 §6、docs/14 D12）。
 * 管理者（PER-08。判定はサーバー）が固定holdoutの評価を実行し、実行履歴・metrics・合否・費用・p95を見る。
 *
 * - **実モデル実行は未実施（V04）**: この評価はコミット済みの架空holdout（人手ラベル＋記録済みの予測）の
 *   再計算で、実モデルの実測ではない。その旨を常に表示する（docs/evidence/ai-evaluation.md）。
 * - **未実施・失敗を合格と表示しない**: gatePassed=falseは「不合格」、null（失敗/未判定）は「未判定」と表示する。
 * - 実行ボタンはAPI-89。202=永続jobの受付で完了ではない（docs/05 §1）。
 */

const num = (v: number | null | undefined, digits = 3, suffix = ""): string =>
  v === null || v === undefined ? "—" : `${v.toFixed(digits)}${suffix}`;

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-[7.5rem] flex-col gap-0.5 rounded-xl bg-white/[.04] px-3 py-2">
      <span className="text-[11px] font-bold text-ink-muted">{label}</span>
      <span className="text-[15px] font-bold tabular-nums">{value}</span>
    </div>
  );
}

function MetricsGrid({ metrics }: { metrics: EvaluationMetricsDto }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Metric label="macro F1（>=0.85）" value={num(metrics.macroF1)} />
      <Metric label="要確認再現率（>=0.95）" value={num(metrics.needsReviewRecall)} />
      <Metric label="異常→無判断の見逃し（0が要件）" value={String(metrics.falseSafe)} />
      <Metric label="保留率" value={metrics.abstention === null ? "—" : `${(metrics.abstention * 100).toFixed(1)}%`} />
      <Metric label="遅延 p95（ms）" value={String(metrics.latencyP95Ms)} />
      <Metric label="tokens（入出力）" value={`${metrics.promptTokens}/${metrics.completionTokens}`} />
      <Metric
        label="費用（USD・記録済みusage）"
        value={metrics.costUsd === null ? "—" : `$${metrics.costUsd.toFixed(4)}`}
      />
      <Metric label="失敗例" value={String(metrics.failedCases)} />
    </div>
  );
}

function GateChip({ run }: { run: EvaluationRunDto }) {
  if (run.status !== "succeeded" || run.gatePassed === null) {
    return <Chip tone="attention" icon="help">未判定（失敗: {run.errorCode ?? "unknown"}）</Chip>;
  }
  if (run.gatePassed) return <Chip tone="ok" icon="check_circle">合格</Chip>;
  return <Chip tone="alert" icon="cancel">不合格</Chip>;
}

export function AiEvaluationPanel() {
  const [runs, setRuns] = useState<EvaluationRunDto[] | "loading" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [accepted, setAccepted] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = (await api("API-88", { query: {} })) as unknown as EvaluationRunDto[];
      setRuns(data);
    } catch {
      setRuns("error");
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  const runClassification = useMutation("API-89");
  const runReport = useMutation("API-89");

  const request = async (which: "classification" | "report") => {
    const mutation = which === "classification" ? runClassification : runReport;
    const r = await mutation.run({
      body:
        which === "classification"
          ? { datasetVersion: "classification-holdout-v1", questionVersion: "v1", modelId: "typesafe/jev" }
          : {
              datasetVersion: "report-holdout-v1",
              questionVersion: "report-draft-v1",
              modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            },
    });
    if (r) {
      setAccepted(which === "classification" ? "分類holdout" : "報告書holdout");
    }
  };

  return (
    <Card className="flex flex-col gap-3.5 p-4 lg:p-5">
      <h3 className="flex items-center gap-2 text-[15px] font-bold">
        <Icon name="fact_check" className="text-[20px] text-ink-muted" />
        AI評価（固定holdout）
      </h3>
      <Banner tone="warning" eyebrow="NOT MEASURED" role="status" title="実モデルでの品質評価は未実施です">
        <p>
          ここに表示する数値は、コミット済みの架空評価データ（人手ラベルと記録済みの出力。生成スクリプト:
          scripts/generate-ai-holdout.ts）を再計算したもので、実モデルの実測ではありません。
          実モデルでの評価（V04）は、AI送信条件（D12）の了承とAI環境の用意が済んでから行います。
        </p>
      </Banner>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={runClassification.saving} busy={runClassification.saving} onClick={() => void request("classification")} className="!h-[42px] !text-[12px]">
          分類holdout（300件）を評価する
        </Button>
        <Button variant="secondary" disabled={runReport.saving} busy={runReport.saving} onClick={() => void request("report")} className="!h-[42px] !text-[12px]">
          報告書holdout（50件）を評価する
        </Button>
      </div>
      {(runClassification.state.kind === "processing" || runReport.state.kind === "processing") && (
        <Notice tone="info" icon="hourglass_top" role="status">
          {accepted}の評価を実行キューに入れました（{accepted === "分類holdout" ? "API-89" : "API-89"}・202=受付）。完了ではありません。実行結果は下の一覧に反映されます。
        </Notice>
      )}
      {runs === "loading" && <p role="status" className="text-[13px] text-ink-muted">読み込んでいます…</p>}
      {runs === "error" && (
        <Notice tone="warning" icon="error" role="status">実行履歴を取得できませんでした。</Notice>
      )}
      {Array.isArray(runs) && runs.length === 0 && (
        <p className="text-[13px] text-ink-muted">実行履歴はまだありません。上のボタンで固定holdoutの評価を実行できます。</p>
      )}
      {Array.isArray(runs) && runs.length > 0 && (
        <ul aria-label="AI評価の実行履歴" className="flex flex-col gap-3">
          {runs.map((run) => (
            <li key={run.id} className="flex flex-col gap-2 rounded-xl border border-white/10 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <GateChip run={run} />
                <span className="text-[13px] font-bold">
                  {run.kind === "classification" ? "分類holdout" : "報告書holdout"}
                  <span className="ml-2 font-normal text-ink-muted">
                    {run.datasetVersion} · 質問/プロンプト版 {run.questionVersion} · モデル {run.modelId}
                  </span>
                </span>
                <span className="text-[11px] text-ink-muted">
                  {new Date(run.executedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 実行 · {run.caseCount}件
                </span>
              </div>
              {run.metrics ? (
                <>
                  <MetricsGrid metrics={run.metrics} />
                  <p className="text-[11px] text-ink-muted">費用の出典: {run.metrics.costSource}</p>
                  {run.metrics.gate.reasons.length > 0 && (
                    <p className="text-[12px] font-bold text-alert">
                      不合格の理由: {run.metrics.gate.reasons.join("・")}（閾値 {run.metrics.gate.thresholdVersion} は評価前に事前固定）
                    </p>
                  )}
                  {run.metrics.failedCaseSamples.length > 0 && (
                    <p className="text-[12px] text-ink-sub">
                      失敗例（上位{run.metrics.failedCaseSamples.length}件/全{run.metrics.failedCases}件）:
                      {run.metrics.failedCaseSamples.slice(0, 5).map((f) => ` ${f.caseRef}(${f.note})`).join("・")}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-[12px] text-attention">指標は未判定です（実行が失敗しました。失敗を合格とは表示しません）。</p>
              )}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)} className="!h-[38px] !text-[12px]">実行履歴を再読み込み</Button>
      </div>
    </Card>
  );
}
