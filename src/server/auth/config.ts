import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import type { AppEnv } from "../env";
import { sha256Hex } from "../mutations/hash";

/**
 * 認証ライブラリ(Better Auth 1.7.7 固定、docs/14 V01)の設定。
 * 認証の役割は「本人が誰か」(identity)の確認だけ。所属・役割・担当・停止は業務表(users/members/…)が正本で、
 * セッションCookieの中身や認証ライブラリのroleを業務認可に使わない（毎要求 src/server/auth/principal.ts がD1から引く）。
 */

export const AUTH_BASE_PATH = "/api/auth";
/** 招待token(生)を運ぶヘッダー。自由なsign-upを閉じ、招待に束縛した登録だけを通すために使う */
export const INVITATION_HEADER = "x-invitation-token";
/** 認証側のセッション寿命（案、D04）。業務側の停止は毎要求D1で判定するのでこの寿命に依存しない */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** 局所実行の鍵(試験・wrangler dev)を本番系で使わないための目印 */
export const DEV_SECRET_PREFIX = "dev-only-";

export type AuthEnv = Pick<AppEnv, "DB" | "APP_ENV" | "BETTER_AUTH_SECRET" | "AUTH_BASE_URL">;

/** 登録メールの正規化（前後空白除去＋小文字）。招待のemail_hashと認証identityの照合に使う */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
export const emailHash = (email: string): Promise<string> => sha256Hex(`email:${normalizeEmail(email)}`);
/** 招待tokenのhash。tokenは256bitの乱数なので単純なSHA-256で足りる（総当たり不能） */
export const tokenHash = (token: string): Promise<string> => sha256Hex(`invitation:${token}`);

export interface ResetMessage {
  /** 認証identityのメール（配送先）。ログ・応答には出さない */
  email: string;
  /** 一回限り・期限付きの再設定token（生）。配送以外に出さない */
  token: string;
}
export interface AuthDeps {
  /**
   * 再設定tokenの配送。D04（配送方式）が未決のため、既定は「どこにも送らない」。
   * 試験は差し替えて捕捉する。実配送を足すときはここにだけ実装する（応答や監査にtokenを出さない）。
   */
  deliverReset?: (msg: ResetMessage) => Promise<void>;
}

/** 設定の不備を起動時に検出する（鍵が短い・本番系で開発用の鍵・baseURLがhttpsでない） */
export function assertAuthEnv(env: AuthEnv): { origin: string; secure: boolean } {
  if (typeof env.BETTER_AUTH_SECRET !== "string" || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error("BETTER_AUTH_SECRET は32文字以上のSecretが必要です");
  }
  if (env.APP_ENV !== "local" && env.BETTER_AUTH_SECRET.startsWith(DEV_SECRET_PREFIX)) {
    throw new Error("開発用のBETTER_AUTH_SECRETは local 以外では使えません");
  }
  let url: URL;
  try {
    url = new URL(env.AUTH_BASE_URL);
  } catch {
    throw new Error("AUTH_BASE_URL がURLではありません");
  }
  const secure = url.protocol === "https:";
  if (env.APP_ENV !== "local" && !secure) throw new Error("local 以外の AUTH_BASE_URL は https が必要です");
  return { origin: url.origin, secure };
}

/** DBへ書く列名をsnake_caseにする対応（04のauth_*表）。ライブラリのスキーマを変えずに名前だけ合わせる */
const dates = { createdAt: "created_at", updatedAt: "updated_at" } as const;

export function createAuth(env: AuthEnv, deps: AuthDeps = {}) {
  const { origin, secure } = assertAuthEnv(env);

  return betterAuth({
    appName: "FireOS",
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    // 同一originだけを信頼する（他originからの変更要求はOrigin検査で403）
    trustedOrigins: [origin],
    user: { modelName: "auth_users", fields: { emailVerified: "email_verified", ...dates } },
    session: {
      modelName: "auth_sessions",
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: 24 * 60 * 60,
      // Cookie session cacheは使わない（失効後も残るため。docs/07 §2）。毎要求D1で検証する
      cookieCache: { enabled: false },
      fields: { userId: "user_id", expiresAt: "expires_at", ipAddress: "ip_address", userAgent: "user_agent", ...dates },
    },
    account: {
      modelName: "auth_accounts",
      accountLinking: { enabled: false },
      fields: {
        accountId: "account_id", providerId: "provider_id", userId: "user_id", accessToken: "access_token",
        refreshToken: "refresh_token", idToken: "id_token", accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at", ...dates,
      },
    },
    verification: {
      modelName: "auth_verifications",
      // 再設定tokenなどの識別子をDBにhashで保存する（DBの閲覧だけでは再設定できない）
      storeIdentifier: "hashed",
      fields: { expiresAt: "expires_at", ...dates },
    },
    emailAndPassword: {
      enabled: true,
      // 自由登録は閉じる。登録は下の hooks.before で「有効な招待token＋招待先メール」に限る
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: true,
      requireEmailVerification: false,
      resetPasswordTokenExpiresIn: 60 * 60,
      // 再設定に成功したら、他の端末のセッションを全て失効させる（docs/07 §2）
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        await deps.deliverReset?.({ email: user.email, token });
      },
    },
    advanced: {
      useSecureCookies: secure,
      cookiePrefix: "fireos",
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure },
    },
    rateLimit: {
      enabled: true,
      // Workersは複数のisolateで動くため、メモリでなくD1に数える
      storage: "database",
      modelName: "auth_rate_limits",
      fields: { lastRequest: "last_request" },
      window: 60,
      max: 60,
      // 値は計測前の案（D18）。総当たりを遅くするため、資格情報を受ける経路を狭くする
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 3 },
        "/reset-password": { window: 60, max: 5 },
        "/two-factor/verify-totp": { window: 60, max: 5 },
        "/two-factor/verify-backup-code": { window: 60, max: 5 },
      },
    },
    plugins: [
      twoFactor({
        issuer: "FireOS",
        backupCodeOptions: { amount: 8, length: 10, storeBackupCodes: "encrypted" },
        // 検証を済ませるまで二要素を有効にしない（途中で放置しても締め出されない）
        skipVerificationOnEnable: false,
        schema: {
          user: { fields: { twoFactorEnabled: "two_factor_enabled" } },
          twoFactor: {
            modelName: "auth_two_factors",
            fields: {
              secret: "secret", backupCodes: "backup_codes", userId: "user_id", verified: "verified",
              failedVerificationCount: "failed_verification_count", lockedUntil: "locked_until",
            },
          },
        },
      }),
    ],
    hooks: {
      // 有効化を確定したら、それ以前に（パスワードだけで）作られた他のセッションを失効させる。
      // 二要素を通っていないセッションが、管理者の操作に残らないようにする。ログイン時の二要素確認（既存セッション無し）では何もしない
      after: createAuthMiddleware(async (ctx) => {
        const before = ctx.context.session?.session;
        // 確認後に新しいセッションへ切り替わる場合は、そちらを残す
        const keep = ctx.context.newSession?.session ?? before;
        if (ctx.path === "/two-factor/verify-totp" && before && keep) {
          await env.DB.prepare("DELETE FROM auth_sessions WHERE user_id = ? AND token <> ?").bind(keep.userId, keep.token).run();
        }
      }),
      before: createAuthMiddleware(async (ctx) => {
        // 「この端末を30日間信頼する」は受け付けない（停止・失効で消せない端末Cookieを作らない）
        if (ctx.path.startsWith("/two-factor/") && (ctx.body as { trustDevice?: unknown } | undefined)?.trustDevice) {
          throw APIError.from("BAD_REQUEST", { code: "TRUST_DEVICE_DISABLED", message: "この端末を信頼する設定は使えません" });
        }
        // 自由なsign-upを許さない。招待tokenを持ち、そのtokenの招待先メールと同じ場合だけ登録できる
        if (ctx.path.startsWith("/sign-up")) {
          await assertInvitedSignUp(env.DB, ctx.headers?.get(INVITATION_HEADER) ?? null, (ctx.body as { email?: unknown } | undefined)?.email);
        }
      }),
    },
    databaseHooks: {
      // 登録経路が増えても、招待先メールのない identity は作れない（二重の防御）
      user: {
        create: {
          before: async (user) => {
            if (!(await hasPendingInvitationFor(env.DB, user.email))) {
              throw APIError.from("FORBIDDEN", { code: "INVITATION_REQUIRED", message: "招待が必要です" });
            }
            // 招待tokenの所持が届け先メールの所有確認（token照合はhooks.beforeで済み）
            return { data: { ...user, emailVerified: true } };
          },
        },
      },
      // 業務側で停止された利用者には、認証が正しくても新しいセッションを作らない
      session: {
        create: {
          before: async (session) => {
            const row = await env.DB.prepare(
              "SELECT u.status FROM users u WHERE u.auth_id = ?",
            ).bind(session.userId).first<{ status: string }>();
            if (row && row.status !== "active") {
              throw APIError.from("FORBIDDEN", { code: "ACCOUNT_DISABLED", message: "このアカウントは利用できません" });
            }
            return { data: session };
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

const forbidden = () => APIError.from("FORBIDDEN", { code: "INVITATION_REQUIRED", message: "招待が必要です" });

/** 招待(未使用・未取消・期限内)がメール宛に存在するか */
async function hasPendingInvitationFor(db: D1Database, email: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM invitations WHERE email_hash = ? AND status = 'pending' AND expires_at > ?")
    .bind(await emailHash(email), new Date().toISOString())
    .first();
  return row !== null;
}

async function assertInvitedSignUp(db: D1Database, token: string | null, email: unknown): Promise<void> {
  if (!token || typeof email !== "string" || token.length < 16 || token.length > 512) throw forbidden();
  const row = await db
    .prepare("SELECT 1 FROM invitations WHERE token_hash = ? AND email_hash = ? AND status = 'pending' AND expires_at > ?")
    .bind(await tokenHash(token), await emailHash(email), new Date().toISOString())
    .first();
  if (!row) throw forbidden();
}
