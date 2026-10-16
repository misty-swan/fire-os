import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CLASSIFICATION_DATASET_VERSION,
  NEEDS_REVIEW_EVAL_THRESHOLD,
  QUALITY_GATE_THRESHOLDS,
  REPORT_DATASET_VERSION,
  evaluateClassificationDataset,
  evaluateReportDataset,
} from "../src/server/ai/evaluation";
import { LLM_MODEL, REPORT_PROMPT_VERSION } from "../src/server/ai/llm";
import { JEV_MODEL } from "../src/server/ai/jev";
import { QUESTION_VERSION } from "../src/server/ai/questions";
import { runDueJobs } from "../src/server/jobs/runner";
import type { EvaluationMetricsDto } from "../src/shared/contracts/ai";
import { classificationHoldoutJsonl as runtimeClassification } from "../src/server/ai/dataset/classification-holdout";
import { reportHoldoutJsonl as runtimeReport } from "../src/server/ai/dataset/report-holdout";
import type { Identity } from "./helpers/fixture";
import classificationJsonl from "./fixtures/ai/classification-holdout.jsonl";
import reportJsonl from "./fixtures/ai/report-holdout.jsonl";
import { classificationHoldoutJsonl } from "./fixtures/ai/generated-classification-holdout";
import { reportHoldoutJsonl } from "./fixtures/ai/generated-report-holdout";
import { createFixture, type TestFixture } from "./helpers/fixture";

/**
 * AI評価の固定holdout実行と品質ゲート（T061、docs/06 §6、docs/14 D12、docs/08 CT-17/AT-AI-05）。
 *
 * - datasetはコミット済みの架空fixture（scripts/generate-ai-holdout.tsが決定的に生成。人手ラベル＋記録済みの予測）。
 *   **実AIは使わない**: 評価job（evaluation.run）は記録済み出力の再計算で、実モデルでの実行はV04の未実施手順
 *   （docs/evidence/ai-evaluation.md）。偽の品質数値を実測として作らない。
 * - 閾値（0.85/0.95/見逃し0）はsrc/server/ai/evaluation.tsに事前固定（D12のB案）。評価後に変更しない。
 * - 異常→no_issueの見逃しは1件でも不合格（oneFalseSafeRun）。
 */

let fx: TestFixture;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

beforeEach(async () => {
  // 他の試験のjobを拾わないよう、未完了のjobを全て取消す（tests/jev.test.tsと同じ流儀）
  await env.DB.prepare(
    "UPDATE jobs SET status = 'cancelled', lease_token = NULL, lease_until = NULL WHERE status IN ('queued', 'running', 'retry_wait')",
  ).run();
  // jobの受付時刻（next_attempt_at）はenqueueJobの既定＝実時刻で記録されるため、runner用の
  // 固定クロックは実時刻より先に置く（固定日付のままでは実時刻がその日時を追い越した以降、
  // jobが永遠に未到来になりrunDueJobsが何もleaseしなくなる。2026-10-16T00:00Z固定で発生）
  fx.clock.set(new Date(Date.now() + 3_600_000).toISOString()); // 実時刻+1時間
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) =>
  (await r.json()) as {
    data?: unknown;
    error?: { code: string; details?: { field: string; reason: string }[] };
    meta?: { requestId: string; nextCursor?: string };
  };

/** 評価jobはenv.AIを使わない（記録済み出力の再計算）。待機中のjobを消化する */
const runJobs = async () => runDueJobs(env, { clock: fx.clock, maxJobs: 5 });

const postRun = async (who: Identity, body: Record<string, unknown>) =>
  fx.client(who).request("POST", "/api/v1/ai/evaluation-runs", body, idem());

interface RunRow {
  id: string;
  job_id: string;
  kind: string;
  dataset_version: string;
  model_id: string;
  dataset_sha256: string;
  case_count: number;
  labels_json: string;
  outputs_json: string;
  metrics_json: string | null;
  gate_passed: number | null;
  status: string;
  error_code: string | null;
  run_by_user_id: string;
}

const runRowOf = async (jobId: string): Promise<RunRow> =>
  (await env.DB.prepare("SELECT * FROM ai_evaluation_runs WHERE job_id = ?").bind(jobId).first<RunRow>())!;
const metricsOf = (row: RunRow): EvaluationMetricsDto => JSON.parse(row.metrics_json!) as EvaluationMetricsDto;
const passedOf = (row: RunRow): boolean | null => (row.gate_passed === null ? null : row.gate_passed === 1);

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const classificationRows = classificationJsonl
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as {
    id: string;
    kind: string;
    input: { note: string; items: { code: string; result: string }[] };
    expectedLabel: string;
    expectedNeedsReview: boolean;
    recordedOutput: {
      questionVersion: string; modelId: string; choice: string;
      probabilities: Record<string, number> | null; needsReview: number;
      usage: { promptTokens: number; completionTokens: number } | null; latencyMs: number;
    };
  });
const reportRows = reportJsonl
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as {
    id: string;
    kind: string;
    input: { title: string; participantCount: number | null; actualStartHourJst: number | null; actualEndHourJst: number | null; content: string };
    expected: { mustNotStateUnknownFacts: true };
    recordedOutput: { questionVersion: string; modelId: string; text: string; missingFields: string[]; usage: { promptTokens: number; completionTokens: number } | null; latencyMs: number };
  });

/** 生成スクリプトの固定seedで作ったfixtureが勝手に変わっていないことの保証（再現性） */
const FIXTURE_SHA256 = {
  classification: "67d6e457cd003b840f57dd3ee4e79ed7bbd72b54c8fefb14a2f0b286c22d45a0",
  report: "6f3260c47de719422cf047f55f409c99f906b67bf89b34fcd5748de43bae0d38",
};

const ANOMALIES = ["equipment_issue", "access_obstruction", "missing_equipment"];

describe("AI評価の固定holdout実行と品質ゲート (T061)", () => {
  it("holdout_fixtures_are_committed_and_versioned", async () => {
    expect(classificationRows.length).toBeGreaterThanOrEqual(200); // docs/06 §6「最低200例」
    for (const label of [...ANOMALIES, "no_issue", "other"]) {
      expect(classificationRows.filter((r) => r.expectedLabel === label).length, `${label}の代表クラス`).toBeGreaterThanOrEqual(30);
    }
    expect(reportRows.length).toBe(50); // docs/06 §6「50実績相当」
    // 記録済み出力の質問版/モデル版はサーバー固定の値と一致する（別の版の記録を混在させない）
    for (const r of classificationRows) {
      expect(r.recordedOutput.questionVersion).toBe(QUESTION_VERSION);
      expect(r.recordedOutput.modelId).toBe(JEV_MODEL);
    }
    for (const r of reportRows) {
      expect(r.recordedOutput.questionVersion).toBe(REPORT_PROMPT_VERSION);
      expect(r.recordedOutput.modelId).toBe(LLM_MODEL);
    }
    // 誤分類・未知usage・確率未記録・要確認・見逃しを含む（ブリーフの入力要件）
    expect(classificationRows.some((r) => r.recordedOutput.choice !== r.expectedLabel)).toBe(true);
    expect(classificationRows.some((r) => r.recordedOutput.usage === null)).toBe(true);
    expect(classificationRows.some((r) => r.recordedOutput.probabilities === null)).toBe(true);
    expect(classificationRows.some((r) => r.expectedNeedsReview)).toBe(true);
    expect(classificationRows.some((r) => r.recordedOutput.choice === "no_issue" && ANOMALIES.includes(r.expectedLabel))).toBe(true);
    // 報告書は人数/時刻の欠落と指示注入を含む
    expect(reportRows.some((r) => r.input.participantCount === null)).toBe(true);
    expect(reportRows.some((r) => r.input.actualEndHourJst === null)).toBe(true);
    expect(reportRows.some((r) => r.input.content.includes("【指示】"))).toBe(true);
    // 生成物のハッシュ（再現性。生成スクリプトやseedを変えたら意図として更新する）
    expect(await sha256Hex(classificationJsonl)).toBe(FIXTURE_SHA256.classification);
    expect(await sha256Hex(reportJsonl)).toBe(FIXTURE_SHA256.report);
    // 実行時にimportするTSモジュール（生成物）は正本の.jsonlと完全に一致する（手で編集したら落ちる）
    expect(classificationHoldoutJsonl).toBe(classificationJsonl);
    expect(reportHoldoutJsonl).toBe(reportJsonl);
    expect(runtimeClassification).toBe(classificationJsonl);
    expect(runtimeReport).toBe(reportJsonl);
  });

  it("quality_gate_fails_on_one_abnormal_to_no_issue_case", async () => {
    const admin = fx.units.a.people.admin;

    // --- ① 分類holdout（300件）の評価を実行（API-89。202=受付で完了ではない） ---
    const postClassification = await postRun(admin, {
      datasetVersion: CLASSIFICATION_DATASET_VERSION,
      questionVersion: QUESTION_VERSION,
      modelId: JEV_MODEL,
    });
    expect(postClassification.status).toBe(202); // 未接続ならここが404≠202で赤
    const classificationJobId = (((await json(postClassification)).data!) as { id: string }).id;

    // --- ② 報告書holdout（50件）も同じ要領で実行する（RAGは後続タスク） ---
    const postReport = await postRun(admin, {
      datasetVersion: REPORT_DATASET_VERSION,
      questionVersion: REPORT_PROMPT_VERSION,
      modelId: LLM_MODEL,
    });
    expect(postReport.status).toBe(202);
    const reportJobId = (((await json(postReport)).data!) as { id: string }).id;

    await runJobs(); // 評価jobはAIを使わないため、どのrunnerが拾っても同じ結果になる

    // --- ゲート値（docs/06 §6のB案。閾値はsrc/server/ai/evaluation.tsに事前固定） ---
    const classificationRow = await runRowOf(classificationJobId);
    const classificationGate = metricsOf(classificationRow);
    expect(classificationRow.status).toBe("succeeded");
    expect(classificationGate.macroF1).toBeGreaterThanOrEqual(0.85);
    expect(classificationGate.needsReviewRecall).toBeGreaterThanOrEqual(0.95);
    // datasetには異常→no_issueの見逃し2件を含める（docs/06 §6「見逃し0」のため、この系列は**不合格**。合格と表示しない実例）
    expect(classificationGate.falseSafe).toBe(2);
    expect(passedOf(classificationRow)).toBe(false);
    expect(classificationGate.gate.reasons).toContain("false_safe_over_0");
    // 統計・費用・遅延も保存する（token/cost/p95。usage未知の件数を明示）
    expect(classificationGate.usageUnknownCases).toBe(10);
    expect(classificationGate.usageKnownCases).toBe(290);
    expect(classificationGate.promptTokens).toBeGreaterThan(0);
    expect(classificationGate.costUsd).toBeGreaterThan(0); // Jev定価（docs/06 §2・検証設定）での算出
    expect(classificationGate.latencyP95Ms).toBeGreaterThan(0);
    expect(classificationGate.abstention).toBeGreaterThan(0);
    // datasetの再現性（同じsha256の固定集合の再計算であることを保存する）
    expect(classificationRow.dataset_sha256).toBe(FIXTURE_SHA256.classification);
    expect(classificationRow.case_count).toBe(300);
    // 失敗例を恣意的に除外しない（誤分類10＋見逃し2が失敗例として保存される）
    const classificationCases = await fx.rows("ai_evaluation_cases", { run_id: classificationRow.id });
    expect(classificationCases.length).toBe(12);
    expect(classificationCases.filter((c) => c.note === "false_safe").length).toBe(2);

    // --- 報告書holdout: 捏造0・未記載補完0（docs/06 §6「未記載事実補完0、数値不一致0」） ---
    const reportRow = await runRowOf(reportJobId);
    const reportGate = metricsOf(reportRow);
    expect(reportRow.status).toBe("succeeded");
    expect(reportGate.fabricatedFacts).toBe(0);
    expect(reportGate.completionOfMissing).toBe(0);
    expect(passedOf(reportRow)).toBe(true);
    // LLMの単価は未固定（D16/V04）。勝手に推計しない（tokensは記録する）
    expect(reportGate.costUsd).toBe(null);
    expect(reportGate.promptTokens).toBeGreaterThan(0);
    expect(reportGate.latencyP95Ms).toBeGreaterThan(0);

    // --- 1件の異常→no_issueでゲートが落ちること（docs/14 D12「見逃し0」の事前固定の効きの確認） ---
    const restored = classificationRows.map((r) =>
      ANOMALIES.includes(r.expectedLabel) && r.recordedOutput.choice === "no_issue"
        ? { ...r, recordedOutput: { ...r.recordedOutput, choice: r.expectedLabel } }
        : r,
    );
    expect(restored.some((r) => ANOMALIES.includes(r.expectedLabel) && r.recordedOutput.choice === "no_issue")).toBe(false);
    const target = restored.find((r) => ANOMALIES.includes(r.expectedLabel) && r.recordedOutput.choice !== "no_issue")!;
    const oneFalseSafeDataset = restored.map((r) =>
      r.id === target.id ? { ...r, recordedOutput: { ...r.recordedOutput, choice: "no_issue" } } : r,
    );
    const oneFalseSafeRun = evaluateClassificationDataset(
      oneFalseSafeDataset.map((r) => ({ ...r, kind: "classification" as const })),
    );
    expect(oneFalseSafeRun.metrics.falseSafe).toBe(1);
    expect(oneFalseSafeRun.metrics.gate.passed).toBe(false); // 1件でも見逃しがあれば不合格

    // --- outputsに個人本文を複製しない（docs/04:155「個人本文最小化」。保存は統計と行id参照だけ） ---
    const storedJson = JSON.stringify([classificationRow.labels_json, classificationRow.outputs_json, classificationRow.metrics_json]);
    for (const r of classificationRows.slice(0, 30)) {
      expect(storedJson.includes(r.input.note.slice(0, 10))).toBe(false);
    }
    const caseRefs = await env.DB.prepare("SELECT case_ref FROM ai_evaluation_cases WHERE run_id = ?")
      .bind(classificationRow.id).all<{ case_ref: string }>();
    for (const c of caseRefs.results) expect(c.case_ref).toMatch(/^c-\d{4}$/);
  });

  it("unknown_versions_are_rejected_and_unrecorded_model_fails_honestly", async () => {
    const admin = fx.units.a.people.admin;
    // 未知のdataset版・質問版は400（黙って別の設定で評価しない）
    const badDataset = await postRun(admin, { datasetVersion: "no-such-dataset-v9", questionVersion: QUESTION_VERSION, modelId: JEV_MODEL });
    expect(badDataset.status).toBe(400);
    expect(((await json(badDataset)).error?.details ?? [])[0]?.reason).toBe("unknown_dataset_version");
    const badQuestion = await postRun(admin, { datasetVersion: CLASSIFICATION_DATASET_VERSION, questionVersion: "v999", modelId: JEV_MODEL });
    expect(badQuestion.status).toBe(400);
    expect(((await json(badQuestion)).error?.details ?? [])[0]?.reason).toBe("unknown_question_version");
    // 非管理者は403（PER-08。画面の出し分けと別にサーバーが拒否する）
    const forbidden = await postRun(fx.units.a.people.member, { datasetVersion: CLASSIFICATION_DATASET_VERSION, questionVersion: QUESTION_VERSION, modelId: JEV_MODEL });
    expect(forbidden.status).toBe(403);

    // 記録済み出力が無いモデルは評価できない。**失敗として記録し（gate_passed=NULL）、合格と表示しない**
    const unrecorded = await postRun(admin, { datasetVersion: CLASSIFICATION_DATASET_VERSION, questionVersion: QUESTION_VERSION, modelId: "other-model/v9" });
    expect(unrecorded.status).toBe(202);
    const jobId = (((await json(unrecorded)).data!) as { id: string }).id;
    await runJobs();
    const row = await runRowOf(jobId);
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("no_recorded_outputs");
    expect(row.gate_passed).toBe(null);
    expect(row.metrics_json).toBe(null);
    expect(row.case_count).toBe(0);
    // 同じ（dataset, 質問版, モデル）の再依頼は同じjob（dedupe）
    const again = await postRun(admin, { datasetVersion: CLASSIFICATION_DATASET_VERSION, questionVersion: QUESTION_VERSION, modelId: "other-model/v9" });
    expect(again.status).toBe(202);
    expect((((await json(again)).data!) as { id: string }).id).toBe(jobId);
  });

  it("evaluation_runs_are_listed_with_filters_and_keyset", async () => {
    const admin = fx.units.a.people.admin;
    const first = await fx.client(admin).request("GET", "/api/v1/ai/evaluation-runs?limit=2");
    expect(first.status).toBe(200);
    const firstBody = (await json(first)) as { data: { id: string }[]; meta?: { nextCursor?: string } };
    expect(firstBody.data.length).toBe(2);
    expect(firstBody.meta?.nextCursor).toBeTruthy();
    // 続き取得（keyset。改変cursorは409）
    const second = await fx.client(admin).request("GET", `/api/v1/ai/evaluation-runs?limit=2&cursor=${firstBody.meta!.nextCursor}`);
    expect(second.status).toBe(200);
    const secondBody = (await json(second)) as { data: { id: string }[]; meta?: { nextCursor?: string } };
    const ids = new Set(firstBody.data.map((r) => r.id));
    for (const r of secondBody.data) expect(ids.has(r.id)).toBe(false);
    const tampered = await fx.client(admin).request("GET", `/api/v1/ai/evaluation-runs?limit=2&cursor=${firstBody.meta!.nextCursor!.slice(0, -2)}xx`);
    expect(tampered.status).toBe(409);
    // フィルタ（modelId/datasetVersion）
    const byDataset = await fx.client(admin).request("GET", `/api/v1/ai/evaluation-runs?datasetVersion=${REPORT_DATASET_VERSION}`);
    const byDatasetBody = (await json(byDataset)) as { data: { datasetVersion: string; kind: string }[] };
    expect(byDatasetBody.data.length).toBeGreaterThan(0);
    for (const r of byDatasetBody.data) {
      expect(r.datasetVersion).toBe(REPORT_DATASET_VERSION);
      expect(r.kind).toBe("report");
    }
    const byModel = await fx.client(admin).request("GET", `/api/v1/ai/evaluation-runs?modelId=${JEV_MODEL}`);
    const byModelBody = (await json(byModel)) as { data: { modelId: string; gatePassed: boolean | null }[] };
    expect(byModelBody.data.length).toBeGreaterThan(0);
    for (const r of byModelBody.data) expect(r.modelId).toBe(JEV_MODEL);
    // DTOがgate_passed=NULL（失敗/未判定）をそのまま運ぶ（合格と表示しないための材料）
    const all = (await json(await fx.client(admin).request("GET", "/api/v1/ai/evaluation-runs"))) as { data: { gatePassed: boolean | null; status: string }[] };
    expect(all.data.some((r) => r.gatePassed === null && r.status === "failed")).toBe(true);
  });

  it("fabricated_and_incomplete_recordings_fail_the_report_gate", async () => {
    // 検出が空振りでないことの確認（変異テスト）。記録に捏造を1つ差し込むとゲートが落ちる
    const target = reportRows[0]!;
    const tampered = reportRows.map((r) =>
      r.id === target.id
        ? { ...r, recordedOutput: { ...r.recordedOutput, text: `${r.recordedOutput.text}参加は50名だった。` } }
        : r,
    );
    const result = evaluateReportDataset(tampered.map((r) => ({ ...r, kind: "report" as const })));
    expect(result.metrics.fabricatedFacts).toBeGreaterThanOrEqual(1);
    expect(result.metrics.gate.passed).toBe(false);
    expect(result.metrics.gate.reasons).toContain("fabricated_facts_over_0");
    // 欠落欄の補完も「未記載事実補完」として別枠で数える
    const missingTarget = reportRows.find((r) => r.input.participantCount === null)!;
    const completed = reportRows.map((r) =>
      r.id === missingTarget.id
        ? { ...r, recordedOutput: { ...r.recordedOutput, text: `${r.recordedOutput.text}参加は3名だった。` } }
        : r,
    );
    const completedResult = evaluateReportDataset(completed.map((r) => ({ ...r, kind: "report" as const })));
    expect(completedResult.metrics.completionOfMissing).toBeGreaterThanOrEqual(1);
    // 見逃し閾値の定数も事前固定であること（評価後に都合よく変えない設計の確認）
    expect(QUALITY_GATE_THRESHOLDS.macroF1Min).toBe(0.85);
    expect(QUALITY_GATE_THRESHOLDS.needsReviewRecallMin).toBe(0.95);
    expect(QUALITY_GATE_THRESHOLDS.falseSafeMax).toBe(0);
    expect(NEEDS_REVIEW_EVAL_THRESHOLD).toBe(0.5);
  });
});
