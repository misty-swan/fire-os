import { DocumentAccessPolicy, DocumentWithdrawal } from "../../shared/contracts/content";
import { resolvePrincipal } from "../auth/principal";
import type { AppEnv } from "../env";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { enqueueJobStatement } from "../jobs/store";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { loadDocument, requireAclTargets, requireDocumentManage } from "./documents";

/**
 * 文書の撤回（API-92）とACL・分類の変更（API-99）（T063、docs/05、docs/04:149/151、docs/06 §5、docs/10 §2/§4）。
 *
 * - **撤回（API-92）**は終端（docs/11 documentStates。二重撤回は422）。文書status→withdrawn＋
 *   content_version_events（action='withdrawn'）＋**document.deindex jobの永続化**。
 *   索引の削除（T066のhandler）を待たず、D1の可視性判定で即除外される（docs/06 §5.5「D1側で即除外」）。
 *   撤回後は一覧・詳細・原文・版の全GETが404（存在も明かさない）。
 * - **ACL変更（API-99）**はACLの全置換（deny優先のまま）＋classification変更＋policy_version増分＋
 *   **document.reindex jobの永続化**。可視範囲を緩和する方向（ACL集合の拡大）の変更も、
 *   管理権限（PER-11＋幹部・管理者）のPATCH操作自体を承認とみなし、**必ずreindex jobを作って**
 *   緩和/引上げの向きを監査metadataに記録する（docs/16 T063の裁定。D03未承認の検証設定）。
 * - 版status（document_versions.status）の遷移はこの2APIでは行わない（承認API-75だけが行う）。
 *   この2APIが動かすのは文書rootのstatus（documents.status）とpolicy_version。
 * - すべてexecuteMutation（版・冪等・監査・outbox同batch）。jobの起動合図はAPI-74と同じtry/catch。
 */

/** 撤回・ACL変更の理由の上限（content_version_events.reasonのCHECKに揃える。超過は400） */
const REASON_MAX = 2000;

interface DocumentVersionPointerRow {
  id: string; revision_no: number;
}

/** 文書rootと、対象versionのjobを1行に組み立てる応答（jobKeyはAPI-92=deindexJob／API-99=reindexJob）。
 *  jobのサブクエリはjson()で包む（スカラーサブクエリはJSON subtypeが落ちてtextになる環境がある。D1実測） */
const documentWithJobSql = (kind: string, jobKey: string) =>
  "SELECT json_object(" +
  "'document', json_object('id', d.id, 'version', d.version, 'title', d.title, 'classification', d.classification, 'status', d.status, " +
  "'currentVersionId', d.current_version_id, 'currentDraftVersionId', d.current_draft_version_id, 'policyVersion', d.policy_version, " +
  "'createdAt', d.created_at, 'updatedAt', d.updated_at), " +
  `'${jobKey}', json((SELECT json_object('id', j.id, 'status', j.status, 'attempts', j.attempts, 'errorCode', j.error_code, 'resultRef', j.result_ref) ` +
  "FROM jobs j WHERE j.unit_id = d.unit_id AND j.kind = '" + kind + "' AND j.source_id = ? ORDER BY j.created_at DESC LIMIT 1))) " +
  "FROM documents d WHERE d.id = ?";

/**
 * 可視範囲の向き（docs/16 T063の裁定）。
 * - relaxed: allow増（旧・新のどのdenyも無い対象）またはdeny外し（新ACLでallowを持つ対象）
 * - tightened: allow減（外れた対象に新denyも無い＝ACL一致無しで非公開へ）またはdeny増
 * - classification（自由記述の短い語。docs/04:149）には公開度の順序が無いため向きの判定はACLだけで行い、
 *   変更の有無だけを監査に記録する
 */
type AclRow = { member_id: string | null; role_id: string | null; effect: string };

function policyDirection(oldAcl: readonly AclRow[], newAcl: readonly AclRow[]): "relaxed" | "tightened" | "mixed" | "unchanged" {
  const key = (r: AclRow) => (r.member_id ? `m:${r.member_id}` : `r:${r.role_id}`);
  const allow = (rows: readonly AclRow[]) => new Set(rows.filter((r) => r.effect === "allow").map(key));
  const deny = (rows: readonly AclRow[]) => new Set(rows.filter((r) => r.effect === "deny").map(key));
  const oldAllow = allow(oldAcl), oldDeny = deny(oldAcl), newAllow = allow(newAcl), newDeny = deny(newAcl);
  const relaxed =
    [...newAllow].some((s) => !oldAllow.has(s) && !oldDeny.has(s) && !newDeny.has(s)) ||
    [...oldDeny].some((s) => !newDeny.has(s) && newAllow.has(s));
  const tightened =
    [...oldAllow].some((s) => !newAllow.has(s) && !newDeny.has(s)) ||
    [...newDeny].some((s) => !oldDeny.has(s));
  if (relaxed && tightened) return "mixed";
  return relaxed ? "relaxed" : tightened ? "tightened" : "unchanged";
}

export function registerDocumentPolicyRoutes(app: ApiApp): void {
  // --- API-92: 撤回（終端。docs/05 API-92「version,reason;即時検索除外/旧引用失効」） ---
  defineRoute(app, "API-92", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-92");
    // 管理権限を先に見る（非管理者は存在を問わず403。docs/10 §3）
    requireDocumentManage(p);
    if (body.reason.length > REASON_MAX) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "reason", reason: "too_long" }]);
    }
    const doc = await loadDocument(c, params.id, p.unitId);

    // 撤回の記録対象とdeindexの対象は「有効な版」（承認済み、無ければ現在のdraft）。
    // pointerは同unitの版のみを指す（schemaの複合FK）。rootの版ガードが並行変更を取込まない
    const activeVersionId = doc.current_version_id ?? doc.current_draft_version_id;
    let activeRevisionNo = 0;
    if (activeVersionId) {
      const v = await c.env.DB.prepare("SELECT id, revision_no FROM document_versions WHERE id = ? AND unit_id = ?")
        .bind(activeVersionId, p.unitId).first<DocumentVersionPointerRow>();
      if (!v) throw new HttpError("INTERNAL_ERROR");
      activeRevisionNo = v.revision_no;
    }
    // deindex job（T066のhandlerが実行する。T063ではqueuedのまま＝索引削除は意図的に遅延してよい）
    const deindexJob = activeVersionId
      ? enqueueJobStatement(c.env, {
          unitId: p.unitId,
          kind: "document.deindex",
          sourceType: "document_version",
          sourceId: activeVersionId,
          sourceVersion: activeRevisionNo,
          configVersion: "v1",
          requestedBy: p.userId,
          dedupeKey: `${p.unitId}|document.deindex|${doc.id}|${activeVersionId}`,
        })
      : null;

    const result = await executeMutation(c.env, p, {
      operationCode: "document.withdraw",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/documents/${params.id}/withdrawal`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      // withdrawnは終端（docs/11 documentStates）。二重撤回は422 INVALID_TRANSITION
      roots: [{
        table: "documents", id: doc.id, expectedVersion: body.version,
        allowedStates: { column: "status", values: ["draft", "approved"] },
      }],
      conditions: [
        // 書込前の状態検査（allowedStatesは失敗後の分類だけなので、終端への辺はここで潰す）
        { existsSql: "SELECT 1 FROM documents WHERE id = ? AND unit_id = ? AND status IN ('draft', 'approved')", binds: [doc.id, p.unitId], failCode: "INVALID_TRANSITION" },
      ],
      statements: (ctx) => [
        c.env.DB.prepare(
          "UPDATE documents SET status = 'withdrawn', version = version + 1, last_mutation_token = ?, updated_at = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ?",
        ).bind(ctx.attempt, ctx.now, doc.id, p.unitId, body.version),
        // 撤回のevents（版がまだ無い文書ではeventsの対象版が無いため書かない。監査・outboxは常時記録）
        ...(activeVersionId ? [
          c.env.DB.prepare(
            "INSERT INTO content_version_events (id, unit_id, report_version_id, document_version_id, action, reason, actor_user_id, actor_kind, created_at) " +
              "VALUES (?, ?, NULL, ?, 'withdrawn', ?, ?, 'human', ?)",
          ).bind(crypto.randomUUID(), p.unitId, activeVersionId, body.reason, p.userId, ctx.now),
        ] : []),
        ...(deindexJob ? [deindexJob.statement] : []),
      ],
      audit: {
        action: "document.withdraw", entityType: "document", entityId: doc.id,
        metadata: { deindexedVersionId: activeVersionId, policyVersion: doc.policy_version },
      },
      event: {
        entityType: "document", entityId: doc.id, entityVersion: body.version + 1,
        eventType: "document.withdrawn", payload: { deindexedVersionId: activeVersionId },
      },
      response: {
        status: 200,
        sql: documentWithJobSql("document.deindex", "deindexJob"),
        binds: [activeVersionId, doc.id],
        decode: (j) => DocumentWithdrawal.parse(j),
      },
    });
    if (deindexJob) {
      // 起動の合図（正本はD1。Cronも回収するので送信失敗は握りつぶす）
      try {
        await c.env.JOBS_QUEUE.send({ jobId: deindexJob.id });
      } catch (err) {
        console.error(JSON.stringify({ event: "job_queue_send_failed", jobId: deindexJob.id, error: String(err) }));
      }
    }
    return ok(c, result.data);
  });

  // --- API-99: ACL・分類の変更（全置換。docs/05 API-99「version,classification,acl;引下げ承認/同unit」） ---
  defineRoute(app, "API-99", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-99");
    // 管理権限を先に見る（非管理者は存在を問わず403。docs/10 §3）
    requireDocumentManage(p);
    const doc = await loadDocument(c, params.id, p.unitId);
    // ACLの対象は実在（同unit団員/役割）まで検査（存在しない対象への許可行を作らない。API-73と同じ404）
    await requireAclTargets({ env: c.env }, p.unitId, body.acl);

    // 変更前のACL（向きの判定に使う。deny優先の判定自体はSQLが毎回行うため、ここでは記録のみ）
    const oldAcl = (
      await c.env.DB.prepare("SELECT member_id, role_id, effect FROM document_acl WHERE unit_id = ? AND document_id = ?")
        .bind(p.unitId, doc.id).all<AclRow>()
    ).results;
    // 新ACLは監査・判定用にDBと同じ形へ正規化する
    const newAcl: AclRow[] = body.acl.map((e) => ({ member_id: e.memberId ?? null, role_id: e.roleId ?? null, effect: e.effect }));
    const direction = policyDirection(oldAcl, newAcl);
    const classificationChanged = body.classification !== doc.classification;

    // reindex job（T066のhandlerが実行する）。緩和方向でも必ず永続化する（docs/16 T063の裁定）。
    // 対象は有効な版（承認済み、無ければ現在のdraft）。版がまだ無い文書では作らない
    const activeVersionId = doc.current_version_id ?? doc.current_draft_version_id;
    let activeRevisionNo = 0;
    if (activeVersionId) {
      const v = await c.env.DB.prepare("SELECT id, revision_no FROM document_versions WHERE id = ? AND unit_id = ?")
        .bind(activeVersionId, p.unitId).first<DocumentVersionPointerRow>();
      if (!v) throw new HttpError("INTERNAL_ERROR");
      activeRevisionNo = v.revision_no;
    }
    const reindexJob = activeVersionId
      ? enqueueJobStatement(c.env, {
          unitId: p.unitId,
          kind: "document.reindex",
          sourceType: "document_version",
          sourceId: activeVersionId,
          sourceVersion: activeRevisionNo,
          configVersion: "v1",
          requestedBy: p.userId,
          dedupeKey: `${p.unitId}|document.reindex|${doc.id}|${activeVersionId}`,
        })
      : null;

    const aclRowIds = body.acl.map(() => crypto.randomUUID());
    const result = await executeMutation(c.env, p, {
      operationCode: "document.access_policy.change",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "PATCH", path: `/documents/${params.id}/access-policy`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      // ACL変更は撤回済み（withdrawn＝終端）には行えない（422）
      roots: [{
        table: "documents", id: doc.id, expectedVersion: body.version,
        allowedStates: { column: "status", values: ["draft", "approved"] },
      }],
      conditions: [
        // 書込前の状態検査（allowedStatesは失敗後の分類だけなので、終端への辺はここで潰す）
        { existsSql: "SELECT 1 FROM documents WHERE id = ? AND unit_id = ? AND status IN ('draft', 'approved')", binds: [doc.id, p.unitId], failCode: "INVALID_TRANSITION" },
      ],
      statements: (ctx) => [
        // ACLは全置換（現在値の全行を消して入れ直す。deny優先の判定は行の集合で行うため順序は無関係）
        c.env.DB.prepare("DELETE FROM document_acl WHERE unit_id = ? AND document_id = ?").bind(p.unitId, doc.id),
        ...body.acl.map((entry, i) =>
          c.env.DB.prepare(
            "INSERT INTO document_acl (id, unit_id, document_id, member_id, role_id, permission, effect, actor_user_id, actor_kind, created_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'human', ?)",
          ).bind(
            aclRowIds[i]!, p.unitId, doc.id, entry.memberId ?? null, entry.roleId ?? null,
            entry.permission, entry.effect, p.userId, ctx.now,
          ),
        ),
        // classification変更とpolicy_version増分（ACL・分類の改訂版。docs/04:149）
        c.env.DB.prepare(
          "UPDATE documents SET classification = ?, policy_version = policy_version + 1, version = version + 1, last_mutation_token = ?, updated_at = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ?",
        ).bind(body.classification, ctx.attempt, ctx.now, doc.id, p.unitId, body.version),
        ...(reindexJob ? [reindexJob.statement] : []),
      ],
      audit: {
        action: "document.access_policy.change", entityType: "document", entityId: doc.id,
        metadata: {
          direction,
          classificationChanged,
          policyVersion: doc.policy_version + 1,
          reindexedVersionId: activeVersionId,
        },
      },
      event: {
        entityType: "document", entityId: doc.id, entityVersion: body.version + 1,
        eventType: "document.access_policy_changed",
        payload: { direction, policyVersion: doc.policy_version + 1 },
      },
      response: {
        status: 200,
        sql: documentWithJobSql("document.reindex", "reindexJob"),
        binds: [activeVersionId, doc.id],
        decode: (j) => DocumentAccessPolicy.parse(j),
      },
    });
    if (reindexJob) {
      // 起動の合図（正本はD1。Cronも回収するので送信失敗は握りつぶす）
      try {
        await c.env.JOBS_QUEUE.send({ jobId: reindexJob.id });
      } catch (err) {
        console.error(JSON.stringify({ event: "job_queue_send_failed", jobId: reindexJob.id, error: String(err) }));
      }
    }
    return ok(c, result.data);
  });
}
