import { useId, type ComponentProps, type ReactNode } from "react";
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
  /** 実行中。二重タップを防ぐためdisabledになり、ラベルは進行形にする */
  busy?: boolean;
};

export function Button({ variant = "primary", busy, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={clsx(
        "inline-flex w-full items-center justify-center gap-2 rounded-pill font-bold transition active:scale-[0.98]",
        "disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-ink-dim disabled:shadow-none",
        variant === "primary" &&
          "h-14 bg-ember text-[16px] text-white shadow-[0_12px_28px_-8px_rgba(255,90,46,.7)] hover:bg-ember-hover",
        variant === "secondary" && "h-[52px] bg-white/10 text-[15px] text-ink hover:bg-white/[.14]",
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
  neutral: "bg-white/10 text-[#c3cad6]",
  ok: "bg-ok/15 text-ok",
  attention: "bg-attention/15 text-attention",
  alert: "bg-alert/15 text-alert",
  ai: "bg-ai/15 text-ai",
} as const;
export type Tone = keyof typeof tones;

/** 状態チップ。色だけに頼らず必ずアイコンと文字を持つ（docs/03 §1）。 */
export function Chip({ tone = "neutral", icon, children }: { tone?: Tone; icon?: string; children: ReactNode }) {
  return (
    <span className={clsx("inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-[12px] font-bold", tones[tone])}>
      {icon && <Icon name={icon} className="text-[14px]" />}
      {children}
    </span>
  );
}

const bannerTones = {
  error: "bg-alert/[.08] shadow-[inset_0_0_0_1px_rgba(255,90,70,.3)] text-[#ffb0a4]",
  warning: "bg-attention/[.08] shadow-[inset_0_0_0_1px_rgba(255,195,92,.3)] text-[#ffdca0]",
  success: "bg-ok/[.07] shadow-[inset_0_0_0_1px_rgba(58,208,143,.22)] text-[#bfe9d6]",
  info: "bg-white/[.04] shadow-[inset_0_0_0_1px_rgba(255,255,255,.1)] text-ink-sub",
} as const;

export function Banner({
  tone,
  icon,
  title,
  children,
  role,
}: {
  tone: keyof typeof bannerTones;
  icon: string;
  title: string;
  children?: ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <div role={role} className={clsx("flex gap-3 rounded-[24px] p-4", bannerTones[tone])}>
      <Icon name={icon} fill className="text-[22px]" />
      <div className="min-w-0">
        <p className="text-[14px] font-bold">{title}</p>
        {children && <div className="mt-1 text-[13px] leading-relaxed opacity-90">{children}</div>}
      </div>
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
          "h-[54px] rounded-field border-0 bg-white/[.06] px-4 text-[16px] text-ink placeholder:text-ink-dim",
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
        <p id={errorId} className="flex items-center gap-1.5 text-[13px] text-alert">
          <Icon name="error" fill className="text-[16px]" />
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
          "min-h-24 rounded-[18px] border-0 bg-white/5 px-4 py-3.5 text-[16px] text-ink",
          error ? "shadow-[inset_0_0_0_1px_var(--color-alert)]" : "shadow-[inset_0_0_0_1px_rgba(255,255,255,.1)]",
          className,
        )}
      />
      {hint && <p className="text-[12px] text-ink-muted">{hint}</p>}
      {error && (
        <p id={errorId} className="flex items-center gap-1.5 text-[13px] text-alert">
          <Icon name="error" fill className="text-[16px]" />
          {error}
        </p>
      )}
    </div>
  );
}
