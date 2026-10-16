import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import { useOnline } from "../../components/AppShell";
import { LIMITS } from "../../../shared/contracts/common";
import type { EventPageDto } from "../../../shared/contracts/sync";

/**
 * 出動詳細（SCR-12）の更新配信（T073、docs/05 §8・docs/14 D16）。
 *
 * 方式は **poll** に固定した（docs/evidence/V06-realtime.md）。API-80の再開cursorを一定間隔で回し、
 * - 切断後の回収はcursorの位置から（snapshotと接続の隙間にcommitされた変更も取りこぼさない）、
 * - 409 RESYNC_REQUIRED（cursorの期限切れ・認可の変更〔失権〕）はsnapshot（API-70）の取り直しで回復し、
 * - 重複・順序逆の再配信は版比較で畳む（**entityVersionが前より大きいときだけ採用**。表示する版は
 *   後退しない＝reconnect_ignores_old_entity_versions_and_resyncs_expired_cursorと同じ規則）、
 * - オンライン/オフラインの語彙はAppShellの札（useOnline）をそのまま使い、ここでは同期の状態だけを重ねる。
 *
 * cursorは応答ごとに新しくなり（24時間の期限が延びる。docs/05 §8「heartbeat/resumeCursor」）、
 * 主体とACLは毎pollサーバーが引き直すため、この接続が古い権限で見続けることはない。
 */
export type ConnectionState =
  | "online" /** 通信と同期ともに正常（AppShellの「オンライン」と同じ語彙） */
  | "offline" /** 端末がオフライン（useOnline。回復したらpollを続ける） */
  | "resync"; /** 通信はあるが同期をやり直している（cursor失効のsnapshot再取得・失敗のbackoff中） */

/** pollの標準間隔。更新反映の上限遅延は概ね「この間隔＋応答時間」。実測の根拠はdocs/evidence/V06-realtime.md */
const POLL_INTERVAL_MS = 2000;
/** 連続して失敗したときの再試行間隔の上限（2秒→4秒→…→30秒。成功したら2秒へ戻す） */
const POLL_MAX_INTERVAL_MS = 30_000;

export function useIncidentUpdates(id: string): { status: ConnectionState; refresh: () => void } {
  const online = useOnline();
  /** 遠隔の更新を検知した回数。これが動くとrefreshの参照が変わる（下の注記） */
  const [syncTick, setSyncTick] = useState(0);
  /** 通信はあるが同期に失敗している（backoff・snapshot再取得の最中） */
  const [degraded, setDegraded] = useState(false);
  /** 同期ループを即時に1回走らせる（refreshの呼び出しで待ち時間を飛ばす） */
  const wakerRef = useRef<(() => void) | null>(null);
  /** API-80の再開cursor。端末のメモリだけに置く（docs/05 §8） */
  const cursorRef = useRef("");
  /** 画面に見えているとみなす出動の版。これより新しい版のイベントだけを採用する（版は後退しない） */
  const appliedVersionRef = useRef(0);

  /**
   * 今すぐ読み直す。遠隔の新しい版を検知するたびに**新しい関数**として返し直す（わざと不安定な参照）。
   * 画面はrefreshを効果の依存に据えるだけで遠隔更新を反映でき、手動で呼べば即時の同期＋読み直しになる。
   */
  const refresh = useCallback(() => {
    setSyncTick((t) => t + 1);
    wakerRef.current?.();
  }, [syncTick]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let delay = POLL_INTERVAL_MS;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timer = null;
          resolve();
        }, ms);
        wakerRef.current = () => {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
            resolve();
          }
        };
      });
    /** 同じ絞り（この出動）のイベントで、版が進むときだけ採用する（重複・順序逆・旧版は畛む） */
    const fold = (page: EventPageDto): boolean => {
      let advanced = false;
      for (const e of page.events) {
        if (e.entityType === "incident" && e.entityId === id && e.entityVersion > appliedVersionRef.current) {
          appliedVersionRef.current = e.entityVersion;
          advanced = true;
        }
      }
      return advanced;
    };

    void (async () => {
      while (alive) {
        if (!online) {
          // オフラインの間は要求を出さない（AppShellの札が「オフライン」を示す）。回復したら効果が組み直されて続く
          setDegraded(false);
          await sleep(1000);
          continue;
        }
        try {
          const query: Record<string, string> = { entityType: "incident", entityId: id };
          if (cursorRef.current !== "") query.cursor = cursorRef.current;
          else query.afterSequence = "0"; // 初回はこの出動の最初から（履歴の窓は小さい。2ページ目以降はcursorで続く）
          const page = await api("API-80", { query });
          if (!alive) return;
          cursorRef.current = page.resumeCursor;
          const advanced = fold(page);
          // ページが上限まで満ちている間は間を置かず追いつく（切断が長かった端末の回収）
          if (page.events.length >= LIMITS.listLimitDefault) continue;
          if (advanced || page.resyncRequired) {
            // 新しい版を採用した（＝画面の内容が変わる可能性）。詳細を読み直させる。
            // 初回接続でも1回動く（開いた直後に他端末の変更が入っても取りこぼさない。1回の読み直しで収まる）
            setSyncTick((t) => t + 1);
          }
          setDegraded(false);
          delay = POLL_INTERVAL_MS;
          await sleep(delay + POLL_INTERVAL_MS * 0.2 * Math.random()); // 斉奏を崩す揺らめき（±20%以内の遅れ）
        } catch (e) {
          if (!alive) return;
          setDegraded(true);
          if (e instanceof ApiError && e.code === "RESYNC_REQUIRED") {
            // cursorの期限切れ・認可の変更（失権）: snapshot（API-70）を取り直して続行する（docs/05 §8）
            try {
              const snapshot = await api("API-70", { params: { id } });
              if (!alive) return;
              cursorRef.current = snapshot.snapshotCursor;
              if (snapshot.version > appliedVersionRef.current) {
                appliedVersionRef.current = snapshot.version;
                setSyncTick((t) => t + 1); // snapshotの時点で版が進んでいる。詳細を読み直させる
              }
              setDegraded(false);
              delay = POLL_INTERVAL_MS;
            } catch {
              if (!alive) return;
              delay = Math.min(delay * 2, POLL_MAX_INTERVAL_MS);
            }
          } else {
            // 通信断・5xx・読めない応答: 間隔を延ばして再試行（オフライン表示はuseOnlineが担当）
            delay = Math.min(delay * 2, POLL_MAX_INTERVAL_MS);
          }
          await sleep(delay + POLL_INTERVAL_MS * 0.2 * Math.random());
        }
      }
    })();

    return () => {
      alive = false;
      wakerRef.current = null;
      if (timer !== null) clearTimeout(timer);
    };
  }, [id, online]);

  const status: ConnectionState = !online ? "offline" : degraded ? "resync" : "online";
  return { status, refresh };
}
