import { z } from "zod";

// 共通スキーマ（docs/05 §1〜3）。上限値は「負荷検証で固定するB案」で、機能上限の無断削減を意味しない。
// 値を変えるときは docs/05 §1 と一緒に更新する。
export const LIMITS = {
  titleMax: 200,
  bodyMax: 20_000,
  queryMax: 4_000,
  jsonBytesMax: 256 * 1024,
  listLimitDefault: 50,
  listLimitMax: 200,
  arrayMax: 100,
  /** 集計（API-52）の応答配列。1団の年間活動/出動・団員数より十分大きい上限（docs/05 API-52行） */
  analyticsArrayMax: 2000,
  idempotencyKeyMax: 128,
} as const;

/** 未知のJSON列を拒否するobject。入力は必ずこれで定義する。 */
export const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

// --- 基本型 ---
/** サーバー生成のUUID（小文字）。大文字を受け付けると照会404や冪等hashの不一致を招くため拒否する */
export const Id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "小文字のUUIDで指定してください");
/**
 * UTC瞬間。小数秒の桁数はいくつでも受け付け、検証後はDBと同じ「ミリ秒3桁のZ形式」へ正規化する
 * （前後比較を文字列で行っても精度の違いで逆転しないように）。
 */
export const Instant = z.iso.datetime({ message: "UTC瞬間(ISO8601)で指定してください" }).transform((v) => new Date(v).toISOString());
export const BusinessDate = z.iso.date();
export const Version = z.number().int().min(1);
/** 未作成のPUT(upsert)は version 0 を指定する */
export const VersionOrZero = z.number().int().min(0);
export const Title = z.string().min(1).max(LIMITS.titleMax);
export const Body = z.string().min(1).max(LIMITS.bodyMax);
export const OptionalBody = z.string().max(LIMITS.bodyMax);
export const Reason = z.string().min(1).max(LIMITS.bodyMax);
export const Question = z.string().min(1).max(LIMITS.queryMax);
export const ShortText = z.string().min(1).max(200);
// --- DBのCHECKに揃えた上限（docs/04の各表DDLと一致。共通上限のまま通すとDBで500になる系列を入力で400にする） ---
/** 管理番号・出典・資産コードなど（DBのCHECK 1〜100） */
export const Code100 = z.string().min(1).max(100);
/** 資機材の数量単位など（DBのCHECK 1〜50） */
export const Code50 = z.string().min(1).max(50);
/** 確認・訂正・対応の理由（DBのCHECK 1〜2000。共通上限Reason(20,000)より狭い列） */
export const Reason2000 = z.string().min(1).max(2000);
/** 点検明細の備考など（DBのCHECK 1〜2000。未指定はNULL。空文字は不可） */
export const Note2000 = z.string().min(1).max(2000);
/** 施設の位置メモなど（DBのCHECK 1〜1000。NOT NULL。空文字は不可） */
export const Note1000 = z.string().min(1).max(1000);
export const Latitude = z.number().min(-90).max(90);
export const Longitude = z.number().min(-180).max(180);
export const NonNegative = z.number().min(0);
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const IdList = z.array(Id).min(1).max(LIMITS.arrayMax);
export const IdListMaybeEmpty = z.array(Id).max(LIMITS.arrayMax);

// --- ページング ---
export const Cursor = z.string().min(1).max(2048);
export const Limit = z.coerce.number().int().min(1).max(LIMITS.listLimitMax).default(LIMITS.listLimitDefault);
export const listQuery = <T extends z.ZodRawShape>(shape: T = {} as T) =>
  obj({ ...shape, limit: Limit, cursor: Cursor.optional() });

// --- エラー ---
export const errorCodes = [
  "VALIDATION_ERROR", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND",
  "VERSION_CONFLICT", "IDEMPOTENCY_MISMATCH", "DUPLICATE", "SNAPSHOT_CHANGED", "RESYNC_REQUIRED",
  "INVALID_TRANSITION", "UNAPPROVED_POLICY", "ATTACHMENT_NOT_READY",
  "RATE_LIMITED", "INTERNAL_ERROR", "DEPENDENCY_UNAVAILABLE",
] as const;
export type ErrorCode = (typeof errorCodes)[number];

/** コード→HTTP status。docs/05 §1 の表と一致させる。 */
export const errorStatus: Record<ErrorCode, 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503> = {
  VALIDATION_ERROR: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  VERSION_CONFLICT: 409, IDEMPOTENCY_MISMATCH: 409, DUPLICATE: 409, SNAPSHOT_CHANGED: 409, RESYNC_REQUIRED: 409,
  INVALID_TRANSITION: 422, UNAPPROVED_POLICY: 422, ATTACHMENT_NOT_READY: 422,
  RATE_LIMITED: 429, INTERNAL_ERROR: 500, DEPENDENCY_UNAVAILABLE: 503,
};

export const ErrorEnvelope = obj({
  error: obj({
    code: z.enum(errorCodes),
    message: z.string(),
    details: z.array(obj({ field: z.string(), reason: z.string() })),
  }),
  meta: obj({ requestId: z.string() }),
});

export const SuccessMeta = obj({
  requestId: z.string(),
  nextCursor: z.string().optional(),
  snapshotRevision: z.number().int().optional(),
});
export const successEnvelope = <T extends z.ZodType>(data: T) => obj({ data, meta: SuccessMeta });

// --- 共通DTO ---
export const Page = <T extends z.ZodType>(item: T) => z.array(item);

/**
 * 04/10 から未確定のDTO。id/versionだけを必須とし、他は通す(loose)。
 * registry の provisional=true と対応し、該当機能タスクで厳密化する。
 */
export const provisionalDto = () => z.looseObject({ id: Id, version: z.number().int().min(1) });

export const Job = obj({
  id: Id,
  status: z.enum(["queued", "running", "succeeded", "retry_wait", "manual_review", "cancelled", "stale"]),
  attempts: z.number().int().min(0),
  errorCode: z.string().nullable(),
  resultRef: z.string().nullable(),
});
export type Job = z.infer<typeof Job>;

export const Target = obj({ type: z.enum(["facility", "vehicle", "equipment"]), id: Id });
export const AssetTarget = obj({ type: z.enum(["vehicle", "equipment"]), id: Id });

// --- API定義 ---
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "ALL";
export type ApiKind = "get" | "list" | "mutation" | "job" | "binary" | "noContent" | "external" | "stream";

export interface ApiDef<Q extends z.ZodType = z.ZodType, S extends z.ZodType = z.ZodType> {
  method: HttpMethod;
  path: string;
  /** 10_権限マトリクス のPER、または認証/所有者などの文字列 */
  permission: string;
  kind: ApiKind;
  /** 成功時のHTTP status。202=永続job受付(業務完了ではない) */
  success: readonly (200 | 201 | 202 | 204)[];
  request: Q;
  /** envelopeの data 部。binary/204/externalは使わない */
  response: S;
  /** 応答DTOが04/10の確定待ち */
  provisional?: boolean;
}

/** 型を保ったままAPI定義を作る恒等関数。 */
export function defineApi<Q extends z.ZodType, S extends z.ZodType>(def: ApiDef<Q, S>): ApiDef<Q, S> {
  return def;
}

export const IdempotencyKey = z.string().min(1).max(LIMITS.idempotencyKeyMax);

/**
 * 変更系(POST/PUT/PATCH/DELETE JSON)の必須ヘッダー。API-36/83を除く全ての変更が持つ。
 * リクエストの形は {params,query,body,headers} で、各APIが obj({ ... , ...IDEM }) と直接書く
 * （型が各項目の必須/任意を保つため。ヘルパーで動的に組み立てない）。
 */
export const IDEM = { headers: z.looseObject({ "idempotency-key": IdempotencyKey }) } as const;
export const idParams = { id: Id };
export const P_ID = obj(idParams);
export const noContent = z.undefined();
