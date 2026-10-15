import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { apiCall } from "../../api";
import { PageTitle } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, TextField } from "../../components/ui";
import type { ApiInput } from "../../api";
import type { ActivityDto } from "../../../shared/contracts/operations";
import { activityStates } from "../../../shared/states";
import { boundFromQuery, fmtHM } from "./time";

/**
 * 予定・活動の一覧（T039、SCR-08。prototype の予定・活動画面）。
 * 週ストリップ＋「これから/終了した活動」のグループで、日付/種別/参加者/状態/実参加で検索する（API-05）。
 * filterはURLクエリにもつ（?from=&to=&memberId=&actual= 。T047ホームのドリルダウンから同じURLで開ける）。
 */

/** 開催状態は色と文字で示す（docs/11 §2の開催、docs/03 §1） */
export const ACTIVITY_STATUS: Record<ActivityDto["status"], { label: string; tone: "neutral" | "ok" | "attention" | "alert" }> = {
  draft: { label: "下書き", tone: "neutral" },
  scheduled: { label: "予定", tone: "ok" },
  in_progress: { label: "進行中", tone: "attention" },
  completed: { label: "終了", tone: "neutral" },
  cancelled: { label: "中止", tone: "alert" },
};

/** 種別の色（prototype: 訓練=橙・点検=青・その他=薄灰） */
export const kindColor = (kind: string) => (kind === "訓練" ? "#ff6a3d" : kind === "点検" ? "#4f9bff" : "#c3cad6");

type ActQuery = NonNullable<ApiInput<"API-05">["query"]>;

const STATUS_OPTIONS = [
  { value: "", label: "すべての状態" },
  ...activityStates.map((v) => ({ value: v, label: ACTIVITY_STATUS[v].label })),
];

export function ActivitiesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const kind = searchParams.get("kind") ?? "";
  const memberId = searchParams.get("memberId") ?? "";
  const status = searchParams.get("status") ?? "";
  const actual = searchParams.get("actual") === "true";

  const [items, setItems] = useState<ActivityDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [members, setMembers] = useState<{ id: string; displayName: string }[]>([]);

  // 参加者filterの選択肢（API-02。IssuesPageの担当選択と同じ流儀）
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = (await apiCall("API-02", { query: { limit: 200 } })).data as unknown as { id: string; displayName: string }[];
        if (alive) setMembers(rows);
      } catch {
        if (alive) setMembers([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const query = (): Partial<ActQuery> => ({
    limit: 50,
    ...(from ? { from: boundFromQuery(from) } : {}),
    ...(to ? { to: boundFromQuery(to, true) } : {}),
    ...(kind ? { kind } : {}),
    ...(memberId ? { memberId } : {}),
    ...(status ? { status: status as (typeof activityStates)[number] } : {}),
    ...(actual ? { actual: "true" } : {}),
  });

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    setPhase("loading");
    setItems([]);
    void (async () => {
      try {
        const res = await apiCall("API-05", { query: query() as ActQuery }, { signal: ctrl.signal });
        if (!alive) return;
        setItems(res.data as unknown as ActivityDto[]);
        setCursor(res.nextCursor ?? null);
        setPhase("ready");
      } catch (e) {
        if (alive && !(e instanceof DOMException && e.name === "AbortError")) setPhase("error");
      }
    })();
    return () => {
      alive = false;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const loadMore = async () => {
    if (!cursor) return;
    setPhase("loading");
    try {
      const res = await apiCall("API-05", { query: { ...query(), cursor } as ActQuery });
      setItems((prev) => [...prev, ...(res.data as unknown as ActivityDto[])]);
      setCursor(res.nextCursor ?? null);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  };

  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    setSearchParams(next, { replace: true });
  };
  const clearFilters = () => setSearchParams(new URLSearchParams(), { replace: true });

  // 週ストリップ（prototype: 月始まりの7日。今日は白抜き、予定のある日は点）
  const week = (() => {
    const today = new Date();
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const eventDays = new Set(items.map((i) => new Date(i.plannedStartsAt).toDateString()));
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return {
        date: d,
        dow: ["月", "火", "水", "木", "金", "土", "日"][i],
        isToday: d.toDateString() === today.toDateString(),
        hasEvent: eventDays.has(d.toDateString()),
      };
    });
  })();

  const nowIso = new Date().toISOString();
  const upcoming = items.filter((i) => i.plannedStartsAt >= nowIso);
  const past = items.filter((i) => i.plannedStartsAt < nowIso).reverse(); // 終了した活動は新しい順

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <PageTitle
        eyebrow="2026 · ACTIVITIES"
        className="lg:[&_h2]:hidden"
        right={
          <span aria-hidden="true" className="grid size-11 place-items-center rounded-full bg-white/[.06]">
            <Icon name="calendar_month" className="text-[21px] text-ink-muted" />
          </span>
        }
      >
        予定・活動
      </PageTitle>

      {/* 週ストリップ（prototype: 7日の枠＋今日の白抜き＋予定の点） */}
      <div aria-hidden="true" className="grid grid-cols-7 gap-1">
        {week.map((d) => (
          <div
            key={d.date.toISOString()}
            className={`flex h-[68px] flex-col items-center justify-center gap-1 rounded-[18px] ${d.isToday ? "bg-ink text-night" : "bg-white/[.04]"}`}
          >
            <span className={`text-[10px] ${d.isToday ? "text-night/70" : "text-ink-muted"}`}>{d.dow}</span>
            <span className="font-mono text-[17px] font-semibold">{d.date.getDate()}</span>
            <span className={`size-[5px] rounded-full ${d.hasEvent ? "bg-ember" : "bg-transparent"}`} />
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={clearFilters}>
          <Icon name="restart_alt" className="text-[17px]" />
          条件を消す
        </Button>
        <Link
          to="/app/activities/new"
          className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-pill bg-white/[.08] px-4 text-[13px] font-bold text-ink"
        >
          <Icon name="add" className="text-[17px]" />
          予定を登録
        </Link>
      </div>

      {/* 検索（docs/03 SCR-08: 日付/種別/参加者/状態。actualは実参加の記録がある活動） */}
      <Card className="grid gap-3 lg:grid-cols-2" aria-label="予定の検索">
        <TextField name="filter-from" label="この日から" type="date" value={from} onChange={(e) => setParam({ from: e.target.value })} />
        <TextField name="filter-to" label="この日まで" type="date" value={to} onChange={(e) => setParam({ to: e.target.value })} />
        <label className="hairline flex h-[54px] items-center gap-2 rounded-field bg-white/[.06] px-4">
          <span className="text-[12px] font-bold text-ink-sub">参加者</span>
          <select
            aria-label="参加者で絞る"
            value={memberId}
            onChange={(e) => setParam({ memberId: e.target.value })}
            className="min-w-0 flex-1 border-none bg-transparent text-[14px] font-medium text-ink outline-none"
          >
            <option value="">すべての団員</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="hairline flex h-[54px] items-center gap-2 rounded-field bg-white/[.06] px-4">
          <span className="text-[12px] font-bold text-ink-sub">状態</span>
          <select
            aria-label="状態で絞る"
            value={status}
            onChange={(e) => setParam({ status: e.target.value })}
            className="min-w-0 flex-1 border-none bg-transparent text-[14px] font-medium text-ink outline-none"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <TextField name="filter-kind" label="種別" value={kind} onChange={(e) => setParam({ kind: e.target.value })} placeholder="訓練・点検・行事など" />
        <label className="flex min-h-[54px] items-center gap-2.5 rounded-field bg-white/[.06] px-4">
          <input type="checkbox" checked={actual} onChange={(e) => setParam({ actual: e.target.checked ? "true" : null })} className="size-5" />
          <span className="text-[13px] font-medium text-ink">実参加の記録がある</span>
        </label>
      </Card>

      {phase === "loading" && (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-20 animate-pulse rounded-[20px] bg-white/[.05]" />
          ))}
        </div>
      )}
      {phase === "error" && (
        <Banner tone="error" eyebrow="ERROR" role="alert" title="予定の一覧を取得できませんでした">
          通信を確認して、再読み込みしてください。
        </Banner>
      )}
      {phase === "ready" && items.length === 0 && (
        <Banner tone="info" eyebrow="EMPTY" title="該当する予定はありません">
          条件を変えるか、「予定を登録」から作ってください。
        </Banner>
      )}

      {/* prototype: 「これから」「終了した活動」のグループ。行は日付箱＋種別・時刻＋題＋状態ピル */}
      {(
        [
          { heading: "これから", list: upcoming },
          { heading: "終了した活動", list: past },
        ] as const
      ).map(
        (g) =>
          g.list.length > 0 && (
            <section key={g.heading} className="flex flex-col gap-2">
              <h3 className="mt-2 font-mono text-[11px] font-semibold tracking-[.14em] text-ink-dim">{g.heading}</h3>
              <div className="flex flex-col gap-2">
                {g.list.map((a) => {
                  const d = new Date(a.plannedStartsAt);
                  const meta = ACTIVITY_STATUS[a.status];
                  return (
                    <Link
                      key={a.id}
                      to={`/app/activities/${a.id}`}
                      className="grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-3.5 rounded-[20px] bg-white/[.04] p-3.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,.07)] hover:bg-white/[.07]"
                    >
                      <span className="flex flex-col items-center gap-0.5 rounded-[14px] bg-white/[.05] py-1.5">
                        <span className="font-mono text-[18px] font-semibold">{d.getDate()}</span>
                        <span className="text-[10px] text-ink-muted">{["日", "月", "火", "水", "木", "金", "土"][d.getDay()]}</span>
                      </span>
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="flex items-center gap-1.5 text-[11px] font-medium text-ink-sub">
                          <span aria-hidden="true" className="size-[7px] flex-none rounded-[2px]" style={{ background: kindColor(a.kind) }} />
                          {a.kind} · {fmtHM(a.plannedStartsAt)}
                        </span>
                        <span className="truncate text-[15px] font-bold">{a.title}</span>
                      </span>
                      <Chip tone={meta.tone}>{meta.label}</Chip>
                    </Link>
                  );
                })}
              </div>
            </section>
          ),
      )}

      {cursor && (
        <Button variant="secondary" busy={phase === "loading"} onClick={() => void loadMore()} className="max-lg:min-h-11">
          さらに読み込む
        </Button>
      )}
    </div>
  );
}
