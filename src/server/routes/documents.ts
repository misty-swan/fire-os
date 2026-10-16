import {
  Document,
  DocumentVersion,
  type DocumentDto,
  type DocumentVersionDto,
} from "../../shared/contracts/content";
import { Job } from "../../shared/contracts/common";
import { resolvePrincipal, type AuthzPrincipal } from "../auth/principal";
import type { AppEnv } from "../env";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { enqueueJobStatement } from "../jobs/store";
import { canonicalRequestHash, sha256Hex } from "../mutations/hash";
import { executeMutation } from "../mutations/execute";
import { documentVisibilitySql } from "../documents/authorized";
import "../jobs/handlers/document-extract"; // 抽出job（document.extract）handlerの登録（Cron/Queueと同じ登録点）
import { requirePermission } from "./invitations";

/**
 * 許諾文書の原本・版・閲覧API（T062、docs/04:149/150、docs/05 API-73/74/90/91、docs/06 §5、docs/10 §2/§4）。
 * - 承認（API-75）・撤回（API-92）・ACL変更（API-99）はroutes/document-decisions.ts・document-policy.ts（T063）。
 *   抽出job handlerはT064（jobはqueuedのまま滞在する）。
 * - 管理操作（API-73/74）はPER-11＋幹部・管理者（docs/10のPER-03 unitWide: MANAGERSと同じ実装既定。
 *   D03未承認の検証設定としてdocs/16 T062に記録）。
 * - 閲覧（API-90/91）はdeny優先のdocument_aclで前置する（docs/10 §3「SQLで対象行を絞ってからページング」）。
 *   ACL行の無い文書は同unitのPER-01保持者に見える既定。非公開文書は一覧の行・件数にも現れず、詳細は404。
 *   撤回済み（withdrawn）の文書は誰にも現れない（T063。終端・存在も明かさない404）。
 * - 版は常に新draft版を作り、旧版の原本参照・許諾・hashは不変（docs/04:150「承認原本不変」＝0024の帳票版と同じ流儀）。
 *   current_draft_version_idだけを切替え、current_version_id（承認済pointer）は承認（API-75のapprove）だけが切替る。
 * - attachmentIdは原本添付への直接参照（docs/04:150）。取得（API-27）のACL再検査の経路として同じ
 *   (document, attachment)のattachment_links行を版作成と同時に1本作る（docs/16 T062の裁定: 直参照とlink併用）。
 */

/** PER-11＋幹部・管理者（管理操作の実装既定。docs/10 PER-11「△公開対象」の管理側） */
export function requireDocumentManage(p: AuthzPrincipal): void {
  requirePermission(p, "PER-11", { unitId: p.unitId, type: "document" });
  if (!p.roles.includes("officer") && !p.roles.includes("admin")) {
    throw new HttpError("FORBIDDEN", undefined, [{ field: "permission", reason: "document_manage_required" }]);
  }
}

interface DocumentRow {
  id: string; unit_id: string; version: number; title: string; classification: string;
  current_version_id: string | null; current_draft_version_id: string | null;
  status: string; policy_version: number; created_at: string; updated_at: string;
}

interface DocumentVersionRow {
  id: string; unit_id: string; document_id: string; revision_no: number; attachment_id: string;
  status: DocumentVersionDto["status"]; approved_by: string | null; approved_at: string | null;
  license_ref: string; content_hash: string; created_at: string;
}

const toDocument = (r: DocumentRow): DocumentDto => ({
  id: r.id,
  version: r.version,
  title: r.title,
  classification: r.classification,
  status: r.status as DocumentDto["status"],
  currentVersionId: r.current_version_id,
  currentDraftVersionId: r.current_draft_version_id,
  policyVersion: r.policy_version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

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

/** 版と抽出job（202応答。docs/05 API-74「DocumentVersion＋Job」） */
const VERSION_WITH_JOB_JSON =
  "SELECT json_object(" +
  "'version', json_object('id', t.id, 'documentId', t.document_id, 'revisionNo', t.revision_no, 'attachmentId', t.attachment_id, " +
  "'status', t.status, 'approvedBy', t.approved_by, 'approvedAt', t.approved_at, 'licenseRef', t.license_ref, " +
  "'contentHash', t.content_hash, 'createdAt', t.created_at), " +
  "'job', json_object('id', j.id, 'status', j.status, 'attempts', j.attempts, 'errorCode', j.error_code, 'resultRef', j.result_ref)) " +
  "FROM document_versions t LEFT JOIN jobs j ON j.source_type = 'document_version' AND j.source_id = t.id AND j.kind = 'document.extract' " +
  "WHERE t.id = ? AND t.unit_id = ? ORDER BY j.created_at DESC LIMIT 1";

/**
 * 文書ACL前置（deny優先）のWHERE片はsrc/server/documents/authorized.tsの正本（T063で移動。
 * 一覧・詳細・原文取得・検索/引用の全経路で同じ判定を使う）。
 */

/** 存在しない/別unitの文書は同じ404（存在を明かさない。announcements.tsと同じ流儀） */
export async function loadDocument(c: { env: AppEnv }, id: string, unitId: string): Promise<DocumentRow> {
  const row = await c.env.DB.prepare(
    "SELECT id, unit_id, version, title, classification, current_version_id, current_draft_version_id, status, policy_version, created_at, updated_at " +
      "FROM documents WHERE id = ?",
  ).bind(id).first<DocumentRow>();
  if (!row || row.unit_id !== unitId) throw new HttpError("NOT_FOUND");
  return row;
}

const loadVersions = async (env: AppEnv, unitId: string, documentId: string): Promise<DocumentVersionRow[]> =>
  (
    await env.DB.prepare(
      "SELECT id, unit_id, document_id, revision_no, attachment_id, status, approved_by, approved_at, license_ref, content_hash, created_at " +
        "FROM document_versions WHERE unit_id = ? AND document_id = ? ORDER BY revision_no",
    ).bind(unitId, documentId).all<DocumentVersionRow>()
  ).results;

/** ACL入力の対象を実在（同unit団員/役割）まで検査する（docs/05 §1「IDは存在/所属/許可を全関連先まで検査」。announcementsと同じ404） */
export async function requireAclTargets(c: { env: AppEnv }, unitId: string, acl: readonly { memberId?: string; roleId?: string }[]): Promise<void> {
  const memberIds = acl.flatMap((e) => (e.memberId ? [e.memberId] : []));
  const roleIds = acl.flatMap((e) => (e.roleId ? [e.roleId] : []));
  if (memberIds.length > 0) {
    const rows = (
      await c.env.DB.prepare(
        `SELECT id, unit_id FROM members WHERE id IN (${memberIds.map(() => "?").join(",")})`,
      ).bind(...memberIds).all<{ id: string; unit_id: string }>()
    ).results;
    if (rows.length !== new Set(memberIds).size || rows.some((r) => r.unit_id !== unitId)) throw new HttpError("NOT_FOUND");
  }
  if (roleIds.length > 0) {
    const rows = (
      await c.env.DB.prepare(
        `SELECT id FROM roles WHERE id IN (${roleIds.map(() => "?").join(",")})`,
      ).bind(...roleIds).all<{ id: string }>()
    ).results;
    if (rows.length !== new Set(roleIds).size) throw new HttpError("NOT_FOUND");
  }
}

// --- 署名付きcursor（announcements.tsと同じ流儀。条件を変えた続き取得・改変cursorは409 SNAPSHOT_CHANGED） ---

interface DocumentCursor {
  filterHash: string;
  createdAt: string;
  id: string;
}

const signingKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", new TextEncoder().encode(`document-cursor:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

async function encodeCursor(key: CryptoKey, cursor: DocumentCursor): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify(cursor)));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `${payload}.${b64url(new Uint8Array(sig))}`;
}

/** 改変・署名不一致・型の不整合は全てnull（呼び出し側は条件変更と同じ409にする） */
async function decodeCursor(key: CryptoKey, value: string): Promise<DocumentCursor | null> {
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", key, unb64url(sig) as BufferSource, new TextEncoder().encode(payload));
    if (!valid) return null;
    const parsed = JSON.parse(new TextDecoder().decode(unb64url(payload))) as DocumentCursor;
    if (typeof parsed.filterHash !== "string" || typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export function registerDocumentRoutes(app: ApiApp): void {
  // --- API-73: 文書の登録（root＋ACLを同一batchで確定。docs/05 API-73「title,classification,acl;D20許諾」） ---
  defineRoute(app, "API-73", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-73");
    requireDocumentManage(p);
    // ACLの対象は実在（同unit団員/役割）まで検査する（存在しない対象への許可行を作らない）
    await requireAclTargets({ env: c.env }, p.unitId, body.acl);

    const id = crypto.randomUUID();
    const result = await executeMutation(c.env, p, {
      operationCode: "document.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/documents", body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [],
      created: [{ table: "documents", id }],
      statements: (ctx) => [
        c.env.DB.prepare(
          "INSERT INTO documents (id, unit_id, title, classification, current_version_id, current_draft_version_id, status, policy_version, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, NULL, NULL, 'draft', 1, ?, ?, ?, ?, 'human')",
        ).bind(id, p.unitId, body.title, body.classification, ctx.attempt, ctx.now, ctx.now, p.userId),
        ...body.acl.map((entry) =>
          c.env.DB.prepare(
            "INSERT INTO document_acl (id, unit_id, document_id, member_id, role_id, permission, effect, actor_user_id, actor_kind, created_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'human', ?)",
          ).bind(
            crypto.randomUUID(), p.unitId, id, entry.memberId ?? null, entry.roleId ?? null,
            entry.permission, entry.effect, p.userId, ctx.now,
          ),
        ),
      ],
      audit: {
        action: "document.create", entityType: "document", entityId: id,
        metadata: { aclCount: body.acl.length, policyVersion: 1 },
      },
      event: { entityType: "document", entityId: id, entityVersion: 1, eventType: "document.created", payload: { policyVersion: 1 } },
      response: {
        status: 201,
        sql: "SELECT json_object('id', id, 'version', version, 'title', title, 'classification', classification, 'status', status, " +
          "'currentVersionId', current_version_id, 'currentDraftVersionId', current_draft_version_id, 'policyVersion', policy_version, " +
          "'createdAt', created_at, 'updatedAt', updated_at) FROM documents WHERE id = ?",
        binds: [id],
        decode: (j) => Document.parse(j),
      },
    });
    return ok(c, result.data, {}, 201);
  });

  // --- API-74: 版の作成＋抽出job登録（1batch。202=受付。docs/05 API-74「version,attachmentId,licenseRef;ready原本/抽出job」） ---
  defineRoute(app, "API-74", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-74");
    // 管理権限を先に見る（非管理者は存在を問わず403。文書の存在を明かさない。docs/10 §3）
    requireDocumentManage(p);
    const doc = await loadDocument(c, params.id, p.unitId);
    // licenseRefは契約必須（無い版は作れない。docs/04:150「license_ref:T」＝入力省略は共通検証の400）

    // 原本は同unit・readyのみ（別unit/存在しない添付は同じ404。未検査は422 ATTACHMENT_NOT_READY）。
    // 競合（承認待ちに検査が変わる等）はbatch内のconditionsで書込前に再検査する
    const att = await c.env.DB.prepare("SELECT id, unit_id, sha256 FROM attachments WHERE id = ?")
      .bind(body.attachmentId).first<{ id: string; unit_id: string; sha256: string | null }>();
    if (!att || att.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");

    // 直前版から次のrevisionを採番（文書ごとに1から。UNIQUE(unit_id,document_id,revision_no)で二重防御）
    const latest = await c.env.DB.prepare(
      "SELECT revision_no FROM document_versions WHERE unit_id = ? AND document_id = ? ORDER BY revision_no DESC LIMIT 1",
    ).bind(p.unitId, doc.id).first<{ revision_no: number }>();
    const nextRevisionNo = (latest?.revision_no ?? 0) + 1;
    const versionId = crypto.randomUUID();
    // 抽出job（T064のhandlerが実行する。T062ではqueuedのまま滞在するだけでよい）。
    // 業務の確定（版作成）と同じbatchで登録し、確定後にQueueへ起動の合図を送る
    const job = enqueueJobStatement(c.env, {
      unitId: p.unitId,
      kind: "document.extract",
      sourceType: "document_version",
      sourceId: versionId,
      sourceVersion: nextRevisionNo,
      configVersion: "v1",
      requestedBy: p.userId,
      dedupeKey: `${p.unitId}|document.extract|${doc.id}|${versionId}`,
    });

    const result = await executeMutation(c.env, p, {
      operationCode: "document.version.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/documents/${params.id}/versions`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      // draft pointerの切替はrootの版ガード付き比較更新（並行改版の第2は409）。
      // current_version_id（承認済pointer）は触らない（docs/11「承認済pointerは次版承認まで保持」。T063以降）
      roots: [{ table: "documents", id: doc.id, expectedVersion: body.version }],
      created: [{ table: "document_versions", id: versionId }],
      conditions: [
        { existsSql: "SELECT 1 FROM attachments WHERE id = ? AND unit_id = ?", binds: [att.id, p.unitId], failCode: "NOT_FOUND" },
        { existsSql: "SELECT 1 FROM attachments WHERE id = ? AND unit_id = ? AND status = 'ready'", binds: [att.id, p.unitId], failCode: "ATTACHMENT_NOT_READY" },
      ],
      statements: (ctx) => [
        // 版（draft。content_hashは添付のsha256へ固定＝原本の不変証跡。docs/04:150）。
        // batchの順序どおりconditions（ready検査）の後に走るため、readyならsha256はDBのCHECKで非NULL
        c.env.DB.prepare(
          "INSERT INTO document_versions (id, unit_id, document_id, revision_no, attachment_id, status, approved_by, approved_at, license_ref, content_hash, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, 'draft', NULL, NULL, ?, ?, ?, ?, ?, ?, 'human')",
        ).bind(versionId, p.unitId, doc.id, nextRevisionNo, att.id, body.licenseRef, att.sha256 ?? "", ctx.attempt, ctx.now, ctx.now, p.userId),
        c.env.DB.prepare(
          "UPDATE documents SET current_draft_version_id = ?, version = version + 1, last_mutation_token = ?, updated_at = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ?",
        ).bind(versionId, ctx.attempt, ctx.now, doc.id, p.unitId, body.version),
        // 取得（API-27）のACL再検査の経路: 同じ(document, attachment)のlinkを1本（docs/16 T062の裁定）。
        // ready検査済み＋NOT EXISTSで二重INSERTを防ぐ（attachment_links.uq_attachment_links_active）
        c.env.DB.prepare(
          "INSERT INTO attachment_links (id, unit_id, attachment_id, entity_type, entity_id, linked_by, created_at, updated_at, created_by, actor_kind) " +
            "SELECT ?, ?, a.id, 'document', ?, ?, ?, ?, ?, 'human' FROM attachments a WHERE a.unit_id = ? AND a.id = ? AND a.status = 'ready' " +
            "AND NOT EXISTS (SELECT 1 FROM attachment_links l WHERE l.attachment_id = a.id AND l.entity_type = 'document' AND l.entity_id = ? AND l.unlinked_at IS NULL)",
        ).bind(crypto.randomUUID(), p.unitId, doc.id, p.userId, ctx.now, ctx.now, p.userId, p.unitId, att.id, doc.id),
        job.statement,
      ],
      audit: {
        action: "document.version.create", entityType: "document", entityId: doc.id,
        metadata: { revisionNo: nextRevisionNo, attachmentId: att.id },
      },
      event: {
        entityType: "document", entityId: doc.id, entityVersion: body.version + 1,
        eventType: "document_version.created", payload: { revisionNo: nextRevisionNo },
      },
      duplicateOn: [
        // revision採番競合はrootの版ガードで先に409になるが、二重防御として宣言する
        "document_versions.unit_id", "document_versions.document_id", "document_versions.revision_no",
      ],
      response: {
        status: 202,
        sql: VERSION_WITH_JOB_JSON,
        binds: [versionId, p.unitId],
        decode: (j) => {
          const v = j as { version: unknown; job: unknown };
          return { version: DocumentVersion.parse(v.version), job: Job.parse(v.job) };
        },
      },
    });
    // 起動の合図（正本はD1。Cronも回収するので送信失敗は握りつぶす）
    try {
      await c.env.JOBS_QUEUE.send({ jobId: job.id });
    } catch (err) {
      console.error(JSON.stringify({ event: "job_queue_send_failed", jobId: job.id, error: String(err) }));
    }
    return ok(c, result.data, {}, 202);
  });

  // --- API-90: 一覧（文書ACL前置。docs/05 API-90「q/status/limit/cursor;文書ACL前置」） ---
  defineRoute(app, "API-90", async (c) => {
    const p = await resolvePrincipal(c);
    const { query } = await parseApiRequest(c, "API-90");
    requirePermission(p, "PER-11", { unitId: p.unitId, type: "document" });

    // 可視性はSQLで対象行を絞ってからページングする（docs/10 §3「全件取得後にUIで隠す方式は禁止」）。
    // 撤回済み（withdrawn）は誰にも現れない（T063。終端・存在も明かさない）
    const visibility = documentVisibilitySql(p);
    const where = ["d.unit_id = ?", "d.status <> 'withdrawn'", visibility.sql];
    const binds: unknown[] = [p.unitId, ...visibility.binds];
    if (query.q) {
      where.push("d.title LIKE ? ESCAPE '\\'");
      binds.push(`%${likeEscape(query.q)}%`);
    }
    if (query.status) {
      where.push("d.status = ?");
      binds.push(query.status);
    }

    // 条件の指紋はcursor自体を除いて計算する（条件を変えた続き取得は409 SNAPSHOT_CHANGED）
    const key = await signingKey(c.env.BETTER_AUTH_SECRET);
    const { cursor: cursorValue, ...filterOnly } = query;
    const filterHash = await sha256Hex(JSON.stringify(filterOnly));
    if (cursorValue) {
      const cursor = await decodeCursor(key, cursorValue);
      if (!cursor || cursor.filterHash !== filterHash) throw new HttpError("SNAPSHOT_CHANGED");
      // 新しい順（作成降順）の続き。同時刻はid降順で並べ、取りこぼしも重複も作らない
      where.push("(d.created_at < ? OR (d.created_at = ? AND d.id < ?))");
      binds.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    // limit+1件だけ読み、続きの有無をnextCursorの有無で返す（件数を黙って切り捨てない。docs/05 §1）
    const rows = (
      await c.env.DB.prepare(
        "SELECT d.id, d.unit_id, d.version, d.title, d.classification, d.current_version_id, d.current_draft_version_id, d.status, d.policy_version, d.created_at, d.updated_at " +
          `FROM documents d WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
      ).bind(...binds, query.limit + 1).all<DocumentRow>()
    ).results;

    const page = rows.slice(0, query.limit).map(toDocument);
    if (rows.length > query.limit) {
      const last = rows[query.limit - 1]!;
      return ok(c, page, { nextCursor: await encodeCursor(key, { filterHash, createdAt: last.created_at, id: last.id }) });
    }
    return ok(c, page);
  });

  // --- API-91: 詳細（文書＋版一覧＋原文添付の参照。revision?で引用元版を辿れる。docs/05 API-91） ---
  defineRoute(app, "API-91", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, query } = await parseApiRequest(c, "API-91");
    requirePermission(p, "PER-11", { unitId: p.unitId, type: "document" });
    const doc = await loadDocument(c, params.id, p.unitId);

    // ACL前置（deny優先。非公開文書は存在も明かさない404。docs/10 §3「対象外IDは404」）。
    // 撤回済み（withdrawn）も同じ404（T063。一覧・詳細・原文・版の全GETが存在を明かさない）
    const visibility = documentVisibilitySql(p);
    const visible = await c.env.DB.prepare(
      `SELECT 1 FROM documents d WHERE d.id = ? AND d.status <> 'withdrawn' AND ${visibility.sql}`,
    ).bind(doc.id, ...visibility.binds).first();
    if (!visible) throw new HttpError("NOT_FOUND");

    const versions = await loadVersions(c.env, p.unitId, doc.id);
    // revision?省略は現在のdraft版（無ければ承認版）。版一覧は文書ACLで見える者に全版を見せる
    // （T063裁定: 絞り込みはしない。機密性の正文書ゲートは文書ACLと撤回で、版の審査状態はworkflowの記録。docs/16 T063）
    const currentVersionId = doc.current_draft_version_id ?? doc.current_version_id;
    const selected =
      (query.revision === undefined
        ? versions.find((v) => v.id === currentVersionId)
        : versions.find((v) => v.revision_no === query.revision)) ?? null;
    if (query.revision !== undefined && !selected) throw new HttpError("NOT_FOUND");
    // 表示版の原文添付の参照（鍵・実体は返さない。取得はAPI-27が毎回ACLを再検査する。docs/10 §4）
    let original: { attachmentId: string; status: string; contentType: string; contentHash: string | null } | null = null;
    if (selected) {
      const att = await c.env.DB.prepare("SELECT id, status, content_type, sha256 FROM attachments WHERE id = ? AND unit_id = ?")
        .bind(selected.attachment_id, p.unitId).first<{ id: string; status: string; content_type: string; sha256: string | null }>();
      if (!att) throw new HttpError("INTERNAL_ERROR"); // 版のattachment_idはNOT NULL FK（docs/04:150）
      original = { attachmentId: att.id, status: att.status, contentType: att.content_type, contentHash: att.sha256 };
    }

    return ok(c, {
      document: toDocument(doc),
      versions: versions.map(toDocumentVersion),
      original,
    });
  });
}
