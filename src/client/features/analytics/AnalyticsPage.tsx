import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { apiCall, type ApiInput } from "../../api";
import { PageTitle } from "../../components/Page";
import { Banner, Card, Chip, Icon, Notice } from "../../components/ui";
import type { AnalyticsDto } from "../../../shared/contracts/operations";

/**
 * 活動分析（T060、SCR-26 /app/analytics。docs/03「月次/年度/団員別、元活動/出動/operation参照」）。
 * prototypeにSCR-26専用の画面は無い（Desktopでは予告ページ）ため共通部品で構成し、
 * 数値・単位・条件・未入力はAPI-52（Analytics）の応答をそのまま写す（画面で加工して数値の根拠を変えない）。
 * - 二重計上なし: 同一operationの活動＋出動は「出来事」として1回だけ数えられている（サーバー側で保証。
 *   tests/analytics.test.ts）。画面語彙は「出来事」「延べ参加」
 * - 未入力: 時間が未入力の出来事は0時間と表示せず「未入力」と出す（docs/14 D05案。0時間と混同しない）
 * - 年度は4月始まり＝docs/14 D05案の**検証設定（未承認）**のため、画面にその旨を常時出す（了承済みとは見せない）
 * - 元データ: sourcesの各行から元活動/出動の詳細（API-07/70）へ辿れる。filtersは同じ条件で開く一覧
 *   （API-05はactual=trueでid集合が一致。API-21は無効(voided)も閲覧可能なため、一覧側は無効行を除して比較）
 */

type View = "monthly" | "year" | "members";

const VIEW_TABS: { key: View; label: string; icon: string }[] = [
  { key: "monthly", label: "月次", icon: "calendar_month" },
  { key: "year", label: "年度", icon: "event_note" },
  { key: "members", label: "団員別", icon: "groups" },
];

/** 分→「X時間Y分」。0分は「0時間」（未入力とは別の表示。未入力は呼び出し側で先に分岐する） */
const formatMinutes = (m: number): string => {
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h === 0) return `${min}分`;
  return min === 0 ? `${h}時間` : `${h}時間${min}分`;
};

/** 月のキー（YYYY-MM）→ JST暦月の半開区間 [from, to)（画面側のドリルダウン用。JSTは夏時間が無い） */
const monthBounds = (month: string): { from: string; to: string } => {
  const start = new Date(`${month}-01T00:00:00+09:00`).getTime();
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { from: new Date(start).toISOString(), to: new Date(new Date(`${next}-01T00:00:00+09:00`).getTime()).toISOString() };
};

/** 今年度（JST暦日で判定。4月始まりの検証設定） */
const currentFiscalYear = (): number => {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const year = Number(day.slice(0, 4));
  return Number(day.slice(5, 7)) >= 4 ? year : year - 1;
};

const monthLabel = (month: string): string => {
  const m = Number(month.split("-")[1]);
  return `${m}月`;
};

/** 条件のチップ（docs/03 SCR-26「条件/単位/未入力を明示」。期間と絞り込みをその場で示す） */
function ConditionsBar({ data }: { data: AnalyticsDto }) {
  const period = data.period.from
    ? `${data.period.from.slice(0, 10)} から ${data.period.to ? `〜 ${data.period.to.slice(0, 10)} まで（終端を含まない）` : "以降"}`
    : "期間の指定なし";
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="集計の条件">
      <Chip tone="neutral" icon="date_range">{period}</Chip>
      {data.fiscalYear !== null && <Chip tone="neutral">{data.fiscalYear}年度</Chip>}
      {data.kind && <Chip tone="neutral">種別: {data.kind}</Chip>}
      {data.memberId && <Chip tone="neutral">団員で絞り込み中</Chip>}
      <Chip tone="neutral" icon="filter_alt">
        単位: 出来事（同じ出来事の活動と出動は1件）・延べ参加（出来事×団員）
      </Chip>
    </div>
  );
}

/** 数値カード（出典の単位を必ず添える。docs/03 SCR-26「単位を明示」） */
function TotalCard({ label, value, unit, note, testid }: { label: string; value: string; unit?: string; note?: string; testid: string }) {
  return (
    <Card className="flex flex-col gap-1.5 p-4" data-testid={testid}>
      <span className="flex items-center gap-1.5 text-[12px] font-bold text-ink-sub">
        <Icon name="insights" className="text-[16px]" />
        {label}
      </span>
      <span className="flex items-baseline gap-1">
        <span className="font-mono text-[26px] font-semibold leading-none" data-testid={`${testid}-value`}>{value}</span>
        {unit && <span className="text-[11px] text-ink-muted">{unit}</span>}
      </span>
      {note && <span className="text-[11px] leading-[1.6] text-ink-muted">{note}</span>}
    </Card>
  );
}

/** 時間が未入力の団員行（既知0なら「未入力」だけ。0時間と表示しない。docs/14 D05案） */
function MemberHoursCell({ known, unknown }: { known: number; unknown: number }) {
  if (unknown > 0 && known === 0) {
    return (
      <span className="flex flex-wrap items-center gap-1">
        <Chip tone="attention">未入力</Chip>
        <span className="text-[11px] text-ink-muted">{unknown}件</span>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-baseline gap-1">
      <span className="font-mono text-[14px] font-semibold">{formatMinutes(known)}</span>
      {unknown > 0 && <span className="text-[11px] font-bold text-attention">＋未入力{unknown}件</span>}
    </span>
  );
}

type AnalyticsQuery = NonNullable<ApiInput<"API-52">["query"]>;

export function AnalyticsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const thisFy = currentFiscalYear();
  const fy = Number(searchParams.get("fy") ?? thisFy);
  const view = (searchParams.get("view") as View | null) ?? "monthly";
  const kind = searchParams.get("kind") ?? "";

  const [data, setData] = useState<AnalyticsDto | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    setPhase("loading");
    void (async () => {
      try {
        const res = await apiCall("API-52", {
          query: { fiscalYear: fy, ...(kind ? { kind } : {}) } as AnalyticsQuery,
        }, { signal: ctrl.signal });
        if (!alive) return;
        setData(res.data as unknown as AnalyticsDto);
        setPhase("ready");
      } catch (e) {
        if (alive && !(e instanceof DOMException && e.name === "AbortError")) setPhase("error");
      }
    })();
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [fy, kind]);

  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    setSearchParams(next, { replace: true });
  };

  const fyOptions = useMemo(() => [0, 1, 2, 3, 4].map((n) => thisFy - n), [thisFy]);

  return (
    <div className="flex max-w-[860px] flex-col gap-4">
      <PageTitle
        eyebrow="ANALYTICS"
        className="lg:[&_h2]:hidden"
        right={
          <span aria-hidden="true" className="grid size-11 place-items-center rounded-full bg-white/[.06]">
            <Icon name="insights" className="text-[21px] text-ink-sub" />
          </span>
        }
      >
        活動分析
      </PageTitle>

      {/* 年度は検証設定（docs/14 D05案・未承認）。了承済みの運用設定とは表示しない（docs/05 §9） */}
      <Notice tone="info" icon="science" role="status">
        年度の区切り（4月始まり）は検証設定（D05案・未承認）です。集計は有効な記録（取り消し・無効は除く）を
        「出来事」の単位で数え、同じ出来事の活動と出動を二重に数えません。時間が未入力の記録は0時間とせず「未入力」と出します。
      </Notice>

      <div className="flex flex-wrap items-center gap-2">
        <label className="hairline flex h-[54px] items-center gap-2 rounded-field bg-white/[.06] px-4">
          <span className="text-[12px] font-bold text-ink-sub">年度</span>
          <select
            aria-label="年度で絞る"
            value={fy}
            onChange={(e) => setParam({ fy: e.target.value })}
            className="min-w-0 border-none bg-transparent text-[14px] font-medium text-ink outline-none"
          >
            {fyOptions.map((y) => (
              <option key={y} value={y}>
                {y}年度
              </option>
            ))}
          </select>
        </label>
        <div role="tablist" aria-label="集計の区分" className="flex gap-1">
          {VIEW_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={view === t.key}
              data-testid={`analytics-tab-${t.key}`}
              onClick={() => setParam({ view: t.key })}
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-pill px-4 text-[13px] font-bold ${
                view === t.key ? "bg-ember text-white" : "bg-white/[.06] text-ink-sub"
              }`}
            >
              <Icon name={t.icon} className="text-[17px]" />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {phase === "loading" && (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-24 animate-pulse rounded-[20px] bg-white/[.05]" />
          ))}
        </div>
      )}
      {phase === "error" && (
        <Banner tone="error" eyebrow="ERROR" role="alert" title="集計を取得できませんでした">
          通信を確認して、再読み込みしてください。
        </Banner>
      )}

      {phase === "ready" && data && (
        <>
          <ConditionsBar data={data} />

          <div className="grid gap-2.5 sm:grid-cols-3">
            <TotalCard
              label="出来事"
              value={String(data.totals.operationCount)}
              unit="件"
              testid="analytics-total-operations"
              note="取り消し・無効の記録は含みません"
            />
            <TotalCard
              label="延べ参加"
              value={String(data.totals.memberCount)}
              unit="人回"
              testid="analytics-total-members"
              note="実参加の記録（活動の実績と出動の参集）。同じ出来事の重複は数えません"
            />
            <TotalCard
              label="活動時間（実績の全体時間）"
              value={data.unknownOperationIds.length > 0 && data.totals.knownDurationMinutes === 0 ? "未入力" : formatMinutes(data.totals.knownDurationMinutes)}
              testid="analytics-total-hours"
              note={
                data.unknownOperationIds.length > 0
                  ? `時間が未入力の出来事が${data.unknownOperationIds.length}件あります（0時間には数えません）`
                  : "実績に全体時間がある記録の合計"
              }
            />
          </div>

          {view === "monthly" && (
            <Card className="flex flex-col gap-0 p-0" aria-label="月次の集計">
              {data.monthly.length === 0 ? (
                <p className="p-4 text-[13px] font-medium text-ink-muted">この条件の記録はまだありません</p>
              ) : (
                data.monthly.map((m) => {
                  const b = monthBounds(m.month);
                  return (
                    <div
                      key={m.month}
                      data-testid={`analytics-month-${m.month}`}
                      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-white/[.06] p-3.5 last:border-b-0"
                    >
                      <span className="w-12 font-mono text-[16px] font-semibold">{monthLabel(m.month)}</span>
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[13px]">
                        <span>
                          出来事 <span className="font-mono font-semibold">{m.operationCount}</span>件
                        </span>
                        <span className="text-ink-sub">
                          延べ参加 <span className="font-mono font-semibold">{m.memberCount}</span>人回
                        </span>
                        {m.unknownOperationCount > 0 && (
                          <span className="text-[11px] font-bold text-attention">未入力{m.unknownOperationCount}件</span>
                        )}
                      </span>
                      <span className="flex gap-1">
                        <Link
                          to={`/app/activities?from=${encodeURIComponent(b.from)}&to=${encodeURIComponent(b.to)}&actual=true`}
                          className="inline-flex min-h-11 items-center rounded-pill bg-white/[.06] px-3 text-[12px] font-bold"
                        >
                          活動
                        </Link>
                        <Link
                          to={`/app/incidents?from=${encodeURIComponent(b.from)}&to=${encodeURIComponent(b.to)}`}
                          className="inline-flex min-h-11 items-center rounded-pill bg-white/[.06] px-3 text-[12px] font-bold"
                        >
                          出動
                        </Link>
                      </span>
                    </div>
                  );
                })
              )}
              <p className="px-4 pb-3.5 text-[11px] leading-[1.6] text-ink-muted">
                月はJSTの暦で分類（活動は予定開始、出動は発生日時）。記録のある月だけを表示します。
              </p>
            </Card>
          )}

          {view === "members" && (
            <Card className="flex flex-col gap-0 p-0" aria-label="団員別の集計">
              {data.members.length === 0 ? (
                <p className="p-4 text-[13px] font-medium text-ink-muted">実参加の記録がまだありません</p>
              ) : (
                data.members.map((mem) => (
                  <Link
                    key={mem.memberId}
                    to={`${data.sources.filters.activitiesHref}${data.sources.filters.activitiesHref.includes("?") ? "&" : "?"}memberId=${mem.memberId}`}
                    data-testid="analytics-member-row"
                    className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-white/[.06] p-3.5 last:border-b-0 hover:bg-white/[.04]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-bold">{mem.displayName}</span>
                      <span className="text-[12px] text-ink-sub">
                        出来事 <span className="font-mono font-semibold">{mem.operationCount}</span>件
                      </span>
                    </span>
                    <MemberHoursCell known={mem.knownDurationMinutes} unknown={mem.unknownOperationCount} />
                    <Icon name="chevron_right" className="text-[18px] text-ink-muted" />
                  </Link>
                ))
              )}
              <p className="px-4 pb-3.5 text-[11px] leading-[1.6] text-ink-muted">
                {/* 利用者向けの語彙で示す（docs番号を画面文面に入れない。「検証設定（D05案・未承認）」の注記自体は規定語彙。PH4レビューC 低3） */}
                実参加のあった団員だけを掲載（分団内のみ）。時間は実績の全体時間で、個人途中参加の時間は含めません。
              </p>
            </Card>
          )}

          {/* 元データ（年度と月次で共通。数値の根拠。docs/03 SCR-26「元活動/出動/operation参照」） */}
          {(view === "year" || view === "monthly") && (
            <section className="flex flex-col gap-2.5">
              <h3 className="text-[14px] font-bold">元データ（この数値の根拠）</h3>
              <Card className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap gap-2">
                  <Link
                    to={data.sources.filters.activitiesHref}
                    data-testid="analytics-source-list-activities"
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-pill bg-white/[.06] px-4 text-[13px] font-bold"
                  >
                    <Icon name="calendar_month" className="text-[17px]" />
                    同じ条件の活動一覧（{data.sources.activities.length}件）
                  </Link>
                  <Link
                    to={data.sources.filters.incidentsHref}
                    data-testid="analytics-source-list-incidents"
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-pill bg-white/[.06] px-4 text-[13px] font-bold"
                  >
                    <Icon name="e911_emergency" className="text-[17px]" />
                    同じ条件の出動一覧（{data.sources.incidents.length}件）
                  </Link>
                </div>
                <p className="text-[11px] leading-[1.6] text-ink-muted">
                  活動の一覧は実績が記録されたものだけを同じ条件で開きます。出動の一覧は無効（voided）の行も表示されますが、集計には含みません。
                </p>
                <ul className="flex flex-col gap-1.5" aria-label="元データの記録">
                  {data.sources.activities.map((row) => (
                    <li key={`a-${row.id}`}>
                      <Link
                        to={`/app/activities/${row.id}`}
                        data-testid={`analytics-source-activity-${row.id}`}
                        className="flex items-center gap-2.5 rounded-[14px] bg-white/[.04] p-3 text-[13px] hover:bg-white/[.07]"
                      >
                        <Chip tone="neutral" icon="calendar_month">活動</Chip>
                        <span className="min-w-0 flex-1 truncate font-bold">{row.title}</span>
                        <span className="font-mono text-[11px] text-ink-muted">{row.plannedStartsAt.slice(0, 10)}</span>
                      </Link>
                    </li>
                  ))}
                  {data.sources.incidents.map((row) => (
                    <li key={`i-${row.id}`}>
                      <Link
                        to={`/app/incidents/${row.id}`}
                        data-testid={`analytics-source-incident-${row.id}`}
                        className="flex items-center gap-2.5 rounded-[14px] bg-white/[.04] p-3 text-[13px] hover:bg-white/[.07]"
                      >
                        <Chip tone="neutral" icon="e911_emergency">出動</Chip>
                        <span className="min-w-0 flex-1 truncate font-bold">{row.summary}</span>
                        <span className="font-mono text-[11px] text-ink-muted">{row.occurredAt.slice(0, 10)}</span>
                      </Link>
                    </li>
                  ))}
                  {data.sources.activities.length === 0 && data.sources.incidents.length === 0 && (
                    <li className="text-[13px] font-medium text-ink-muted">元データはまだありません</li>
                  )}
                </ul>
              </Card>
            </section>
          )}

          {view === "year" && (
            <Card className="flex flex-col gap-2 p-4" aria-label="年度の集計">
              <h3 className="text-[14px] font-bold">{data.fiscalYear}年度のまとめ</h3>
              <p className="text-[13px] leading-[1.8] text-ink-sub">
                {/* 文を分け、未入力が0件のときも文が破綻しない（「（既知分のみ）では…」と読める形をなくす。PH4レビューC 低4） */}
                {data.period.from?.slice(0, 10)} から {data.period.to?.slice(0, 10)} まで（終端を含まない）で、
                有効な記録だけを数えると 出来事{data.totals.operationCount}件・延べ参加{data.totals.memberCount}人回です。
                活動時間は実績の全体時間の合計（既知分のみ）です。
                {data.unknownOperationIds.length > 0
                  ? `時間が未入力の出来事が${data.unknownOperationIds.length}件あり、0時間には数えません。`
                  : "すべての記録に時間が入っています。"}
              </p>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
