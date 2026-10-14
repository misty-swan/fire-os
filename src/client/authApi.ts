import { authLibrary } from "../shared/contracts/auth";

/**
 * 認証ライブラリ(API-36、/api/auth/*)の呼び出し。業務APIの envelope・Idempotency-Key は対象外で、契約の一覧
 * (authLibrary.endpoints)にある経路だけを呼ぶ。利用者に見せる文言は、登録の有無やパスワードの正誤を区別しない。
 */
export type AuthFailure =
  | "invalid_credentials" // メール/パスワードの誤り、または未登録（区別しない）
  | "invalid_code" // 認証コード/回復コードの誤り（使用済みを含む）
  | "limited" // 回数制限
  | "disabled" // 停止されたアカウント
  | "invitation" // 招待が使えない（期限切れ・取消・メール不一致・token誤り）
  | "weak_password"
  | "exists" // すでに登録済み
  | "network"
  | "unknown";

export class AuthError extends Error {
  constructor(public readonly kind: AuthFailure, public readonly status = 0) {
    super(kind);
  }
}

export const AUTH_MESSAGES: Record<AuthFailure, string> = {
  invalid_credentials: "メールアドレスまたはパスワードが正しくありません",
  invalid_code: "コードが正しくないか、すでに使われています",
  limited: "試行が多すぎます。しばらくしてからやり直してください",
  disabled: "このアカウントは利用できません。分団の管理者へ連絡してください",
  invitation: "この招待は使えません。期限切れ・取消済み、またはメールアドレスが招待先と違う可能性があります。分団の管理者に確認してください",
  weak_password: "パスワードは12文字以上で入力してください",
  exists: "このメールアドレスはすでに登録されています。ログインして続きを進めてください",
  network: "通信できません。接続を確認してもう一度お試しください",
  unknown: "処理に失敗しました。しばらくしてからもう一度お試しください",
};

const ALLOWED = new Set(authLibrary.endpoints.map((e) => `${e.method} ${e.path}`));

async function call<T>(method: "GET" | "POST", path: (typeof authLibrary.endpoints)[number]["path"], body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T }> {
  if (!ALLOWED.has(`${method} ${path}`)) throw new Error(`契約に無い認証経路です: ${method} ${path}`);
  let res: Response;
  try {
    res = await fetch(`${authLibrary.basePath}${path}`, {
      method,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new AuthError("network");
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* 本文なし */
  }
  if (!res.ok) throw new AuthError(classify(res.status, data), res.status);
  return { status: res.status, data: data as T };
}

function classify(status: number, data: unknown): AuthFailure {
  const code = (data as { code?: string } | null)?.code ?? "";
  if (status === 429) return "limited";
  if (code === "ACCOUNT_DISABLED") return "disabled";
  if (code === "INVITATION_REQUIRED") return "invitation";
  if (code === "USER_ALREADY_EXISTS" || code.startsWith("USER_ALREADY_EXISTS")) return "exists";
  if (code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_TOO_LONG") return "weak_password";
  if (status === 401 || code === "INVALID_EMAIL_OR_PASSWORD" || code === "INVALID_PASSWORD") return "invalid_credentials";
  if (code === "INVALID_CODE" || code === "INVALID_BACKUP_CODE" || code === "INVALID_TWO_FACTOR_COOKIE" || status === 400) return "invalid_code";
  return "unknown";
}

export interface SignInResult {
  /** true のとき、認証コード（または回復コード）の確認が必要 */
  twoFactorRequired: boolean;
}

export async function signIn(email: string, password: string): Promise<SignInResult> {
  try {
    const { data } = await call<{ twoFactorRedirect?: boolean }>("POST", "/sign-in/email", { email, password });
    return { twoFactorRequired: Boolean(data?.twoFactorRedirect) };
  } catch (e) {
    // 400は入力形式の誤り（メール形式など）。資格情報の誤りと同じ文言にする
    if (e instanceof AuthError && e.kind === "invalid_code") throw new AuthError("invalid_credentials", e.status);
    throw e;
  }
}
export const signOut = () => call("POST", "/sign-out", {});
/** 二要素の確認。誤り・使用済み・期限切れはまとめて「コードが正しくない」にする（回数制限と停止だけ別） */
async function secondFactor(path: "/two-factor/verify-totp" | "/two-factor/verify-backup-code", code: string) {
  try {
    return await call("POST", path, { code });
  } catch (e) {
    if (e instanceof AuthError && (e.kind === "invalid_credentials" || e.kind === "unknown")) throw new AuthError("invalid_code", e.status);
    throw e;
  }
}
export const verifyTotp = (code: string) => secondFactor("/two-factor/verify-totp", code);
export const verifyBackupCode = (code: string) => secondFactor("/two-factor/verify-backup-code", code);

export async function signUpWithInvitation(token: string, email: string, password: string): Promise<{ authId: string }> {
  const { data } = await call<{ user: { id: string } }>("POST", "/sign-up/email", { email, password, name: "団員" }, { "x-invitation-token": token });
  return { authId: data.user.id };
}
export async function currentAuthId(): Promise<string | null> {
  const { data } = await call<{ user: { id: string } } | null>("GET", "/get-session");
  return data?.user.id ?? null;
}
export const requestPasswordReset = (email: string) => call("POST", "/request-password-reset", { email });
export const resetPassword = (token: string, newPassword: string) => call("POST", "/reset-password", { token, newPassword });

export interface TwoFactorSetup {
  totpURI: string;
  backupCodes: string[];
}
export async function enableTwoFactor(password: string): Promise<TwoFactorSetup> {
  try {
    return (await call<TwoFactorSetup>("POST", "/two-factor/enable", { password })).data;
  } catch (e) {
    if (e instanceof AuthError && (e.kind === "invalid_credentials" || e.kind === "invalid_code")) throw new AuthError("invalid_credentials", e.status);
    throw e;
  }
}
export async function regenerateBackupCodes(password: string): Promise<string[]> {
  try {
    return (await call<{ backupCodes: string[] }>("POST", "/two-factor/generate-backup-codes", { password })).data.backupCodes;
  } catch (e) {
    if (e instanceof AuthError && (e.kind === "invalid_credentials" || e.kind === "invalid_code")) throw new AuthError("invalid_credentials", e.status);
    throw e;
  }
}
