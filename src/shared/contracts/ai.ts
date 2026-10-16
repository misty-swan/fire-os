import { z } from "zod";
import {
  Body, BusinessDate, Id, IdList, IDEM, Instant, Job, LIMITS, P_ID, Page, Question, Sha256, ShortText, Title, Version,
  defineApi, listQuery, obj, Reason,
} from "./common";
import { notificationSourceTypes } from "./content";
import { aiProposalStates, notificationChannels, reviewDecisions } from "../states";

/**
 * AI分類（T053、docs/06 §2/§3）。分類の源（API-29の入力元）とJevの許可カテゴリ
 * （docs/06 §2のcriteriaどおり。states.tsではない＝状態でなく分類語彙）。
 */
export const classificationSourceTypes = ["facility_inspection", "asset_inspection", "issue"] as const;
export type ClassificationSourceType = (typeof classificationSourceTypes)[number];

/**
 * ai_evaluations.source_typeの全体集合（docs/04:144。T068で'assistant'を追加）。
 * 分類API-29の入力はclassificationSourceTypesのまま（横断提案の源は'assistant'1種）。
 */
export const aiSourceTypes = [...classificationSourceTypes, "assistant"] as const;
export type AiSourceType = (typeof aiSourceTypes)[number];

/**
 * 横断assistantが読み取れる記録の種別（API-77のcontextRefs・提案のreferences/readResultsの語彙。T068）。
 * 既存の読取経路（業務service・検索port）と同じ認可関数で読む。期限（inspection_due_detections）は
 * 単一件の読取契約が無いため含めない（docs/16 T068に記録）。
 */
export const assistantReadingTypes = ["facility_inspection", "asset_inspection", "issue", "activity", "document"] as const;
export type AssistantReadingType = (typeof assistantReadingTypes)[number];
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

/** 提案の根拠（読み取った記録の参照。点検=series版・異常/活動=行のversion・文書=revision_no。T068）。
 *  承認（API-31）のstale検査はこの版集合と現行版の一致で行う（docs/16 T068）。 */
export const ProposalReference = obj({ type: z.enum(assistantReadingTypes), id: Id, version: Version });
export type ProposalReferenceDto = z.infer<typeof ProposalReference>;

/** 読み取り結果の要約（最小化本文。氏名・連絡先を含めない＝docs/14 D12。ai_evaluations.output_jsonに保存する） */
export const AssistantReadResult = obj({
  type: z.enum(assistantReadingTypes),
  id: Id,
  version: Version,
  summary: z.string().min(1).max(2000),
});
export type AssistantReadResultDto = z.infer<typeof AssistantReadResult>;

/**
 * AIの書込提案（実行はしない。kindはtask/notification draftの許可enumだけ＝docs/05 API-77行。
 * 形はAPI-31のconfirmedPayload.task/.notificationと同じ＝承認画面がそのまま確定予定値として使える）。
 */
export const AssistantProposedEffect = z.discriminatedUnion("kind", [
  obj({
    kind: z.literal("task"),
    title: Title,
    assigneeMemberId: Id.optional(),
    dueDate: BusinessDate.nullable().optional(),
  }),
  obj({
    kind: z.literal("notification"),
    source: obj({ type: z.enum(notificationSourceTypes), id: Id }),
    body: Body.optional(),
    audienceMemberIds: z.array(Id).max(LIMITS.arrayMax).optional(),
    channels: z.array(z.enum(notificationChannels)).min(1).max(10),
    expiresAt: Instant.nullable().optional(),
  }),
]);
export type AssistantProposedEffectDto = z.infer<typeof AssistantProposedEffect>;

/**
 * assistant源のoutput_json本体（ai_evaluations。T068）。references＝参照した記録の版集合、
 * readResults＝読み取り結果の要約（本文は最小化）、proposedEffects＝書込候補（許可enumだけ）。
 * 構造検証（応答schema・referencesが入力した集合の部分集合・proposedEffectsが許可enum内）を
 * 通った出力だけを保存する（検証前の出力はどこにも保存しない＝T057/T067流儀）。
 */
export const AssistantCandidateOutput = obj({
  answer: z.string().min(1),
  references: z.array(ProposalReference).max(LIMITS.arrayMax),
  readResults: z.array(AssistantReadResult).max(LIMITS.arrayMax),
  proposedEffects: z.array(AssistantProposedEffect).max(10),
  questionVersion: ShortText,
  sourceVersion: Version,
  model: ShortText.nullable(),
  usage: ClassificationUsage.nullable(),
});

/**
 * API-77の応答（provisional解除・T068）。proposalIdはai_evaluationsの行ID。
 * 保留（根拠0件・生成応答の検証不可）は proposalId=null のabstained応答で、行も提案も作らない。
 */
export const AssistantProposal = obj({
  proposalId: Id.nullable(),
  answer: z.string().min(1),
  references: z.array(ProposalReference).max(LIMITS.arrayMax),
  readResults: z.array(AssistantReadResult).max(LIMITS.arrayMax),
  proposedEffects: z.array(AssistantProposedEffect).max(10),
  abstained: z.boolean(),
});
export type AssistantProposalDto = z.infer<typeof AssistantProposal>;

/**
 * AI評価（docs/04:143 ai_evaluations。API-30の一覧要素）。outputJsonは候補本体、
 * usageJsonはtoken使用量。statusはdocs/11 AI提案の語彙（作成時は常にpending＝人未承認）。
 * sourceTypeでoutputJsonの形が変わる（discriminated union）: 分類源はClassificationCandidateOutput、
 * assistant源（T068）はAssistantCandidateOutput。
 */
const AiEvaluationBase = {
  id: Id,
  jobId: Id,
  // sourceIdは枝ごとに型が違う（下のunion）: 分類源=対象記録のId〔小文字UUID〕、
  // assistant源=`query:<質問本文のsha256>`の合成キー（docs/05 API-77行どおり。UUIDでない）。
  // assistant枝をIdのままにすると、assistant行が1件あるunitでAPI-30の一覧のtoDtoが落ちて
  // 500になる（T070で発覚・assistant_rows_do_not_break_the_api_30_listで担保）
  sourceVersion: Version,
  inputHash: Sha256,
  inputSnapshotRef: ShortText.nullable(),
  questionVersion: ShortText,
  modelId: ShortText,
  actualModelVersion: ShortText.nullable(),
  status: z.enum(aiProposalStates),
  usageJson: ClassificationUsage.nullable(),
  createdAt: Instant,
};
export const AiEvaluation = z.discriminatedUnion("sourceType", [
  obj({ ...AiEvaluationBase, sourceType: z.enum(classificationSourceTypes), sourceId: Id, outputJson: ClassificationCandidateOutput }),
  obj({ ...AiEvaluationBase, sourceType: z.literal("assistant"), sourceId: ShortText, outputJson: AssistantCandidateOutput }),
]);
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

/**
 * 巡回計画（T071、docs/04:157「patrol_plans/patrol_plan_stops」、docs/05 API-78/79、docs/11 巡回計画）。
 * plan側status（draft/confirmed/cancelled。confirmed・cancelledは終端＝docs/16 T071の裁定）、
 * stop側はplan内でposition一意（順序一意）・facility重複なし。決定（確定/取消）の時刻decidedAtは
 * draftではnull。facilityNameは管理番号か識別名（DBのCHECKでどちらか必須）、緯度経度は候補施設の座標。
 */
export const patrolPlanStates = ["draft", "confirmed", "cancelled"] as const;
export type PatrolPlanState = (typeof patrolPlanStates)[number];
export const PatrolStop = obj({
  facilityId: Id,
  position: z.number().int().min(1),
  facilityName: z.string().min(1),
  latitude: z.number(),
  longitude: z.number(),
});
export type PatrolStop = z.infer<typeof PatrolStop>;
export const PatrolPlan = obj({
  id: Id,
  version: Version,
  date: BusinessDate,
  objective: ShortText,
  status: z.enum(patrolPlanStates),
  stops: z.array(PatrolStop).min(1),
  decidedAt: Instant.nullable(),
  createdAt: Instant,
  updatedAt: Instant,
});
export type PatrolPlan = z.infer<typeof PatrolPlan>;

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
    request: obj({ query: listQuery({ status: z.enum(aiProposalStates).optional(), sourceType: z.enum(aiSourceTypes).optional() }) }),
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
  // 応答はAssistantProposal（T068でprovisional解除。contextRefsのtypeは読取語彙のenum＝未知種別は400）
  "API-77": defineApi({
    method: "POST", path: "/ai/assistant", permission: "PER-09", kind: "mutation", success: [200],
    request: obj({
      body: obj({
        query: Question,
        contextRefs: z.array(obj({ type: z.enum(assistantReadingTypes), id: Id })).max(LIMITS.arrayMax),
      }),
      ...IDEM,
    }),
    response: AssistantProposal,
  }),
  "API-78": defineApi({
    method: "POST", path: "/patrol-plans", permission: "PER-14", kind: "mutation", success: [201],
    request: obj({
      body: obj({ facilityIds: IdList, date: BusinessDate, objective: ShortText }),
      ...IDEM,
    }),
    // T071でprovisional解除（docs/04:157・docs/05 API-78行）。stopsはサーバーが最近傍順で提案する
    response: PatrolPlan,
  }),
  "API-79": defineApi({
    method: "POST", path: "/patrol-plans/:id/decision", permission: "PER-14", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({ version: Version, orderedFacilityIds: IdList, decision: z.enum(["confirm", "cancel"]), reason: Reason }),
      ...IDEM,
    }),
    // T071でprovisional解除（docs/04:157・docs/05 API-79行）
    response: PatrolPlan,
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
