import type { ReactNode } from "react";
import { Navigate, createBrowserRouter, createMemoryRouter, type RouteObject } from "react-router";
import { AppShell } from "./components/AppShell";
import { Card, Chip, Icon } from "./components/ui";
import { screens, type ScreenDef } from "./screens";

/** 未実装画面の仮表示。どのタスクで作るかを示し、成功したように見せない。 */
export function ScreenPlaceholder({ screen }: { screen: ScreenDef }) {
  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <p className="font-mono text-[11px] font-semibold tracking-[.14em] text-ember-soft">
        {screen.id} · {screen.phase}
      </p>
      <h2 className="text-[26px] font-bold leading-snug">{screen.title}</h2>
      <Card className="flex flex-col gap-3 p-4">
        <Chip tone="neutral" icon="construction">
          未実装
        </Chip>
        <p className="text-[14px] text-ink-sub">{screen.summary}</p>
        <p className="flex items-center gap-2 text-[13px] text-ink-muted">
          <Icon name="task_alt" className="text-[18px]" />
          この画面は{screen.phase}のタスク {screen.ownerTask} で実装します。
        </p>
      </Card>
    </div>
  );
}

/**
 * 28画面の登録点。後続タスクは自分の画面を screenElements["SCR-xx"] へ登録する（未登録はプレースホルダー）。
 * 試験では buildRoutes の overrides で任意の要素に差し替える。
 */
export const screenElements: Partial<Record<string, ReactNode>> = {};

function toRoute(sc: ScreenDef, overrides: Record<string, ReactNode>): RouteObject {
  return {
    path: sc.path,
    handle: { screen: sc },
    element: overrides[sc.id] ?? screenElements[sc.id] ?? <ScreenPlaceholder screen={sc} />,
  };
}

function NotFound() {
  return (
    <div className="flex max-w-[720px] flex-col gap-3">
      <h2 className="text-[26px] font-bold">ページが見つかりません</h2>
      <p className="text-[14px] text-ink-sub">アドレスが正しいか確認してください。</p>
    </div>
  );
}

// ログイン(SCR-01)はshellの外（ナビを出さない）。/app 配下はAppShellの中。
export function buildRoutes(overrides: Record<string, ReactNode> = {}): RouteObject[] {
  const loginScreen = screens.find((s) => s.id === "SCR-01")!;
  return [
    { path: "/", element: <Navigate to="/app" replace /> },
    toRoute(loginScreen, overrides),
    {
      element: <AppShell />,
      children: [...screens.filter((s) => s.id !== "SCR-01").map((s) => toRoute(s, overrides)), { path: "*", element: <NotFound /> }],
    },
  ];
}

export const createRouter = () => createBrowserRouter(buildRoutes());
export const createTestRouter = (initialEntries: string[], overrides: Record<string, ReactNode> = {}) =>
  createMemoryRouter(buildRoutes(overrides), { initialEntries });
