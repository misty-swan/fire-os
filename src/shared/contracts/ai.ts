import { z } from "zod";
import {
  Body, BusinessDate, Id, IdList, IDEM, Job, LIMITS, P_ID, Page, Question, ShortText, Version, defineApi, listQuery, obj,
  provisionalDto, Reason,
} from "./common";
import { aiProposalStates, reviewDecisions } from "../states";

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

const jobRequest = (body: z.ZodObject) => obj({ body, ...IDEM });
const jobResponse = Job;

export const aiApis = {
  "API-29": defineApi({
    method: "POST", path: "/ai/classifications", permission: "PER-09", kind: "job", success: [202],
    request: jobRequest(obj({ sourceType: ShortText, sourceId: Id, sourceVersion: Version, questionVersion: ShortText })),
    response: jobResponse,
  }),
  "API-30": defineApi({
    method: "GET", path: "/ai/reviews", permission: "PER-10", kind: "list", success: [200],
    request: obj({ query: listQuery({ status: z.enum(aiProposalStates).optional(), sourceType: ShortText.optional() }) }),
    response: Page(provisionalDto()), provisional: true,
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
