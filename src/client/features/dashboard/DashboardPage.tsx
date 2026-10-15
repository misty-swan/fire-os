import { useEffect, useState } from "react";
import { Link } from "react-router";
import { apiCall, type ApiInput } from "../../api";
import { useOnline } from "../../components/AppShell";
import { MobileTopRow, PageTitle } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon } from "../../components/ui";
import type { AnnouncementDto } from "../../../shared/contracts/content";
import type { DashboardDto, DashboardMetricDto } from "../../../shared/contracts/operations";
import { useMe } from "../../me";
import { fmtDay, fmtHM } from "../activities/time";

/**
 * ホーム（T047、SCR-02。prototype のホーム / Desktop のダッシュボード）。
 * API-28の各指標（数値）と遷移先（href）をそのままタイルに写す。数値と一覧件数の一致はサーバー側で
 * 保証されており（tests/dashboard.test.ts）、画面は数値とhrefを勝手に加工しない。
 * 未接続の指標（点検期限=T048、通知・自分のタスク=PH4）は0件ではなく「未接続」と出す（docs/16 T047）。
 */

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

const RESPONSE_LABEL: Record<NonNullable<DashboardDto["nextActivity"]["myResponse"]>, string> = {
  unanswered: "未回答", attending: "参加", absent: "不参加", undecided: "未定",
};

interface TileMetric {
  key: string;
  label: string;
  icon: string;
  metric: DashboardMetricDto;
}

/** 指標タイル1つ。接続済みは数値＋一覧へのリンク、未接続は0件ではなく未接続の表示（docs/16 T047） */
function MetricTile({ tile }: { tile: TileMetric }) {
  const { metric, label, icon, key } = tile;
  const inner = (
    <>
      <span className="grid size-[30px] flex-none place-items-center rounded-[9px] bg-white/[.08]">
        <Icon name={icon} fill className="text-[17px]" />
      </span>
      <span className="text-[13px] font-bold leading-[1.4]">{label}</span>
      {metric.connected ? (
        <span className="mt-auto flex items-baseline gap-1">
          <span className="font-mono text-[26px] font-semibold leading-none">{metric.count}</span>
          <span className="text-[11px] text-ink-muted">件</span>
        </span>
      ) : (
        <span className="mt-auto flex items-center gap-1 text-[11px] font-bold text-ink-muted">
          <Icon name="construction" className="text-[14px]" />
          未接続
        </span>
      )}
    </>
  );
  const cls =
    "flex h-full min-h-[96px] flex-col gap-2 rounded-[20px] bg-white/[.04] p-3.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,.07)]";
  if (metric.connected && metric.href) {
    return (
      <Link to={metric.href} data-testid={`metric-${key}`} aria-label={`${label}の一覧を開く（${metric.count}件）`} className={`${cls} hover:bg-white/[.07]`}>
        {inner}
      </Link>
    );
  }
  return (
    <div data-testid={`metric-${key}`} aria-label={`${label}（未接続）`} className={cls}>
      {inner}
    </div>
  );
}

/** 指標を取得できたあとの本文（prototypeホーム: ダイヤル→出欠→やること→お知らせ） */
function DashboardBody({ data, notices }: { data: DashboardDto; notices: AnnouncementDto[] | null }) {
  const next = data.nextActivity;
  const dialTotal = next.attending + next.undecided + next.absent + next.unanswered;
  const attendingPct = dialTotal ? Math.round((next.attending / dialTotal) * 100) : 0;
  const undecidedPct = dialTotal ? Math.round(((next.attending + next.undecided) / dialTotal) * 100) : 0;
  const daysUntil = next.plannedStartsAt
    ? Math.max(0, Math.ceil((new Date(next.plannedStartsAt).getTime() - Date.now()) / 86_400_000))
    : null;
  const untilLabel = daysUntil === null ? null : daysUntil === 0 ? "今日" : daysUntil === 1 ? "明日" : `あと${daysUntil}日`;
  const myResponse = next.myResponse;
  const answered = myResponse !== null && myResponse !== "unanswered";

  const tiles: TileMetric[] = [
    { key: "myUnanswered", label: "本人未回答", icon: "how_to_reg", metric: data.myUnanswered },
    { key: "openIssues", label: "確認待ちの異常", icon: "error", metric: data.openIssues },
    { key: "inspectionDue", label: "点検期限", icon: "event_available", metric: data.inspectionDue },
    { key: "notifications", label: "通知", icon: "notifications", metric: data.notifications },
    { key: "myTasks", label: "自分のタスク", icon: "task_alt", metric: data.myTasks },
  ];

  return (
    <>
      {/* 次回予定のダイヤル（prototypeホーム）。押すと同じ条件（これからの予定）の一覧へ＝数値と一覧が一致する導線 */}
      <div className="grid gap-4 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-center">
        {next.count > 0 && next.href ? (
          <Link
            to={next.href}
            className="relative mx-auto flex size-[236px] items-center justify-center rounded-full transition hover:opacity-90 lg:mx-0"
            aria-label={`これからの予定${next.count}件の一覧を開く（次回は${next.title ?? ""}）`}
            style={{ background: `conic-gradient(#ff6a3d 0 ${attendingPct}%,#ffc35c ${attendingPct}% ${undecidedPct}%,rgba(255,255,255,.08) ${undecidedPct}% 100%)` }}
          >
            <span className="flex size-[214px] flex-col items-center justify-center gap-1 rounded-full bg-[radial-gradient(circle_at_50%_30%,#13203a,#0a1424)] text-center shadow-[inset_0_0_0_1px_rgba(255,255,255,.06)]">
              <span className="font-mono text-[11px] font-semibold tracking-[.14em] text-ember-soft">
                {untilLabel} · {next.kind}
              </span>
              <span className="px-4 text-[20px] font-bold leading-[1.3]">{next.title}</span>
              <span className="font-mono text-[13px] font-medium text-ink-sub">
                {next.plannedStartsAt ? `${fmtDay(next.plannedStartsAt).replace(/（.*）/, "")} ${fmtHM(next.plannedStartsAt)}` : ""}
              </span>
              <span className="mt-1 text-[11px] font-medium text-ink-muted">
                参加 {next.attending} · 未定 {next.undecided} · 未回答 {next.unanswered}
              </span>
            </span>
          </Link>
        ) : (
          <Card className="flex flex-col items-center justify-center gap-2 py-10 text-center lg:size-[236px]">
            <Icon name="event_busy" className="text-[24px] text-ink-muted" />
            <p className="text-[14px] font-bold">これからの予定はありません</p>
            <Link to="/app/activities" className="text-[12px] font-bold text-ember-soft underline-offset-4 hover:underline">
              予定・活動の一覧を開く
            </Link>
          </Card>
        )}

        {/* 出欠の案内（prototypeホームのクイック回答枠。回答そのものは活動詳細SCR-09の本人出欠で行う） */}
        {next.id && next.inAudience && (
          <Card className="flex items-center gap-3">
            {answered ? (
              <>
                <span className="grid size-9 flex-none place-items-center rounded-full bg-ok/[.15] text-ok">
                  <Icon name="check" className="text-[20px]" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[14px] font-bold">「{RESPONSE_LABEL[myResponse!]}」で回答済み</span>
                  <span className="text-[11px] font-medium text-ink-muted">締切まで変更できます</span>
                </span>
                <Link
                  to={`/app/activities/${next.id}`}
                  className="inline-flex h-11 flex-none items-center rounded-pill bg-white/[.08] px-4 text-[13px] font-bold text-ink"
                >
                  変更
                </Link>
              </>
            ) : (
              <>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[14px] font-bold">あなたは未回答です</span>
                  <span className="text-[11px] font-medium text-ink-muted">
                    {next.responseDueAt ? `締切 ${fmtDay(next.responseDueAt)}` : "回答の締切はありません"}
                  </span>
                </span>
                <Link
                  to={`/app/activities/${next.id}`}
                  className="inline-flex h-[46px] flex-none items-center rounded-pill bg-ember px-5 text-[14px] font-bold text-white shadow-[0_8px_24px_-6px_rgba(255,90,46,.6)]"
                >
                  回答する
                </Link>
              </>
            )}
          </Card>
        )}
      </div>

      {/* やること（prototypeホームの横スクロールカード。指標タイルは数値と同じ条件の一覧への導線） */}
      <section className="flex flex-col gap-2.5">
        <h3 className="text-[14px] font-bold">やること</h3>
        <div className="fo-scroll flex gap-2.5 overflow-x-auto max-lg:-mx-5 max-lg:px-5 lg:grid lg:grid-cols-5 lg:overflow-visible">
          {tiles.map((t) => (
            <div key={t.key} className="w-[164px] flex-none lg:w-auto">
              <MetricTile tile={t} />
            </div>
          ))}
        </div>
      </section>

      {/* お知らせ（prototypeホームのお知らせ欄。自分が対象の公開済み。重要/連絡の区分は契約に無いため出さない） */}
      <section className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[14px] font-bold">お知らせ</h3>
          <Link to="/app/announcements" className="inline-flex min-h-11 items-center text-[12px] font-bold text-ember-soft underline-offset-4 hover:underline">
            すべて見る
          </Link>
        </div>
        <Card className="flex flex-col gap-0 p-0">
          {notices && notices.length > 0 ? (
            notices.map((n, i) => (
              <Link
                key={n.id}
                to={`/app/announcements/${n.id}`}
                className={`flex items-start gap-3 p-3.5 hover:bg-white/[.04] ${i > 0 ? "border-t border-white/[.06]" : ""}`}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="line-clamp-2 text-[14px] font-bold leading-[1.5]">{n.title}</span>
                  <span className="font-mono text-[11px] font-medium text-ink-muted">
                    {n.publishedAt ? `${fmtDay(n.publishedAt)} ${fmtHM(n.publishedAt)}` : ""}
                  </span>
                </span>
                {n.readAt ? <Chip tone="neutral">既読</Chip> : <Chip tone="alert">未読</Chip>}
              </Link>
            ))
          ) : (
            <p className="p-4 text-[13px] font-medium text-ink-muted">お知らせはまだありません</p>
          )}
        </Card>
      </section>
    </>
  );
}

export function DashboardPage() {
  const online = useOnline();
  const { me } = useMe();
  const [data, setData] = useState<DashboardDto | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [notices, setNotices] = useState<AnnouncementDto[] | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    void (async () => {
      try {
        const res = await apiCall("API-28", { query: {} }, { signal: ctrl.signal });
        if (!alive) return;
        setData(res.data as unknown as DashboardDto);
        setPhase("ready");
      } catch (e) {
        if (alive && !(e instanceof DOMException && e.name === "AbortError")) setPhase("error");
      }
    })();
    // お知らせ欄（prototypeホーム）。公開済みで自分が対象のものを新しい順に3件（全文はSCR-16の一覧）
    void (async () => {
      try {
        const rows = (
          await apiCall("API-24", { query: { status: "published", limit: 3 } as ApiInput<"API-24">["query"] }, { signal: ctrl.signal })
        ).data as unknown as AnnouncementDto[];
        if (alive) setNotices(rows);
      } catch {
        if (alive) setNotices([]);
      }
    })();
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [reloadKey]);

  const now = new Date();
  const dateLabel = `${now.getMonth() + 1}月${now.getDate()}日（${WEEKDAYS[now.getDay()]}）· ${me.unitName}`;
  const hour = now.getHours();
  const greeting = hour < 4 ? "こんばんは" : hour < 11 ? "おはようございます" : hour < 18 ? "こんにちは" : "こんばんは";
  const familyName = me.profile.displayName.trim().split(/\s+/)[0] ?? me.profile.displayName; // 姓（先頭トークン。prototype:117「佐藤さん」）

  return (
    <div className="mx-auto flex w-full max-w-[900px] flex-col gap-5">
      {/* スマホの最上段（通信状態・DEMO・通知。prototype ホームの1行目）。その下に日付と画面名・挨拶 */}
      <div>
        <MobileTopRow online={online} />
      </div>
      <PageTitle eyebrow={dateLabel} className="lg:hidden">
        ホーム
      </PageTitle>
      <p className="-mt-3 text-[22px] font-bold leading-[1.35] lg:hidden">
        {greeting}、{familyName}さん
      </p>

      {phase === "loading" && (
        <div className="flex flex-col gap-3">
          <div className="grid h-[240px] place-items-center animate-pulse rounded-[22px] bg-white/[.05]" />
          <div className="grid grid-cols-2 gap-2.5">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className="h-24 animate-pulse rounded-[20px] bg-white/[.05]" />
            ))}
          </div>
        </div>
      )}
      {phase === "error" && (
        <Banner
          tone="error"
          eyebrow="ERROR"
          role="alert"
          title="ホームの指標を取得できませんでした"
          action={
            <Button variant="secondary" className="max-lg:min-h-11" onClick={() => setReloadKey((k) => k + 1)}>
              再読み込み
            </Button>
          }
        >
          通信を確認してもう一度お試しください。
        </Banner>
      )}
      {phase === "ready" && data && <DashboardBody data={data} notices={notices} />}

      {/* AIバー（prototypeホームの最下部。AIアシスタントはPH5=SCR-28のため、入口だけを置く） */}
      <Link
        to="/app/assistant"
        className="fixed inset-x-3 bottom-24 z-20 flex h-[54px] items-center gap-2.5 rounded-pill bg-[rgba(20,30,50,.86)] pl-4 pr-2 shadow-[inset_0_0_0_1px_rgba(170,150,255,.32),0_14px_30px_-8px_rgba(0,0,0,.7)] backdrop-blur-[18px] lg:hidden"
      >
        <Icon name="auto_awesome" className="text-[20px] text-ai" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-sub">AIアシスタント（後のフェーズで実装）</span>
        <span className="grid size-[38px] flex-none place-items-center rounded-full bg-ai text-[#0b1220]">
          <Icon name="arrow_upward" className="text-[20px]" />
        </span>
      </Link>
    </div>
  );
}
