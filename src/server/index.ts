import { Hono } from "hono";
import { assertEnvName, type AppBindings, type AppEnv } from "./env";
import { registerRoutes } from "./routes";

/**
 * アプリ本体。順序が重要：
 *  1. /api/* は必ずJSONで終わる(未実装APIをSPAのHTMLで成功に見せない)
 *  2. それ以外はReact(静的ファイル)。未知のURLはSPAのindex.html
 */
export function createApp(env: Pick<AppEnv, "APP_ENV">): Hono<AppBindings> {
  assertEnvName(env.APP_ENV);
  const app = new Hono<AppBindings>();

  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    await next();
    c.header("x-request-id", c.get("requestId"));
  });

  registerRoutes(app);

  // 未定義のAPI。HTML(SPA)を返さない。T002でhttp.tsの共通エラー形式へ置き換える。
  app.all("/api/*", (c) =>
    c.json(
      {
        error: { code: "NOT_FOUND", message: "APIが見つかりません", details: [] },
        meta: { requestId: c.get("requestId") },
      },
      404,
    ),
  );

  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}

export default {
  fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Response | Promise<Response> {
    return createApp(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<AppEnv>;
