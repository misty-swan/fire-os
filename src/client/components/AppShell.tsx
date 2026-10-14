import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router";
import { clsx } from "clsx";
import { authEvents } from "../api";
import { initialOf, roleLabel, splitUnit, useMe } from "../me";
import { bottomTabs, desktopNavGroups, dispatchNav, matchDesktopNav, matchScreen } from "../screens";
import { BrandMark } from "./BrandMark";
import { Icon } from "./ui";

/** 通信状態。navigator.onLine は「接続なし」の確実な検出にだけ使う（オンラインでも到達できるとは限らない）。 */
export function useOnline(): boolean {
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

/** 架空データであることの表示（prototypeのDEMOタグ）。実データ運用までは常に表示する。 */
function DemoTag({ className }: { className?: string }) {
  return (
    <span
      title="架空データによる検証版です"
      className={clsx("rounded-pill border border-dashed border-white/25 font-mono font-semibold tracking-[.12em] text-ink-sub", className)}
    >
      DEMO
    </span>
  );
}

/** PC(1024px以上)の左サイドバー(248px)。prototype Desktop と同じ：ロゴ→分団カード→3グループ→出動管理→利用者。 */
function Sidebar({ activePath }: { activePath: string | undefined }) {
  const { me } = useMe();
  const unit = splitUnit(me.unitName);
  return (
    <aside className="fo-scroll sticky top-0 hidden h-dvh w-[248px] flex-none flex-col gap-1 overflow-y-auto border-r border-white/[.06] bg-sidebar px-3.5 pb-4 pt-[18px] lg:flex">
      <div className="flex items-center gap-2.5 px-2 pb-4 pt-0.5">
        <BrandMark size={32} />
        <span className="text-[19px] font-black leading-none tracking-[-.01em]">FireOS</span>
        <DemoTag className="ml-auto px-1.5 py-1 text-[9px]" />
      </div>
      {/* 分団の切り替え。複数分団対応は後続（prototypeは Phase 3 と表示）。いまは表示のみ */}
      <button
        type="button"
        disabled
        title="複数分団の切り替えは後続フェーズで対応します"
        className="hairline mb-2.5 flex items-center gap-2.5 rounded-[14px] bg-white/[.04] px-3 py-2.5 text-left"
      >
        <span className="flex flex-1 flex-col gap-0.5">
          {unit.upper && <span className="text-[10px] text-ink-muted">{unit.upper}</span>}
          <span className="text-[14px] font-bold">{unit.lower}</span>
        </span>
        <Icon name="unfold_more" className="text-[18px] text-ink-muted" />
      </button>

      {/* prototype どおりサイドバー全体がスクロールし、出動管理/利用者は margin-top:auto で最下部へ寄せる */}
      <nav aria-label="主要メニュー" className="flex flex-col gap-1">
        {desktopNavGroups.map((g) => (
          <div key={g.heading} className="flex flex-col gap-1">
            <p className="px-2.5 pb-1.5 pt-3.5 font-mono text-[10px] font-semibold tracking-[.16em] text-[#5f6a7d]">{g.heading}</p>
            {g.items.map((n) => {
              const active = activePath === n.path;
              return (
                <Link
                  key={n.path + n.label}
                  to={n.path}
                  aria-current={active ? "page" : undefined}
                  className={clsx(
                    "flex h-10 items-center gap-3 rounded-nav px-3 text-[13px] transition-colors hover:bg-white/[.06]",
                    active ? "bg-white/[.07] font-bold text-ink" : "font-medium text-ink-sub",
                  )}
                >
                  <Icon name={n.icon} fill={active} className={clsx("text-[20px]", active ? "text-[#ff6a3d]" : "text-ink-dim")} />
                  <span className="flex-1">{n.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="mt-auto flex flex-col gap-2.5 pt-[18px]">
        <Link
          to={dispatchNav.path}
          aria-current={activePath === dispatchNav.path ? "page" : undefined}
          className={clsx(
            "flex h-11 items-center gap-2.5 rounded-nav px-3.5 text-[#ffb0a8] shadow-[inset_0_0_0_1px_rgba(255,59,47,.45)] hover:bg-dispatch/[.12]",
            activePath === dispatchNav.path && "bg-dispatch/[.14]",
          )}
        >
          <Icon name={dispatchNav.icon} className="text-[20px]" />
          <span className="text-[13px] font-bold">{dispatchNav.label}</span>
        </Link>
        {/* 利用者ブロック（prototypeと同じ見た目）。押すとプロフィール/ログアウトのメニュー画面へ（PCにメニュータブが無いため） */}
        <Link to="/app/menu" aria-label="プロフィールとログアウト" className="flex items-center gap-2.5 rounded-nav border-t border-white/[.06] px-2 pt-2.5 hover:bg-white/[.04]">
          <span aria-hidden="true" className="grid size-9 flex-none place-items-center rounded-full bg-[#1a2740] text-[14px] font-bold">
            {initialOf(me.profile.displayName)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[13px] font-bold">{me.profile.displayName}</span>
            <span className="truncate text-[11px] text-ink-muted">{me.profile.rank ?? "団員"}</span>
          </span>
          <span className="rounded-pill bg-[rgba(255,106,61,.14)] px-[7px] py-[3px] text-[10px] font-bold text-ember-soft">{roleLabel(me.roles)}</span>
        </Link>
      </div>
    </aside>
  );
}

/** PCのヘッダー(64px)：パンくず＋画面名、検索欄、通信状態、通知、AIアシスタント。 */
function DesktopHeader({ title, crumb, online }: { title: string; crumb: string; online: boolean }) {
  const location = useLocation();
  const { me } = useMe();
  const aiActive = location.pathname.startsWith("/app/assistant");
  return (
    <header className="hidden h-16 flex-none items-center gap-3.5 border-b border-white/[.06] pl-8 pr-6 lg:flex">
      <div className="flex flex-none flex-col gap-0.5">
        <span className="whitespace-nowrap text-[11px] text-ink-dim">
          {splitUnit(me.unitName).lower} / {crumb}
        </span>
        <h1 className="whitespace-nowrap text-[17px] font-bold">{title}</h1>
      </div>
      {/* 横断検索は権限付き検索(API-76)の実装後に有効化する。prototypeの見た目だけ先に置く */}
      <button
        type="button"
        disabled
        title="検索は後続フェーズで有効になります"
        className="ml-auto flex h-10 min-w-[120px] flex-[0_1_320px] items-center gap-2 rounded-nav bg-white/5 px-3 text-ink-dim shadow-[inset_0_0_0_1px_rgba(255,255,255,.08)]"
      >
        <Icon name="search" className="text-[19px]" />
        <span className="flex-1 overflow-hidden whitespace-nowrap text-left text-[13px]">団員・施設・記録を検索</span>
        <span className="rounded-[5px] bg-white/[.07] px-1.5 py-[3px] font-mono text-[10px] font-semibold">⌘K</span>
      </button>
      <span className="inline-flex h-8 flex-none items-center gap-[7px] whitespace-nowrap rounded-pill bg-white/[.04] px-3 text-[12px] text-ink-sub">
        <span aria-hidden="true" className={clsx("size-[7px] rounded-full", online ? "bg-ok" : "bg-attention")} />
        {online ? "オンライン" : "オフライン"}
      </span>
      <Link to="/app/tasks-notifications" aria-label="タスク・通知" className="relative grid size-10 flex-none place-items-center rounded-nav bg-white/5">
        <Icon name="notifications" className="text-[20px]" />
      </Link>
      <Link
        to="/app/assistant"
        aria-current={aiActive ? "page" : undefined}
        className={clsx(
          "flex h-10 flex-none items-center gap-2 whitespace-nowrap rounded-nav px-3.5 text-[13px] font-bold text-[#e4ddff] shadow-[inset_0_0_0_1px_rgba(185,169,255,.35)]",
          aiActive ? "bg-ai/[.16]" : "bg-white/[.04]",
        )}
      >
        <Icon name="auto_awesome" className="text-[19px] text-ai" />
        AIアシスタント
      </Link>
    </header>
  );
}

/** スマホの下部ナビ(84px)。prototype の navDef：ホーム/マップ/予定・活動/AI/メニュー。AIタブだけ強調色が紫。 */
function BottomNav({ activeTab }: { activeTab: string | undefined }) {
  return (
    <nav
      aria-label="主要メニュー"
      data-testid="bottom-nav"
      className="fixed inset-x-0 bottom-0 z-50 grid h-[84px] grid-cols-5 border-t border-white/[.06] bg-gradient-to-b from-night/60 to-night/[.96] pt-[9px] backdrop-blur-[16px] lg:hidden"
    >
      {bottomTabs.map((t) => {
        const active = t.tab === activeTab;
        return (
          // NavLinkは自分のURL一致でaria-currentを上書きするため、サブ画面でも親タブを強調できるLinkを使う
          <Link
            key={t.tab}
            to={t.path}
            aria-current={active ? "page" : undefined}
            className={clsx("flex min-h-11 flex-col items-center gap-1 transition-colors", active ? "text-ink" : "text-ink-dim")}
          >
            <span
              className={clsx(
                "flex h-[30px] w-14 items-center justify-center rounded-pill transition-colors",
                active && (t.tab === "ai" ? "bg-ai/[.18]" : "bg-[rgba(255,106,61,.18)]"),
              )}
            >
              <Icon name={t.icon} fill={active} className="text-[23px]" />
            </span>
            <span className={clsx("text-[10px]", active ? "font-bold" : "font-medium")}>{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const online = useOnline();
  const main = useRef<HTMLElement>(null);
  const current = matchScreen(location.pathname);
  const desk = matchDesktopNav(location.pathname);
  const title = current?.desktopTitle ?? current?.title ?? "FireOS";

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

  return (
    <div className="min-h-dvh lg:flex lg:h-dvh lg:overflow-hidden">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-pill focus:bg-ember focus:px-4 focus:py-2 focus:font-bold focus:text-white"
      >
        メインコンテンツへ移動
      </a>

      {/* ホームだけ橙の放射状のぼかし（prototype showGlow）。スマホのみ */}
      {current?.id === "SCR-02" && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed left-1/2 top-[190px] size-[560px] -translate-x-1/2 -translate-y-1/2 lg:hidden"
          style={{ background: "radial-gradient(closest-side,rgba(255,96,48,.22),rgba(255,96,48,.06) 55%,transparent)" }}
        />
      )}

      <Sidebar activePath={desk?.path} />

      <div className="flex min-w-0 flex-1 flex-col lg:overflow-hidden">
        <DesktopHeader title={title} crumb={desk?.crumb ?? "運用"} online={online} />

        <div className="fo-scroll relative flex-1 lg:min-h-0 lg:overflow-auto">
          {!online && (
            <div role="status" className="mx-5 mt-3 flex h-[30px] items-center justify-center gap-2 rounded-pill bg-attention text-[11px] font-bold text-[#1a1204] lg:mx-8">
              <Icon name="cloud_off" className="text-[16px]" />
              オフラインです。通信が回復するまで保存できません
            </div>
          )}
          <main
            ref={main}
            id="main"
            tabIndex={-1}
            className={clsx(
              // prototype: スマホ本文は上10px/左右20px、PCは 28px 32px 56px・最大1440px（左寄せ）
              "relative mx-auto w-full max-w-[1440px] px-5 pt-2.5 outline-none lg:mx-0 lg:px-8 lg:pb-14 lg:pt-7",
              current?.hideNav ? "pb-32" : "pb-28",
            )}
          >
            {/* スマホにはヘッダーが無い(prototype)ので、h1は読み上げ用。PCはヘッダーの画面名がh1 */}
            <h1 className="sr-only lg:hidden">{current?.title ?? "FireOS"}</h1>
            <Outlet />
          </main>
        </div>
      </div>

      {!current?.hideNav && <BottomNav activeTab={current?.tab} />}
    </div>
  );
}
