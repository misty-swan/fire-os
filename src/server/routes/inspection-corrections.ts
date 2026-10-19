import { Inspection } from "../inspections/build";
import { buildInspectionMutation, type BuiltInspection } from "../inspections/build";
import { resolvePrincipal, type AuthzPrincipal } from "../auth/principal";
import type { AppEnv } from "../env";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp } from "../http";
import { executeMutation } from "../mutations/execute";
import type { ParsedRequest } from "../../shared/contracts/registry";
import { requirePermission } from "./invitations";

/**
 * 点検の訂正（T031、docs/05 API-46、docs/11 §3）。
 * 原本は変更せず、新しい原本＋seriesの現在版ポインタ切替を一つのmutationで行う。
 * 同じ原本から二つの訂正枝は作れない（supersedes_id UNIQUE＋series版ガード）。
 * T076: 組み立てはbuildInspectionCorrectionとして公開し、通信断同期（API-81）が同じ
 * 認可・series版ガードのまま再利用する（オフライン操作も再認可。docs/10 PER-13）。
 */

export interface CorrectionRequest {
  /** 訂正対象の種別と元の原本のID（API-46のparams。同期ではtargetIdに相当） */
  type: "facility" | "vehicle" | "equipment";
  originalId: string;
  /** 検証済みの本文（docs/05 API-46のbody。supersedesIdはoriginalIdと同じになる） */
  body: ParsedRequest<"API-46">["body"];
}

/**
 * 点検訂正のmutationを組み立てる（T031のrouteとT076の同期で共用）。元の原本の存在・series・対象・PER-04を
 * 検査してからbuildInspectionMutationへ載せる。実行は呼出し側がexecuteMutationで行う
 * （T076の同期は実行前に台帳書込をspecに追加するため、組み立てと実行を分けている）。
 */
export async function buildInspectionCorrection(
  env: AppEnv,
  p: AuthzPrincipal,
  req: CorrectionRequest,
  idempotencyKey: string,
): Promise<BuiltInspection> {
  const { type, originalId, body } = req;
  const table = type === "facility" ? "facility_inspections" : "asset_inspections";

  // 元の原本（訂正対象）の存在と所属。seriesの現在版がこの原本であることをbuildの中で確かめる
  const original = await env.DB.prepare(`SELECT id, series_id, unit_id, supersedes_id, inspector_member_id FROM ${table} WHERE id = ?`).bind(originalId)
    .first<{ id: string; series_id: string; unit_id: string; supersedes_id: string | null; inspector_member_id: string }>();
  if (!original || original.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");

  // 対象のID（seriesから引く。訂正は同対象・同seriesのみ）
  const series = await env.DB.prepare("SELECT * FROM inspection_series WHERE id = ? AND unit_id = ?").bind(original.series_id, p.unitId)
    .first<{ facility_id: string | null; vehicle_id: string | null; equipment_id: string | null }>();
  if (!series) throw new HttpError("NOT_FOUND");
  const targetId = type === "facility" ? series.facility_id : type === "vehicle" ? series.vehicle_id : series.equipment_id;
  if (!targetId) throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "type", reason: "target_mismatch" }]);

  // 訂正の権限は「元の原本の実施者」で判定する（T085レビューA-I3で発見したT031の欠陥: 旧実装はクライアントが送る
  // body.inspectorMemberIdで判定しており、一般団員が自分を実施者に書いて他人の点検を訂正・実施者を差し替えできた）。
  // 加えて新しい原本の実施者（body）にも同じ権限を要求し、本人分しか持たない主体が実施者を他人へ移せないようにする
  requirePermission(p, "PER-04", { unitId: p.unitId, type, id: targetId, ownerMemberId: original.inspector_member_id });
  requirePermission(p, "PER-04", { unitId: p.unitId, type, id: targetId, ownerMemberId: body.inspectorMemberId });

  return buildInspectionMutation(env, p, {
    target: { type, id: targetId },
    input: body,
    operationCode: "inspection.correction",
    idempotencyKey,
    requestHashPath: `/inspections/${type}/${originalId}/corrections`,
    correction: { supersedesId: originalId, reason: body.reason, seriesVersion: body.seriesVersion, originalInspectorMemberId: original.inspector_member_id },
  });
}

export function registerInspectionCorrectionRoutes(app: ApiApp): void {
  defineRoute(app, "API-46", async (c) => {
    const p = await resolvePrincipal(c);
    const { params, body, headers } = await parseApiRequest(c, "API-46");
    const built = await buildInspectionCorrection(c.env, p, { type: params.type, originalId: params.id, body }, headers["idempotency-key"]);
    const result = await executeMutation(c.env, p, built.spec);
    return ok(c, Inspection.parse(result.data), {}, 201);
  });
}
