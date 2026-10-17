import type { MiddlewareHandler } from "hono";
import { apiDef, apiIds, type ApiId } from "../../shared/contracts/registry";
import type { AppBindings } from "../env";
import { errorResponse, type ApiApp, type ApiContext } from "../http";
import { securityHeaders } from "./headers";

/**
 * 共通セキュリティ処理の注入点（T081、docs/07 §2、docs/05 §1の429行）。
 *
 * - `SecurityPolicy` は試験とT082の負荷試験が差し替えられる注入型。既定（DEVELOPMENT_SECURITY_POLICY）
 *   は**寛容な開発設定**で、既存の試験・e2e・通常運用を止めない（controller裁定2）。厳しい上限の挙動
 *   （429・auth/AI/search/upload別の区分）はpolicyを注入する試験（tests/security/）が観測する。
 * - 上限の計上鍵はdocs/07 §2（D18）の「IP＋user単位」のうち、middleware段階で取得できるIP
 *   （cf-connecting-ip。proxy無しのlocalでは"-"にまとまる）。user単位の狭い上限は認証ライブラリが
 *   D1に数える（src/server/auth/config.tsのrateLimit。sign-in/sign-up 5回/分）。
 * - アプリ内の計数は**isolate内のメモリ**（Workerの1実行体）でしかない。厳密な全体上限はCloudflare側の
 *   WAF/Rate Limiting製品層で行う前提（docs/evidence/security.mdの限界節、T087で確認）。
 * - 計数のstateはpolicyオブジェクト（WeakMapの鍵）ごとに分く。index.tsは要求ごとにcreateAppを
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
  rateLimit: Record<RateLimitBucket, RateLimitRule>;
}

/** 開発設定（未承認。docs/07の上限案を「開発設定」として置いたもの。実環境の値はT087の負荷検証とD11の承認で確定）。 */
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
};

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

const states = new WeakMap<SecurityPolicy, LimiterState>();
/** 計数mapの上限（攻撃者が鍵を増やしてメモリを食うのを防ぐ。超えたら全消しで可用性を優先する） */
const MAX_KEYS = 20_000;

const stateOf = (policy: SecurityPolicy): LimiterState => {
  let state = states.get(policy);
  if (!state) {
    state = { hits: new Map() };
    states.set(policy, state);
  }
  return state;
};

/** 窓内の到達判定。許すならnull、拒むならRetry-Afterの秒数を返す */
export function checkRateLimit(policy: SecurityPolicy, bucket: RateLimitBucket, clientKey: string, now: number): number | null {
  const rule = policy.rateLimit[bucket];
  const state = stateOf(policy);
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
    const retryAfter = checkRateLimit(policy, bucket, clientKeyOf(c), Date.now());
    if (retryAfter !== null) return rateLimitResponse(c, bucket, retryAfter);
    await next();
  };

/**
 * 共通セキュリティ処理（security headers＋rate limit）をappへ適用する。
 * index.tsは既定policyで呼び、試験は厳しい/緩和policyを差して挙動を観測する。
 * Origin/CSRF検査は既存機構（src/server/index.ts）のまま。ここでは重複実装しない（controller裁定4）。
 */
export function applySecurity(app: ApiApp, policy: SecurityPolicy): void {
  // headersを先に（外側に）登録し、429・403など全てのAPI応答にheadersが付くようにする
  app.use("/api/*", securityHeaders());
  app.use("/api/*", rateLimitMiddleware(policy));
}
