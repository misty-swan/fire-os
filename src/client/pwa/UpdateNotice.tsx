import { useEffect, useState } from "react";
import { Icon } from "../components/ui";
import { PWA_UPDATE_APPLIED, PWA_UPDATE_AVAILABLE, applyPwaUpdate } from "./register";

/**
 * Service Workerの更新案内（T074）。prototypeには無いPWAのchrome（docs/03 §1.1-21）。
 * 新しい版が待機に入ったら出て、「更新」を押すと引き継ぐ。再読込はしないので未保存の入力は消えない。
 */
export function PwaUpdateNotice() {
  const [state, setState] = useState<"idle" | "available" | "applied">("idle");

  useEffect(() => {
    const available = () => setState("available");
    const applied = () => setState("applied");
    window.addEventListener(PWA_UPDATE_AVAILABLE, available);
    window.addEventListener(PWA_UPDATE_APPLIED, applied);
    return () => {
      window.removeEventListener(PWA_UPDATE_AVAILABLE, available);
      window.removeEventListener(PWA_UPDATE_APPLIED, applied);
    };
  }, []);

  // 案内を出す前に待機workerができていたケース（起動直後の取りこぼし）も拾う。dev/jsdomでは何もしない
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg?.waiting && navigator.serviceWorker.controller) setState("available");
    });
  }, []);

  // 「更新しました」は置いておくと邪魔なので10秒で引っ込める
  useEffect(() => {
    if (state !== "applied") return;
    const timer = setTimeout(() => setState("idle"), 10_000);
    return () => clearTimeout(timer);
  }, [state]);

  if (state === "idle") return null;
  return (
    <div
      role="status"
      data-testid="pwa-update-notice"
      // 位置はトースト帯の**上**（docs/03 §1.1-21）: トーストは画面ごとに下端100/110/160px・PCは下端28pxの
      // z-[120]で出るため、下端96pxの帯では「更新」ボタンがトーストに覆われる。全画面共通の案内なので、
      // 最も高いトースト帯（ホーム/AIの160px）＋トースト高さの上（スマホ224px・PC 84px）に置いて
      // どの画面のトーストとも重ならない。z-indexはトースト（120）・メニュー系（100/110）・dialogより下の60のまま
      className="fixed bottom-[224px] left-1/2 z-[60] flex min-h-11 -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-pill bg-surface py-2 pl-4 pr-2 text-[12px] font-bold shadow-[inset_0_0_0_1px_rgba(255,255,255,.1),0_12px_30px_rgba(0,0,0,.5)] lg:bottom-[84px]"
    >
      <Icon name="system_update_alt" className="flex-none text-[18px] text-ok" />
      {state === "available" ? (
        <>
          <span>FireOSの新しい版があります</span>
          <button
            type="button"
            onClick={() => void applyPwaUpdate()}
            className="flex min-h-11 items-center rounded-pill bg-ember px-3.5 text-[12px] font-bold text-white lg:min-h-9"
          >
            更新
          </button>
        </>
      ) : (
        <span className="pr-2">更新しました。次回の起動から新しい版を使います</span>
      )}
    </div>
  );
}
