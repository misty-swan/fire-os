import { ok, parseApiRequest, defineRoute, type ApiApp } from "../http";
import { readEvents } from "../events/snapshot";

/**
 * 差分取得（API-80、docs/05 §8）。再開cursor以後のoutboxを現在のACLでfilterして返すpoll型のAPI。
 * 接続方式（SSE/poll/DO）はT073・D16で確定させるが、応答の契約（EventPage）はこのAPIが正本。
 * /api/*は必ずJSONで応答する（AGENTS.md）。ok()の本文はEventPage（events/resumeCursor/resyncRequired）。
 */
export function registerEventRoutes(app: ApiApp): void {
  defineRoute(app, "API-80", async (c) => {
    const { query } = await parseApiRequest(c, "API-80");
    const page = await readEvents(c, query.cursor ?? "");
    return ok(c, page);
  });
}
