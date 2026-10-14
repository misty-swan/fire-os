import { Issue } from "../issues/issue";
import { issueTransitions } from "../../shared/states";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { Target } from "../../shared/contracts/common";
import { requirePermission } from "./invitations";

/**
 * 異常の起票と状態遷移（T032、docs/05 API-15/16/17、docs/11 異常、D07）。
 * 遷移は docs/11 の許可辺のみ（reported→under_review→in_progress→resolved→closed→under_review）。
 * 終了(closed)と対応実施(resolved)を区別し、再開には理由が要る。位置確認・点検結果は変更しない。
 */

const ISSUE_JSON =
  "SELECT json_object(" +
  "'id', id, 'version', version, 'target', json_object('type', CASE WHEN facility_id IS NOT NULL THEN 'facility' WHEN vehicle_id IS NOT NULL THEN 'vehicle' ELSE 'equipment' END, 'id', COALESCE(facility_id, vehicle_id, equipment_id)), " +
  "'title', title, 'description', description, 'reportedBy', reported_by, 'assigneeMemberId', assignee_member_id, 'status', status, " +
  "'confirmedCategory', confirmed_category, 'originInspectionId', COALESCE(source_facility_inspection_id, source_asset_inspection_id), 'createdAt', created_at, 'updatedAt', updated_at) " +
  "FROM issues WHERE id = ?";

export function registerIssueRoutes(app: ApiApp): void {
  // --- API-16: 手動起票（起点なし。対象は既存の施設/車両/資機材） ---
  defineRoute(app, "API-16", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-16");
    const targetTable = body.target.type === "facility" ? "facilities" : body.target.type === "vehicle" ? "vehicles" : "equipment";
    const exists = await c.env.DB.prepare(`SELECT unit_id FROM ${targetTable} WHERE id = ?`).bind(body.target.id)
      .first<{ unit_id: string }>();
    if (!exists || exists.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
    requirePermission(p, "PER-04", { unitId: p.unitId, type: body.target.type, id: body.target.id, ownerMemberId: p.memberId });

    const id = crypto.randomUUID();
    const result = await executeMutation(c.env, p, {
      operationCode: "issue.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/issues", body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [],
      created: [{ table: "issues", id }],
      statements: (ctx) => [
        c.env.DB.prepare(
          `INSERT INTO issues (id, unit_id, ${body.target.type}_id, title, description, reported_by, status, last_mutation_token, created_at, updated_at, created_by, actor_kind) ` +
            "VALUES (?, ?, ?, ?, ?, ?, 'reported', ?, ?, ?, ?, 'human')",
        ).bind(id, p.unitId, body.target.id, body.title, body.description, p.userId, ctx.attempt, ctx.now, ctx.now, p.userId),
        c.env.DB.prepare(
          "INSERT INTO issue_events (id, unit_id, issue_id, action, before_json, after_json, actor_user_id, actor_kind, created_at) VALUES (?, ?, ?, 'reported', '{}', ?, ?, 'human', ?)",
        ).bind(crypto.randomUUID(), p.unitId, id, JSON.stringify({ status: "reported", source: "manual" }), p.userId, ctx.now),
      ],
      audit: { action: "issue.create", entityType: "issue", entityId: id, metadata: { target: body.target.type, source: "manual" } },
      event: { entityType: "issue", entityId: id, entityVersion: 1, eventType: "issue.reported", payload: { target: body.target.type } },
      response: { status: 201, sql: ISSUE_JSON, binds: [id], decode: (j) => Issue.parse(j) },
    });
    return ok(c, result.data, {}, 201);
  });

  // --- API-15: 一覧（対象・状態・担当で絞る。serverで先に絞る） ---
  defineRoute(app, "API-15", async (c) => {
    const p = await resolvePrincipal(c);
    const { query } = await parseApiRequest(c, "API-15");
    requirePermission(p, "PER-01", { unitId: p.unitId, type: "issue" });
    const where = ["unit_id = ?"];
    const binds: unknown[] = [p.unitId];
    if (query.targetType) {
      const col = query.targetType === "facility" ? "facility_id" : query.targetType === "vehicle" ? "vehicle_id" : "equipment_id";
      where.push(`${col} = ?`);
      binds.push(query.targetId);
    }
    if (query.status) { where.push("status = ?"); binds.push(query.status); }
    if (query.assigneeMemberId) { where.push("assignee_member_id = ?"); binds.push(query.assigneeMemberId); }
    if (query.cursor) {
      const [at, id] = decodeCursor(query.cursor);
      where.push("(created_at > ? OR (created_at = ? AND id > ?))");
      binds.push(at, at, id);
    }
    const rows = (
      await c.env.DB.prepare(
        `SELECT * FROM issues WHERE ${where.join(" AND ")} ORDER BY created_at, id LIMIT ?`,
      ).bind(...binds, query.limit + 1).all<Record<string, unknown>>()
    ).results;
    const page = rows.slice(0, query.limit);
    const nextCursor = rows.length > query.limit
      ? encodeCursor(page[page.length - 1]!.created_at as string, page[page.length - 1]!.id as string)
      : undefined;
    const data = page.map((r) =>
      Issue.parse({
        id: r.id, version: r.version,
        target: { type: r.facility_id ? "facility" : r.vehicle_id ? "vehicle" : "equipment", id: r.facility_id ?? r.vehicle_id ?? r.equipment_id },
        title: r.title, description: r.description, reportedBy: r.reported_by, assigneeMemberId: r.assignee_member_id,
        status: r.status, confirmedCategory: r.confirmed_category,
        originInspectionId: r.source_facility_inspection_id ?? r.source_asset_inspection_id,
        createdAt: r.created_at, updatedAt: r.updated_at,
      }),
    );
    return ok(c, data, { nextCursor });
  });

  // --- API-17: 状態遷移・担当割当（PER-05。遷移検査・履歴・監査を同じbatchで） ---
  defineRoute(app, "API-17", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-17");
    const current = await c.env.DB.prepare("SELECT * FROM issues WHERE id = ?").bind(params.id)
      .first<{ id: string; unit_id: string; status: string; version: number; assignee_member_id: string | null }>()
      .then((r) => (r && r.unit_id === p.unitId ? r : null));
    if (!current) throw new HttpError("NOT_FOUND");
    requirePermission(p, "PER-05", { unitId: p.unitId, type: "issue", id: params.id, ownerMemberId: current.assignee_member_id ?? undefined });

    const statusChange = body.status !== undefined && body.status !== current.status;
    if (statusChange && !issueTransitions[current.status as keyof typeof issueTransitions].includes(body.status!)) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "status", reason: "transition_not_allowed" }]);
    }
    const reopen = body.status === "under_review" && current.status === "closed";
    if (reopen && !body.reason?.trim()) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "reason", reason: "reason_required" }]);
    }
    if (body.assigneeMemberId) {
      const m = await c.env.DB.prepare("SELECT unit_id FROM members WHERE id = ?").bind(body.assigneeMemberId).first<{ unit_id: string }>();
      if (!m || m.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
    }
    const changed = [
      ...(statusChange ? ["status"] : []),
      ...(body.assigneeMemberId !== undefined ? ["assignee"] : []),
    ].join(".");

    const result = await executeMutation(c.env, p, {
      operationCode: "issue.update",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "PATCH", path: `/issues/${params.id}`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{
        table: "issues", id: params.id, expectedVersion: body.version,
        allowedStates: statusChange ? { column: "status", values: [current.status] } : undefined,
      }],
      statements: (ctx) => [
        c.env.DB.prepare(
          "UPDATE issues SET " +
            "status = CASE WHEN ? = 1 THEN ? ELSE status END, " +
            "assignee_member_id = CASE WHEN ? = 1 THEN ? ELSE assignee_member_id END, " +
            "version = version + 1, last_mutation_token = ?, updated_at = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ?",
        ).bind(statusChange ? 1 : 0, body.status ?? current.status, body.assigneeMemberId !== undefined ? 1 : 0, body.assigneeMemberId ?? null, ctx.attempt, ctx.now, params.id, p.unitId, body.version),
        // 履歴（docs/04 issue_events。変更の前後をID・状態の形で残す。本文は複製しない）
        c.env.DB.prepare(
          "INSERT INTO issue_events (id, unit_id, issue_id, action, before_json, after_json, note, actor_user_id, actor_kind, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'human', ?)",
        ).bind(
          crypto.randomUUID(), p.unitId, params.id,
          statusChange ? `status.${current.status}_to_${body.status}` : "assignee.changed",
          JSON.stringify({ status: current.status, assignee: current.assignee_member_id }),
          JSON.stringify({ status: statusChange ? body.status : current.status, assignee: body.assigneeMemberId !== undefined ? body.assigneeMemberId : current.assignee_member_id }),
          body.reason ?? null, p.userId, ctx.now,
        ),
      ],
      audit: { action: "issue.update", entityType: "issue", entityId: params.id, metadata: { changed, to: statusChange ? body.status! : current.status } },
      event: { entityType: "issue", entityId: params.id, entityVersion: body.version + 1, eventType: "issue.updated", payload: { changed } },
      response: { status: 200, sql: ISSUE_JSON, binds: [params.id], decode: (j) => Issue.parse(j) },
    });
    return ok(c, result.data);
  });
}

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
void Target;
