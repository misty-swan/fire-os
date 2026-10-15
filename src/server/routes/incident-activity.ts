import type { ApiApp } from "../http";
import { defineRoute, ok, parseApiRequest } from "../http";
import { linkIncidentActivity } from "../operations/link";

/**
 * 出動と既存活動のリンク（T043、docs/05 API-71、docs/04:103、docs/11、docs/14 D08）。
 * 検査と確定は共通関数linkIncidentActivity（operations/link.ts）へ集約し、API-22の
 * 作成時リンク（routes/incidents.ts）と同じ規則（一活動一出動・両root版・使用移管）を適用する。
 * 応答はdocs/05 API-71行どおりIncident＋OperationLink（T043でprovisionalから厳格化）。
 */
export function registerOperationLinkRoutes(app: ApiApp): void {
  defineRoute(app, "API-71", async (c) => {
    const input = await parseApiRequest(c, "API-71");
    const data = await linkIncidentActivity(c, input);
    return ok(c, data);
  });
}
