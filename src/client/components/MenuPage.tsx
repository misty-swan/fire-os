import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { clsx } from "clsx";
import { AUTH_MESSAGES, AuthError, signOut } from "../authApi";
import { purgeForLogout } from "../offline/lifecycle";
import { initialOf, roleLabel, useMe } from "../me";
import { menuTiles } from "../screens";
import { PageTitle } from "./Page";
import { Banner, Button, Icon } from "./ui";

/** スマホの「メニュー」タブ（prototype Menu）：プロフィールカード、2列の機能タイル、ログアウト。 */
export function MenuPage() {
  const { me } = useMe();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      await signOut();
      // 端末に残した下書き・写真を消す（T075・docs/07: ログアウト/ユーザー切替でデータと鍵を破棄）。
      // 消去に失敗してもログアウト自体は止めない（sessionは既に無く、残った分は次の利用者のログイン時にも掃除される）
      await purgeForLogout(me.profile.memberId).catch(() => undefined);
      navigate("/login", { replace: true });
    } catch (e) {
      // 通信できずログアウトを確認できなかったときは、ログアウトできたと見せない
      setError(AUTH_MESSAGES[e instanceof AuthError ? e.kind : "unknown"]);
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <PageTitle>メニュー</PageTitle>
      <div className="hairline flex items-center gap-3.5 rounded-[22px] bg-white/5 p-4">
        <span aria-hidden="true" className="grid size-[52px] flex-none place-items-center rounded-full bg-[#1a2740] text-[18px] font-bold">
          {initialOf(me.profile.displayName)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="truncate text-[16px] font-bold">{me.profile.displayName}</span>
          <span className="truncate text-[12px] text-ink-muted">{me.unitName} · {me.profile.rank ?? "団員"}</span>
        </div>
        <span className="flex-none rounded-pill bg-white/[.08] px-[9px] py-1 text-[11px] font-bold text-[#c3cad6]">{roleLabel(me.roles)}</span>
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
      {error && (
        <Banner tone="error" eyebrow="ERROR" role="alert" title="ログアウトを確認できません">
          {error}
        </Banner>
      )}
      <Link to="/login#mfa" className="hairline flex min-h-12 items-center gap-3 rounded-card bg-white/[.04] px-4 text-[14px] font-bold hover:bg-white/[.07]">
        <Icon name="shield" className="text-[22px] text-[#c3cad6]" />
        二要素認証・回復コード
        {me.mfaEnabled ? <span className="ml-auto text-[11px] font-bold text-ok">有効</span> : me.mfaRequired ? <span className="ml-auto text-[11px] font-bold text-attention">要設定</span> : <span className="ml-auto text-[11px] font-medium text-ink-muted">未設定</span>}
      </Link>
      <Button variant="secondary" busy={busy} onClick={() => void logout()} className="!bg-white/5 !text-[14px] !text-ink-sub">
        <Icon name="logout" className="text-[19px]" />
        {busy ? "ログアウトしています…" : "ログアウト"}
      </Button>
    </div>
  );
}
