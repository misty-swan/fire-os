import { useEffect, useRef } from "react";
import { useBlocker } from "react-router";
import { Button } from "./ui";

/**
 * 未保存の変更があるとき、画面を離れる前に確認する。
 * ・アプリ内の移動：確認ダイアログ（既定は「編集に戻る」）。閉じたら元の操作位置へフォーカスを戻す
 * ・タブを閉じる/再読込：ブラウザ標準の確認(beforeunload)
 */
export function useUnsavedChangesGuard(dirty: boolean) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);
  return blocker;
}

export function LeaveConfirm({ dirty }: { dirty: boolean }) {
  const blocker = useUnsavedChangesGuard(dirty);
  const open = blocker.state === "blocked";
  const stayRef = useRef<HTMLButtonElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      stayRef.current?.focus();
    } else if (returnTo.current) {
      returnTo.current.focus(); // 閉じたら、押す前にいた場所へ戻す
      returnTo.current = null;
    }
  }, [open]);

  if (!open) return null;
  return (
    // スマホ: prototype の出欠シート（下から、取っ手、上端の光沢）。PC: リマインドモーダル（560px、26px角丸、ぼかし幕）
    <div
      onClick={() => blocker.reset()} // 幕を押したら既定（編集に戻る）
      className="fixed inset-0 z-[100] flex animate-[fo-in_.2s_ease_both] items-end lg:animate-[fo-fade_.2s_ease_both] justify-center bg-[rgba(3,6,12,.6)] lg:items-center lg:bg-[rgba(3,6,12,.65)] lg:backdrop-blur-[4px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-title"
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); blocker.reset(); } }}
        className={
          "w-full animate-[fo-in_.3s_ease_both] rounded-t-[30px] lg:animate-[fo-in-desktop_.3s_cubic-bezier(.2,.8,.2,1)_both] bg-[#0f1828] px-5 pb-[34px] pt-3 shadow-[inset_0_1px_0_rgba(255,255,255,.1)] " +
          "lg:flex lg:w-[560px] lg:max-w-[calc(100vw-40px)] lg:flex-col lg:gap-4 lg:rounded-[26px] lg:p-6 lg:shadow-[inset_0_0_0_1px_rgba(255,255,255,.1),0_40px_80px_rgba(0,0,0,.6)]"
        }
      >
        <div aria-hidden="true" className="mx-auto mb-4 h-1 w-10 rounded-sm bg-white/[.18] lg:hidden" />
        <div className="flex flex-col gap-1">
          <h2 id="leave-title" className="text-[18px] font-bold lg:text-[19px]">
            保存されていない変更があります
          </h2>
          <p className="text-[12px] font-medium text-ink-muted">このまま移動すると、入力した内容は失われます。</p>
        </div>
        <div className="mt-4 flex flex-col gap-2 lg:mt-0 lg:flex-row-reverse lg:justify-start lg:pt-1">
          <Button ref={stayRef} onClick={() => blocker.reset()} className="lg:h-[46px] lg:w-auto lg:px-[22px] lg:text-[13px] lg:shadow-none">
            編集に戻る
          </Button>
          <Button variant="secondary" onClick={() => blocker.proceed()} className="lg:h-[46px] lg:w-auto lg:bg-white/[.07] lg:px-5 lg:text-[13px] lg:hover:bg-white/[.07]">
            保存せずに移動する
          </Button>
        </div>
      </div>
    </div>
  );
}
