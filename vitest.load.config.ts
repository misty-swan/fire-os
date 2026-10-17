import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

/**
 * 負荷試験（T082）のrunner。`npm run test:load` で実行する。
 *
 * - 実workerd＋実D1エンジン上で代表件数のseedと測定を行う（workers試験と同じ基盤）。
 *   既存の workers/client プロジェクトから tests/load を除外済み（vitest.config.ts）なので、
 *   `npx vitest --run` で二重実行されない。timeoutは規定より長く（seedが代表件数を作るため）。
 * - globalSetup（SPAのビルド）は不要: 負荷試験は /api/* のJSONだけを叩く（SPA配信は試さない）。
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations("./drizzle");
  return {
    test: {
      name: "load",
      include: ["tests/load/**/*.test.ts"],
      exclude: ["tests/e2e/**", "tests/live/**"],
      environment: "node",
      // 1テストの上限を10分に（controller裁定6: 1本が10分を超えるならprofileでなく設計を見直す）。
      // 実際の各テストはこれより大幅に短い（docs/evidence/V07-performance.mdに実測時間を記録）。
      testTimeout: 600_000,
      hookTimeout: 600_000,
      // ファイル間で並列にしない（各ファイルが代表件数のseed＋30端末の負荷を作るため1本ずつ測る）
      fileParallelism: false,
    },
    resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_AUTH: "1",
            BETTER_AUTH_SECRET: "dev-only-test-secret-0123456789abcdef0123456789",
            AUTH_BASE_URL: "http://example.com",
            // 負荷試験のai bucketは、localで決定的に動くfake AI（src/server/ai/local-fake.ts）で
            // 検索→引用検証→保存までの全経路を測る（実モデルの遅延は含まない＝V07の限界節）。
            // e2e（playwright.config.tsのwebServer）と同じ試験専用の変数。本番環境の設定には置かない
            TEST_AI_FAKE: "1",
          },
          d1Databases: { DB_FRESH: "fireos-fresh-test" },
        },
      }),
    ],
  };
});
