import type { ApiApp } from "./http";
import { registerJobRoutes } from "./routes/jobs";

// APIルートの登録点。各ドメインのroute登録関数を後続タスクがここへ追加する。
export function registerRoutes(app: ApiApp): void {
  registerJobRoutes(app);
}
