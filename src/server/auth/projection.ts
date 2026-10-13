import { apiDef, type ApiId, type ApiResponse } from "../../shared/contracts/registry";
import type { AuthzPrincipal } from "./principal";

/**
 * 応答DTOを契約(strict)で検証して返す。契約に無い列が混ざっていれば例外（=500）にして、
 * Secret・許可されていない列・内部IDが応答へ漏れるのを実装の誤りとして検出する。
 * 許可列の取捨は各ドメイン（例: members の projectMember）が行い、最後にここを通す。
 */
export function project<I extends ApiId>(id: I, _p: AuthzPrincipal, data: unknown): ApiResponse<I> {
  return apiDef(id).response.parse(data) as ApiResponse<I>;
}
