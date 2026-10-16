import type { EventPageDto } from "../../shared/contracts/sync";
import type { ApiContext } from "../http";
import { readEvents } from "./snapshot";

/**
 * 更新配信の輸送（T073、docs/14 D16・docs/evidence/V06-realtime.md）。
 *
 * 30端末の更新配信は **poll方式に固定**した: API-80（差分取得・T072）の再開cursorを一定間隔で回す。
 * 根拠はローカルworkerd＋D1での30端末実測（更新反映p95≈2.4秒〔D18開発案の5秒以内〕）と費用である:
 * - SSE: push源を作るために結局D1の内部pollかDOが要る（二重実装）。長時間接続の再接続・保持の管理も増える。
 * - Durable Objects: wranglerのenvはbindingを継承しないため4環境すべてへのbinding/class/migration追加と
 *   課金（DOリクエスト）が対価として要る。unit内の単調連番とACL filterはD1 outboxが既に担っているため、
 *   30端中超の規模では得るものが小さい。D1読み取り費用が問題になった時点で再評価する（V06残手順・T082）。
 *
 * subscribeはpoll方式の**走査核をsession（AsyncIterable）として束ねた契約**で、API-80の応答はこの
 * 最初の1ページである（1要求=1ページ。続きは受け手がresumeCursorで回す）。この契約を保ったまま
 * SSE/DOへ移すときは、subscribeのpush実装に差し替える（受け手の語彙は変わらない）。
 */

/** 対象filter。nullは絞り無し（unit全体のstream。ACLだけが見え方を決める） */
export type EventFilter = { entityType: string | null; entityId: string | null };

export interface SubscribeInput {
  /** 再開cursor（空文字は先頭から。API-80と同じ語義） */
  cursor: string;
  /** 対象filter（未結合のcursorに付けると結合され、結合済みと矛盾すると409 RESYNC_REQUIRED） */
  filter: EventFilter;
}

/**
 * pollの標準間隔（2秒）。1応答に満杯のページが続く間は受け手が間を置かず追いつくため、
 * この値は「新着がないときの静かさ」と「更新反映の上限遅延（≈間隔＋応答時間）」の取り引きになる。
 * D18開発案（更新遅延p95 5秒）に対する実測の根拠は docs/evidence/V06-realtime.md。
 */
export const POLL_INTERVAL_MS = 2000;
/** 連続失敗時のpoll間隔の上限（クライアント側のbackoff。docs/evidence/V06-realtime.md） */
export const POLL_MAX_INTERVAL_MS = 30_000;
/** 1接続でdrainするページ数の上限（一般一覧の40ページ打ち切りと同じ割り切り。続きは次の接続で） */
const MAX_DRAIN_PAGES = 40;

export const EventTransport = {
  /**
   * 輸送の接続。1回のnext()＝1回の認証済み走査（API-80と同じ走査核。主体・ACLは毎ページ引き直す）で
   * 1ページを返す。空ページで終了する（drain完了。続きの変更は次の接続で）。409 RESYNC_REQUIREDは
   * そのまま伝播する（受け手はsnapshot（API-70）を取り直す。useIncidentUpdatesと同じ規則）。
   * AsyncIterable（輸送の契約）としてもそのまま使える。
   */
  subscribe(ctx: ApiContext, input: SubscribeInput): AsyncGenerator<EventPageDto> {
    let cursor = input.cursor;
    // filterは{null,null}でも「絞り無し」として渡す（API-80の絞り無しと同じ扱いに正規化される）
    return (async function* () {
      for (let pages = 0; pages < MAX_DRAIN_PAGES; pages++) {
        const page = await readEvents(ctx, cursor, { entityType: input.filter.entityType, entityId: input.filter.entityId });
        cursor = page.resumeCursor;
        yield page;
        if (page.events.length === 0) return;
      }
    })();
  },

  /** pollの1周期（API-80の1応答）。routeはこれで1ページを返す（応答契約はT072のEventPageのまま） */
  async firstPage(ctx: ApiContext, input: SubscribeInput): Promise<EventPageDto> {
    return (await EventTransport.subscribe(ctx, input).next()).value!;
  },
};
