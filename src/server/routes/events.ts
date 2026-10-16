import { ok, parseApiRequest, defineRoute, type ApiApp } from "../http";
import { EventTransport } from "../events/transport";

/**
 * 差分取得（API-80、docs/05 §8）。poll輸送（T073で固定。docs/14 D16・docs/evidence/V06-realtime.md）の
 * 1周期＝1ページを返す。輸送の契約とpoll間隔の根拠はsrc/server/events/transport.ts。
 * /api/*は必ずJSONで応答する（AGENTS.md）。ok()の本文はEventPage（events/resumeCursor/resyncRequired）。
 */
export function registerEventRoutes(app: ApiApp): void {
  defineRoute(app, "API-80", async (c) => {
    const { query } = await parseApiRequest(c, "API-80");
    const page = await EventTransport.firstPage(c, {
      cursor: query.cursor ?? "",
      filter: { entityType: query.entityType ?? null, entityId: query.entityId ?? null },
    });
    return ok(c, page);
  });
}
