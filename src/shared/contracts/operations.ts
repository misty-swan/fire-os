import { z } from "zod";
import {
  Body, BusinessDate, Id, IdList, IdListMaybeEmpty, IDEM, Instant, LIMITS, NonNegative, P_ID, Page, Reason, Reason2000,
  ShortText, Target, Title, Version, VersionOrZero, defineApi, listQuery, obj, provisionalDto,
} from "./common";
import {
  activityStates, actualParticipationStates, attendanceResponses, incidentKinds, incidentStates, mobilizationStates,
  taskStates,
} from "../states";

const activityShape = {
  title: Title,
  kind: ShortText,
  plannedStartsAt: Instant,
  locationText: ShortText,
  ownerMemberId: Id,
  audienceMemberIds: IdList,
  plannedEndsAt: Instant.optional(),
  responseDueAt: Instant.optional(),
};
const endNotBeforeStart = (v: { plannedStartsAt?: string; plannedEndsAt?: string }) =>
  !v.plannedStartsAt || !v.plannedEndsAt || v.plannedEndsAt >= v.plannedStartsAt;
const orderMessage = { message: "plannedEndsAt は plannedStartsAt 以降にしてください" };

export const ActivityInput = obj(activityShape).refine(endNotBeforeStart, orderMessage);

/**
 * 予定（docs/04 activities）。時刻はDB保存と同じ正規形（UTCミリ秒Z）。
 * operationIdは活動と出動で共用する出来事root（docs/04「共通出来事」）。取消でcountable=0（docs/11 §3）
 */
export const Activity = obj({
  id: Id,
  version: Version,
  operationId: Id,
  title: Title,
  kind: ShortText,
  plannedStartsAt: Instant,
  plannedEndsAt: Instant.nullable(),
  locationText: ShortText,
  ownerMemberId: Id,
  status: z.enum(activityStates),
  responseDueAt: Instant.nullable(),
  createdAt: Instant,
  updatedAt: Instant,
});
export type ActivityDto = z.infer<typeof Activity>;

/**
 * 出欠（docs/04:89 activity_attendance）。API-08/41の応答とAPI-07の可視行。
 * 行は(activity_id, member_id)で一意。未回答は行が無いことで表現し（初回回答はversion=0でINSERT）、
 * 取り下げはresponse=unanswered（docs/11 出欠「未回答は…未定と区別」、docs/05 §1）
 */
export const Attendance = obj({
  id: Id,
  version: Version,
  memberId: Id,
  response: z.enum(attendanceResponses),
  respondedAt: Instant.nullable(),
});
export type AttendanceDto = z.infer<typeof Attendance>;

/** 予定の詳細（API-07「可視出欠と現在実績を含む」）。実績の子Page（ActivityResult）はT037で接続する */
export const ActivityDetail = obj({
  ...Activity.shape,
  /** 対象者はsnapshot（activity_audience）。名簿変更で母数を変えない（docs/04） */
  audience: z.array(Id).max(LIMITS.arrayMax),
  attendance: z.array(Attendance).max(LIMITS.arrayMax),
  /** 現在実績。activity_resultsを作るAPI（API-09）はT037のため、接続までは常にnull */
  result: z.null(),
});
export type ActivityDetailDto = z.infer<typeof ActivityDetail>;

const actualShape = {
  content: Body,
  actualStartsAt: Instant.optional(),
  actualEndsAt: Instant.optional(),
  participants: z
    .array(
      obj({
        memberId: Id,
        actualStatus: z.enum(actualParticipationStates),
        individualStartsAt: Instant.optional(),
        individualEndsAt: Instant.optional(),
      }),
    )
    .max(LIMITS.arrayMax),
  attachmentIds: IdListMaybeEmpty,
};
export const ActualInput = obj(actualShape);

const ResourceUsage = obj({
  id: Id.optional(),
  target: Target,
  quantity: NonNegative,
  from: Instant.optional(),
  to: Instant.optional(),
});

export const operationsApis = {
  "API-05": defineApi({
    method: "GET", path: "/activities", permission: "PER-01", kind: "list", success: [200],
    request: obj({
      query: listQuery({
        from: Instant.optional(), to: Instant.optional(), kind: ShortText.optional(), memberId: Id.optional(),
        status: z.enum(activityStates).optional(), actual: z.stringbool().optional(),
      }),
    }),
    response: Page(provisionalDto()), provisional: true,
  }),
  "API-06": defineApi({
    method: "POST", path: "/activities", permission: "PER-03", kind: "mutation", success: [201],
    request: obj({ body: ActivityInput, ...IDEM }), response: Activity,
  }),
  "API-07": defineApi({
    method: "GET", path: "/activities/:id", permission: "PER-01", kind: "get", success: [200],
    request: obj({ params: P_ID }), response: ActivityDetail,
  }),
  "API-08": defineApi({
    method: "PUT", path: "/activities/:id/attendance/me", permission: "PER-02", kind: "mutation", success: [200, 201],
    request: obj({
      params: P_ID,
      body: obj({ version: VersionOrZero, response: z.enum(attendanceResponses) }),
      ...IDEM,
    }),
    response: Attendance,
  }),
  "API-09": defineApi({
    method: "POST", path: "/activities/:id/actual-results", permission: "PER-04", kind: "mutation", success: [201],
    request: obj({ params: P_ID, body: obj({ activityVersion: Version, ...actualShape }), ...IDEM }),
    response: provisionalDto(), provisional: true,
  }),
  "API-39": defineApi({
    method: "PATCH", path: "/activities/:id", permission: "PER-03", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({
        ...obj(activityShape).partial().shape,
        version: Version,
        status: z.enum(activityStates).optional(),
        // 開催状態の履歴（activity_events.reason、DBのCHECK ≤2000）に揃える。公開済の変更は理由必須（docs/11）
        reason: Reason2000.optional(),
      }).refine(endNotBeforeStart, orderMessage),
      ...IDEM,
    }),
    response: Activity,
  }),
  "API-40": defineApi({
    method: "POST", path: "/activities/:id/cancellation", permission: "PER-03", kind: "mutation", success: [200],
    // 中止理由はactivity_events.reason（DBのCHECK ≤2000）に揃える。出欠は保持し、通知は別承認（docs/05）
    request: obj({ params: P_ID, body: obj({ version: Version, reason: Reason2000 }), ...IDEM }),
    response: Activity,
  }),
  "API-41": defineApi({
    method: "PUT", path: "/activities/:id/attendance/:memberId", permission: "PER-02代理許可", kind: "mutation", success: [200, 201],
    request: obj({
      params: obj({ id: Id, memberId: Id }),
      body: obj({ version: VersionOrZero, response: z.enum(attendanceResponses), reason: Reason }),
      ...IDEM,
    }),
    response: Attendance,
  }),
  "API-42": defineApi({
    method: "POST", path: "/activities/:id/actual-results/corrections", permission: "PER-04", kind: "mutation", success: [201],
    request: obj({ params: P_ID, body: obj({ resultVersion: Version, ...actualShape, reason: Reason }), ...IDEM }),
    response: provisionalDto(), provisional: true,
  }),
  "API-43": defineApi({
    method: "GET", path: "/activities/:id/actual-results", permission: "PER-01", kind: "get", success: [200],
    request: obj({ params: P_ID, query: obj({ revision: z.coerce.number().int().min(1).optional() }) }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-21": defineApi({
    method: "GET", path: "/incidents", permission: "PER-01", kind: "list", success: [200],
    request: obj({
      query: listQuery({
        kind: z.enum(incidentKinds).optional(), from: Instant.optional(), to: Instant.optional(),
        status: z.enum(incidentStates).optional(),
      }),
    }),
    response: Page(provisionalDto()), provisional: true,
  }),
  "API-22": defineApi({
    method: "POST", path: "/incidents", permission: "PER-04", kind: "mutation", success: [201],
    request: obj({
      body: obj({
        kind: z.enum(incidentKinds), occurredAt: Instant, summary: Body, activityId: Id.optional(),
        resourceUsages: z.array(ResourceUsage).max(LIMITS.arrayMax).optional(),
      }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-23": defineApi({
    method: "PUT", path: "/incidents/:id/participants/:memberId", permission: "PER-04", kind: "mutation", success: [200, 201],
    request: obj({
      params: obj({ id: Id, memberId: Id }),
      body: obj({
        version: VersionOrZero,
        attendanceStatus: z.enum(mobilizationStates),
        times: obj({ mobilizedAt: Instant.optional(), arrivedAt: Instant.optional(), returnedAt: Instant.optional() }).optional(),
        reason: Reason.optional(),
      }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-69": defineApi({
    method: "PATCH", path: "/incidents/:id", permission: "PER-04", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({
        version: Version, status: z.enum(incidentStates).optional(), kind: z.enum(incidentKinds).optional(),
        summary: Body.optional(), reason: Reason,
      }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-70": defineApi({
    method: "GET", path: "/incidents/:id", permission: "PER-01限定", kind: "get", success: [200],
    request: obj({ params: P_ID }), response: z.looseObject({}), provisional: true,
  }),
  "API-71": defineApi({
    method: "PUT", path: "/incidents/:id/activity", permission: "PER-04", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({
        version: Version, activityId: Id, activityVersion: Version,
        operationVersions: z.record(Id, Version), reason: Reason,
      }),
      ...IDEM,
    }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-57": defineApi({
    method: "PUT", path: "/operations/:id/resource-usages", permission: "PER-04", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({ version: Version, usages: z.array(ResourceUsage).max(LIMITS.arrayMax), reason: Reason }),
      ...IDEM,
    }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-28": defineApi({
    method: "GET", path: "/dashboard", permission: "PER-01", kind: "get", success: [200],
    request: obj({ query: obj({ period: ShortText.optional() }) }), response: z.looseObject({}), provisional: true,
  }),
  "API-52": defineApi({
    method: "GET", path: "/analytics", permission: "PER-01", kind: "get", success: [200],
    request: obj({
      query: obj({
        from: Instant.optional(), to: Instant.optional(), fiscalYear: z.coerce.number().int().min(2000).max(2200).optional(),
        memberId: Id.optional(), kind: ShortText.optional(),
      }),
    }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-68": defineApi({
    method: "POST", path: "/tasks", permission: "PER-04/10", kind: "mutation", success: [201],
    request: obj({
      body: obj({
        title: Title, assigneeMemberId: Id.optional(), dueDate: BusinessDate.optional(), sourceDecisionId: Id.optional(),
      }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-87": defineApi({
    method: "PATCH", path: "/tasks/:id", permission: "PER-04/10", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({
        version: Version, status: z.enum(taskStates).optional(), assigneeMemberId: Id.nullable().optional(), reason: Reason,
      }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
} as const;
