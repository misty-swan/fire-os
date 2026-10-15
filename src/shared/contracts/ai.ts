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

export const Citation = obj({
  documentId: Id,
  documentVersionId: Id,
  chunkId: Id,
  pageNo: z.number().int().min(1).optional(),
  section: ShortText.optional(),
  quotedSpan: obj({ start: z.number().int().min(0), end: z.number().int().min(0) }),
});
export const RagAnswer = obj({ answer: z.string(), citations: z.array(Citation), abstained: z.boolean() });

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
    response: Page(provisionalDto()), provisional: true,
  }),
  "API-89": defineApi({
    method: "POST", path: "/ai/evaluation-runs", permission: "PER-08運用", kind: "job", success: [202],
    request: jobRequest(obj({ datasetVersion: ShortText, questionVersion: ShortText, modelId: ShortText })),
    response: jobResponse,
  }),
} as const;
