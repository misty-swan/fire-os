import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";

// 試験は2系統：
//  workers = 本物のworkerd(Workers実行環境)＋D1/Queues上で動くサーバー試験
//  client  = jsdom上で動くReact試験
const alias = { "@": new URL("./src", import.meta.url).pathname };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, remoteBindings: false })],
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
});
