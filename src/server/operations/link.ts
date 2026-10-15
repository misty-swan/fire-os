import { OperationLinkResult } from "../../shared/contracts/operations";
import type { ApiRequest, ApiResponse } from "../../shared/contracts/registry";
import { parseRequest } from "../../shared/contracts/registry";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, type ApiContext } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation, type ExtraCondition, type MutationSpec, type RootGuard } from "../mutations/execute";
import { requirePermission } from "../routes/invitations";

/**
 * 出動と既存活動を一つの出来事（operation）へ関連付け（T043、docs/04:94/103、docs/05 API-71、
 * docs/11、docs/14 D08、AT-DSP-03）。
 * - **リンク=両rootのoperation一致**: activities.operation_id と incidents.operation_id は
 *   作成経路（T035/T040）で別々に採番された operations行を指す。リンクで出動と使用履歴を
 *   **活動側operationへ付け替え**、旧出動側operationは countable=0（非計数化）にして
 *   履歴/監査参照は可能のまま残す（docs/04:103「旧operationを非計数化し旧ID/理由をイベントへ残す」。
 *   物理削除はしない。docs/04:100）。
 * - **両rootロック（docs/05 API-71「両rootロック」）**: incidents.version と activities.version、
 *   さらに operationVersions に載る双方のoperation版を、すべて1つのbatch内の比較更新で検査する
 *   （早期の版検査はしない。片側だけ版が進んでいるとき、途中の文まで実行されたbatch全体が
 *   取り消され、片側だけ進む分断を作らない。docs/05 §2「競合では履歴/監査を残さない」）。
 * - **一活動一出動**: 既に別の出動へリンク済みの活動は409 DUPLICATE（docs/04:103「既存の別リンクが
 *   ある場合は409とし上書きしない」。incidents.activity_id UNIQUE＋batch内の明示条件の二重化）。
 *   リンク済み出動の付け替え（再リンク）はdocs/05・docs/11に根拠が無いため422で拒否し、
 *   voided出動（docs/11「voidedは閲覧のみ」）へのリンクも422で拒否する。
 * - **使用移管**: resource_usages は operation_id をキーとするため、旧出動側operationの全行の
 *   operation_id を生存operationへ付け替える（対象・数量・時間・状態は据え置き。行の版だけ進める）。
 *   リンク後に双方の使用履歴がすべて見え、有効operationは1つになる。使用の別eventは出さない
 *   （一mutation一event。docs/02 §4）。
 * - **API-22との共通処理**: 活動の存在・同unit検査と生存operationの特定は
 *   resolveActivityForLink に集約し、出動の作成時リンク（API-22のactivityId）でも同じ規則を適用する
 *   （作成時は出動を生まれたときから活動のoperationへ属させ、docs/04:94「リンク時operation一致」）。
 * - 履歴・監査・outbox（incident_events＋activity_events＋監査＋domain_events）まで
 *   1つのD1 batchで確定する（docs/02 §4）。
 */

export const LINK_OPERATION_CODE = "incident.activity.link";

/** 活動とその出来事root（生存側）の現行版、既存リンクの有無 */
export interface ActivityLinkTarget {
  activityId: string;
  activityVersion: number;
  activityStatus: string;
  /** 活動側の出来事root（リンク後の生存operation。docs/04:103「活動側operationへ付替」） */
  operationId: string;
  /** 生存operationの現行版（使用履歴API-57と同じ「operation版」） */
  operationVersion: number;
  /** 既にこの活動へリンク済みの出動（一活動一出動。docs/04:94 activity_id UNIQUE） */
  linkedIncidentId: string | null;
}

/**
 * リンク先の活動と出来事rootを読む（API-22のactivityId経路とAPI-71で共用する共通検査部）。
 * 別unit/存在しない活動は同じ404（docs/05 §1「存在を明かさない」）。
 */
export async function resolveActivityForLink(c: ApiContext, unitId: string, activityId: string): Promise<ActivityLinkTarget> {
  const row = await c.env.DB.prepare(
    "SELECT a.id, a.unit_id, a.status AS activity_status, a.version AS activity_version, a.operation_id, " +
      "o.version AS operation_version, " +
      "(SELECT i.id FROM incidents i WHERE i.unit_id = a.unit_id AND i.activity_id = a.id) AS linked_incident_id " +
      "FROM activities a JOIN operations o ON o.unit_id = a.unit_id AND o.id = a.operation_id WHERE a.id = ?",
  ).bind(activityId)
    .first<{
      id: string; unit_id: string; activity_status: string; activity_version: number;
      operation_id: string; operation_version: number; linked_incident_id: string | null;
    }>();
  if (!row || row.unit_id !== unitId) throw new HttpError("NOT_FOUND");
  return {
    activityId: row.id, activityVersion: row.activity_version, activityStatus: row.activity_status,
    operationId: row.operation_id, operationVersion: row.operation_version, linkedIncidentId: row.linked_incident_id,
  };
}

/** 一活動一出動の明示検査（409 DUPLICATE。API-22とAPI-71で共用。batch内のconditionsにも同じ条件を入れる） */
export function activityAlreadyLinked(target: ActivityLinkTarget): HttpError | null {
  return target.linkedIncidentId === null
    ? null
    : new HttpError("DUPLICATE", undefined, [{ field: "activityId", reason: "activity_already_linked" }]);
}

/** batch内で「この活動へリンク済みの出動が無い」ことを検査する条件（先行リンクの競合は409 DUPLICATE） */
export const activityNotLinkedCondition = (unitId: string, activityId: string): ExtraCondition => ({
  existsSql:
    "SELECT 1 FROM units u WHERE u.id = ? AND NOT EXISTS (SELECT 1 FROM incidents i WHERE i.unit_id = u.id AND i.activity_id = ?)",
  binds: [unitId, activityId],
  failCode: "DUPLICATE",
});

/** API-71の応答（Incident＋OperationLink）をSQLで組み立てる（batch内の応答確定用。docs/05:125） */
const LINK_RESULT_JSON =
  "SELECT json_object(" +
  "'incident', (SELECT json_object('id', id, 'version', version, 'operationId', operation_id, 'activityId', activity_id, " +
    "'kind', kind, 'occurredAt', occurred_at, 'summary', summary, 'status', status, 'createdBy', created_by, " +
    "'createdAt', created_at, 'updatedAt', updated_at) FROM incidents WHERE id = ?), " +
  "'link', json_object('incidentId', ?, 'activityId', ?, 'operationId', ?, 'retiredOperationId', ?, " +
    "'operationVersion', (SELECT version FROM operations WHERE id = ? AND unit_id = ?), " +
    "'retainedUsageIds', COALESCE((SELECT json_group_array(x.id) FROM " +
    "(SELECT id FROM resource_usages WHERE unit_id = ? AND operation_id = ? ORDER BY rowid) x), json_array())))";

/**
 * API-71: 出動と既存活動のリンク（docs/05 API-71、T043）。
 * 両root・双方のoperation版・編集権を検査し、出動と使用履歴を活動側operationへ付け替えて
 * 旧operationを非計数化する（docs/04:103）。どこか一つでも不一致なら409で全体を何も変えず拒否する。
 */
export async function linkIncidentActivity(
  c: ApiContext,
  input: ApiRequest<"API-71">,
): Promise<ApiResponse<"API-71">> {
  const p = await resolvePrincipal(c);
  const { params, body, headers } = parseRequest("API-71", input);

  // 0) 同じ鍵の再送（docs/05 §2「同じキー/本文の再送は元HTTP status/dataを返し」）。
  // 鍵が既にあるときは現在の状態では不可になる変更（voided・付け替え・競合リンク）でも
  // 保存済み応答を返す必要があるため、状態前提の検査を飛ばしてexecuteMutationへ渡す
  // （T041/T042と同じ流儀。executeMutationが鍵を見て早期returnするためspecの状態値は使われない）
  const knownKey = await c.env.DB.prepare(
    "SELECT 1 FROM idempotency_records WHERE actor_user_id = ? AND operation_code = ? AND idempotency_key = ?",
  ).bind(p.userId, LINK_OPERATION_CODE, headers["idempotency-key"]).first();

  // 1) 対象の出動と活動（別unit/存在しない対象は同じ404。存在を明かさない。行は消えないため再送でも読める）
  const incident = await c.env.DB.prepare(
    "SELECT i.id, i.unit_id, i.operation_id, i.activity_id, i.kind, i.status, i.version AS incident_version, " +
      "o.version AS operation_version FROM incidents i " +
      "JOIN operations o ON o.unit_id = i.unit_id AND o.id = i.operation_id WHERE i.id = ?",
  ).bind(params.id)
    .first<{
      id: string; unit_id: string; operation_id: string; activity_id: string | null;
      kind: string; status: string; incident_version: number; operation_version: number;
    }>();
  if (!incident || incident.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
  const activity = await resolveActivityForLink(c, p.unitId, body.activityId);

  // 2) 両rootのoperation版（docs/05 API-71「両rootロック」。クライアントは双方の現行版を送る。
  // キー不足は400。版の不一致はbatch内の比較更新で検出し409にする（早期の版検査はしない））
  const incidentOpVersion = body.operationVersions[incident.operation_id];
  const activityOpVersion = body.operationVersions[activity.operationId];
  if (incidentOpVersion === undefined || activityOpVersion === undefined) {
    const missing: { field: string; reason: string }[] = [];
    if (incidentOpVersion === undefined) missing.push({ field: `operationVersions.${incident.operation_id}`, reason: "required" });
    if (activityOpVersion === undefined) missing.push({ field: `operationVersions.${activity.operationId}`, reason: "required" });
    throw new HttpError("VALIDATION_ERROR", undefined, missing);
  }

  // 3) 編集権（docs/05 API-71「PER-04」。一般団員は本人分のみでリンクは本人分ではない）
  requirePermission(p, "PER-04", { unitId: p.unitId, type: "incident", id: params.id });

  if (!knownKey) {
    // voidedは終端（docs/11「voidedは閲覧のみ」。リンクも出動の変更なので不可）
    if (incident.status === "voided") {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "status", reason: "voided_is_terminal" }]);
    }
    // リンク済み出動の付け替えは非対応（docs/05・docs/11に根拠が無い。docs/04:103「上書きしない」）
    if (incident.activity_id !== null) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "activityId", reason: "relink_not_supported" }]);
    }
    // 一活動一出動（docs/04:94 activity_id UNIQUE、docs/04:103「既存の別リンクがある場合は409」）
    const dup = activityAlreadyLinked(activity);
    if (dup) throw dup;
  }

  // 4) 付け替える使用履歴の行数（監査の記録用。batch内で全行を生存operationへ付け替える）
  const movedUsages = knownKey
    ? 0
    : ((await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM resource_usages WHERE unit_id = ? AND operation_id = ?",
      ).bind(p.unitId, incident.operation_id).first<{ n: number }>())?.n ?? 0);

  // 5) 1つのbatchで両rootと双方のoperation版を比較更新でガードする（docs/05 API-71「両rootロック」。
  // executeMutationが各rootの「version=期待+1かつ今回の印付き」を検査し、どれか一つでも
  // 不一致なら409 VERSION_CONFLICTで全体を取り消す。途中の文は残らない）
  const roots: RootGuard[] = [
    { table: "incidents", id: params.id, expectedVersion: body.version, allowedStates: { column: "status", values: [incident.status] } },
    { table: "activities", id: body.activityId, expectedVersion: body.activityVersion },
    { table: "operations", id: activity.operationId, expectedVersion: activityOpVersion },
    { table: "operations", id: incident.operation_id, expectedVersion: incidentOpVersion },
  ];
  // 競合リンクの最終検査（書込前の状態で評価。読み取り後の先行リンクは409 DUPLICATE。
  // 失敗後の判定も取消後=書込前の状態で同じSQLを評価するため結果が一致する）
  const conditions: ExtraCondition[] = [activityNotLinkedCondition(p.unitId, body.activityId)];

  const spec: MutationSpec<ApiResponse<"API-71">> = {
    operationCode: LINK_OPERATION_CODE,
    key: headers["idempotency-key"],
    requestHash: await canonicalRequestHash({
      method: "PUT", path: `/incidents/${params.id}/activity`, baseVersion: body.version, body,
    }),
    expectedAuthzVersion: p.authzVersion,
    roots,
    conditions,
    statements: (ctx) => [
      // 旧出動側operationの非計数化（docs/04:103「旧operationを非計数化」。状態は出動側のまま、
      // 行は残るため履歴/監査参照は可能。集計から外れる＝docs/11 §3）
      c.env.DB.prepare(
        "UPDATE operations SET countable = 0, version = version + 1, last_mutation_token = ?, updated_at = ? " +
          "WHERE id = ? AND unit_id = ? AND version = ?",
      ).bind(ctx.attempt, ctx.now, incident.operation_id, p.unitId, incidentOpVersion),
      // 使用履歴の付け替え（docs/04:103「incidentと使用履歴を活動側operationへ付替」。
      // 対象・数量・時間・状態は据え置きで物理削除しない（docs/04:100）。行の版だけ進める）
      c.env.DB.prepare(
        "UPDATE resource_usages SET operation_id = ?, version = version + 1, last_mutation_token = ?, updated_at = ? " +
          "WHERE unit_id = ? AND operation_id = ?",
      ).bind(activity.operationId, ctx.attempt, ctx.now, p.unitId, incident.operation_id),
      // 活動rootのロック（内容は不変。docs/05 API-71「両rootロック」）
      c.env.DB.prepare(
        "UPDATE activities SET version = version + 1, last_mutation_token = ?, updated_at = ? " +
          "WHERE id = ? AND unit_id = ? AND version = ?",
      ).bind(ctx.attempt, ctx.now, body.activityId, p.unitId, body.activityVersion),
      // 生存operation（活動側）の版を増分（docs/04:100「operation版も増分」と同じ。出動と使用履歴が加わる）
      c.env.DB.prepare(
        "UPDATE operations SET version = version + 1, last_mutation_token = ?, updated_at = ? " +
          "WHERE id = ? AND unit_id = ? AND version = ?",
      ).bind(ctx.attempt, ctx.now, activity.operationId, p.unitId, activityOpVersion),
      // 出動root（docs/04:94「リンク時operation一致」）
      c.env.DB.prepare(
        "UPDATE incidents SET operation_id = ?, activity_id = ?, version = version + 1, last_mutation_token = ?, updated_at = ? " +
          "WHERE id = ? AND unit_id = ? AND version = ?",
      ).bind(activity.operationId, body.activityId, ctx.attempt, ctx.now, params.id, p.unitId, body.version),
      // 履歴（docs/04:95「種別訂正/操作元を保持」＋docs/04:103「旧ID/理由をイベントへ残す」。
      // issue_events/incident_eventsと同じオブジェクトJSON。概要の本文は複製しない）
      c.env.DB.prepare(
        "INSERT INTO incident_events (id, unit_id, incident_id, action, before_json, after_json, reason, actor_user_id, actor_kind, created_at) " +
          "VALUES (?, ?, ?, 'activity.link', ?, ?, ?, ?, 'human', ?)",
      ).bind(
        crypto.randomUUID(), p.unitId, params.id,
        JSON.stringify({ status: incident.status, kind: incident.kind, activityId: null, operationId: incident.operation_id }),
        JSON.stringify({
          status: incident.status, kind: incident.kind, activityId: body.activityId,
          operationId: activity.operationId, retiredOperationId: incident.operation_id,
        }),
        body.reason, p.userId, ctx.now,
      ),
      // 活動側の履歴（docs/04 activity_events。状態は不変で前=後。作成の初行と同じ流儀。理由はDBのCHECK ≤2000）
      c.env.DB.prepare(
        "INSERT INTO activity_events (id, unit_id, activity_id, previous_status, next_status, reason, actor_user_id, actor_kind, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 'human', ?)",
      ).bind(
        crypto.randomUUID(), p.unitId, body.activityId, activity.activityStatus, activity.activityStatus,
        body.reason, p.userId, ctx.now,
      ),
    ],
    audit: {
      action: "incident.activity.link", entityType: "incident", entityId: params.id,
      metadata: {
        activityId: body.activityId, operationId: activity.operationId,
        retiredOperationId: incident.operation_id, movedUsages,
      },
    },
    event: {
      entityType: "incident", entityId: params.id, entityVersion: body.version + 1,
      eventType: "incident.activity.linked",
      payload: { activityId: body.activityId, operationId: activity.operationId, retiredOperationId: incident.operation_id },
    },
    // 競合リンクのUNIQUE（unit_id, activity_id）だけを重複として答える（docs/02 §4。宣言外は500）
    duplicateOn: ["incidents.unit_id", "incidents.activity_id"],
    // 応答はbatch内のSQLが組み立てる（付け替え後のincident＋生存operation版＋使用履歴の全行ID）
    response: {
      status: 200, sql: LINK_RESULT_JSON,
      binds: [
        params.id,
        params.id, body.activityId, activity.operationId, incident.operation_id,
        activity.operationId, p.unitId, p.unitId, activity.operationId,
      ],
      decode: (j) => OperationLinkResult.parse(j),
    },
  };
  const result = await executeMutation(c.env, p, spec);
  return result.data;
}
