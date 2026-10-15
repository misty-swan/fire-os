import { jstDateTime } from "../ai/llm";
import { resolvePrincipal } from "../auth/principal";
import type { ApiRequest, ApiResponse } from "../../shared/contracts/registry";
import type { AppEnv } from "../env";
import { HttpError, type ApiContext } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation, type ExtraCondition, type MutationSpec } from "../mutations/execute";
import { requirePermission } from "../routes/invitations";

/**
 * 報告書の申請・承認・差戻し（T058、docs/05 API-60、docs/11 報告書/文書版、docs/04:145/148、CT-06）。
 *
 * **申請と最終決定の分離**（docs/11の核心）:
 * - `request_review`（申請）は**content_version_eventsへの追記だけ**。決定行
 *   （review_decisions）は作らない＝最終決定を消費しない。draft→in_review。
 * - `changes_requested`（差戻し）も決定行は作らない（review_decisionsのdecision語彙は
 *   docs/04:145どおりapproved/approved_with_edit/rejectedで、差戻しを含まない）。
 *   in_review→changes_requested、eventsへ記録。差戻し後の訂正はAPI-59の新draft版（旧版不変）。
 * - `approve`（最終承認）だけがreview_decisionsへ **report_version_id非NULL UNIQUEで一版一回**
 *   の決定行を作る（uq_review_decision_report_version。二重approveは409 DUPLICATE）。
 *   in_review→approved、旧承認版はsupersededへ（eventsに記録）し、承認済pointerは次版承認まで保持。
 * - **承認時は元実績版を再検査**（docs/11「引用元/実績版一致」）: 入力のsourceVersionsが版の
 *   保存値（source_versions）と一致しなければ409、保存値と現行の実績・活動の版が一致しなければ409
 *   （batchのconditionsで再検査。承認の途中の元実績変更も取込み直さない）。
 * - 承認では出力欄の数値（活動名・参加人数・実施日時）を**サーバーが計算してconfirmed_payloadへ
 *   固定**する（docs/16 T058。出力の原本。元実績の後続変更で承認済み出力が変わらない）。
 *
 * 状態 precondition はbatchのconditionsで書込前に検査する（422）。ただし二重approveだけは
 * 409 DUPLICATEを返すため、conditionsの先頭で「決定行がまだ無いこと」を検査する
 * （rootのallowedStatesはdiagnoseでconditionsより先に評価されるため、approveでは使わない）。
 */

/** 決定理由の上限（review_decisions.reason／content_version_events.reasonのCHECKに揃える。超過は400） */
const REASON_MAX = 2000;

interface ReportRow {
  id: string; unit_id: string; activity_id: string;
  current_draft_version_id: string | null; current_approved_version_id: string | null;
  version: number; created_by: string | null; owner_member_id: string;
}
interface VersionRow {
  id: string; unit_id: string; report_id: string; template_version: string; revision_no: number;
  source_versions: string; status: string; version: number;
}

/** 出力欄の確定値（承認時にconfirmed_payloadへ固定する表示値。数値はサーバー計算） */
interface RenderFields {
  activityTitle: string;
  participantCount: string;
  actualPeriod: string;
}

/** 源の現行状態（承認時の計算と版の条件検査に使う） */
async function loadSourceState(
  env: AppEnv, unitId: string, activityId: string,
): Promise<{ activityVersion: number; resultVersion: number; resultRevisionNo: number; fields: RenderFields }> {
  const activity = await env.DB.prepare("SELECT title, version FROM activities WHERE id = ? AND unit_id = ?")
    .bind(activityId, unitId).first<{ title: string; version: number }>();
  if (!activity) throw new HttpError("NOT_FOUND");
  const result = await env.DB.prepare("SELECT id, version, current_revision_id FROM activity_results WHERE unit_id = ? AND activity_id = ?")
    .bind(unitId, activityId).first<{ id: string; version: number; current_revision_id: string | null }>();
  if (!result?.current_revision_id) {
    throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "resultVersion", reason: "result_not_found" }]);
  }
  const revision = await env.DB.prepare(
    "SELECT revision_no, actual_starts_at, actual_ends_at FROM activity_result_revisions WHERE id = ? AND unit_id = ?",
  ).bind(result.current_revision_id, unitId).first<{ revision_no: number; actual_starts_at: string | null; actual_ends_at: string | null }>();
  if (!revision) throw new HttpError("INTERNAL_ERROR"); // pointerは同親の版のみを指す（activity-resultsと同じ前提）

  // 参加人数は実参加（participated）行数。行が無い＝未記載（0名と区別しない。T057のサーバー集計と同じ）
  const participated = (await env.DB.prepare(
    "SELECT count(*) AS n FROM activity_actual_participants WHERE result_revision_id = ? AND unit_id = ? AND actual_status = 'participated'",
  ).bind(result.current_revision_id, unitId).first<{ n: number }>())!.n;

  const startJst = revision.actual_starts_at === null ? null : jstDateTime(revision.actual_starts_at);
  const endJst = revision.actual_ends_at === null ? null : jstDateTime(revision.actual_ends_at);
  return {
    activityVersion: activity.version,
    resultVersion: result.version,
    resultRevisionNo: revision.revision_no,
    fields: {
      activityTitle: activity.title,
      participantCount: participated > 0 ? String(participated) : "未記載",
      actualPeriod: `${startJst ?? "未記載"}〜${endJst ?? "未記載"}`,
    },
  };
}

/** 入力sourceVersionsは版の保存値と完全一致（approverが確認した版の前提。別内容は409） */
function assertSourceVersionsMatchSaved(input: Record<string, number>, saved: Record<string, number>): void {
  const keys = new Set([...Object.keys(input), ...Object.keys(saved)]);
  for (const key of keys) {
    if (input[key] !== saved[key]) {
      throw new HttpError("VERSION_CONFLICT", undefined, [{ field: "sourceVersions", reason: "source_versions_mismatch" }]);
    }
  }
}

/** 承認済pointerの切替と監査・eventsを含む応答（batch末尾でSQLが組み立てる） */
const DECISION_RESPONSE_SQL =
  "SELECT json_object('reportId', ?, 'versionId', v.id, 'revisionNo', v.revision_no, 'status', v.status, 'decision', ?, 'reviewDecisionId', ?) " +
  "FROM report_versions v WHERE v.id = ?";

export async function decideReportVersion(ctx: ApiContext, input: ApiRequest<"API-60">): Promise<ApiResponse<"API-60">> {
  const p = await resolvePrincipal(ctx);
  const { params, body, headers } = input;
  const env = ctx.env;

  // 決定理由（reasonのDB CHECKは1〜2000。契約の共通上限より長い入力は400で弾く）
  if (body.reason.length > REASON_MAX) {
    throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "reason", reason: "too_long" }]);
  }

  // 対象の帳票（実在・同unit。docs/10 §3「対象外IDは404」）
  const report = await env.DB.prepare(
    "SELECT r.*, a.owner_member_id FROM reports r JOIN activities a ON a.unit_id = r.unit_id AND a.id = r.activity_id WHERE r.id = ?",
  ).bind(params.id).first<ReportRow>();
  if (!report || report.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
  requirePermission(p, "PER-10", { unitId: p.unitId, type: "report", id: params.id });

  // 対象の版（reportVersionはdocs/05 API-60の入力＝revision_no。該当が無いrevisionは404）
  const version = await env.DB.prepare(
    "SELECT id, unit_id, report_id, template_version, revision_no, source_versions, status, version FROM report_versions " +
      "WHERE unit_id = ? AND report_id = ? AND revision_no = ?",
  ).bind(p.unitId, report.id, body.reportVersion).first<VersionRow>();
  if (!version) throw new HttpError("NOT_FOUND");

  // 帳票rootの版（全決定共通。rootへの並行改稿〔新draft作成等〕があったら409。rootはapproveでのみ更新するため
  // request_review/changes_requestedではconditionsで検査する）
  const rootVersionCondition: ExtraCondition = {
    existsSql: "SELECT 1 FROM reports WHERE id = ? AND unit_id = ? AND version = ?",
    binds: [report.id, p.unitId, body.version],
    failCode: "VERSION_CONFLICT",
  };

  if (body.decision === "request_review") {
    // --- 申請: draft→in_review。eventsへの追記だけ（決定行は作らない＝docs/11の核心） ---
    const result = await executeMutation(env, p, {
      operationCode: "report.decision.submit",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/reports/${params.id}/decision`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{
        table: "report_versions", id: version.id, expectedVersion: version.version,
        allowedStates: { column: "status", values: ["draft"] },
      }],
      conditions: [
        { existsSql: "SELECT 1 FROM report_versions WHERE id = ? AND unit_id = ? AND status = 'draft'", binds: [version.id, p.unitId], failCode: "INVALID_TRANSITION" },
        rootVersionCondition,
      ],
      statements: (mutationCtx) => [
        env.DB.prepare(
          "UPDATE report_versions SET status = 'in_review', version = version + 1, last_mutation_token = ?, updated_at = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ? AND status = 'draft'",
        ).bind(mutationCtx.attempt, mutationCtx.now, version.id, p.unitId, version.version),
        env.DB.prepare(
          "INSERT INTO content_version_events (id, unit_id, report_version_id, document_version_id, action, reason, actor_user_id, actor_kind, created_at) " +
            "VALUES (?, ?, ?, NULL, 'request_review', ?, ?, 'human', ?)",
        ).bind(crypto.randomUUID(), p.unitId, version.id, body.reason, p.userId, mutationCtx.now),
      ],
      audit: {
        action: "report.request_review", entityType: "report", entityId: report.id,
        metadata: { decision: "request_review", reportVersion: body.reportVersion },
      },
      event: {
        entityType: "report", entityId: report.id, entityVersion: body.version,
        eventType: "report_version.submitted", payload: { revisionNo: body.reportVersion, decision: "request_review" },
      },
      response: { status: 200, sql: DECISION_RESPONSE_SQL, binds: [report.id, "request_review", null, version.id], decode: (j) => j as ApiResponse<"API-60"> },
    });
    return result.data;
  }

  if (body.decision === "changes_requested") {
    // --- 差戻し: in_review→changes_requested。決定行は作らない（decision語彙に差戻しは無い。docs/04:145） ---
    const result = await executeMutation(env, p, {
      operationCode: "report.decision.changes_requested",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/reports/${params.id}/decision`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{
        table: "report_versions", id: version.id, expectedVersion: version.version,
        allowedStates: { column: "status", values: ["in_review"] },
      }],
      conditions: [
        { existsSql: "SELECT 1 FROM report_versions WHERE id = ? AND unit_id = ? AND status = 'in_review'", binds: [version.id, p.unitId], failCode: "INVALID_TRANSITION" },
        rootVersionCondition,
      ],
      statements: (mutationCtx) => [
        env.DB.prepare(
          "UPDATE report_versions SET status = 'changes_requested', version = version + 1, last_mutation_token = ?, updated_at = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ? AND status = 'in_review'",
        ).bind(mutationCtx.attempt, mutationCtx.now, version.id, p.unitId, version.version),
        env.DB.prepare(
          "INSERT INTO content_version_events (id, unit_id, report_version_id, document_version_id, action, reason, actor_user_id, actor_kind, created_at) " +
            "VALUES (?, ?, ?, NULL, 'changes_requested', ?, ?, 'human', ?)",
        ).bind(crypto.randomUUID(), p.unitId, version.id, body.reason, p.userId, mutationCtx.now),
      ],
      audit: {
        action: "report.changes_requested", entityType: "report", entityId: report.id,
        metadata: { decision: "changes_requested", reportVersion: body.reportVersion },
      },
      event: {
        entityType: "report", entityId: report.id, entityVersion: body.version,
        eventType: "report_version.changes_requested", payload: { revisionNo: body.reportVersion, decision: "changes_requested" },
      },
      response: { status: 200, sql: DECISION_RESPONSE_SQL, binds: [report.id, "changes_requested", null, version.id], decode: (j) => j as ApiResponse<"API-60"> },
    });
    return result.data;
  }

  // --- approve（最終承認）: 申請・差戻しと違い、一版一回の決定行を作る ---
  const savedSourceVersions = JSON.parse(version.source_versions) as Record<string, number>;
  // ①入力は版の保存値と一致（approverが確認した版の前提。別内容の承認は409）
  assertSourceVersionsMatchSaved(body.sourceVersions, savedSourceVersions);
  // ②元実績の現行版（サーバー計算値の確定にも使う。版がずれていたら下のconditionsで409）
  const source = await loadSourceState(env, p.unitId, report.activity_id);
  if (source.resultVersion !== savedSourceVersions.resultVersion || source.resultRevisionNo !== savedSourceVersions.resultRevisionNo ||
    source.activityVersion !== savedSourceVersions.activityVersion) {
    // 事前検査（分かりやすいdetails）。同じ検査をbatch内のconditionsでも行う（承認中の変更を取込まない）
    throw new HttpError("VERSION_CONFLICT", undefined, [{ field: "sourceVersions", reason: "source_changed" }]);
  }

  // 作成者の団員ID（承認者欄の出力のためconfirmed_payloadへ固定。未リンクならNULL）
  const creator = report.created_by
    ? await env.DB.prepare("SELECT id FROM members WHERE unit_id = ? AND user_id = ?").bind(p.unitId, report.created_by)
        .first<{ id: string }>()
    : null;

  const decisionId = crypto.randomUUID();
  const approvedEventId = crypto.randomUUID();
  const oldApprovedId = report.current_approved_version_id;
  const supersedes = oldApprovedId !== null && oldApprovedId !== version.id;
  const supersededEventId = supersedes ? crypto.randomUUID() : null;

  const confirmedPayload = JSON.stringify({
    templateVersion: version.template_version,
    revisionNo: version.revision_no,
    computed: source.fields,
    creatorMemberId: creator?.id ?? null,
    approverMemberId: p.memberId,
  });

  const spec: MutationSpec<ApiResponse<"API-60">> = {
    operationCode: "report.decision.approve",
    key: headers["idempotency-key"],
    requestHash: await canonicalRequestHash({ method: "POST", path: `/reports/${params.id}/decision`, baseVersion: body.version, body }),
    expectedAuthzVersion: p.authzVersion,
    // 版行と帳票rootの比較更新（0行更新を成功扱いにしない）。allowedStatesは使わない
    // （diagnoseがconditionsより先にrootを評価するため、二重approveを409 DUPLICATEにする）
    roots: [
      { table: "report_versions", id: version.id, expectedVersion: version.version },
      { table: "reports", id: report.id, expectedVersion: body.version },
    ],
    created: [{ table: "review_decisions", id: decisionId }],
    // 一版一決定（docs/04:145「各対象非NULL UNIQUE」。二重approveは409）
    duplicateOn: ["index:uq_review_decision_report_version"],
    conditions: [
      // 先頭で決定行の不在を検査（二重approveは状態検査より先に409。docs/11「審査の最終決定は一版一回」）
      { existsSql: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM review_decisions WHERE unit_id = ? AND report_version_id = ?)", binds: [p.unitId, version.id], failCode: "DUPLICATE" },
      { existsSql: "SELECT 1 FROM report_versions WHERE id = ? AND unit_id = ? AND status = 'in_review'", binds: [version.id, p.unitId], failCode: "INVALID_TRANSITION" },
      rootVersionCondition,
      // 元実績版の再検査（docs/11「引用元/実績版一致」。承認の途中の変更も409）
      { existsSql: "SELECT 1 FROM activities WHERE id = ? AND unit_id = ? AND version = ?", binds: [report.activity_id, p.unitId, savedSourceVersions.activityVersion], failCode: "VERSION_CONFLICT" },
      {
        existsSql:
          "SELECT 1 FROM activity_results r JOIN activity_result_revisions v ON v.id = r.current_revision_id " +
          "WHERE r.unit_id = ? AND r.activity_id = ? AND r.version = ? AND v.revision_no = ?",
        binds: [p.unitId, report.activity_id, savedSourceVersions.resultVersion, savedSourceVersions.resultRevisionNo],
        failCode: "VERSION_CONFLICT",
      },
    ],
    statements: (mutationCtx) => [
      // 対象版をapprovedへ（approved_by/approved_atはapprovedだけが持つCHECK。以降はトリガーで承認列不変）
      env.DB.prepare(
        "UPDATE report_versions SET status = 'approved', approved_by = ?, approved_at = ?, version = version + 1, last_mutation_token = ?, updated_at = ? " +
          "WHERE id = ? AND unit_id = ? AND version = ? AND status = 'in_review'",
      ).bind(p.memberId, mutationCtx.now, mutationCtx.attempt, mutationCtx.now, version.id, p.unitId, version.version),
      // 旧承認版はsupersededへ（docs/11 approved→superseded。status遷移だけ許され、承認列は不変のまま）
      ...(supersedes ? [
        env.DB.prepare(
          "UPDATE report_versions SET status = 'superseded', version = version + 1, last_mutation_token = ?, updated_at = ? " +
            "WHERE id = ? AND unit_id = ? AND status = 'approved'",
        ).bind(mutationCtx.attempt, mutationCtx.now, oldApprovedId!, p.unitId),
      ] : []),
      // 承認済pointerは次版承認まで保持→ここで次版へ切替（docs/11）
      env.DB.prepare(
        "UPDATE reports SET current_approved_version_id = ?, version = version + 1, last_mutation_token = ?, updated_at = ? " +
          "WHERE id = ? AND unit_id = ? AND version = ?",
      ).bind(version.id, mutationCtx.attempt, mutationCtx.now, report.id, p.unitId, body.version),
      // 最終決定1行（対象ちょうど一つ＝report_version_idのみ。承認はeffect操作を伴わないためNULL）
      env.DB.prepare(
        "INSERT INTO review_decisions (id, unit_id, evaluation_id, report_version_id, document_version_id, decision, confirmed_payload, reviewer_member_id, reviewed_at, reason, effect_operation_id, version, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
          "VALUES (?, ?, NULL, ?, NULL, 'approved', ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, 'human')",
      ).bind(decisionId, p.unitId, version.id, confirmedPayload, p.memberId, mutationCtx.now, body.reason, mutationCtx.attempt, mutationCtx.now, mutationCtx.now, p.userId),
      // 承認のevents
      env.DB.prepare(
        "INSERT INTO content_version_events (id, unit_id, report_version_id, document_version_id, action, reason, actor_user_id, actor_kind, created_at) " +
          "VALUES (?, ?, ?, NULL, 'approved', ?, ?, 'human', ?)",
      ).bind(approvedEventId, p.unitId, version.id, body.reason, p.userId, mutationCtx.now),
      ...(supersededEventId ? [
        env.DB.prepare(
          "INSERT INTO content_version_events (id, unit_id, report_version_id, document_version_id, action, reason, actor_user_id, actor_kind, created_at) " +
            "VALUES (?, ?, ?, NULL, 'superseded', ?, ?, 'human', ?)",
        ).bind(supersededEventId, p.unitId, oldApprovedId!, body.reason, p.userId, mutationCtx.now),
      ] : []),
    ],
    audit: {
      action: "report.approve", entityType: "report", entityId: report.id,
      metadata: { decision: "approve", reportVersion: body.reportVersion, reviewDecisionId: decisionId },
    },
    event: {
      entityType: "report", entityId: report.id, entityVersion: body.version + 1,
      eventType: "report_version.approved", payload: { revisionNo: body.reportVersion, decision: "approve" },
    },
    response: { status: 200, sql: DECISION_RESPONSE_SQL, binds: [report.id, "approve", decisionId, version.id], decode: (j) => j as ApiResponse<"API-60"> },
  };
  const result = await executeMutation(env, p, spec);
  return result.data;
}
