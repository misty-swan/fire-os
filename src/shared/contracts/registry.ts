import type { z } from "zod";
import { aiApis } from "./ai";
import { assetsApis } from "./assets";
import { authApis } from "./auth";
import type { ApiDef } from "./common";
import { contentApis } from "./content";
import { gisApis } from "./gis";
import { operationsApis } from "./operations";
import { syncApis } from "./sync";

/** 102 APIの正本。各APIの入力・出力・権限・成功statusを持ち、OpenAPIと型はここから導出する。 */
export const registry = {
  ...authApis,
  ...gisApis,
  ...operationsApis,
  ...assetsApis,
  ...contentApis,
  ...aiApis,
  ...syncApis,
} as const;

export type Registry = typeof registry;
export type ApiId = keyof Registry;
/** API番号の昇順（文字列順だと API-100 が API-11 より前に来るため数値で並べる） */
export const apiIds = (Object.keys(registry) as ApiId[]).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));

/** クライアントが渡す入力（既定値は未適用）。{params,query,body,headers} */
export type ApiRequest<I extends ApiId> = z.input<Registry[I]["request"]>;
/** サーバーが検証後に得る入力（既定値適用済み）。 */
export type ParsedRequest<I extends ApiId> = z.output<Registry[I]["request"]>;
/** 成功時の data 部。HTTP status は共通http層が扱う。 */
export type ApiResponse<I extends ApiId> = z.output<Registry[I]["response"]>;

export function apiDef(id: ApiId): ApiDef {
  return registry[id] as unknown as ApiDef;
}

/** 検証エラー。details は {field, reason}。サーバーは400 VALIDATION_ERRORへ変換する。 */
export class ContractError extends Error {
  constructor(public readonly details: { field: string; reason: string }[]) {
    super("VALIDATION_ERROR");
  }
}

export function safeParseRequest<I extends ApiId>(id: I, value: unknown) {
  return registry[id].request.safeParse(value) as z.ZodSafeParseResult<ParsedRequest<I>>;
}

export function parseRequest<I extends ApiId>(id: I, value: unknown): ParsedRequest<I> {
  const result = safeParseRequest(id, value);
  if (!result.success) {
    throw new ContractError(
      result.error.issues.map((i) => ({ field: i.path.join(".") || "(root)", reason: i.message })),
    );
  }
  return result.data;
}
