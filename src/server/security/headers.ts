import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../env";

/**
 * APIの全応答へ付ける共通security headers（T081、docs/07 §2「CSP/エスケープ、型/サイズ検証」）。
 *
 * - 既存機構との集約（controller裁定4）: Origin/CSRF検査は src/server/index.ts の既存middlewareが正本の
 *   まま（試験とe2eで担保済みのため移さない）。binary応答（添付API-27・帳票API-61）が独自に付ける
 *   Content-Type/Content-Disposition/nosniffは上書きしない（**値が無い場合だけ付ける**）。
 * - cache-control: no-store もここで一括して付ける（従来index.tsのOrigin middlewareが付けていたものを
 *   集約。個別routeがprivate,no-store等を既に設定している場合はそれを優先する）。
 * - SPA静的asset（ASSETS.fetch）は対象外。実CDN/WAF層の設定と併せてT086で確認する
 *   （docs/evidence/security.mdの限界節）。
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "cache-control": "no-store",
};

/** await next()の後に既存の応答へ足す（存在しない場合だけ。個別routeの設定を壊さない）。 */
export function securityHeaders(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
  };
}
