import { z } from "zod";
import {
  Body, BusinessDate, Id, IdList, IDEM, Instant, Job, LIMITS, P_ID, Page, Question, Sha256, ShortText, Version,
  defineApi, listQuery, obj, provisionalDto, Reason,
} from "./common";
import { aiProposalStates, reviewDecisions } from "../states";

/**
 * AI分類（T053、docs/06 §2/§3）。分類の源（API-29の入力元）とJevの許可カテゴリ
 * （docs/06 §2のcriteriaどおり。states.tsではない＝状態でなく分類語彙）。
 */
export const classificationSourceTypes = ["facility_inspection", "asset_inspection", "issue"] as const;
export type ClassificationSourceType = (typeof classificationSourceTypes)[number];
export const classificationCategories = ["equipment_issue", "access_obstruction", "missing_equipment", "no_issue", "other"] as const;
export type ClassificationCategory = (typeof classificationCategories)[number];

/** Jevのusage（docs/06 §2「戻り値はmodel/answers/usage」。token数はモデル応答の実測をそのまま保存する） */
export const ClassificationUsage = obj({ promptTokens: z.number().int().min(0), completionTokens: z.number().int().min(0) });

/**
 * 分類候補の本体（ai_evaluations.output_json＝候補本体。最終事実ではない）。
 * needsReviewはJevのnoul（0〜1の保留度）そのもので、choiceのconfidenceを流用しない
 * （docs/06「confidenceを現実の異常確率/正答保証と表示しない」）。answersは生出力の監査用。
 * 人の確定分類はreview_decisions（T054）へ別保存する。
 */
export const ClassificationCandidateOutput = obj({
  categories: obj({
    representative: z.enum(classificationCategories),
    probabilities: z.partialRecord(z.enum(classificationCategories), z.number().min(0).max(1)).nullable(),
    multipleIssues: z.boolean(),
  }),
  needsReview: z.number().min(0).max(1),
  model: ShortText,
  questionVersion: ShortText,
  sourceVersion: Version,
  usage: ClassificationUsage.nullable(),
  answers: z.record(z.string(), z.unknown()),
});

/**
 * AI評価（docs/04:143 ai_evaluations。API-30の一覧要素）。outputJsonは候補本体、
 * usageJsonはtoken使用量。statusはdocs/11 AI提案の語彙（作成時は常にpending＝人未承認）。
 */
export const AiEvaluation = obj({
  id: Id,
  jobId: Id,
  sourceType: z.enum(classificationSourceTypes),
  sourceId: Id,
  sourceVersion: Version,
  inputHash: Sha256,
  inputSnapshotRef: ShortText.nullable(),
  questionVersion: ShortText,
  modelId: ShortText,
  actualModelVersion: ShortText.nullable(),
  outputJson: ClassificationCandidateOutput,
  status: z.enum(aiProposalStates),
  usageJson: ClassificationUsage.nullable(),
  createdAt: Instant,
});
export type AiEvaluationDto = z.infer<typeof AiEvaluation>;

export const ReviewInput = obj({
  version: Version,
  sourceVersion: Version,
  decision: z.enum(reviewDecisions),
  confirmedPayload: z.record(z.string(), z.unknown()),
  reviewNote: Body.optional(),
});

/**
 * AI評価の実行履歴（T061、docs/04 §3.4 155行 ai_evaluation_runs、API-88/89）。
 * labels/outputsは統計のみで**個人本文を複製しない**（失敗例はdataset行id参照＝failedCaseSamples.caseRef）。
 * metrics/gatePassed/statusで未実施・失敗を合格と表示しない（docs/06 §6、docs/14 D12）。
 */
export const evaluationKinds = ["classification", "report"] as const;
export type EvaluationKind = (typeof evaluationKinds)[number];

export const EvaluationFailureCase = obj({
  caseRef: ShortText,
  expected: ShortText,
  predicted: ShortText.nullable(),
  note: ShortText.nullable(),
});

/** 品質ゲートの判定（閾値はsrc/server/ai/evaluation.tsに事前固定。docs/06 §6のB案・docs/14 D12） */
export const EvaluationGate = obj({
  passed: z.boolean(),
  reasons: z.array(ShortText),
  thresholdVersion: ShortText,
});

/**
 * 評価指標（docs/16 T061「MetricsはmacroF1/needsReviewRecall/falseSafe/abstention/latencyP95/token/cost/failedCases」）。
 * nullは「この種別では測らない」（例: reportのmacroF1）か「測れなかった」（usage未知での費用等）。
 */
export const EvaluationMetrics = obj({
  macroF1: z.number().min(0).max(1).nullable(),
  needsReviewRecall: z.number().min(0).max(1).nullable(),
  /** 異常→no_issueの見逃し件数（docs/06 §6「見逃し0」。1件でもゲート不合格） */
  falseSafe: z.number().int().min(0),
  /** 保留率（要確認予測の割合。docs/06 §6「保留率」） */
  abstention: z.number().min(0).max(1).nullable(),
  latencyP95Ms: z.number().int().min(0),
  promptTokens: z.number().int().min(0),
  completionTokens: z.number().int().min(0),
  usageKnownCases: z.number().int().min(0),
  usageUnknownCases: z.number().int().min(0),
  /** 記録済みusageからの費用（USD）。単価が未固定（report）やusage未知ではnull（勝手に推計しない） */
  costUsd: z.number().min(0).nullable(),
  costSource: ShortText,
  /** 生成の捏造（数値不一致＋未知の事実。docs/06 §6「数値不一致0」） */
  fabricatedFacts: z.number().int().min(0),
  /** 未記載欄の補完（docs/06 §6「未記載事実補完0」） */
  completionOfMissing: z.number().int().min(0),
  /** 記録されたmissingFieldsがサーバー値の欠落と一致しない件数 */
  missingFieldsMismatches: z.number().int().min(0),
  failedCases: z.number().int().min(0),
  /** 失敗例（上限20件のサンプル。全件はai_evaluation_cases） */
  failedCaseSamples: z.array(EvaluationFailureCase),
  gate: EvaluationGate,
});
export type EvaluationMetricsDto = z.infer<typeof EvaluationMetrics>;

export const EvaluationRun = obj({
  id: Id,
  jobId: Id,
  kind: z.enum(evaluationKinds),
  datasetVersion: ShortText,
  questionVersion: ShortText,
  modelId: ShortText,
  datasetRef: ShortText,
  datasetSha256: Sha256,
  /** 失敗した実行は0（case数を数えられなかった）。成功した実行は1以上 */
  caseCount: z.number().int().min(0),
  labels: z.record(z.string(), z.unknown()),
  outputs: z.record(z.string(), z.unknown()),
  /** status=failedの実行はmetricsを持たない（未判定を合格と見せない） */
  metrics: EvaluationMetrics.nullable(),
  gatePassed: z.boolean().nullable(),
  status: z.enum(["succeeded", "failed"]),
  errorCode: ShortText.nullable(),
  runByUserId: Id,
  executedAt: Instant,
  createdAt: Instant,
});
export type EvaluationRunDto = z.infer<typeof EvaluationRun>;

export const Citation = obj({
  documentId: Id,
  documentVersionId: Id,
  chunkId: Id,
  pageNo: z.number().int().min(1).optional(),
  section: ShortText.optional(),
  quotedSpan: obj({ start: z.number().int().min(0), end: z.number().int().min(0) }),
});
export const RagAnswer = obj({ answer: z.string().min(1), citations: z.array(Citation), abstained: z.boolean() });

// bodyの形を保つ（T002時点の z.ZodObject 単独指定はoutputをunknownへ潰すため、
// API-29の実装（T053）でジェネリック化した。API-32/89も同じヘルパーを使う）
const jobRequest = <T extends z.ZodRawShape>(body: z.ZodObject<T>) => obj({ body, ...IDEM });
const jobResponse = Job;

export const aiApis = {
  "API-29": defineApi({
    method: "POST", path: "/ai/classifications", permission: "PER-09", kind: "job", success: [202],
    request: jobRequest(obj({ sourceType: z.enum(classificationSourceTypes), sourceId: Id, sourceVersion: Version, questionVersion: ShortText })),
    response: jobResponse,
  }),
  "API-30": defineApi({
    method: "GET", path: "/ai/reviews", permission: "PER-10", kind: "list", success: [200],
    request: obj({ query: listQuery({ status: z.enum(aiProposalStates).optional(), sourceType: z.enum(classificationSourceTypes).optional() }) }),
    response: Page(AiEvaluation),
  }),
  "API-31": defineApi({
    method: "POST", path: "/ai/reviews/:id/decision", permission: "PER-10", kind: "mutation", success: [200],
    request: obj({ params: P_ID, body: ReviewInput, ...IDEM }),
    response: z.looseObject({ effectIds: z.array(Id) }), provisional: true,
  }),
  "API-32": defineApi({
    method: "POST", path: "/reports/drafts", permission: "PER-09", kind: "job", success: [202],
    request: jobRequest(obj({ activityId: Id, resultVersion: Version, templateVersion: ShortText })),
    response: jobResponse,
  }),
  // 読取専用のPOST（検索）。永続変更を伴わないため Idempotency-Key は不要（docs/05 §2の「JSONの変更」に当たらない）。
  "API-76": defineApi({
    method: "POST", path: "/search/rag", permission: "PER-11/09", kind: "get", success: [200],
    request: obj({
      body: obj({
        query: Question, maxSources: z.number().int().min(1).max(20).optional(),
        documentIds: z.array(Id).min(1).max(LIMITS.arrayMax).optional(),
      }),
    }),
    response: RagAnswer,
  }),
  // AI提案(proposal)を保存するため Idempotency-Key を必須とする。書込の確定は人の承認(API-31)後。
  "API-77": defineApi({
    method: "POST", path: "/ai/assistant", permission: "PER-09", kind: "mutation", success: [200],
    request: obj({
      body: obj({ query: Question, contextRefs: z.array(obj({ type: ShortText, id: Id })).max(LIMITS.arrayMax) }),
      ...IDEM,
    }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-78": defineApi({
    method: "POST", path: "/patrol-plans", permission: "PER-14", kind: "mutation", success: [201],
    request: obj({
      body: obj({ facilityIds: IdList, date: BusinessDate, objective: ShortText }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-79": defineApi({
    method: "POST", path: "/patrol-plans/:id/decision", permission: "PER-14", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({ version: Version, orderedFacilityIds: IdList, decision: z.enum(["confirm", "cancel"]), reason: Reason }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-88": defineApi({
    method: "GET", path: "/ai/evaluation-runs", permission: "PER-08", kind: "list", success: [200],
    request: obj({ query: listQuery({ modelId: ShortText.optional(), datasetVersion: ShortText.optional() }) }),
    response: Page(EvaluationRun),
  }),
  "API-89": defineApi({
    method: "POST", path: "/ai/evaluation-runs", permission: "PER-08運用", kind: "job", success: [202],
    request: jobRequest(obj({ datasetVersion: ShortText, questionVersion: ShortText, modelId: ShortText })),
    response: jobResponse,
  }),
} as const;
