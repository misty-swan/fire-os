import { z } from "zod";
import {
  Body, Id, IdList, IDEM, Instant, Job, LIMITS, P_ID, Page, Reason, Sha256, ShortText, Title, Version, defineApi, listQuery, noContent,
  obj,
} from "./common";
import {
  announcementStates, attachmentStates, contentVersionStates, deliveryStates, documentStates, jobStates,
  notificationApprovalStates, notificationChannels,
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

/**
 * 対象者1行（docs/04:140）。addressRefは連絡先の「参照」（例: member:<memberId>#inbox）。生値は載せない。
 * deliveryStatusは送信者（PER-12）投影だけに載る自分の宛先ごとの配送の現在状態（docs/11 配送。
 * 行がまだ無い＝job未実行はnull。T052。対象者本人の投影には載らない＝本人はmyDeliveryを見る）
 */
export const NotificationRecipient = obj({
  memberId: Id,
  channel: z.enum(notificationChannels),
  addressRef: ShortText,
  readAt: Instant.nullable(),
  deliveryStatus: z.enum(deliveryStates).nullable().optional(),
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

// --- 報告書（T056。docs/04:146/147、docs/05 API-58/59/62、docs/11 報告書/文書版、docs/14 D20） ---

/**
 * 版の参照源（docs/04:147 source_versions）。activityの版・実績の版/訂正番号は**サーバーが実績から計算して
 * 記録する**（docs/16 T056「数値は実績からサーバー計算」。使用した様式版はtemplate_version列）。
 * 元実績の更新は「保存した版と現行版の不一致」で検出できる
 */
const ReportSourceVersions = obj({
  activityVersion: Version,
  resultVersion: Version,
  resultRevisionNo: Version,
});

/** 帳票の版（docs/04:147）。内容列（text等）は旧版不変。承認列は承認済み（approved）だけが持つ */
export const ReportVersion = obj({
  id: Id,
  reportId: Id,
  /** 使用した様式版（allowlist設定artifact。config/report-templates/manifest.jsonでhash固定） */
  templateVersion: ShortText,
  revisionNo: Version,
  text: Body,
  /** 様式の必須欄で未記入のもの（サーバー計算） */
  missingFields: z.array(ShortText).max(LIMITS.arrayMax),
  sourceVersions: ReportSourceVersions,
  /** AI生成時のモデル（手動下書きはNULL。T057以降） */
  modelId: z.string().max(200).nullable(),
  /** AI生成のプロンプト構造の版（report-draft-v1。手動下書きはNULL。T057で追加した列のDTO反映＝T059） */
  promptVersion: z.string().max(100).nullable(),
  /** AI生成のtoken使用量（手動下書きはNULL。T057で追加したusage_jsonのDTO反映＝T059） */
  usageJson: obj({ promptTokens: z.number().int().min(0), completionTokens: z.number().int().min(0) }).nullable(),
  status: z.enum(contentVersionStates),
  approvedBy: Id.nullable(),
  approvedAt: Instant.nullable(),
  createdAt: Instant,
});
export type ReportVersionDto = z.infer<typeof ReportVersion>;

/** 帳票root（docs/04:146）。kindはT056では手動下書きのみ（AI下書きはT057以降でCHECK拡張） */
export const Report = obj({
  id: Id,
  version: Version,
  activityId: Id,
  kind: z.literal("manual"),
  currentDraftVersionId: Id.nullable(),
  currentApprovedVersionId: Id.nullable(),
  createdAt: Instant,
  updatedAt: Instant,
});
export type ReportDto = z.infer<typeof Report>;

/** docs/05 API-58「Report＋ReportVersion」（API-62の作成直後応答も同じ形。activity-resultsのAPI-43と同じ流儀） */
export const ReportHistory = obj({ report: Report, versions: z.array(ReportVersion) });
export type ReportHistoryDto = z.infer<typeof ReportHistory>;

const AclEntry = obj({
  memberId: Id.optional(),
  roleId: Id.optional(),
  permission: ShortText,
  effect: z.enum(["allow", "deny"]),
}).refine((v) => !!v.memberId !== !!v.roleId, { message: "memberId か roleId のどちらか一方を指定してください" });
const Acl = z.array(AclEntry).min(1).max(LIMITS.arrayMax);

// --- 文書（T062。docs/04:149/150、docs/05 API-73/74/90/91、docs/06 §5、docs/10 §2/§4） ---

/**
 * 文書root（docs/04:149）。currentVersionIdは有効な承認版（T063の承認だけが切替る）、
 * currentDraftVersionIdは最新のdraft版（版作成で切替る）＝docs/11「承認版とdraftの別pointer」。
 * policyVersionはACL・分類の改訂版（API-99の変更で増分。応答契約に載る。docs/04:149のT062追加列）。
 */
export const Document = obj({
  id: Id,
  version: Version,
  title: Title,
  classification: ShortText,
  status: z.enum(documentStates),
  currentVersionId: Id.nullable(),
  currentDraftVersionId: Id.nullable(),
  policyVersion: Version,
  createdAt: Instant,
  updatedAt: Instant,
});
export type DocumentDto = z.infer<typeof Document>;

/**
 * 文書の版（docs/04:150）。attachmentIdは原本添付への直接参照（取得経路は同じ(document,attachment)の
 * attachment_links。docs/16 T062の裁定）。contentHashは版作成時に添付のsha256へ固定した原本のhash
 * （後続の版作成・元添付の履歴でも書変わらない）。revisionNoは文書ごとに1から採番（文書/版UNIQUE）。
 * statusはcontentVersionStates（docs/11 報告書/文書版）。承認列は承認済み（approved）だけが持つ。
 */
export const DocumentVersion = obj({
  id: Id,
  documentId: Id,
  revisionNo: Version,
  attachmentId: Id,
  status: z.enum(contentVersionStates),
  approvedBy: Id.nullable(),
  approvedAt: Instant.nullable(),
  /** 許諾の出典（必須。無い版は作れない。docs/05 API-74「licenseRef」） */
  licenseRef: ShortText,
  contentHash: Sha256,
  createdAt: Instant,
});
export type DocumentVersionDto = z.infer<typeof DocumentVersion>;

/** 版の原本添付の参照（API-91「原文添付参照/引用元版」。取得はAPI-27。鍵・実体は返さない） */
export const DocumentOriginal = obj({
  attachmentId: Id,
  status: z.enum(attachmentStates),
  contentType: z.string(),
  /** readyの添付だけが持つ原本のhash */
  contentHash: Sha256.nullable(),
});

/**
 * docs/05 API-91「DocumentDetail」: 文書＋版一覧＋表示中の版の原文添付の参照。
 * revision?で引用元版を辿れる（省略は現在のdraft版。draftが無ければ承認版）。
 * originalは版がまだ無い（または表示版が無い）ときnull。
 */
export const DocumentDetail = obj({
  document: Document,
  versions: z.array(DocumentVersion),
  original: DocumentOriginal.nullable(),
});

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
    // approveは配送jobの受付（202=業務完了でない。docs/05 §1）。cancelはjobを作らないため200。
    // cancel_unsentは承認後の未送分取消（deliveries単位。docs/11「未送分取消」。T052でAPI化。
    // 承認状態は変えないため200。bodyHash/audienceHashはapproveだけが要求する）
    method: "POST", path: "/notifications/:id/approval", permission: "PER-12", kind: "job", success: [200, 202],
    request: obj({
      params: P_ID,
      body: obj({
        version: Version,
        // 承認固定のhashはapproveの要求（サーバーが検査。cancel/cancel_unsentでは使わないため任意）
        bodyHash: Sha256.optional(), audienceHash: Sha256.optional(),
        decision: z.enum(["approve", "cancel", "cancel_unsent"]),
      }),
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
    // unread=true（T052）: 自分の分のうち未読（recipients.read_at IS NULL）だけ。docs/05 API-28の
    // notifications指標（自分宛・未読の件数）と同じ条件で、href先の一覧の件数と一致させる
    request: obj({ query: listQuery({ status: z.enum(notificationApprovalStates).optional(), unread: z.stringbool().optional() }) }),
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
    // **未承認版は担当のみ**（docs/05 API-58。担当=作成者＋activity担当owner。担当外は承認版だけが見え、
    // 承認版が無い場合は存在も見せないため404。T056実装）
    request: obj({ params: P_ID, query: obj({ revision: z.coerce.number().int().min(1).optional() }) }),
    response: ReportHistory,
  }),
  "API-59": defineApi({
    method: "POST", path: "/reports/:id/versions", permission: "PER-10", kind: "mutation", success: [201],
    // 新draft版（docs/11「差戻し後/承認後訂正は新draft版、旧版不変」。旧版409はrootの版ガード）。
    // 入力のsourceVersionsはdocs/05どおり受理するが、activity/resultの版は**サーバーが現行実績から
    // 再計算して保存する**（docs/16 T056。入力を信用しない。様式版は直前版から引継ぎ）
    request: obj({
      params: P_ID,
      body: obj({
        version: Version, text: Body, missingFields: z.array(ShortText).max(LIMITS.arrayMax), sourceVersions, reason: Reason,
      }),
      ...IDEM,
    }),
    response: ReportVersion,
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
    // 手動下書き（AI停止でも人の入力で帳票を作れる）。templateVersionはallowlist外・hash不一致が422
    // （docs/04 §3.5末尾「存在しない版は422」）。resultVersionは実績rootの版ガード（旧版409）。
    // source_versions（activity/resultの版）はサーバーが実績から計算して記録する（docs/16 T056）
    request: obj({
      body: obj({ activityId: Id, resultVersion: Version, templateVersion: ShortText, text: Body }),
      ...IDEM,
    }),
    response: ReportHistory,
  }),
  // --- 文書 ---
  "API-73": defineApi({
    method: "POST", path: "/documents", permission: "PER-11管理", kind: "mutation", success: [201],
    // 権限はPER-11＋幹部・管理者（docs/10 PER-11「△公開対象」の管理操作。D03未承認の検証設定）。
    // aclはdeny優先の投影（memberId/roleId片方。ACL行で絞られない文書は無い＝作成時必須1件以上）
    request: obj({ body: obj({ title: Title, classification: ShortText, acl: Acl }), ...IDEM }),
    response: Document,
  }),
  "API-74": defineApi({
    method: "POST", path: "/documents/:id/versions", permission: "PER-11管理", kind: "job", success: [202],
    // ready原本＋licenseRef必須（docs/05 API-74「version,attachmentId,licenseRef;ready原本/抽出job」）。
    // attachmentIdは同unit・ready添付（未readyは422 ATTACHMENT_NOT_READY）。licenseRefは契約必須（無ければ400）。
    // content_hashは添付のsha256へ固定。document.extract job（202=受付で完了ではない。handlerはT064）
    request: obj({
      params: P_ID,
      body: obj({ version: Version, attachmentId: Id, licenseRef: ShortText }),
      ...IDEM,
    }),
    response: obj({ version: DocumentVersion, job: Job }),
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
    // 文書ACL前置（deny優先。ACL行が無い文書は同unitのPER-01保持者に見える既定）。
    // SQLで対象行を絞ってからページング（docs/10 §3）。非公開文書は行・件数に現れない
    request: obj({ query: listQuery({ q: ShortText.optional(), status: z.enum(documentStates).optional() }) }),
    response: Page(Document),
  }),
  "API-91": defineApi({
    method: "GET", path: "/documents/:id", permission: "PER-11", kind: "get", success: [200],
    request: obj({ params: P_ID, query: obj({ revision: z.coerce.number().int().min(1).optional() }) }),
    response: DocumentDetail,
  }),
  "API-92": defineApi({
    method: "POST", path: "/documents/:id/withdrawal", permission: "PER-11管理", kind: "mutation", success: [200],
    request: obj({ params: P_ID, body: obj({ version: Version, reason: Reason }), ...IDEM }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-99": defineApi({
    method: "PATCH", path: "/documents/:id/access-policy", permission: "PER-11管理", kind: "mutation", success: [200],
    // 応答のpolicyVersionはdocuments.policy_version（T062で追加した列。T063の変更で増分）
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
