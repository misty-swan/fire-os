import { Activity, Incident, IncidentDetail, IncidentEvent, IncidentParticipant } from "../../shared/contracts/operations";
import { canTransition, incidentTransitions } from "../../shared/states";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp, type ApiContext } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { requirePermission } from "./invitations";
import { buildResourceUsageMutation, toResourceUsageDto, type ResourceUsageRowShape } from "./resource-usages";

/**
 * 出動（模擬・訓練・実出動記録）の登録・状態変更・一覧・詳細
 * （T040、docs/05 API-21/22/69/70、docs/11 出動イベントrecording行、docs/04:94-97、docs/14 D08）。
 * 種別（kind=simulation/training/actual_record）と状態（status=recording→active/closed/voided）は別契約で、
 * 種別は状態と独立に訂正できる（理由必須）。遷移はdocs/11の許可辺のみ
 * （recording→active/closed/voided、active→closed、closed→recording（訂正）。voidedは終端で閲覧のみ）。
 * 出来事root（operations）と出動rootを同じbatchで確定し、voidedでcountable=0にする（docs/04「無効時countable=0」）。
 * 出動命令は自動発行しない（docs/11「正式指令を発行しない」）。登録・状態変更は監査/outboxまで一つのbatch。
 * 参集（API-23）はincident-participants.ts（T041）、使用履歴（API-57/22のresourceUsages）は
 * resource-usages.ts（T042で接続）、活動operationの統合（API-71）はT043。
 */

const INCIDENT_JSON =
  "SELECT json_object('id', id, 'version', version, 'operationId', operation_id, 'activityId', activity_id, " +
  "'kind', kind, 'occurredAt', occurred_at, 'summary', summary, 'status', status, 'createdBy', created_by, " +
  "'createdAt', created_at, 'updatedAt', updated_at) FROM incidents WHERE id = ?";

interface IncidentRow {
  id: string; unit_id: string; operation_id: string; activity_id: string | null;
  kind: string; occurred_at: string; summary: string; status: string; version: number;
  created_by: string; created_at: string; updated_at: string;
}
type IncidentWithOperation = IncidentRow & { operation_version: number };

/** 出動と出来事root（状態を写す先）を読む。別unit/存在しない対象は同じ404（存在を明かさない） */
async function loadIncident(c: ApiContext, id: string, unitId: string): Promise<IncidentWithOperation> {
  const row = await c.env.DB.prepare(
    "SELECT i.*, o.version AS operation_version FROM incidents i " +
      "JOIN operations o ON o.unit_id = i.unit_id AND o.id = i.operation_id WHERE i.id = ?",
  ).bind(id).first<IncidentWithOperation>();
  if (!row || row.unit_id !== unitId) throw new HttpError("NOT_FOUND");
  return row;
}

const toIncident = (r: IncidentRow) =>
  Incident.parse({
    id: r.id, version: r.version, operationId: r.operation_id, activityId: r.activity_id, kind: r.kind,
    occurredAt: r.occurred_at, summary: r.summary, status: r.status, createdBy: r.created_by,
    createdAt: r.created_at, updatedAt: r.updated_at,
  });

/** 一覧・詳細の安定順（occurred_at, id）の続き取得キー（issuesと同じopaque cursor。unit条件は常に付く） */
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

export function registerIncidentRoutes(app: ApiApp): void {
  // --- API-22: 出動の登録（recording。operation/incident/履歴初行を同一batchで生成。
  // 出動命令は発行しない（docs/11「正式指令を発行しない」） ---
  defineRoute(app, "API-22", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-22");
    requirePermission(p, "PER-04", { unitId: p.unitId, type: "incident" });
    // activityIdは同unitの既存活動だけ（docs/04 activity_id UNIQUE/FK。1活動にリンクできる出動は1件）。
    // 既存活動とのoperation統合（付替え）はAPI-71＝T043で共通処理へ接続する
    let activityId: string | null = null;
    if (body.activityId) {
      const activity = await c.env.DB.prepare("SELECT unit_id FROM activities WHERE id = ?").bind(body.activityId)
        .first<{ unit_id: string }>();
      if (!activity || activity.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
      const linked = await c.env.DB.prepare("SELECT id FROM incidents WHERE unit_id = ? AND activity_id = ?")
        .bind(p.unitId, body.activityId).first<{ id: string }>();
      if (linked) throw new HttpError("DUPLICATE", undefined, [{ field: "activityId", reason: "activity_already_linked" }]);
      activityId = body.activityId;
    }

    const operationId = crypto.randomUUID();
    const id = crypto.randomUUID();
    // 使用履歴の作成（T042。docs/05 API-22行「resourceUsagesの保存はT042で共通関数経由」）。
    // buildResourceUsageMutationが検査（対象ちょうど一つ/quantity>0/時間/同unit・存在）と
    // INSERT文＋履歴文＋資産の存在条件を組み立て、下のexecuteMutationと同じbatchに取り込む
    // （出来事root/出動/使用履歴/監査/outboxを1つのbatchで確定。docs/02 §4。一mutation一event）。
    // 作成経路ではoperationを行と同じbatchで作るため、operation版のガードも増分もしない
    const usages = body.resourceUsages?.length
      ? await buildResourceUsageMutation(c, {
          principal: p, operationId, operationVersion: 0, operationCreatedInBatch: true,
          usages: body.resourceUsages, reason: null,
          idempotencyKey: headers["idempotency-key"], requestPath: "/incidents",
          requestBody: { resourceUsages: body.resourceUsages },
        })
      : null;

    const result = await executeMutation(c.env, p, {
      operationCode: "incident.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/incidents", body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [],
      created: [
        { table: "operations", id: operationId }, { table: "incidents", id },
        ...(usages?.created ?? []),
      ],
      // 使用履歴の対象資産の存在はbatch内でも再検査する（読み取り後の廃止は404。docs/05 §1）
      conditions: usages?.conditions ?? [],
      statements: (ctx) => [
        // 出来事root（docs/04「共通出来事」）。種別は出動。状態は子rootに合わせ、集計対象として作る
        c.env.DB.prepare(
          "INSERT INTO operations (id, unit_id, kind, status, countable, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, 'incident', 'recording', 1, ?, ?, ?, ?, 'human')",
        ).bind(operationId, p.unitId, ctx.attempt, ctx.now, ctx.now, p.userId),
        c.env.DB.prepare(
          "INSERT INTO incidents (id, unit_id, operation_id, activity_id, kind, occurred_at, summary, status, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'recording', ?, ?, ?, ?, 'human')",
        ).bind(id, p.unitId, operationId, activityId, body.kind, body.occurredAt, body.summary, ctx.attempt, ctx.now, ctx.now, p.userId),
        // 履歴の初行（docs/04:95。作成を前後JSONで記録する。issue_eventsと同じ流儀）
        c.env.DB.prepare(
          "INSERT INTO incident_events (id, unit_id, incident_id, action, before_json, after_json, reason, actor_user_id, actor_kind, created_at) " +
            "VALUES (?, ?, ?, 'create', '{}', ?, NULL, ?, 'human', ?)",
        ).bind(crypto.randomUUID(), p.unitId, id, JSON.stringify({ status: "recording", kind: body.kind }), p.userId, ctx.now),
        // 使用履歴（docs/04:100。operations/incidentsのINSERTより後なので、同一batch内のFKも成立する）
        ...(usages ? usages.statements(ctx) : []),
      ],
      audit: {
        action: "incident.create", entityType: "incident", entityId: id,
        metadata: { kind: body.kind, operationId, activityId: activityId ?? "none" },
      },
      event: { entityType: "incident", entityId: id, entityVersion: 1, eventType: "incident.created", payload: { kind: body.kind } },
      response: { status: 201, sql: INCIDENT_JSON, binds: [id], decode: (j) => Incident.parse(j) },
    });
    return ok(c, result.data, {}, 201);
  });

  // --- API-21: 一覧（同unitのみ。kind/from/to/statusで絞る。occurred_at昇順の安定keyset。
  // voidedも閲覧可能（docs/11「voidedは閲覧のみ」） ---
  defineRoute(app, "API-21", async (c) => {
    const p = await resolvePrincipal(c);
    const { query } = await parseApiRequest(c, "API-21");
    requirePermission(p, "PER-01", { unitId: p.unitId, type: "incident" });
    const where = ["unit_id = ?"];
    const binds: unknown[] = [p.unitId];
    if (query.kind) { where.push("kind = ?"); binds.push(query.kind); }
    if (query.status) { where.push("status = ?"); binds.push(query.status); }
    // 期間は半開区間。fromは包含、toは排他（docs/05 §1。occurred_atで判定）
    if (query.from) { where.push("occurred_at >= ?"); binds.push(query.from); }
    if (query.to) { where.push("occurred_at < ?"); binds.push(query.to); }
    if (query.cursor) {
      const [at, id] = decodeCursor(query.cursor);
      where.push("(occurred_at > ? OR (occurred_at = ? AND id > ?))");
      binds.push(at, at, id);
    }
    // limit+1件だけ読み、続きの有無をnextCursorの有無で返す（件数を黙って切り捨てない。docs/05 §1）
    const rows = (
      await c.env.DB.prepare(
        `SELECT id, version, operation_id, activity_id, kind, occurred_at, summary, status, created_by, created_at, updated_at ` +
          `FROM incidents WHERE ${where.join(" AND ")} ORDER BY occurred_at, id LIMIT ?`,
      ).bind(...binds, query.limit + 1).all<IncidentRow>()
    ).results;
    const page = rows.slice(0, query.limit);
    const nextCursor = rows.length > query.limit
      ? encodeCursor(page[page.length - 1]!.occurred_at, page[page.length - 1]!.id)
      : undefined;
    return ok(c, page.map(toIncident), { nextCursor });
  });

  // --- API-69: 状態遷移・種別訂正・概要訂正（docs/11の許可辺。理由は契約で必須。旧版は409） ---
  defineRoute(app, "API-69", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-69");
    const current = await loadIncident(c, params.id, p.unitId);
    requirePermission(p, "PER-04", { unitId: p.unitId, type: "incident", id: params.id });
    // voidedは終端（docs/11「voidedは閲覧のみ」）。種別・概要・状態のいずれの変更も不可
    if (current.status === "voided") {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "status", reason: "voided_is_terminal" }]);
    }

    const statusChange = body.status !== undefined && body.status !== current.status;
    if (statusChange && !canTransition(incidentTransitions, current.status as keyof typeof incidentTransitions, body.status!)) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "status", reason: "transition_not_allowed" }]);
    }
    const kindChange = body.kind !== undefined && body.kind !== current.kind;
    const summaryChange = body.summary !== undefined && body.summary !== current.summary;
    if (!statusChange && !kindChange && !summaryChange) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "(body)", reason: "no_changes" }]);
    }
    // 理由はdocs/11「訂正/無効化理由」。契約（Reason2000）で必須・上限済み

    const nextStatus = statusChange ? body.status! : current.status;
    const nextKind = kindChange ? body.kind! : current.kind;
    const changed = [
      ...(statusChange ? ["status"] : []),
      ...(kindChange ? ["kind"] : []),
      ...(summaryChange ? ["summary"] : []),
    ].join(".");

    const result = await executeMutation(c.env, p, {
      operationCode: "incident.update",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "PATCH", path: `/incidents/${params.id}`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [
        { table: "incidents", id: params.id, expectedVersion: body.version, allowedStates: { column: "status", values: [current.status] } },
        // 状態を写す先の出来事rootも版で競合を検出する（読んだ状態が今も有効か。activitiesと同じ）
        ...(statusChange ? [{ table: "operations", id: current.operation_id, expectedVersion: current.operation_version }] : []),
      ],
      statements: (ctx) => [
        c.env.DB.prepare(
          `UPDATE incidents SET ${[
            ...(statusChange ? ["status = ?" ] : []),
            ...(kindChange ? ["kind = ?"] : []),
            ...(summaryChange ? ["summary = ?"] : []),
            "version = version + 1", "last_mutation_token = ?", "updated_at = ?",
          ].join(", ")} WHERE id = ? AND unit_id = ? AND version = ?`,
        ).bind(
          ...(statusChange ? [nextStatus] : []),
          ...(kindChange ? [nextKind] : []),
          ...(summaryChange ? [body.summary!] : []),
          ctx.attempt, ctx.now, params.id, p.unitId, body.version,
        ),
        // 出来事rootへ状態を写す。voidedは集計対象から外す（docs/04「無効時countable=0」。activitiesの中止と同じ）
        ...(statusChange
          ? [c.env.DB.prepare(
              "UPDATE operations SET status = ?, countable = CASE WHEN ? = 'voided' THEN 0 ELSE 1 END, version = version + 1, last_mutation_token = ?, updated_at = ? " +
                "WHERE id = ? AND unit_id = ? AND version = ?",
            ).bind(nextStatus, nextStatus, ctx.attempt, ctx.now, current.operation_id, p.unitId, current.operation_version)]
          : []),
        // 履歴（docs/04:95。変更の前後を状態・種別の形で残す。概要の本文は複製しない）
        c.env.DB.prepare(
          "INSERT INTO incident_events (id, unit_id, incident_id, action, before_json, after_json, reason, actor_user_id, actor_kind, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'human', ?)",
        ).bind(
          crypto.randomUUID(), p.unitId, params.id, changed,
          JSON.stringify({ status: current.status, kind: current.kind }),
          JSON.stringify({ status: nextStatus, kind: nextKind }),
          body.reason, p.userId, ctx.now,
        ),
      ],
      audit: { action: "incident.update", entityType: "incident", entityId: params.id, metadata: { changed, to: nextStatus } },
      event: { entityType: "incident", entityId: params.id, entityVersion: body.version + 1, eventType: "incident.updated", payload: { changed } },
      response: { status: 200, sql: INCIDENT_JSON, binds: [params.id], decode: (j) => Incident.parse(j) },
    });
    return ok(c, result.data);
  });

  // --- API-70: 詳細（docs/05 API-70「参集/活動/使用履歴/イベント」。voidedも閲覧可能） ---
  defineRoute(app, "API-70", async (c) => {
    const p = await resolvePrincipal(c);
    const { params } = await parseApiRequest(c, "API-70");
    requirePermission(p, "PER-01", { unitId: p.unitId, type: "incident", id: params.id });
    const current = await loadIncident(c, params.id, p.unitId);

    // 関連付けた活動（docs/05 API-70「活動」。未リンクはnull）
    const activity = current.activity_id
      ? await c.env.DB.prepare("SELECT * FROM activities WHERE id = ?").bind(current.activity_id)
          .first<Record<string, string | number>>()
          .then((r) =>
            r && r.unit_id === p.unitId
              ? Activity.parse({
                  id: r.id, version: r.version, operationId: r.operation_id, title: r.title, kind: r.kind,
                  plannedStartsAt: r.planned_starts_at, plannedEndsAt: r.planned_ends_at, locationText: r.location_text,
                  ownerMemberId: r.owner_member_id, status: r.status, responseDueAt: r.response_due_at,
                  createdAt: r.created_at, updatedAt: r.updated_at,
                })
              : null,
          )
      : null;

    // 参集（incident_participants）。書込はAPI-23（incident-participants.ts、T041で接続）
    const participants = (
      await c.env.DB.prepare(
        "SELECT id, version, member_id, attendance_status, mobilized_at, arrived_at, returned_at " +
          "FROM incident_participants WHERE incident_id = ? ORDER BY member_id",
      ).bind(params.id)
        .all<{ id: string; version: number; member_id: string; attendance_status: string; mobilized_at: string | null; arrived_at: string | null; returned_at: string | null }>()
    ).results.map((r) =>
      IncidentParticipant.parse({
        id: r.id, version: r.version, memberId: r.member_id, attendanceStatus: r.attendance_status,
        mobilizedAt: r.mobilized_at, arrivedAt: r.arrived_at, returnedAt: r.returned_at,
      }),
    );

    // 使用履歴（resource_usages。T042で接続。docs/04:100。cancelledも行として残る。operationIdで元出来事へ辿れる）
    const resourceUsages = (
      await c.env.DB.prepare(
        "SELECT id, unit_id, operation_id, vehicle_id, equipment_id, quantity, used_from, used_to, recorded_by_member_id, status, version " +
          "FROM resource_usages WHERE unit_id = ? AND operation_id = ? ORDER BY rowid",
      ).bind(p.unitId, current.operation_id).all<ResourceUsageRowShape>()
    ).results.map(toResourceUsageDto);

    // 履歴（incident_events。追記順＝rowid。失敗した変更は残らない）
    const events = (
      await c.env.DB.prepare(
        "SELECT id, action, before_json, after_json, reason, created_at FROM incident_events WHERE incident_id = ? ORDER BY rowid",
      ).bind(params.id)
        .all<{ id: string; action: string; before_json: string; after_json: string; reason: string | null; created_at: string }>()
    ).results.map((r) =>
      IncidentEvent.parse({
        id: r.id, action: r.action, before: JSON.parse(r.before_json), after: JSON.parse(r.after_json),
        reason: r.reason, createdAt: r.created_at,
      }),
    );

    const detail = IncidentDetail.parse({
      ...toIncident(current),
      activity,
      participants,
      resourceUsages,
      events,
    });
    return ok(c, detail);
  });
}
