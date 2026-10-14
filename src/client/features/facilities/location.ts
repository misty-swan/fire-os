/** 施設の位置まわり（T022、docs/03 §4、D08/D09）。 */

export interface LocationInput {
  latitude: number;
  longitude: number;
}

/**
 * 外部経路（MAP-09）。GoogleマップのURLを開くだけで、API呼び出しは追加しない（docs/07 §6）。
 * 送る座標は画面に明示する（docs/03 §4「外部送信座標を提示し」）。
 */
export function buildMapsUrl(location: LocationInput): string {
  const destination = `${location.latitude},${location.longitude}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}

/**
 * GPSは利用者の明示操作での一回取得だけ（docs/03 §4「常時追跡・自動上書きをしない」）。
 * watchPositionは使わない。拒否・timeout・低精度は手入力へ落ちる。
 */
export function getCurrentPosition(options: { timeoutMs?: number } = {}): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("unsupported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: options.timeoutMs ?? 10_000,
      maximumAge: 0,
    });
  });
}
