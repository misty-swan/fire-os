import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { apiCall } from "../../api";
import { PageTitle } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, Notice, TextField } from "../../components/ui";
import { useOnline } from "../../components/AppShell";
import type { ApiInput } from "../../api";
import type { IncidentDto } from "../../../shared/contracts/operations";
import { incidentKinds, incidentStates } from "../../../shared/states";
import { boundFromQuery } from "../activities/time";

/**
 * 出動履歴の一覧（T044、SCR-11。prototype メニューの「出動履歴」タイル。PCは赤枠の「出動管理」）。
 * 種別（模擬/訓練/実出動記録）は色＋文字で目立つように区分し（docs/03 SCR-11）、
 * 状態（記録中/出動中/終了/無効）は種別と別のピルで示す（docs/11 出動イベント。種別と状態は別契約）。
 * 種別/状態/期間（from包含/to排他）で絞る（API-21）。
 * ?activity= は活動詳細からの相互導線（T043のリンク後）。API-21にactivityIdの絞り込みが無いため
 * 全ページを読んでからクライアントで絞り込む（docs/03「意図して変えた点」に記録）。
 * 同期状態はオンライン/オフラインの札だけ（端末同期はPH6。完了を示す表示はしない。docs/03 §1.1）。
 */

/** 種別は色＋文字で区分する（docs/03 SCR-11「目立つ文字で区分」。色だけに頼らない） */
export const INCIDENT_KIND: Record<(typeof incidentKinds)[number], { label: string; color: string }> = {
  simulation: { label: "模擬", color: "#ff7a66" },
  training: { label: "訓練", color: "#ffc35c" },
  actual_record: { label: "実出動記録", color: "#ff5a2e" },
};

/** 状態（docs/11 出動イベント。recording→active/closed/voided、active→closed、closed→recordingは訂正） */
export const INCIDENT_STATUS: Record<(typeof incidentStates)[number], { label: string; tone: "neutral" | "ok" | "attention" | "alert" }> = {
  recording: { label: "記録中", tone: "attention" },
  active: { label: "出動中", tone: "alert" },
  closed: { label: "終了", tone: "neutral" },
  voided: { label: "無効", tone: "neutral" },
};

type IncidentQuery = NonNullable<ApiInput<"API-21">["query"]>;

export function IncidentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const kind = searchParams.get("kind") ?? "";
  const status = searchParams.get("status") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const activityId = searchParams.get("activity") ?? "";
  const online = useOnline();

  const [items, setItems] = useState<IncidentDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  /** 活動での絞り込みで全ページを読み切れなかった（上限打ち切り） */
  const [walkTruncated, setWalkTruncated] = useState(false);

  const query = (): Partial<IncidentQuery> => ({
    limit: 50,
    ...(kind ? { kind: kind as (typeof incidentKinds)[number] } : {}),
    ...(status ? { status: status as (typeof incidentStates)[number] } : {}),
    // 期間は半開区間[from, to)（docs/05 §1。occurred_atで判定。activitiesと同じ変換）
    ...(from ? { from: boundFromQuery(from) } : {}),
    ...(to ? { to: boundFromQuery(to, true) } : {}),
  });

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    setPhase("loading");
    setItems([]);
    setWalkTruncated(false);
    void (async () => {
      try {
        const res = await apiCall("API-21", { query: query() as IncidentQuery }, { signal: ctrl.signal });
        if (!alive) return;
        let all = res.data as unknown as IncidentDto[];
        let next: string | undefined = res.nextCursor;
        // 活動での絞り込み（?activity=）はAPI-21にactivityIdが無いため全ページを読んでから行う。
        // 見えている範囲だけで黙って切り捨てない（docs/05 §1）。上限は40ページ（異常な母数での無限取得を防ぐ）
        let pages = 1;
        while (next && activityId && !ctrl.signal.aborted && pages < 40) {
          const more = await apiCall("API-21", { query: { ...query(), cursor: next } as IncidentQuery }, { signal: ctrl.signal });
          all = [...all, ...(more.data as unknown as IncidentDto[])];
          next = more.nextCursor;
          pages += 1;
        }
        if (!alive) return;
        setItems(all);
        setCursor(activityId ? null : (next ?? null));
        setWalkTruncated(Boolean(next) && activityId !== "");
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
      const res = await apiCall("API-21", { query: { ...query(), cursor } as IncidentQuery });
      setItems((prev) => [...prev, ...(res.data as unknown as IncidentDto[])]);
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

  // 活動詳細からの相互導線: activityIdでの絞り込みはAPIに無いため、読み切った全行からクライアントで絞る
  const shown = activityId ? items.filter((i) => i.activityId === activityId) : items;

  const fmtDay = (iso: string) => {
    const d = new Date(iso);
    return { date: d.getDate(), dow: ["日", "月", "火", "水", "木", "金", "土"][d.getDay()], key: d.toISOString() };
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <PageTitle
        eyebrow="INCIDENTS"
        className="lg:[&_h2]:hidden"
        right={
          <span aria-hidden="true" className="grid size-11 place-items-center rounded-full bg-white/[.06]">
            <Icon name="e911_emergency" className="text-[21px] text-[#ff7a66]" />
          </span>
        }
      >
        出動履歴
      </PageTitle>

      {/* 正式連絡に依存しない旨（docs/14 D08。prototype 出動モードの注記の文言） */}
      <Notice tone="info" icon="info" role="status">
        この記録は正式な指令ではありません。現場の指揮は団長・消防署の指示に従ってください。本アプリは応答と記録の共有のための補助です。
      </Notice>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}>
          <Icon name="restart_alt" className="text-[17px]" />
          条件を消す
        </Button>
        <Link
          to="/app/incidents/new"
          className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-pill bg-white/[.08] px-4 text-[13px] font-bold text-ink"
        >
          <Icon name="add" className="text-[17px]" />
          出動記録を登録
        </Link>
      </div>

      {/* 検索（docs/03 SCR-11: 種別/日時/状態。API-21のkind/status/from/to） */}
      <Card className="grid gap-3 lg:grid-cols-2" aria-label="出動記録の検索">
        <label className="hairline flex h-[54px] items-center gap-2 rounded-field bg-white/[.06] px-4">
          <span className="text-[12px] font-bold text-ink-sub">種別</span>
          <select
            aria-label="種別で絞る"
            value={kind}
            onChange={(e) => setParam({ kind: e.target.value })}
            className="min-w-0 flex-1 border-none bg-transparent text-[14px] font-medium text-ink outline-none"
          >
            <option value="">すべての種別</option>
            {incidentKinds.map((k) => (
              <option key={k} value={k}>
                {INCIDENT_KIND[k].label}
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
            <option value="">すべての状態</option>
            {incidentStates.map((s) => (
              <option key={s} value={s}>
                {INCIDENT_STATUS[s].label}
              </option>
            ))}
          </select>
        </label>
        <TextField name="filter-from" label="この日から" type="date" value={from} onChange={(e) => setParam({ from: e.target.value })} />
        <TextField name="filter-to" label="この日まで" type="date" value={to} onChange={(e) => setParam({ to: e.target.value })} />
      </Card>

      {activityId && (
        <Notice tone="info" icon="link" role="status">
          選んだ活動に関連する出動記録だけを表示しています。
          <button type="button" onClick={() => setParam({ activity: null })} className="ml-1 font-bold underline">
            全体の履歴に戻る
          </button>
        </Notice>
      )}

      {phase === "loading" && (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-20 animate-pulse rounded-[20px] bg-white/[.05]" />
          ))}
        </div>
      )}
      {phase === "error" && (
        <Banner tone="error" eyebrow="ERROR" role="alert" title="出動記録の一覧を取得できませんでした">
          通信を確認して、再読み込みしてください。
        </Banner>
      )}
      {phase === "ready" && shown.length === 0 && (
        <Banner tone="info" eyebrow="EMPTY" title="該当する出動記録はありません">
          {activityId ? "この活動に関連する出動記録はまだありません。「出動記録を登録」から作ってください。" : "条件を変えるか、「出動記録を登録」から作ってください。"}
        </Banner>
      )}
      {walkTruncated && (
        <Banner tone="warning" eyebrow="LIMIT" role="status" title="関連する記録をすべて読み込めていません">
          件数が多いため一部だけを表示しています。期間や状態で絞り込んでください。
        </Banner>
      )}

      <ul className="flex flex-col gap-2" aria-label="出動記録の一覧">
        {shown.map((inc) => {
          const d = fmtDay(inc.occurredAt);
          const k = INCIDENT_KIND[inc.kind];
          const st = INCIDENT_STATUS[inc.status];
          return (
            <li key={inc.id}>
              <Link
                to={`/app/incidents/${inc.id}`}
                className="grid grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-3.5 rounded-[20px] bg-white/[.04] p-3.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,.07)] hover:bg-white/[.07]"
              >
                <span className="flex flex-col items-center gap-0.5 rounded-[14px] bg-white/[.05] py-1.5">
                  <span className="font-mono text-[18px] font-semibold">{d.date}</span>
                  <span className="text-[10px] text-ink-muted">{d.dow}</span>
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  {/* 種別は目立つ文字で区分（docs/03 SCR-11）。色点＋色文字＋文字ラベル */}
                  <span className="flex items-center gap-1.5 text-[12px] font-bold" style={{ color: k.color }}>
                    <span aria-hidden="true" className="size-2 flex-none rounded-[2px]" style={{ background: k.color }} />
                    {k.label}
                  </span>
                  <span className="truncate text-[15px] font-bold">{inc.summary}</span>
                </span>
                <Chip tone={st.tone}>{st.label}</Chip>
              </Link>
            </li>
          );
        })}
      </ul>

      {cursor && !activityId && (
        <Button variant="secondary" busy={phase === "loading"} onClick={() => void loadMore()} className="max-lg:min-h-11">
          さらに読み込む
        </Button>
      )}

      <p className="flex items-center gap-2 px-0.5 text-[12px] text-ink-muted">
        <span aria-hidden="true" className={`size-[7px] rounded-full ${online ? "bg-ok" : "bg-attention"}`} />
        {online ? "オンライン" : "オフライン"}（端末同期は後の機能で接続します）
      </p>
    </div>
  );
}
