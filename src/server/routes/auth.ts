import { authLibrary } from "../../shared/contracts/auth";
import { AUTH_BASE_PATH } from "../auth/config";
import { authServiceFor } from "../auth/adapter";
import { notFound, type ApiApp } from "../http";

const allowed = new Set(authLibrary.endpoints.map((e) => `${e.method} ${AUTH_BASE_PATH}${e.path}`));

/**
 * API-36: 認証ライブラリ(Better Auth)のhandler。base pathは /api/auth（業務の /api/v1 とは別）。
 * 業務のenvelope・Idempotency-Key対象外で、応答の形はライブラリの公式スキーマに従う。
 * 公開する経路は契約(authLibrary.endpoints)の一覧だけ。それ以外（プロフィール更新・アカウント削除・外部連携など、
 * ライブラリが持つが業務で使わない経路）は、有効にしたつもりがなくても届かないよう JSON 404 で終わらせる。
 * 自由なsign-upは設定（config.ts の hooks.before）で閉じている。
 */
export function registerAuthRoutes(app: ApiApp): void {
  app.all(`${AUTH_BASE_PATH}/*`, (c) => {
    const key = `${c.req.method} ${new URL(c.req.url).pathname.replace(/\/+$/, "")}`;
    if (!allowed.has(key)) return notFound(c);
    return authServiceFor(c.env).handle(c.req.raw);
  });
}
