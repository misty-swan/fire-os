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
                bindings: { TEST_MIGRATIONS: migrations, TEST_AUTH: "1" },
                // 空DBから適用する試験用の2つ目のD1
                d1Databases: { DB_FRESH: "fireos-fresh-test" },
              },
            }),
          ],
          test: {
            name: "workers",
            include: ["tests/**/*.test.ts"],
            exclude: ["tests/e2e/**", "tests/live/**"],
            globalSetup: ["./tests/helpers/build-client.ts"],
          },
        },
        {
          resolve: { alias },
          plugins: [react()],
          test: {
            name: "client",
            environment: "jsdom",
            include: ["tests/**/*.test.tsx"],
            setupFiles: ["./tests/helpers/client-setup.ts"],
          },
        },
      ],
    },
  };
});
