import type { ApiRequest } from "../../shared/contracts/registry";
import { queryActivities } from "../activities/query";
import { defineRoute, ok, type ApiApp } from "../http";

/**
 * API-05: 活動履歴の一覧検索（T038、docs/05 API-05「from/to/kind/memberId/status/limit/cursor;実参加検索はactual=true」）。
 * 認証・認可前置（PER-01）と入力の契約検証はqueryActivities内で行う（T039の活動画面・T047のホームのドリルダウンが
 * 同じ関数を再利用するため。docs/16 T038）。itemsをdataへ、続き取得キーをmeta.nextCursorへ載せる。
 */
export function registerActivityListRoutes(app: ApiApp): void {
  defineRoute(app, "API-05", async (c) => {
    // queryは生の文字列のまま渡し、検証（未知query・範囲外limitは400）はqueryActivities内のparseRequestで行う
    const raw = c.req.query();
    const result = await queryActivities(c, { query: raw as ApiRequest<"API-05">["query"] });
    return ok(c, result.items, { nextCursor: result.nextCursor });
  });
}
