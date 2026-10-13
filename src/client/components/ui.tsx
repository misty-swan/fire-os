import { useEffect, useId, useRef, type ComponentProps, type ReactNode } from "react";
import { clsx } from "clsx";

// 共通の見た目部品。寸法・色は prototype（Beacon）に合わせる。
// ボタンは 56px(主)/52px(副) のpill、カードは20px角丸＋1px inset罫線、入力は54px/16px角丸。

export function Icon({ name, fill, className }: { name: string; fill?: boolean; className?: string }) {
  return (
    <span aria-hidden="true" className={clsx("ms", fill && "ms-fill", className)}>
      {name}
    </span>
  );
}

type ButtonProps = ComponentProps<"button"> & {
  variant?: "primary" | "secondary";
  /**
   * 実行中。prototype(Design System "Loading")どおり主色の塗りのままスピナーと進行形の文言を出す。
   * 押しても何もしない（aria-disabled）。無効(disabled)の灰色とは見た目を分ける。
   */
  busy?: boolean;
};

export function Button({ variant = "primary", busy, className, children, disabled, onClick, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={(e) => {
        if (busy) {
          e.preventDefault(); // 実行中の二重タップを無視（submitも止める）
          return;
        }
        onClick?.(e);
      }}
      className={clsx(
        "inline-flex w-full items-center justify-center rounded-pill font-bold transition",
        // 実行中(Loading)は影も押下の縮みも無し（prototype Design System）
        busy ? "gap-2.5 text-[15px]" : "gap-2 active:scale-[0.98]",
        variant === "primary" && "h-14 bg-ember text-white",
        variant === "primary" && !busy && "shadow-[0_12px_28px_-8px_rgba(255,90,46,.7)]",
        variant === "primary" && !busy && "text-[16px] hover:bg-ember-hover",
        variant === "secondary" && "h-[52px] bg-white/[.08] text-[15px] text-ink hover:bg-white/[.12]",
        // 無効: prototype Disabled（.08 / #7d889b / 15px / not-allowed）
        "disabled:cursor-not-allowed disabled:bg-white/[.08] disabled:text-[15px] disabled:text-ink-dim disabled:shadow-none disabled:active:scale-100",
        className,
      )}
    >
      {busy && (
        <span
          aria-hidden="true"
          className="size-4 animate-[fo-spin_.8s_linear_infinite] rounded-full border-2 border-white/30 border-t-white"
        />
      )}
      {children}
    </button>
  );
}

export function Card({ className, ...rest }: ComponentProps<"div">) {
  return <div {...rest} className={clsx("hairline rounded-card bg-white/[.04] p-3.5", className)} />;
}

const tones = {
  neutral: "bg-white/[.08] text-[#c3cad6]",
  ok: "bg-ok/[.14] text-ok",
  attention: "bg-attention/[.14] text-attention",
  alert: "bg-[rgba(255,90,70,.16)] text-alert",
  ai: "bg-ai/[.14] text-ai",
} as const;
export type Tone = keyof typeof tones;

/**
 * 状態チップ。色だけに頼らず必ず文字を持つ（docs/03 §1）。
 * size="lg" は Design System の状態ラベル（34px・13px・アイコン16px）、既定は画面内の小ピル（11px・4px 9px）。
 */
export function Chip({ tone = "neutral", icon, size = "sm", children }: { tone?: Tone; icon?: string; size?: "sm" | "lg"; children: ReactNode }) {
  return (
    <span
      className={clsx(
        "inline-flex flex-none items-center rounded-pill font-bold",
        size === "lg" ? "h-[34px] gap-1.5 px-3.5 text-[13px]" : "gap-1 px-[9px] py-1 text-[11px]",
        tones[tone],
      )}
    >
      {icon && <Icon name={icon} className={size === "lg" ? "text-[16px]" : "text-[13px]"} />}
      {children}
    </span>
  );
}

const blockTones = {
  error: { box: "bg-[rgba(255,90,70,.08)] shadow-[inset_0_0_0_1px_rgba(255,90,70,.3)]", eyebrow: "text-[#ff9a88]", title: "text-[#ffb0a4]", body: "text-[#e7c9c4]" },
  warning: { box: "bg-[rgba(255,195,92,.08)] shadow-[inset_0_0_0_1px_rgba(255,195,92,.3)]", eyebrow: "text-attention", title: "text-[#ffdca0]", body: "text-[#ffdca0]" },
  success: { box: "bg-ok/[.07] shadow-[inset_0_0_0_1px_rgba(58,208,143,.22)]", eyebrow: "text-ok", title: "text-[#bfe9d6]", body: "text-[#bfe9d6]" },
  info: { box: "bg-white/[.04] shadow-[inset_0_0_0_1px_rgba(255,255,255,.1)]", eyebrow: "text-ink-dim", title: "text-ink", body: "text-ink-sub" },
} as const;

/**
 * 状態ブロック（Design System の ERROR / OFFLINE ブロック）：
 * 等幅の小見出し → 14pxのタイトル → 12px/1.6の本文 → 任意の操作。padding 20px・角丸24px。
 */
export function Banner({
  tone,
  eyebrow,
  title,
  children,
  action,
  role,
}: {
  tone: keyof typeof blockTones;
  /** 例: ERROR / OFFLINE / CONFLICT（英大文字の等幅ラベル） */
  eyebrow: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  role?: "alert" | "status";
}) {
  const t = blockTones[tone];
  return (
    <div role={role} className={clsx("flex flex-col gap-2.5 rounded-[24px] p-5", t.box)}>
      <span className={clsx("font-mono text-[10px] font-semibold tracking-[.14em]", t.eyebrow)}>{eyebrow}</span>
      <p className={clsx("text-[14px] font-bold", t.title)}>{title}</p>
      {children && <div className={clsx("text-[12px] font-medium leading-[1.6]", t.body)}>{children}</div>}
      {action}
    </div>
  );
}

/**
 * 1行の案内（prototype 活動記録の「確認待ちです」枠）：アイコン＋13px/1.6、padding 14px・角丸18px。
 * 処理中(202)や確認待ちなど、エラーではない途中経過に使う。
 */
export function Notice({ tone = "warning", icon, children, role }: { tone?: "warning" | "ai" | "info"; icon: string; children: ReactNode; role?: "status" }) {
  const styles = {
    warning: { box: "bg-[rgba(255,195,92,.08)] shadow-[inset_0_0_0_1px_rgba(255,195,92,.28)] text-[#ffdca0]", icon: "text-attention" },
    ai: { box: "bg-ai/[.07] shadow-[inset_0_0_0_1px_rgba(185,169,255,.26)] text-ink-sub", icon: "text-ai" },
    info: { box: "bg-white/[.04] shadow-[inset_0_0_0_1px_rgba(255,255,255,.1)] text-ink-sub", icon: "text-ink-muted" },
  }[tone];
  return (
    <div role={role} className={clsx("flex items-center gap-2.5 rounded-[18px] p-3.5 text-[13px] font-medium leading-[1.6]", styles.box)}>
      <Icon name={icon} className={clsx("text-[20px]", styles.icon)} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * トースト（prototypeの明るい面）。成功だけに使い、2.6秒で一度だけ消える。
 * スマホは左右16px・下からの位置は画面ごと（prototype toastBottom: 既定110、タブ画面100、ホーム/AI 160）、PCは下28pxの中央。
 */
export function Toast({ children, onDone, bottom = 110 }: { children: ReactNode; onDone?: () => void; bottom?: number }) {
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    // 親の再描画で計測をやり直さないよう、表示した時点から一度だけ数える
    const t = setTimeout(() => done.current?.(), 2600);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      role="status"
      style={{ bottom }}
      className={clsx(
        "fixed inset-x-4 z-[120] flex items-center gap-2.5 rounded-[18px] bg-ink px-4 py-3.5 text-[13px] font-bold leading-[1.5] text-night",
        "shadow-[0_16px_40px_rgba(0,0,0,.5)] animate-[fo-in_.3s_cubic-bezier(.2,.8,.2,1)_both]",
        "lg:inset-x-auto lg:!bottom-7 lg:left-1/2 lg:-translate-x-1/2 lg:whitespace-nowrap lg:rounded-2xl lg:px-[18px] lg:py-[13px]",
      )}
    >
      <Icon name="check_circle" className="text-[20px] text-[#1f9e66] lg:text-[19px]" />
      {children}
    </div>
  );
}

interface FieldBase {
  name: string;
  label: string;
  error?: string;
  hint?: string;
}

/** 入力欄。idは `field-<name>`：FormErrorsが最初の誤り欄へフォーカスを移すために使う。 */
export function TextField({ name, label, error, hint, className, ...rest }: FieldBase & Omit<ComponentProps<"input">, "name">) {
  const hintId = useId();
  const errorId = `field-${name}-error`;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`field-${name}`} className="text-[12px] font-bold text-ink-sub">
        {label}
      </label>
      <input
        {...rest}
        id={`field-${name}`}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={clsx(error && errorId, hint && hintId) || undefined}
        className={clsx(
          "h-[54px] rounded-field border-0 bg-white/[.06] px-4 text-[16px] font-medium text-ink placeholder:text-ink-dim",
          error ? "shadow-[inset_0_0_0_1px_var(--color-alert)]" : "shadow-[inset_0_0_0_1px_rgba(255,255,255,.1)]",
          className,
        )}
      />
      {hint && (
        <p id={hintId} className="text-[12px] text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="flex items-center gap-1.5 text-[13px] font-medium text-alert">
          <Icon name="error" className="text-[17px]" />
          {error}
        </p>
      )}
    </div>
  );
}

export function TextArea({ name, label, error, hint, className, ...rest }: FieldBase & Omit<ComponentProps<"textarea">, "name">) {
  const errorId = `field-${name}-error`;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`field-${name}`} className="text-[12px] font-bold text-ink-sub">
        {label}
      </label>
      <textarea
        {...rest}
        id={`field-${name}`}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={clsx(
          "min-h-24 resize-none rounded-[18px] border-0 bg-white/5 px-4 py-3.5 text-[14px] font-medium leading-[1.7] text-ink",
          error ? "shadow-[inset_0_0_0_1px_var(--color-alert)]" : "shadow-[inset_0_0_0_1px_rgba(255,255,255,.1)]",
          className,
        )}
      />
      {hint && <p className="text-[12px] text-ink-muted">{hint}</p>}
      {error && (
        <p id={errorId} className="flex items-center gap-1.5 text-[13px] font-medium text-alert">
          <Icon name="error" className="text-[17px]" />
          {error}
        </p>
      )}
    </div>
  );
}
