import type { Context, Hono } from "hono";
import { LIMITS, errorStatus, type ErrorCode } from "../shared/contracts/common";
import { ContractError, apiDef, parseRequest, type ApiId, type ParsedRequest } from "../shared/contracts/registry";
import type { AppBindings } from "./env";

export type ApiApp = Hono<AppBindings>;
export type ApiContext = Context<AppBindings>;
/** 業務APIの共通接頭辞（API-36の認証だけは対象外） */
export const API_BASE = "/api/v1";

/** 業務エラー。codeからHTTP statusが決まる。messageは利用者に見せてよい文だけにする（内部本文を入れない）。 */
export class HttpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly details: { field: string; reason: string }[] = [],
  ) {
    super(message ?? code);
  }
}

const publicMessage: Record<ErrorCode, string> = {
  VALIDATION_ERROR: "入力内容に誤りがあります",
  UNAUTHENTICATED: "ログインが必要です",
  FORBIDDEN: "この操作は許可されていません",
  NOT_FOUND: "対象が見つかりません",
  VERSION_CONFLICT: "他の操作で更新されています。内容を再確認してください",
  IDEMPOTENCY_MISMATCH: "同じ送信キーで異なる内容が送られました",
  DUPLICATE: "既に登録されています",
  SNAPSHOT_CHANGED: "データが更新されました。再取得してください",
  RESYNC_REQUIRED: "再同期が必要です",
  INVALID_TRANSITION: "この状態からは変更できません",
  UNAPPROVED_POLICY: "運用設定が未承認のため実行できません",
  ATTACHMENT_NOT_READY: "添付の検査が完了していません",
  RATE_LIMITED: "しばらくしてから再度お試しください",
  INTERNAL_ERROR: "処理に失敗しました",
  DEPENDENCY_UNAVAILABLE: "外部サービスに接続できません",
};

type Ctx = Context<AppBindings>;

export function errorResponse(
  c: Ctx,
  code: ErrorCode,
  details: { field: string; reason: string }[] = [],
  message?: string,
): Response {
  const headers: Record<string, string> = {};
  if (code === "RATE_LIMITED") headers["retry-after"] = "60";
  return c.json(
    { error: { code, message: message ?? publicMessage[code], details }, meta: { requestId: c.get("requestId") } },
    errorStatus[code],
    headers,
  );
}

export function notFound(c: Ctx): Response {
  return errorResponse(c, "NOT_FOUND");
}

/** Honoのonerror。内部例外の本文は応答へ出さない（requestIdでログと突き合わせる）。 */
export function onError(err: Error, c: Ctx): Response {
  if (err instanceof HttpError) return errorResponse(c, err.code, err.details, err.message === err.code ? undefined : err.message);
  if (err instanceof ContractError) return errorResponse(c, "VALIDATION_ERROR", err.details);
  console.error(JSON.stringify({ requestId: c.get("requestId"), error: String(err) }));
  return errorResponse(c, "INTERNAL_ERROR");
}

export function ok<T>(c: Ctx, data: T, meta: { nextCursor?: string; snapshotRevision?: number } = {}, status: 200 | 201 | 202 = 200) {
  return c.json({ data, meta: { requestId: c.get("requestId"), ...meta } }, status);
}

/** JSON本文を読む。256KiB超・JSONでない・壊れたJSONは400 VALIDATION_ERROR。 */
export async function readJsonBody(c: Ctx): Promise<unknown> {
  const length = Number(c.req.header("content-length") ?? "0");
  if (length > LIMITS.jsonBytesMax) {
    throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "(body)", reason: "payload_too_large" }]);
  }
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > LIMITS.jsonBytesMax) {
    throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "(body)", reason: "payload_too_large" }]);
  }
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "(body)", reason: "invalid_json" }]);
  }
}

/**
 * HonoのリクエストをAPI契約で検証した入力へ変換する。
 * params/query/body/headers のうち、そのAPIの契約が持つものだけを読む（契約外の入力は無視でなく拒否）。
 */
export async function parseApiRequest<I extends ApiId>(c: Ctx, id: I): Promise<ParsedRequest<I>> {
  const shape = (apiDef(id).request as unknown as { shape?: Record<string, unknown> }).shape ?? {};
  const input: Record<string, unknown> = {};
  if ("params" in shape) input.params = c.req.param();
  if ("query" in shape) input.query = c.req.query();
  if ("body" in shape) input.body = await readJsonBody(c);
  if ("headers" in shape) input.headers = Object.fromEntries(c.req.raw.headers.entries());
  return parseRequest(id, input);
}

/** 台帳(registry)の method/path でルートを登録する。パスをコードに二重に書かず、契約と食い違わないようにする。 */
export function defineRoute<I extends ApiId>(app: ApiApp, id: I, handler: (c: ApiContext) => Response | Promise<Response>): void {
  const def = apiDef(id);
  app.on(def.method, `${API_BASE}${def.path}`, handler);
}
