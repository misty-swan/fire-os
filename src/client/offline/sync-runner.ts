import { ApiError, api, apiCall } from "../api";
import { attachmentTargetTypes } from "../../shared/contracts/assets";

/** 写真の転送先の対象種別（contractsのattachmentTargetTypesと同じ語彙） */
type AttachmentTargetType = (typeof attachmentTargetTypes)[number];
import { expireDueDrafts } from "./lifecycle";
import { getDraftStore } from "./store";
import type { DraftScope, DraftStore, LocalDraft } from "./types";
import { payloadHashOf } from "./hash";

/**
 * 端末下書きの同期runner（T077、docs/05 §2・API-81/82、docs/07端末保持、docs/10 PER-13「オフライン操作も再認可」）。
 *
 * 順序制御（docs/16 T077「再認証→期限/現権限→写真upload/検査ready→元操作同期→結果照会」）:
 *  1. 再認証: 401が返ったら以降の下書きを触らずに停止する（AppShellの再ログイン導線に任せる。
 *     権限はサーバーが毎要求D1から引き直すため、この画面側では判定しない）。
 *  2. 期限/現権限: 送信候補は毎パスの最初に expireDueDrafts() で掃除してから列挙する
 *     （list自体は期限切れを消さない＝T075の約束。認可の再検査はAPI-81側で行われる）。
 *  3. 写真先行: 写真を参照する点検の下書きは、端末内の写真を予約→転送→検査（API-26/83/84→job API-86）まで
 *     済めて「ready」になってから親操作を送る。ready前・検査中に親を送らない（parentSentBeforeReady=false）。
 *     検査で拒否された写真は親ごと「拒否」にして、壊れた入力を送らない。
 *  4. 元操作同期: API-81は clientOperationId を Idempotency-Key と同値で1回だけ適用する（docs/05 §2）。
 *     応答が消失した場合は同じ鍵での再送が「照会」を兼ねる（適用済みの鍵は保存済みの結果を返す。
 *     sync_operationsの台帳解決＝tests/sync.test.tsと同じ意味論。新しい鍵は絶対に作らない）。
 *  5. 結果照会: サーバーの同期操作ID（memo.syncOperationId）が判っている場合は、送り直す前にAPI-82で
 *     照会する（404＝操作が無いことが証明されたときだけ送り直す）。
 *
 * 競合の扱い（docs/03 SCR-27「旧版を自動上書きしない」）: 409 VERSION_CONFLICT は下書きを「競合」で止める。
 * 勝手に版を読み直して送り直したり（last-write-wins）、自動で上書きしたりしない。解消は人がConflictPanelで
 * サーバー現値と比較したあと、**新しいclientOperationId**で送り直す（ConflictPanel.tsx）。
 * 競合・拒否の下書きはこのrunnerの送信候補から外れる（手動の解消・削除だけが動かす）。
 */

/** 同期1件の結果（SyncSummary.itemsの要素） */
export interface SyncItemResult {
  clientOperationId: string;
  operationCode: string;
  /** applied=サーバーが適用を確認。conflict/rejected=人が動かすまで止める。skipped=今回は送れなかった（写真待ち・再認証・中止）。
   *  unknown=応答が消失していて適用の成否がまだ分からない（同じ鍵での照会・再送に回る。docs/05 §2冪等） */
  outcome: "applied" | "conflict" | "rejected" | "skipped" | "unknown";
  /** 保留理由（skipped/unknown）やサーバーの拒否理由の要約（conflict/rejected）。SCR-27の表示にそのまま使う */
  reason?: string;
}

/** 1パスのまとめ。appliedだけが「反映」で、それ以外は保存完了とは表示しない（docs/03 §1） */
export interface SyncSummary {
  startedAt: string;
  finishedAt: string;
  total: number;
  applied: number;
  conflict: number;
  rejected: number;
  skipped: number;
  items: SyncItemResult[];
}

/** SyncPageが同期の開始・終了を知るための通知（runnerは画面に依存しない） */
export const syncEvents = new EventTarget();

/** 自動同期の再試行間隔。契約は「再接続から60秒以内に同期が始まる」で、online/visibility/起動で即時、
 *  逃したときもこの周期で走る（docs/16 T077のsyncStartsWithinSeconds≤60） */
export const AUTO_SYNC_INTERVAL_MS = 30_000;

/** 検査job（API-86）の Poll 設定。AttachmentUploaderと同じ1.5秒間隔（上限30秒） */
const JOB_POLL_INTERVAL_MS = 1500;
const JOB_POLL_MAX = 20;

/** 401＝再認証が必要。パスを中断し、残りを未実施にする（下書きは触らない） */
class ReauthNeeded extends Error {}

/** 写真を参照できる操作と、転送先の対象種別（点検の訂正はpayload.typeを从う） */
const PHOTO_TARGET_TYPES: Record<string, AttachmentTargetType | "from_payload"> = {
  "facility_inspection.create": "facility",
  "inspection.correction": "from_payload",
};

/** 下書きの状態の表示（SCR-27のチップ。応答不明はsendingの一種） */
export function draftStatusLabel(draft: LocalDraft): string {
  if (draft.status === "conflict") return "競合";
  if (draft.status === "rejected") return "拒否";
  if (draft.status === "sending" && draft.memo?.responseUnknown) return "応答不明";
  if (draft.status === "sending") return "送信中";
  return "未同期";
}

/** 下書き1行の内容の要約（SCR-27の一覧行。payloadの代表値だけを短く出す） */
export function draftSummaryLine(draft: LocalDraft): string {
  const p = draft.payload;
  if (typeof p.response === "string") {
    const labels: Record<string, string> = { attending: "参加", undecided: "未定", absent: "不参加", unanswered: "回答を取り下げ" };
    return `回答: ${labels[p.response] ?? String(p.response)}`;
  }
  if (typeof p.attendanceStatus === "string") {
    const labels: Record<string, string> = { mobilizing: "参集中", arrived: "参集済", returned: "帰還", unavailable: "出動不可" };
    return `状態: ${labels[p.attendanceStatus] ?? String(p.attendanceStatus)}`;
  }
  if (typeof p.result === "string") {
    const labels: Record<string, string> = { ok: "良好", needs_review: "異常あり", unknown: "未確認" };
    const note = typeof p.note === "string" && p.note ? `／${p.note.slice(0, 30)}` : "";
    return `結果: ${labels[p.result] ?? String(p.result)}${note}`;
  }
  return `対象: ${draft.targetId || "（新規）"}`;
}

/**
 * 保留操作を1パスで同期する（Interfaces verbatim: syncPending(input:{scope;signal}):Promise<SyncSummary>）。
 * 手動（SCR-27の「今すぐ同期」）と自動（startAutoSync）の共通の本体。単一実行はrunSyncPassが保証する。
 */
export async function syncPending(
  input: { scope: DraftScope; signal: AbortSignal },
  store: DraftStore = getDraftStore(),
): Promise<SyncSummary> {
  const startedAt = new Date().toISOString();
  const items: SyncItemResult[] = [];
  // 期限切れは送信候補にしない（docs/16: 期限後は人が新操作を作る。listは内部で消さないためここで掃除する）
  await expireDueDrafts(new Date().toISOString(), store);
  const rows = await store.list(input.scope);
  // 古いものから送る（作成順。一覧の表示はlistの新しい順のまま）
  const queue = [...rows].reverse();
  for (let i = 0; i < queue.length; i++) {
    const draft = queue[i]!;
    if (input.signal.aborted) {
      items.push({ clientOperationId: draft.clientOperationId, operationCode: draft.operationCode, outcome: "skipped", reason: "中止しました" });
      continue;
    }
    // 競合・拒否は人が解消するまで送らない（自動上書きも自動再送もしない。docs/03 SCR-27）
    if (draft.status === "conflict" || draft.status === "rejected") {
      items.push({
        clientOperationId: draft.clientOperationId,
        operationCode: draft.operationCode,
        outcome: draft.status === "conflict" ? "conflict" : "rejected",
        reason: draft.memo?.reason ?? "前回の結果が確定しています（人が確認するまで送りません）",
      });
      continue;
    }
    try {
      items.push(await syncOne(draft, input.signal, store));
    } catch (e) {
      const skip = (reason: string) =>
        items.push({ clientOperationId: draft.clientOperationId, operationCode: draft.operationCode, outcome: "skipped", reason });
      if (e instanceof ReauthNeeded) {
        // 以降は全て再認証待ち（サーバー主体の失効・停止が401の正。権限は毎要求サーバーで判定される）
        skip("ログインが必要です");
        for (const rest of queue.slice(i + 1)) {
          items.push({ clientOperationId: rest.clientOperationId, operationCode: rest.operationCode, outcome: "skipped", reason: "ログインが必要です" });
        }
        break;
      }
      if (e instanceof DOMException && e.name === "AbortError") skip("中止しました");
      else skip("端末の保存を読み書きできませんでした"); // storeの入出力失敗など。下書きを壊さず次のパスに委ねる
    }
  }
  const count = (o: SyncItemResult["outcome"]) => items.filter((i) => i.outcome === o).length;
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    total: rows.length,
    applied: count("applied"),
    conflict: count("conflict"),
    rejected: count("rejected"),
    // 応答不明（unknown）は今回の完了ではないので未実施に数える（反映とは混同しない）
    skipped: count("skipped") + count("unknown"),
    items,
  };
}

/** 下書き1件の同期（写真→元操作→結果照会の順。失敗の分類はdocs/05のstatus/codeに従う） */
async function syncOne(original: LocalDraft, signal: AbortSignal, store: DraftStore): Promise<SyncItemResult> {
  let draft = original;
  // memoは必ず現在値を起点に上書きする（状態遷移だけの書き込みで進行メモを消さない）
  const touch = async (patch: Partial<LocalDraft>) => {
    draft = { ...draft, ...patch, memo: { ...draft.memo, ...patch.memo, at: new Date().toISOString() } };
    await store.put(draft);
  };
  if (draft.status === "local_draft") await touch({ status: "pending" });

  // --- 写真先行（docs/16 T077: upload/検査readyを待ってから親操作） ---
  const photoType = PHOTO_TARGET_TYPES[draft.operationCode];
  if (draft.attachments.length > 0 && !photoType) {
    // 写真を送れる操作ではないのに写真を参照している＝壊れた下書き。送らず人に報告する
    await touch({ status: "rejected", memo: { reason: "この操作は写真を同期できません（入力を作り直してください）" } });
    return { clientOperationId: draft.clientOperationId, operationCode: draft.operationCode, outcome: "rejected", reason: "この操作は写真を同期できません" };
  }
  if (photoType) {
    const target = (photoType === "from_payload" ? String(draft.payload.type ?? "facility") : photoType) as AttachmentTargetType;
    const gate = await uploadDraftPhotos(draft, target, signal, store, touch);
    if (gate) return gate; // {outcome: skipped|rejected} 写真がreadyになるまで親は送らない
  }

  // --- 元操作の同期（API-81。鍵=clientOperationId） ---
  await touch({ status: "sending", memo: { ...draft.memo, responseUnknown: false } });
  // 結果照会（docs/05 API-82）: 操作IDが判っているときは、送り直す前に照会する。
  // appliedなら送らない（再送不要）、404なら「操作が無い」ことが証明されたので送ってよい
  if (draft.memo?.syncOperationId) {
    const q = await queryOperation(draft.memo.syncOperationId, signal);
    if (q.outcome === "applied") {
      await store.remove(draft.clientOperationId);
      return { clientOperationId: draft.clientOperationId, operationCode: draft.operationCode, outcome: "applied" };
    }
    if (q.outcome === "unknown") {
      return { clientOperationId: draft.clientOperationId, operationCode: draft.operationCode, outcome: "skipped", reason: q.reason };
    }
    // 404（証明された未適用）はこのあとの送信に進む
  }
  const first = await sendCommand(draft, signal, store);
  if (first.outcome !== "unknown") return first;
  // 応答不明: 適用されたか分からない。同じ鍵での再送が照会を兼ねる（一回だけ。新しい鍵は作らない）
  const replay = await sendCommand(draft, signal, store);
  if (replay.outcome !== "unknown") return replay;
  return {
    clientOperationId: draft.clientOperationId,
    operationCode: draft.operationCode,
    outcome: "skipped",
    reason: "応答が確認できません。次の同期で同じ内容を確認します（勝手に新しい操作は作りません）",
  };
}

/**
 * 端末内写真をサーバーへ移す（予約API-26→転送API-83→確定API-84→検査job API-86）。
 * 全てreadyになったらnullを返す（親操作へ進んでよい）。readyにできない間は親を止める理由を返す。
 */
async function uploadDraftPhotos(
  draft: LocalDraft,
  targetType: AttachmentTargetType,
  signal: AbortSignal,
  store: DraftStore,
  touch: (patch: Partial<LocalDraft>) => Promise<void>,
): Promise<SyncItemResult | null> {
  const resolved: Record<string, string> = { ...(draft.memo?.attachmentIds ?? {}) };
  const rejectDraft = async (reason: string): Promise<SyncItemResult> => {
    await touch({ status: "rejected", memo: { ...draft.memo, attachmentIds: resolved, reason } });
    return { clientOperationId: draft.clientOperationId, operationCode: draft.operationCode, outcome: "rejected", reason };
  };
  const holdDraft = async (reason: string): Promise<SyncItemResult> => {
    // ready前・検査中は親を送らない（parentSentBeforeReady=false）。できた分は覚えて次のパスで再利用する
    await touch({ status: "sending", memo: { ...draft.memo, attachmentIds: resolved, reason } });
    return { clientOperationId: draft.clientOperationId, operationCode: draft.operationCode, outcome: "skipped", reason };
  };
  for (const attachment of draft.attachments) {
    if (signal.aborted) return holdDraft("中止しました");
    if (resolved[attachment.blobKey]) continue; // 前回readyになった写真（二重に上げない）
    const blob = await store.getAttachment(attachment.blobKey).catch(() => null);
    if (!blob) return rejectDraft(`写真（${attachment.name}）がこの端末にありません。入力を作り直してください`);
    let intentId: string;
    let token: string;
    try {
      const intent = await api("API-26", {
        body: {
          target: { type: targetType, id: draft.targetId },
          contentType: blob.contentType,
          byteSize: blob.byteSize,
        },
      }, { signal });
      if (!intent.uploadToken) throw new ApiError(0, "RESPONSE_UNKNOWN");
      intentId = intent.id;
      token = intent.uploadToken;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      if (e instanceof ApiError && e.status === 401) throw new ReauthNeeded();
      if (e instanceof ApiError && [400, 403, 404, 409, 422].includes(e.status)) {
        return rejectDraft(`写真の保存先が受け付けられませんでした（${describeError(e)}）。入力を確認してください`);
      }
      return holdDraft("写真を転送できません（通信を確認しています）。転送が済むまで点検は送りません");
    }
    // 転送（バイナリ。AttachmentUploaderと同じ経路・token）
    let attemptId: string;
    try {
      const up = await fetch(`/api/v1/attachments/${intentId}/upload`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": blob.contentType, "x-upload-token": token },
        body: blob.data,
        signal,
      });
      if (!up.ok) throw new ApiError(up.status, "RESPONSE_UNKNOWN");
      attemptId = ((await up.json()) as { data: { id: string } }).data.id;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      if (e instanceof ApiError && e.status === 401) throw new ReauthNeeded();
      return holdDraft("写真を転送できません（通信を確認しています）。転送が済むまで点検は送りません");
    }
    // 完了確定（検査jobの受付）
    let jobId: string;
    try {
      const done = await api("API-84", {
        params: { id: intentId },
        body: { version: 1, uploadAttemptId: attemptId, sha256: await sha256OfBlob(blob.data) },
      }, { signal });
      jobId = done.job.id;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      if (e instanceof ApiError && e.status === 401) throw new ReauthNeeded();
      const detail = e instanceof Error ? `（${e.message}）` : String(e);
      return holdDraft(`写真の検査を開始できません${detail}。次の同期で続けます（点検はまだ送りません）`);
    }
    // 検査待ち。jobの結果だけを見る（未検査の写真を親に載せない＝docs/16 T018と同じ原則）
    let ready = false;
    let rejectedReason: string | null = null;
    for (let i = 0; i < JOB_POLL_MAX; i++) {
      if (signal.aborted) return holdDraft("中止しました");
      await new Promise((r) => setTimeout(r, JOB_POLL_INTERVAL_MS));
      const job = await api("API-86", { params: { id: jobId } }, { signal }).catch(() => null);
      if (!job) continue;
      if (job.status === "succeeded") {
        if (job.resultRef?.startsWith("rejected:")) rejectedReason = "写真の検査が通りませんでした。写真を付け直した新しい入力を作ってください";
        else { resolved[attachment.blobKey] = intentId; ready = true; }
        break;
      }
      if (job.status === "manual_review" || job.status === "stale") {
        rejectedReason = "写真の検査を完了できませんでした。写真を付け直した新しい入力を作ってください";
        break;
      }
    }
    if (rejectedReason) return rejectDraft(rejectedReason);
    if (!ready) return holdDraft("写真の検査中です。検査が済むまで点検は送りません");
  }
  // 検査済みのattachmentIdをpayloadへ載せ、hashを「送る本文」の形に更新する（payloadHashは本文に対する整合値）
  const existing = Array.isArray(draft.payload.attachmentIds) ? (draft.payload.attachmentIds as string[]) : [];
  const merged = [...existing, ...Object.values(resolved).filter((id) => !existing.includes(id))];
  if (merged.length !== existing.length) {
    const payload = { ...draft.payload, attachmentIds: merged };
    await touch({ payload, payloadHash: await payloadHashOf(payload), memo: { ...draft.memo, attachmentIds: resolved } });
  }
  return null;
}

/** API-81の送信。結果を分類する（unknownは応答不明＝上の呼び出し側で同鍵の照会再送に回す） */
async function sendCommand(draft: LocalDraft, signal: AbortSignal, store: DraftStore): Promise<SyncItemResult> {
  const base = { clientOperationId: draft.clientOperationId, operationCode: draft.operationCode };
  const now = new Date().toISOString();
  try {
    await apiCall("API-81", {
      body: {
        clientOperationId: draft.clientOperationId,
        deviceId: draft.scope.deviceId,
        operationCode: draft.operationCode,
        targetId: draft.targetId,
        baseVersion: draft.baseVersion,
        payload: draft.payload,
        payloadHash: draft.payloadHash,
      },
    }, { idempotencyKey: draft.clientOperationId, signal });
    // サーバーが適用を確認した（docs/05 SyncOperation.status=applied）。端末からは消す（送信済みは置かない）
    await store.remove(draft.clientOperationId);
    return { ...base, outcome: "applied" };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    const err = e instanceof ApiError ? e : new ApiError(0, "RESPONSE_UNKNOWN");
    if (err.status === 401) throw new ReauthNeeded();
    if (err.status === 409) {
      if (err.code === "VERSION_CONFLICT") {
        const reason = "サーバーの値が新しくなっています（版の競合）。比較して選んでください";
        await store.put({ ...draft, status: "conflict", memo: { ...draft.memo, responseUnknown: false, errorCode: err.code, reason, at: now } });
        return { ...base, outcome: "conflict", reason };
      }
      // 鍵の期限切れ・取り違え・二重登録。同じ鍵ではもう送れないので「拒否」で止めて人に委ねる
      const reason =
        err.details.some((d) => d.reason === "key_expired") ? "送信鍵の期限が切れました。新しい入力として作り直してください"
          : err.details.some((d) => d.reason === "request_hash_mismatch") ? "同じ鍵で別の内容が送られています（鍵の取り違え）。新しい入力として作り直してください"
            : err.code === "DUPLICATE" ? "同じ記録がすでにあります（二重登録の拒否）。サーバーの記録を確認してください"
              : describeError(err);
      await store.put({ ...draft, status: "rejected", memo: { ...draft.memo, responseUnknown: false, errorCode: err.code, reason, at: now } });
      return { ...base, outcome: "rejected", reason };
    }
    if ([400, 403, 404, 422].includes(err.status)) {
      const reason = err.status === 403 ? "この操作の権限がありません（サーバーで拒否されました）"
        : err.status === 404 ? "対象が見つかりません（削除・変更された可能性があります）"
          : `サーバーが受け付けませんでした（${describeError(err)}）`;
      await store.put({ ...draft, status: "rejected", memo: { ...draft.memo, responseUnknown: false, errorCode: err.code, reason, at: now } });
      return { ...base, outcome: "rejected", reason };
    }
    // 0（通信断・応答喪失）や5xx。応答不明の印だけ残し、状態はsendingのまま（照会・同鍵再送に回す）
    await store.put({ ...draft, status: "sending", memo: { ...draft.memo, responseUnknown: true, reason: "応答が確認できません", at: now } });
    return { ...base, outcome: "unknown" };
  }
}

/** API-82での照会（操作IDが判っているとき。docs/05 API-82「本人」） */
async function queryOperation(id: string, signal: AbortSignal): Promise<{ outcome: "applied" | "none" | "unknown"; reason?: string }> {
  try {
    const op = await api("API-82", { params: { id } }, { signal });
    return op.status === "applied" ? { outcome: "applied" } : { outcome: "unknown", reason: `サーバー側の状態は ${op.status} です` };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    if (e instanceof ApiError && e.status === 401) throw new ReauthNeeded();
    if (e instanceof ApiError && e.status === 404) return { outcome: "none" }; // 存在しない＝未適用の証明
    return { outcome: "unknown", reason: "結果の照会ができません（通信を確認しています）" };
  }
}

/** エラーの短い要約（detailsの最初の項目。コードだけの.raw表示にしない） */
function describeError(e: ApiError): string {
  const d = e.details[0];
  if (d) return `${d.field}: ${d.reason}`;
  return e.code;
}

/** 写真実体のSHA-256（API-84に載せる。サーバー側の検証hashと一致させる） */
async function sha256OfBlob(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 1パスの単一実行ラッパー（手動・自動の共通入口）。実行中は後発の要求を同じパスに寄せる
 * （二重の同期で鍵の解決が競わないように）。
 */
let inFlight: Promise<SyncSummary> | null = null;
let inFlightAbort: AbortController | null = null;

export function runSyncPass(scope: DraftScope): Promise<SyncSummary> {
  if (inFlight) return inFlight;
  inFlightAbort = new AbortController();
  const signal = inFlightAbort.signal;
  syncEvents.dispatchEvent(new Event("start"));
  const pass = syncPending({ scope, signal }).then(
    (summary) => {
      syncEvents.dispatchEvent(new CustomEvent<SyncSummary>("done", { detail: summary }));
      return summary;
    },
    (e) => {
      syncEvents.dispatchEvent(new CustomEvent<SyncSummary>("done"));
      throw e;
    },
  );
  // 実行中フラグの解除は成功・失敗どちらでも（.finallyは拒否される新しいPromiseを作るため、
  // ここでは結果を飲む.thenで同じことをする。未処理のrejectionを作らない）
  const settled = () => {
    inFlight = null;
    inFlightAbort = null;
  };
  void pass.then(settled, settled);
  inFlight = pass;
  return inFlight;
}

/** 手動で動かしているパスがあれば中断する（ログアウト・ユーザー切替時にMeGateがstop()から呼ぶ） */
export function abortSyncPass(): void {
  inFlightAbort?.abort();
}

/**
 * 自動同期（docs/16 T077「syncStartsWithinSeconds≤60」）。起動・online・タブ復帰で即時、
 * 逃したら AUTO_SYNC_INTERVAL_MS ごと。戻り値は停止用の関数（MeGateのcleanupが呼ぶ）。
 * scopeは毎回呼び出し時に取り直す（認証済みmeから組み立てる。T075レビューからの持ち越し事項）。
 */
export function startAutoSync(getScope: () => DraftScope | null): () => void {
  // 端末保存が使えない環境（private mode等。jsdomも同様）では自動同期を開かない。
  // 使えるように見えて毎パス失敗するより、SCR-27の保存の失敗表示だけを出す（store.tsの縮退と同じ方針）
  if (typeof indexedDB === "undefined") return () => undefined;
  let stopped = false;
  let lastAttemptAt = 0;
  const kick = () => {
    if (stopped || inFlight) return;
    const scope = getScope();
    if (!scope) return;
    // 連打防止（visibility/onlineの連発に対して。起動直後は lastAttemptAt=0 なので必ず走る）
    if (Date.now() - lastAttemptAt < AUTO_SYNC_INTERVAL_MS / 2) return;
    lastAttemptAt = Date.now();
    void runSyncPass(scope).catch(() => undefined); // パス内部で失敗を分類済み。画面への通知はsyncEventsで行う
  };
  const onOnline = () => kick();
  const onVisible = () => {
    if (document.visibilityState === "visible") kick();
  };
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);
  const timer = window.setInterval(kick, AUTO_SYNC_INTERVAL_MS);
  kick();
  return () => {
    stopped = true;
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
    window.clearInterval(timer);
    abortSyncPass();
  };
}
