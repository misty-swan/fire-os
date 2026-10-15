import { resolvePrincipal } from "../auth/principal";
import { HttpError, defineRoute, parseApiRequest, type ApiApp } from "../http";
import { renderReport, type ApprovedReportVersion } from "../reports/render";
import { requirePermission } from "./invitations";

/**
 * 承認済み帳票の出力API（T058、docs/05 API-61「format=pdf/csv;承認版のみ/D20」）。
 *
 * - PER-11（閲覧。承認版は全員が見える＝docs/05 API-58「担当外は承認版だけが見える」と同じ）。
 * - **承認版のみ**: 承認済pointer（current_approved_version_id）が無い帳票は404
 *   （存在も出力もしない。docs/05「未承認はnot 200」。API-58の「承認版が無い場合は存在も明かさない」と同じ区分）。
 * - 出力の原本は「承認時に確定した値」: 数値（活動名・参加人数・実施日時）はreview_decisionsの
 *   confirmed_payloadに固定したサーバー計算値を使い、元実績の後続変更で書変わらない（docs/16 T058）。
 *   人的本文（text）・作成者/承認者の表示名は版と決定行から解決する。
 * - 応答はbinary/CSVでJSON envelopeの外（docs/05 §1）。Content-TypeとContent-Dispositionは
 *   ここで決め、本文の組み立てはrenderReport（src/server/reports/render.ts）に任せる。
 */
export function registerReportContentRoutes(app: ApiApp): void {
  // --- API-61: 承認版のPDF/CSV出力 ---
  defineRoute(app, "API-61", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, query } = await parseApiRequest(c, "API-61");
    requirePermission(p, "PER-11", { unitId: p.unitId, type: "report", id: params.id });

    const report = await c.env.DB.prepare("SELECT id, unit_id, created_by, current_approved_version_id FROM reports WHERE id = ?")
      .bind(params.id).first<{ id: string; unit_id: string; created_by: string | null; current_approved_version_id: string | null }>();
    if (!report || report.unit_id !== p.unitId || !report.current_approved_version_id) throw new HttpError("NOT_FOUND");

    const version = await c.env.DB.prepare(
      "SELECT id, report_id, template_version, revision_no, text, status, approved_at FROM report_versions WHERE id = ? AND unit_id = ?",
    ).bind(report.current_approved_version_id, p.unitId)
      .first<{ id: string; report_id: string; template_version: string; revision_no: number; text: string; status: string; approved_at: string | null }>();
    // pointerは同親のapproved版のみを指す（approveが同batchで保証。崩れているのは復旧が必要な不整合）
    if (!version || version.report_id !== report.id || version.status !== "approved" || version.approved_at === null) {
      throw new HttpError("INTERNAL_ERROR");
    }

    // 承認時に確定した値（決定行はapproveと同batchで作る。無いのは不整合）
    const decision = await c.env.DB.prepare(
      "SELECT confirmed_payload, reviewer_member_id FROM review_decisions WHERE unit_id = ? AND report_version_id = ?",
    ).bind(p.unitId, version.id).first<{ confirmed_payload: string; reviewer_member_id: string }>();
    if (!decision) throw new HttpError("INTERNAL_ERROR");
    const payload = JSON.parse(decision.confirmed_payload) as {
      computed?: Record<string, string>;
    };

    const creatorName = report.created_by
      ? (await c.env.DB.prepare("SELECT display_name FROM members WHERE unit_id = ? AND user_id = ?")
          .bind(p.unitId, report.created_by).first<{ display_name: string }>())?.display_name ?? null
      : null;
    const approverName = (await c.env.DB.prepare("SELECT display_name FROM members WHERE unit_id = ? AND id = ?")
      .bind(p.unitId, decision.reviewer_member_id).first<{ display_name: string }>())?.display_name ?? null;

    const approved: ApprovedReportVersion = {
      templateVersion: version.template_version,
      revisionNo: version.revision_no,
      text: version.text,
      approvedAt: version.approved_at,
      computedFields: payload.computed ?? {},
      creatorName,
      approverName,
    };
    const body = await renderReport(approved, query.format);
    const ext = query.format === "pdf" ? "pdf" : "csv";
    // 機微内容を共有キャッシュへ残さず、危険形式はダウンロードさせる（attachments.tsと同じ流儀）
    return new Response(body, {
      headers: {
        "content-type": query.format === "pdf" ? "application/pdf" : "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="report-${report.id}-r${version.revision_no}.${ext}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
}
