// Workersのbinding(接続先)と環境識別子の型。wrangler.jsoncのbinding名と一致させる。
import type { SecurityPolicy } from "./security/limits";

export type AppEnvName = "local" | "demo" | "staging" | "production";

export interface AppEnv {
  /** D1: 業務状態・認可・ジョブ・outboxの正本 */
  DB: D1Database;
  /** private R2: 不変添付の保存先 */
  FILES: R2Bucket;
  /** Workers AI。localには無い(常にCloudflare本体へ接続するため)。使う側は存在を確認する */
  AI?: Ai;
  /** 永続ジョブの起動補助(正本はD1のjobs表) */
  JOBS_QUEUE: Queue<JobMessage>;
  /** 静的ファイル(React)配信 */
  ASSETS: Fetcher;
  APP_ENV: AppEnvName;
  /** '1' のとき、localかつ試験環境でだけ x-test-identity での認証注入を許す(src/server/auth/principal.ts)。本番系の設定には置かない */
  TEST_AUTH?: string;
  /** '1' のとき、localかつ試験環境でだけ分類jobの決定的なfake AIを使う(src/server/ai/local-fake.ts)。実AI(binding)がある場合はそちらを優先。本番系の設定には置かない */
  TEST_AI_FAKE?: string;
  /** 認証ライブラリ(Better Auth)の署名鍵。Secret（wrangler secret / .dev.vars）。32文字以上。ログ・応答・Gitに出さない */
  BETTER_AUTH_SECRET: string;
  /** 同一originのベースURL（例: https://fireos.example）。Cookie属性・trustedOrigins・Origin検査の唯一の基準 */
  AUTH_BASE_URL: string;
}

/** Queuesへ載せるのはjob IDだけ。内容はD1から読む(Secret/個人情報をQueueへ複製しない)。 */
export interface JobMessage {
  jobId: string;
}

export interface AppBindings {
  Bindings: AppEnv;
  Variables: {
    requestId: string;
    /** 共通セキュリティ処理のpolicy（applySecurityが設定。user単位の第二計上点が読む。T081） */
    securityPolicy?: SecurityPolicy;
  };
}

const ENV_NAMES: readonly AppEnvName[] = ["local", "demo", "staging", "production"];

export function assertEnvName(value: unknown): AppEnvName {
  if (typeof value === "string" && (ENV_NAMES as readonly string[]).includes(value)) {
    return value as AppEnvName;
  }
  throw new Error(`APP_ENV が不正です: ${String(value)}`);
}
