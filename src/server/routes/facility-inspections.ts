import { Inspection } from "../inspections/build";
import { inspectionResults } from "../../shared/states";
import { buildInspectionMutation } from "../inspections/build";
import { executeMutation } from "../mutations/execute";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { requirePermission } from "./invitations";

/**
 * 施設の点検（T029、docs/05 API-14/44）。原本・明細・起点異常・添付リンクを一つのbatchで保存する。
 * 実施者の指定はPER-04（幹部・管理者は分団内、担当者は担当対象、一般団員は自分）。
 */
export function registerFacilityInspectionRoutes(app: ApiApp): void {
  // --- API-14: 施設点検の保存 ---
  defineRoute(app, "API-14", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-14");
    requirePermission(p, "PER-04", { unitId: p.unitId, type: "facility", id: params.id, ownerMemberId: body.inspectorMemberId });
    const built = await buildInspectionMutation(c.env, p, {
      target: { type: "facility", id: params.id },
      input: body,
      operationCode: "facility_inspection.create",
      idempotencyKey: headers["idempotency-key"],
      requestHashPath: `/facilities/${params.id}/inspections`,
    });
    const result = await executeMutation(c.env, p, built.spec);
    return ok(c, Inspection.parse(result.data), {}, 201);
  });

  // --- API-44: 施設の点検履歴（最新有効版＝現在版。過去の訂正前の原本も参照できる） ---
  defineRoute(app, "API-44", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, query } = await parseApiRequest(c, "API-44");
    requirePermission(p, "PER-01", { unitId: p.unitId, type: "facility", id: params.id });
    const facility = await c.env.DB.prepare("SELECT unit_id FROM facilities WHERE id = ?").bind(params.id)
      .first<{ unit_id: string }>();
    if (!facility || facility.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");

    const where = ["i.facility_id = ?", "i.unit_id = ?"];
    const binds: unknown[] = [params.id, p.unitId];
    if (query.from) { where.push("i.inspected_at >= ?"); binds.push(query.from); }
    if (query.to) { where.push("i.inspected_at < ?"); binds.push(query.to); }
    if (query.result) { where.push("i.result = ?"); binds.push(query.result); }
    if (query.cursor) {
      // from/to/resultで絞った安定keyset（inspected_at, id）。cursorはその最後の組
      const [at, id] = decodeCursor(query.cursor);
      where.push("(i.inspected_at > ? OR (i.inspected_at = ? AND i.id > ?))");
      binds.push(at, at, id);
    }
    const rows = (
      await c.env.DB.prepare(
        "SELECT i.id, i.inspected_at FROM facility_inspections i WHERE " + where.join(" AND ") + " ORDER BY i.inspected_at DESC, i.id DESC LIMIT ?",
      ).bind(...binds, query.limit + 1).all<{ id: string; inspected_at: string }>()
    ).results;
    const page = rows.slice(0, query.limit);
    const list = page.length === 0 ? [] : (
      await c.env.DB.batch(page.map((r) => c.env.DB.prepare(FACILITY_INSPECTION_JSON).bind(r.id)))
    ).map((res) => {
      const row = res.results[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      const first = Object.values(row)[0];
      return typeof first === "string" ? JSON.parse(first) : first;
    });
    const nextCursor = rows.length > query.limit
      ? encodeCursor(page[page.length - 1]!.inspected_at, page[page.length - 1]!.id)
      : undefined;
    return ok(c, list.filter(Boolean), { nextCursor });
  });
}

const FACILITY_INSPECTION_JSON =
  "SELECT json_object(" +
  "'id', i.id, 'seriesId', i.series_id, 'seriesVersion', s.version, 'target', json_object('type', 'facility', 'id', i.facility_id), " +
  "'templateVersionId', i.template_version_id, 'inspectorMemberId', i.inspector_member_id, 'inspectedAt', i.inspected_at, " +
  "'result', i.result, 'note', i.note, 'supersedesId', i.supersedes_id, 'correctionReason', i.correction_reason, 'createdAt', i.created_at, " +
  "'items', (SELECT json_group_array(json_object('code', m.item_code, 'result', m.result, 'value', json(m.value_json), 'note', m.note)) FROM inspection_items m WHERE m.facility_inspection_id = i.id)) " +
  "FROM facility_inspections i JOIN inspection_series s ON s.id = i.series_id WHERE i.id = ?";

const encodeCursor = (at: string, id: string) =>
  btoa(unescape(encodeURIComponent(JSON.stringify([at, id])))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function decodeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(decodeURIComponent(escape(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))))) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string") return [v[0], v[1]];
  } catch {
    /* 下で400 */
  }
  throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "cursor", reason: "invalid_cursor" }]);
}

