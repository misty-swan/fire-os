import { InspectionSchedule } from "../../shared/contracts/assets";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { requirePermission } from "./invitations";

/**
 * 点検期限の設定（T048、docs/05 API-56、docs/04:119、docs/14 D06）。
 * - **未作成PUT（docs/05 §2）**: 対象ごとに1行（docs/04:119「対象一つ」。部分一意索引で担保）。
 *   version=0でINSERT、既存行はversion比較更新（旧版・同版並行は409）。行がありversion=0は
 *   INSERT UNIQUE違反→diagnoseがrootの版比較で409に分類する（T036のactivity_attendanceと同じ流儀）。
 * - **PUTは全置換**（docs/05 §1のResourceUsageList PUTと同じ。intervalDays省略はNULL＝周期未設定）。
 *   次回点検日・正周期・Asia/Tokyoを保存する（timezoneは契約でAsia/Tokyo固定。D06）。
 * - **対象検査**: 同unitの車両/資機材（存在しない/別unitは同じ404。docs/05 §1「存在を明かさない」）。
 *   廃止資産への設定は拒否しない（期限の記録は台帳の値で、検出が廃止資産をskipする。docs/14 D24）。
 * - **冪等・監査・outboxは1つのbatch**（executeMutation）。再送は鍵の解決が先のため、
 *   状態前提の読み取りを飛ばして元の応答を返す（T042 resource-usagesと同じ流儀）。
 * - 期限超過の検出（通知候補）はsrc/server/jobs/handlers/inspection-due.tsのCronが行い、
 *   このAPIは検出を行わない（T050がnotificationsへ接続）。
 */

const SCHEDULE_JSON =
  "SELECT json_object('id', id, 'version', version, " +
  "'target', json_object('type', CASE WHEN vehicle_id IS NOT NULL THEN 'vehicle' ELSE 'equipment' END, " +
  "'id', COALESCE(vehicle_id, equipment_id)), " +
  "'nextDueDate', next_due_date, 'intervalDays', interval_days, 'timezone', timezone) " +
  "FROM inspection_schedules WHERE id = ?";

export function registerInspectionScheduleRoutes(app: ApiApp): void {
  defineRoute(app, "API-56", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-56");
    requirePermission(p, "PER-03", { unitId: p.unitId, type: params.type, id: params.id });
    const assetTable = params.type === "vehicle" ? "vehicles" : "equipment";
    const targetColumn = params.type === "vehicle" ? "vehicle_id" : "equipment_id";

    // 同じ鍵の再送（docs/05 §2）はexecuteMutation内で先に解決される。鍵があるときは
    // 状態前提の読み取り（対象の所在・既存scheduleの版）を飛ばす（T042 resource-usagesと同じ流儀）
    const knownKey = await c.env.DB.prepare(
      "SELECT 1 FROM idempotency_records WHERE actor_user_id = ? AND operation_code = ? AND idempotency_key = ?",
    ).bind(p.userId, "inspection_schedule.set", headers["idempotency-key"]).first();

    let existing: { id: string; version: number } | null = null;
    if (!knownKey) {
      // 対象の存在・同unit（存在しない/別unitは同じ404。物理削除はしないため再送中に消えることはない）
      const asset = await c.env.DB.prepare(`SELECT unit_id FROM ${assetTable} WHERE id = ?`).bind(params.id)
        .first<{ unit_id: string }>();
      if (!asset || asset.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
      // 既存のschedule（対象ごとに1行。docs/04:119）
      existing = await c.env.DB.prepare(`SELECT id, version FROM inspection_schedules WHERE ${targetColumn} = ?`)
        .bind(params.id).first<{ id: string; version: number }>();
      if (!existing && body.version !== 0) {
        throw new HttpError("VERSION_CONFLICT", undefined, [{ field: "version", reason: "schedule_row_missing" }]);
      }
    }

    const scheduleId = existing?.id ?? crypto.randomUUID();
    const result = await executeMutation(c.env, p, {
      operationCode: "inspection_schedule.set",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({
        method: "PUT", path: `/assets/${params.type}/${params.id}/inspection-schedule`, baseVersion: body.version, body,
      }),
      expectedAuthzVersion: p.authzVersion,
      // INSERT（version=0→作成後1）とUPDATE（期待版+1）を同じ比較更新ガードで検査する（attendanceと同じ）
      roots: [{ table: "inspection_schedules", id: scheduleId, expectedVersion: body.version }],
      created: existing || knownKey ? [] : [{ table: "inspection_schedules", id: scheduleId }],
      statements: (ctx) => [
        existing
          ? c.env.DB.prepare(
              "UPDATE inspection_schedules SET next_due_date = ?, interval_days = ?, timezone = ?, " +
                "version = version + 1, last_mutation_token = ?, updated_at = ? " +
                "WHERE id = ? AND unit_id = ? AND version = ?",
            ).bind(body.nextDueDate, body.intervalDays ?? null, body.timezone, ctx.attempt, ctx.now, scheduleId, p.unitId, body.version)
          : c.env.DB.prepare(
              "INSERT INTO inspection_schedules (id, unit_id, vehicle_id, equipment_id, next_due_date, interval_days, timezone, " +
                "last_mutation_token, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human')",
            ).bind(
              scheduleId, p.unitId, params.type === "vehicle" ? params.id : null, params.type === "equipment" ? params.id : null,
              body.nextDueDate, body.intervalDays ?? null, body.timezone, ctx.attempt, ctx.now, ctx.now, p.userId,
            ),
      ],
      audit: {
        action: "inspection_schedule.set", entityType: "inspection_schedule", entityId: scheduleId,
        metadata: { target: params.type, nextDueDate: body.nextDueDate },
      },
      event: {
        entityType: "inspection_schedule", entityId: scheduleId,
        entityVersion: (existing?.version ?? 0) + 1, eventType: "inspection_schedule.set",
        payload: { target: params.type },
      },
      response: {
        status: existing ? 200 : 201, sql: SCHEDULE_JSON, binds: [scheduleId],
        decode: (j) => InspectionSchedule.parse(j),
      },
    });
    return ok(c, result.data, {}, result.status);
  });
}
