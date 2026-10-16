import { PatrolPlan } from "../../shared/contracts/ai";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { requirePermission } from "./invitations";

/**
 * 地域の点検巡回計画（T071、docs/05 API-78/79、docs/04:157、docs/03 SCR-25、docs/10 PER-14、docs/14 D01）。
 *
 * - **API-78（案の作成・201）**: 対象施設（同unit・停止〔archived_at〕以外。docs/16 T071の裁定）・業務日・目的から
 *   draftの案を作り、**stopsへ候補順（最近傍法。proposeStopOrder）を保存する**。外部の経路最適化
 *   （Google Routes API等）は使わない（docs/14 D01のIDなし参考候補は自動採用しない）。
 * - **API-79（決定・200）**: decision=confirmは人の確定（docs/04:157「計画確定は人」）。orderedFacilityIdsは
 *   **対象施設と完全一致の集合かつ重複なしが必須**（対象外・欠け・重複は400。二重順序＝position重複は
 *   DBの一意索引でも拒否）。確定でstopsを作り直し（同じbatch内のDELETE+INSERT。SQLiteの一意制約は即時で
 *   位置の入替えを直接UPDATEできないため。docs/16 T071）、planをconfirmedへ遷める。cancelはdraft→cancelled
 *   （stopsは触らない）。confirmed/cancelledは**終端**（再操作は現行版でも422。変更は新しい案として作り直す）。
 * - **自動派生0**: 確定でも出動・タスク・通知・点検を1件も作らない（計画確定を実災害の指令/設備安全判断にしない。
 *   画面には常時注記を出す。docs/03 SCR-25・docs/16 T071）。
 * - **権限（docs/10 PER-14「参照施設の権限＋人の確定」）**: 作成・決定とも対象施設1件ごとにPER-14を検査する
 *   （幹部・管理者は所属内、担当者は担当scopeのある対象。docs/16 T071に記録）。
 * - **冪等**: 両APIともIdempotency-Key必須（docs/05 §2）。同じ鍵の再送はexecuteMutation内で先に解決するため、
 *   状態前提の読み取り（対象施設・plan・stops）を飛ばして元の応答を返す（T041/T048流儀）。
 */

/** 応答の組み立て（docs/04:157どおり。stopsはposition順。facilityNameは管理番号か識別名） */
const PATROL_PLAN_JSON =
  "SELECT json_object('id', p.id, 'version', p.version, 'date', p.plan_date, 'objective', p.objective, " +
  "'status', p.status, 'decidedAt', p.decided_at, 'createdAt', p.created_at, 'updatedAt', p.updated_at, " +
  "'stops', (SELECT json_group_array(json_object('facilityId', t.facility_id, 'position', t.position, " +
  "'facilityName', COALESCE(f.management_number, f.identifying_name), 'latitude', f.latitude, 'longitude', f.longitude)) " +
  "FROM (SELECT s.facility_id, s.position FROM patrol_plan_stops s WHERE s.unit_id = p.unit_id AND s.plan_id = p.id ORDER BY s.position) t " +
  "JOIN facilities f ON f.id = t.facility_id)) " +
  "FROM patrol_plans p WHERE p.id = ?";

/** 2点間の距離（m。haversine）。順序の提案だけに使う計算値で、表示の距離ではない */
function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(s));
}

/**
 * 候補順の提案（最近傍法。T071の裁定）: 開始点を**最も南**（緯度が最小。同点は経度→idの辞書順）に固定し、
 * 未訪問の最近傍を順に選ぶ（同距離はid順）。入力順・作成順に依存しない決定的な並びで、
 * 外部サービスに依存しない（docs/14 D01）。座標は全施設が持つ（facilities.latitude/longitudeはNOT NULL）ため
 * 全候補が提案の対象になる。
 */
export function proposeStopOrder(facilities: readonly { id: string; latitude: number; longitude: number }[]): string[] {
  const remaining = [...facilities].sort((x, y) => x.latitude - y.latitude || x.longitude - y.longitude || (x.id < y.id ? -1 : 1));
  let current = remaining.shift();
  if (!current) return [];
  const order = [current.id];
  while (remaining.length > 0) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const next = remaining[i]!;
      const d = distanceMeters(current.latitude, current.longitude, next.latitude, next.longitude);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    current = remaining.splice(best, 1)[0]!;
    order.push(current.id);
  }
  return order;
}

export function registerPatrolPlanRoutes(app: ApiApp): void {
  // --- API-78 案の作成（201。statusはdraft。順序は最近傍順の提案） ---
  defineRoute(app, "API-78", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-78");

    // 同じ鍵の再送（docs/05 §2）はexecuteMutation内で先に解決される。鍵があるときは
    // 状態前提の読み取り（対象施設の所在）を飛ばす（T041/T048流儀）
    const knownKey = await c.env.DB.prepare(
      "SELECT 1 FROM idempotency_records WHERE actor_user_id = ? AND operation_code = ? AND idempotency_key = ?",
    ).bind(p.userId, "patrol_plan.create", headers["idempotency-key"]).first();

    let candidates: { id: string; latitude: number; longitude: number }[] = [];
    if (!knownKey) {
      // 重複する候補は400（対象施設の集合は重複なし。docs/16 T071）
      const ids = new Set(body.facilityIds);
      if (ids.size !== body.facilityIds.length) {
        throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "facilityIds", reason: "duplicate_facility" }]);
      }
      // 対象は同unitの現役施設のみ（停止〔archived_at〕は候補から外す。docs/16 T071の裁定）。
      // 別unit・不在・停止は区別せず404（存在を明かさない。docs/05 §1）。
      // IN句のbindはunit_idと合わせて100を越えないよう分割する（docs/05 §1「D1 bound parameter上限100を越えない」）
      const found: { id: string; latitude: number; longitude: number }[] = [];
      for (let i = 0; i < body.facilityIds.length; i += 99) {
        const chunk = body.facilityIds.slice(i, i + 99);
        const placeholders = chunk.map(() => "?").join(", ");
        const rows = await c.env.DB.prepare(
          `SELECT id, latitude, longitude FROM facilities WHERE unit_id = ? AND archived_at IS NULL AND id IN (${placeholders})`,
        ).bind(p.unitId, ...chunk).all<{ id: string; latitude: number; longitude: number }>();
        found.push(...rows.results);
      }
      if (found.length !== body.facilityIds.length) throw new HttpError("NOT_FOUND");
      // 巡回計画の作成/確定は対象施設1件ごとのPER-14（docs/10「参照施設の権限」）
      for (const facility of found) {
        requirePermission(p, "PER-14", { unitId: p.unitId, type: "facility", id: facility.id });
      }
      candidates = found;
    }

    const planId = crypto.randomUUID();
    // 候補順の提案（最近傍法）。knownKeyのときは再送で提案を計算し直さない（応答は保存済みのものを返す）
    const proposal = proposeStopOrder(candidates);
    const positionOf = new Map(proposal.map((id, i) => [id, i + 1]));
    const stopIds = new Map(body.facilityIds.map((facilityId) => [facilityId, crypto.randomUUID()]));

    const result = await executeMutation(c.env, p, {
      operationCode: "patrol_plan.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/patrol-plans", body }),
      expectedAuthzVersion: p.authzVersion,
      // 作成だけの操作（更新対象のrootは無し。docs/05 §3「作成入力にversionは含めない」）
      roots: [],
      created: [
        { table: "patrol_plans", id: planId },
        ...body.facilityIds.map((facilityId) => ({ table: "patrol_plan_stops", id: stopIds.get(facilityId)!, noMutationToken: true })),
      ],
      statements: (ctx) => [
        c.env.DB.prepare(
          "INSERT INTO patrol_plans (id, unit_id, plan_date, objective, status, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, 'human')",
        ).bind(planId, p.unitId, body.date, body.objective, ctx.attempt, ctx.now, ctx.now, p.userId),
        ...body.facilityIds.map((facilityId) =>
          c.env.DB.prepare(
            "INSERT INTO patrol_plan_stops (id, unit_id, plan_id, facility_id, position, actor_user_id, actor_kind, created_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, 'human', ?)",
          ).bind(stopIds.get(facilityId)!, p.unitId, planId, facilityId, positionOf.get(facilityId)!, p.userId, ctx.now),
        ),
      ],
      audit: {
        action: "patrol_plan.create", entityType: "patrol_plan", entityId: planId,
        metadata: { date: body.date, stopCount: body.facilityIds.length },
      },
      event: {
        entityType: "patrol_plan", entityId: planId, entityVersion: 1, eventType: "patrol_plan.created",
        payload: { date: body.date, stopCount: body.facilityIds.length },
      },
      response: { status: 201, sql: PATROL_PLAN_JSON, binds: [planId], decode: (j) => PatrolPlan.parse(j) },
    });
    return ok(c, result.data, {}, result.status);
  });

  // --- API-79 決定（確定/取消。200。confirmed/cancelledは終端） ---
  defineRoute(app, "API-79", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-79");

    const knownKey = await c.env.DB.prepare(
      "SELECT 1 FROM idempotency_records WHERE actor_user_id = ? AND operation_code = ? AND idempotency_key = ?",
    ).bind(p.userId, "patrol_plan.decide", headers["idempotency-key"]).first();

    let currentStops: string[] = [];
    if (!knownKey) {
      // 対象の案（別unit/不在は同じ404。物理削除はしないため再送中に消えることはない）
      const plan = await c.env.DB.prepare("SELECT unit_id FROM patrol_plans WHERE id = ?").bind(params.id).first<{ unit_id: string }>();
      if (!plan || plan.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
      // 現在の立ち寄り順（position順。決定はこの対象集合と完全一致で送る）
      const stops = await c.env.DB.prepare(
        "SELECT facility_id FROM patrol_plan_stops WHERE unit_id = ? AND plan_id = ? ORDER BY position",
      ).bind(p.unitId, params.id).all<{ facility_id: string }>();
      currentStops = stops.results.map((r) => r.facility_id);
      // orderedFacilityIdsは対象施設と完全一致の集合かつ重複なし（docs/16 T071。対象外・欠け・重複は400）
      const ids = new Set(body.orderedFacilityIds);
      if (ids.size !== body.orderedFacilityIds.length) {
        throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "orderedFacilityIds", reason: "duplicate_facility" }]);
      }
      if (ids.size !== currentStops.length || !currentStops.every((id) => ids.has(id))) {
        throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "orderedFacilityIds", reason: "plan_stops_mismatch" }]);
      }
      // 巡回計画の作成/確定は対象施設1件ごとのPER-14（docs/10「参照施設の権限」）
      for (const facilityId of body.orderedFacilityIds) {
        requirePermission(p, "PER-14", { unitId: p.unitId, type: "facility", id: facilityId });
      }
    }

    const confirm = body.decision === "confirm";
    const stopIds = new Map(body.orderedFacilityIds.map((facilityId) => [facilityId, crypto.randomUUID()]));
    const result = await executeMutation(c.env, p, {
      operationCode: "patrol_plan.decide",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/patrol-plans/${params.id}/decision`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      // 版ガード＋状態前提（draftからのみ。版違いは409、draft以外は422にdiagnoseが分類する）
      roots: [{ table: "patrol_plans", id: params.id, expectedVersion: body.version, allowedStates: { column: "status", values: ["draft"] } }],
      created: confirm
        ? body.orderedFacilityIds.map((facilityId) => ({ table: "patrol_plan_stops", id: stopIds.get(facilityId)!, noMutationToken: true }))
        : [],
      statements: (ctx) => [
        // 確定はstopsを作り直す（人が送った順序でpositionを確定。取消は触らない）
        ...(confirm
          ? [
              c.env.DB.prepare("DELETE FROM patrol_plan_stops WHERE unit_id = ? AND plan_id = ?").bind(p.unitId, params.id),
              ...body.orderedFacilityIds.map((facilityId, i) =>
                c.env.DB.prepare(
                  "INSERT INTO patrol_plan_stops (id, unit_id, plan_id, facility_id, position, actor_user_id, actor_kind, created_at) " +
                    "VALUES (?, ?, ?, ?, ?, ?, 'human', ?)",
                ).bind(stopIds.get(facilityId)!, p.unitId, params.id, facilityId, i + 1, p.userId, ctx.now),
              ),
            ]
          : []),
        c.env.DB.prepare(
          "UPDATE patrol_plans SET status = ?, decided_at = ?, decided_by = ?, version = version + 1, " +
            "last_mutation_token = ?, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ? AND status = 'draft'",
        ).bind(confirm ? "confirmed" : "cancelled", ctx.now, p.userId, ctx.attempt, ctx.now, params.id, p.unitId, body.version),
      ],
      audit: {
        action: confirm ? "patrol_plan.confirm" : "patrol_plan.cancel", entityType: "patrol_plan", entityId: params.id,
        metadata: { stopCount: body.orderedFacilityIds.length },
      },
      event: {
        entityType: "patrol_plan", entityId: params.id, entityVersion: body.version + 1,
        eventType: confirm ? "patrol_plan.confirmed" : "patrol_plan.cancelled",
        payload: { stopCount: body.orderedFacilityIds.length },
      },
      response: { status: 200, sql: PATROL_PLAN_JSON, binds: [params.id], decode: (j) => PatrolPlan.parse(j) },
    });
    return ok(c, result.data, {}, result.status);
  });
}
