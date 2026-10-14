import { z } from "zod";
import {
  Code100, Cursor, Id, IdListMaybeEmpty, IDEM, Instant, Latitude, Limit, Longitude, Note1000, Note2000, P_ID, Page, Reason, Reason2000, ShortText, Version,
  Body, defineApi, listQuery, noContent, obj, provisionalDto, LIMITS,
} from "./common";
import { attachmentStates, inspectionResults, locationVerificationStates } from "../states";

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
  // DBのCHECK（facilities.location_source/management_number/identifying_name ≤100）に揃える
  locationSource: Code100,
  // DBのCHECK（facilities.location_note 1..1000。NOT NULL）に揃える（空文字は400。500にしない）
  locationNote: Note1000,
  managementNumber: Code100.optional(),
  identifyingName: Code100.optional(),
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
        // 点検明細の項目コード（DBのCHECK inspection_items.item_code ≤100）に揃える
        code: Code100,
        result: z.enum(inspectionResults),
        value: z.union([z.string().max(LIMITS.titleMax), z.number(), z.boolean()]).optional(),
        // DBのCHECK（inspection_items.note 1..2000。未指定はNULL）に揃える（空文字は400）
        note: Note2000.optional(),
      }),
    )
    .min(1)
    .max(LIMITS.arrayMax),
  // DBのCHECK（facility_inspections/asset_inspections.note 1..20000）に揃える（空文字は400）
  note: Body,
  createIssue: z.boolean(),
  attachmentIds: IdListMaybeEmpty,
});
export const inspectionShape = InspectionInput.shape;

/** 施設の応答（docs/04 facilities）。R2鍵など内部値は含めない */
export const Facility = obj({
  id: Id,
  version: Version,
  type: z.enum(facilityTypes),
  managementNumber: z.string().nullable(),
  identifyingName: z.string().nullable(),
  latitude: Latitude,
  longitude: Longitude,
  locationSource: ShortText,
  locationNote: z.string(),
  locationVersion: z.number().int().min(1),
  verificationStatus: z.enum(locationVerificationStates),
  lastVerifiedAt: z.iso.datetime().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type Facility = z.infer<typeof Facility>;

export const LocationRevision = obj({
  id: Id,
  locationVersion: z.number().int().min(1),
  eventNo: z.number().int().min(1),
  latitude: Latitude,
  longitude: Longitude,
  locationSource: ShortText,
  verificationStatus: z.enum(locationVerificationStates),
  verifiedByMemberId: Id.nullable(),
  verifiedAt: z.iso.datetime().nullable(),
  reason: z.string(),
  createdAt: z.iso.datetime(),
});

export const FacilityDetail = obj({
  ...Facility.shape,
  /** リンク済みの添付（idと状態のみ。本文はAPI-27） */
  attachments: z.array(obj({ id: Id, status: z.enum(attachmentStates) })),
  /** 位置の履歴（古い順の1ページ。続きはmeta.nextCursor） */
  locationHistory: z.array(LocationRevision),
});
export type FacilityDetail = z.infer<typeof FacilityDetail>;


export const gisApis = {
  "API-10": defineApi({
    method: "GET", path: "/facilities", permission: "PER-01", kind: "list", success: [200],
    request: obj({ query: FacilityQuery }), response: Page(Facility),
  }),
  "API-11": defineApi({
    method: "POST", path: "/facilities", permission: "PER-03", kind: "mutation", success: [201],
    request: obj({ body: FacilityInput, ...IDEM }), response: Facility,
  }),
  "API-12": defineApi({
    method: "GET", path: "/facilities/:id", permission: "PER-01", kind: "get", success: [200],
    request: obj({ params: P_ID, query: listQuery({}) }),
    response: FacilityDetail,
  }),
  "API-13": defineApi({
    method: "PATCH", path: "/facilities/:id", permission: "PER-03", kind: "mutation", success: [200],
    request: obj({
      params: P_ID,
      // 座標/出典の変更は位置確認を失効させる（サーバー側）。null可は04で?の列だけ。
      // attachmentIds/attachmentDraftIdは変更では受け付けない（編集画面のuploaderは検査の完了時に直リンク。
      // 添付の変更はunlinkと再アップロードで行う。送った場合は未知列の400）
      body: obj({
        ...obj(facilityShape).omit({ attachmentIds: true, attachmentDraftId: true }).partial().shape,
        managementNumber: Code100.nullable().optional(),
        identifyingName: Code100.nullable().optional(),
        version: Version,
      }),
      ...IDEM,
    }),
    response: Facility,
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
      body: obj({ version: Version, locationVersion: Version, decision: z.enum(["request", "verify", "reject"]), reason: Reason2000 }),
      ...IDEM,
    }),
    response: obj({ facility: Facility, revision: LocationRevision }),
  }),
  "API-53": defineApi({
    method: "POST", path: "/facilities/imports", permission: "PER-03", kind: "job", success: [202],
    request: obj({ body: obj({ csvAttachmentId: Id, templateVersion: ShortText }), ...IDEM }),
    response: obj({
      id: Id, jobId: Id,
      /** 解析が終わった後の値（job完了後に読める。未完了はnull） */
      status: z.string().nullable(),
      version: z.number().int().nullable(),
      totalRows: z.number().int().nullable(),
      validRows: z.number().int().nullable(),
      errorRows: z.number().int().nullable(),
      previewHash: z.string().nullable(),
      /** 行ごとのエラー（docs/03 SCR-20「行番号付き」。先頭50件。解析前はnull） */
      errors: z.array(obj({ rowNo: z.number().int().min(1), error: ShortText })).max(50).nullable(),
    }),
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
