import { answerRag } from "../search/rag";
import { defineRoute, ok, parseApiRequest, type ApiApp } from "../http";

/**
 * RAG検索（API-76 POST /search/rag。T067、docs/05 API-76）。
 * 読み取り専用POSTのためIdempotency-Keyは不要（docs/05 §2「API-76（検索のPOST）は永続変更を伴わないため不要」）。
 * 認可・検索・生成・引用検証・出力前ACL再検査・保存の本体はsrc/server/search/rag.ts（answerRag）。
 */
export function registerRagRoutes(app: ApiApp): void {
  defineRoute(app, "API-76", async (c) => {
    const input = await parseApiRequest(c, "API-76");
    const data = await answerRag(c, input);
    return ok(c, data);
  });
}
