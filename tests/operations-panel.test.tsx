import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetPendingKeysForTest } from "../src/client/useMutation";
import { OperationsPanel } from "../src/client/features/admin/OperationsPanel";

/**
 * 運用（費用と障害）パネルのjsdom試験（T080）。e2eはT080では走らせないため、
 * SCR-17で「費用と障害を把握できる」ことの最小の裏付けをここで取る:
 * ①常時注記（実請求との照合は未実施）と開発設定のしきい値が出る ②既存API（API-88/93）からの
 * 表示で、costUsdの無い実行を費用合計に入れない（勝手に推計しない）③監査の記録を日本語で出す
 * ④403は「管理者だけ」、二要素未設定は案内のみでAPIを呼ばない。
 * stubFetchの流儀は tests/client-shell.test.tsx と同じ。
 */

type Reply = { status: number; body?: unknown } | Error;
function stubFetch(...replies: Reply[]) {
  const queue = [...replies];
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
    const r = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const ok = (data: unknown): Reply => ({ status: 200, body: { data, meta: { requestId: "req-1" } } });

const runRow = (over: Record<string, unknown> = {}) => ({
  id: "run-1", jobId: "job-1", kind: "classification", datasetVersion: "classification-holdout-v1",
  questionVersion: "v1", modelId: "typesafe/jev", datasetRef: "tests/fixtures/ai/classification-holdout.jsonl@v1",
  datasetSha256: "a".repeat(64), caseCount: 300, labels: {}, outputs: {},
  status: "succeeded", gatePassed: true, errorCode: null, runByUserId: "u-1",
  executedAt: "2026-10-17T00:00:00.000Z", createdAt: "2026-10-17T00:00:00.000Z", ...over,
});

beforeEach(() => {
  vi.unstubAllGlobals();
  _resetPendingKeysForTest();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OperationsPanel (T080)", () => {
  it("shows_not_measured_note_thresholds_costs_from_recorded_usage_and_audit_history", async () => {
    const fetchFn = stubFetch(
      // API-88: 成功2件（costUsdあり/なし）＋失敗1件。costUsdの無い実行は費用合計に入れない
      ok([
        runRow({ id: "run-ok-cost", status: "succeeded", metrics: { promptTokens: 1000, completionTokens: 100, costUsd: 0.042, costSource: "docs/06 §2 Jev定価（検証設定）: 入力$0.042/100万tokens・出力$0。実請求の実測はV04（未実施）" } }),
        runRow({ id: "run-ok-nocost", status: "succeeded", metrics: { promptTokens: 500, completionTokens: 50, costUsd: null, costSource: "単価未固定（docs/14 D16・V04）。tokensの記録のみ" } }),
        runRow({ id: "run-failed", status: "failed", gatePassed: null, metrics: null, errorCode: "dataset_invalid" }),
      ]),
      // API-93: 停止と解除の監査
      ok([
        { id: "a1", occurredAt: "2026-10-17T01:00:00.000Z", actorKind: "system", actorId: null, action: "budget.stop", entityType: "budget", entityId: "budget-dev-v1", mutationId: "m1", metadata: { from: "normal", to: "stopped", source: "auto", reasons: "daily_ai_calls_over,ai_calls_spike", note: "job:ai.classify" }, entityVersion: null, eventType: null },
        { id: "a2", occurredAt: "2026-10-17T02:00:00.000Z", actorKind: "system", actorId: null, action: "budget.resume", entityType: "budget", entityId: "budget-dev-v1", mutationId: "m2", metadata: { from: "stopped", to: "normal", source: "auto", reasons: "none", note: "job:ai.classify" }, entityVersion: null, eventType: null },
      ]),
    );
    render(<OperationsPanel enabled={true} />);

    // 常時注記（実請求との照合は未実施・未計上の正直表示）
    expect(screen.getByText("実際の請求との照合は未実施です")).toBeTruthy();
    expect(screen.getByText(/計測できない分を0と表示する代わりに「未計上」として示します/)).toBeTruthy();
    // 開発設定のしきい値（未承認である旨つき）
    expect(screen.getByText("$5")).toBeTruthy();
    expect(screen.getByText("実団体の承認済みではない")).toBeTruthy();
    expect(screen.getByText("500回")).toBeTruthy();

    await waitFor(() => expect(screen.getByText("1,650")).toBeTruthy()); // tokens合計（1000+100+500+50。costUsdと無関係）
    // 費用合計はcostUsdを持つ1件だけ（0.042。無い実行を0と偽装して合算しない）
    expect(screen.getByText("$0.042")).toBeTruthy();
    expect(screen.getByText("記録済みの1件のみ")).toBeTruthy();
    // 失敗した実行は合格と数えない（失敗・未判定=1件）
    expect(screen.getByText("1件")).toBeTruthy();
    // 監査の記録は理由コードの日本語で出る
    expect(screen.getByText("上限超過により、高価なAI呼び出しを停止")).toBeTruthy();
    expect(screen.getByText(`理由: AI呼び出しの1日の枠を超過・使用量が急増`)).toBeTruthy();
    expect(screen.getByText("高価なAI呼び出しの停止を解除")).toBeTruthy();
    // 自動通知が無いことの注記
    expect(screen.getByText(/上限の接近・超過は自動で通知されません/)).toBeTruthy();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("shows_admin_only_on_403_and_avoids_calls_until_mfa_ready", async () => {
    // 二要素未設定: 案内のみでAPIを呼ばない
    const fetchFn = stubFetch();
    const { unmount } = render(<OperationsPanel enabled={false} />);
    expect(screen.getByText(/二要素認証の設定が済むまで、この情報は表示できません/)).toBeTruthy();
    expect(fetchFn).not.toHaveBeenCalled();
    unmount();

    // 403（PER-08無し）: 案内だけを出し、壊れたように見せない
    stubFetch({ status: 403, body: { error: { code: "FORBIDDEN", message: "x", details: [] } } });
    render(<OperationsPanel enabled={true} />);
    await waitFor(() => expect(screen.getByText("この情報は管理者だけが表示できます。")).toBeTruthy());
  });
});
