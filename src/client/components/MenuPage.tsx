import { Link } from "react-router";
import { clsx } from "clsx";
import { demoProfile } from "../demo";
import { menuTiles } from "../screens";
import { PageTitle } from "./Page";
import { Button, Icon } from "./ui";

/** スマホの「メニュー」タブ（prototype Menu）：プロフィールカード、2列の機能タイル、ログアウト。 */
export function MenuPage() {
  return (
    <div className="flex flex-col gap-4">
      <PageTitle>メニュー</PageTitle>
      <div className="hairline flex items-center gap-3.5 rounded-[22px] bg-white/5 p-4">
        <span aria-hidden="true" className="grid size-[52px] flex-none place-items-center rounded-full bg-[#1a2740] text-[18px] font-bold">
          {demoProfile.initial}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="truncate text-[16px] font-bold">{demoProfile.name}</span>
          <span className="truncate text-[12px] text-ink-muted">{demoProfile.detail}</span>
        </div>
        <span className="flex-none rounded-pill bg-white/[.08] px-[9px] py-1 text-[11px] font-bold text-[#c3cad6]">{demoProfile.role}</span>
      </div>
      <ul className="grid grid-cols-2 gap-2">
        {menuTiles.map((t) => (
          <li key={t.path}>
            <Link
              to={t.path}
              className="hairline flex min-h-24 flex-col justify-between gap-2.5 rounded-card bg-white/[.04] p-3.5 hover:bg-white/[.07]"
            >
              <Icon name={t.icon} className={clsx("text-[24px]", t.danger ? "text-alert" : "text-[#c3cad6]")} />
              <span className="text-[14px] font-bold">{t.label}</span>
            </Link>
          </li>
        ))}
      </ul>
      {/* ログアウトはAPI-36(認証)が必要。PH1(T010)で接続するまで押せない */}
      <Button variant="secondary" disabled title="ログインの実装(PH1)後に使えます" className="!bg-white/5 !text-[14px] !text-ink-sub">
        <Icon name="logout" className="text-[19px]" />
        ログアウト
      </Button>
    </div>
  );
}
