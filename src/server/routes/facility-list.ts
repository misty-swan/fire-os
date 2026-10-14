import { resolvePrincipal } from "../auth/principal";
import { defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { queryFacilities } from "../gis/query";
import { requirePermission } from "./invitations";

/** API-10: 施設の一覧・地図の全件取得（T020）。続き取得は署名付きcursor（filterHash/snapshotRevision）で行う */
export function registerFacilityListRoutes(app: ApiApp): void {
  defineRoute(app, "API-10", async (c) => {
    const p = await resolvePrincipal(c);
    const { query } = await parseApiRequest(c, "API-10");
    requirePermission(p, "PER-01", { unitId: p.unitId, type: "facility" });
    const result = await queryFacilities(c.env, p.unitId, c.env.BETTER_AUTH_SECRET, query);
    return ok(c, result.items, { nextCursor: result.nextCursor, snapshotRevision: result.snapshotRevision });
  });
}
