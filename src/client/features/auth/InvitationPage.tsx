import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { AUTH_MESSAGES, AuthError, currentAuthId, signIn, signUpWithInvitation } from "../../authApi";
import { Button, Icon, TextField } from "../../components/ui";
import { MeGate, useMe } from "../../me";
import { useMutation } from "../../useMutation";
import { StepHeading, monoField } from "./AuthLayout";
import { MfaPanel } from "./MfaPanel";

const REASON: Record<string, string> = {
  expired: "この招待は期限切れです。分団の管理者に再発行を依頼してください",
  cancelled: "この招待は取り消されています。分団の管理者に確認してください",
  already_used: "この招待はすでに使われています。登録済みならログインしてください",
  identity_mismatch: "招待先のメールアドレスと一致しません。招待された宛先のメールアドレスで登録してください",
  member_already_linked: "この団員はすでにアカウントと結びついています",
  member_not_active: "この団員は現在、利用できない状態です。分団の管理者に確認してください",
  identity_already_linked: "このアカウントはすでに別の団員と結びついています",
};

/** 非必須の利用者は後で設定できる。管理者(必須)には出さない */
function SkipSetup({ next }: { next: string }) {
  const navigate = useNavigate();
  const { me } = useMe();
  if (me.mfaRequired) return null;
  return (
    <Button variant="secondary" onClick={() => navigate(next, { replace: true })}>
      あとで設定する
    </Button>
  );
}

/**
 * 招待の受領（自由な新規登録ではない）。管理者から渡された招待tokenで、招待先のメールアドレスのアカウントを作り、
 * 団員に結びつける。token はURLの # 以降から取り、画面に出さずアドレスからも消す（履歴・Refererに残さない）。
 * 登録だけ済んで受領が途中で止まった場合は、同じ画面で「ログインして続きから」受領できる。
 */
export function InvitationPage({ token, next }: { token: string; next: string }) {
  const navigate = useNavigate();
  const accept = useMutation("API-35");
  const [step, setStep] = useState<"register" | "resume" | "mfa">("register");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [field, setField] = useState<"email" | "password" | "password2" | "">("");

  const fail = (f: typeof field, message: string) => {
    setField(f);
    setError(message);
    document.getElementById(`field-${f || "email"}`)?.focus();
  };

  async function finish(authId: string) {
    const r = await accept.run({ body: { token, verifiedAuthIdentity: authId } });
    if (!r) return false;
    // 受領できた。続けて二要素認証の設定へ（管理者は必須、それ以外は後でもよい）
    setStep("mfa");
    return true;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setField("");
    if (!email.includes("@")) return fail("email", "招待先のメールアドレスを入力してください");
    if (step === "register") {
      if (password.length < 12) return fail("password", AUTH_MESSAGES.weak_password);
      if (password !== password2) return fail("password2", "確認用のパスワードが一致しません");
    }
    setBusy(true);
    try {
      if (step === "register") {
        const { authId } = await signUpWithInvitation(token, email, password);
        await finish(authId);
      } else {
        await signIn(email, password);
        const authId = await currentAuthId();
        if (authId) await finish(authId);
      }
    } catch (err) {
      const kind = err instanceof AuthError ? err.kind : "unknown";
      if (kind === "exists") {
        setStep("resume");
        setPassword2("");
      }
      setError(AUTH_MESSAGES[kind]);
    } finally {
      setBusy(false);
    }
  }

  // 受領APIの失敗は理由つきで示す。招待は使えないまま画面に留まる
  const rejected =
    accept.state.kind === "rejected" || accept.state.kind === "conflict" || accept.state.kind === "forbidden" ? accept.state.details[0]?.reason : undefined;
  const acceptError =
    accept.state.kind === "unknown" ? "結果を確認できませんでした。もう一度押すと、同じ内容で再送します（二重には登録されません）"
    : accept.state.kind === "limited" ? AUTH_MESSAGES.limited
    : rejected ? (REASON[rejected] ?? AUTH_MESSAGES.invitation)
    : accept.state.kind === "forbidden" ? AUTH_MESSAGES.invitation
    : "";

  if (step === "mfa") {
    return (
      <>
        <StepHeading eyebrow="STEP 2 / 2" title="二要素認証を設定します">受け取りが完了しました。パスワードが漏れても入られにくくするため、二要素認証の設定をおすすめします（管理者は必須です）。</StepHeading>
        <MeGate>
          <MfaPanel onDone={() => navigate(next, { replace: true })} />
          <SkipSetup next={next} />
        </MeGate>
      </>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3.5">
      <StepHeading eyebrow="INVITATION" title={step === "register" ? "招待を受け取る" : "ログインして続きから受け取る"}>
        {step === "register"
          ? "分団の管理者から届いた招待です。招待された宛先のメールアドレスと、新しいパスワード（12文字以上）を入力してください。"
          : "このメールアドレスは登録済みです。パスワードでログインすると、招待の受け取りを続けます。"}
      </StepHeading>
      <TextField name="email" label="メールアドレス" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} error={field === "email" ? error : undefined} className={monoField} />
      <TextField name="password" label={step === "register" ? "新しいパスワード（12文字以上）" : "パスワード"} type="password" autoComplete={step === "register" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} error={field === "password" ? error : undefined} className={monoField} />
      {step === "register" && (
        <TextField name="password2" label="パスワード（確認）" type="password" autoComplete="new-password" value={password2} onChange={(e) => setPassword2(e.target.value)} error={field === "password2" ? error : undefined} className={monoField} />
      )}
      {(error && !field) || acceptError ? (
        <p role="alert" className="flex items-center gap-2 text-[13px] font-medium text-alert">
          <Icon name="error" className="text-[18px]" />
          {error || acceptError}
        </p>
      ) : null}
      <Button type="submit" busy={busy || accept.saving} className="mt-2.5">
        {busy || accept.saving ? "処理しています…" : step === "register" ? "アカウントを作成して受け取る" : "ログインして受け取る"}
      </Button>
    </form>
  );
}
