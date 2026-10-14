import type { ReactNode } from "react";
import { BrandMark } from "../../components/BrandMark";

/**
 * ログイン系の画面の枠（prototype LOGIN）：上余白120px・左右28px・下40px、ロゴ76px→FireOS 40px太字→キャッチ14px、
 * フォームは52px下、最下部に DEMO 注記と案内。ホームと同じ橙の放射状ぼかし。シェル（ナビ）の外。
 */
export function AuthLayout({ children, hint = "パスワードを忘れた場合は分団の管理者へ" }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="relative min-h-dvh overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[190px] size-[560px] -translate-x-1/2 -translate-y-1/2"
        style={{ background: "radial-gradient(closest-side,rgba(255,96,48,.22),rgba(255,96,48,.06) 55%,transparent)" }}
      />
      <main id="main" className="relative mx-auto flex min-h-dvh w-full max-w-[460px] flex-col px-7 pb-10 pt-[120px] animate-[fo-in_.5s_ease_both]">
        <div className="flex flex-col items-center gap-[18px]">
          <BrandMark size={76} />
          <div className="flex flex-col items-center gap-2">
            <h1 className="text-[40px] font-black leading-none tracking-[-.02em]">FireOS</h1>
            <p className="whitespace-nowrap text-[14px] text-ink-sub">消防団のすべてを、ひとつに。</p>
          </div>
        </div>
        <div className="mt-[52px] flex flex-col gap-3.5">{children}</div>
        <div className="mt-auto flex flex-col items-center gap-2.5 pt-10">
          <span className="rounded-pill border border-dashed border-white/25 px-[9px] py-[5px] font-mono text-[10px] font-semibold tracking-[.12em] text-ink-sub">
            DEMO · 架空のデータで動作しています
          </span>
          <span className="text-center text-[12px] font-normal text-ink-dim">{hint}</span>
        </div>
      </main>
    </div>
  );
}

/** 画面内の小見出し（ログイン以外の段階：招待受領・二要素・再設定など） */
export function StepHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[12px] font-semibold text-ink-muted">{eyebrow}</span>
      <h2 className="text-[22px] font-bold leading-[1.3]">{title}</h2>
      {children && <p className="text-[13px] leading-[1.7] text-ink-sub">{children}</p>}
    </div>
  );
}

/** 入力の等幅フォント指定（prototypeのログイン欄は IBM Plex Mono 16px） */
export const monoField = "font-mono";

/** ログイン後の戻り先。/app 配下の同一origin相対パスだけ許す（外部URLへの誘導を防ぐ） */
export function safeNext(value: string | null): string {
  return value && /^\/app(\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/.test(value) && !value.includes("//") ? value : "/app";
}
