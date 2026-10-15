import { z } from "zod";
import {
  Body, Id, IdList, IDEM, Instant, LIMITS, P_ID, Page, Reason, Sha256, ShortText, Title, Version, defineApi, listQuery, noContent,
  obj, provisionalDto,
} from "./common";
import {
  announcementStates, attachmentStates, deliveryStates, jobStates, notificationApprovalStates, notificationChannels,
} from "../states";

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

// --- 通知（T050。docs/04 §3.4 139-142行、docs/05 API-63〜65/67/100、docs/11 通知承認・配送） ---

/** 通知の源（docs/05 API-63「source」。未回答者抽出=activity／お知らせ=announcement／点検期限検出=inspection_due） */
export const notificationSourceTypes = ["activity", "announcement", "inspection_due"] as const;
export type NotificationSourceType = (typeof notificationSourceTypes)[number];

/** 対象者1行（docs/04:140）。addressRefは連絡先の「参照」（例: member:<memberId>#inbox）。生値は載せない */
export const NotificationRecipient = obj({
  memberId: Id,
  channel: z.enum(notificationChannels),
  addressRef: ShortText,
  readAt: Instant.nullable(),
});

/** 配送jobの状態（API-64/65の送信者投影。jobの実行（deliveries生成）はT051の配送handler） */
export const NotificationDeliveryJob = obj({ jobId: Id, status: z.enum(jobStates) });

/**
 * 通知（docs/04:139）。bodyHash/audienceHashはAPI-64の承認固定に使う値
 * （bodyHash=body本文のSHA-256、audienceHash=対象memberId整列配列の正規化JSONのSHA-256）。
 * audienceMemberIds/recipients/deliveryJobは送信者（PER-12）の要求にだけ載る（API-65の投影。
 * 対象者には他者の宛先と承認hashを見せない）。対象者本人向けの投影はMyNotification。
 */
export const Notification = obj({
  id: Id,
  version: Version,
  status: z.enum(notificationApprovalStates),
  sourceType: z.enum(notificationSourceTypes),
  sourceId: Id,
  body: Body,
  bodyHash: Sha256,
  audienceHash: Sha256,
  channels: z.array(z.enum(notificationChannels)).min(1),
  expiresAt: Instant.nullable(),
  approvedAt: Instant.nullable(),
  audienceMemberIds: z.array(Id).optional(),
  recipients: z.array(NotificationRecipient).optional(),
  deliveryJob: NotificationDeliveryJob.nullable().optional(),
  createdAt: Instant,
  updatedAt: Instant,
});
export type NotificationDto = z.infer<typeof Notification>;

/**
 * 対象者本人の通知（API-65の対象者投影・API-67の一覧）。他者の宛先・配送・承認hashは載せない。
 * myDeliveryは自分の配送の現在状態（docs/11 配送）。T050では配送行が無いためnull
 * （承認だけで到達したとは表示しない。docs/07 §5「端末到達・既読…の保証をしない」）
 */
export const MyNotification = obj({
  id: Id,
  version: Version,
  status: z.enum(notificationApprovalStates),
  sourceType: z.enum(notificationSourceTypes),
  sourceId: Id,
  body: Body,
  channels: z.array(z.enum(notificationChannels)).min(1),
  myReadAt: Instant.nullable(),
  myDelivery: obj({ status: z.enum(deliveryStates), attemptCount: z.number().int().min(0) }).nullable(),
  createdAt: Instant,
  updatedAt: Instant,
});
export type MyNotificationDto = z.infer<typeof MyNotification>;

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
        source: obj({ type: z.enum(notificationSourceTypes), id: Id }),
        // 本文/対象は入力でも、源からの既定値提案（省略）でもよい（docs/16 T050）。
        // inspection_due源は対象を源から決められないためaudienceMemberIds必須（省略はサーバー400）
        body: Body.optional(), audienceMemberIds: IdList.optional(),
        channels: z.array(z.enum(notificationChannels)).min(1).max(10), expiresAt: Instant.optional(),
      }),
      ...IDEM,
    }),
    response: Notification,
  }),
  "API-64": defineApi({
    // approveは配送jobの受付（202=業務完了でない。docs/05 §1）。cancelはjobを作らないため200
    method: "POST", path: "/notifications/:id/approval", permission: "PER-12", kind: "job", success: [200, 202],
    request: obj({
      params: P_ID,
      body: obj({ version: Version, bodyHash: Sha256, audienceHash: Sha256, decision: z.enum(["approve", "cancel"]) }),
      ...IDEM,
    }),
    response: Notification,
  }),
  "API-65": defineApi({
    method: "GET", path: "/notifications/:id", permission: "PER-12/対象者", kind: "get", success: [200],
    request: obj({ params: P_ID }), response: Notification,
  }),
  "API-67": defineApi({
    method: "GET", path: "/notifications/me", permission: "PER-01", kind: "list", success: [200],
    request: obj({ query: listQuery({ status: z.enum(notificationApprovalStates).optional() }) }),
    response: Page(MyNotification),
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
