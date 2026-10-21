import type { AppEnvName } from "../env";

/**
 * demo環境だけHTML（document）応答へ付けるContent-Security-Policy（T089 計画Task 6。
 * docs/superpowers/plans/2026-10-21-public-demo-miyanoura.md Task 6、設計書§4「SPAへのCSPは今回つける」）。
 *
 * - 許可リストは計画Task 6ブリーフの原文どおり。出典は実コード:
 *   - `https://maps.googleapis.com`（script/connect/img）: 地図の動的ロード（src/client/features/map/useGoogleMaps.ts。
 *     キー有りのbuildだけMapPageが読む）とMaps JS API内部のfetch。imgの `https://*.googleapis.com`
 *     `https://maps.gstatic.com` は地図タイル。
 *   - `https://fonts.googleapis.com`（style）と `https://fonts.gstatic.com`（font）: Google Fonts
 *     （src/client/index.html。prototypeどおりZen Kaku Gothic New / IBM Plex Mono / Material Symbols）。
 *   - `blob:` `data:`（img）: 写真・添付のプレビュー（URL.createObjectURL。src/client/features/attachments/AttachmentUploader.tsx ほか）。
 * - 既定の締め方は既存のAPI共通CSP（security/headers.ts。default-src 'none'; frame-ancestors 'none';
 *   base-uri 'none'）と同じ姿勢に合わせ、document用に `default-src 'self'` をfallbackに置く
 *   （クライアントにiframe/object/embed/audio/video/<base>は無い。grepで確認済み。'none'だと
 *   same-origin資産が全て死ぬため 'self'）。'unsafe-eval' は持たない（production Reactに不要。
 *   dev viteが要るのはlocal=localにCSP無しのため無関係）。
 * - local / staging / production は付けない（localは試験・e2e不変の契約。staging/productionは
 *   実CDN/WAF層との役割分担をT086で確定させる。docs/evidence/security.md §6の限界節）。
 */

/** ポリシー文字列を生成する純関数。mapsEnabled=falseは地図系の許可だけ外す（fonts系は残す＝③）。 */
export function cspHeaderValue(env: { mapsEnabled: boolean }): string {
  const maps = env.mapsEnabled;
  return [
    "default-src 'self'",
    maps ? "script-src 'self' https://maps.googleapis.com" : "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    maps ? "img-src 'self' data: blob: https://*.googleapis.com https://maps.gstatic.com" : "img-src 'self' data: blob:",
    "worker-src 'self'",
    maps ? "connect-src 'self' https://maps.googleapis.com" : "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
}

/**
 * 静的配信（ASSETS.fetch）の応答へ、demoのHTML（document）だけCSPを足す。
 *
 * - content-typeが text/html の応答だけが対象（SPAのdocument。subresourceのjs/css/画像には
 *   CSPは要らない=最小面。documentのCSPがそのpageの読み込みを統制する）。
 * - headersはcopyしてから付ける（ASSETSの応答を直接書き換えない。bodyはstreamのまま受け渡す）。
 * - attach側のmapsEnabledは常にtrue: demoはMapsキー（VITE_GOOGLE_MAPS_API_KEY）入りのbuildで
 *   配信される（ops/demo-provisioning.md。Task 7のビルド手順）。キー無しbuildでもこの許可は
 *   不活性（クライアントがキー有りのときしかMapsを読まない。MapPageの分岐）。
 *   キー無しで配信する場合はこの呼び出しを cspHeaderValue({ mapsEnabled: false }) に差し替える。
 */
export function responseWithDemoCsp(appEnv: AppEnvName, response: Response): Response {
  if (appEnv !== "demo") return response;
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("text/html")) return response;
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", cspHeaderValue({ mapsEnabled: true }));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
