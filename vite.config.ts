import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// クライアント(React)のビルド設定。サーバー(Workers)は wrangler が src/server/index.ts を直接バンドルする。
export default defineConfig({
  root: "src/client",
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  build: { outDir: "../../dist/client", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
