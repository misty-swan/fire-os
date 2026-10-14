import { useEffect, useRef, type ReactNode } from "react";
import { clsx } from "clsx";
import { Button, Icon } from "./ui";

/**
 * 重ねて出す面（ドロワー/モーダル）の共通の挙動：Escapeで閉じる、開いたら中へフォーカス、閉じたら開いた操作へ戻す、
 * 背面はクリックで閉じる（prototype：背景 rgba(3,6,12,.55)、ドロワー440px、モーダル560px）。
 */
function useOverlay(onClose: () => void, initialFocus?: string) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  // Escで呼ぶ onClose は常に最新のもの（入力途中かどうかの確認を含む）にする。初回の関数を握り続けない
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEffect(() => {
    opener.current = document.activeElement;
    const target = initialFocus ? ref.current?.querySelector<HTMLElement>(initialFocus) : null;
    (target ?? ref.current?.querySelector<HTMLElement>("button, [href], input, textarea, select") ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") latestClose.current();
      // フォーカスを面の外へ出さない（Tabの循環）
      if (e.key === "Tab" && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')];
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      (opener.current as HTMLElement | null)?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

/** 右からのドロワー（スマホは全幅）。prototype 団員ドロワー：幅440px・背景#0b1424 */
export function Drawer({ label, eyebrow, onClose, children }: { label: string; eyebrow: string; onClose: () => void; children: ReactNode }) {
  const ref = useOverlay(onClose, "[data-close]");
  return (
    <>
      <div onClick={onClose} aria-hidden="true" className="fixed inset-0 z-[80] bg-[rgba(3,6,12,.55)] animate-[fo-fade_.2s_ease_both]" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="fo-scroll fixed inset-y-0 right-0 z-[81] w-full overflow-y-auto bg-[#0b1424] shadow-[-30px_0_60px_rgba(0,0,0,.5),inset_1px_0_0_rgba(255,255,255,.08)] animate-[fo-slide_.3s_cubic-bezier(.2,.8,.2,1)_both] sm:w-[440px]"
      >
        <div className="flex items-center justify-between px-6 py-5">
          <span className="font-mono text-[10px] font-semibold tracking-[.14em] text-ink-dim">{eyebrow}</span>
          <button type="button" data-close aria-label="閉じる" onClick={onClose} className="grid size-11 place-items-center rounded-[10px] bg-white/5 lg:size-9">
            <Icon name="close" className="text-[19px]" />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

/** 中央のモーダル。prototype リマインドモーダル：幅560px（画面幅-40px まで）・角丸26px */
export function Modal({ title, sub, onClose, children, wide, initialFocus }: { title: string; sub?: string; onClose: () => void; children: ReactNode; wide?: boolean; initialFocus?: string }) {
  const ref = useOverlay(onClose, initialFocus);
  return (
    <>
      <div onClick={onClose} aria-hidden="true" className="fixed inset-0 z-[90] bg-[rgba(3,6,12,.65)] backdrop-blur-[4px] animate-[fo-fade_.2s_ease_both]" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={clsx(
          "fo-scroll fixed left-1/2 top-1/2 z-[91] flex max-h-[calc(100dvh-32px)] w-[560px] max-w-[calc(100vw-40px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-[26px] bg-[#0f1828] p-6 shadow-[inset_0_0_0_1px_rgba(255,255,255,.1),0_40px_80px_rgba(0,0,0,.6)] animate-[fo-in_.3s_cubic-bezier(.2,.8,.2,1)_both]",
          wide && "sm:w-[640px]",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-[19px] font-bold">{title}</h2>
            {sub && <span className="text-[12px] text-ink-muted">{sub}</span>}
          </div>
          <button type="button" aria-label="閉じる" onClick={onClose} className="grid size-11 flex-none place-items-center rounded-[10px] bg-white/5 lg:size-9">
            <Icon name="close" className="text-[19px]" />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

/**
 * 危険な操作の確認。対象・理由・影響を示し、既定のフォーカスは「戻る」（誤操作で確定しない）。
 * 「実行する」は押した後も、保存結果が確定するまで二重に押せない（busy）。
 */
export function ConfirmDialog({
  title, confirmLabel, busy, onConfirm, onCancel, children, danger,
}: {
  title: string;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}) {
  return (
    <Modal title={title} onClose={onCancel} initialFocus="[data-default]">
      <div className="flex flex-col gap-3 text-[13px] leading-[1.7] text-ink-sub">{children}</div>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" autoFocus data-default onClick={onCancel} className="h-[46px] rounded-pill bg-white/[.07] px-5 text-[13px] font-bold">
          戻る
        </button>
        <Button
          busy={busy}
          onClick={onConfirm}
          className={clsx("!h-[46px] !w-auto px-[22px] !text-[13px]", danger && "!bg-danger hover:!bg-danger-hover")}
        >
          {busy ? "実行しています…" : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
