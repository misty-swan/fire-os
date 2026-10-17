import { Attendance, type AttendanceDto } from "../../shared/contracts/operations";
import { attendanceResponses } from "../../shared/states";
import { hasScope } from "../auth/authorize";
import { resolvePrincipal, type AuthzPrincipal } from "../auth/principal";
import type { AppEnv } from "../env";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation, type MutationSpec } from "../mutations/execute";
import { requirePermission } from "./invitations";

/**
 * 出欠の回答（T036、docs/05 API-08/41、docs/11 出欠、docs/10 PER-02、docs/14 D05）。
 * - 行は(activity_id, member_id)で一意。未回答は行が無いことで表現し、初回回答はversion=0でINSERTする
 *   （docs/05 §2「未作成PUTは0を指定してINSERT UNIQUEをガード」。行ありに0を送ると旧版の409）。
 * - 未定(undecided)と取り下げ(unanswered)は別。取り下げはresponse=unansweredで行を残し版を進める
 *   （docs/11「未回答は回答レコード未作成でも表現し、未定と区別」。回答版の連続性を保つ）。
 * - 締切・対象検査はbatch内の前提条件で検査する（docs/05 API-08「締切/対象検査」）。同キー再送は
 *   冪い録の解決が先なので元の応答を返し、現在の状態（締切・対象）を再適用しない（docs/05 §2）。
 * - 代理（API-41）はD05の承認済scope（scope_assignmentsのentity_type='member'×PER-02）を持つ者だけ。
 *   役割では開かない（docs/10「本人のみ。代理はD05で別付与」）。理由は契約で必須（無しは400）。
 *   代理の操作はattendance_eventsにproxy_for_member_idと理由を記録する（本人回答はNULL）。
 * - T076: mutationの組み立てはbuildRespondAttendanceとして公開し、通信断同期（API-81）が同じ
 *   認可・版・状態前提のまま再利用する（オフライン操作も再認可。docs/10 PER-13）。
 */

const ATTENDANCE_JSON =
  "SELECT json_object('id', id, 'version', version, 'memberId', member_id, 'response', response, 'respondedAt', responded_at) " +
  "FROM activity_attendance WHERE id = ?";

type AttendanceResponse = (typeof attendanceResponses)[number];

interface RespondBody {
  version: number;
  response: AttendanceResponse;
  reason?: string;
}

export interface BuiltAttendance {
  spec: MutationSpec<AttendanceDto>;
  attendanceId: string;
}

/**
 * 本人または許可代理の出欠回答のmutationを組み立てる。対象者の行を1行だけ作成/更新し、履歴・監査・outboxを
 * 同じbatchに載せる。存在しない/別unitの活動は同じ404（存在を明かさない）。実行は呼出し側がexecuteMutationで
 * 行う（T076の同期は実行前に台帳書込をspecに追加するため、組み立てと実行を分けている）。
 */
export async function buildRespondAttendance(
  env: AppEnv,
  p: AuthzPrincipal,
  activityId: string,
  targetMemberId: string,
  body: RespondBody,
  key: string,
  requestPath: string,
): Promise<BuiltAttendance> {
  const activity = await env.DB.prepare("SELECT id, unit_id FROM activities WHERE id = ?").bind(activityId)
    .first<{ id: string; unit_id: string }>();
  if (!activity || activity.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");

  const isSelf = targetMemberId === p.memberId;
  if (isSelf) {
    // PER-02は本人の対象だけ（docs/10）。API-08は常に自分の行
    requirePermission(p, "PER-02", { unitId: p.unitId, type: "activity", id: activityId, ownerMemberId: p.memberId });
  } else {
    // 代理の対象は同unitの団員（存在しない/別unitは存在を明かさず同じ404）
    const targetMember = await env.DB.prepare("SELECT unit_id FROM members WHERE id = ?").bind(targetMemberId)
      .first<{ unit_id: string }>();
    if (!targetMember || targetMember.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
    // 代理はD05の承認済scopeだけ（対象団員×PER-02）。scopeが無い本人以外の操作は403
    if (!hasScope(p, "PER-02", { unitId: p.unitId, type: "member", id: targetMemberId })) {
      throw new HttpError("FORBIDDEN", undefined, [{ field: "permission", reason: "scope_required" }]);
    }
  }

  // 既存行を読む。行は削除しないため「version>0なのに行が無い」は古い状態（409）。
  // 同キー再送はexecuteMutation内で先に解決されるので、この検査が再送を壊さない
  const existing = await env.DB.prepare(
    "SELECT id, version FROM activity_attendance WHERE activity_id = ? AND member_id = ?",
  ).bind(activityId, targetMemberId).first<{ id: string; version: number }>();
  if (!existing && body.version !== 0) {
    throw new HttpError("VERSION_CONFLICT", undefined, [{ field: "version", reason: "attendance_row_missing" }]);
  }

  const attendanceId = existing?.id ?? crypto.randomUUID();
  const proxyFor = isSelf ? null : targetMemberId;
  const nowIso = new Date().toISOString();
  const spec: MutationSpec<AttendanceDto> = {
    operationCode: "attendance.respond",
    key,
    requestHash: await canonicalRequestHash({ method: "PUT", path: requestPath, baseVersion: body.version, body }),
    expectedAuthzVersion: p.authzVersion,
    roots: [
      // INSERT(未作成, version=0)は作成後のversion=1、UPDATEはversion=期待+1を同じguardで検査する。
      // 行ありにversion=0を送った場合のUNIQUE違反も、ここで旧版の409として分類される
      { table: "activity_attendance", id: attendanceId, expectedVersion: body.version },
    ],
    conditions: [
      // 対象検査（docs/04「未回答母数は…対象snapshot」）。対象snapshotに入っていない団員の回答は不可
      {
        existsSql: "SELECT 1 FROM activity_audience WHERE activity_id = ? AND member_id = ?",
        binds: [activityId, targetMemberId],
        failCode: "FORBIDDEN",
      },
      {
        // 受付中のみ（docs/11 出欠）: 公開済（scheduled/in_progress）で締切内。draft/completed/cancelledは不可
        existsSql: "SELECT 1 FROM activities WHERE id = ? AND unit_id = ? AND status IN ('scheduled', 'in_progress') " +
          "AND (response_due_at IS NULL OR response_due_at >= ?)",
        binds: [activityId, p.unitId, nowIso],
        failCode: "INVALID_TRANSITION",
      },
    ],
    statements: (ctx) => [
      existing
        ? env.DB.prepare(
            "UPDATE activity_attendance SET response = ?, responded_at = ?, version = version + 1, last_mutation_token = ?, updated_at = ? " +
              "WHERE id = ? AND unit_id = ? AND version = ?",
          ).bind(body.response, ctx.now, ctx.attempt, ctx.now, attendanceId, p.unitId, body.version)
        : env.DB.prepare(
            "INSERT INTO activity_attendance (id, unit_id, activity_id, member_id, response, responded_at, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human')",
          ).bind(attendanceId, p.unitId, activityId, targetMemberId, body.response, ctx.now, ctx.attempt, ctx.now, ctx.now, p.userId),
      // 履歴（docs/04 attendance_events）。本人回答はproxy_for_member_id=NULL、代理は対象団員と理由を記録
      env.DB.prepare(
        "INSERT INTO attendance_events (id, unit_id, attendance_id, response, proxy_for_member_id, reason, actor_user_id, actor_kind, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 'human', ?)",
      ).bind(crypto.randomUUID(), p.unitId, attendanceId, body.response, proxyFor, body.reason ?? null, p.userId, ctx.now),
    ],
    audit: {
      action: "attendance.respond",
      entityType: "activity_attendance",
      entityId: attendanceId,
      metadata: { activityId, response: body.response, proxyFor },
    },
    event: {
      entityType: "activity_attendance",
      entityId: attendanceId,
      entityVersion: (existing?.version ?? 0) + 1,
      eventType: "attendance.responded",
      payload: { activityId, response: body.response },
    },
    response: { status: existing ? 200 : 201, sql: ATTENDANCE_JSON, binds: [attendanceId], decode: (j) => Attendance.parse(j) },
  };
  return { spec, attendanceId };
}

export function registerAttendanceRoutes(app: ApiApp): void {
  // --- API-08: 本人の出欠（固定パス /attendance/me を /attendance/:memberId より先に照合。docs/05 §1、Honoは登録順） ---
  defineRoute(app, "API-08", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-08");
    const built = await buildRespondAttendance(c.env, p, params.id, p.memberId, body, headers["idempotency-key"], `/activities/${params.id}/attendance/me`);
    const result = await executeMutation(c.env, p, built.spec);
    return ok(c, result.data, {}, result.status);
  });

  // --- API-41: 許可代理の出欠（D05承認済scope。理由必須は契約。対象が自分なら本人回答として記録） ---
  defineRoute(app, "API-41", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-41");
    const built = await buildRespondAttendance(c.env, p, params.id, params.memberId, body, headers["idempotency-key"], `/activities/${params.id}/attendance/${params.memberId}`);
    const result = await executeMutation(c.env, p, built.spec);
    return ok(c, result.data, {}, result.status);
  });
}
