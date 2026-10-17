import { createExecutionContext } from "cloudflare:test";
import { createApp } from "../../src/server/index";
import type { AppEnv } from "../../src/server/env";
import type { SecurityPolicy } from "../../src/server/security/limits";
import type { LoadBucket, RequestSample } from "../../scripts/seed-load";

/**
 * 負荷試験の共通部品（T082。計画Files外のhelper。tests/loadの2試験で共有する）。
 *
 * 負荷試験は実workerd＋実D1（cloudflare vitest plugin）上で、実HTTPと同じ形の要求を
 * createApp(env, LOAD_SECURITY_POLICY) へ投げて測定する（fixtures作法のclientと同じ発想）。
 */

/**
 * 負荷試験用の緩和SecurityPolicy（コントローラ裁定5）。
 *
 * 実環境ではWAF/Rate Limiting製品層＋ここで差すpolicyの値が効く（docs/07 §2。アプリ内の計数は
 * isolate内メモリでしかない）。負荷試験では30端末×0.5req/sのpoll＋要求mixがすべて同一IP・同一利用者の
 * 鍵にまとまるため、既定（開発設定 default 100,000req/分）でも余裕はあるが、**429で測定を汚さないこと**を
 * 明示の目的として実質無効の幅を差す（黙った免除ではなく、試験コードに記録した免除）。
 * レート制限そのものの挙動（429・bucket区分）はtests/security/abuse.test.tsが厳しいpolicyで観測する。
 */
export const LOAD_SECURITY_POLICY: SecurityPolicy = {
  rateLimit: {
    auth: { requests: 10_000_000, windowMs: 60_000 },
    ai: { requests: 10_000_000, windowMs: 60_000 },
    search: { requests: 10_000_000, windowMs: 60_000 },
    upload: { requests: 10_000_000, windowMs: 60_000 },
    default: { requests: 10_000_000, windowMs: 60_000 },
  },
  userRateLimit: {
    auth: { requests: 10_000_000, windowMs: 60_000 },
    ai: { requests: 10_000_000, windowMs: 60_000 },
    search: { requests: 10_000_000, windowMs: 60_000 },
    upload: { requests: 10_000_000, windowMs: 60_000 },
    default: { requests: 10_000_000, windowMs: 60_000 },
  },
};

/** 負荷試験で話す利用者（scripts/seed-load.tsの固定ID。x-test-identityはuserIdだけを使い、状態は必ずDBから引かれる） */
export interface LoadIdentity {
  userId: string;
  memberId: string;
  unitId: string;
}

const BASE = "http://example.com";

/** createAppに緩和policyを差した負荷試験用のapp（1テストで1回作り、要求ごとにenvを渡す） */
export type LoadApp = ReturnType<typeof createApp>;
export function makeLoadApp(): LoadApp {
  return createApp({ APP_ENV: "local" }, LOAD_SECURITY_POLICY);
}

/** 負荷試験のクライアント。fixtureのclientと同じ形（実HTTPと同じRequestをapp.fetchへ渡す） */
export class LoadClient {
  constructor(
    private readonly app: LoadApp,
    private readonly env: AppEnv,
    readonly identity: LoadIdentity,
  ) {}

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      "x-test-identity": JSON.stringify(this.identity),
      ...headers,
    };
    return await this.app.fetch(
      new Request(`${BASE}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }),
      this.env,
      createExecutionContext(),
    );
  }

  /** バイナリ（API-83）など専用ヘッダー/本文の要求（fixtureのrawと同じ） */
  async raw(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set("x-test-identity", JSON.stringify(this.identity));
    return await this.app.fetch(
      new Request(request.url, { method: request.method, headers, body: request.body, duplex: "half" } as RequestInit),
      this.env,
      createExecutionContext(),
    );
  }
}

/** 測定sampleを記録しながら要求を実行する（失敗も必ずsampleに残す。成功だけの性能判定をしない） */
export class LoadSampler {
  readonly samples: RequestSample[] = [];

  constructor(
    private readonly env: AppEnv,
    /** クエリ計画監査の結果（apiごとの境界外走査の数。sampleへ記録してsummarizeLoadが合計する） */
    private readonly unboundedByApi: ReadonlyMap<string, number> = new Map(),
  ) {}

  async run(api: string, bucket: LoadBucket, send: () => Promise<Response>): Promise<Response> {
    const t0 = Date.now();
    let res: Response;
    try {
      res = await send();
    } catch (err) {
      // 例外（接続断など）も「失敗のsample」として記録してから投げ直す（失敗を外さない）
      this.samples.push({ api, bucket, ok: false, status: 0, durationMs: Date.now() - t0, unboundedQueries: this.unboundedByApi.get(api) ?? 0 });
      throw err;
    }
    this.samples.push({ api, bucket, ok: res.ok, status: res.status, durationMs: Date.now() - t0, unboundedQueries: this.unboundedByApi.get(api) ?? 0 });
    return res;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** poll周期の揺らめき（±jitterRatio。斉奏を崩して実端末のばらつきに寄せる。V06と同じ） */
export const jitterMs = (base: number, ratio = 0.2) => base * (1 - ratio + Math.random() * 2 * ratio);

/** 最小のPNGシグネチャ付きダミー（upload.test.tsと同じ。内容の検査はT016で済み） */
export const pngBytes = (fill: number, size = 100): Uint8Array => {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.fill(fill, 8);
  return b;
};

export const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join("");

export const idem = (): Record<string, string> => ({ "idempotency-key": crypto.randomUUID() });

export interface EventPage {
  events: { id: string; entityType: string; entityId: string; entityVersion: number; eventType: string; sequence: number }[];
  resumeCursor: string;
  resyncRequired: boolean;
}

export const toJson = async <T>(r: Response): Promise<T> => (await r.json()) as T;
