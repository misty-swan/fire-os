import type { Hono } from "hono";
import type { AppBindings } from "./env";

// APIルートの登録点。各ドメインのroute登録関数を後続タスクがここへ追加する。
export function registerRoutes(_app: Hono<AppBindings>): void {
  // T006: registerJobRoutes(app)
}
