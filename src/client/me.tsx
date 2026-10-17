import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import type { ApiResponse } from "../shared/contracts/registry";
import { ApiError, api } from "./api";
import { purgeForeignDrafts } from "./offline/lifecycle";
import { Banner, Button } from "./components/ui";

/** API-01 の値。サイドバー・メニューの利用者表示、管理画面の出し分けに使う（権限判定そのものはサーバー） */
export type MeData = ApiResponse<"API-01">;
interface MeValue {
  me: MeData;
  refresh: () => Promise<void>;
}
const MeContext = createContext<MeValue | null>(null);

export function useMe(): MeValue {
  const v = useContext(MeContext);
  if (!v) throw new Error("useMe は MeGate の内側で使います");
  return v;
}

const ROLE_LABEL: Record<MeData["roles"][number], string> = { admin: "管理者", officer: "幹部", operator: "担当者", member: "一般団員" };
const ROLE_ORDER = ["admin", "officer", "operator", "member"] as const;
/** 複数の役割があれば最上位を表示する（権限は和集合。表示はピルひとつ） */
export const roleLabel = (roles: MeData["roles"]): string => {
  const top = ROLE_ORDER.find((r) => roles.includes(r));
  return top ? ROLE_LABEL[top] : "役割なし";
};
export const initialOf = (name: string): string => [...name.trim()][0] ?? "?";
/** 「架空市 第一分団」→ 上段「架空市」・下段「第一分団」（空白が無ければ全体を下段に） */
export function splitUnit(unitName: string): { upper: string; lower: string } {
  const i = unitName.indexOf(" ");
  return i < 0 ? { upper: "", lower: unitName } : { upper: unitName.slice(0, i), lower: unitName.slice(i + 1) };
}

/**
 * 利用者情報の取得。ログインしていなければ(401)ログイン画面へ（戻り先を覚える）。
 * `me` を渡すと取得しない（試験・storybook用）。取得中や失敗時は業務の画面を出さない。
 */
export function MeGate({ me: provided, children }: { me?: MeData; children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [me, setMe] = useState<MeData | null>(provided ?? null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api("API-01", {});
      setMe(next);
      setFailed(false);
      // ログアウト消去が走らずに残った他人の下書きを掃除する（T075・docs/14 D14: ユーザー切替で破棄）。
      // 失敗しても起動は止めない（下書きの読みはscopeで分離されているので、残っても他人には見えない）
      void purgeForeignDrafts(next.profile.memberId).catch(() => undefined);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
        return;
      }
      setFailed(true);
    }
  }, [navigate, location.pathname, location.search]);

  useEffect(() => {
    if (!provided) void load();
    // 初回だけ取得する（画面遷移のたびに取り直さない。権限の変化は各APIが毎回サーバーで判定する）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo(() => (me ? { me, refresh: load } : null), [me, load]);
  if (value) return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
  return (
    <div className="grid min-h-dvh place-items-center px-5">
      {failed ? (
        <div className="w-full max-w-[420px]">
          <Banner tone="error" eyebrow="ERROR" role="alert" title="利用者情報を取得できません" action={<Button variant="secondary" onClick={() => void load()}>再読み込み</Button>}>
            通信を確認してもう一度お試しください。
          </Banner>
        </div>
      ) : (
        <p role="status" className="text-[13px] text-ink-muted">読み込んでいます…</p>
      )}
    </div>
  );
}
