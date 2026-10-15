import { decideReportVersion } from "../reports/decision";
import { defineRoute, ok, parseApiRequest, type ApiApp } from "../http";

/**
 * 報告書の申請・承認・差戻しAPI（T058、docs/05 API-60）。decideReportVersion
 * （src/server/reports/decision.ts）への薄い接続点。決定・events・元実績再検査の本体は
 * decision.tsの文書を参照（ai-decisions.tsと同じ登録点の形）。
 */
export function registerReportDecisionRoutes(app: ApiApp): void {
  // --- API-60: 申請（request_review）／差戻し（changes_requested）／承認（approve）。200=同batchで確定 ---
  defineRoute(app, "API-60", async (c) => {
    const input = await parseApiRequest(c, "API-60");
    const data = await decideReportVersion(c, input);
    return ok(c, data);
  });
}
