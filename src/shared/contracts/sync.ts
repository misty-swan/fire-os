import { z } from "zod";
import { Id, IDEM, Job, P_ID, Sha256, ShortText, VersionOrZero, defineApi, obj } from "./common";
import { syncOperationStates } from "../states";

export const SyncCommand = obj({
  clientOperationId: ShortText,
  deviceId: ShortText,
  operationCode: ShortText,
  targetId: Id,
  baseVersion: VersionOrZero,
  payload: z.record(z.string(), z.unknown()),
  payloadHash: Sha256,
});
export const SyncOperation = z.looseObject({ id: Id, status: z.enum(syncOperationStates) });

export const syncApis = {
  // 認可イベントのstreamまたは同等のpoll DTO。方式はD16で未決のため応答は暫定。
  "API-80": defineApi({
    method: "GET", path: "/events", permission: "PER-13", kind: "stream", success: [200],
    request: obj({
      query: obj({
        entityType: ShortText.optional(), entityId: Id.optional(), afterSequence: z.coerce.number().int().min(0),
      }),
    }),
    response: z.looseObject({}), provisional: true,
  }),
  "API-81": defineApi({
    method: "POST", path: "/sync/commands", permission: "PER-13＋元操作", kind: "mutation", success: [200, 202],
    request: obj({ body: SyncCommand, ...IDEM }),
    response: SyncOperation,
  }),
  "API-82": defineApi({
    method: "GET", path: "/sync/operations/:id", permission: "PER-13本人", kind: "get", success: [200],
    request: obj({ params: P_ID }), response: SyncOperation,
  }),
  // 永続ジョブの状態照会。依頼者のみ（PH0）。内部入力・内部error本文・Secretは返さない。
  "API-86": defineApi({
    method: "GET", path: "/jobs/:id", permission: "依頼者", kind: "get", success: [200],
    request: obj({ params: P_ID }), response: Job,
  }),
} as const;
