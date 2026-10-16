import { DocumentVersion, type DocumentVersionDto } from "../../shared/contracts/content";
import type { AuthzPrincipal } from "../auth/principal";
import type { AppEnv } from "../env";

/**
 * 文書の可視性と承認済み版の共通認可（T063。docs/04:151、docs/06 §5、docs/10 §3/§4）。
 *
 * **このmoduleが単一の正本**（docs/16 T063の裁定）:
 * - documentVisibilitySql — deny優先のdocument_acl前置のWHERE片（T062のroutes/documents.tsから移動）。
 *   一覧（API-90）・詳細（API-91）・原文取得（API-27のdocument link再検査）で使う。
 * - isDocumentVisible — 文書そのものが今見えるか（撤回・ACL失効を待たず即時判定）。
 * - authorizedDocumentVersions — **承認済み（status='approved'）かつ現ACL可視（deny優先・撤回除外）**の版だけを返す。
 *   後続のT066（検索hit後再検査）・T067（回答出力前再検査・引用原文取得）がこれを呼ぶ。
 *   docs/10 §4「過去の閲覧許可を永続権限とみなさない」＝索引削除（deindex/reindex job）が遅れても、
 *   この関数の結果が即空になるため旧引用・旧回答・原文取得のどの経路も漏らさない（docs/06 §5.5）。
 *
 * 可視性の4値判定（docs/16 T062どおり。permission値は判定に使わず行の一致とeffectのみ）:
 *   deny一致 → 非公開（deny優先）／ allow一致 → 可視 ／ ACL行ありで一致無し → 非公開 ／ ACL行なし → 可視。
 */

interface DocumentVersionRow {
  id: string; unit_id: string; document_id: string; revision_no: number; attachment_id: string;
  status: DocumentVersionDto["status"]; approved_by: string | null; approved_at: string | null;
  license_ref: string; content_hash: string; created_at: string;
}

const toDocumentVersion = (r: DocumentVersionRow): DocumentVersionDto => ({
  id: r.id,
  documentId: r.document_id,
  revisionNo: r.revision_no,
  attachmentId: r.attachment_id,
  status: r.status,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
  licenseRef: r.license_ref,
  contentHash: r.content_hash,
  createdAt: r.created_at,
});

/** SQL中で可視性判定の対象文書を指す別名（呼び出し側のFROM documents d / JOIN documents d と揃える） */
const VISIBILITY_ALIAS = "d";

/**
 * 文書ACL前置（deny優先）のWHERE片。permission値は可視性判定に使わず、
 * 行の一致（本人または自分の役割）とeffectで判定する（docs/16 T062に記録）。
 * - deny一致 → 非公開（deny優先。docs/04:151）
 * - allow一致 → 可視
 * - ACL行はあるが一致無し → 非公開（ACLあり＝絞り込み）
 * - ACL行が無い → 可視（同unitのPER-01保持者に見える既定。docs/16 T062）
 * roles空のprincipalは**常に非可視**（PH5レビューA低1。役割の無い主体は可視判定の一致を作れない。
 * SQLiteは`IN ()`を偽と評価するため偶然の一致は起きないが、既定可視の文書が役割無しで見える
 * 隙間を作らないよう、ここで明示的に潰す＝単一の正本としての入力防御）
 */
export function documentVisibilitySql(p: AuthzPrincipal): { sql: string; binds: unknown[] } {
  if (p.roles.length === 0) return { sql: "0 = 1", binds: [] };
  const d = VISIBILITY_ALIAS;
  const denyMatch =
    `(dd.member_id = ? OR dd.role_id IN (SELECT id FROM roles WHERE code IN (` +
    p.roles.map(() => "?").join(",") + `)))`;
  const allowMatch =
    `(da2.member_id = ? OR da2.role_id IN (SELECT id FROM roles WHERE code IN (` +
    p.roles.map(() => "?").join(",") + `)))`;
  return {
    sql:
      // deny一致は先に潰す（deny優先。docs/04:151）
      `NOT EXISTS (SELECT 1 FROM document_acl dd WHERE dd.document_id = ${d}.id AND dd.unit_id = ${d}.unit_id AND dd.effect = 'deny' AND ` + denyMatch + ") " +
      `AND ( NOT EXISTS (SELECT 1 FROM document_acl da WHERE da.document_id = ${d}.id AND da.unit_id = ${d}.unit_id) ` +
      `OR EXISTS (SELECT 1 FROM document_acl da2 WHERE da2.document_id = ${d}.id AND da2.unit_id = ${d}.unit_id AND da2.effect = 'allow' AND ` + allowMatch + ") )",
    binds: [p.memberId, ...p.roles, p.memberId, ...p.roles],
  };
}

/**
 * 文書そのものが今見えるか（撤回されておらず、現ACLで可視）。
 * API-27のdocument link再検査（原文取得の毎回ACL再検査。docs/10 §4）と詳細API-91の前置で使う。
 */
export async function isDocumentVisible(env: Pick<AppEnv, "DB">, p: AuthzPrincipal, documentId: string): Promise<boolean> {
  const visibility = documentVisibilitySql(p);
  const row = await env.DB.prepare(
    `SELECT 1 FROM documents ${VISIBILITY_ALIAS} WHERE ${VISIBILITY_ALIAS}.id = ? AND ${VISIBILITY_ALIAS}.unit_id = ? ` +
      `AND ${VISIBILITY_ALIAS}.status <> 'withdrawn' AND ${visibility.sql}`,
  ).bind(documentId, p.unitId, ...visibility.binds).first();
  return row !== null;
}

/**
 * 承認済みで今も可視な版だけを返す（検索・引用・回答出力・原文取得の共通の正本）。
 * 撤回（document.status='withdrawn'）とACL失効はD1の判定で即除外する（docs/06 §5.5）。
 * idsは検索hitなど少数の版IDを想定する（D1のbind上限内。超過は呼び出し側の誤りとして例外）。
 */
export async function authorizedDocumentVersions(
  env: Pick<AppEnv, "DB">,
  p: AuthzPrincipal,
  ids: readonly string[],
): Promise<DocumentVersionDto[]> {
  if (ids.length === 0) return [];
  if (ids.length > 80) throw new Error("authorizedDocumentVersions: idsは80件まで（D1のbind上限内）");
  const visibility = documentVisibilitySql(p);
  const rows = (
    await env.DB.prepare(
      "SELECT v.id, v.unit_id, v.document_id, v.revision_no, v.attachment_id, v.status, v.approved_by, v.approved_at, v.license_ref, v.content_hash, v.created_at " +
        "FROM document_versions v JOIN documents d ON d.unit_id = v.unit_id AND d.id = v.document_id " +
        `WHERE v.unit_id = ? AND v.id IN (${ids.map(() => "?").join(",")}) AND v.status = 'approved' ` +
        `AND d.status <> 'withdrawn' AND ${visibility.sql}`,
    ).bind(p.unitId, ...ids, ...visibility.binds).all<DocumentVersionRow>()
  ).results;
  return rows.map(toDocumentVersion);
}
