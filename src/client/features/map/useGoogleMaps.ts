import { useEffect, useState } from "react";

/**
 * Google Maps JS APIの動的ローダー（V05。docs/14）。
 * キー（VITE_GOOGLE_MAPS_API_KEY）はviteがビルド時に値へ差し替える。リポジトリの既定は空＝
 * キーが無い環境では何もせず loaded:false・error:null のまま（呼び出しは無害。置き換え絵のまま、
 * ローカル・試験・e2eも不変）。ロードはモジュール単位の単一Promise（scriptの二重挿入をしない）。
 * 失敗は2系統: 認証・quota（Maps側が gm_authFailure を呼ぶ。script挿入の**前**に置く）と
 * script自体の読み込み失敗（onerror）。解決は地図callback（__fireosMapsCallback）待ち＝
 * ネットワーク到達性に依存しない設計で、jsdomの試験はcallbackを手動発火して進められる。
 */

const CALLBACK_NAME = "__fireosMapsCallback";

interface MapsLoad {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: Error) => void;
}

let mapsLoad: MapsLoad | null = null;

/** 単一ロードの状態を戻す（試験用。試験の間でscriptの挿入とPromiseを片付けるためのもの） */
export function resetGoogleMapsLoaderForTests(): void {
  mapsLoad = null;
}

function startMapsLoad(key: string): Promise<void> {
  if (mapsLoad) return mapsLoad.promise;
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  mapsLoad = { promise, resolve, reject };

  // 認証失敗（キーの誤り・ドメイン制限・quota）はMaps側が gm_authFailure を呼ぶ。scriptを挿入する前に置く
  const w = window as unknown as Record<string, unknown> & { gm_authFailure?: () => void };
  w.gm_authFailure = () => reject(new Error("auth"));

  const script = document.createElement("script");
  script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=${CALLBACK_NAME}&loading=async&language=ja&region=JP`;
  script.async = true;
  script.onerror = () => reject(new Error("network"));
  document.head.appendChild(script);

  w[CALLBACK_NAME] = () => resolve();
  return promise;
}

/** Maps JS APIの読み込み状態。キーが無い環境では loaded:false・error:null のまま変化しない */
export function useGoogleMaps(): { loaded: boolean; error: string | null } {
  const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!key) return; // キーが無い環境ではscriptを挿入しない（無害）
    let alive = true;
    startMapsLoad(key).then(
      () => {
        if (alive) setLoaded(true);
      },
      (e: Error) => {
        if (alive) setError(e.message);
      },
    );
    return () => {
      alive = false;
    };
  }, [key]);

  return { loaded, error };
}
