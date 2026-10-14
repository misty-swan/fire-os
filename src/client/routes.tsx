import type { ReactNode } from "react";
import { Navigate, createBrowserRouter, createMemoryRouter, type RouteObject } from "react-router";
import { AppShell, useOnline } from "./components/AppShell";
import { AccessPanel } from "./features/admin/AccessPanel";
import { LoginPage } from "./features/auth/LoginPage";
import { MembersPage } from "./features/members/MembersPage";
import { MapPage } from "./features/map/MapPage";
import { FacilityPage } from "./features/facilities/FacilityPage";
import { FacilityEditorPage } from "./features/facilities/FacilityEditorPage";
import { InspectionFormPage } from "./features/inspections/InspectionForm";
import { IssuesPage } from "./features/issues/IssuesPage";
import { AssetsPage } from "./features/assets/AssetsPage";
import { AssetPage } from "./features/assets/AssetPage";
import { ImportPage } from "./features/facilities/ImportPage";
import { InspectionTemplatesPanel } from "./features/admin/InspectionTemplatesPanel";
import { MeGate, type MeData } from "./me";
import { MenuPage } from "./components/MenuPage";
import { MobileTopRow, PageTitle } from "./components/Page";
import { Card, Chip, Icon } from "./components/ui";
import { screens, shellScreens, type ScreenDef } from "./screens";

/** 未実装画面の仮表示。どのタスクで作るかを示し、成功したように見せない。 */
export function ScreenPlaceholder({ screen }: { screen: ScreenDef }) {
  const online = useOnline();
  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      {/* ホームだけ最上段に通信状態/DEMO/通知（prototype ホーム） */}
      {screen.id === "SCR-02" && <MobileTopRow online={online} />}
      {/* PCは見出しがヘッダーに出るので、本文の大見出しはスマホのみ */}
      <PageTitle eyebrow={`${screen.id} · ${screen.phase}`} className="lg:[&_h2]:hidden">
        {screen.title}
      </PageTitle>
      <Card className="flex flex-col gap-3 p-4">
        <Chip tone="neutral" icon="construction">
          未実装
        </Chip>
        <p className="text-[14px] leading-[1.7] text-ink-sub">{screen.summary}</p>
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
export const screenElements: Partial<Record<string, ReactNode>> = {
  "SCR-01": <LoginPage />,
  "SCR-15": <MembersPage />,
  "SCR-17": <AccessPanel />,
  "SCR-03": <MapPage />,
  "SCR-04": <FacilityPage />,
  "SCR-05": <FacilityEditorPage />,
  "SCR-06": <InspectionFormPage />,
  "SCR-07": <IssuesPage />,
  "SCR-13": <AssetsPage />,
  "SCR-14": <AssetPage />,
  "SCR-20": <ImportPage />,
};

function toRoutes(sc: ScreenDef, overrides: Record<string, ReactNode>): RouteObject[] {
  const element = overrides[sc.id] ?? screenElements[sc.id] ?? <ScreenPlaceholder screen={sc} />;
  return [sc.path, ...(sc.aliases ?? [])].map((path) => ({ path, handle: { screen: sc }, element }));
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
export function buildRoutes(overrides: Record<string, ReactNode> = {}, options: { me?: MeData } = {}): RouteObject[] {
  const loginScreen = screens.find((s) => s.id === "SCR-01")!;
  return [
    { path: "/", element: <Navigate to="/app" replace /> },
    ...toRoutes(loginScreen, overrides),
    {
      // 業務の画面はログイン済み(API-01が取れる)ときだけ。取れなければ /login へ。options.me は試験用（取得を省く）
      element: (
        <MeGate me={options.me}>
          <AppShell />
        </MeGate>
      ),
      children: [
        ...screens.filter((s) => s.id !== "SCR-01").flatMap((s) => toRoutes(s, overrides)),
        // シェルの画面（SCR番号なし）。メニューはスマホの「メニュー」タブ
        { path: "/app/menu", handle: { screen: shellScreens[0] }, element: overrides["SHELL-MENU"] ?? <MenuPage /> },
        ...toRoutes(shellScreens[1]!, overrides),
        { path: "*", element: <NotFound /> },
      ],
    },
  ];
}

export const createRouter = () => createBrowserRouter(buildRoutes());
export const createTestRouter = (initialEntries: string[], overrides: Record<string, ReactNode> = {}, me?: MeData) =>
  createMemoryRouter(buildRoutes(overrides, { me }), { initialEntries });
