import { z } from "zod";
import { Cursor, Id, IDEM, Instant, Job, LIMITS, P_ID, Sha256, ShortText, Version, VersionOrZero, defineApi, obj } from "./common";
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

/**
 * 配信イベント（docs/05 §8）。payloadはoutbox（domain_events.payload_minimal）の最小値で、
 * 個人情報の本文は入らない（docs/04:166）。重複/順序逆はsequenceとentityVersionでクライアントが検知する。
 */
export const SyncEvent = obj({
  /** domain_eventsの行ID（再送・重複の畳み込みキー） */
  id: Id,
  entityType: ShortText,
  entityId: Id,
  /** 変更後の対象版（重複/順序逆の検知に使う。docs/05 §8） */
  entityVersion: Version,
  eventType: ShortText,
  payload: z.record(z.string(), z.unknown()),
  /** unit内の単調連番。不可視イベントは露出せず番号が飛ぶ（通信欠落と誤認しない。docs/05 §8） */
  sequence: z.number().int().min(1),
  createdAt: Instant,
});
export type SyncEventDto = z.infer<typeof SyncEvent>;

/**
 * 差分取得（API-80）の応答。resumeCursorは常に返す（不可視イベントで読み位置だけ進んだときも
 * heartbeatの代わりにこれで伝える。docs/05 §8）。resyncRequiredは位置がunitの連番より先など、
 * このままでは追いつけないときにtrue（409ではなく200で再取得へ誘導する）。
 */
export const EventPage = obj({
  events: z.array(SyncEvent).max(LIMITS.listLimitMax),
  resumeCursor: Cursor,
  resyncRequired: z.boolean(),
});
export type EventPageDto = z.infer<typeof EventPage>;

export const syncApis = {
  // 差分取得（docs/05 §8）。応答はT072で暫定から厳格化（EventPage）。方式（SSE/poll/DO）はT073・D16で確定させる
  "API-80": defineApi({
    method: "GET", path: "/events", permission: "PER-13", kind: "stream", success: [200],
    request: obj({
      query: obj({
        entityType: ShortText.optional(), entityId: Id.optional(),
        // 初回（cursor無し）だけ使う。cursorがあるときは位置もfilterもcursorが正（docs/05 §8）
        afterSequence: z.coerce.number().int().min(0).optional(),
        cursor: Cursor.optional(),
      }),
    }),
    response: EventPage,
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
