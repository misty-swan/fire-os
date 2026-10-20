import type { MiddlewareHandler } from "hono";
import { apiDef, apiIds, type ApiId } from "../../shared/contracts/registry";
import type { AppBindings } from "../env";
import { HttpError, errorResponse, type ApiApp, type ApiContext } from "../http";
import { securityHeaders } from "./headers";

/**
 * 共通セキュリティ処理の注入点（T081、docs/07 §2、docs/05 §1の429行）。
 *
 * - `SecurityPolicy` は試験とT082の負荷試験が差し替えられる注入型。既定（DEVELOPMENT_SECURITY_POLICY）
 *   は**寛容な開発設定**で、既存の試験・e2e・通常運用を止めない（controller裁定2）。厳しい上限の挙動
 *   （429・auth/AI/search/upload別の区分）はpolicyを注入する試験（tests/security/）が観測する。
 * - 上限は**2層**でdocs/07 §2（D18）の「IP＋user単位」を満たす: ①IP境界（このmiddleware。未認証も計上。
 *   鍵はcf-connecting-ip。proxy無しのlocalでは"-"にまとまる）、②user単位（**認証解決後の第二計上点**。
 *   `enforceUserRateLimit`をresolvePrincipalが呼ぶ。鍵はusers.id。`SecurityPolicy.userRateLimit`）。
 *   認証経路（/api/auth/*）はライブラリがD1に数えるuser/IP単位の上限（src/server/auth/config.tsのrateLimit。
 *   sign-in/sign-up 5回/分）が担当。
 * - アプリ内の計数は**isolate内のメモリ**（Workerの1実行体）でしかない。厳密な全体上限はCloudflare側の
 *   WAF/Rate Limiting製品層で行う前提（docs/evidence/security.mdの限界節、T086で確認）。
 * - 計数のstateはrulesのオブジェクト（WeakMapの鍵。policyの次元ごと）に分く。index.tsは要求ごとにcreateAppを
 *   再構築するため、middlewareをclosureにすると計数が1要求で消える——そのためstateはモジュール側に
 *   置き、既定policyのstateはisolateの生存期間で共有する。
 */
export interface RateLimitRule {
  /** 窓内で許す要求数 */
  requests: number;
  /** 窓の長さ（ミリ秒） */
  windowMs: number;
}

export type RateLimitBucket = "auth" | "ai" | "search" | "upload" | "default";

export interface SecurityPolicy {
  /** IP境界の上限（routes前のmiddleware。未認証の要求も計上する） */
  rateLimit: Record<RateLimitBucket, RateLimitRule>;
  /**
   * user単位の上限（**認証解決後の第二計上点**。resolvePrincipalが有効な利用者で呼ぶ。
   * docs/07 §2 D18「IP＋user単位」のuser次元。省略ならIP境界だけ）。鍵はusers.id。
   * 認証経路（/api/auth/*）はここを通らない（ライブラリのD1計上〔IP＋経路〕が担当）。
   */
  userRateLimit?: Record<RateLimitBucket, RateLimitRule>;
}

/** 開発設定（未承認。docs/07の上限案を「開発設定」として置いたもの。実環境の値はT086の公開設定時の検証とD11の承認で確定）。 */
export const DEVELOPMENT_SECURITY_POLICY: SecurityPolicy = {
  rateLimit: {
    // 認証はライブラリのD1上限（sign-in/sign-up等 5回/分/IP）が実効上限。この層はそれより広い後段の防衛線
    auth: { requests: 300, windowMs: 60_000 },
    // 高価な系列（AI呼出し・検索・upload）。既定は「通常の操作・既存の試験・e2eが連続で踏まない」幅にする
    // （全試験群体が同一IPにまとまる開発環境でも効かない幅。絞り込むときはpolicyを差して観測する）
    ai: { requests: 1_000, windowMs: 60_000 },
    search: { requests: 1_000, windowMs: 60_000 },
    upload: { requests: 1_000, windowMs: 60_000 },
    // 業務APIの既定は実質上限なしの幅（既存試験・e2e・同期の再送を壊さない。全体上限はCloudflare層）
    default: { requests: 100_000, windowMs: 60_000 },
  },
  // user次元も同じ幅（同一IPを共有する利用者同士を締め付けない。user単位の鍵はusers.id）
  userRateLimit: {
    auth: { requests: 300, windowMs: 60_000 },
    ai: { requests: 1_000, windowMs: 60_000 },
    search: { requests: 1_000, windowMs: 60_000 },
    upload: { requests: 1_000, windowMs: 60_000 },
    default: { requests: 100_000, windowMs: 60_000 },
  },
};

/**
 * 公開デモ用のpolicy（T086。docs/07 §2・§8「デモ2,000 Maps/月」等の前提とdocs/14 D11の検証設定）。
 *
 * - 公開デモ（APP_ENV=demo）を寛容な開発設定（DEVELOPMENT_SECURITY_POLICY）で動かさないための値。
 *   **未承認の開発設定**である点は DEVELOPMENT_SECURITY_POLICY と同じ（実環境での確定は実Cloudflare接続後。
 *   docs/16 T086・docs/evidence/security.mdの限界節。WAF/Rate Limiting製品層との併用前提）。
 * - 認証経路（/api/auth/*）はライブラリのD1計上（sign-in等 5回/分/IP）が実効上限。この層は後段の防衛線。
 * - アプリ内の計数はisolate内メモリ（DEVELOPMENT_SECURITY_POLICYの注記と同じ）。厳密な全体上限は
 *   Cloudflare側の製品層で行う（未接続のため未実施＝局所完了。X-V01/X-DEMO）。
 * - 費用上限（月額$5・AI 500回/日等）はT080のbudget機構（config/budget-development.json）が担い、
 *   ここでは重複実装しない。Maps 2,000ロード/月はアプリ内で計測できない（unmeasured）ため
 *   Googleコンソール側の制限として運用手順（ops/demo-deploy.md）に記録する。
 */
export const DEMO_SECURITY_POLICY: SecurityPolicy = {
  rateLimit: {
    // 資格情報を受ける経路はライブラリ側が5回/分/IPで締める。ここはそれより広い後段（総当たりの遅延）
    auth: { requests: 60, windowMs: 60_000 },
    // 高価な系列（AI呼出し・検索・upload）。デモでは少数の試用で足りる幅に絞る
    ai: { requests: 30, windowMs: 60_000 },
    search: { requests: 60, windowMs: 60_000 },
    upload: { requests: 30, windowMs: 60_000 },
    // 通常API（閲覧・同期poll）。1IPあたり毎分1,200reqはデモ閲覧には十分な幅
    default: { requests: 1_200, windowMs: 60_000 },
  },
  // user次元（同一IPを共有する複数利用者を締め付けすぎない。demoの1userあたりの上限）
  userRateLimit: {
    auth: { requests: 60, windowMs: 60_000 },
    ai: { requests: 30, windowMs: 60_000 },
    search: { requests: 60, windowMs: 60_000 },
    upload: { requests: 30, windowMs: 60_000 },
    default: { requests: 600, windowMs: 60_000 },
  },
};

/** 環境名から既定のpolicyを選ぶ（index.tsがpolicy注入されないときに使う。demoだけ公開デモ用の値） */
export function securityPolicyForEnv(envName: "local" | "demo" | "staging" | "production"): SecurityPolicy {
  return envName === "demo" ? DEMO_SECURITY_POLICY : DEVELOPMENT_SECURITY_POLICY;
}

// --- バケットの分類（台帳から機械展開。APIの追加・移動に追従する） ---

/** AI呼出し系（docs/07 §2「AI」の上限。job受付API-89も実行時にAI評価を伴う系列として同じ区分） */
const AI_APIS = new Set<ApiId>(["API-29", "API-32", "API-77", "API-89"]);
/** 検索（docs/07 §2「検索」。API-76） */
const SEARCH_APIS = new Set<ApiId>(["API-76"]);
/** 添付のupload（docs/07 §2「アップロード」。API-83のstream転送） */
const UPLOAD_APIS = new Set<ApiId>(["API-83"]);

interface Matcher {
  method: string;
  regex: RegExp;
  bucket: RateLimitBucket;
}

const MATCHERS: Matcher[] = apiIds.flatMap((id): Matcher[] => {
  const def = apiDef(id);
  if (def.method === "ALL") return []; // API-36（/api/auth/*）は下のauthBucketForのstartsWithで分類する
  const bucket: RateLimitBucket = AI_APIS.has(id) ? "ai" : SEARCH_APIS.has(id) ? "search" : UPLOAD_APIS.has(id) ? "upload" : "default";
  return [{ method: def.method, regex: new RegExp(`^/api/v1${def.path.replaceAll(/:[A-Za-z]+/g, "[^/]+")}$`), bucket }];
});

export function rateLimitBucketFor(method: string, path: string): RateLimitBucket {
  if (path.startsWith("/api/auth/")) return "auth";
  for (const m of MATCHERS) {
    if (m.method === method && m.regex.test(path)) return m.bucket;
  }
  return "default";
}

// --- sliding windowの計数（isolate内メモリ。docs/07の「開発設定」） ---

interface LimiterState {
  hits: Map<string, number[]>;
}

const states = new WeakMap<object, LimiterState>();
/** 計数mapの上限（攻撃者が鍵を増やしてメモリを食うのを防ぐ。超えたら全消しで可用性を優先する） */
const MAX_KEYS = 20_000;

const stateOf = (scope: object): LimiterState => {
  let state = states.get(scope);
  if (!state) {
    state = { hits: new Map() };
    states.set(scope, state);
  }
  return state;
};

/** 窓内の到達判定。許すならnull、拒むならRetry-Afterの秒数を返す。stateはrulesのオブジェクト（次元・policyごと）に分く */
export function checkRateLimit(rules: Record<RateLimitBucket, RateLimitRule>, bucket: RateLimitBucket, clientKey: string, now: number): number | null {
  const rule = rules[bucket];
  const state = stateOf(rules);
  if (state.hits.size > MAX_KEYS) state.hits.clear();
  const key = `${bucket}:${clientKey}`;
  const stamps = (state.hits.get(key) ?? []).filter((t) => now - t < rule.windowMs);
  if (stamps.length >= rule.requests) {
    state.hits.set(key, stamps);
    // 0許可のrule（最初の要求で拒否）では窓の先頭が無いので、窓の長さをそのまま待ち時間にする
    if (stamps.length === 0) return Math.max(1, Math.ceil(rule.windowMs / 1000));
    return Math.max(1, Math.ceil((stamps[0]! + rule.windowMs - now) / 1000));
  }
  stamps.push(now);
  state.hits.set(key, stamps);
  return null;
}

const clientKeyOf = (c: ApiContext): string =>
  c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "-";

/** 429（RATE_LIMITED）を共通エラーenvelope＋計算済みRetry-Afterで返す（docs/05 §1の429行）。 */
export const rateLimitResponse = (c: ApiContext, bucket: RateLimitBucket, retryAfterSec: number): Response =>
  errorResponse(c, "RATE_LIMITED", [{ field: "rate", reason: `bucket_${bucket}` }], undefined, { "retry-after": String(retryAfterSec) });

const rateLimitMiddleware = (policy: SecurityPolicy): MiddlewareHandler<AppBindings> =>
  async (c, next) => {
    const bucket = rateLimitBucketFor(c.req.method, c.req.path);
    const retryAfter = checkRateLimit(policy.rateLimit, bucket, clientKeyOf(c), Date.now());
    if (retryAfter !== null) return rateLimitResponse(c, bucket, retryAfter);
    await next();
  };

/**
 * user単位の第二計上点（docs/07 §2 D18「IP＋user単位」のuser次元）。
 * resolvePrincipalが**有効な利用者が確定した直後**に呼ぶ（routesのmiddlewareはprincipalを知らないため、
 * 認証の正本であるprincipal解決の直後に計上する。同じバケット分類・窓の機構をuser次元で再計上）。
 * 429はHttpErrorとして伝わり、共通エラーenvelopeになる。
 */
export const enforceUserRateLimit = (c: ApiContext, userId: string): void => {
  const policy = c.get("securityPolicy");
  if (!policy?.userRateLimit) return; // user次元を持たないpolicyではIP境界だけ
  const bucket = rateLimitBucketFor(c.req.method, c.req.path);
  const retryAfter = checkRateLimit(policy.userRateLimit, bucket, userId, Date.now());
  if (retryAfter !== null) {
    // Retry-AfterはIP次元と同じ窓計算値（ph7-review A低2。docs/05 §1「Retry-After（秒）」。
    //   throwはresolvePrincipalの深部から出るため、窓の秒数をHttpErrorの追加headersへ載せて
    //   共通のonError→errorResponseで応答へ出す。載せない場合はerrorResponseの包括既定60秒になる）
    throw new HttpError("RATE_LIMITED", undefined, [{ field: "rate", reason: `user_${bucket}` }], { "retry-after": String(retryAfter) });
  }
};

/**
 * 共通セキュリティ処理（security headers＋rate limit）をappへ適用する。
 * index.tsは既定policyで呼び、試験は厳しい/緩和policyを差して挙動を観測する。
 * Origin/CSRF検査は既存機構（src/server/index.ts）のまま。ここでは重複実装しない（controller裁定4）。
 */
export function applySecurity(app: ApiApp, policy: SecurityPolicy): void {
  // policyをcontextへ載せる（user単位の第二計上点＝principal解決後が読む。middlewareはroutes前でしか動けないため）
  app.use("/api/*", async (c, next) => {
    c.set("securityPolicy", policy);
    await next();
  });
  // headersを先に（外側に）登録し、429・403など全てのAPI応答にheadersが付くようにする
  app.use("/api/*", securityHeaders());
  app.use("/api/*", rateLimitMiddleware(policy));
}
