import { DocumentDecision } from "../../shared/contracts/content";
import { resolvePrincipal } from "../auth/principal";
import type { ApiRequest, ApiResponse } from "../../shared/contracts/registry";
import type { AppEnv } from "../env";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp, type ApiContext } from "../http";
import { enqueueJobStatement } from "../jobs/store";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation, type ExtraCondition } from "../mutations/execute";
import { requirePermission } from "./invitations";
import { loadDocument } from "./documents";

/**
 * 文書の申請・承認・差戻しAPI（T063、docs/05 API-75、docs/11 報告書/文書版、docs/04:148、CT-06と同じ分離）。
 *
 * **申請と最終決定の分離**（docs/11の核心。T058のreports流儀そのもの）:
 * - `request_review`（申請）は**content_version_eventsへの追記だけ**。決定行
 *   （review_decisions）は作らない＝最終決定を消費しない。draft→in_review。
 * - `changes_requested`（差戻し）も決定行は作らない（review_decisionsのdecision語彙は
 *   docs/04:145どおりapproved/approved_with_edit/rejectedで、差戻しを含まない）。
 *   in_review→changes_requested（docs/11 contentVersionTransitionsどおりの終端）へ遷め、eventsへ記録。
 *   差戻し後の訂正はAPI-74の新draft版（旧版はトリガーで不変）。
 * - `approve`（最終承認）だけがreview_decisionsへ **document_version_id非NULL UNIQUEで一版一回**
 *   の決定行を作る（uq_review_decision_document_version。二重approveは409 DUPLICATE）。
 *   in_review→approved、旧承認版はsupersededへ（eventsに記録）、documents.current_version_idを次版へ切替え、
 *   文書statusをapprovedへ進め（初回承認でdraft→approved。RAG対象になる）、**document.index jobを永続化**する
 *   （handlerはT066。T063はenqueueまで。dedupe_key=`${unitId}|document.index|${documentId}|${versionId}`）。
 *
 * 状態 precondition はbatchのconditionsで書込前に検査する（422）。ただし二重approveだけは
 * 409 DUPLICATEを返すため、conditionsの先頭で「決定行がまだ無いこと」を検査する
 * （rootのallowedStatesはdiagnoseでconditionsより先に評価されるため、approveでは使わない）。
 */

/** 決定理由の上限（review_decisions.reason／content_version_events.reasonのCHECKに揃える。超過は400） */
const REASON_MAX = 2000;

/** 決定の応答（batch末尾でSQLが組み立てる。approve時だけ決定行とindex jobが載る） */
const DECISION_RESPONSE_SQL =
  "SELECT json_object('documentId', ?, 'versionId', v.id, 'revisionNo', v.revision_no, 'status', v.status, 'decision', ?, 'reviewDecisionId', ?, " +
  "'indexJobId', (SELECT j.id FROM jobs j WHERE j.unit_id = v.unit_id AND j.kind = 'document.index' AND j.source_id = v.id ORDER BY j.created_at DESC LIMIT 1)) " +
  "FROM document_versions v WHERE v.id = ?";

interface DocumentDecisionVersionRow {
  id: string; unit_id: string; document_id: string; revision_no: number;
  license_ref: string; content_hash: string; status: string; version: number;
}

/**
 * API-75の登録点（ai-decisions.ts・report-decisions.tsと同じ登録点の形）。
 * 決定・events・一版一決定・index jobの本体はdecideDocumentVersionの文書を参照。
 */
export function registerDocumentDecisionRoutes(app: ApiApp): void {
  // --- API-75: 申請（request_review）／差戻し（changes_requested）／承認（approve）。200=同batchで確定 ---
  defineRoute(app, "API-75", async (c) => {
    const input = await parseApiRequest(c, "API-75");
    const data = await decideDocumentVersion(c, input);
    return ok(c, data);
  });
}

export async function decideDocumentVersion(ctx: ApiContext, input: ApiRequest<"API-75">): Promise<ApiResponse<"API-75">> {
  const p = await resolvePrincipal(ctx);
  const { params, body, headers } = input;
  const env: AppEnv = ctx.env;

  // 決定理由（reasonのDB CHECKは1〜2000。契約の共通上限より長い入力は400で弾く）
  if (body.reason.length > REASON_MAX) {
    throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "reason", reason: "too_long" }]);
  }

  // 権限を先に見る（docs/05 API-75「PER-10文書承認」。RULESのPER-10=幹部・管理者unitWide。
  // 非承認権限は存在を問わず403。文書の存在を明かさない。docs/10 §3）
  requirePermission(p, "PER-10", { unitId: p.unitId, type: "document", id: params.id });
  const doc = await loadDocument(ctx, params.id, p.unitId);

  // 対象の版（documentVersionはdocs/05 API-75の入力＝revision_no。該当が無いrevisionは404）
  const version = await env.DB.prepare(
    "SELECT id, unit_id, document_id, revision_no, license_ref, content_hash, status, version FROM document_versions " +
      "WHERE unit_id = ? AND document_id = ? AND revision_no = ?",
  ).bind(p.unitId, doc.id, body.documentVersion).first<DocumentDecisionVersionRow>();
  if (!version) throw new HttpError("NOT_FOUND");

  // 文書rootの版（全決定共通。rootへの並行変更〔版作成・ACL変更・撤回等〕があったら409。
  // rootはapproveでだけ更新するため、request_review/changes_requestedではconditionsで検査する）
  const rootVersionCondition: ExtraCondition = {
    existsSql: "SELECT 1 FROM documents WHERE id = ? AND unit_id = ? AND version = ?",
    binds: [doc.id, p.unitId, body.version],
    failCode: "VERSION_CONFLICT",
  };

  if (body.decision === "request_review") {
    // --- 申請: draft→in_review。eventsへの追記だけ（決定行は作らない＝docs/11の核心） ---
    const result = await executeMutation(env, p, {
      operationCode: "document.decision.submit",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/documents/${params.id}/decision`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{
        table: "document_versions", id: version.id, expectedVersion: version.version,
        allowedStates: { column: "status", values: ["draft"] },
      }],
      conditions: [
        { existsSql: "SELECT 1 FROM document_versions WHERE id = ? AND unit_id = ? AND status = 'draft'", binds: [version.id, p.unitId], failCode: "INVALID_TRANSITION" },
        rootVersionCondition,
      ],
      statements: (mutationCtx) => [
        env.DB.prepare(
          "UPDATE document_versions SET status = 'in_review', version = version + 1, last_mutation_token = ?, updated_at = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ? AND status = 'draft'",
        ).bind(mutationCtx.attempt, mutationCtx.now, version.id, p.unitId, version.version),
        env.DB.prepare(
          "INSERT INTO content_version_events (id, unit_id, report_version_id, document_version_id, action, reason, actor_user_id, actor_kind, created_at) " +
            "VALUES (?, ?, NULL, ?, 'request_review', ?, ?, 'human', ?)",
        ).bind(crypto.randomUUID(), p.unitId, version.id, body.reason, p.userId, mutationCtx.now),
      ],
      audit: {
        action: "document.request_review", entityType: "document", entityId: doc.id,
        metadata: { decision: "request_review", revisionNo: body.documentVersion },
      },
      event: {
        entityType: "document", entityId: doc.id, entityVersion: body.version,
        eventType: "document_version.submitted", payload: { revisionNo: body.documentVersion, decision: "request_review" },
      },
      response: { status: 200, sql: DECISION_RESPONSE_SQL, binds: [doc.id, "request_review", null, version.id], decode: (j) => DocumentDecision.parse(j) },
    });
    return result.data;
  }

  if (body.decision === "changes_requested") {
    // --- 差戻し: in_review→changes_requested（docs/11 contentVersionTransitionsの終端）。
    // 決定行は作らない（decision語彙に差戻しは無い。docs/04:145）。訂正はAPI-74の新draft版 ---
    const result = await executeMutation(env, p, {
      operationCode: "document.decision.changes_requested",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/documents/${params.id}/decision`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [{
        table: "document_versions", id: version.id, expectedVersion: version.version,
        allowedStates: { column: "status", values: ["in_review"] },
      }],
      conditions: [
        { existsSql: "SELECT 1 FROM document_versions WHERE id = ? AND unit_id = ? AND status = 'in_review'", binds: [version.id, p.unitId], failCode: "INVALID_TRANSITION" },
        rootVersionCondition,
      ],
      statements: (mutationCtx) => [
        env.DB.prepare(
          "UPDATE document_versions SET status = 'changes_requested', version = version + 1, last_mutation_token = ?, updated_at = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ? AND status = 'in_review'",
        ).bind(mutationCtx.attempt, mutationCtx.now, version.id, p.unitId, version.version),
        env.DB.prepare(
          "INSERT INTO content_version_events (id, unit_id, report_version_id, document_version_id, action, reason, actor_user_id, actor_kind, created_at) " +
            "VALUES (?, ?, NULL, ?, 'changes_requested', ?, ?, 'human', ?)",
        ).bind(crypto.randomUUID(), p.unitId, version.id, body.reason, p.userId, mutationCtx.now),
      ],
      audit: {
        action: "document.changes_requested", entityType: "document", entityId: doc.id,
        metadata: { decision: "changes_requested", revisionNo: body.documentVersion },
      },
      event: {
        entityType: "document", entityId: doc.id, entityVersion: body.version,
        eventType: "document_version.changes_requested", payload: { revisionNo: body.documentVersion, decision: "changes_requested" },
      },
      response: { status: 200, sql: DECISION_RESPONSE_SQL, binds: [doc.id, "changes_requested", null, version.id], decode: (j) => DocumentDecision.parse(j) },
    });
    return result.data;
  }

  // --- approve（最終承認）: 申請・差戻しと違い、一版一回の決定行を作る ---
  const decisionId = crypto.randomUUID();
  const oldApprovedId = doc.current_version_id;
  const supersedes = oldApprovedId !== null && oldApprovedId !== version.id;
  const supersededEventId = supersedes ? crypto.randomUUID() : null;
  // 索引job（T066のhandlerが実行する。T063ではqueuedのまま滞在するだけでよい）。
  // 業務の確定（承認）と同じbatchで登録し、確定後にQueueへ起動の合図を送る
  const indexJob = enqueueJobStatement(env, {
    unitId: p.unitId,
    kind: "document.index",
    sourceType: "document_version",
    sourceId: version.id,
    sourceVersion: version.revision_no,
    configVersion: "v1",
    requestedBy: p.userId,
    dedupeKey: `${p.unitId}|document.index|${doc.id}|${version.id}`,
  });

  const result = await executeMutation(env, p, {
    operationCode: "document.decision.approve",
    key: headers["idempotency-key"],
    requestHash: await canonicalRequestHash({ method: "POST", path: `/documents/${params.id}/decision`, baseVersion: body.version, body }),
    expectedAuthzVersion: p.authzVersion,
    // 版行と文書rootの比較更新（0行更新を成功扱いにしない）。allowedStatesは使わない
    // （diagnoseがconditionsより先にrootを評価するため、二重approveを409 DUPLICATEにする）
    roots: [
      { table: "document_versions", id: version.id, expectedVersion: version.version },
      { table: "documents", id: doc.id, expectedVersion: body.version },
    ],
    created: [{ table: "review_decisions", id: decisionId }],
    // 一版一決定（docs/04:145「各対象非NULL UNIQUE」。二重approveは409）
    duplicateOn: ["index:uq_review_decision_document_version"],
    conditions: [
      // 先頭で決定行の不在を検査（二重approveは状態検査より先に409。docs/11「審査の最終決定は一版一回」）
      { existsSql: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM review_decisions WHERE unit_id = ? AND document_version_id = ?)", binds: [p.unitId, version.id], failCode: "DUPLICATE" },
      { existsSql: "SELECT 1 FROM document_versions WHERE id = ? AND unit_id = ? AND status = 'in_review'", binds: [version.id, p.unitId], failCode: "INVALID_TRANSITION" },
      // 撤回済みの文書は承認できない（withdrawnは終端）
      { existsSql: "SELECT 1 FROM documents WHERE id = ? AND unit_id = ? AND status IN ('draft', 'approved')", binds: [doc.id, p.unitId], failCode: "INVALID_TRANSITION" },
      rootVersionCondition,
    ],
    statements: (mutationCtx) => [
      // 対象版をapprovedへ（approved_by/approved_atはapprovedだけが持つCHECK。以降はトリガーで承認列不変）
      env.DB.prepare(
        "UPDATE document_versions SET status = 'approved', approved_by = ?, approved_at = ?, version = version + 1, last_mutation_token = ?, updated_at = ? " +
          "WHERE id = ? AND unit_id = ? AND version = ? AND status = 'in_review'",
      ).bind(p.memberId, mutationCtx.now, mutationCtx.attempt, mutationCtx.now, version.id, p.unitId, version.version),
      // 旧承認版はsupersededへ（docs/11 approved→superseded。status遷移だけ許され、承認列は不変のまま）
      ...(supersedes ? [
        env.DB.prepare(
          "UPDATE document_versions SET status = 'superseded', version = version + 1, last_mutation_token = ?, updated_at = ? " +
            "WHERE id = ? AND unit_id = ? AND status = 'approved'",
        ).bind(mutationCtx.attempt, mutationCtx.now, oldApprovedId!, p.unitId),
      ] : []),
      // 承認済pointerは次版承認まで保持→ここで次版へ切替。初回承認で文書statusもapprovedへ（RAG対象。docs/11）
      env.DB.prepare(
        "UPDATE documents SET current_version_id = ?, status = 'approved', version = version + 1, last_mutation_token = ?, updated_at = ? " +
          "WHERE id = ? AND unit_id = ? AND version = ?",
      ).bind(version.id, mutationCtx.attempt, mutationCtx.now, doc.id, p.unitId, body.version),
      // 最終決定1行（対象ちょうど一つ＝document_version_idのみ。承認はeffect操作を伴わないためNULL）。
      // confirmed_payloadに承認時に確定した版の内容証跡（許諾・原本hash）を固定する（元版の後続変更で書変わらない）
      env.DB.prepare(
        "INSERT INTO review_decisions (id, unit_id, evaluation_id, report_version_id, document_version_id, decision, confirmed_payload, reviewer_member_id, reviewed_at, reason, effect_operation_id, version, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
          "VALUES (?, ?, NULL, NULL, ?, 'approved', ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, 'human')",
      ).bind(
        decisionId, p.unitId, version.id,
        JSON.stringify({ revisionNo: version.revision_no, licenseRef: version.license_ref, contentHash: version.content_hash }),
        p.memberId, mutationCtx.now, body.reason, mutationCtx.attempt, mutationCtx.now, mutationCtx.now, p.userId,
      ),
      // 承認のevents
      env.DB.prepare(
        "INSERT INTO content_version_events (id, unit_id, report_version_id, document_version_id, action, reason, actor_user_id, actor_kind, created_at) " +
          "VALUES (?, ?, NULL, ?, 'approved', ?, ?, 'human', ?)",
      ).bind(crypto.randomUUID(), p.unitId, version.id, body.reason, p.userId, mutationCtx.now),
      ...(supersededEventId ? [
        env.DB.prepare(
          "INSERT INTO content_version_events (id, unit_id, report_version_id, document_version_id, action, reason, actor_user_id, actor_kind, created_at) " +
            "VALUES (?, ?, NULL, ?, 'superseded', ?, ?, 'human', ?)",
        ).bind(supersededEventId, p.unitId, oldApprovedId!, body.reason, p.userId, mutationCtx.now),
      ] : []),
      indexJob.statement,
    ],
    audit: {
      action: "document.approve", entityType: "document", entityId: doc.id,
      metadata: { decision: "approve", revisionNo: body.documentVersion, reviewDecisionId: decisionId, supersedes: supersedes ? oldApprovedId! : "none" },
    },
    event: {
      entityType: "document", entityId: doc.id, entityVersion: body.version + 1,
      eventType: "document_version.approved", payload: { revisionNo: body.documentVersion, decision: "approve" },
    },
    response: { status: 200, sql: DECISION_RESPONSE_SQL, binds: [doc.id, "approve", decisionId, version.id], decode: (j) => DocumentDecision.parse(j) },
  });
  // 起動の合図（正本はD1。Cronも回収するので送信失敗は握りつぶす）
  try {
    await env.JOBS_QUEUE.send({ jobId: indexJob.id });
  } catch (err) {
    console.error(JSON.stringify({ event: "job_queue_send_failed", jobId: indexJob.id, error: String(err) }));
  }
  return result.data;
}
