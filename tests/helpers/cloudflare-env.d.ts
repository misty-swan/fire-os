// 試験で env(cloudflare:workers) から見えるbindingの型。wrangler.jsonc と vitest.config.ts の設定に対応する。
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    /** 空DBからのmigration適用を確認する試験用の2つ目のD1 */
    DB_FRESH: D1Database;
    FILES: R2Bucket;
    JOBS_QUEUE: Queue<{ jobId: string }>;
    ASSETS: Fetcher;
    APP_ENV: "local" | "demo" | "staging" | "production";
    TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  }
}
