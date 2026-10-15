import { resolvePrincipal } from "../auth/principal";
import { queryAnalytics } from "../analytics/query";
import { defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { requirePermission } from "./invitations";

/**
 * 月次・年度・団員別集計（T060、docs/05 API-52、docs/03 SCR-26、docs/10 PER-01「業務閲覧/検索/集計」）。
 * 認可前置（PER-01＝この要求の本人の所属unit。他unitの存在件数を漏らさない）のうえ、
 * src/server/analytics/query.ts で集計する（集計の単位・年度の検証設定は同モジュールとAnalytics契約の注記どおり）。
 */
export function registerAnalyticsRoutes(app: ApiApp): void {
  defineRoute(app, "API-52", async (c) => {
    const p = await resolvePrincipal(c);
    const { query } = await parseApiRequest(c, "API-52");
    requirePermission(p, "PER-01", { unitId: p.unitId, type: "activity" });
    return ok(c, await queryAnalytics(c, p, query));
  });
}
