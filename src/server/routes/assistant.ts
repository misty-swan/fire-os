import { proposeAssistantAction } from "../ai/assistant";
import { defineRoute, ok, parseApiRequest, type ApiApp } from "../http";

/**
 * 業務横断AIの提案API（T068、docs/05 API-77 POST /ai/assistant）。proposeAssistantAction
 * （src/server/ai/assistant.ts）への薄い接続点。API-31（ai-decisions.ts）と同じ分離。
 * 読取の境界・生成・構造検証・冪等・保存の本体はassistant.tsの文書を参照。
 */
export function registerAssistantRoutes(app: ApiApp): void {
  // --- API-77: 横断読取＋承認前の書込提案（200=提案をai_evaluations候補として保存） ---
  defineRoute(app, "API-77", async (c) => {
    const input = await parseApiRequest(c, "API-77");
    const data = await proposeAssistantAction(c, input);
    return ok(c, data);
  });
}
