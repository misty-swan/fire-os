import { Inspection } from "../inspections/build";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { executeMutation } from "../mutations/execute";
import { buildInspectionMutation } from "../inspections/build";
import { requirePermission } from "./invitations";

/**
 * 点検の訂正（T031、docs/05 API-46、docs/11 §3）。
 * 原本は変更せず、新しい原本＋seriesの現在版ポインタ切替を一つのmutationで行う。
 * 同じ原本から二つの訂正枝は作れない（supersedes_id UNIQUE＋series版ガード）。
 */
export function registerInspectionCorrectionRoutes(app: ApiApp): void {
  defineRoute(app, "API-46", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-46");
    const type = params.type;

    // 元の原本（訂正対象）の存在と所属。seriesの現在版がこの原本であることをbuildの中で確かめる
    const table = type === "facility" ? "facility_inspections" : "asset_inspections";
    const original = await c.env.DB.prepare(`SELECT id, series_id, unit_id, supersedes_id FROM ${table} WHERE id = ?`).bind(params.id)
      .first<{ id: string; series_id: string; unit_id: string; supersedes_id: string | null }>();
    if (!original || original.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");

    // 対象のID（seriesから引く。訂正は同対象・同seriesのみ）
    const series = await c.env.DB.prepare("SELECT * FROM inspection_series WHERE id = ? AND unit_id = ?").bind(original.series_id, p.unitId)
      .first<{ facility_id: string | null; vehicle_id: string | null; equipment_id: string | null }>();
    if (!series) throw new HttpError("NOT_FOUND");
    const targetId = type === "facility" ? series.facility_id : type === "vehicle" ? series.vehicle_id : series.equipment_id;
    if (!targetId) throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "type", reason: "target_mismatch" }]);

    requirePermission(p, "PER-04", { unitId: p.unitId, type, id: targetId, ownerMemberId: body.inspectorMemberId });

    const built = await buildInspectionMutation(c.env, p, {
      target: { type, id: targetId },
      input: body,
      operationCode: "inspection.correction",
      idempotencyKey: headers["idempotency-key"],
      requestHashPath: `/inspections/${type}/${params.id}/corrections`,
      correction: { supersedesId: params.id, reason: body.reason },
    });
    const result = await executeMutation(c.env, p, built.spec);
    return ok(c, Inspection.parse(result.data), {}, 201);
  });
}
