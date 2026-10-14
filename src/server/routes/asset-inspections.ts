import { buildInspectionMutation } from "../inspections/build";
import { Inspection } from "../inspections/build";
import { resolvePrincipal } from "../auth/principal";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { executeMutation } from "../mutations/execute";
import { canonicalRequestHash } from "../mutations/hash";
import { requirePermission } from "./invitations";

/**
 * 車両・資機材の点検（T030、docs/05 API-20）。対象はちょうど一つ（vehicle/equipment）。
 * 様式の対象種別の一致はbuild側で検査する（施設用の様式は使えない）。
 */
export function registerAssetInspectionRoutes(app: ApiApp): void {
  defineRoute(app, "API-20", async (c) => {
    const p = await resolvePrincipal(c);
    const { body, headers } = await parseApiRequest(c, "API-20");
    requirePermission(p, "PER-04", { unitId: p.unitId, type: body.target.type, id: body.target.id, ownerMemberId: body.inspectorMemberId });
    const built = await buildInspectionMutation(c.env, p, {
      target: { type: body.target.type, id: body.target.id },
      input: body,
      operationCode: "asset_inspection.create",
      idempotencyKey: headers["idempotency-key"],
      requestHashPath: "/asset-inspections",
    });
    const result = await executeMutation(c.env, p, built.spec);
    return ok(c, Inspection.parse(result.data), {}, 201);
  });
}

void HttpError;
void canonicalRequestHash;
