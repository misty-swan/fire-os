import type { EvaluationKind } from "../../shared/contracts/ai";
import {
  classificationCategories,
  EvaluationFailureCase,
  type EvaluationMetricsDto,
} from "../../shared/contracts/ai";
import { z } from "zod";
import { LLM_MODEL, REPORT_PROMPT_VERSION, detectFabrications, type ReportGenerationInput } from "./llm";
import { JEV_MODEL } from "./jev";
import { ANOMALY_CATEGORIES, QUESTION_VERSION } from "./questions";
import type { AppEnv } from "../env";
import { canonicalJson, sha256Hex } from "../mutations/hash";
import { registerJobHandler } from "../jobs/runner";
import type { JobOutcome, LeasedJob } from "../jobs/store";

/**
 * AI評価の固定holdout実行（T061、docs/06 §6、docs/14 D12、docs/08 CT-17/AT-AI-05）。
 *
 * - **局所完了の範囲**: 実AIは使えない（D12未了承・localにAI binding無し＝docs/evidence/V04-jev.md/V04-llm.md）。
 *   そのため評価は「コミット済みの固定holdout（tests/fixtures/ai/*.jsonl。人手ラベル＋記録済みの予測）を
 *   再計算する」形で実装し、指標・ゲート判定・保存・表示を完全にする。**実モデルでの実行はV04の未実施手順**で、
 *   記録済み出力の再計算を「実測」として表示しない（docs/evidence/ai-evaluation.mdに実行前の手順を記録）。
 * - datasetは scripts/generate-ai-holdout.ts が決定的に生成し、生成物をコミットする（再現可能）。
 *   sha256を実行ごとに保存して、同じdatasetの再計算であることを保証する。
 * - **閾値はコードに事前固定**（下のQUALITY_GATE_THRESHOLDS。docs/06 §6のB案・docs/14 D12推奨案）。
 *   評価後に都合よく変更しない。1件でも異常→no_issueの見逃しがあれば不合格（falseSafeMax=0）。
 * - outputsに個人本文を複製しない（docs/04:155「個人本文最小化」）: 保存するのは統計とdataset行idだけ。
 * - RAG評価は後続タスク（AI-06）で追加する。
 */

// --- dataset（コミット済みfixture。生成スクリプトが書いた同一内容のTSモジュールをimportする。
// 正本は同名の.jsonl（人間が読む・試験が一致を検証）。サーバーモジュールからtests/を跨ぐimportは
// vitest workers環境でモジュール解決が不安定になるため、実行時はsrc内の生成モジュールを使う
// （docs/16 T061に記録）） ---

import { classificationHoldoutJsonl } from "./dataset/classification-holdout";
import { reportHoldoutJsonl } from "./dataset/report-holdout";

export const CLASSIFICATION_DATASET_VERSION = "classification-holdout-v1";
export const REPORT_DATASET_VERSION = "report-holdout-v1";

const DATASETS: Record<string, { kind: EvaluationKind; text: string; ref: string }> = {
  [CLASSIFICATION_DATASET_VERSION]: {
    kind: "classification",
    text: classificationHoldoutJsonl,
    ref: `tests/fixtures/ai/classification-holdout.jsonl@${CLASSIFICATION_DATASET_VERSION}`,
  },
  [REPORT_DATASET_VERSION]: {
    kind: "report",
    text: reportHoldoutJsonl,
    ref: `tests/fixtures/ai/report-holdout.jsonl@${REPORT_DATASET_VERSION}`,
  },
};

export const kindOfDatasetVersion = (datasetVersion: string): EvaluationKind | null =>
  DATASETS[datasetVersion]?.kind ?? null;

// --- 品質ゲートの閾値（docs/06 §6のB案・docs/14 D12推奨案。**評価前に事前固定し、評価後に変更しない**） ---

export const QUALITY_GATE_THRESHOLDS = {
  /** 閾値の版（出典の記録。値を変えるときはこの版を進め、docs/evidence/ai-evaluation.mdに理由を残す） */
  thresholdVersion: "b-plan-2026-10-16",
  /** Jev代表分類: macro F1 >= 0.85（docs/06 §6「B案」） */
  macroF1Min: 0.85,
  /** 要確認（needsReview）再現率 >= 0.95（docs/06 §6「B案」） */
  needsReviewRecallMin: 0.95,
  /** 異常→no_issueの見逃しは1件でも不合格（docs/06 §6「見逃し0」） */
  falseSafeMax: 0,
  /** LLM下書き: 捏造（数値不一致・未知の事実）は1件でも不合格（docs/06 §6「数値不一致0」） */
  reportFabricatedFactsMax: 0,
  /** 未記載欄の補完は1件でも不合格（docs/06 §6「未記載事実補完0」） */
  reportCompletionOfMissingMax: 0,
  /** 記録のmissingFieldsがサーバー値の欠落と一致しない件数の上限（記録の正直さの検査） */
  reportMissingFieldsMismatchesMax: 0,
} as const;

/**
 * 要確認（noul）を判定値に変えるための閾値。**D12未決**のため0.5を評価用の検証設定として
 * 事前固定したもの（表示はT053どおりnoulそのものを行い、この閾値は評価の集計だけに使う。
 * 評価後に都合よく変更しない。確定はD12/V04）。
 */
export const NEEDS_REVIEW_EVAL_THRESHOLD = 0.5;

/**
 * Jevの定価（docs/06 §2「入力$0.042/100万tokens・出力$0」。検証設定としての固定で、実請求の実測はV04）。
 * report（LLM）の単価は未固定（docs/14 D16）のため費用を計算せずnullにする（勝手に推計しない）。
 */
const JEV_INPUT_USD_PER_MTOKEN = 0.042;
const JEV_OUTPUT_USD_PER_MTOKEN = 0;
export const JEV_COST_SOURCE =
  "docs/06 §2 Jev定価（検証設定）: 入力$0.042/100万tokens・出力$0。実請求の実測はV04（未実施）";
export const REPORT_COST_SOURCE = "単価未固定（docs/14 D16・V04）。tokensの記録のみ";

// --- dataset行の検証（コミット済みfixtureをそのまま信じない。形が違えば評価を失敗させる） ---

const usageSchema = z.object({ promptTokens: z.number().int().min(0), completionTokens: z.number().int().min(0) });

export const ClassificationCaseRow = z.object({
  id: z.string().min(1).max(100),
  kind: z.literal("classification"),
  input: z.object({ note: z.string().min(1), items: z.array(z.object({ code: z.string(), result: z.string() })).min(1) }),
  expectedLabel: z.string().min(1).max(100),
  expectedNeedsReview: z.boolean(),
  recordedOutput: z.object({
    questionVersion: z.string().min(1).max(100),
    modelId: z.string().min(1).max(200),
    choice: z.string().min(1).max(100),
    probabilities: z.record(z.string(), z.number().min(0).max(1)).nullable(),
    needsReview: z.number().min(0).max(1),
    usage: usageSchema.nullable(),
    latencyMs: z.number().int().min(0),
  }),
});
export type ClassificationCase = z.infer<typeof ClassificationCaseRow>;

export const ReportCaseRow = z.object({
  id: z.string().min(1).max(100),
  kind: z.literal("report"),
  input: z.object({
    title: z.string(),
    content: z.string(),
    participantCount: z.number().int().min(0).nullable(),
    actualStartHourJst: z.number().int().min(0).max(23).nullable(),
    actualEndHourJst: z.number().int().min(0).max(23).nullable(),
  }),
  expected: z.object({ mustNotStateUnknownFacts: z.literal(true) }),
  recordedOutput: z.object({
    questionVersion: z.string().min(1).max(100),
    modelId: z.string().min(1).max(200),
    text: z.string().min(1),
    missingFields: z.array(z.string().min(1).max(100)),
    usage: usageSchema.nullable(),
    latencyMs: z.number().int().min(0),
  }),
});
export type ReportCase = z.infer<typeof ReportCaseRow>;

/** datasetが読めない・形が違う・記録済み出力が無いときの評価失敗（jobのerror_code/failed行になる短い理由） */
export class EvaluationDatasetError extends Error {
  constructor(
    public readonly reason: "dataset_version_unknown" | "question_version_unknown" | "no_recorded_outputs" | "dataset_invalid",
  ) {
    super(`evaluation dataset error: ${reason}`);
  }
}

function parseLines<T extends z.ZodType>(schema: T, text: string, file: string): z.infer<T>[] {
  const rows: z.infer<T>[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = schema.safeParse(JSON.parse(line));
    if (!parsed.success) throw new EvaluationDatasetError("dataset_invalid");
    rows.push(parsed.data);
  }
  if (rows.length === 0) throw new EvaluationDatasetError("dataset_invalid");
  return rows;
}

// --- 評価（Interface: evaluateRun(input): Promise<EvaluationMetrics>） ---

export interface EvaluationInput {
  kind: EvaluationKind;
  datasetVersion: string;
  questionVersion: string;
  modelId: string;
}

export interface EvaluationDatasetResult {
  metrics: EvaluationMetricsDto;
  /** docs/04:155「labels:J」人手ラベルの統計 */
  labels: Record<string, unknown>;
  /** docs/04:155「outputs:J」記録済み予測の統計（本文は含まない） */
  outputs: Record<string, unknown>;
}

interface FailureSample {
  caseRef: string;
  expected: string;
  predicted: string | null;
  note: string;
}

/** 失敗例サンプルの上限（全件はai_evaluation_casesに保存する） */
const MAX_FAILED_SAMPLES = 20;

const latencyP95 = (latencies: number[]): number => {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(sorted.length * 0.95))) - 1]!;
};

const tally = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** 分類holdoutの評価（docs/06 §6のJev代表分類行。誤分類・未知usage・確率未記録・見逃しをそのまま数える） */
export function evaluateClassificationDataset(rows: ClassificationCase[]): EvaluationDatasetResult {
  // dataset内の記録は1つの（質問版, モデル）の組でなければ混在評価になる。違っていればdataset_invalid
  for (const r of rows) {
    if (r.recordedOutput.questionVersion !== QUESTION_VERSION || r.recordedOutput.modelId !== JEV_MODEL) {
      throw new EvaluationDatasetError("dataset_invalid");
    }
  }
  const perClass: Record<string, { tp: number; fp: number; fn: number }> = {};
  let tpReview = 0, fnReview = 0, fpReview = 0;
  let falseSafe = 0;
  const latencies: number[] = [];
  let promptTokens = 0, completionTokens = 0, usageKnown = 0, usageUnknown = 0, probabilitiesMissing = 0;
  const expectedLabels: Record<string, number> = {};
  const predictedLabels: Record<string, number> = {};
  const failures: FailureSample[] = [];

  // ラベルはJevの許可カテゴリちょうど。語彙外の記録は別の質問版の出力混在の疑いがあるためdataset_invalid
  const isCategory = (v: string): boolean => (classificationCategories as readonly string[]).includes(v);
  for (const r of rows) {
    if (!isCategory(r.expectedLabel) || !isCategory(r.recordedOutput.choice)) {
      throw new EvaluationDatasetError("dataset_invalid");
    }
  }

  for (const r of rows) {
    const predicted = r.recordedOutput.choice;
    tally(expectedLabels, r.expectedLabel);
    tally(predictedLabels, predicted);
    const cell = (perClass[r.expectedLabel] ??= { tp: 0, fp: 0, fn: 0 });
    const predictedCell = (perClass[predicted] ??= { tp: 0, fp: 0, fn: 0 });
    if (predicted === r.expectedLabel) {
      cell.tp++;
    } else {
      cell.fn++;
      predictedCell.fp++;
      // 異常→no_issueの見逃しは誤分類の中でも別枠で数える（docs/06 §6「見逃し0」。1件でもゲート不合格）。
      // 1ケースの失敗例は1行（UNIQUE(run, case)）にするため、見逃しはmisclassifiedの代わりにfalse_safeとして記録する
      const isFalseSafe = (ANOMALY_CATEGORIES as readonly string[]).includes(r.expectedLabel) && predicted === "no_issue";
      falseSafe += isFalseSafe ? 1 : 0;
      failures.push({ caseRef: r.id, expected: r.expectedLabel, predicted, note: isFalseSafe ? "false_safe" : "misclassified" });
    }
    // 要確認（needsReview）の再現率。閾値はNEEDS_REVIEW_EVAL_THRESHOLD（D12未決の検証設定。上の注記）
    const predictedReview = r.recordedOutput.needsReview >= NEEDS_REVIEW_EVAL_THRESHOLD;
    if (r.expectedNeedsReview && predictedReview) tpReview++;
    else if (r.expectedNeedsReview) fnReview++;
    else if (predictedReview) fpReview++;
    if (r.recordedOutput.probabilities === null) probabilitiesMissing++; // 確率が無い（複数異常フラグを計算できない記録）
    latencies.push(r.recordedOutput.latencyMs);
    if (r.recordedOutput.usage) {
      promptTokens += r.recordedOutput.usage.promptTokens;
      completionTokens += r.recordedOutput.usage.completionTokens;
      usageKnown++;
    } else {
      usageUnknown++; // usage未知（未知usageの記録）。token/費用の合算から外して既知件数を明示する
    }
  }

  const f1s: number[] = [];
  for (const c of Object.keys(perClass)) {
    const { tp, fp, fn } = perClass[c]!;
    const p = tp + fp > 0 ? tp / (tp + fp) : 0;
    const r = tp + fn > 0 ? tp / (tp + fn) : 0;
    f1s.push(p + r > 0 ? (2 * p * r) / (p + r) : 0);
  }
  const macroF1 = f1s.reduce((a, b) => a + b, 0) / f1s.length;
  const needsReviewRecall = tpReview + fnReview > 0 ? tpReview / (tpReview + fnReview) : null;
  const abstention = (tpReview + fpReview) / rows.length;
  const costUsd = usageKnown > 0 ? (promptTokens * JEV_INPUT_USD_PER_MTOKEN + completionTokens * JEV_OUTPUT_USD_PER_MTOKEN) / 1_000_000 : null;

  // ゲート判定（閾値は事前固定。理由は画面にそのまま出す）
  const reasons: string[] = [];
  if (macroF1 < QUALITY_GATE_THRESHOLDS.macroF1Min) reasons.push(`macro_f1_below_${QUALITY_GATE_THRESHOLDS.macroF1Min}`);
  if (needsReviewRecall !== null && needsReviewRecall < QUALITY_GATE_THRESHOLDS.needsReviewRecallMin) {
    reasons.push(`needs_review_recall_below_${QUALITY_GATE_THRESHOLDS.needsReviewRecallMin}`);
  }
  if (falseSafe > QUALITY_GATE_THRESHOLDS.falseSafeMax) reasons.push(`false_safe_over_${QUALITY_GATE_THRESHOLDS.falseSafeMax}`);

  const metrics: EvaluationMetricsDto = {
    macroF1,
    needsReviewRecall,
    falseSafe,
    abstention,
    latencyP95Ms: latencyP95(latencies),
    promptTokens,
    completionTokens,
    usageKnownCases: usageKnown,
    usageUnknownCases: usageUnknown,
    costUsd,
    costSource: JEV_COST_SOURCE,
    fabricatedFacts: 0,
    completionOfMissing: 0,
    missingFieldsMismatches: 0,
    failedCases: failures.length,
    failedCaseSamples: failures.slice(0, MAX_FAILED_SAMPLES).map((f) => EvaluationFailureCase.parse(f)),
    gate: { passed: reasons.length === 0, reasons, thresholdVersion: QUALITY_GATE_THRESHOLDS.thresholdVersion },
  };
  return {
    metrics,
    labels: { expectedLabels, expectedNeedsReview: tpReview + fnReview, caseCount: rows.length },
    outputs: {
      predictedLabels,
      needsReviewPredicted: tpReview + fpReview,
      usageKnownCases: usageKnown,
      usageUnknownCases: usageUnknown,
      probabilitiesMissingCases: probabilitiesMissing,
    },
  };
}

/** 記録済みの報告書下書きをT057と同じ捏造検出（detectFabrications）に掛けるための最小限の入力 */
function reportCaseToGenerationInput(r: ReportCase): ReportGenerationInput {
  const jst = (h: number | null) => (h === null ? null : `2026-10-01 ${String(h).padStart(2, "0")}:00`);
  return {
    template: { version: "evaluation", title: "evaluation", sourceRef: "evaluation", fictionalNote: "evaluation" },
    activity: { title: r.input.title, kind: "訓練", locationText: "架空市", plannedStartsAtJst: null },
    result: {
      content: r.input.content,
      actualStartsAtJst: jst(r.input.actualStartHourJst),
      actualEndsAtJst: jst(r.input.actualEndHourJst),
    },
    serverValues: { participantCount: r.input.participantCount, resourceSummary: null },
    missingValues: [],
    sourceVersions: { activityVersion: 1, resultVersion: 1, resultRevisionNo: 1 },
    sourceVersion: 1,
  };
}

/** 報告書下書きholdoutの評価（docs/06 §6のLLM下書き行。捏造0・未記載補完0を記録済み出力で検査する） */
export function evaluateReportDataset(rows: ReportCase[]): EvaluationDatasetResult {
  for (const r of rows) {
    if (r.recordedOutput.questionVersion !== REPORT_PROMPT_VERSION || r.recordedOutput.modelId !== LLM_MODEL) {
      throw new EvaluationDatasetError("dataset_invalid");
    }
  }
  const latencies: number[] = [];
  let promptTokens = 0, completionTokens = 0, usageKnown = 0, usageUnknown = 0;
  let fabricatedFacts = 0, completionOfMissing = 0, missingFieldsMismatches = 0, injectedNotes = 0;
  let missingParticipant = 0, missingStart = 0, missingEnd = 0;
  const failures: FailureSample[] = [];

  for (const r of rows) {
    latencies.push(r.recordedOutput.latencyMs);
    if (r.recordedOutput.usage) {
      promptTokens += r.recordedOutput.usage.promptTokens;
      completionTokens += r.recordedOutput.usage.completionTokens;
      usageKnown++;
    } else {
      usageUnknown++;
    }
    if (r.input.participantCount === null) missingParticipant++;
    if (r.input.actualStartHourJst === null) missingStart++;
    if (r.input.actualEndHourJst === null) missingEnd++;
    if (r.input.content.includes("【指示】")) injectedNotes++;

    // 記録済み出力を捏造検出に掛ける（判定ロジックは生成時（T057）と同じもの。評価側で別の緩い検査を作らない）
    const facts = detectFabrications(r.recordedOutput.text, reportCaseToGenerationInput(r));
    fabricatedFacts += facts.length;
    if (facts.length > 0) failures.push({ caseRef: r.id, expected: "no_fabrication", predicted: "fabricated", note: "fabricated_facts" });
    // 欠落欄の補完: サーバー値に無い人数・時刻を出力に書くことは「補完」でもある（null欄に何か書いた）
    for (const fact of facts) {
      if (fact.startsWith("participant_count:") && r.input.participantCount === null) completionOfMissing++;
      if (fact.startsWith("time:")) {
        const knownHours = new Set(
          [r.input.actualStartHourJst, r.input.actualEndHourJst].filter((h): h is number => h !== null),
        );
        const hour = Number(fact.split(":")[1]);
        if (!knownHours.has(hour)) completionOfMissing++;
      }
    }
    // 記録の正直さ: missingFieldsがサーバー値の欠落と一致しているか（一致しない記録は失敗例）
    const expectedMissing = [
      ...(r.input.participantCount === null ? ["participantCount"] : []),
      ...(r.input.actualStartHourJst === null ? ["actualStartsAt"] : []),
      ...(r.input.actualEndHourJst === null ? ["actualEndsAt"] : []),
    ].sort();
    if (JSON.stringify(expectedMissing) !== JSON.stringify([...r.recordedOutput.missingFields].sort())) {
      missingFieldsMismatches++;
      failures.push({ caseRef: r.id, expected: expectedMissing.join("+") || "none", predicted: r.recordedOutput.missingFields.join("+") || "none", note: "missing_fields_mismatch" });
    }
  }

  const reasons: string[] = [];
  if (fabricatedFacts > QUALITY_GATE_THRESHOLDS.reportFabricatedFactsMax) reasons.push("fabricated_facts_over_0");
  if (completionOfMissing > QUALITY_GATE_THRESHOLDS.reportCompletionOfMissingMax) reasons.push("completion_of_missing_over_0");
  if (missingFieldsMismatches > QUALITY_GATE_THRESHOLDS.reportMissingFieldsMismatchesMax) reasons.push("missing_fields_mismatch_over_0");

  const metrics: EvaluationMetricsDto = {
    macroF1: null,
    needsReviewRecall: null,
    falseSafe: 0,
    abstention: null,
    latencyP95Ms: latencyP95(latencies),
    promptTokens,
    completionTokens,
    usageKnownCases: usageKnown,
    usageUnknownCases: usageUnknown,
    costUsd: null, // LLMの単価は未固定（docs/14 D16）。勝手に推計しない
    costSource: REPORT_COST_SOURCE,
    fabricatedFacts,
    completionOfMissing,
    missingFieldsMismatches,
    failedCases: failures.length,
    failedCaseSamples: failures.slice(0, MAX_FAILED_SAMPLES).map((f) => EvaluationFailureCase.parse(f)),
    gate: { passed: reasons.length === 0, reasons, thresholdVersion: QUALITY_GATE_THRESHOLDS.thresholdVersion },
  };
  return {
    metrics,
    labels: {
      caseCount: rows.length,
      missingParticipantCount: missingParticipant,
      missingStartHourCount: missingStart,
      missingEndHourCount: missingEnd,
      injectedNoteCount: injectedNotes,
    },
    outputs: { usageKnownCases: usageKnown, usageUnknownCases: usageUnknown },
  };
}

/**
 * dataset版→評価の実行（Interface。コミット済みholdoutを読み、質問版/モデル版の一致を検査してから計算する。
 * 記録済み出力が無いモデルは評価せず no_recorded_outputs（黙って別モデルの記録を使わない）。
 */
export async function evaluateRun(input: EvaluationInput): Promise<EvaluationMetricsDto> {
  return (await evaluateDataset(input)).metrics;
}

export async function evaluateDataset(input: EvaluationInput): Promise<EvaluationDatasetResult> {
  const dataset = DATASETS[input.datasetVersion];
  if (!dataset) throw new EvaluationDatasetError("dataset_version_unknown");
  if (dataset.kind !== input.kind) throw new EvaluationDatasetError("dataset_invalid");
  const expectedQuestion = dataset.kind === "classification" ? QUESTION_VERSION : REPORT_PROMPT_VERSION;
  const expectedModel = dataset.kind === "classification" ? JEV_MODEL : LLM_MODEL;
  if (input.questionVersion !== expectedQuestion) throw new EvaluationDatasetError("question_version_unknown");
  if (input.modelId !== expectedModel) throw new EvaluationDatasetError("no_recorded_outputs");
  const rows =
    dataset.kind === "classification"
      ? parseLines(ClassificationCaseRow, dataset.text, dataset.ref)
      : parseLines(ReportCaseRow, dataset.text, dataset.ref);
  return dataset.kind === "classification"
    ? evaluateClassificationDataset(rows as ClassificationCase[])
    : evaluateReportDataset(rows as ReportCase[]);
}

// --- 保存（evaluation.run job。metrics/失敗例をai_evaluation_runs/ai_evaluation_casesへ1つのbatchで確定） ---

/** 失敗例の保存上限（metrics.failedCasesは全件数。行は上位のみ。恣意的な除外に使わない＝noteで全件数を明示） */
const MAX_CASE_ROWS = 100;

interface RunRowInput {
  job: LeasedJob;
  input: EvaluationInput;
  datasetSha256: string;
  result: EvaluationDatasetResult | null;
  errorCode: string | null;
}

async function persistRunRow(env: AppEnv, row: RunRowInput): Promise<string> {
  const id = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const dataset = DATASETS[row.input.datasetVersion]!;
  const statements = [
    env.DB.prepare(
      "INSERT INTO ai_evaluation_runs (id, unit_id, kind, dataset_version, question_version, model_id, dataset_ref, dataset_sha256, case_count, labels_json, outputs_json, metrics_json, gate_passed, status, error_code, job_id, run_by_user_id, actor_kind, executed_at, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human', ?, ?)",
    ).bind(
      id,
      row.job.unitId,
      row.input.kind,
      row.input.datasetVersion,
      row.input.questionVersion,
      row.input.modelId,
      dataset.ref,
      row.datasetSha256,
      row.result ? Number(row.result.labels.caseCount ?? 0) : 0,
      canonicalJson(row.result?.labels ?? {}),
      canonicalJson(row.result?.outputs ?? {}),
      row.result ? canonicalJson(row.result.metrics) : null,
      row.result ? (row.result.metrics.gate.passed ? 1 : 0) : null,
      row.result ? "succeeded" : "failed",
      row.errorCode,
      row.job.id,
      row.job.requestedBy,
      nowIso,
      nowIso,
    ),
  ];
  // 失敗例（全件数はmetrics.failedCases。行は上限まで。本文は複製せずdataset行idだけ）
  if (row.result && row.result.metrics.failedCases > 0) {
    for (const sample of row.result.metrics.failedCaseSamples.slice(0, MAX_CASE_ROWS)) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO ai_evaluation_cases (id, unit_id, run_id, case_ref, expected, predicted, passed, latency_ms, note, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)",
        ).bind(crypto.randomUUID(), row.job.unitId, id, sample.caseRef, sample.expected, sample.predicted, sample.note, nowIso),
      );
    }
  }
  await env.DB.batch(statements);
  return id;
}

/**
 * 評価job（API-89が登録する kind=evaluation.run）。AI呼出しはしない（記録済み出力の再計算）。
 * 質問版が廃止されていればstale、dataset不明はmanual_review、記録済み出力が無いモデルは
 * failed行を残してmanual_review（**失敗・未判定を合格と表示しない**）。
 */
export async function evaluationRunJob(job: LeasedJob, env: AppEnv): Promise<JobOutcome> {
  // 同じjobの再実行は既存のrunを返す（UNIQUE(unit_id, job_id)の前の保険。T053と同じ流儀）
  const existing = await env.DB.prepare("SELECT id FROM ai_evaluation_runs WHERE unit_id = ? AND job_id = ?")
    .bind(job.unitId, job.id).first<{ id: string }>();
  if (existing) return { kind: "succeeded", resultRef: `evaluation_run:${existing.id}` };

  const datasetVersion = job.sourceId;
  const questionVersion = job.configVersion;
  // dedupe_key=`unit|evaluation.run|datasetVersion|questionVersion|modelId`。modelIdはこのkeyで運ぶ（jobsの列に空きが無いため）
  const modelId = job.dedupeKey.split("|").slice(4).join("|") || "unknown";
  const kind = kindOfDatasetVersion(datasetVersion);
  if (!kind) return { kind: "manual_review", errorCode: "dataset_version_unknown" }; // dataset自体が不明。run行は作れない
  const input: EvaluationInput = { kind, datasetVersion, questionVersion, modelId };
  const dataset = DATASETS[datasetVersion]!;
  const datasetSha256 = await sha256Hex(dataset.text);

  let result: EvaluationDatasetResult;
  try {
    result = await evaluateDataset(input);
  } catch (err) {
    if (err instanceof EvaluationDatasetError) {
      if (err.reason === "question_version_unknown") return { kind: "stale", errorCode: err.reason };
      // 記録済み出力が無い/壊れている → 失敗として記録（合格ではない）。人の確認（manual_review）へ
      await persistRunRow(env, { job, input, datasetSha256, result: null, errorCode: err.reason });
      return { kind: "manual_review", errorCode: err.reason };
    }
    throw err; // runnerがretryable handler_errorにする
  }
  const id = await persistRunRow(env, { job, input, datasetSha256, result, errorCode: null });
  return { kind: "succeeded", resultRef: `evaluation_run:${id}` };
}

// job登録（Cron/Queueと同じ登録点。routes/ai-evaluation.ts経由でWorkerに読み込まれる）
registerJobHandler("evaluation.run", evaluationRunJob);
