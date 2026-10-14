import { Id, Target } from "../../shared/contracts/common";
import { inspectionResults } from "../../shared/states";
import { z } from "zod";
import type { AppEnv } from "../env";
import { HttpError } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation, type ExtraCondition, type MutationSpec, type RootGuard } from "../mutations/execute";
import { validateItems, type InspectionItemInput } from "./validate-items";
import { planAttachmentLinks } from "../attachments/link";

/**
 * 点検（docs/04 inspection_items、docs/05 InspectionInput/DTO）。T029で暫定DTOから確定した応答の形。
 */
export const InspectionItemDto = z.object({
  code: z.string(),
  result: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]).nullable().optional(),
  note: z.string().nullable().optional(),
});

export const Inspection = z.object({
  id: Id,
  seriesId: Id,
  seriesVersion: z.number().int().min(1),
  target: Target,
  templateVersionId: Id,
  inspectorMemberId: Id,
  inspectedAt: z.iso.datetime(),
  result: z.enum(inspectionResults),
  note: z.string(),
  items: z.array(InspectionItemDto),
  supersedesId: Id.nullable(),
  correctionReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type Inspection = z.infer<typeof Inspection>;

export interface InspectionInputData {
  templateVersionId: string;
  inspectedAt: string;
  inspectorMemberId: string;
  result: "ok" | "needs_review" | "unknown";
  checkItems: { code: string; result: string; value?: string | number | boolean; note?: string }[];
  note: string;
  createIssue: boolean;
  /** ready添付を点検と同じ確定でリンクする（docs/05 InspectionInput.attachmentIds。未検査は422 ATTACHMENT_NOT_READY） */
  attachmentIds?: string[];
}

export interface SeriesRow {
  id: string; unit_id: string; version: number;
  facility_id: string | null; vehicle_id: string | null; equipment_id: string | null;
  current_facility_inspection_id: string | null; current_asset_inspection_id: string | null;
}

export interface BuiltInspection {
  spec: MutationSpec<unknown>;
  inspectionId: string;
  issueId: string | null;
}

const FACILITY_JSON =
  "SELECT json_object(" +
  "'id', i.id, 'seriesId', i.series_id, 'seriesVersion', s.version, 'target', json_object('type', 'facility', 'id', i.facility_id), " +
  "'templateVersionId', i.template_version_id, 'inspectorMemberId', i.inspector_member_id, 'inspectedAt', i.inspected_at, " +
  "'result', i.result, 'note', i.note, 'supersedesId', i.supersedes_id, 'correctionReason', i.correction_reason, 'createdAt', i.created_at, " +
  "'items', (SELECT json_group_array(json_object('code', m.item_code, 'result', m.result, 'value', json(m.value_json), 'note', m.note)) FROM inspection_items m WHERE m.facility_inspection_id = i.id)) " +
  "FROM facility_inspections i JOIN inspection_series s ON s.id = i.series_id WHERE i.id = ?";

const ASSET_JSON =
  "SELECT json_object(" +
  "'id', i.id, 'seriesId', i.series_id, 'seriesVersion', s.version, 'target', json_object('type', CASE WHEN i.vehicle_id IS NOT NULL THEN 'vehicle' ELSE 'equipment' END, 'id', COALESCE(i.vehicle_id, i.equipment_id)), " +
  "'templateVersionId', i.template_version_id, 'inspectorMemberId', i.inspector_member_id, 'inspectedAt', i.inspected_at, " +
  "'result', i.result, 'note', i.note, 'supersedesId', i.supersedes_id, 'correctionReason', i.correction_reason, 'createdAt', i.created_at, " +
  "'items', (SELECT json_group_array(json_object('code', m.item_code, 'result', m.result, 'value', json(m.value_json), 'note', m.note)) FROM inspection_items m WHERE m.asset_inspection_id = i.id)) " +
  "FROM asset_inspections i JOIN inspection_series s ON s.id = i.series_id WHERE i.id = ?";

/**
 * 点検1件の原子更新を作る（T029施設/T030資産/T031訂正で共用）。
 * 対象・様式版・実施者・seriesを検査し、原本＋明細＋起点異常＋seriesポインタ切替を1つのbatchにする。
 */
export async function buildInspectionMutation(
  env: AppEnv,
  principal: { unitId: string; userId: string; authzVersion: number },
  opts: {
    target: { type: "facility" | "vehicle" | "equipment"; id: string };
    input: InspectionInputData;
    operationCode: string;
    idempotencyKey: string;
    requestHashPath: string;
    /** 訂正（T031）のときだけ。元の原本のIDと訂正理由、クライアントが宣言したseries版（docs/05 API-46のseries版ガード） */
    correction?: { supersedesId: string; reason: string; seriesVersion: number };
  },
): Promise<BuiltInspection> {
  const { target, input, correction } = opts;

  // 1) 対象の存在と所属
  let facilityLocationVersion: number | null = null;
  if (target.type === "facility") {
    const f = await env.DB.prepare("SELECT unit_id, location_version FROM facilities WHERE id = ?").bind(target.id)
      .first<{ unit_id: string; location_version: number }>();
    if (!f || f.unit_id !== principal.unitId) throw new HttpError("NOT_FOUND");
    facilityLocationVersion = f.location_version;
  } else {
    const table = target.type === "vehicle" ? "vehicles" : "equipment";
    const row = await env.DB.prepare(`SELECT unit_id FROM ${table} WHERE id = ?`).bind(target.id).first<{ unit_id: string }>();
    if (!row || row.unit_id !== principal.unitId) throw new HttpError("NOT_FOUND");
  }

  // 2) 承認済み様式版（対象種別の一致。未承認・別対象の様式は使えない）
  const templateVersion = await env.DB.prepare(
    "SELECT v.id, v.unit_id, t.target_type, v.item_schema, v.status FROM inspection_template_versions v " +
      "JOIN inspection_templates t ON t.id = v.template_id WHERE v.id = ?",
  ).bind(input.templateVersionId)
    .first<{ id: string; unit_id: string; target_type: string; item_schema: string; status: string }>()
    .then((r) => (r && r.unit_id === principal.unitId ? r : null));
  if (!templateVersion) throw new HttpError("NOT_FOUND");
  if (templateVersion.status !== "approved") {
    throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "templateVersionId", reason: "template_not_approved" }]);
  }
  if (templateVersion.target_type !== target.type) {
    throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "templateVersionId", reason: "target_type_mismatch" }]);
  }
  const schema = JSON.parse(templateVersion.item_schema) as Parameters<typeof validateItems>[0];
  const check = validateItems(schema, input.checkItems);
  if (!check.valid) {
    throw new HttpError("VALIDATION_ERROR", undefined, check.errors.slice(0, 10).map((e) => ({ field: `checkItems.${e.code}`, reason: e.reason })));
  }

  // 3) 実施者の所属（対象と同じunitの団員）。休団・退団の団員は実施者にできない（docs/10 PER-04の対象条件）
  const inspector = await env.DB.prepare("SELECT unit_id, status FROM members WHERE id = ?").bind(input.inspectorMemberId)
    .first<{ unit_id: string; status: string }>();
  if (!inspector || inspector.unit_id !== principal.unitId) throw new HttpError("NOT_FOUND");
  if (inspector.status !== "active") {
    throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "inspectorMemberId", reason: "inspector_not_active" }]);
  }

  // 4) series（既存があれば使う。無ければ同じbatchで作る）
  const seriesColumn = target.type === "facility" ? "facility_id" : target.type === "vehicle" ? "vehicle_id" : "equipment_id";
  const existingSeries = await env.DB.prepare(`SELECT * FROM inspection_series WHERE ${seriesColumn} = ? AND unit_id = ?`)
    .bind(target.id, principal.unitId)
    .first<SeriesRow>();

  const inspectionId = crypto.randomUUID();
  const issueId = input.createIssue ? crypto.randomUUID() : null;
  const newSeriesId = existingSeries ? null : crypto.randomUUID();
  const inspectionTable = target.type === "facility" ? "facility_inspections" : "asset_inspections";
  const responseSql = target.type === "facility" ? FACILITY_JSON : ASSET_JSON;

  const roots: RootGuard[] = [];
  const conditions: ExtraCondition[] = [];
  const created: { table: string; id: string }[] = [
    { table: inspectionTable, id: inspectionId },
    ...(newSeriesId ? [{ table: "inspection_series", id: newSeriesId }] : []),
  ];
  if (issueId) created.push({ table: "issues", id: issueId });

  if (existingSeries) {
    // 既存seriesの現在版ガード（訂正の競合・並行の点検の両方をここで検出する）。
    // 訂正はクライアントが宣言したseriesVersionで競合を検出する（docs/05 API-46の「series版ガード」。
    // 再読した現在版で黙って通すと、古い版を見ていた画面からの訂正がそのまま通ってしまう）。
    // 非訂正の作成は従来どおり再読値（並行の初回点検の競合は系列の一意索引とポインタ更新で守る）
    roots.push({
      table: "inspection_series", id: existingSeries.id,
      expectedVersion: correction ? correction.seriesVersion : existingSeries.version,
    });
  }
  if (correction) {
    if (!existingSeries) throw new HttpError("NOT_FOUND");
    // 訂正対象（supersedesId）がseriesの現在版であること。現在版以外から枝分かれする訂正は作れない
    const pointerCol = target.type === "facility" ? "current_facility_inspection_id" : "current_asset_inspection_id";
    // 訂正元が現在版でなくなったのは「他の訂正で更新された」こと。docs/16どおり409にする
    conditions.push({
      existsSql: `SELECT 1 FROM inspection_series WHERE id = ? AND unit_id = ? AND ${pointerCol} = ?`,
      binds: [existingSeries.id, principal.unitId, correction.supersedesId],
      failCode: "VERSION_CONFLICT",
    });
  }

  // ready添付のリンク（docs/05 InspectionInput.attachmentIds）。リンク先の点検行はこのbatchで作るため
  // 存在条件を付けず、リンク文は点検のINSERTと同じbatchに入れる（docs/07 §3.5「添付は業務と同時に確定」）
  const link = (input.attachmentIds?.length ?? 0) > 0
    ? await planAttachmentLinks(env, principal.unitId, principal.userId, {
        target: { type: "inspection", id: inspectionId },
        attachmentIds: input.attachmentIds!,
        targetCreatedInBatch: true,
      })
    : null;

  const statements = (ctx: { attempt: string; now: string }): D1PreparedStatement[] => {
    const stmts: D1PreparedStatement[] = [];
    const seriesId = existingSeries ? existingSeries.id : newSeriesId!;
    if (newSeriesId) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO inspection_series (id, unit_id, ${seriesColumn}, ${target.type === "facility" ? "current_facility_inspection_id" : "current_asset_inspection_id"}, created_at, updated_at, created_by, actor_kind) ` +
            `VALUES (?, ?, ?, ?, ?, ?, ?, 'human')`,
        ).bind(newSeriesId, principal.unitId, target.id, inspectionId, ctx.now, ctx.now, principal.userId),
      );
    }
    if (target.type === "facility") {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO facility_inspections (id, unit_id, series_id, facility_id, template_version_id, inspector_member_id, inspected_at, result, note, location_version, supersedes_id, correction_reason, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human')",
        ).bind(
          inspectionId, principal.unitId, seriesId, target.id,
          input.templateVersionId, input.inspectorMemberId, input.inspectedAt, input.result, input.note,
          facilityLocationVersion ?? 1, correction?.supersedesId ?? null, correction?.reason ?? null,
          ctx.attempt, ctx.now, ctx.now, principal.userId,
        ),
      );
    } else {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO asset_inspections (id, unit_id, series_id, vehicle_id, equipment_id, template_version_id, inspector_member_id, inspected_at, result, note, supersedes_id, correction_reason, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human')",
        ).bind(
          inspectionId, principal.unitId, seriesId,
          target.type === "vehicle" ? target.id : null, target.type === "equipment" ? target.id : null,
          input.templateVersionId, input.inspectorMemberId, input.inspectedAt, input.result, input.note,
          correction?.supersedesId ?? null, correction?.reason ?? null,
          ctx.attempt, ctx.now, ctx.now, principal.userId,
        ),
      );
    }
    for (const item of input.checkItems) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO inspection_items (id, unit_id, ${target.type === "facility" ? "facility_inspection_id" : "asset_inspection_id"}, item_code, result, value_json, note, created_at, actor_kind) ` +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'human')",
        ).bind(
          crypto.randomUUID(), principal.unitId, inspectionId, item.code, item.result,
          item.value === undefined ? null : JSON.stringify(item.value), item.note ?? null, ctx.now,
        ),
      );
    }
    // seriesの現在版ポインタを新しい原本へ（訂正・新規ともに。並行点検はseriesの版ガードで片方だけ成功）
    stmts.push(
      env.DB.prepare(
        `UPDATE inspection_series SET ${target.type === "facility" ? "current_facility_inspection_id" : "current_asset_inspection_id"} = ?, ` +
          "version = version + 1, updated_at = ?, last_mutation_token = ? WHERE id = ? AND unit_id = ?",
      ).bind(inspectionId, ctx.now, ctx.attempt, seriesId, principal.unitId),
    );
    if (issueId) {
      // 起点異常（docs/04: 起点は点検で対象一致。ここで作る異常は未確認(reported)から始まる）
      stmts.push(
        env.DB.prepare(
          `INSERT INTO issues (id, unit_id, ${seriesColumn}, source_${target.type === "facility" ? "facility" : "asset"}_inspection_id, title, description, reported_by, status, last_mutation_token, created_at, updated_at, created_by, actor_kind) ` +
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'reported', ?, ?, ?, ?, 'human')",
        ).bind(
          issueId, principal.unitId, target.id, inspectionId,
          "点検で異常を確認", input.note, principal.userId, ctx.attempt, ctx.now, ctx.now, principal.userId,
        ),
        env.DB.prepare(
          "INSERT INTO issue_events (id, unit_id, issue_id, action, before_json, after_json, actor_user_id, actor_kind, created_at) VALUES (?, ?, ?, 'reported', '{}', ?, ?, 'human', ?)",
        ).bind(crypto.randomUUID(), principal.unitId, issueId, JSON.stringify({ status: "reported", source: "inspection" }), principal.userId, ctx.now),
      );
    }
    return stmts;
  };

  const spec: MutationSpec<unknown> = {
    operationCode: opts.operationCode,
    key: opts.idempotencyKey,
    requestHash: await canonicalRequestHash({ method: "POST", path: opts.requestHashPath, body: { target: target.id, ...input } }),
    expectedAuthzVersion: principal.authzVersion,
    roots,
    created,
    conditions: [...conditions, ...(link?.conditions ?? [])],
    statements: (ctx) => [
      ...statements(ctx),
      ...(link ? link.statements(ctx) : []),
    ] as unknown as D1PreparedStatement[],
    audit: {
      action: `${target.type}_inspection.create`, entityType: target.type === "facility" ? "facility_inspection" : "asset_inspection",
      entityId: inspectionId, metadata: { result: input.result, issue: input.createIssue ? "created" : "none" },
    },
    event: {
      entityType: target.type === "facility" ? "facility_inspection" : "asset_inspection", entityId: inspectionId,
      entityVersion: 1, eventType: "inspection.created", payload: { result: input.result },
    },
    duplicateOn: [
      "facility_inspections.supersedes_id",
      "asset_inspections.supersedes_id",
      // 対象ごとの系列は一つ（docs/04。0014の部分一意索引。二重作成は409 DUPLICATE）
      ...(newSeriesId ? [`index:uq_series_${target.type}`] : []),
      ...(link ? link.duplicateOn : []),
    ],
    response: { status: 201, sql: responseSql, binds: [inspectionId], decode: (j) => Inspection.parse(j) },
  };

  return { spec, inspectionId, issueId };
}
