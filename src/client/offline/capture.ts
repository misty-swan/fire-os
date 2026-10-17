import type { MeData } from "../me";
import type { ApiId } from "../../shared/contracts/registry";
import { getDraftStore, IndexedDbDraftStore } from "./store";
import type { LocalDraft } from "./types";
import { payloadHashOf } from "./hash";
import { draftExpiryFrom } from "./lifecycle";

/**
 * 通信断入力の下書き化（T077、docs/07端末保持・docs/16 T077「SCR-27と点検/出欠/参集の各画面が
 * offlineから回復できる」）。
 *
 * 接続点はuseMutationの保存失敗（ネットワーク層の未知失敗＝status 0）だけ。元APIのフォームを
 * offline対応に作り直すのではなく、「書き込みの結果が分からなくなった操作」を同じ送信鍵
 * （Idempotency-Key＝clientOperationId）のまま端末に置き、SCR-27から後で同期できるようにする。
 * 同じ鍵なので、もし操作が実はサーバーに届いていた場合も再送は一回だけ成立する
 * （docs/05 §2「同じキー/本文の再送は元HTTP status/dataを返す」。tests/sync.test.tsの再送試験と同じ）。
 *
 * 対象はT076のallowlistのうち画面がある3つ（点検保存API-14・本人出欠API-08・参集API-23）。
 * 点検訂正（API-46）は訂正フォームが未実装（T033残作業）のため、フォーム経由の捕捉対象外
 * （seed等で作られた訂正の下書きは同期runnerが扱える）。
 */

/** 同期できる操作の表示名（SCR-27の一覧で使う。語彙はT076のallowlistと一致） */
export const OPERATION_LABELS: Record<string, string> = {
  "facility_inspection.create": "点検の保存",
  "inspection.correction": "点検の訂正",
  "attendance.respond": "本人出欠",
  "incident.participant.record": "参集の記録",
};

/** 下書きに載せる形（API-81のSyncCommandの元。出欠・参集は版をpayloadから抜いてbaseVersionへ） */
export interface CapturePlan {
  operationCode: string;
  targetId: string;
  baseVersion: number;
  payload: Record<string, unknown>;
}

/**
 * 保存に失敗したリクエストを、allowlistの操作に写像できるか。
 * 入力の形は各APIの契約（registry）そのもの。写像できない操作は下書きにしない（同期できないものを残さない）。
 *
 * meは認証済みの利用者（API-01）。参集（API-23）の**代理（params.memberId≠本人）は下書きにしない**:
 * 同期のallowlist（T076）はAPI-23を必ず同期主体自身の記録として再生するため、代理の参集を
 * 下書きに置くと再送時に別人の参集記録として黙って届いてしまう（allowlist.ts「代理（D08 scope）は同期しない」）。
 */
export function planFor(id: ApiId, input: unknown, me: Pick<MeData, "profile"> | null): CapturePlan | null {
  const i = input as { params?: Record<string, unknown>; body?: Record<string, unknown> } | null;
  if (!i?.params || typeof i.body !== "object" || i.body === null) return null;
  const params = i.params;
  const body = i.body as Record<string, unknown>;
  switch (id) {
    case "API-14": {
      // 点検の保存（payload=元bodyそのもの。targetId=施設。新規作成なのでbaseVersion=0）
      if (typeof params.id !== "string") return null;
      return { operationCode: "facility_inspection.create", targetId: params.id, baseVersion: 0, payload: plain(body) };
    }
    case "API-46": {
      // 点検の訂正（typeをpayloadに含み、supersedesIdはtargetIdで補う＝allowlistの約束。seriesVersionはpayloadに）
      if (typeof params.id !== "string" || typeof params.type !== "string") return null;
      const { supersedesId: _drop, ...rest } = body;
      return {
        operationCode: "inspection.correction",
        targetId: params.id,
        baseVersion: 0,
        payload: plain({ type: params.type, ...rest }),
      };
    }
    case "API-08": {
      // 本人出欠（版はbaseVersionで運ぶ。payloadにversionがあるとサーバーが400にする＝assertNoVersionInPayload）
      if (typeof params.id !== "string" || typeof body.version !== "number") return null;
      const { version: _v, ...rest } = body;
      return { operationCode: "attendance.respond", targetId: params.id, baseVersion: body.version, payload: plain(rest) };
    }
    case "API-23": {
      // 参集の本人記録（出欠と同じく版はbaseVersionへ）。代理は下書きにしない（上の注記どおり。
      // memberIdが入力に無い・本人と一致しない場合は再生時に主体が替わってしまうため写像しない）
      if (typeof params.memberId !== "string" || params.memberId !== me?.profile.memberId) return null;
      if (typeof params.id !== "string" || typeof body.version !== "number") return null;
      const { version: _v, ...rest } = body;
      return { operationCode: "incident.participant.record", targetId: params.id, baseVersion: body.version, payload: plain(rest) };
    }
    default:
      return null;
  }
}

/** payloadはJSONで保存する（IndexedDBのstructured cloneに載る plain な形に整える） */
function plain(body: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

/**
 * 失敗した書き込みを下書きとして端末に置く。返り値は作れたかどうか（呼び出し側の表示は変えない。
 * 下書きに置けない場合も、フォームの「結果を確認できません」の表示が正として残る）。
 *
 * scopeは必ず認証済みのme（API-01）から組み立てる（T075レビューからの持ち越し事項。呼び出し元の
 * 引数や入力値から分団・利用者を決めない）。meが取れない文脈（ログイン画面など）では作らない。
 */
export async function captureOfflineDraft(
  me: Pick<MeData, "profile" | "unitName"> | null,
  id: ApiId,
  input: unknown,
  /** 失敗したリクエストで使った送信鍵。同じ鍵で再送できるのが下書きの要点（docs/05 §2冪等） */
  idempotencyKey: string,
  store: IndexedDbDraftStore = getDraftStore(),
): Promise<boolean> {
  if (!me) return false;
  const plan = planFor(id, input, me);
  if (!plan || plan.targetId === "") return false;
  const now = new Date().toISOString();
  const draft: LocalDraft = {
    scope: { userId: me.profile.memberId, unitId: me.unitName, deviceId: IndexedDbDraftStore.deviceIdOf() },
    clientOperationId: idempotencyKey,
    operationCode: plan.operationCode,
    targetId: plan.targetId,
    baseVersion: plan.baseVersion,
    payload: plan.payload,
    payloadHash: await payloadHashOf(plan.payload),
    status: "local_draft",
    // 画面経由の点検は写真がすでにサーバーにあり（検査済みのattachmentIdsをpayloadに含む）、
    // 端末内blobは無い。端末内写真を参照する下書きは同期時にrunnerが転送する（sync-runner.ts）
    attachments: [],
    createdAt: now,
    expiresAt: draftExpiryFrom(now),
  };
  try {
    await store.put(draft);
    return true;
  } catch {
    // 容量不足・IndexedDB不可など。保存できないことはSCR-27には載らないが、フォームの失敗表示が正として残る
    return false;
  }
}
