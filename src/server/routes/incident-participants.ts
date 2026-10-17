import { IncidentParticipant, type IncidentParticipantDto } from "../../shared/contracts/operations";
import { canTransition, mobilizationStates, mobilizationTransitions } from "../../shared/states";
import { hasScope } from "../auth/authorize";
import { resolvePrincipal, type AuthzPrincipal } from "../auth/principal";
import type { AppEnv } from "../env";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation, type MutationSpec } from "../mutations/execute";
import { requirePermission } from "./invitations";

/**
 * 参集・到着・帰還の本人/代理記録（T041、docs/05 API-23、docs/11 参集/帰還unconfirmed行、docs/04:96-97、docs/14 D08）。
 * - 行は(incident_id, member_id)で一意。出動に参加者名簿は無いため、行の無い状態がunconfirmed（未確認）を表現し、
 *   初回記録はversion=0でINSERTする（docs/05 §2。attendanceと同じ。行ありに0を送ると旧版の409）。
 * - 遷移はdocs/11の許可辺のみ（unconfirmed→unavailable/mobilizing/arrived/returned、mobilizing→arrived/unavailable、
 *   arrived→returned。unavailable/returnedは終端）。同一状態への再送信は遷移ではないが、時刻の訂正
 *   （docs/11「履歴訂正は別イベント」）として通し、before/afterをincident_participant_eventsへ追記する。
 * - 時刻（times）は既知の値だけを送る。省略した時刻は既存値を維持し、未知はNULLのまま残す
 *   （docs/11「事後入力では欠落時刻を捏造しない」）。順序はdocs/04:96「既知時刻の順序」どおり
 *   mobilizedAt <= arrivedAt <= returnedAtで、**両方存在する組だけ**検査する（片方未知は保留。違反は400）。
 * - 本人は自分の行（PER-04の本人分）、代理はD08の代理scope（scope_assignmentsのentity_type='member'×PER-04）を
 *   持つ者だけ（attendance.ts T036の流儀。docs/10「代理入力・他人の時刻はD05/D08」。役割では開かない）。
 *   理由は契約どおり任意（D08が未決のため、T036の契約必須とは揃えず追加制限もしない）。
 *   代理の操作は履歴のafter_jsonにproxyFor（対象団員）と理由を記録する。本人はproxyFor=NULL。
 * - returnedは帰還記録であり、出欠のabsentや実参加のabsentとは別物（docs/11:21。混同しない）。
 * - 同時競合で負けた側は業務書込・履歴・監査・outboxのすべてが残らない（1つのbatchで取消）。
 * - T076: mutationの組み立てはbuildRecordParticipationとして公開し、通信断同期（API-81）が同じ
 *   認可・版・状態前提のまま再利用する（オフライン操作も再認可。docs/10 PER-13）。
 */

const PARTICIPANT_JSON =
  "SELECT json_object('id', id, 'version', version, 'memberId', member_id, 'attendanceStatus', attendance_status, " +
  "'mobilizedAt', mobilized_at, 'arrivedAt', arrived_at, 'returnedAt', returned_at) FROM incident_participants WHERE id = ?";

type MobilizationStatus = (typeof mobilizationStates)[number];

/** 冪等記録のoperation code（idempotency_recordsはuser＋code＋keyで一意。docs/05 §2） */
const OPERATION_CODE = "incident.participant.record";

interface RecordBody {
  version: number;
  attendanceStatus: MobilizationStatus;
  times?: { mobilizedAt?: string; arrivedAt?: string; returnedAt?: string };
  reason?: string;
}

interface ExistingRow {
  id: string; version: number; attendance_status: string;
  mobilized_at: string | null; arrived_at: string | null; returned_at: string | null;
}

export interface BuiltParticipation {
  spec: MutationSpec<IncidentParticipantDto>;
  participantId: string;
}

/**
 * 本人または許可代理の参集記録のmutationを組み立てる。対象団員の行を1行だけ作成/更新し、履歴・監査・outboxを
 * 同じbatchに載せる。存在しない/別unitの出動・団員は同じ404（存在を明かさない）。
 * 実行は呼出し側がexecuteMutationで行う（T076の同期は実行前に台帳書込をspecに追加するため）。
 */
export async function buildRecordParticipation(
  env: AppEnv,
  p: AuthzPrincipal,
  incidentId: string,
  targetMemberId: string,
  body: RecordBody,
  key: string,
  requestPath: string,
): Promise<BuiltParticipation> {
  const incident = await env.DB.prepare("SELECT id, unit_id FROM incidents WHERE id = ?").bind(incidentId)
    .first<{ id: string; unit_id: string }>();
  if (!incident || incident.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");

  const isSelf = targetMemberId === p.memberId;
  if (isSelf) {
    // PER-04の本人分（docs/10。一般団員は自分の参集だけ。幹部・管理者は所属内で本人分も可）
    requirePermission(p, "PER-04", { unitId: p.unitId, type: "incident", id: incidentId, ownerMemberId: p.memberId });
  } else {
    // 代理の対象は同unitの団員（存在しない/別unitは存在を明かさず同じ404）
    const targetMember = await env.DB.prepare("SELECT unit_id FROM members WHERE id = ?").bind(targetMemberId)
      .first<{ unit_id: string }>();
    if (!targetMember || targetMember.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
    // 代理はD08の代理scopeだけ（対象団員×PER-04）。scopeが無い本人以外の操作は役割でも開かない（403）
    if (!hasScope(p, "PER-04", { unitId: p.unitId, type: "member", id: targetMemberId })) {
      throw new HttpError("FORBIDDEN", undefined, [{ field: "permission", reason: "scope_required" }]);
    }
  }

  // 既存行を読む。行は削除しないため「version>0なのに行が無い」は古い状態（409）
  const existing = await env.DB.prepare(
    "SELECT id, version, attendance_status, mobilized_at, arrived_at, returned_at FROM incident_participants " +
      "WHERE incident_id = ? AND member_id = ?",
  ).bind(incidentId, targetMemberId).first<ExistingRow>();

  // 書込内容は「送信で上書き、省略は既存維持」の併合結果（未知はNULLのまま。履歴のafter_jsonも同じ値）
  const fromStatus = existing?.attendance_status ?? "unconfirmed";
  const nextMobilizedAt = body.times?.mobilizedAt ?? existing?.mobilized_at ?? null;
  const nextArrivedAt = body.times?.arrivedAt ?? existing?.arrived_at ?? null;
  const nextReturnedAt = body.times?.returnedAt ?? existing?.returned_at ?? null;

  // docs/05 §2「同じキー/本文の再送は元HTTP status/dataを返し」: 現在の状態では不可になる変更（旧版・遷移・
  // 重複する訂正）でも、保存済み応答のある再送はexecuteMutationが先に解決して元の応答を返す（T036と同じ）。
  // 鍵が既にある（=再送の）ときは状態前提を検査しない。新しい操作のときだけ検査してからbatchに入る
  const knownKey = await env.DB.prepare(
    "SELECT 1 FROM idempotency_records WHERE actor_user_id = ? AND operation_code = ? AND idempotency_key = ?",
  ).bind(p.userId, OPERATION_CODE, key).first();
  if (!knownKey) {
    if (!existing && body.version !== 0) {
      throw new HttpError("VERSION_CONFLICT", undefined, [{ field: "version", reason: "participant_row_missing" }]);
    }
    // 行ありにversion=0は「未作成」を意味するので旧版（409。executeMutationのroot guardと同じ分類）
    if (existing && body.version === 0) {
      throw new HttpError("VERSION_CONFLICT", undefined, [{ field: "version", reason: "row_already_exists" }]);
    }
    // unconfirmedは行が無いことで表現する初期値（docs/11の辺に自己辺が無い。行を作って持たせる状態ではない）
    if (!existing && body.attendanceStatus === "unconfirmed") {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "attendanceStatus", reason: "unconfirmed_is_initial" }]);
    }

    // 状態と時刻の変更点（docs/11の遷移辺と「履歴訂正は別イベント」。同一状態での時刻変更は訂正として通す）
    const statusChanged = body.attendanceStatus !== fromStatus;
    const timesChanged =
      (body.times?.mobilizedAt !== undefined && body.times.mobilizedAt !== existing?.mobilized_at) ||
      (body.times?.arrivedAt !== undefined && body.times.arrivedAt !== existing?.arrived_at) ||
      (body.times?.returnedAt !== undefined && body.times.returnedAt !== existing?.returned_at);
    if (!statusChanged && !timesChanged) {
      // 状態も時刻も動かない送信（新しいキー）は変更点なし。API-69と同じ扱い
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "(body)", reason: "no_changes" }]);
    }
    if (statusChanged && !canTransition(mobilizationTransitions, fromStatus as keyof typeof mobilizationTransitions, body.attendanceStatus)) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "attendanceStatus", reason: "transition_not_allowed" }]);
    }

    // 既知時刻の順序（docs/04:96「既知時刻の順序」）。片方未知（NULL）の組は検査しない
    // （docs/11「事後入力では欠落時刻を捏造しない」）。違反はDBのCHECKで500にする前に400で返す
    const violations: { field: string; reason: string }[] = [];
    if (nextMobilizedAt && nextArrivedAt && nextArrivedAt < nextMobilizedAt) {
      violations.push({ field: "times.arrivedAt", reason: "before_mobilized_at" });
    }
    if (nextMobilizedAt && nextReturnedAt && nextReturnedAt < nextMobilizedAt) {
      violations.push({ field: "times.returnedAt", reason: "before_mobilized_at" });
    }
    if (nextArrivedAt && nextReturnedAt && nextReturnedAt < nextArrivedAt) {
      violations.push({ field: "times.returnedAt", reason: "before_arrived_at" });
    }
    if (violations.length) throw new HttpError("VALIDATION_ERROR", undefined, violations);
  }

  const participantId = existing?.id ?? crypto.randomUUID();
  const proxyFor = isSelf ? null : targetMemberId;
  const beforeJson = JSON.stringify({
    attendanceStatus: fromStatus,
    mobilizedAt: existing?.mobilized_at ?? null,
    arrivedAt: existing?.arrived_at ?? null,
    returnedAt: existing?.returned_at ?? null,
  });
  const afterJson = JSON.stringify({
    attendanceStatus: body.attendanceStatus,
    mobilizedAt: nextMobilizedAt,
    arrivedAt: nextArrivedAt,
    returnedAt: nextReturnedAt,
    proxyFor, // 代理入力のときは対象団員（docs/04:97「代理入力者/訂正保持」。本人はNULL）
  });

  const spec: MutationSpec<IncidentParticipantDto> = {
    operationCode: OPERATION_CODE,
    key,
    requestHash: await canonicalRequestHash({ method: "PUT", path: requestPath, baseVersion: body.version, body }),
    expectedAuthzVersion: p.authzVersion,
    roots: [
      // INSERT(未作成, version=0)は作成後のversion=1、UPDATEはversion=期待+1を同じguardで検査する。
      // 行ありにversion=0を送った場合も、0行更新をassertionが検出して旧版の409になる
      { table: "incident_participants", id: participantId, expectedVersion: body.version },
    ],
    statements: (ctx) => [
      existing
        ? env.DB.prepare(
            "UPDATE incident_participants SET attendance_status = ?, mobilized_at = ?, arrived_at = ?, returned_at = ?, " +
              "version = version + 1, last_mutation_token = ?, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ?",
          ).bind(body.attendanceStatus, nextMobilizedAt, nextArrivedAt, nextReturnedAt, ctx.attempt, ctx.now, participantId, p.unitId, body.version)
        : env.DB.prepare(
            "INSERT INTO incident_participants (id, unit_id, incident_id, member_id, attendance_status, mobilized_at, arrived_at, returned_at, " +
              "last_mutation_token, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human')",
          ).bind(participantId, p.unitId, incidentId, targetMemberId, body.attendanceStatus, nextMobilizedAt, nextArrivedAt, nextReturnedAt, ctx.attempt, ctx.now, ctx.now, p.userId),
      // 履歴（docs/04:97。前後の状態・時刻と代理入力の対象・理由。失敗した変更は残らない）
      env.DB.prepare(
        "INSERT INTO incident_participant_events (id, unit_id, participant_id, before_json, after_json, reason, actor_user_id, actor_kind, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 'human', ?)",
      ).bind(crypto.randomUUID(), p.unitId, participantId, beforeJson, afterJson, body.reason ?? null, p.userId, ctx.now),
    ],
    audit: {
      action: "incident.participant.record",
      entityType: "incident_participant",
      entityId: participantId,
      metadata: { incidentId, attendanceStatus: body.attendanceStatus, proxyFor },
    },
    event: {
      entityType: "incident_participant",
      entityId: participantId,
      entityVersion: (existing?.version ?? 0) + 1,
      eventType: "incident_participant.recorded",
      payload: { incidentId, attendanceStatus: body.attendanceStatus },
    },
    response: { status: existing ? 200 : 201, sql: PARTICIPANT_JSON, binds: [participantId], decode: (j) => IncidentParticipant.parse(j) },
  };
  return { spec, participantId };
}

export function registerParticipantRoutes(app: ApiApp): void {
  // --- API-23: 参集・到着・帰還の記録（本人/代理。docs/05 API-23、docs/11 参集/帰還行、docs/10 PER-04、docs/14 D08） ---
  defineRoute(app, "API-23", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-23");
    const built = await buildRecordParticipation(
      c.env, p, params.id, params.memberId, body, headers["idempotency-key"],
      `/incidents/${params.id}/participants/${params.memberId}`,
    );
    const result = await executeMutation(c.env, p, built.spec);
    return ok(c, result.data, {}, result.status);
  });
}
