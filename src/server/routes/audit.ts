import { resolvePrincipal } from "../auth/principal";
import { project } from "../auth/projection";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { requirePermission } from "./invitations";

const encodeCursor = (at: string, id: string) => btoa(JSON.stringify([at, id])).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function decodeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/"))) as unknown;
    if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string") return [v[0], v[1]];
  } catch {
    /* 下で400 */
  }
  throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "cursor", reason: "invalid_cursor" }]);
}

/**
 * API-93: 監査ログの検索（読み取り専用）。管理者（PER-08、二要素必須）が、自分の分団の監査だけを、新しい順の安定したkeysetで追跡する。
 * 監査の追加は業務更新と同じbatchだけで、ここを含む一般の業務経路に更新・削除のAPIは無い（PATCH/DELETE/POSTは404）。
 */
export function registerAuditRoutes(app: ApiApp): void {
  defineRoute(app, "API-93", async (c) => {
    const p = await resolvePrincipal(c);
    const { query } = await parseApiRequest(c, "API-93");
    requirePermission(p, "PER-08", { unitId: p.unitId, type: "audit" });

    const where = ["a.unit_id = ?"];
    const binds: unknown[] = [p.unitId];
    if (query.entityType) { where.push("a.entity_type = ?"); binds.push(query.entityType); }
    if (query.entityId) { where.push("a.entity_id = ?"); binds.push(query.entityId); }
    if (query.actorId) { where.push("a.actor_user_id = ?"); binds.push(query.actorId); }
    if (query.from) { where.push("a.occurred_at >= ?"); binds.push(query.from); }
    if (query.to) { where.push("a.occurred_at <= ?"); binds.push(query.to); }
    if (query.cursor) {
      const [at, id] = decodeCursor(query.cursor);
      where.push("(a.occurred_at < ? OR (a.occurred_at = ? AND a.id < ?))");
      binds.push(at, at, id);
    }
    const rows = (
      await c.env.DB.prepare(
        "SELECT a.id, a.occurred_at, a.actor_kind, a.actor_user_id, a.action, a.entity_type, a.entity_id, a.mutation_id, a.metadata_json, e.entity_version, e.event_type " +
          `FROM audit_logs a LEFT JOIN domain_events e ON e.unit_id = a.unit_id AND e.mutation_id = a.mutation_id WHERE ${where.join(" AND ")} ` +
          "ORDER BY a.occurred_at DESC, a.id DESC LIMIT ?",
      ).bind(...binds, query.limit + 1).all<{
        id: string; occurred_at: string; actor_kind: "human" | "system"; actor_user_id: string | null; action: string; entity_type: string;
        entity_id: string; mutation_id: string; metadata_json: string; entity_version: number | null; event_type: string | null;
      }>()
    ).results;
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > query.limit && last ? encodeCursor(last.occurred_at, last.id) : undefined;
    const data = page.map((r) => ({
      id: r.id, occurredAt: r.occurred_at, actorKind: r.actor_kind, actorId: r.actor_user_id, action: r.action,
      entityType: r.entity_type, entityId: r.entity_id, mutationId: r.mutation_id,
      entityVersion: r.entity_version, eventType: r.event_type, metadata: JSON.parse(r.metadata_json) as Record<string, unknown>,
    }));
    return ok(c, project("API-93", p, data), { nextCursor });
  });
}


