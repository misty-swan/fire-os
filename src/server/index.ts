import { Hono } from "hono";
import { assertEnvName, type AppBindings, type AppEnv, type JobMessage } from "./env";
import { handleQueueBatch, handleScheduled } from "./jobs/dispatch";
import { notFound, onError } from "./http";
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
