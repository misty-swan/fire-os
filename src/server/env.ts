// Workersのbinding(接続先)と環境識別子の型。wrangler.jsoncのbinding名と一致させる。

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
}

/** Queuesへ載せるのはjob IDだけ。内容はD1から読む(Secret/個人情報をQueueへ複製しない)。 */
export interface JobMessage {
  jobId: string;
}

export interface AppBindings {
  Bindings: AppEnv;
  Variables: { requestId: string };
}

const ENV_NAMES: readonly AppEnvName[] = ["local", "demo", "staging", "production"];

export function assertEnvName(value: unknown): AppEnvName {
  if (typeof value === "string" && (ENV_NAMES as readonly string[]).includes(value)) {
    return value as AppEnvName;
  }
  throw new Error(`APP_ENV が不正です: ${String(value)}`);
}
