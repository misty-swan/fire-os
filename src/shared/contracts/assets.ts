import { z } from "zod";
import {
  AssetTarget, Id, IdListMaybeEmpty, IDEM, LIMITS, NonNegative, OptionalBody, P_ID, Page, Reason, Sha256, ShortText, Target,
  Title, Version, VersionOrZero, BusinessDate, Body, defineApi, listQuery, noContent, obj, provisionalDto,
} from "./common";
import { inspectionShape } from "./gis";
import { issueStates } from "../states";

export const attachmentTargetTypes = [
  "facility", "activity", "vehicle", "equipment", "inspection", "issue", "announcement", "report_version", "document",
  "import_batch", "attachment_draft",
] as const;
export const AttachmentTarget = obj({ type: z.enum(attachmentTargetTypes), id: Id });

export const UploadIntent = obj({
  id: Id, uploadPath: z.string(), uploadToken: z.string(), expiresAt: z.iso.datetime(), version: z.number().int().min(1),
});
export const UploadAttempt = obj({ id: Id, sha256: Sha256, size: z.number().int().min(1), version: z.number().int().min(1) });
export const AttachmentDraft = obj({ id: Id, version: z.number().int().min(1), expiresAt: z.iso.datetime() });

const storage = obj({ facilityId: Id.optional(), vehicleId: Id.optional(), note: OptionalBody.max(1000).optional() }).refine(
  (v) => !(v.facilityId && v.vehicleId),
  { message: "facilityId と vehicleId は同時に指定できません" },
);

const templateItem = obj({
  code: ShortText,
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
        version: Version, status: z.enum(issueStates).optional(), assigneeMemberId: Id.nullable().optional(), reason: Reason,
      }),
      ...IDEM,
    }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-18": defineApi({
    method: "GET", path: "/vehicles", permission: "PER-01", kind: "list", success: [200],
    request: obj({ query: listQuery({ q: ShortText.optional(), status: ShortText.optional() }) }),
    response: Page(provisionalDto()), provisional: true,
  }),
  "API-19": defineApi({
    method: "GET", path: "/equipment", permission: "PER-01", kind: "list", success: [200],
    request: obj({ query: listQuery({ q: ShortText.optional(), status: ShortText.optional(), storage: ShortText.optional() }) }),
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
      body: obj({ seriesVersion: Version, supersedesId: Id, reason: Reason, ...inspectionShape }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-47": defineApi({
    method: "POST", path: "/vehicles", permission: "PER-03", kind: "mutation", success: [201],
    request: obj({
      body: obj({ assetCode: ShortText, name: ShortText, status: ShortText, storageFacilityId: Id.optional() }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-48": defineApi({
    method: "PATCH", path: "/vehicles/:id", permission: "PER-03", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({
        version: Version, assetCode: ShortText.optional(), name: ShortText.optional(), status: ShortText.optional(),
        storageFacilityId: Id.nullable().optional(),
      }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-49": defineApi({
    method: "POST", path: "/equipment", permission: "PER-03", kind: "mutation", success: [201],
    request: obj({
      body: obj({ assetCode: ShortText, name: ShortText, quantity: NonNegative, quantityUnit: ShortText, storage }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-50": defineApi({
    method: "PATCH", path: "/equipment/:id", permission: "PER-03", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({
        version: Version, assetCode: ShortText.optional(), name: ShortText.optional(), quantity: NonNegative.optional(),
        quantityUnit: ShortText.optional(), status: ShortText.optional(), storage: storage.optional(),
      }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-51": defineApi({
    method: "GET", path: "/assets/:type/:id", permission: "PER-01", kind: "get", success: [200],
    request: obj({ params: obj({ type: z.enum(["vehicle", "equipment"]), id: Id }) }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-56": defineApi({
    method: "PUT", path: "/assets/:type/:id/inspection-schedule", permission: "PER-03", kind: "mutation", success: [200, 201],
    request: obj({
      params: obj({ type: z.enum(["vehicle", "equipment"]), id: Id }),
      body: obj({
        version: VersionOrZero, nextDueDate: BusinessDate, intervalDays: z.number().int().min(1).max(3660).optional(),
        timezone: z.string().min(1).max(64),
      }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
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
    response: z.looseObject({}), provisional: true,
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
