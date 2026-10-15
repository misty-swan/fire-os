import { z } from "zod";
import {
  Body, BusinessDate, Id, IdList, IdListMaybeEmpty, IDEM, Instant, LIMITS, P_ID, Page, Reason, Reason2000,
  ShortText, Target, Title, Version, VersionOrZero, defineApi, listQuery, obj, provisionalDto,
} from "./common";
import {
  activityStates, actualParticipationStates, attendanceResponses, incidentKinds, incidentStates, mobilizationStates,
  resourceUsageStates, taskStates,
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

/**
 * 実参加の1行（docs/04:93 activity_actual_participants）。
 * 出欠(Attendance)とは別物で、回答を実参加へコピーしない（docs/11 実参加行）。
 * 個人時間は全体時間と別列。不明はNULL（docs/05 §3「未知時刻は欠落表示」）
 */
export const ActivityResultParticipant = obj({
  memberId: Id,
  actualStatus: z.enum(actualParticipationStates),
  individualStartsAt: Instant.nullable(),
  individualEndsAt: Instant.nullable(),
});
export type ActivityResultParticipantDto = z.infer<typeof ActivityResultParticipant>;

/**
 * 実績の版（docs/04:92 activity_result_revisions）。訂正は新revisionを作り原本は不変（docs/11 §3）。
 * 訂正版だけsupersedesId（訂正元）とcorrectionReason（理由必須）を持つ
 */
export const ActivityResultRevision = obj({
  id: Id,
  resultId: Id,
  revisionNo: z.number().int().min(1),
  actualStartsAt: Instant.nullable(),
  actualEndsAt: Instant.nullable(),
  content: Body,
  supersedesId: Id.nullable(),
  correctionReason: Reason2000.nullable(),
  participants: z.array(ActivityResultParticipant).max(LIMITS.arrayMax),
  createdAt: Instant,
});
export type ActivityResultRevisionDto = z.infer<typeof ActivityResultRevision>;

/**
 * 実績root（docs/04:91 activity_results）。activity_id UNIQUE（1活動1実績。docs/05 API-09「未作成のみ」）。
 * currentRevisionは現在の訂正版へのポインタ。API-09/42の応答とAPI-07の詳細に載る
 */
export const ActivityResult = obj({
  id: Id,
  activityId: Id,
  version: Version,
  currentRevisionId: Id,
  currentRevision: ActivityResultRevision,
  createdAt: Instant,
  updatedAt: Instant,
});
export type ActivityResultDto = z.infer<typeof ActivityResult>;

/** 実績と全版（API-43。docs/05:96「ActivityResult＋revisions」。revision?で旧版も取得可） */
export const ActivityResultHistory = obj({
  result: ActivityResult,
  revisions: z.array(ActivityResultRevision).min(1).max(LIMITS.arrayMax),
});
export type ActivityResultHistoryDto = z.infer<typeof ActivityResultHistory>;

/** 予定の詳細（API-07「可視出欠と現在実績を含む」）。実績未作成の活動はresult=null（docs/05 §1） */
export const ActivityDetail = obj({
  ...Activity.shape,
  /** 対象者はsnapshot（activity_audience）。名簿変更で母数を変えない（docs/04） */
  audience: z.array(Id).max(LIMITS.arrayMax),
  attendance: z.array(Attendance).max(LIMITS.arrayMax),
  /** 現在実績（activity_results。未作成はnull） */
  result: ActivityResult.nullable(),
});
export type ActivityDetailDto = z.infer<typeof ActivityDetail>;

/**
 * 出動（docs/04:94 incidents、docs/11 出動イベントrecording行、docs/14 D08）。
 * 種別（kind=模擬/訓練/実出動記録の区分）と状態（status=recording→active/closed/voided。incidentTransitions。
 * closed→recordingは訂正、voidedは終端）は別契約。正式な指令系とは接続せず出動命令も自動発行しない
 * （docs/11「正式指令を発行しない」）。登録者・発生日時・概要を記録する
 */
export const Incident = obj({
  id: Id,
  version: Version,
  /** 出来事root（operations。kind='incident'）。活動と共用し、出動別/合算集計はdistinct operationId */
  operationId: Id,
  /** 関連付けた既存活動（docs/04 activity_id UNIQUE。1活動に1出動。未リンクはnull） */
  activityId: Id.nullable(),
  kind: z.enum(incidentKinds),
  occurredAt: Instant,
  summary: Body,
  status: z.enum(incidentStates),
  /** 登録者（作成した操作の利用者ID。issuesのreportedByと同じ扱い） */
  createdBy: Id,
  createdAt: Instant,
  updatedAt: Instant,
});
export type IncidentDto = z.infer<typeof Incident>;

/** 参集の1行（docs/04:96 incident_participants）。書込はAPI-23（T041）。API-70の詳細に載る。
 * 行の無い状態がunconfirmed（未確認）で、returnedは帰還記録（docs/11。出欠のabsentとは別） */
export const IncidentParticipant = obj({
  id: Id,
  version: Version,
  memberId: Id,
  attendanceStatus: z.enum(mobilizationStates),
  /** 個人の時刻。不明はNULL（docs/05 §3「未知時刻は欠落表示」） */
  mobilizedAt: Instant.nullable(),
  arrivedAt: Instant.nullable(),
  returnedAt: Instant.nullable(),
});
export type IncidentParticipantDto = z.infer<typeof IncidentParticipant>;

/** 出動の履歴1行（docs/04:95 incident_events「種別訂正/操作元を保持」。before/afterは状態・種別など小さな値） */
export const IncidentEvent = obj({
  id: Id,
  action: ShortText,
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
  reason: Reason2000.nullable(),
  createdAt: Instant,
});
export type IncidentEventDto = z.infer<typeof IncidentEvent>;

/**
 * 使用履歴1行の入力（docs/04:100、docs/05 API-22/57。docs/11 §3「在庫を自動減算しない」）。
 * idがあればその既存行の更新、無ければ新規作成。対象はvehicle/equipmentのちょうど一つ（Target契約）、
 * quantity>0、from/toは両方あるときだけ順序を検査する（片方未知は保留。docs/04「時間順序」）
 */
export const ResourceUsageInput = obj({
  id: Id.optional(),
  target: Target,
  quantity: z.number().positive(),
  from: Instant.optional(),
  to: Instant.optional(),
}).refine((v) => !v.from || !v.to || v.to >= v.from, { message: "to は from 以降にしてください" });

/** 使用履歴の1行（docs/04:100 resource_usages）。cancelledも行として残り、集計から除外される（docs/11 §3） */
export const ResourceUsageRow = obj({
  id: Id,
  version: Version,
  /** 出来事root（activities/incidentsが共用）。このIDで元の活動/出動を辿れる */
  operationId: Id,
  target: obj({ type: z.enum(["vehicle", "equipment"]), id: Id }),
  quantity: z.number(),
  usedFrom: Instant.nullable(),
  usedTo: Instant.nullable(),
  recordedByMemberId: Id,
  status: z.enum(resourceUsageStates),
});
export type ResourceUsageRowDto = z.infer<typeof ResourceUsageRow>;

/** docs/05 API-57応答「ResourceUsageList＋operationVersion」。全有効集合PUTの結果（cancelled行も保持） */
export const ResourceUsageList = obj({
  usages: z.array(ResourceUsageRow).max(LIMITS.arrayMax),
  operationVersion: Version,
});
export type ResourceUsageListDto = z.infer<typeof ResourceUsageList>;

/**
 * 出動の詳細（API-70「参集/活動/使用履歴/イベント」docs/05:124）。
 * 参集の書込はAPI-23（T041で接続済み）。使用履歴の書込はAPI-57（T042で接続済み）
 */
export const IncidentDetail = obj({
  ...Incident.shape,
  /** 関連付けた活動（activityIdの内容。未リンクはnull） */
  activity: Activity.nullable(),
  participants: z.array(IncidentParticipant).max(LIMITS.arrayMax),
  /** 車両/機材の使用履歴（resource_usages。docs/04:100。書込はAPI-57＝T042で接続済み。cancelled行も残る） */
  resourceUsages: z.array(ResourceUsageRow).max(LIMITS.arrayMax),
  events: z.array(IncidentEvent).max(LIMITS.arrayMax),
});
export type IncidentDetailDto = z.infer<typeof IncidentDetail>;

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

export const operationsApis = {
  "API-05": defineApi({
    method: "GET", path: "/activities", permission: "PER-01", kind: "list", success: [200],
    request: obj({
      query: listQuery({
        from: Instant.optional(), to: Instant.optional(), kind: ShortText.optional(), memberId: Id.optional(),
        status: z.enum(activityStates).optional(), actual: z.stringbool().optional(),
      }),
    }),
    // 応答はdocs/05 API-05行どおりPage<Activity>（T038でprovisionalから厳格化。T035のActivity DTOを流用）
    response: Page(Activity),
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
    response: ActivityResult,
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
    // 訂正理由はactivity_result_revisions.correction_reasonのCHECK（≤2000）に揃える（docs/04:92「訂正は理由必須」。API-39/40と同じ扱い）
    request: obj({ params: P_ID, body: obj({ resultVersion: Version, ...actualShape, reason: Reason2000 }), ...IDEM }),
    response: ActivityResult,
  }),
  "API-43": defineApi({
    method: "GET", path: "/activities/:id/actual-results", permission: "PER-01", kind: "get", success: [200],
    request: obj({ params: P_ID, query: obj({ revision: z.coerce.number().int().min(1).optional() }) }),
    response: ActivityResultHistory,
  }),
  "API-21": defineApi({
    method: "GET", path: "/incidents", permission: "PER-01", kind: "list", success: [200],
    request: obj({
      query: listQuery({
        kind: z.enum(incidentKinds).optional(), from: Instant.optional(), to: Instant.optional(),
        status: z.enum(incidentStates).optional(),
      }),
    }),
    // 応答はdocs/05 API-21行どおりPage<Incident>（T040でprovisionalから厳格化）
    response: Page(Incident),
  }),
  "API-22": defineApi({
    method: "POST", path: "/incidents", permission: "PER-04", kind: "mutation", success: [201],
    request: obj({
      body: obj({
        kind: z.enum(incidentKinds), occurredAt: Instant, summary: Body, activityId: Id.optional(),
        // 使用履歴はbuildResourceUsageMutation経由で出動/出来事rootと同一batchで作る（docs/05 API-22行。T042で接続）
        resourceUsages: z.array(ResourceUsageInput).max(LIMITS.arrayMax).optional(),
      }),
      ...IDEM,
    }),
    response: Incident,
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
    // 応答はdocs/05 API-23行どおりParticipant（T041でprovisionalから厳格化）
    response: IncidentParticipant,
  }),
  "API-69": defineApi({
    method: "PATCH", path: "/incidents/:id", permission: "PER-04", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({
        version: Version, status: z.enum(incidentStates).optional(), kind: z.enum(incidentKinds).optional(),
        summary: Body.optional(),
        // 理由はincident_events.reasonのCHECK（≤2000）に揃える（docs/11「訂正/無効化理由」。API-39/40と同じ扱い）
        reason: Reason2000,
      }),
      ...IDEM,
    }),
    response: Incident,
  }),
  "API-70": defineApi({
    method: "GET", path: "/incidents/:id", permission: "PER-01限定", kind: "get", success: [200],
    request: obj({ params: P_ID }),
    // docs/05 API-70行どおりIncidentDetail（T040でprovisionalから厳格化。参集/使用履歴はT041/T042で埋める）
    response: IncidentDetail,
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
      body: obj({ version: Version, usages: z.array(ResourceUsageInput).max(LIMITS.arrayMax), reason: Reason2000 }),
      ...IDEM,
    }),
    // docs/05 API-57行どおりResourceUsageList＋operationVersion（T042でprovisionalから厳格化）。
    // 理由はresource_usage_events.reasonのCHECK（≤2000）に揃える（API-69/39/40と同じ扱い）
    response: ResourceUsageList,
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
