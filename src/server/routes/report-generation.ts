import { Job } from "../../shared/contracts/common";
import { resolvePrincipal } from "../auth/principal";
import type { AppEnv } from "../env";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { enqueueJob } from "../jobs/store";
import { REPORT_JOB_KIND, reportJobDedupeKey } from "../reports/generate";
import { getReportTemplate } from "../reports/templates";
import "../jobs/handlers/report"; // 報告書生成job handlerの登録（Cron/Queueと同じ登録点）
import { requirePermission } from "./invitations";

/**
 * 報告書下書き生成の依頼（API-32）（T057、docs/05 API-32、docs/06 §4、docs/10 PER-09、docs/14 D12）。
 *
 * - PER-09（送信許可）＋PER-01（入力元＝activityの読取権。AIで読める範囲を広げない＝docs/10 PER-09）。
 * - 様式はallowlist（docs/04 §3.5末尾「存在しない版は422」）、実績不在は422（API-62と同じ区分）、
 *   旧版は409（実行時にもhandlerが再検査する＝docs/06 §3）。
 * - 業務rootを持たないjob受付のためexecuteMutationを使わない（jobs.dedupe_keyが冪等の正本。
 *   docs/05 §2「AI job dedupeはAPI冪等キーと役割が異なる」。Idempotency-Keyは契約どおり必須で、
 *   同じ鍵の再送は同じdedupe_keyの既存jobを返す。T053のAPI-29と同じ流儀）。
 * - 202は受付であり報告書の完成ではない（docs/05 §1「202は業務完了と表示しない」。
 *   完成はAPI-86のjob状態とreports側で確認する。docs/03 SCR-19の語彙に記録）。
 * - dedupe_keyにはactivityVersionも含める（実行時のstale検査が「activity/resultの両方の版一致」を
 *   再構成比較で行えるようにするため。handlers/report.ts）。
 */
export function registerReportGenerationRoutes(app: ApiApp): void {
  defineRoute(app, "API-32", async (c) => {
    const p = await resolvePrincipal(c);
    const { body } = await parseApiRequest(c, "API-32");
    // allowlist外・hash不一致の様式版は受理しない（docs/04 §3.5末尾。templates.tsが422を投げる）
    await getReportTemplate(body.templateVersion);
    // 源の実在・同unit（存在しない/別unitは同じ404。存在を明かさない）
    const activity = await c.env.DB.prepare(
      "SELECT version, owner_member_id FROM activities WHERE id = ? AND unit_id = ?",
    ).bind(body.activityId, p.unitId).first<{ version: number; owner_member_id: string }>();
    if (!activity) throw new HttpError("NOT_FOUND");
    // PER-09（送信許可）＋入力元の読取権（docs/10 PER-09「入力元の全読取権＋送信許可。検索/生成で昇格しない」）
    requirePermission(p, "PER-09", { unitId: p.unitId, type: "activity", id: body.activityId, ownerMemberId: activity.owner_member_id });
    requirePermission(p, "PER-01", { unitId: p.unitId, type: "activity", id: body.activityId, ownerMemberId: activity.owner_member_id });
    // 実績の存在と版（旧版・並行更新は409。実績不在は422＝T056のAPI-62と同じ区分）
    const result = await c.env.DB.prepare(
      "SELECT version, current_revision_id FROM activity_results WHERE unit_id = ? AND activity_id = ?",
    ).bind(p.unitId, body.activityId).first<{ version: number; current_revision_id: string | null }>();
    if (!result?.current_revision_id) {
      throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "resultVersion", reason: "result_not_found" }]);
    }
    if (result.version !== body.resultVersion) throw new HttpError("VERSION_CONFLICT");

    // dedupe（docs/06 §3「同一元版＋質問版dedupe」のLLM側相当。様式版が質問版の位置）
    const job = await enqueueJob(c.env, {
      unitId: p.unitId,
      kind: REPORT_JOB_KIND,
      sourceType: "activity_result",
      sourceId: body.activityId,
      sourceVersion: body.resultVersion,
      configVersion: body.templateVersion,
      requestedBy: p.userId,
      dedupeKey: reportJobDedupeKey(p.unitId, body.activityId, activity.version, body.resultVersion, body.templateVersion),
    });
    return ok(c, Job.parse({ id: job.id, status: job.status, attempts: job.attempts, errorCode: job.errorCode, resultRef: job.resultRef }), {}, 202);
  });
}
