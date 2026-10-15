import { decideAiProposal } from "../ai/review";
import { defineRoute, ok, parseApiRequest, type ApiApp } from "../http";

/**
 * AI提案の決定API（T054、docs/05 API-31）。decideAiProposal（src/server/ai/review.ts）への
 * 薄い接続点。API-29/30（ai-classification.ts）と同じ登録点からWorkerへ読み込まれる。
 * 決定・効果・stale検査の本体はreview.tsの文書を参照。
 */
export function registerAiDecisionRoutes(app: ApiApp): void {
  // --- API-31: 確認・修正・却下と一回限りの業務反映（200=同batchで確定完了） ---
  defineRoute(app, "API-31", async (c) => {
    const input = await parseApiRequest(c, "API-31");
    const data = await decideAiProposal(c, input);
    return ok(c, data);
  });
}
