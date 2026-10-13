import { z } from "zod";
import {
  Body, BusinessDate, Id, IdList, IdListMaybeEmpty, IDEM, Instant, LIMITS, NonNegative, P_ID, Page, Reason,
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
    request: obj({ body: ActivityInput, ...IDEM }), response: provisionalDto(), provisional: true,
  }),
  "API-07": defineApi({
    method: "GET", path: "/activities/:id", permission: "PER-01", kind: "get", success: [200],
    request: obj({ params: P_ID }), response: provisionalDto(), provisional: true,
  }),
  "API-08": defineApi({
    method: "PUT", path: "/activities/:id/attendance/me", permission: "PER-02", kind: "mutation", success: [200, 201],
    request: obj({
      params: P_ID,
      body: obj({ version: VersionOrZero, response: z.enum(attendanceResponses) }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
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
        reason: Reason.optional(),
      }).refine(endNotBeforeStart, orderMessage),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-40": defineApi({
    method: "POST", path: "/activities/:id/cancellation", permission: "PER-03", kind: "mutation", success: [200],
    request: obj({ params: P_ID, body: obj({ version: Version, reason: Reason }), ...IDEM }),
    response: provisionalDto(), provisional: true,
  }),
  "API-41": defineApi({
    method: "PUT", path: "/activities/:id/attendance/:memberId", permission: "PER-02代理許可", kind: "mutation", success: [200, 201],
    request: obj({
      params: obj({ id: Id, memberId: Id }),
      body: obj({ version: VersionOrZero, response: z.enum(attendanceResponses), reason: Reason }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
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
