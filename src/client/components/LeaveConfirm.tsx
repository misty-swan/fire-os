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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgba(3,6,12,.6)] lg:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="leave-title"
        onKeyDown={(e) => e.key === "Escape" && blocker.reset()}
        className="w-full max-w-[560px] rounded-t-[30px] bg-[#0f1828] p-6 lg:rounded-[26px]"
      >
        <h2 id="leave-title" className="text-[18px] font-bold">
          保存されていない変更があります
        </h2>
        <p className="mt-2 text-[14px] text-ink-sub">このまま移動すると、入力した内容は失われます。</p>
        <div className="mt-5 flex flex-col gap-3">
          <Button ref={stayRef} onClick={() => blocker.reset()}>
            編集に戻る
          </Button>
          <Button variant="secondary" onClick={() => blocker.proceed()}>
            保存せずに移動する
          </Button>
        </div>
      </div>
    </div>
  );
}
