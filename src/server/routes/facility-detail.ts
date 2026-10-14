import { FacilityDetail, LocationRevision } from "../../shared/contracts/gis";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { loadFacility } from "./facility-writes";
import { requirePermission } from "./invitations";

/**
 * 施設の詳細（T019、API-12）。台帳＋リンク済み添付（idと状態）＋位置履歴（cursor）を返す。
 * 履歴は古い順（登録時から）。点検・異常の一覧はT029/T032でこの詳細に足す。
 */

interface RevisionRow {
  id: string; location_version: number; event_no: number; latitude: number; longitude: number;
  location_source: string; verification_status: string; verified_by_member_id: string | null;
  verified_at: string | null; reason: string; created_at: string;
}

const encodeCursor = (locationVersion: number, eventNo: number) =>
  btoa(JSON.stringify([locationVersion, eventNo])).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function decodeCursor(cursor: string): [number, number] {
  try {
    const v = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") return [v[0], v[1]];
  } catch {
    /* 下で400 */
  }
  throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "cursor", reason: "invalid_cursor" }]);
}

export function registerFacilityDetailRoutes(app: ApiApp): void {
  defineRoute(app, "API-12", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, query } = await parseApiRequest(c, "API-12");
    requirePermission(p, "PER-01", { unitId: p.unitId, type: "facility", id: params.id });
    const facility = await loadFacility(c.env, params.id, p.unitId);
    if (!facility) throw new HttpError("NOT_FOUND"); // 別unitも同じ応答

    // 位置履歴（古い順のkeyset: (location_version, event_no)）
    const where = ["facility_id = ?", "unit_id = ?"];
    const binds: unknown[] = [params.id, p.unitId];
    if (query.cursor) {
      const [version, eventNo] = decodeCursor(query.cursor);
      where.push("(location_version > ? OR (location_version = ? AND event_no > ?))");
      binds.push(version, version, eventNo);
    }
    const revisions = (
      await c.env.DB.prepare(
        `SELECT * FROM facility_location_revisions WHERE ${where.join(" AND ")} ORDER BY location_version, event_no LIMIT ?`,
      ).bind(...binds, query.limit + 1).all<RevisionRow>()
    ).results;
    const page = revisions.slice(0, query.limit);
    const nextCursor = revisions.length > query.limit
      ? encodeCursor(page[page.length - 1]!.location_version, page[page.length - 1]!.event_no)
      : undefined;

    // リンク済み添付（idと状態だけ。本文の取得はAPI-27が毎回ACLを検査する）
    const attachments = await c.env.DB.prepare(
      "SELECT a.id, a.status FROM attachments a JOIN attachment_links l ON l.attachment_id = a.id AND l.unit_id = a.unit_id " +
        "WHERE l.entity_type = 'facility' AND l.entity_id = ? AND l.unit_id = ? AND l.unlinked_at IS NULL ORDER BY a.id",
    ).bind(params.id, p.unitId).all<{ id: string; status: string }>();

    const locationHistory = page.map((r) => LocationRevision.parse({
      id: r.id, locationVersion: r.location_version, eventNo: r.event_no, latitude: r.latitude, longitude: r.longitude,
      locationSource: r.location_source, verificationStatus: r.verification_status,
      verifiedByMemberId: r.verified_by_member_id, verifiedAt: r.verified_at, reason: r.reason, createdAt: r.created_at,
    }));
    const data = {
      id: facility.id,
      version: facility.version,
      type: facility.type as "hydrant" | "cistern" | "box",
      managementNumber: facility.management_number,
      identifyingName: facility.identifying_name,
      latitude: facility.latitude,
      longitude: facility.longitude,
      locationSource: facility.location_source,
      locationNote: facility.location_note,
      locationVersion: facility.location_version,
      verificationStatus: facility.verification_status as "unverified" | "pending" | "verified" | "rejected",
      lastVerifiedAt: facility.last_verified_at,
      metadata: JSON.parse(facility.metadata) as Record<string, unknown>,
      attachments: attachments.results.map((a) => ({ id: a.id, status: a.status as "ready" })),
      locationHistory,
    };
    return ok(c, FacilityDetail.parse(data), { nextCursor });
  });
}
