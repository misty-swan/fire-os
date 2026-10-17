/**
 * FireOS の Service Worker（T074、docs/07 §4「PWA・GPS・オフライン同期」・D14）。
 *
 * cacheするのは**静的shellだけ**（vite.pwa.config.ts の globPatterns：index.html / JS / CSS /
 * manifest.webmanifest / icons）。それ以外の要求はどのhandlerも置かないので、そのまま通信に流れる:
 *  - /api/* の応答（認証・名簿・RAG回答・添付本文を含む）は一切cacheしない
 *  - Google（fonts / maps.googleapis / gstatic 等）の資産はcross-originなので対象外（同一originだけ扱う）
 *  - offline時に起動するのはshellだけで、取得していない業務データは表示しない（未取得を偽装しない: docs/03）。
 *    取れないものは各画面が正直に失敗を示す（MeGateの「利用者情報を取得できません」等）
 *
 * 更新は勝手に適用しない。新しい版がinstallして待機に入ったら、クライアント(src/client/pwa/register.ts)
 * が案内を出し、利用者が「更新」を選んだときだけ SKIP_WAITING を受けて引き継ぐ。引き継ぎ後もページを
 * 再読込しないので、未保存の入力は消えない（docs/07 §4「PWA更新は未同期データを消さない」。次回起動から新版）。
 */
/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute, type PrecacheEntry } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: PrecacheEntry[] };

// 静的shellのprecache（一覧は vite.pwa.config.ts の globPatterns で決まる）
precacheAndRoute(self.__WB_MANIFEST);
// 旧版のprecache cacheを掃除する（旧shell整理）
cleanupOutdatedCaches();

// SPAのnavigationはprecacheしたindex.htmlで起動する。workboxの既定で同一originだけを扱い、
// /api/* はdenylistで明示的に外す（offlineに /api を開いてもHTMLを偽って返さない）
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), {
    denylist: [/^\/api\//],
  }),
);

// 新しい版がactivateしたら、開いているページも引き受ける（再読込はしない。入力はそのまま残る）
clientsClaim();

// 利用者が「更新」を選んだときだけ、待機していた新しい版を起動する
self.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | null)?.type === "SKIP_WAITING") self.skipWaiting();
});
