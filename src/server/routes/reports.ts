import {
  ReportHistory,
  ReportVersion,
  type ReportHistoryDto,
  type ReportVersionDto,
} from "../../shared/contracts/content";
import { resolvePrincipal } from "../auth/principal";
import type { AppEnv } from "../env";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { canonicalRequestHash } from "../mutations/hash";
import { executeMutation, type MutationSpec } from "../mutations/execute";
import { getReportTemplate, type ReportTemplate } from "../reports/templates";
import { requirePermission } from "./invitations";

/**
 * 帳票の手動下書き・版（T056、docs/05 API-58/59/62、docs/04:146/147、docs/11 報告書/文書版、docs/14 D20）。
 * - 様式は点検様式と別の版付き設定artifact（config/report-templates/manifest.jsonのallowlist。hash固定）で、
 *   allowlist外・hash不一致の版は422で受理しない（docs/04 §3.5末尾「存在しない版は422」）。
 * - 編集は常に新draft版を作り、旧版はDBトリガーで不変（docs/11「差戻し後/承認後訂正は新draft版、旧版不変」）。
 *   承認版（current_approved_version_id）とdraft（current_draft_version_id）のpointerは別に持つ。
 * - 数値（参加人数・実施日時）は人の入力に任せず、**サーバーが元実績から計算してsource_versionsに版を記録する**
 *   （docs/16 T056。元実績の更新は「保存した版と現行版の不一致」で検出できる）。
 * - 承認の決定（API-60）と出力（API-61）はT058以降。
 */

interface ActivityRow {
  id: string; unit_id: string; version: number; owner_member_id: string;
}
interface ResultRow {
  id: string; unit_id: string; activity_id: string; current_revision_id: string | null; version: number;
}
interface RevisionRow {
  id: string; unit_id: string; result_id: string; revision_no: number;
}
interface ReportRow {
  id: string; unit_id: string; activity_id: string; kind: string;
  current_draft_version_id: string | null; current_approved_version_id: string | null;
  version: number; created_at: string; updated_at: string; created_by: string | null;
  owner_member_id: string;
}
interface ReportVersionRow {
  id: string; unit_id: string; report_id: string; template_version: string; revision_no: number;
  text: string; missing_fields: string; source_versions: string; model_id: string | null;
  status: ReportVersionDto["status"]; approved_by: string | null; approved_at: string | null; created_at: string;
}

const toReport = (r: ReportRow): ReportHistoryDto["report"] => ({
  id: r.id,
  version: r.version,
  activityId: r.activity_id,
  kind: r.kind as "manual",
  currentDraftVersionId: r.current_draft_version_id,
  currentApprovedVersionId: r.current_approved_version_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toReportVersion = (r: ReportVersionRow): ReportVersionDto => ({
  id: r.id,
  reportId: r.report_id,
  templateVersion: r.template_version,
  revisionNo: r.revision_no,
  text: r.text,
  missingFields: JSON.parse(r.missing_fields) as string[],
  sourceVersions: JSON.parse(r.source_versions) as ReportVersionDto["sourceVersions"],
  modelId: r.model_id,
  status: r.status,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
  createdAt: r.created_at,
});

/** 帳票と全版（docs/05 API-58「Report＋ReportVersion」。batch内のSQLが組み立てる応答用） */
const REPORT_VERSION_JSON =
  "SELECT json_object('id', t.id, 'reportId', t.report_id, 'templateVersion', t.template_version, " +
  "'revisionNo', t.revision_no, 'text', t.text, 'missingFields', json(t.missing_fields), " +
  "'sourceVersions', json(t.source_versions), 'modelId', t.model_id, 'status', t.status, " +
  "'approvedBy', t.approved_by, 'approvedAt', t.approved_at, 'createdAt', t.created_at) " +
  "FROM report_versions t WHERE t.id = ?";

const REPORT_JSON =
  "SELECT json_object('report', json_object('id', r.id, 'version', r.version, 'activityId', r.activity_id, 'kind', r.kind, " +
  "'currentDraftVersionId', r.current_draft_version_id, 'currentApprovedVersionId', r.current_approved_version_id, " +
  "'createdAt', r.created_at, 'updatedAt', r.updated_at), " +
  "'versions', (SELECT json_group_array(json_object('id', t.id, 'reportId', t.report_id, 'templateVersion', t.template_version, " +
  "'revisionNo', t.revision_no, 'text', t.text, 'missingFields', json(t.missing_fields), " +
  "'sourceVersions', json(t.source_versions), 'modelId', t.model_id, 'status', t.status, " +
  "'approvedBy', t.approved_by, 'approvedAt', t.approved_at, 'createdAt', t.created_at)) FROM " +
  "(SELECT * FROM report_versions t WHERE t.unit_id = r.unit_id AND t.report_id = r.id ORDER BY t.revision_no) t)) " +
  "FROM reports r WHERE r.id = ?";

/**
 * 源の実績・予定の現行版を読み、source_versionsとして記録する値を組み立てる
 * （docs/16 T056「数値は実績からサーバー計算」。人の入力から数値を複製しない）。
 * 様式のrequired input欄は本文（text）が空白のみのとき未記入とする（欄ごとの分解は文書原本機能＝PH4以降の範囲）
 */
async function computeSourceVersions(
  env: AppEnv,
  unitId: string, activityId: string, template: ReportTemplate, text: string,
): Promise<{ sourceVersions: ReportVersionDto["sourceVersions"]; missingFields: string[] }> {
  const activity = await env.DB.prepare("SELECT version FROM activities WHERE id = ? AND unit_id = ?")
    .bind(activityId, unitId).first<{ version: number }>();
  if (!activity) throw new HttpError("NOT_FOUND");
  const result = await env.DB.prepare("SELECT id, current_revision_id, version FROM activity_results WHERE unit_id = ? AND activity_id = ?")
    .bind(unitId, activityId).first<ResultRow>();
  if (!result?.current_revision_id) {
    throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "resultVersion", reason: "result_not_found" }]);
  }
  const revision = await env.DB.prepare("SELECT revision_no FROM activity_result_revisions WHERE id = ?")
    .bind(result.current_revision_id).first<{ revision_no: number }>();
  if (!revision) throw new HttpError("INTERNAL_ERROR"); // ポインタは同親の版のみを指す（activity-resultsと同じ前提）
  return {
    sourceVersions: {
      activityVersion: activity.version,
      resultVersion: result.version,
      resultRevisionNo: revision.revision_no,
    },
    missingFields: template.fieldSchema
      .filter((f) => f.required && f.source === "input" && text.trim().length === 0)
      .map((f) => f.code),
  };
}

export function registerReportRoutes(app: ApiApp): void {
  // --- API-62: 手動下書き（AI停止でも人の入力で帳票を作れる。docs/05 API-62） ---
  defineRoute(app, "API-62", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-62");
    const activity = await c.env.DB.prepare("SELECT unit_id, owner_member_id FROM activities WHERE id = ?")
      .bind(body.activityId).first<ActivityRow>();
    if (!activity || activity.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
    requirePermission(p, "PER-04", { unitId: p.unitId, type: "activity", id: body.activityId, ownerMemberId: activity.owner_member_id });

    // allowlist外・hash不一致の様式版は受理しない（docs/04 §3.5末尾。templates.tsが422を投げる）
    const template = await getReportTemplate(body.templateVersion);
    const { sourceVersions, missingFields } = await computeSourceVersions(c.env, p.unitId, body.activityId, template, body.text);

    // 実績rootの版ガード（docs/05「resultVersion」。旧版・並行更新は409）
    const result = await c.env.DB.prepare("SELECT id, current_revision_id, version FROM activity_results WHERE unit_id = ? AND activity_id = ?")
      .bind(p.unitId, body.activityId).first<ResultRow>();
    if (!result?.current_revision_id) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "resultVersion", reason: "result_not_found" }]);
    }

    const reportId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const spec: MutationSpec<ReportHistoryDto> = {
      operationCode: "report.manual.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: "/reports/manual", body }),
      expectedAuthzVersion: p.authzVersion,
      roots: [],
      // reports/report_versionsは新規作成のみ（1活動に複数帳票可＝docs/04 ER「ACTIVITIES ||--o{ REPORTS」。UNIQUE無し）
      created: [{ table: "reports", id: reportId }, { table: "report_versions", id: versionId }],
      // resultVersionの期待版は条件検査（帳票は実績の行を一切更新しないためrootガードにできない。
      // activity-results.tsのactivities検査と同じ方式。旧版・並行更新は409）
      conditions: [
        {
          existsSql: "SELECT 1 FROM activity_results WHERE id = ? AND unit_id = ? AND version = ?",
          binds: [result.id, p.unitId, body.resultVersion],
          failCode: "VERSION_CONFLICT",
        },
      ],
      statements: (ctx) => [
        // root（循環FKのためdraft pointerはNULLで作り、初版INSERT後に向ける。docs/04:146）
        c.env.DB.prepare(
          "INSERT INTO reports (id, unit_id, activity_id, kind, current_draft_version_id, current_approved_version_id, version, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, 'manual', NULL, NULL, 1, ?, ?, ?, ?, 'human')",
        ).bind(reportId, p.unitId, body.activityId, ctx.attempt, ctx.now, ctx.now, p.userId),
        // 初版（revision_no=1。draft。数値は実績から計算したsource_versionsを保存）
        c.env.DB.prepare(
          "INSERT INTO report_versions (id, unit_id, report_id, template_version, revision_no, text, missing_fields, source_versions, model_id, status, approved_by, approved_at, version, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, 1, ?, ?, ?, NULL, 'draft', NULL, NULL, 1, ?, ?, ?, ?, 'human')",
        ).bind(versionId, p.unitId, reportId, template.version, body.text, JSON.stringify(missingFields), JSON.stringify(sourceVersions), ctx.attempt, ctx.now, ctx.now, p.userId),
        c.env.DB.prepare(
          "UPDATE reports SET current_draft_version_id = ?, updated_at = ? WHERE id = ? AND unit_id = ? AND current_draft_version_id IS NULL",
        ).bind(versionId, ctx.now, reportId, p.unitId),
      ],
      audit: {
        action: "report.manual.create", entityType: "report", entityId: reportId,
        metadata: { activityId: body.activityId, templateVersion: template.version },
      },
      event: { entityType: "report", entityId: reportId, entityVersion: 1, eventType: "report.created", payload: { activityId: body.activityId } },
      response: { status: 201, sql: REPORT_JSON, binds: [reportId], decode: (j) => ReportHistory.parse(j) },
    };
    const result2 = await executeMutation(c.env, p, spec);
    return ok(c, result2.data, {}, 201);
  });

  // --- API-59: 新draft版（旧版は不変。docs/11「差戻し後/承認後訂正は新draft版、旧版不変」） ---
  defineRoute(app, "API-59", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-59");
    requirePermission(p, "PER-10", { unitId: p.unitId, type: "report", id: params.id });
    const report = await c.env.DB.prepare(
      "SELECT r.*, a.owner_member_id FROM reports r JOIN activities a ON a.unit_id = r.unit_id AND a.id = r.activity_id WHERE r.id = ?",
    ).bind(params.id).first<ReportRow>();
    if (!report || report.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");

    // 直前版から様式版を引き継ぎ、revisionを進める（様式の改版は様式側の関心事。docs/05 API-59に様式入力は無い）
    const latest = await c.env.DB.prepare(
      "SELECT * FROM report_versions WHERE unit_id = ? AND report_id = ? ORDER BY revision_no DESC LIMIT 1",
    ).bind(p.unitId, report.id).first<ReportVersionRow>();
    if (!latest) throw new HttpError("INTERNAL_ERROR"); // 初版はrootと同時に作る（docs/04:146）
    const template = await getReportTemplate(latest.template_version);
    const { sourceVersions, missingFields } = await computeSourceVersions(c.env, p.unitId, report.activity_id, template, body.text);
    const nextRevisionNo = latest.revision_no + 1;
    const versionId = crypto.randomUUID();

    const spec: MutationSpec<ReportVersionDto> = {
      operationCode: "report.version.create",
      key: headers["idempotency-key"],
      requestHash: await canonicalRequestHash({ method: "POST", path: `/reports/${params.id}/versions`, baseVersion: body.version, body }),
      expectedAuthzVersion: p.authzVersion,
      // draft pointerの切替はrootの版ガード付き比較更新（docs/11 §3。並行改稿の第2は409）。
      // current_approved_version_idは触らない（docs/11「承認済pointerは次版承認まで保持」）
      roots: [{ table: "reports", id: report.id, expectedVersion: body.version }],
      created: [{ table: "report_versions", id: versionId }],
      statements: (ctx) => [
        c.env.DB.prepare(
          "INSERT INTO report_versions (id, unit_id, report_id, template_version, revision_no, text, missing_fields, source_versions, model_id, status, approved_by, approved_at, version, last_mutation_token, created_at, updated_at, created_by, actor_kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'draft', NULL, NULL, 1, ?, ?, ?, ?, 'human')",
        ).bind(versionId, p.unitId, report.id, latest.template_version, nextRevisionNo, body.text, JSON.stringify(missingFields), JSON.stringify(sourceVersions), ctx.attempt, ctx.now, ctx.now, p.userId),
        c.env.DB.prepare(
          "UPDATE reports SET current_draft_version_id = ?, version = version + 1, last_mutation_token = ?, updated_at = ? " +
            "WHERE id = ? AND unit_id = ? AND version = ?",
        ).bind(versionId, ctx.attempt, ctx.now, report.id, p.unitId, body.version),
      ],
      audit: {
        action: "report.version.create", entityType: "report", entityId: report.id,
        metadata: { revisionNo: nextRevisionNo },
      },
      event: {
        entityType: "report", entityId: report.id, entityVersion: body.version + 1,
        eventType: "report_version.created", payload: { revisionNo: nextRevisionNo },
      },
      duplicateOn: [
        // 並行改稿のrevision採番競合はrootの版ガードで先に409になるが、二重防御として宣言する
        "report_versions.unit_id", "report_versions.report_id", "report_versions.revision_no",
      ],
      response: { status: 201, sql: REPORT_VERSION_JSON, binds: [versionId], decode: (j) => ReportVersion.parse(j) },
    };
    const result = await executeMutation(c.env, p, spec);
    return ok(c, result.data, {}, 201);
  });

  // --- API-58: 帳票と版の取得（revision?。未承認版は担当のみ。docs/05 API-58） ---
  defineRoute(app, "API-58", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, query } = await parseApiRequest(c, "API-58");
    requirePermission(p, "PER-11", { unitId: p.unitId, type: "report", id: params.id });
    const report = await c.env.DB.prepare(
      "SELECT r.*, a.owner_member_id FROM reports r JOIN activities a ON a.unit_id = r.unit_id AND a.id = r.activity_id WHERE r.id = ?",
    ).bind(params.id).first<ReportRow>();
    if (!report || report.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
    const all = (
      await c.env.DB.prepare("SELECT * FROM report_versions WHERE unit_id = ? AND report_id = ? ORDER BY revision_no")
        .bind(p.unitId, report.id).all<ReportVersionRow>()
    ).results;
    if (all.length === 0) throw new HttpError("INTERNAL_ERROR"); // 初版はrootと同時に作る

    // 担当＝作成者＋activity担当owner（コントローラ裁定。docs/05「未承認版は担当のみ」）。
    // 担当外は承認版だけが見え、承認版が無ければ存在も明かさない（404。docs/10 §3「対象外IDは404」）
    const creator = report.created_by
      ? await c.env.DB.prepare("SELECT id FROM members WHERE unit_id = ? AND user_id = ?").bind(p.unitId, report.created_by)
          .first<{ id: string }>()
      : null;
    const isOwner = p.memberId === report.owner_member_id || (creator !== null && p.memberId === creator.id);
    const visible = all.filter((v) => isOwner || v.id === report.current_approved_version_id);
    const selected = query.revision === undefined ? visible : visible.filter((v) => v.revision_no === query.revision);
    if (selected.length === 0) throw new HttpError("NOT_FOUND");

    const data = ReportHistory.parse({ report: toReport(report), versions: selected.map(toReportVersion) });
    return ok(c, data);
  });
}
