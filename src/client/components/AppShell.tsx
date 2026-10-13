import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { clsx } from "clsx";
import { authEvents } from "../api";
import { bottomTabs, matchScreen, menuGroups } from "../screens";
import { Icon } from "./ui";

/** 通信状態。navigator.onLine は「接続なし」の確実な検出にだけ使う（オンラインでも到達できるとは限らない）。 */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

function SyncPill({ online }: { online: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-pill bg-white/[.06] py-1.5 pl-2.5 pr-3 text-[12px] text-ink-sub">
      <span aria-hidden="true" className={clsx("size-[7px] rounded-full", online ? "bg-ok" : "bg-attention")} />
      {online ? "オンライン" : "オフライン"}
    </span>
  );
}

/** 架空データであることの表示（prototypeのDEMOタグ）。実データ運用までは常に表示する。 */
function DemoTag() {
  return (
    <span
      title="架空データによる検証版です"
      className="rounded-md border border-dashed border-white/25 px-2 py-0.5 font-mono text-[10px] tracking-[.14em] text-ink-muted"
    >
      DEMO
    </span>
  );
}

const navLinkBase = "flex items-center gap-3 rounded-nav px-3 text-[13px]";

/** PC用の左サイドバー(248px)。メニューの全画面を常時表示する。 */
function Sidebar() {
  return (
    <nav aria-label="主要メニュー" className="flex flex-1 flex-col gap-5 overflow-y-auto">
      {menuGroups().map(({ group, items }) => (
        <div key={group}>
          <p className="px-3 pb-2 font-mono text-[10px] font-semibold tracking-[.16em] text-[#5f6a7d]">{group}</p>
          <ul className="flex flex-col gap-0.5">
            {items.map((sc) => (
              <li key={sc.path}>
                <NavLink
                  to={sc.path}
                  end
                  className={({ isActive }) =>
                    clsx(
                      navLinkBase,
                      "h-10 hover:bg-white/[.06]",
                      isActive ? "bg-white/[.07] font-bold text-ink" : "font-medium text-ink-sub",
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon name={sc.menu.icon} fill={isActive} className={clsx("text-[20px]", isActive ? "text-[#ff6a3d]" : "text-ink-dim")} />
                      {sc.menu.label}
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** スマホ用の下部ナビ(84px)。5つの入口はdocs/03 §1。サブ画面では親のタブを強調する。 */
function BottomNav({ activeTab }: { activeTab: string | undefined }) {
  return (
    <nav
      aria-label="主要メニュー"
      data-testid="bottom-nav"
      className="fixed inset-x-0 bottom-0 z-30 grid h-[84px] grid-cols-5 border-t border-white/[.06] bg-gradient-to-b from-night/60 to-night/95 pt-2 backdrop-blur-xl lg:hidden"
    >
      {bottomTabs.map((t) => {
        const active = t.tab === activeTab;
        return (
          // NavLinkは自分のURL一致でaria-currentを上書きするため、サブ画面でも親タブを強調できるLinkを使う
          <Link
            key={t.tab}
            to={t.path}
            aria-current={active ? "page" : undefined}
            className={clsx("flex min-h-11 flex-col items-center gap-1", active ? "text-ink" : "text-ink-dim")}
          >
            <span className={clsx("flex h-[30px] w-14 items-center justify-center rounded-pill", active && "bg-[rgba(255,106,61,.18)]")}>
              <Icon name={t.icon} fill={active} className="text-[23px]" />
            </span>
            <span className={clsx("text-[10px]", active ? "font-bold" : "font-medium")}>{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/** スマホ用の全画面メニュー。下部ナビに無い画面（名簿・文書・同期など）への入口。閉じたら押したボタンへフォーカスを戻す。 */
function MenuSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-[rgba(3,6,12,.6)] lg:hidden" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="メニュー"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && onClose()}
        className="absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-[30px] bg-[#0f1828] px-5 pb-8 pt-3"
      >
        <div aria-hidden="true" className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/20" />
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[18px] font-bold">メニュー</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="メニューを閉じる" className="grid size-11 place-items-center rounded-full bg-white/[.06]">
            <Icon name="close" className="text-[22px]" />
          </button>
        </div>
        {menuGroups().map(({ group, items }) => (
          <section key={group} className="mb-4">
            <h3 className="px-1 pb-2 font-mono text-[10px] font-semibold tracking-[.16em] text-[#5f6a7d]">{group}</h3>
            <ul className="hairline overflow-hidden rounded-card bg-white/[.04]">
              {items.map((sc) => (
                <li key={sc.path} className="border-t border-white/[.06] first:border-t-0">
                  <NavLink to={sc.path} end onClick={onClose} className="flex min-h-12 items-center gap-3 px-4 py-2 text-[14px] font-bold">
                    <Icon name={sc.menu.icon} className="text-[22px] text-ink-sub" />
                    {sc.menu.label}
                    <Icon name="chevron_right" className="ml-auto text-[20px] text-ink-dim" />
                  </NavLink>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const online = useOnline();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLElement>(null);
  const current = matchScreen(location.pathname);

  // 認証切れ(401)は再ログインへ。戻り先を覚える
  useEffect(() => {
    const handler = () => navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    authEvents.addEventListener("unauthenticated", handler);
    return () => authEvents.removeEventListener("unauthenticated", handler);
  }, [navigate, location.pathname, location.search]);

  // 画面が変わったら本文へフォーカスを移す（スクリーンリーダー/キーボードで画面遷移に気付けるように）
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus({ preventScroll: true });
  }, [location.pathname]);

  const closeMenu = () => {
    setMenuOpen(false);
    menuButton.current?.focus(); // 押したボタンへ戻す
  };

  return (
    <div className="min-h-dvh lg:flex">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-pill focus:bg-ember focus:px-4 focus:py-2 focus:font-bold focus:text-white"
      >
        メインコンテンツへ移動
      </a>

      {/* PC: 左サイドバー */}
      <aside className="sticky top-0 hidden h-dvh w-[248px] shrink-0 flex-col gap-5 border-r border-white/[.06] bg-sidebar px-3.5 pb-4 pt-[18px] lg:flex">
        <div className="flex items-center gap-2.5 px-1.5">
          <span aria-hidden="true" className="grid size-8 place-items-center rounded-[10px] bg-ember">
            <Icon name="local_fire_department" fill className="text-[20px] text-white" />
          </span>
          <span className="text-[19px] font-black">FireOS</span>
          <DemoTag />
        </div>
        <Sidebar />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ヘッダー: スマホ=状態/DEMO/通知/メニュー、PC=画面名(64px) */}
        <header className="sticky top-0 z-20 flex min-h-14 items-center gap-3 border-b border-white/[.06] bg-night/90 px-5 py-2 backdrop-blur lg:h-16 lg:px-8">
          <div className="min-w-0 flex-1">
            <p className="hidden text-[11px] text-ink-dim lg:block">架空市 第一分団 / デモ</p>
            {/* スマホでは本文側の大見出しと重複するため読み上げ専用。PC(64pxヘッダー)では表示 */}
            <h1 className="sr-only truncate text-[17px] font-bold lg:not-sr-only">{current?.title ?? "FireOS"}</h1>
          </div>
          <span className="order-first lg:order-none">
            <SyncPill online={online} />
          </span>
          <span className="lg:hidden">
            <DemoTag />
          </span>
          <NavLink to="/app/tasks-notifications" aria-label="タスク・通知" className="grid size-11 place-items-center rounded-full bg-white/[.06] lg:rounded-nav">
            <Icon name="notifications" className="text-[22px]" />
          </NavLink>
          <button
            ref={menuButton}
            type="button"
            aria-label="メニューを開く"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
            className="grid size-11 place-items-center rounded-full bg-white/[.06] lg:hidden"
          >
            <Icon name="menu" className="text-[22px]" />
          </button>
        </header>

        {!online && (
          <div role="status" className="mx-5 mt-3 flex h-[30px] items-center justify-center gap-2 rounded-pill bg-attention text-[11px] font-bold text-[#1a1204] lg:mx-8">
            <Icon name="cloud_off" className="text-[16px]" />
            オフラインです。通信が回復するまで保存できません
          </div>
        )}

        <main ref={main} id="main" tabIndex={-1} className="mx-auto w-full max-w-[1440px] flex-1 px-5 pb-28 pt-5 outline-none lg:px-8 lg:pb-14 lg:pt-7">
          <Outlet />
        </main>
      </div>

      <BottomNav activeTab={current?.tab} />
      <MenuSheet open={menuOpen} onClose={closeMenu} />
    </div>
  );
}
