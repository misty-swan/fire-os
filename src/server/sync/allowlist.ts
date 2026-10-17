import { ContractError, safeParseRequest, type ParsedRequest } from "../../shared/contracts/registry";
import type { AuthzPrincipal } from "../auth/principal";
import type { ApiContext } from "../http";
import { HttpError } from "../http";
import type { MutationSpec } from "../mutations/execute";
import { buildInspectionMutation } from "../inspections/build";
import { buildRespondAttendance } from "../routes/attendance";
import { buildRecordParticipation } from "../routes/incident-participants";
import { buildInspectionCorrection } from "../routes/inspection-corrections";
import { requirePermission } from "../routes/invitations";

/**
 * 同期（API-81）で送れる元操作の許可リスト（docs/16 T076「allowlistは点検保存/訂正・本人出欠・参集」）。
 *
 * 設計の要は「元handlerの認可/MutationSpecを再利用する」ことで、ここに業務検証を複製しない:
 *  - 本文は元APIの契約（registryのrequest schema）でそのまま検証する。未知列・列挙外・型は
 *    元APIと同じ400になり、同期専用の検査漏れを作らない（docs/07「同じ元業務APIを呼ぶ」）。
 *  - 認可・対象検査・状態前提は元routeと同じ関数（buildRespondAttendance / buildRecordParticipation /
 *    buildInspectionMutation / buildInspectionCorrection）が、**同期時点の** principalで走る。
 *    （docs/10 PER-13「オフライン操作も再認可」。applySyncCommandの呼出し時点の権限で判定し直す。）
 *  - payloadの約束: 点検作成・訂正はpayloadが元APIのbodyそのもの（訂正はtypeを含み、supersedesIdはtargetIdで
 *    補う）。出欠・参集はpayloadからversionを抜いた形にし、版はSyncCommand.baseVersionで運ぶ
 *    （docs/07端末保持「clientOperationId/baseVersion」のとおり。payloadにversionがあれば400）。
 *  - payloadHashは端末側の下書き保持の整合用（docs/07）で、サーバーは再計算しない。本文の正本は
 *    payloadそのもの＋元APIの契約検査であり、正規化hashはサーバーがcanonicalRequestHashで付ける。
 */

/** API-81のbody（docs/05 SyncCommand）。registryの検証を通った後の形。 */
export interface SyncCommandData {
  clientOperationId: string;
  deviceId: string;
  operationCode: string;
  targetId: string;
  baseVersion: number;
  payload: Record<string, unknown>;
}

export interface AllowlistEntry {
  /** 元APIのID。本文の検証とrequestHashの正本（docs/05 API-81行「許可元API/同requestHash/baseVersion」） */
  readonly apiId: "API-08" | "API-14" | "API-23" | "API-46";
  /**
   * 元handlerと同じ経路でMutationSpecを組み立てる。認可・版・状態の検査はここで改めて走り
   * （失敗はHttpErrorで400/403/404/409/422）、実行はapplySyncCommandがexecuteMutationで行う。
   */
  readonly build: (c: ApiContext, p: AuthzPrincipal, cmd: SyncCommandData, key: string) => Promise<MutationSpec<unknown>>;
}

/** 元APIの契約で検証する（parseApiRequestと同じ失敗の形。同期にはHonoの要求解析が無いためここで呼ぶ）。 */
function parseWith<I extends Parameters<typeof safeParseRequest>[0]>(id: I, input: unknown): ParsedRequest<I> {
  const result = safeParseRequest(id, input);
  if (!result.success) {
    throw new ContractError(result.error.issues.map((i) => ({ field: i.path.join(".") || "(root)", reason: i.message })));
  }
  return result.data as ParsedRequest<I>;
}

/** 作成系（API-14/46）のbaseVersionは0だけ。版を持つ対象の更新ではないため（docs/07「新規作成は0」）。 */
function assertNoBaseVersion(cmd: SyncCommandData): void {
  if (cmd.baseVersion !== 0) {
    throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "baseVersion", reason: "creation_must_be_zero" }]);
  }
}

/** 版はbaseVersionで運ぶ。payloadにversionを持たせない（鍵と版の単一化。T077の下書きもこの形）。 */
function assertNoVersionInPayload(cmd: SyncCommandData): void {
  if ("version" in cmd.payload) {
    throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "payload.version", reason: "version_is_carried_by_base_version" }]);
  }
}

/** 本人限定の同期（代理API-41はallowlistに入れない。docs/16 T076「本人出欠・参集」）。 */
function selfCommandBody(cmd: SyncCommandData): Record<string, unknown> {
  assertNoVersionInPayload(cmd);
  return { ...cmd.payload, version: cmd.baseVersion };
}

export const ALLOWLIST: Readonly<Record<string, AllowlistEntry>> = {
  // --- 点検の保存（API-14。payload=InspectionInputそのもの。targetId=施設） ---
  "facility_inspection.create": {
    apiId: "API-14",
    build: async (c, p, cmd, key) => {
      assertNoBaseVersion(cmd);
      const parsed = parseWith("API-14", {
        params: { id: cmd.targetId },
        body: cmd.payload,
        headers: { "idempotency-key": key },
      });
      // 元route（T029）と同じ認可。実施者の指定はPER-04（幹部・管理者は分団内、担当者は担当対象、一般団員は自分）
      requirePermission(p, "PER-04", { unitId: p.unitId, type: "facility", id: cmd.targetId, ownerMemberId: parsed.body.inspectorMemberId });
      const built = await buildInspectionMutation(c.env, p, {
        target: { type: "facility", id: cmd.targetId },
        input: parsed.body,
        operationCode: "facility_inspection.create",
        idempotencyKey: key,
        requestHashPath: `/facilities/${cmd.targetId}/inspections`,
      });
      return built.spec;
    },
  },
  // --- 点検の訂正（API-46。payload=type＋元body。targetId=訂正元の原本。series版ガードは元のまま） ---
  "inspection.correction": {
    apiId: "API-46",
    build: async (c, p, cmd, key) => {
      assertNoBaseVersion(cmd);
      const { type, ...rest } = cmd.payload;
      const parsed = parseWith("API-46", {
        params: { type, id: cmd.targetId },
        body: { ...rest, supersedesId: cmd.targetId },
        headers: { "idempotency-key": key },
      });
      const built = await buildInspectionCorrection(c.env, p, { type: parsed.params.type, originalId: cmd.targetId, body: parsed.body }, key);
      return built.spec;
    },
  },
  // --- 本人の出欠（API-08。targetId=活動。代理のAPI-41は同期しない） ---
  "attendance.respond": {
    apiId: "API-08",
    build: async (c, p, cmd, key) => {
      const parsed = parseWith("API-08", {
        params: { id: cmd.targetId },
        body: selfCommandBody(cmd),
        headers: { "idempotency-key": key },
      });
      const built = await buildRespondAttendance(c.env, p, cmd.targetId, p.memberId, parsed.body, key, `/activities/${cmd.targetId}/attendance/me`);
      return built.spec;
    },
  },
  // --- 参集の本人記録（API-23。targetId=出動。代理（D08 scope）は同期しない） ---
  "incident.participant.record": {
    apiId: "API-23",
    build: async (c, p, cmd, key) => {
      const parsed = parseWith("API-23", {
        params: { id: cmd.targetId, memberId: p.memberId },
        body: selfCommandBody(cmd),
        headers: { "idempotency-key": key },
      });
      const built = await buildRecordParticipation(
        c.env, p, cmd.targetId, p.memberId, parsed.body, key,
        `/incidents/${cmd.targetId}/participants/${p.memberId}`,
      );
      return built.spec;
    },
  },
};
