import type { AppEnv } from "../env";
import { createAuth, type Auth, type AuthDeps, type AuthEnv } from "./config";

/** 認証ライブラリが確認した「本人(identity)」。業務の利用者・団員・権限とは別物（毎要求D1の業務表で解決する） */
export interface AuthIdentity {
  /** auth_users.id。業務 users.auth_id と対応する */
  authId: string;
  /** 正規化前のメール。応答・ログへは出さない（招待の照合だけに使う） */
  email: string;
  twoFactorEnabled: boolean;
  sessionId: string;
}

export interface AuthService {
  /** /api/auth/* をライブラリへ渡す（API-36） */
  handle(request: Request): Promise<Response>;
  /** Cookieのセッションを検証してidentityを返す。無効・期限切れ・失効済みはnull。Cookie cacheは使わない */
  session(request: Request): Promise<AuthIdentity | null>;
  /** 認証側の全セッションを削除する。失敗しても業務側の停止は先にcommit済みで、業務認可が遮断する（T012） */
  revokeAll(authId: string): Promise<void>;
  /** 試験・運用の補助：ライブラリが持つ内部の道具（招待登録のアカウント作成等で使う） */
  readonly auth: Auth;
}

export function createAuthService(env: AuthEnv, deps: AuthDeps = {}): AuthService {
  const auth = createAuth(env, deps);
  return {
    auth,
    async handle(request) {
      const response = await auth.handler(request);
      // 認証の応答（セッション/token/二要素の秘密を含み得る）は共有キャッシュに残さない
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
    async session(request) {
      const result = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
      if (!result) return null;
      return {
        authId: result.user.id,
        email: result.user.email,
        twoFactorEnabled: Boolean((result.user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled),
        sessionId: result.session.id,
      };
    },
    async revokeAll(authId) {
      const ctx = await auth.$context;
      await ctx.internalAdapter.deleteUserSessions(authId);
    },
  };
}

/** Workers内では一つのisolateが複数要求を処理するため、DB bindingごとに生成を使い回す（設定は環境が変わらない限り不変） */
const cache = new WeakMap<D1Database, AuthService>();
export function authServiceFor(env: AppEnv, deps?: AuthDeps): AuthService {
  if (deps) return createAuthService(env, deps);
  let svc = cache.get(env.DB);
  if (!svc) {
    svc = createAuthService(env);
    cache.set(env.DB, svc);
  }
  return svc;
}
