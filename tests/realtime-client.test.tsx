import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIncidentUpdates } from "../src/client/features/incidents/useIncidentUpdates";

/**
 * 出動詳細の更新配信フック（T073、SCR-12）。
 * fetchを契約どおりの応答で置き換え、jsdomの実タイマーの代わりに偽タイマーでpoll周期を進める。
 * 確かめるのは画面から見える振る舞いだけである:
 * - 新しい版（entityVersionが前より大きい）を採用したときだけrefreshの参照が変わる（旧版・重複では動かない）
 * - 409 RESYNC_REQUIREDのときsnapshot（API-70）を取り直し、新しいcursorで続ける
 * - オフラインの間は要求を出さず、回復したら続ける（語彙はAppShellの札と同じ online/offline/resync）
 */
const ID = "22222222-2222-4222-8222-222222222222";

type Reply = { status: number; body?: unknown } | Error;

const event = (version: number) => ({
  id: crypto.randomUUID(),
  entityType: "incident",
  entityId: ID,
  entityVersion: version,
  eventType: "summary",
  payload: {},
  sequence: version,
  createdAt: "2026-10-15T00:00:00.000Z",
});
const page = (events: unknown[], cursor: string) => ({ status: 200, body: { data: { events, resumeCursor: cursor, resyncRequired: false }, meta: { requestId: "r" } } });
const fail = (status: number, code: string) => ({ status, body: { error: { code, message: "x", details: [] }, meta: { requestId: "r" } } });

/** URLごとに応答を決めるfetchの置き換え。呼ばれたURLはfn.mock.callsで検査する */
function stubFetch(handler: (url: string) => Reply) {
  const fn = vi.fn(async (url: string) => {
    const r = await handler(url);
    if (r instanceof Error) throw r;
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const eventsUrls = (fn: ReturnType<typeof stubFetch>) =>
  fn.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/api/v1/events"));

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
});

describe("useIncidentUpdates (T073)", () => {
  it("remote_newer_version_advances_and_old_version_does_not_regress", async () => {
    const fn = stubFetch((url) => {
      if (!url.includes("/api/v1/events")) throw new Error(`unexpected: ${url}`);
      if (url.includes("afterSequence=0")) return page([event(3)], "c1"); // 初回: この出動の最初から
      if (url.includes("cursor=c1")) return page([event(2)], "c2"); // 旧版の再配信（at-least-once／順序逆）
      if (url.includes("cursor=c2")) return page([event(4)], "c3"); // 他端末の新しい変更
      return page([], "c9");
    });

    const { result } = renderHook(() => useIncidentUpdates(ID));
    const beforeFirstPoll = result.current.refresh; // 初回描画時の参照（まだ何も採用していない）
    await act(async () => {}); // 初回poll（即時）を流す
    const initial = result.current.refresh;
    expect(result.current.status).toBe("online");
    expect(eventsUrls(fn)[0]).toContain("afterSequence=0");
    expect(initial).not.toBe(beforeFirstPoll); // 新しい版(3)を採用 → 詳細の読み直し

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500); // poll周期2秒＋揺らめきを跨ぐ
    });
    expect(result.current.refresh).toBe(initial); // 旧版(2)では版を動かさない（後退しない・読み直させない）
    expect(eventsUrls(fn)[1]).toContain("cursor=c1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(result.current.refresh).not.toBe(initial); // 新しい版(4)を採用 → 読み直し
    expect(eventsUrls(fn)[2]).toContain("cursor=c2");
    expect(result.current.status).toBe("online");
  });

  it("full_page_catchup_still_triggers_screen_refresh", async () => {
    // 切断中の未反映がちょうど50（満杯1ページ）で、最終ページが空になる境界。
    // 満杯ページで採用した版も捨てず、追い上げの最後で画面を読み直させる
    const full = Array.from({ length: 50 }, (_, i) => event(i + 1));
    const fn = stubFetch((url) => {
      if (!url.includes("/api/v1/events")) throw new Error(`unexpected: ${url}`);
      if (url.includes("afterSequence=0")) return page(full, "c50");
      if (url.includes("cursor=c50")) return page([], "c51");
      return page([], "c99");
    });

    const { result } = renderHook(() => useIncidentUpdates(ID));
    const before = result.current.refresh;
    await act(async () => {}); // 満杯ページ→（間を置かず）空ページまで追い上げを流す
    expect(eventsUrls(fn)[1]).toContain("cursor=c50"); // 追い上げはcursorで続いている
    expect(result.current.refresh).not.toBe(before); // 満杯ページで採用した新版でも詳細を読み直す
    expect(result.current.status).toBe("online");
  });

  it("resync_required_recovers_via_snapshot_and_continues_with_new_cursor", async () => {
    let resolveSnap: ((r: Reply) => void) | null = null;
    const fn = stubFetch((url) => {
      if (url.includes("/api/v1/incidents/")) {
        // snapshot（API-70）の応答をここで止めて、「再同期中」の札を出している間を確かめる
        return new Promise<Reply>((resolve) => {
          resolveSnap = resolve;
        }) as unknown as Reply;
      }
      if (url.includes("afterSequence=0")) return page([], "c1");
      if (url.includes("cursor=c1")) return fail(409, "RESYNC_REQUIRED"); // 期限切れ・失権など
      if (url.includes("cursor=snap-2")) return page([], "snap-3");
      throw new Error(`unexpected: ${url}`);
    });

    const { result } = renderHook(() => useIncidentUpdates(ID));
    await act(async () => {});
    const initial = result.current.refresh;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500); // 2回目のpollが409 → snapshotの取り直しへ
    });
    // snapshotの応答を待っている間は「再同期」。保存済みでもonlineでもない
    expect(result.current.status).toBe("resync");

    await act(async () => {
      resolveSnap!({
        status: 200,
        body: { data: { id: ID, version: 7, snapshotCursor: "snap-2" }, meta: { requestId: "r" } },
      });
    });
    expect(result.current.status).toBe("online");
    expect(result.current.refresh).not.toBe(initial); // snapshotの版(7)を採用 → 詳細の読み直し

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    // 次のpollはsnapshotCursorから（409のcursorに戻らない）
    expect(eventsUrls(fn).at(-1)).toContain("cursor=snap-2");
  });

  it("offline_pauses_polling_and_reports_offline_then_resumes", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    const fn = stubFetch(() => page([], "c1"));

    const { result } = renderHook(() => useIncidentUpdates(ID));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.status).toBe("offline");
    expect(fn.mock.calls.length).toBe(0); // オフラインの間は1本も要求を出さない

    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current.status).toBe("online");
    expect(eventsUrls(fn)[0]).toContain("afterSequence=0"); // 回復したら最初から追いつく
  });
});
