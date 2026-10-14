import { useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { useEffect } from "react";
import { AUTH_MESSAGES, AuthError, enableTwoFactor, regenerateBackupCodes, verifyTotp, type TwoFactorSetup } from "../../authApi";
import { Banner, Button, Icon, Notice, TextField } from "../../components/ui";
import { useMe } from "../../me";

const errText = (e: unknown) => AUTH_MESSAGES[e instanceof AuthError ? e.kind : "unknown"];

/** 回復コードの一回表示。保管したことを確認するまで閉じられない（再表示はできない） */
function RecoveryCodes({ codes, onAck, label }: { codes: string[]; onAck: () => void; label: string }) {
  const [acked, setAcked] = useState(false);
  const text = codes.join("\n");
  return (
    <div className="flex flex-col gap-3.5">
      <Banner tone="warning" eyebrow="RECOVERY CODES" title="回復コードを保管してください">
        認証アプリが使えないときの代わりです。<b>この画面でしか表示されません</b>。各コードは一度しか使えません。紙に書くか、パスワード管理アプリに保存してください。
      </Banner>
      <ul aria-label="回復コード" className="hairline grid grid-cols-2 gap-x-3 gap-y-2 rounded-card bg-white/[.04] p-4 font-mono text-[15px]">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(text)} className="flex-1 !text-[13px]">
          <Icon name="content_copy" className="text-[18px]" />
          コピー
        </Button>
        <a
          download="fireos-recovery-codes.txt"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(text + "\n")}`}
          className="inline-flex h-[52px] flex-1 items-center justify-center gap-2 rounded-pill bg-white/[.08] text-[13px] font-bold hover:bg-white/[.12]"
        >
          <Icon name="download" className="text-[18px]" />
          ファイルに保存
        </a>
      </div>
      <label className="flex items-start gap-2.5 text-[13px] leading-[1.6]">
        <input type="checkbox" checked={acked} onChange={(e) => setAcked(e.target.checked)} className="mt-1 size-[18px]" />
        回復コードを安全な場所に保管しました
      </label>
      <Button disabled={!acked} onClick={onAck}>
        {label}
      </Button>
    </div>
  );
}

/**
 * 二要素認証（TOTP＋回復コード）の設定と状態。パスワードの再確認 → 認証アプリに登録 → 6桁で確認 → 回復コードを一度だけ表示。
 * 確認が済むまで有効にならない（途中で放置しても締め出されない）。解除経路は提供しない（本人確認なしのMFA解除を作らない）。
 * 管理者は必須（未設定だと招待・権限・監査の操作が拒否される）。
 */
export function MfaPanel({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const { me, refresh } = useMe();
  const [step, setStep] = useState<"idle" | "password" | "scan" | "codes" | "regen">("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [qr, setQr] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!setup) return;
    let live = true;
    void QRCode.toDataURL(setup.totpURI, { margin: 1, width: 192 }).then((u) => live && setQr(u));
    return () => {
      live = false;
    };
  }, [setup]);

  const secret = setup ? new URL(setup.totpURI).searchParams.get("secret") ?? "" : "";

  async function start(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setSetup(await enableTwoFactor(password));
      setPassword("");
      setStep("scan");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await verifyTotp(code.trim());
      setCodes(setup!.backupCodes);
      setSetup(null);
      setCode("");
      setStep("codes");
      await refresh();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  async function regenerate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setCodes(await regenerateBackupCodes(password));
      setPassword("");
      setStep("codes");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  const finish = () => {
    setCodes([]);
    setStep("idle");
    onDone?.();
  };

  if (step === "codes") return <RecoveryCodes codes={codes} onAck={finish} label="完了" />;

  const errorLine = error && (
    <p role="alert" className="flex items-center gap-1.5 text-[13px] font-medium text-alert">
      <Icon name="error" className="text-[17px]" />
      {error}
    </p>
  );

  if (step === "password" || step === "regen") {
    return (
      <form onSubmit={step === "password" ? start : regenerate} noValidate className="flex flex-col gap-3.5">
        <p className="text-[13px] leading-[1.7] text-ink-sub">
          {step === "password" ? "設定を始める前に、パスワードを再入力してください。" : "回復コードを作り直すと、古いコードは使えなくなります。パスワードを再入力してください。"}
        </p>
        <TextField name="mfa-password" label="パスワード" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="font-mono" />
        {errorLine}
        <Button type="submit" busy={busy} disabled={!password}>
          {busy ? "確認しています…" : "次へ"}
        </Button>
        <Button variant="secondary" onClick={() => { setStep("idle"); setError(""); setPassword(""); }}>
          やめる
        </Button>
      </form>
    );
  }

  if (step === "scan" && setup) {
    return (
      <form onSubmit={confirm} noValidate className="flex flex-col gap-3.5">
        <p className="text-[13px] leading-[1.7] text-ink-sub">
          認証アプリ（Google Authenticator など）で、下のQRコードを読み取るか、キーを入力してください。表示された6桁の数字を入力すると有効になります。
        </p>
        <div className="flex flex-col items-center gap-3 rounded-card bg-white/[.04] p-4">
          {qr && <img src={qr} alt="認証アプリ用のQRコード" width={192} height={192} className="rounded-xl bg-white p-1.5" />}
          <p className="text-center font-mono text-[13px] tracking-[.08em] text-ink-sub" aria-label="手入力用のキー">
            {secret.replace(/(.{4})/g, "$1 ").trim()}
          </p>
          <a href={setup.totpURI} className="text-[12px] font-bold text-ember-soft underline">この端末の認証アプリで開く</a>
        </div>
        <TextField name="mfa-code" label="認証アプリの6桁" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className="font-mono tracking-[.3em]" />
        {errorLine}
        <Button type="submit" busy={busy} disabled={code.length !== 6}>
          {busy ? "確認しています…" : "確認して有効にする"}
        </Button>
      </form>
    );
  }

  // idle
  return (
    <div className="flex flex-col gap-3.5">
      {me.mfaEnabled ? (
        <>
          <Notice tone="info" icon="verified_user" role="status">
            二要素認証は<b>有効</b>です。
          </Notice>
          {!compact && (
            <Button variant="secondary" onClick={() => setStep("regen")}>
              回復コードを作り直す
            </Button>
          )}
        </>
      ) : (
        <>
          {me.mfaRequired ? (
            <Banner tone="warning" eyebrow="MFA REQUIRED" role="alert" title="二要素認証の設定が必要です">
              管理者は、設定が済むまで招待・権限変更・監査の閲覧ができません。
            </Banner>
          ) : (
            <Notice tone="info" icon="shield" role="status">二要素認証は未設定です。設定すると、パスワードが漏れてもログインされにくくなります。</Notice>
          )}
          <Button onClick={() => setStep("password")}>二要素認証を設定する</Button>
        </>
      )}
    </div>
  );
}
