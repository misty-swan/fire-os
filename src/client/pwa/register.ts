/**
 * PWAの登録・更新案内・logout時の消去入口（T074、docs/07 §4・D14）。
 *
 * - Service Workerは本番ビルドだけで登録する（devでは sw.js が作られない。vite.pwa.config.ts 参照）。
 * - precacheは静的shellのみ。/api/*・認証・添付・Google資産はcacheしない（その設計は sw.ts の責務）。
 * - 新しい版は勝手に適用しない。待機に入ったら PWA_UPDATE_AVAILABLE を上げ、利用者が「更新」を押したら
 *   SKIP_WAITING を送る。ページは再読込しないので未保存の入力は消えない（次回起動から新版）。
 */

/** 待機中の新しい版ができた（案内を出してよい）。detail無し */
export const PWA_UPDATE_AVAILABLE = "fireos:pwa-update-available";
/** 新しい版がこのページを引き継いだ（controllerchange）。再読込はしていない */
export const PWA_UPDATE_APPLIED = "fireos:pwa-update-applied";

/** アプリ起動時に一度だけ呼ぶ（main.tsx）。失敗しても通常のWebアプリとして動かす */
export async function registerPwa(): Promise<void> {
  if (import.meta.env.DEV || !("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });

    // 待機中の新しい版がいたら案内する。ただし適用が効くのは制御されているページだけ。
    // 初回installのときはまだ制御されていないので案内しない（次回の起動で案内になる）
    const announce = () => {
      if (registration.waiting && navigator.serviceWorker.controller) {
        window.dispatchEvent(new CustomEvent(PWA_UPDATE_AVAILABLE));
      }
    };
    announce();
    registration.addEventListener("updatefound", () => {
      // installingは「installed」へ移る瞬間にwaitingへ移って registration.installing がnullになる。
      // そのためworkerの参照を先に受けて、そのworkerのstatechangeを見る
      const installing = registration.installing;
      installing?.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          window.dispatchEvent(new CustomEvent(PWA_UPDATE_AVAILABLE));
        }
      });
    });

    // 新しい版が引き継いだら案内を「更新しました」へ切り替える。再読込はしない。
    // ただし初回installでもclientsClaimでcontrollerchangeが起きるため、
    // もともと制御されていたページ（＝更新の引き継ぎ）だけを案内にする
    let wasControlled = navigator.serviceWorker.controller != null;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (wasControlled) window.dispatchEvent(new CustomEvent(PWA_UPDATE_APPLIED));
      wasControlled = true;
    });
  } catch {
    // 登録できない環境（古いブラウザ等）でもアプリは使える。案内だけ出ない
  }
}

/** 案内の「更新」ボタンから呼ぶ。待機中の新しい版を起動する（再読込は伴わない） */
export async function applyPwaUpdate(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
}

/**
 * ログアウト時の消去の入口として用意したもの（T074）。**T075ではlogout経路には繋いでいない**: 生きた
 * Service Workerが削除済みのprecacheを見続けるため、logout直後の完全読込が壊れる（e2eで確認。
 * src/client/offline/lifecycle.ts の purgeForLogout のコメントに根拠を記録）。precacheは静的shellだけで
 * 機微データは無い。設計が変わって明示的に消したいとき（shell差し替え等）のためだけに残す。
 */
export async function purgeUserCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  const names = await caches.keys();
  await Promise.all(names.filter((n) => n.startsWith("workbox-precache")).map((n) => caches.delete(n)));
}
