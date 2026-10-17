import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// クライアント(React)のビルド設定。サーバー(Workers)は wrangler が src/server/index.ts を直接バンドルする。
// PWA(sw.js)は vite.pwa.config.ts（npm run build だけが使う。devではService Workerを立てない）。
export default defineConfig({
  root: "src/client",
  // リポジトリ直下 public/ の静的資産（manifest.webmanifest・icons）を dist/client へ複製する（T074）。
  // URLはconfigファイル(リポジトリ直下)起点になるので ./public。root(src/client)起点ではない
  publicDir: new URL("./public", import.meta.url).pathname,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  build: { outDir: "../../dist/client", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
