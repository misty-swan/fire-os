import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";

// 試験は2系統：
//  workers = 本物のworkerd(Workers実行環境)＋D1/Queues上で動くサーバー試験
//  client  = jsdom上で動くReact試験
const alias = { "@": new URL("./src", import.meta.url).pathname };

export default defineConfig(async () => {
  // drizzle/*.sql を読み、試験のD1へ適用できる形で binding(TEST_MIGRATIONS) に渡す
  const migrations = await readD1Migrations("./drizzle");
  return {
    test: {
      projects: [
        {
          resolve: { alias },
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              remoteBindings: false,
              miniflare: {
                // TEST_AUTH=1 は試験でだけ x-test-identity による認証注入を許す（本番/staging/demoのwranglerには置かない）
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  TEST_AUTH: "1",
                  BETTER_AUTH_SECRET: "dev-only-test-secret-0123456789abcdef0123456789",
                  AUTH_BASE_URL: "http://example.com",
                },
                // 空DBから適用する試験用の2つ目のD1
                d1Databases: { DB_FRESH: "fireos-fresh-test" },
              },
            }),
          ],
          test: {
            name: "workers",
            include: ["tests/**/*.test.ts"],
            // offline-store（T075の端末下書き）はjsdom＋fake-indexeddbのclient側試験なのでworkersで動かさない
            // tests/load（T082の負荷試験）は vitest.load.config.ts（npm run test:load）で動かす。ここで動かすと
            // 代表件数のseedが正規スイートに乗って遅くなるため除外する（二重実行・タイムアウト事故の防止）
            exclude: ["tests/e2e/**", "tests/live/**", "tests/load/**", "tests/offline-store.test.ts"],
            globalSetup: ["./tests/helpers/build-client.ts"],
          },
        },
        {
          resolve: { alias },
          plugins: [react()],
          test: {
            name: "client",
            environment: "jsdom",
            // tests/offline-store.test.ts（T075 端末下書き）はReactを使わないがjsdom＋IndexedDBの試験なのでclient側で動かす
            include: ["tests/**/*.test.tsx", "tests/offline-store.test.ts"],
            setupFiles: ["./tests/helpers/client-setup.ts"],
          },
        },
      ],
    },
  };
});
