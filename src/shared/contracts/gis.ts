import { z } from "zod";
import {
  Id, IdListMaybeEmpty, IDEM, Instant, Latitude, Longitude, P_ID, Page, Reason, ShortText, Version,
  defineApi, listQuery, noContent, obj, provisionalDto, OptionalBody, LIMITS,
} from "./common";
import { inspectionResults, locationVerificationStates } from "../states";

export const facilityTypes = ["hydrant", "cistern", "box"] as const;

/** bbox=west,south,east,north。境界包含、南<=北、経度跨ぎ(west>east)を許可。 */
export const Bbox = z.string().refine((v) => {
  const p = v.split(",").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return false;
  const [west, south, east, north] = p as [number, number, number, number];
  return west >= -180 && west <= 180 && east >= -180 && east <= 180 && south >= -90 && north <= 90 && south <= north;
}, "bbox は west,south,east,north（南<=北）で指定してください");

export const FacilityQuery = listQuery({
  bbox: Bbox.optional(),
  type: z.enum(facilityTypes).optional(),
  q: ShortText.optional(),
  verificationStatus: z.enum(locationVerificationStates).optional(),
  inspectionResult: z.enum(inspectionResults).optional(),
  hasOpenIssue: z.stringbool().optional(),
});

const facilityShape = {
  type: z.enum(facilityTypes),
  latitude: Latitude,
  longitude: Longitude,
  locationSource: ShortText,
  locationNote: OptionalBody.max(1000),
  managementNumber: ShortText.optional(),
  identifyingName: ShortText.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  attachmentIds: IdListMaybeEmpty.optional(),
  /** 新規entityに添付を同時確定する場合の予約ID（API-98）。一回だけ消費 */
  attachmentDraftId: Id.optional(),
};
/** 番号か識別名のどちらか必須（04: facilities） */
export const FacilityInput = obj(facilityShape).refine((v) => !!v.managementNumber || !!v.identifyingName, {
  message: "managementNumber か identifyingName のどちらかが必要です",
});

export const InspectionInput = obj({
  templateVersionId: Id,
  inspectedAt: Instant,
  inspectorMemberId: Id,
  result: z.enum(inspectionResults),
  checkItems: z
    .array(
      obj({
        code: ShortText,
        result: z.enum(inspectionResults),
        value: z.union([z.string().max(LIMITS.titleMax), z.number(), z.boolean()]).optional(),
        note: OptionalBody.optional(),
      }),
    )
    .min(1)
    .max(LIMITS.arrayMax),
  note: OptionalBody,
  createIssue: z.boolean(),
  attachmentIds: IdListMaybeEmpty,
});
export const inspectionShape = InspectionInput.shape;

export const gisApis = {
  "API-10": defineApi({
    method: "GET", path: "/facilities", permission: "PER-01", kind: "list", success: [200],
    request: obj({ query: FacilityQuery }), response: Page(provisionalDto()), provisional: true,
  }),
  "API-11": defineApi({
    method: "POST", path: "/facilities", permission: "PER-03", kind: "mutation", success: [201],
    request: obj({ body: FacilityInput, ...IDEM }), response: provisionalDto(), provisional: true,
  }),
  "API-12": defineApi({
    method: "GET", path: "/facilities/:id", permission: "PER-01", kind: "get", success: [200],
    request: obj({ params: P_ID }), response: provisionalDto(), provisional: true,
  }),
  "API-13": defineApi({
    method: "PATCH", path: "/facilities/:id", permission: "PER-03", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      // 座標/出典の変更は位置確認を失効させる（サーバー側）。null可は04で?の列だけ。
      body: obj({
        ...obj(facilityShape).partial().shape,
        managementNumber: ShortText.nullable().optional(),
        identifyingName: ShortText.nullable().optional(),
        version: Version,
      }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-14": defineApi({
    method: "POST", path: "/facilities/:id/inspections", permission: "PER-04", kind: "mutation", success: [201],
    request: obj({ params: P_ID, body: InspectionInput, ...IDEM }), response: provisionalDto(), provisional: true,
  }),
  "API-44": defineApi({
    method: "GET", path: "/facilities/:id/inspections", permission: "PER-01", kind: "list", success: [200],
    request: obj({
      params: P_ID,
      query: listQuery({ from: Instant.optional(), to: Instant.optional(), result: z.enum(inspectionResults).optional() }),
    }),
    response: Page(provisionalDto()), provisional: true,
  }),
  "API-45": defineApi({
    method: "POST", path: "/facilities/:id/location-reviews", permission: "PER-03確認許可", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      body: obj({ version: Version, locationVersion: Version, decision: z.enum(["request", "verify", "reject"]), reason: Reason }),
      ...IDEM,
    }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-53": defineApi({
    method: "POST", path: "/facilities/imports", permission: "PER-03", kind: "job", success: [202],
    request: obj({ body: obj({ csvAttachmentId: Id, templateVersion: ShortText }), ...IDEM }),
    response: provisionalDto(), provisional: true,
  }),
  "API-54": defineApi({
    method: "POST", path: "/facilities/imports/:id/commit", permission: "PER-03", kind: "job", success: [200, 202],
    request: obj({
      params: P_ID,
      body: obj({ version: Version, previewHash: z.string().min(1).max(128), conflictResolution: ShortText }),
      ...IDEM,
    }),
    response: provisionalDto(), provisional: true,
  }),
  "API-55": defineApi({
    method: "GET", path: "/facilities/export", permission: "PER-03閲覧＋出力", kind: "binary", success: [200],
    request: obj({ query: FacilityQuery }), response: noContent,
  }),
} as const;
