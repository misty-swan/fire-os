import { z } from "zod";
import {
  AssetTarget, Code100, Code50, Id, IdListMaybeEmpty, IDEM, LIMITS, NonNegative, Note1000, P_ID, Page, Reason, Reason2000, Sha256, ShortText, Target,
  Title, Version, VersionOrZero, BusinessDate, Body, Job, defineApi, listQuery, noContent, obj, provisionalDto,
} from "./common";
import { inspectionShape } from "./gis";
import { ResourceUsageRow } from "./operations";
import { attachmentStates, assetStatuses, inspectionResults, issueStates } from "../states";

export const attachmentTargetTypes = [
  "facility", "activity", "vehicle", "equipment", "inspection", "issue", "announcement", "report_version", "document",
  "import_batch", "attachment_draft",
] as const;
export const AttachmentTarget = obj({ type: z.enum(attachmentTargetTypes), id: Id });

export const UploadIntent = obj({
  id: Id, uploadPath: z.string(), uploadToken: z.string().nullable(), expiresAt: z.iso.datetime(), version: z.number().int().min(1),
});
export const UploadAttempt = obj({ id: Id, sha256: Sha256, size: z.number().int().min(1), version: z.number().int().min(1) });
export const AttachmentDraft = obj({ id: Id, version: z.number().int().min(1), expiresAt: z.iso.datetime() });

/** 車両（docs/04 §3.2）。statusはT048で列挙（docs/11 §2。変更入力API-48/50は未知値400。DBのCHECKはdocs/14 D24） */
export const Vehicle = obj({
  id: Id, version: Version, assetCode: ShortText, name: ShortText, status: ShortText,
  storageFacilityId: Id.nullable(), archivedAt: z.iso.datetime().nullable(),
});
export type VehicleDto = z.infer<typeof Vehicle>;
/** 資機材（数量機材はD15の検証設定。保管先は施設/車両のどちらか一方、外部保管は備考） */
export const Equipment = obj({
  id: Id, version: Version, assetCode: ShortText, name: ShortText, quantity: z.number(),
  quantityUnit: ShortText, status: ShortText,
  storage: obj({ facilityId: Id.nullable(), vehicleId: Id.nullable(), note: z.string().nullable() }),
  archivedAt: z.iso.datetime().nullable(),
});
export type EquipmentDto = z.infer<typeof Equipment>;

/**
 * 資産の詳細（docs/05 API-51行どおりAssetDetail。T042で使用履歴のcursor子Pageを接続、
 * T048で点検期限（inspectionDue。scheduleの現在値＋超過判定）を接続。
 * 点検/異常の子Pageは未接続＝残作業（点検履歴=T030の残、異常=接続タスク未割当）。続きはmeta.nextCursor
 */
export const AssetInspectionDue = obj({
  /** 点検scheduleの現在値（業務日 YYYY-MM-DD）。未設定はnull（0件と未設定を混同しない） */
  nextDueDate: BusinessDate.nullable(),
  /** JST暦日で期限を過ぎているか（docs/14 D06。期限当日23:59は未超過、翌日00:00で超過） */
  overdue: z.boolean(),
});
/**
 * 資産の点検履歴の1行（T085でT030の残作業「点検履歴」を接続。docs/05 API-51）。
 * 訂正前の原本も残る（追記型）。isCurrentは系列の現在版（訂正できるのは現在版だけ＝API-46の版ガード）。
 */
export const AssetInspectionRow = obj({
  id: Id, seriesId: Id, seriesVersion: Version, templateVersionId: Id, inspectorMemberId: Id,
  inspectedAt: z.iso.datetime(), result: z.enum(inspectionResults), note: z.string(),
  items: z.array(obj({
    code: z.string(), result: z.string(),
    value: z.union([z.string(), z.number(), z.boolean()]).nullable(), note: z.string().nullable(),
  })).max(LIMITS.arrayMax),
  supersedesId: Id.nullable(), correctionReason: z.string().nullable(), isCurrent: z.boolean(),
});
export type AssetInspectionRowDto = z.infer<typeof AssetInspectionRow>;

export const AssetDetail = obj({
  asset: z.union([Vehicle, Equipment]),
  /** この資産の点検履歴（新しい順。最大100件。訂正前の原本も含む） */
  inspections: z.array(AssetInspectionRow).max(LIMITS.arrayMax),
  /** この資産の使用履歴（docs/04:100。cancelledも行として残る。operationIdで元の活動/出動を辿れる） */
  usages: z.array(ResourceUsageRow).max(LIMITS.arrayMax),
  /** 点検期限（T048。API-56で設定したscheduleの現在値＋超過判定） */
  inspectionDue: AssetInspectionDue,
});
export type AssetDetailDto = z.infer<typeof AssetDetail>;

/**
 * 点検期限のschedule（docs/04:119。対象一つ、周期正、期限はAsia/Tokyo日付=D06）。
 * T048でprovisionalから厳格化。facilityはAPI-56の対象外（/assets配下はvehicle/equipmentのみ）
 */
export const InspectionSchedule = obj({
  id: Id, version: Version,
  target: AssetTarget,
  nextDueDate: BusinessDate,
  intervalDays: z.number().int().min(1).max(3660).nullable(),
  timezone: z.string(),
});
export type InspectionScheduleDto = z.infer<typeof InspectionSchedule>;

/** 応答へ出す添付。R2鍵(staging/ready)・tokenのhashは内部値なので含めない */
export const Attachment = obj({
  id: Id, version: Version, status: z.enum(attachmentStates), contentType: z.string(), byteSize: z.number().int().min(1),
  sha256: z.string().nullable(), classification: z.enum(["basic", "personal", "sensitive"]), expiresAt: z.iso.datetime(),
});

// 保管先の排他（施設/車両の両方指定は不可）は業務規則のため、サーバーが422で返す（docs/16 T025）。
// 備考はDBのCHECK（equipment.storage_note 1..1000。未指定はNULL）に揃える（空文字は400。500にしない）
const storage = obj({ facilityId: Id.optional(), vehicleId: Id.optional(), note: Note1000.optional() });

const templateItem = obj({
  // 項目コードは点検明細のitem_code（DBのCHECK ≤100）として保存されるため、様式の時点で100に揃える
  code: Code100,
  label: ShortText,
  valueType: z.enum(["boolean", "number", "text", "select"]),
  required: z.boolean(),
  allowedResults: z.array(ShortText).max(LIMITS.arrayMax).optional(),
});
const ItemSchema = z
  .array(templateItem)
  .min(1)
  .max(LIMITS.arrayMax)
  .refine((items) => new Set(items.map((i) => i.code)).size === items.length, { message: "code が重複しています" });
const TemplateDecision = z.enum(["request_review", "approve", "changes_requested"]);

export const assetsApis = {
  "API-15": defineApi({
    method: "GET", path: "/issues", permission: "PER-01", kind: "list", success: [200],
    request: obj({
      query: listQuery({
        targetType: z.enum(["facility", "vehicle", "equipment"]).optional(), targetId: Id.optional(),
        status: z.enum(issueStates).optional(), assigneeMemberId: Id.optional(),
      }),
    }),
    response: Page(provisionalDto()), provisional: true,
  }),
  "API-16": defineApi({
    method: "POST", path: "/issues", permission: "PER-04", kind: "mutation", success: [201],
    request: obj({
      body: obj({
        target: Target, title: Title, description: Body, originInspectionId: Id.optional(), attachmentIds: IdListMaybeEmpty,
      }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-17": defineApi({
    method: "PATCH", path: "/issues/:id", permission: "PER-05", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({
        version: Version, status: z.enum(issueStates).optional(), assigneeMemberId: Id.nullable().optional(),
        // 対応記録の理由（DBのCHECK issue_events.note ≤2000）に揃える
        reason: Reason2000,
      }),
      ...IDEM,
    }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-18": defineApi({
    method: "GET", path: "/vehicles", permission: "PER-01", kind: "list", success: [200],
    // due=overdue（T048）は点検期限が超過している現役資産（docs/14 D24の両建てで廃止を除く）。
    // ホームのinspectionDue件数と同じWHERE（src/server/jobs/handlers/inspection-due.ts overdueAssetCondition）
    request: obj({ query: listQuery({ q: ShortText.optional(), status: ShortText.optional(), due: z.enum(["overdue"]).optional() }) }),
    response: Page(provisionalDto()), provisional: true,
  }),
  "API-19": defineApi({
    method: "GET", path: "/equipment", permission: "PER-01", kind: "list", success: [200],
    request: obj({ query: listQuery({ q: ShortText.optional(), status: ShortText.optional(), storage: ShortText.optional(), due: z.enum(["overdue"]).optional() }) }),
    response: Page(provisionalDto()), provisional: true,
  }),
  "API-20": defineApi({
    method: "POST", path: "/asset-inspections", permission: "PER-04", kind: "mutation", success: [201],
    request: obj({ body: obj({ target: AssetTarget, ...inspectionShape }), ...IDEM }),
    response: provisionalDto(), provisional: true,
  }),
  "API-46": defineApi({
    method: "POST", path: "/inspections/:type/:id/corrections", permission: "PER-04", kind: "mutation", success: [201],
    request: obj({
      params: obj({ type: z.enum(["facility", "vehicle", "equipment"]), id: Id }),
      body: obj({ seriesVersion: Version, supersedesId: Id, reason: Reason2000, ...inspectionShape }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-47": defineApi({
    method: "POST", path: "/vehicles", permission: "PER-03", kind: "mutation", success: [201],
    request: obj({
      // 番号・状態はDBのCHECK（vehicles.asset_code/status ≤100）に揃える
      body: obj({ assetCode: Code100, name: ShortText, status: Code100, storageFacilityId: Id.optional() }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-48": defineApi({
    method: "PATCH", path: "/vehicles/:id", permission: "PER-03", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({
        version: Version, assetCode: Code100.optional(), name: ShortText.optional(),
        // statusはT048で列挙（docs/11 §2。運用/在庫/修繕中/廃止。未知値は400。DBのCHECKはdocs/14 D24）
        status: z.enum(assetStatuses).optional(),
        storageFacilityId: Id.nullable().optional(),
      }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-49": defineApi({
    method: "POST", path: "/equipment", permission: "PER-03", kind: "mutation", success: [201],
    request: obj({
      body: obj({ assetCode: Code100, name: ShortText, quantity: NonNegative, quantityUnit: Code50, storage }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-50": defineApi({
    method: "PATCH", path: "/equipment/:id", permission: "PER-03", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({
        version: Version, assetCode: Code100.optional(), name: ShortText.optional(), quantity: NonNegative.optional(),
        quantityUnit: Code50.optional(), status: z.enum(assetStatuses).optional(), storage: storage.optional(),
      }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-51": defineApi({
    method: "GET", path: "/assets/:type/:id", permission: "PER-01", kind: "get", success: [200],
    request: obj({ params: obj({ type: z.enum(["vehicle", "equipment"]), id: Id }), query: listQuery({}) }),
    // docs/05 API-51行どおりAssetDetail（T042でprovisionalから厳格化。使用履歴の子Pageを接続。
    // 点検履歴はT085で接続（inspections。T030の残作業）。異常の子Pageは未接続）
    response: AssetDetail,
  }),
  "API-56": defineApi({
    method: "PUT", path: "/assets/:type/:id/inspection-schedule", permission: "PER-03", kind: "mutation", success: [200, 201],
    request: obj({
      params: obj({ type: z.enum(["vehicle", "equipment"]), id: Id }),
      body: obj({
        version: VersionOrZero, nextDueDate: BusinessDate, intervalDays: z.number().int().min(1).max(3660).optional(),
        // 業務日のタイムゾーンはD06でAsia/Tokyo固定（docs/04:119「期限はAsia/Tokyo日付」。他は400）
        timezone: z.literal("Asia/Tokyo"),
      }),
      ...IDEM,
    }),
    // T048でdocs/04 inspection_schedulesどおりに厳格化（provisionalから変更）
    response: InspectionSchedule,
  }),
  "API-94": defineApi({
    method: "GET", path: "/inspection-templates", permission: "PER-04", kind: "list", success: [200],
    request: obj({ query: listQuery({ targetType: z.enum(["facility", "vehicle", "equipment"]).optional(), status: ShortText.optional() }) }),
    response: Page(provisionalDto()), provisional: true,
  }),
  "API-95": defineApi({
    method: "POST", path: "/inspection-templates", permission: "PER-03様式管理", kind: "mutation", success: [201],
    request: obj({
      body: obj({ name: ShortText, targetType: z.enum(["facility", "vehicle", "equipment"]), itemSchema: ItemSchema }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-96": defineApi({
    method: "POST", path: "/inspection-templates/:id/versions", permission: "PER-03様式管理", kind: "mutation", success: [201],
    request: obj({ params: P_ID, body: obj({ version: Version, itemSchema: ItemSchema, reason: Reason }), ...IDEM }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-97": defineApi({
    method: "POST", path: "/inspection-templates/:id/decision", permission: "PER-10様式承認", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({ version: Version, templateVersionId: Id, decision: TemplateDecision, reason: Reason }),
      ...IDEM,
    }),
    response: z.looseObject({}), provisional: true,
  }),
  // --- 添付 ---
  "API-26": defineApi({
    method: "POST", path: "/attachments/upload-intents", permission: "PER-04", kind: "mutation", success: [201],
    request: obj({
      body: obj({
        target: AttachmentTarget, contentType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/).max(100),
        byteSize: z.number().int().min(1), sha256: Sha256.optional(),
      }),
      ...IDEM,
    }),
    response: UploadIntent,
  }),
  "API-27": defineApi({
    method: "GET", path: "/attachments/:id/content", permission: "元対象ACL", kind: "binary", success: [200],
    request: obj({ params: P_ID }), response: noContent,
  }),
  // 本文はバイナリ。冪等性はIdempotency-Keyでなくintent/attempt ID＋content hashで判定（docs/05 §2）。
  // uploadTokenは x-upload-token ヘッダーで受け取る（URLに残さないため）。
  "API-83": defineApi({
    method: "PUT", path: "/attachments/:id/upload", permission: "PER-04本人申請", kind: "binary", success: [200],
    request: obj({ params: P_ID, headers: z.looseObject({ "x-upload-token": z.string().min(1).max(512) }) }),
    response: UploadAttempt,
  }),
  "API-84": defineApi({
    method: "POST", path: "/attachments/:id/completion", permission: "PER-04", kind: "job", success: [202],
    request: obj({ params: P_ID, body: obj({ version: Version, uploadAttemptId: Id, sha256: Sha256 }), ...IDEM }),
    response: obj({ attachment: Attachment, job: Job }),
  }),
  "API-85": defineApi({
    method: "DELETE", path: "/attachments/:id", permission: "PER-04管理", kind: "noContent", success: [204],
    request: obj({ params: P_ID, body: obj({ version: Version, reason: Reason }), ...IDEM }),
    response: noContent,
  }),
  "API-98": defineApi({
    method: "POST", path: "/attachment-drafts", permission: "PER-04＋対象作成権", kind: "mutation", success: [201],
    request: obj({
      body: obj({
        intendedEntityType: z.enum(attachmentTargetTypes), parentType: z.enum(attachmentTargetTypes).optional(),
        parentId: Id.optional(),
      }),
      ...IDEM,
    }),
    response: AttachmentDraft,
  }),
  "API-101": defineApi({
    method: "DELETE", path: "/attachments/:id/links/:linkId", permission: "元対象編集権", kind: "noContent", success: [204],
    request: obj({
      params: obj({ id: Id, linkId: Id }),
      body: obj({ version: Version, reason: Reason }),
      ...IDEM,
    }),
    response: noContent,
  }),
} as const;
