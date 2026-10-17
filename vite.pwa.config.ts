import { mergeConfig, defineConfig, type UserConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import baseConfig from "./vite.config";

/**
 * PWA（Service Worker）を含む本番ビルドの設定（T074）。
 *
 * - `npm run build`（= vite build --config vite.pwa.config.ts）だけが dist/client に sw.js を出す。
 *   `npm run dev` は vite.config.ts のままでService Worker無しにする（devでの二重cache・更新待ちを避ける）。
 * - 方式は injectManifest。SWの中身は src/client/pwa/sw.ts に書き、precache対象は静的shellだけに限定する
 *   （/api・認証・添付・Google資産は sw.ts の設計上そもそも経由しない。docs/07 §4・D14）。
 * - manifest.webmanifest と icons は public/ の静的ファイルをそのまま使う（プラグインには manifest: false を
 *   渡して二重生成しない。planのFilesどおり public/manifest.webmanifest が正本）。
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: [
      VitePWA({
        strategies: "injectManifest",
        srcDir: "pwa",
        filename: "sw.ts",
        // 登録は src/client/pwa/register.ts（registerPwa）が行う。自動注入させない
        injectRegister: false,
        manifest: false,
        injectManifest: {
          // precacheはビルド成果物＋public複製分（manifest/icons/favicon）のみ。sw.js自身は含めない
          globPatterns: ["**/*.{js,css,html,webmanifest,png,svg}"],
          globIgnores: ["**/node_modules/**/*", "sw.js"],
        },
      }),
    ],
  }),
) satisfies UserConfig;
