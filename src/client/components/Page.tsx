import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { clsx } from "clsx";
import { Icon } from "./ui";

/**
 * 画面の見出し。prototype の「等幅の小見出し（例: 2026 · OCT）＋26px太字」。
 * ページの h1 はこれ（PCではヘッダーの画面名がh1になるため、重複しないよう PageTitle は h2 を使う）。
 */
export function PageTitle({ eyebrow, children, right, className }: { eyebrow?: string; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={clsx("flex items-end justify-between gap-3", className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        {eyebrow && <span className="font-mono text-[12px] font-semibold text-ink-muted">{eyebrow}</span>}
        <h2 className="text-[26px] font-bold leading-[1.3]">{children}</h2>
      </div>
      {right}
    </div>
  );
}

/** サブ画面の見出し行：左に44pxの丸い戻るボタン、中央に画面名＋補足、右に状態（prototype 点検登録/活動/報告書）。 */
export function SubHeader({
  title,
  sub,
  right,
  backTo,
  closeIcon,
}: {
  /** 画面名。見出し（h2）はページ側で持つ場合があるので省略可 */
  title?: string;
  sub?: string;
  right?: ReactNode;
  /** 戻り先。省略時はブラウザの履歴を1つ戻る */
  backTo?: string;
  /** 点検登録のような全画面フローは「閉じる(×)」 */
  closeIcon?: boolean;
}) {
  const navigate = useNavigate();
  const common = "grid size-11 flex-none place-items-center rounded-full bg-white/[.06]";
  const icon = <Icon name={closeIcon ? "close" : "arrow_back"} className="text-[22px]" />;
  const label = closeIcon ? "閉じる" : "戻る";
  return (
    <div className="flex items-center gap-2.5">
      {backTo ? (
        <Link to={backTo} aria-label={label} className={common}>
          {icon}
        </Link>
      ) : (
        <button type="button" aria-label={label} onClick={() => navigate(-1)} className={common}>
          {icon}
        </button>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        {title && <span className="truncate text-[16px] font-bold">{title}</span>}
        {sub && <span className="truncate text-[11px] text-ink-muted">{sub}</span>}
      </div>
      {right}
    </div>
  );
}

/** ホームの最上段：左に通信状態、右に DEMO と通知（橙の点は未読あり）。prototype ホームの1行目。 */
export function MobileTopRow({ online, unread }: { online: boolean; unread?: boolean }) {
  return (
    <div className="flex items-center justify-between lg:hidden">
      <span className="inline-flex items-center gap-2 rounded-pill bg-white/[.06] py-1.5 pl-[9px] pr-[11px] text-[12px] text-ink-sub">
        <span aria-hidden="true" className={clsx("size-[7px] rounded-full", online ? "bg-ok" : "bg-attention")} />
        {online ? "オンライン" : "オフライン"}
      </span>
      <div className="flex items-center gap-2">
        <span
          title="架空データによる検証版です"
          className="rounded-pill border border-dashed border-white/25 px-2 py-[5px] font-mono text-[10px] font-semibold tracking-[.12em] text-ink-sub"
        >
          DEMO
        </span>
        <Link to="/app/tasks-notifications" aria-label="タスク・通知" className="relative grid size-10 place-items-center rounded-full bg-white/[.06]">
          <Icon name="notifications" className="text-[21px]" />
          {unread && <span aria-hidden="true" className="absolute right-2.5 top-[9px] size-2 rounded-full bg-ember shadow-[0_0_0_2px_#0d1626]" />}
        </Link>
      </div>
    </div>
  );
}
