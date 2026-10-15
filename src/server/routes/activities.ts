import { Activity, ActivityDetail } from "../../shared/contracts/operations";
import { activityTransitions, canTransition } from "../../shared/states";
import { authorize } from "../auth/authorize";
import { resolvePrincipal } from "../auth/principal";
import { loadActivityResult } from "./activity-results";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp, type ApiContext } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { requirePermission } from "./invitations";
import { toResourceUsageDto, type ResourceUsageRowShape } from "./resource-usages";

/**
 * 活動（予定）の作成・公開・変更・中止（T035、docs/05 API-06/07/39/40、docs/11 開催、docs/04 §3.2）。
 * 出来事root（operations）と予定root（activities）と対象snapshot（activity_audience）を同じbatchで確定する。
 * 遷移は docs/11 の許可辺のみ（draft→scheduled/cancelled、scheduled→in_progress/cancelled、
 * in_progress→completed、completed→in_progress。cancelledは終端）。中止で既存出欠を削除しない。
 * 出欠の回答はattendance.ts（API-08/41、T036）、実績はactivity-results.ts（API-09/42/43、T037）。
 */

const ACTIVITY_JSON =
  "SELECT json_object('id', id, 'version', version, 'operationId', operation_id, 'title', title, 'kind', kind, " +
  "'plannedStartsAt', planned_starts_at, 'plannedEndsAt', planned_ends_at, 'locationText', location_text, " +
  "'ownerMemberId', owner_member_id, 'status', status, 'responseDueAt', response_due_at, 'createdAt', created_at, 'updatedAt', updated_at) " +
  "FROM activities WHERE id = ?";

interface ActivityRow {
  id: string; unit_id: string; operation_id: string; version: number;
  title: string; kind: string; planned_starts_at: string; planned_ends_at: string | null;
  location_text: string; owner_member_id: string; status: string; response_due_at: string | null;
  created_at: string; updated_at: string;
}
type ActivityWithOperation = ActivityRow & { operation_version: number };

/** 時刻順序（docs/04「日時順序」。DBのCHECKと同じ規則を入力で先に見て400にする。通ってからCHECKの500にしない） */
const endsBeforeStart = (startsAt: string, endsAt: string | null) => endsAt !== null && endsAt < startsAt;

/** 予定と出来事root（状態を写す先）を読む。別unit/存在しない対象は同じ404（存在を明かさない） */
async function loadActivity(c: ApiContext, id: string, unitId: string): Promise<ActivityWithOperation> {
  const row = await c.env.DB.prepare(
    "SELECT a.*, o.version AS operation_version FROM activities a " +
      "JOIN operations o ON o.unit_id = a.unit_id AND o.id = a.operation_id WHERE a.id = ?",
  ).bind(id).first<ActivityWithOperation>();
  if (!row || row.unit_id !== unitId) throw new HttpError("NOT_FOUND");
  return row;
}

/** 予定の担当（owner）は有効な同unit団員（docs/04「担当同unit」、docs/10と同じ対象条件） */
async function requireActiveMember(c: ApiContext, unitId: string, memberId: string): Promise<void> {
  const m = await c.env.DB.prepare("SELECT unit_id, status FROM members WHERE id = ?").bind(memberId)
    .first<{ unit_id: string; status: string }>();
  if (!m || m.unit_id !== unitId) throw new HttpError("NOT_FOUND");
  if (m.status !== "active") {
    throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "ownerMemberId", reason: "member_not_active" }]);
  }
}

/** 対象者は同unitの団員だけ（存在しない/別unitは同じ404。重複は集合として畳む。UNIQUE違反を500にしないため） */
async function requireAudienceMembers(c: ApiContext, unitId: string, memberIds: readonly string[]): Promise<void> {
  if (memberIds.length === 0) return;
  const rows = (
    await c.env.DB.prepare(
      `SELECT id, unit_id FROM members WHERE id IN (${memberIds.map(() => "?").join(",")})`,
    ).bind(...memberIds).all<{ id: string; unit_id: string }>()
  ).results;
  if (rows.length !== new Set(memberIds).size || rows.some((r) => r.unit_id !== unitId)) {
    throw new HttpError("NOT_FOUND");
  }
}

const audienceInsert = (unitId: string, activityId: string, memberId: string, userId: string, now: string) =>
  ({
    sql: "INSERT INTO activity_audience (id, unit_id, activity_id, member_id, actor_user_id, actor_kind, created_at) VALUES (?, ?, ?, ?, ?, 'human', ?)",
    binds: [crypto.randomUUID(), unitId, activityId, memberId, userId, now],
  });

export function registerActivityRoutes(app: ApiApp): void {
  // --- API-06: 予定の作成（draft。operation/activity/対象snapshotを同一batchで生成） ---
  defineRoute(app, "API-06", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-06");
    requirePermission(p, "PER-03", { unitId: p.unitId, type: "activity" });
    if (endsBeforeStart(body.plannedStartsAt, body.plannedEndsAt ?? null)) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "plannedEndsAt", reason: "end_before_start" }]);
    }
    await requireActiveMember(c, p.unitId, body.ownerMemberId);
    const audience = [...new Set(body.audienceMemberIds)];
    await requireAudienceMembers(c, p.unitId, audience);

    const operationId = crypto.randomUUID();
    const id = crypto.randomUUID();
    const result = await executeMutation(c.env, p, {
      operationCode: "activity.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/activities", body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [],
      created: [{ table: "operations", id: operationId }, { table: "activities", id }],
      statements: (ctx) => [
        // 出来事root（docs/04「共通出来事」）。種別は活動。状態は子rootに合わせ、集計対象として作る
        c.env.DB.prepare(
          "INSERT INTO operations (id, unit_id, kind, status, countable, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, 'activity', 'draft', 1, ?, ?, ?, ?, 'human')",
        ).bind(operationId, p.unitId, ctx.attempt, ctx.now, ctx.now, p.userId),
        c.env.DB.prepare(
          "INSERT INTO activities (id, unit_id, operation_id, title, kind, planned_starts_at, planned_ends_at, location_text, owner_member_id, status, response_due_at, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, 'human')",
        ).bind(
          id, p.unitId, operationId, body.title, body.kind, body.plannedStartsAt, body.plannedEndsAt ?? null,
          body.locationText, body.ownerMemberId, body.responseDueAt ?? null, ctx.attempt, ctx.now, ctx.now, p.userId,
        ),
        // 履歴の初行（docs/04 activity_events。previous=next=初期状態を「作成」の記録とする）
        c.env.DB.prepare(
          "INSERT INTO activity_events (id, unit_id, activity_id, previous_status, next_status, reason, actor_user_id, actor_kind, created_at) " +
            "VALUES (?, ?, ?, 'draft', 'draft', NULL, ?, 'human', ?)",
        ).bind(crypto.randomUUID(), p.unitId, id, p.userId, ctx.now),
        // 対象者はsnapshotで固定（docs/04「未回答母数は現在の名簿全件ではなく対象snapshot」）
        ...audience.map((memberId) => {
          const a = audienceInsert(p.unitId, id, memberId, p.userId, ctx.now);
          return c.env.DB.prepare(a.sql).bind(...a.binds);
        }),
      ],
      audit: { action: "activity.create", entityType: "activity", entityId: id, metadata: { audienceCount: audience.length, operationId } },
      event: { entityType: "activity", entityId: id, entityVersion: 1, eventType: "activity.created" },
      response: { status: 201, sql: ACTIVITY_JSON, binds: [id], decode: (j) => Activity.parse(j) },
    });
    return ok(c, result.data, {}, 201);
  });

  // --- API-39: 公開・変更・遷移（docs/11の許可辺。公開済の変更は理由必須。旧版は409） ---
  defineRoute(app, "API-39", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-39");
    const current = await loadActivity(c, params.id, p.unitId);
    requirePermission(p, "PER-03", { unitId: p.unitId, type: "activity", id: params.id, ownerMemberId: current.owner_member_id });

    const statusChange = body.status !== undefined && body.status !== current.status;
    if (statusChange && !canTransition(activityTransitions, current.status as keyof typeof activityTransitions, body.status!)) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "status", reason: "transition_not_allowed" }]);
    }
    // 日時は「現在値＋入力」で検査する（片方だけのPATCHで逆順を作れないように）
    const startsAt = body.plannedStartsAt ?? current.planned_starts_at;
    const endsAt = body.plannedEndsAt !== undefined ? body.plannedEndsAt : current.planned_ends_at;
    if (endsBeforeStart(startsAt, endsAt)) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "plannedEndsAt", reason: "end_before_start" }]);
    }

    const audienceChange = body.audienceMemberIds !== undefined;
    const audience = audienceChange ? [...new Set(body.audienceMemberIds!)] : [];
    if (audienceChange) await requireAudienceMembers(c, p.unitId, audience);
    const ownerChange = body.ownerMemberId !== undefined && body.ownerMemberId !== current.owner_member_id;
    if (ownerChange) await requireActiveMember(c, p.unitId, body.ownerMemberId!);

    const contentChange =
      body.title !== undefined || body.kind !== undefined || body.plannedStartsAt !== undefined ||
      body.plannedEndsAt !== undefined || body.locationText !== undefined || body.responseDueAt !== undefined || ownerChange;
    if (!statusChange && !contentChange && !audienceChange) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "(body)", reason: "no_changes" }]);
    }
    // 公開済（draft以降）の変更と中止は理由が要る（docs/11「理由」、docs/05 API-39「公開済の変更理由」）
    const reasonRequired = (current.status !== "draft" && (contentChange || statusChange || audienceChange)) || body.status === "cancelled";
    if (reasonRequired && !body.reason?.trim()) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "reason", reason: "reason_required" }]);
    }

    const sets: string[] = [];
    const binds: unknown[] = [];
    const col = (n: string, v: unknown) => { sets.push(`${n} = ?`); binds.push(v); };
    if (statusChange) col("status", body.status!);
    if (body.title !== undefined) col("title", body.title);
    if (body.kind !== undefined) col("kind", body.kind);
    if (body.plannedStartsAt !== undefined) col("planned_starts_at", body.plannedStartsAt);
    if (body.plannedEndsAt !== undefined) col("planned_ends_at", body.plannedEndsAt);
    if (body.locationText !== undefined) col("location_text", body.locationText);
    if (body.responseDueAt !== undefined) col("response_due_at", body.responseDueAt);
    if (body.ownerMemberId !== undefined) col("owner_member_id", body.ownerMemberId);

    const nextStatus = statusChange ? body.status! : current.status;
    const changed =
      [
        ...(statusChange ? ["status"] : []),
        ...(contentChange ? ["content"] : []),
        ...(audienceChange ? ["audience"] : []),
      ].join(".") || "none";
    const result = await executeMutation(c.env, p, {
      operationCode: "activity.update",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "PATCH", path: `/activities/${params.id}`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [
        { table: "activities", id: params.id, expectedVersion: body.version, allowedStates: { column: "status", values: [current.status] } },
        // 状態を写す先の出来事rootも版で競合を検出する（読んだ状態が今も有効か）
        ...(statusChange ? [{ table: "operations", id: current.operation_id, expectedVersion: current.operation_version }] : []),
      ],
      statements: (ctx) => [
        c.env.DB.prepare(
          `UPDATE activities SET ${[...sets, "version = version + 1", "last_mutation_token = ?", "updated_at = ?"].join(", ")} WHERE id = ? AND unit_id = ? AND version = ?`,
        ).bind(...binds, ctx.attempt, ctx.now, params.id, p.unitId, body.version),
        // 出来事rootへ状態を写す。中止は集計対象から外す（docs/11 §3「取消…集計は無効なoperationを除く」）
        ...(statusChange
          ? [c.env.DB.prepare(
              "UPDATE operations SET status = ?, countable = CASE WHEN ? = 'cancelled' THEN 0 ELSE 1 END, version = version + 1, last_mutation_token = ?, updated_at = ? " +
                "WHERE id = ? AND unit_id = ? AND version = ?",
            ).bind(nextStatus, nextStatus, ctx.attempt, ctx.now, current.operation_id, p.unitId, current.operation_version)]
          : []),
        // 履歴（docs/04 activity_events。公開後の内容変更は同じ状態どうしの行に理由を残す。draftの内容変更は監査だけ）
        ...(statusChange || (current.status !== "draft" && (contentChange || audienceChange))
          ? [c.env.DB.prepare(
              "INSERT INTO activity_events (id, unit_id, activity_id, previous_status, next_status, reason, actor_user_id, actor_kind, created_at) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, 'human', ?)",
            ).bind(crypto.randomUUID(), p.unitId, params.id, current.status, nextStatus, body.reason ?? null, p.userId, ctx.now)]
          : []),
        // 対象snapshotの張替え（出欠行は消さない。docs/11 §3）
        ...(audienceChange
          ? [
              c.env.DB.prepare("DELETE FROM activity_audience WHERE unit_id = ? AND activity_id = ?").bind(p.unitId, params.id),
              ...audience.map((memberId) => {
                const a = audienceInsert(p.unitId, params.id, memberId, p.userId, ctx.now);
                return c.env.DB.prepare(a.sql).bind(...a.binds);
              }),
            ]
          : []),
      ],
      audit: {
        action: "activity.update", entityType: "activity", entityId: params.id,
        metadata: { changed, to: nextStatus },
      },
      event: { entityType: "activity", entityId: params.id, entityVersion: body.version + 1, eventType: "activity.updated", payload: { changed } },
      response: { status: 200, sql: ACTIVITY_JSON, binds: [params.id], decode: (j) => Activity.parse(j) },
    });
    return ok(c, result.data);
  });

  // --- API-40: 中止（draft/scheduledからのみ。出欠・対象・履歴は保持。operationをcountable=0） ---
  defineRoute(app, "API-40", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-40");
    const current = await loadActivity(c, params.id, p.unitId);
    requirePermission(p, "PER-03", { unitId: p.unitId, type: "activity", id: params.id, ownerMemberId: current.owner_member_id });
    if (!canTransition(activityTransitions, current.status as keyof typeof activityTransitions, "cancelled")) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "status", reason: "transition_not_allowed" }]);
    }

    const result = await executeMutation(c.env, p, {
      operationCode: "activity.cancel",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/activities/${params.id}/cancellation`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [
        { table: "activities", id: params.id, expectedVersion: body.version, allowedStates: { column: "status", values: [current.status] } },
        { table: "operations", id: current.operation_id, expectedVersion: current.operation_version },
      ],
      statements: (ctx) => [
        c.env.DB.prepare(
          "UPDATE activities SET status = 'cancelled', version = version + 1, last_mutation_token = ?, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ?",
        ).bind(ctx.attempt, ctx.now, params.id, p.unitId, body.version),
        // 中止で出欠・対象・履歴は消さない（docs/11 §3）。出来事rootを集計対象から外すだけ
        c.env.DB.prepare(
          "UPDATE operations SET status = 'cancelled', countable = 0, version = version + 1, last_mutation_token = ?, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ?",
        ).bind(ctx.attempt, ctx.now, current.operation_id, p.unitId, current.operation_version),
        c.env.DB.prepare(
          "INSERT INTO activity_events (id, unit_id, activity_id, previous_status, next_status, reason, actor_user_id, actor_kind, created_at) " +
            "VALUES (?, ?, ?, ?, 'cancelled', ?, ?, 'human', ?)",
        ).bind(crypto.randomUUID(), p.unitId, params.id, current.status, body.reason, p.userId, ctx.now),
      ],
      audit: { action: "activity.cancel", entityType: "activity", entityId: params.id, metadata: { from: current.status } },
      event: { entityType: "activity", entityId: params.id, entityVersion: body.version + 1, eventType: "activity.cancelled", payload: { from: current.status } },
      response: { status: 200, sql: ACTIVITY_JSON, binds: [params.id], decode: (j) => Activity.parse(j) },
    });
    return ok(c, result.data);
  });

  // --- API-07: 詳細（可視出欠と現在実績を含む。docs/05 API-07） ---
  defineRoute(app, "API-07", async (c) => {
    const p = await resolvePrincipal(c);
    const { params } = await parseApiRequest(c, "API-07");
    requirePermission(p, "PER-01", { unitId: p.unitId, type: "activity", id: params.id });
    const current = await c.env.DB.prepare("SELECT * FROM activities WHERE id = ?").bind(params.id)
      .first<ActivityRow>().then((r) => (r && r.unit_id === p.unitId ? r : null));
    if (!current) throw new HttpError("NOT_FOUND");

    // 対象者はsnapshot（出欠の回答有無とは独立。docs/04 activity_audience）
    const audience = (
      await c.env.DB.prepare("SELECT member_id FROM activity_audience WHERE activity_id = ? ORDER BY member_id")
        .bind(params.id).all<{ member_id: string }>()
    ).results.map((r) => r.member_id);

    // 出欠の可視行（docs/05 §1「Detailは親＋認可された子Page」）。出欠の管理権（PER-03）があれば全行、なければ自分の行だけ
    const rows = (
      await c.env.DB.prepare(
        "SELECT id, version, member_id, response, responded_at FROM activity_attendance WHERE activity_id = ? ORDER BY member_id",
      ).bind(params.id)
        .all<{ id: string; version: number; member_id: string; response: string; responded_at: string | null }>()
    ).results;
    const canManage = authorize(p, "PER-03", { unitId: p.unitId, type: "activity", id: params.id, ownerMemberId: current.owner_member_id }).allowed;
    const attendance = rows
      .filter((r) => canManage || r.member_id === p.memberId)
      .map((r) => ({ id: r.id, version: r.version, memberId: r.member_id, response: r.response, respondedAt: r.responded_at }));

    // 現在実績（activity_results。未作成はnull。docs/05 API-07「可視出欠と現在実績を含む」）
    const result = await loadActivityResult(c.env, p.unitId, params.id);

    // 出来事rootの現行版（使用履歴API-57/リンクAPI-71の版ガードに画面が使う。T044で追加）。
    // operations行は活動と同時に作るため無いのは整合性の故障（黙って別の値を返さない）
    const operation = await c.env.DB.prepare("SELECT version FROM operations WHERE id = ? AND unit_id = ?")
      .bind(current.operation_id, p.unitId).first<{ version: number }>();
    if (!operation) throw new HttpError("NOT_FOUND");

    // 車両/機材の使用履歴（docs/04:100。T044で追加。API-57はPUTのみのため詳細に載せる。cancelledも残る）
    const usages = (
      await c.env.DB.prepare(
        "SELECT id, unit_id, operation_id, vehicle_id, equipment_id, quantity, used_from, used_to, recorded_by_member_id, status, version " +
          "FROM resource_usages WHERE unit_id = ? AND operation_id = ? ORDER BY rowid",
      ).bind(p.unitId, current.operation_id).all<ResourceUsageRowShape>()
    ).results.map(toResourceUsageDto);

    const detail = ActivityDetail.parse({
      ...Activity.parse({
        id: current.id, version: current.version, operationId: current.operation_id, title: current.title, kind: current.kind,
        plannedStartsAt: current.planned_starts_at, plannedEndsAt: current.planned_ends_at, locationText: current.location_text,
        ownerMemberId: current.owner_member_id, status: current.status, responseDueAt: current.response_due_at,
        createdAt: current.created_at, updatedAt: current.updated_at,
      }),
      audience,
      attendance,
      result,
      operationVersion: operation.version,
      resourceUsages: usages,
    });
    return ok(c, detail);
  });
}
