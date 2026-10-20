import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { AUTH_MESSAGES, AuthError, requestPasswordReset, resetPassword, signIn, signOut, verifyBackupCode, verifyTotp } from "../../authApi";
import { ApiError, api } from "../../api";
import { Button, Icon, Notice, TextField } from "../../components/ui";
import { MeGate } from "../../me";
import { AuthLayout, StepHeading, monoField, safeNext } from "./AuthLayout";
import { InvitationPage } from "./InvitationPage";
import { MfaPanel } from "./MfaPanel";

const errText = (e: unknown) => AUTH_MESSAGES[e instanceof AuthError ? e.kind : "unknown"];

/** URLの # 以降（招待・再設定のtoken）を読み、読んだらアドレスから消す。tokenを履歴・共有・Refererに残さない */
function useFragmentSecret(key: "invite" | "reset"): [string | null, () => void] {
  const read = () => (typeof window === "undefined" ? null : new URLSearchParams(window.location.hash.slice(1)).get(key));
  const [value, setValue] = useState<string | null>(read);
  // 同じ画面のまま別の招待リンクを開いた（# だけが変わる）場合も、新しいtokenを読む
  useEffect(() => {
    const onHash = () => {
      const v = read();
      if (v) setValue(v);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (value) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, [value]);
  return [value, () => setValue(null)];
}

/** パスワードの再設定（本人確認済みのtokenでのみ）。tokenの配送手段はD04未決のため、tokenは管理者または配送経路から受け取る */
function RecoveryPanel({ token, onBack }: { token: string | null; onBack: () => void }) {
  const [email, setEmail] = useState("");
  const [tokenInput, setTokenInput] = useState(token ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState(false);
  const [haveToken, setHaveToken] = useState(Boolean(token));

  async function request(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await requestPasswordReset(email);
      setSent(true); // 登録の有無にかかわらず同じ表示
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  async function reset(e: FormEvent) {
    e.preventDefault();
    if (password.length < 12) return setError(AUTH_MESSAGES.weak_password);
    setBusy(true);
    setError("");
    try {
      await resetPassword(tokenInput.trim(), password);
      setDone(true);
    } catch (err) {
      setError(err instanceof AuthError && err.kind === "invalid_code" ? "再設定の期限が切れているか、すでに使われています。もう一度申請してください" : errText(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <>
        <StepHeading eyebrow="RECOVERY" title="パスワードを再設定しました">他の端末のログインはすべて解除されました。新しいパスワードでログインしてください。</StepHeading>
        <Button onClick={onBack}>ログインへ</Button>
      </>
    );
  }
  // フォーム全体の誤り。idで入力欄に関連付ける（PH1-C。欄ごとの誤りではないためTextFieldのerror propは使わない）
  const errorLine = error && (
    <p id="recovery-form-error" role="alert" className="flex items-center gap-2 text-[13px] font-medium text-alert">
      <Icon name="error" className="text-[18px]" />
      {error}
    </p>
  );
  return (
    <>
      <StepHeading eyebrow="RECOVERY" title="パスワードの再設定">
        再設定の連絡は、分団の管理者が確認した宛先にだけ届きます。届いた再設定コードがあれば、下の欄に入力してください。
      </StepHeading>
      {haveToken ? (
        <form onSubmit={reset} noValidate className="flex flex-col gap-3.5">
          <TextField name="reset-token" label="再設定コード" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} describedBy={error ? "recovery-form-error" : undefined} className={monoField} />
          <TextField name="password" label="新しいパスワード（12文字以上）" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} describedBy={error ? "recovery-form-error" : undefined} className={monoField} />
          {errorLine}
          <Button type="submit" busy={busy} disabled={!tokenInput || !password}>
            {busy ? "処理しています…" : "再設定する"}
          </Button>
        </form>
      ) : (
        <form onSubmit={request} noValidate className="flex flex-col gap-3.5">
          <TextField name="email" label="登録したメールアドレス" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} describedBy={error ? "recovery-form-error" : undefined} className={monoField} />
          {sent && (
            <Notice tone="info" icon="mark_email_read" role="status">
              登録されている場合は、再設定の案内を手配します。届かないときは分団の管理者へ連絡してください。
            </Notice>
          )}
          {errorLine}
          <Button type="submit" busy={busy} disabled={!email}>
            {busy ? "送信しています…" : "再設定を申請する"}
          </Button>
          <button type="button" className="max-lg:min-h-11 text-[13px] font-bold text-ember-soft underline" onClick={() => setHaveToken(true)}>
            再設定コードをお持ちの方
          </button>
        </form>
      )}
      <Button variant="secondary" onClick={onBack}>
        ログインへ戻る
      </Button>
    </>
  );
}

/**
 * SCR-01 ログイン（prototype LOGIN）。メール＋パスワード → 二要素が有効なら認証コード（または回復コード）→ ホーム。
 * 招待の受領（#invite=…）と再設定（#reset=… / #recover）も同じ見た目で出す。自由な新規登録は出さない。
 * 「生体認証でログイン」は passkey の実装まで無効表示（押しても何も起きない状態を作らない）。
 */
export function LoginPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const next = safeNext(new URLSearchParams(location.search).get("next"));
  const [inviteToken] = useFragmentSecret("invite");
  const [resetToken, clearReset] = useFragmentSecret("reset");
  const [recover, setRecover] = useState(() => typeof window !== "undefined" && window.location.hash === "#recover");
  // ログイン済みの利用者が二要素認証を設定/回復コードを作り直すための入口（#mfa）
  const [mfaOnly] = useState(() => typeof window !== "undefined" && window.location.hash === "#mfa");

  const [step, setStep] = useState<"password" | "second" | "backup" | "mfa-setup">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  /** ログインできたら、業務側で利用できる状態か確認してから入る（招待未受領・停止は入れない） */
  async function enter() {
    try {
      const me = await api("API-01", {});
      if (me.mfaRequired && !me.mfaEnabled) setStep("mfa-setup");
      else navigate(next, { replace: true });
    } catch (e) {
      await signOut().catch(() => undefined);
      setStep("password");
      setPassword("");
      setCode("");
      setError(
        e instanceof ApiError && e.status === 401
          ? "このアカウントはまだ利用できません。招待の受領が済んでいないか、停止されています。分団の管理者へ連絡してください"
          : AUTH_MESSAGES.unknown,
      );
    }
  }

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!email || !password) return setError("メールアドレスとパスワードを入力してください");
    setBusy(true);
    try {
      const r = await signIn(email, password);
      if (r.twoFactorRequired) {
        setStep("second");
        setPassword("");
      } else await enter();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await (step === "backup" ? verifyBackupCode(code.trim()) : verifyTotp(code.trim()));
      await enter();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  // フォーム全体の誤り。idで入力欄に関連付ける（PH1-C。欄ごとの誤りではないためTextFieldのerror propは使わない）
  const errorLine = error && (
    <p id="login-form-error" role="alert" className="flex items-center gap-2 text-[13px] font-medium text-alert">
      <Icon name="error" className="text-[18px]" />
      {error}
    </p>
  );

  if (inviteToken) {
    return (
      <AuthLayout hint="招待は、分団の管理者が発行します">
        <InvitationPage key={inviteToken} token={inviteToken} next={next} />
      </AuthLayout>
    );
  }
  if (resetToken || recover) {
    return (
      <AuthLayout>
        <RecoveryPanel key={resetToken ?? "recover"} token={resetToken} onBack={() => { setRecover(false); clearReset(); }} />
      </AuthLayout>
    );
  }
  if (mfaOnly) {
    return (
      <AuthLayout hint="二要素認証の設定を変えるには、ログインが必要です">
        <StepHeading eyebrow="SECURITY" title="二要素認証" />
        <MeGate>
          <MfaPanel onDone={() => navigate("/app/menu", { replace: true })} />
          <Button variant="secondary" onClick={() => navigate("/app/menu", { replace: true })}>
            メニューへ戻る
          </Button>
        </MeGate>
      </AuthLayout>
    );
  }
  if (step === "mfa-setup") {
    return (
      <AuthLayout>
        <StepHeading eyebrow="SECURITY" title="二要素認証を設定します">管理者のアカウントは二要素認証が必須です。設定が済むまで、招待や権限の操作はできません。</StepHeading>
        <MeGate>
          <MfaPanel onDone={() => navigate(next, { replace: true })} />
        </MeGate>
        <Button variant="secondary" onClick={() => navigate(next, { replace: true })}>
          あとで設定する
        </Button>
      </AuthLayout>
    );
  }
  if (step === "second" || step === "backup") {
    const backup = step === "backup";
    return (
      <AuthLayout hint="認証アプリも回復コードも使えない場合は、別の管理者へ連絡してください">
        <form onSubmit={submitCode} noValidate className="flex flex-col gap-3.5">
          <StepHeading eyebrow="TWO-FACTOR" title={backup ? "回復コードでログイン" : "認証コードを入力"}>
            {backup ? "保管している回復コードを1つ入力してください。使ったコードは二度と使えません。" : "認証アプリに表示されている6桁の数字を入力してください。"}
          </StepHeading>
          <TextField
            name="code"
            label={backup ? "回復コード" : "認証コード（6桁）"}
            inputMode={backup ? "text" : "numeric"}
            autoComplete="one-time-code"
            maxLength={backup ? 11 : 6}
            autoFocus
            value={code}
            onChange={(e) => setCode(backup ? e.target.value : e.target.value.replace(/\D/g, ""))}
            describedBy={error ? "login-form-error" : undefined}
            className={`${monoField} tracking-[.2em]`}
          />
          {errorLine}
          <Button type="submit" busy={busy} disabled={backup ? code.length < 10 : code.length !== 6} className="mt-2.5">
            {busy ? "確認しています…" : "確認する"}
          </Button>
          <Button variant="secondary" onClick={() => { setStep(backup ? "second" : "backup"); setCode(""); setError(""); }}>
            {backup ? "認証コードに戻る" : "回復コードを使う"}
          </Button>
          <button type="button" className="max-lg:min-h-11 text-[13px] font-bold text-ink-sub underline" onClick={() => { setStep("password"); setCode(""); setError(""); }}>
            最初からやり直す
          </button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <form onSubmit={submitPassword} noValidate className="flex flex-col gap-3.5">
        <TextField name="email" label="メールアドレス" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} describedBy={error ? "login-form-error" : undefined} className={monoField} />
        <TextField
          name="password"
          label="パスワード"
          type="password"
          autoComplete="current-password"
          placeholder="パスワードを入力"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(""); }}
          describedBy={error ? "login-form-error" : undefined}
          className={monoField}
        />
        {errorLine}
        <Button type="submit" busy={busy} className="mt-2.5">
          {busy ? "認証しています…" : "ログイン"}
        </Button>
        <Button variant="secondary" disabled title="生体認証（パスキー）は後続で対応します">
          <Icon name="fingerprint" className="text-[20px]" />
          生体認証でログイン
        </Button>
        <button type="button" className="mx-auto max-lg:min-h-11 text-[12px] font-bold text-ember-soft underline" onClick={() => setRecover(true)}>
          パスワードの再設定
        </button>
      </form>
    </AuthLayout>
  );
}
