import { errorStatus, type ErrorCode } from "../shared/contracts/common";
import {
  apiDef, safeParseRequest, type ApiId, type ApiRequest, type ApiResponse,
} from "../shared/contracts/registry";
import { randomUuid } from "./uuid";

/** クライアント側だけで生じるエラーコード（サーバーのErrorCodeとは別） */
export type ClientErrorCode = ErrorCode | "NETWORK_ERROR" | "RESPONSE_UNKNOWN" | "BAD_RESPONSE";

/**
 * API失敗の表現。statusは0=HTTP応答なし。
 * RESPONSE_UNKNOWN は「変更要求を送ったが応答が読めない」＝反映されたか不明。同じIdempotency-Keyで再送できる。
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ClientErrorCode,
    public readonly details: { field: string; reason: string }[] = [],
    public readonly requestId: string | null = null,
  ) {
    super(code);
  }
}

/** 呼び出し側が渡す入力。headers（Idempotency-Key）は api() が付けるので含めない。 */
export type ApiInput<I extends ApiId> = Omit<ApiRequest<I>, "headers">;

export interface ApiResult<I extends ApiId> {
  /** 202 は永続jobの受付であり業務の完了ではない */
  status: number;
  data: ApiResponse<I>;
  requestId: string | null;
  nextCursor?: string;
}

export interface ApiOptions {
  /** 変更系で指定すると再送時に同じ鍵を使える。省略時は毎回新しい鍵 */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** 認証が切れた(401)ことを画面全体へ知らせる。AppShellが購読して再ログインへ誘導する。 */
export const authEvents = new EventTarget();

/** 冪等キー（docs/05の送信キー。推測不能であることが前提。secure context外でも生成できる共有ヘルパー経由） */
export const newIdempotencyKey = (): string => randomUuid();

const API_BASE = "/api/v1";

function buildUrl(path: string, params: Record<string, unknown> | undefined, query: Record<string, unknown> | undefined) {
  let url = API_BASE + path.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(String(params?.[name] ?? "")));
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) search.set(k, String(v));
  const qs = search.toString();
  if (qs) url += `?${qs}`;
  return url;
}

/**
 * 契約(registry)に従ってAPIを呼ぶ。同origin・cookie認証。
 * 送信前に契約で入力を検証し、誤りはネットワークに出さず VALIDATION_ERROR にする。
 */
export async function apiCall<I extends ApiId>(
  id: I,
  input: ApiInput<I>,
  options: ApiOptions = {},
): Promise<ApiResult<I>> {
  const def = apiDef(id);
  const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(def.method);
  const parts = input as { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown };
  const full: Record<string, unknown> = { ...parts };
  const shape = (def.request as unknown as { shape?: Record<string, unknown> }).shape ?? {};
  if ("headers" in shape && isWrite) {
    full.headers = { "idempotency-key": options.idempotencyKey ?? newIdempotencyKey() };
  }
  const parsed = safeParseRequest(id, full);
  if (!parsed.success) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      parsed.error.issues.map((i) => ({ field: i.path.filter((p) => p !== "body" && p !== "query" && p !== "params").join("."), reason: i.message })),
    );
  }

  const headers: Record<string, string> = { accept: "application/json" };
  const idem = (full.headers as { "idempotency-key"?: string } | undefined)?.["idempotency-key"];
  if (idem) headers["idempotency-key"] = idem;
  const hasBody = parts.body !== undefined;
  if (hasBody) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(buildUrl(def.path, parts.params, parts.query), {
      method: def.method,
      credentials: "same-origin",
      headers,
      body: hasBody ? JSON.stringify(parts.body) : undefined,
      signal: options.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    // 送信前に失敗したのか応答だけ失われたのかは区別できない。変更系は「結果不明」として同じ鍵で再送させる
    throw new ApiError(0, isWrite ? "RESPONSE_UNKNOWN" : "NETWORK_ERROR");
  }

  if (response.status === 204) return { status: 204, data: undefined as ApiResponse<I>, requestId: null };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // 本文が読めない。変更系で成功/失敗が判断できなければ結果不明
    throw new ApiError(response.status, isWrite ? "RESPONSE_UNKNOWN" : "BAD_RESPONSE");
  }
  const envelope = body as {
    data?: unknown;
    meta?: { requestId?: string; nextCursor?: string };
    error?: { code?: string; details?: { field: string; reason: string }[] };
  };
  const requestId = envelope.meta?.requestId ?? null;

  if (!response.ok) {
    const code = (envelope.error?.code ?? codeFromStatus(response.status)) as ClientErrorCode;
    if (response.status === 401) authEvents.dispatchEvent(new Event("unauthenticated"));
    throw new ApiError(response.status, code, envelope.error?.details ?? [], requestId);
  }
  return { status: response.status, data: envelope.data as ApiResponse<I>, requestId, nextCursor: envelope.meta?.nextCursor };
}

function codeFromStatus(status: number): ErrorCode {
  const found = (Object.entries(errorStatus) as [ErrorCode, number][]).find(([, s]) => s === status);
  return found ? found[0] : "INTERNAL_ERROR";
}

/** データ部だけが欲しい呼び出し用。202かどうかを区別する必要がある保存操作は apiCall/useMutation を使う。 */
export async function api<I extends ApiId>(id: I, input: ApiInput<I>, options?: ApiOptions): Promise<ApiResponse<I>> {
  return (await apiCall(id, input, options)).data;
}
