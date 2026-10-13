import { Hono } from "hono";
import { assertEnvName, type AppBindings, type AppEnv, type JobMessage } from "./env";
import { handleQueueBatch, handleScheduled } from "./jobs/dispatch";
import { errorResponse, notFound, onError } from "./http";
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

  // 他originからの変更要求を拒否する（CSRF対策。Cookieは SameSite=Lax だが、Originも二重に見る）。
  // ブラウザは変更要求にOriginを付ける。Originが無い場合は sec-fetch-site が cross-site でないことを要求する。
  app.use("/api/*", async (c, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      const trusted = new URL(c.env.AUTH_BASE_URL).origin;
      const crossSite = origin ? origin !== trusted : c.req.header("sec-fetch-site") === "cross-site";
      if (crossSite) return errorResponse(c, "FORBIDDEN", [{ field: "origin", reason: "cross_origin" }]);
    }
    await next();
  });

  registerRoutes(app);

  // 未定義のAPI。HTML(SPA)を返さず、共通のJSONエラー形式で終わる。
  app.all("/api/*", (c) => notFound(c));
  app.onError(onError);

  app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
  return app;
}

export default {
  fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Response | Promise<Response> {
    return createApp(env).fetch(request, env, ctx);
  },
  /** Cron（毎分）。永続ジョブの回収と実行 */
  async scheduled(_controller: ScheduledController, env: AppEnv, _ctx?: ExecutionContext): Promise<void> {
    await handleScheduled(env);
  },
  /** Queues。job IDの合図でジョブを実行する */
  async queue(batch: MessageBatch<JobMessage>, env: AppEnv, _ctx?: ExecutionContext): Promise<void> {
    await handleQueueBatch(batch, env);
  },
} satisfies ExportedHandler<AppEnv, JobMessage>;
