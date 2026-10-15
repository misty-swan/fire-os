import { z } from "zod";
import {
  Body, Id, IdList, IDEM, Instant, LIMITS, P_ID, Page, Reason, Sha256, ShortText, Title, Version, defineApi, listQuery, noContent,
  obj, provisionalDto,
} from "./common";
import { announcementStates, attachmentStates } from "../states";

export const ReadReceipt = obj({ readAt: z.iso.datetime(), revisionNo: z.number().int().min(1).optional(), notificationVersion: z.number().int().min(1).optional() });

/** お知らせへリンク中の添付（id/linkId/linkVersionはAPI-101のunlinkが、status/contentTypeは表示が使う。T046） */
export const AnnouncementAttachment = obj({
  id: Id,
  linkId: Id,
  linkVersion: Version,
  status: z.enum(attachmentStates),
  contentType: z.string(),
});

/**
 * お知らせ（docs/04:132 announcements）。audienceMemberIdsは現行版（revisionNo）の対象snapshot
 * （announcement_revisions.audience_snapshot。docs/04:133/134）。title/body/対象の変更は新revisionで
 * 行われ旧版は不変（docs/11「編集で新revision」）。publishedAtは公開操作時刻または作成時に指定した
 * publishAt（公開への遷移はAPI-72の明示操作。自動公開jobは無い。docs/16 T045）。
 * createdByMemberIdは作成者（users→membersの解決。画面の「作成者」表示。T046）。
 * readAtは**この要求の本人**による現行版の既読日時（未読はnull。旧版の既読は含めない＝改版で未読に戻る。docs/11「既読は版に束縛」）。
 * audienceMemberIdsは**管理権限（PER-03）の要求にだけ載る**（他対象者のID一覧を対象者に返さない。API-24の対象者応答では省略）
 */
export const Announcement = obj({
  id: Id,
  version: Version,
  title: Title,
  body: Body,
  revisionNo: Version,
  status: z.enum(announcementStates),
  publishedAt: Instant.nullable(),
  audienceMemberIds: z.array(Id).optional(),
  createdByMemberId: Id.nullable(),
  readAt: Instant.nullable(),
  attachments: z.array(AnnouncementAttachment),
  createdAt: Instant,
  updatedAt: Instant,
});
export type AnnouncementDto = z.infer<typeof Announcement>;

/** 版判定の共通3値。docs/05 API-60/75/97 */
const ReviewVerb = z.enum(["request_review", "approve", "changes_requested"]);
const sourceVersions = z.record(z.string(), Version);

const AclEntry = obj({
  memberId: Id.optional(),
  roleId: Id.optional(),
  permission: ShortText,
  effect: z.enum(["allow", "deny"]),
}).refine((v) => !!v.memberId !== !!v.roleId, { message: "memberId か roleId のどちらか一方を指定してください" });
const Acl = z.array(AclEntry).min(1).max(LIMITS.arrayMax);

/**
 * 監査ログ（追記専用）。本文・氏名・連絡先・token・Secretは入らない（metadataはIDとコードの平坦な値だけ、1KiB以下）。
 * mutationId は同じ操作のoutbox（entityVersion/eventType）と結びつき、操作・旧新版を追跡できる。
 */
export const AuditLog = obj({
  id: Id,
  occurredAt: z.string(),
  actorKind: z.enum(["human", "system"]),
  actorId: Id.nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  mutationId: z.string(),
  entityVersion: z.number().int().nullable(),
  eventType: z.string().nullable(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export const contentApis = {
  "API-24": defineApi({
    method: "GET", path: "/announcements", permission: "PER-01", kind: "list", success: [200],
    request: obj({ query: listQuery({ status: z.enum(announcementStates).optional() }) }),
    response: Page(Announcement),
  }),
  "API-25": defineApi({
    method: "POST", path: "/announcements", permission: "PER-03", kind: "mutation", success: [201],
    request: obj({
      body: obj({ title: Title, body: Body, audienceMemberIds: IdList, publishAt: Instant.optional() }),
      ...IDEM,
    }),
    response: Announcement,
  }),
  "API-72": defineApi({
    method: "PATCH", path: "/announcements/:id", permission: "PER-03", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({
        version: Version, title: Title.optional(), body: Body.optional(), status: z.enum(announcementStates).optional(),
        audienceMemberIds: IdList.optional(),
      }),
      ...IDEM,
    }),
    response: Announcement,
  }),
  "API-66": defineApi({
    method: "PUT", path: "/announcements/:id/read", permission: "本人", kind: "mutation", success: [200],
    request: obj({ params: P_ID, body: obj({ revisionNo: Version }), ...IDEM }),
    response: ReadReceipt,
  }),
  // --- 通知 ---
  "API-63": defineApi({
    method: "POST", path: "/notifications/drafts", permission: "PER-12", kind: "mutation", success: [201],
    request: obj({
      body: obj({
        source: obj({ type: ShortText, id: Id }), body: Body, audienceMemberIds: IdList,
        channels: z.array(ShortText).min(1).max(10), expiresAt: Instant.optional(),
      }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-64": defineApi({
    method: "POST", path: "/notifications/:id/approval", permission: "PER-12", kind: "job", success: [202],
    request: obj({
      params: P_ID,
      body: obj({ version: Version, bodyHash: Sha256, audienceHash: Sha256, decision: z.enum(["approve", "cancel"]) }),
      ...IDEM,
    }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-65": defineApi({
    method: "GET", path: "/notifications/:id", permission: "PER-12/対象者", kind: "get", success: [200],
    request: obj({ params: P_ID }), response: z.looseObject({}), provisional: true,
  }),
  "API-67": defineApi({
    method: "GET", path: "/notifications/me", permission: "PER-01", kind: "list", success: [200],
    request: obj({ query: listQuery({ status: ShortText.optional() }) }),
    response: Page(provisionalDto()), provisional: true,
  }),
  "API-100": defineApi({
    method: "PUT", path: "/notifications/:id/read", permission: "本人recipient", kind: "mutation", success: [200],
    request: obj({ params: P_ID, body: obj({ notificationVersion: Version }), ...IDEM }),
    response: ReadReceipt,
  }),
  // --- 報告書 ---
  "API-58": defineApi({
    method: "GET", path: "/reports/:id", permission: "PER-11", kind: "get", success: [200],
    request: obj({ params: P_ID, query: obj({ revision: z.coerce.number().int().min(1).optional() }) }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-59": defineApi({
    method: "POST", path: "/reports/:id/versions", permission: "PER-10", kind: "mutation", success: [201],
    request: obj({
      params: P_ID,
      body: obj({
        version: Version, text: Body, missingFields: z.array(ShortText).max(LIMITS.arrayMax), sourceVersions, reason: Reason,
      }),
      ...IDEM,
    }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-60": defineApi({
    method: "POST", path: "/reports/:id/decision", permission: "PER-10", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({ version: Version, reportVersion: Version, decision: ReviewVerb, sourceVersions, reason: Reason }),
      ...IDEM,
    }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-61": defineApi({
    method: "GET", path: "/reports/:id/content", permission: "PER-11", kind: "binary", success: [200],
    request: obj({ params: P_ID, query: obj({ format: z.enum(["pdf", "csv"]) }) }), response: noContent,
  }),
  "API-62": defineApi({
    method: "POST", path: "/reports/manual", permission: "PER-04", kind: "mutation", success: [201],
    request: obj({
      body: obj({ activityId: Id, resultVersion: Version, templateVersion: ShortText, text: Body }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  // --- 文書 ---
  "API-73": defineApi({
    method: "POST", path: "/documents", permission: "PER-11管理", kind: "mutation", success: [201],
    request: obj({ body: obj({ title: Title, classification: ShortText, acl: Acl }), ...IDEM }),
    response: provisionalDto(), provisional: true,
  }),
  "API-74": defineApi({
    method: "POST", path: "/documents/:id/versions", permission: "PER-11管理", kind: "job", success: [202],
    request: obj({
      params: P_ID,
      body: obj({ version: Version, attachmentId: Id, licenseRef: ShortText }),
      ...IDEM,
    }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-75": defineApi({
    method: "POST", path: "/documents/:id/decision", permission: "PER-10文書承認", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({ version: Version, documentVersion: Version, decision: ReviewVerb, reason: Reason }),
      ...IDEM,
    }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-90": defineApi({
    method: "GET", path: "/documents", permission: "PER-11", kind: "list", success: [200],
    request: obj({ query: listQuery({ q: ShortText.optional(), status: ShortText.optional() }) }),
    response: Page(provisionalDto()), provisional: true,
  }),
  "API-91": defineApi({
    method: "GET", path: "/documents/:id", permission: "PER-11", kind: "get", success: [200],
    request: obj({ params: P_ID, query: obj({ revision: z.coerce.number().int().min(1).optional() }) }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-92": defineApi({
    method: "POST", path: "/documents/:id/withdrawal", permission: "PER-11管理", kind: "mutation", success: [200],
    request: obj({ params: P_ID, body: obj({ version: Version, reason: Reason }), ...IDEM }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-99": defineApi({
    method: "PATCH", path: "/documents/:id/access-policy", permission: "PER-11管理", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({ version: Version, classification: ShortText, acl: Acl }),
      ...IDEM,
    }),
    response: z.looseObject({}), provisional: true,
  }),
  // --- 監査 ---
  "API-93": defineApi({
    method: "GET", path: "/audit-logs", permission: "PER-08", kind: "list", success: [200],
    request: obj({
      query: listQuery({
        entityType: ShortText.optional(), entityId: Id.optional(), from: Instant.optional(), to: Instant.optional(),
        actorId: Id.optional(),
      }),
    }),
    response: Page(AuditLog),
  }),
} as const;
