import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { api, apiCall, type ApiInput } from "../../api";
import { MutationStatus } from "../../components/MutationStatus";
import { PageTitle, SubHeader } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, Notice } from "../../components/ui";
import type { MyNotificationDto, NotificationDto } from "../../../shared/contracts/content";
import { useMe } from "../../me";
import { useMutation } from "../../useMutation";
import { fmtInstant } from "../activities/time";
import { TasksPanel } from "../tasks/TasksPanel";
import { NotificationApproval, SenderNotificationDetail, isSenderProjection } from "./NotificationApproval";
import { useMemberNames } from "./names";

/**
 * タスク・通知（T052、SCR-21 /app/tasks-notifications。docs/03 SCR-21「業務タスク、通知draft/本文/対象/
 * 承認/配送失敗/既読」「受付/配送/既読を別表示、再送/取消は対象を明示」）。
 *
 * 1画面を3つの入口（別入口=aliases。お知らせSCR-16と同じ方式）で扱う:
 *  - 一覧（このcomponent）: 通知タブ（自分宛の通知。API-67。?unread=trueで未読だけ＝ホームの通知指標と
 *    同じ条件）とタスクタブ（TasksPanel。API-102）をURLクエリ ?tab= で切り替える
 *  - 通知を作成（/notifications/new）: NotificationApproval（源の選択→承認前確認→承認/取消→配送結果）
 *  - 詳細（/notifications/:id）: API-65は呼び出し者で投影が変わる（送信者=全体、対象者=自分の分だけ）ため、
 *    応答を実行値で区別して送信者视图（SenderNotificationDetail）と対象者视图（本人既読）を出し分ける
 *
 * 本人既読（API-100）は自動でなく明示操作（docs/11「既読を参加/配送完了と混同しない」）。お知らせ（T046）と同じ流儀。
 */

export function NotificationsPage() {
  const location = useLocation();
  if (location.pathname === "/app/tasks-notifications/notifications/new") {
    // 同じパスへの再遷移（取消済みの「あらためて作成」など）でも作成 flow を初期状態で開き直すため
    // location.key を key にする（同一パスの再遷移ではReactが再マウントしないため）
    return <NotificationApproval key={location.key} mode="create" />;
  }
  const detailMatch = location.pathname.match(/^\/app\/tasks-notifications\/notifications\/([^/]+)$/);
  if (detailMatch) return <NotificationDetailRoute key={location.pathname} id={detailMatch[1]!} />;
  return <NotificationsTabPage />;
}

/** SCR-21の一覧（通知タブ／タスクタブ。?tab= をURLに持つ。戻る・再読込でタブが消えない） */
function NotificationsTabPage() {
  const { me } = useMe();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "tasks" ? "tasks" : "notifications";
  // PER-12は幹部・管理者が所属内で持つ（docs/10）。担当scopeの保持者は画面からは判定できないため作成入口は役割で出す
  const canManage = me.roles.includes("officer") || me.roles.includes("admin");

  const setTab = (next: "notifications" | "tasks") => {
    const params = new URLSearchParams(searchParams);
    if (next === "notifications") params.delete("tab");
    else params.set("tab", next);
    setSearchParams(params, { replace: true });
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <PageTitle
        eyebrow="2026 · TASKS & NOTIFICATIONS"
        className="lg:[&_h2]:hidden"
        right={
          <span aria-hidden="true" className="grid size-11 place-items-center rounded-full bg-white/[.06]">
            <Icon name="notifications" className="text-[21px] text-ink-muted" />
          </span>
        }
      >
        タスク・通知
      </PageTitle>

      {/* タブ（色＋下線で現在地を示す。docs/03 §1「色以外の形/文字」） */}
      <div role="tablist" aria-label="タスク・通知の切り替え" className="flex items-center gap-1">
        {([["notifications", "通知", "notifications"], ["tasks", "タスク", "task_alt"]] as const).map(([value, label, icon]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={
              "inline-flex min-h-11 items-center gap-1.5 rounded-pill px-4 text-[13px] font-bold transition " +
              (tab === value ? "bg-white/[.12] text-ink" : "text-ink-muted hover:bg-white/[.06]")
            }
          >
            <Icon name={icon} className="text-[17px]" />
            {label}
          </button>
        ))}
      </div>

      {tab === "tasks" ? (
        <TasksPanel />
      ) : (
        <NotificationsList canManage={canManage} />
      )}
    </div>
  );
}

/** 自分宛の通知の一覧（API-67。?unread=true=未読だけ。ホームの通知指標と同じ条件。docs/05 API-67） */
function NotificationsList({ canManage }: { canManage: boolean }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const unreadOnly = searchParams.get("unread") === "true";
  const [items, setItems] = useState<MyNotificationDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");

  // 再取得の起点は未読絞りだけ（依存配列に未読絞り以外を置かない。関数を毎レンダーで作って依存に置くと
  // 無限再取得になるため、クエリは効果の中で組み立てる。AnnouncementsPageと同じ構成）
  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    setPhase("loading");
    setItems([]);
    void (async () => {
      try {
        const res = await apiCall("API-67", {
          query: { limit: 50, ...(unreadOnly ? { unread: "true" } : {}) } as ApiInput<"API-67">["query"],
        }, { signal: ctrl.signal });
        if (!alive) return;
        setItems(res.data as unknown as MyNotificationDto[]);
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
  }, [unreadOnly]);

  const loadMore = async () => {
    if (!cursor) return;
    setPhase("loading");
    try {
      const res = await apiCall("API-67", {
        query: { limit: 50, ...(unreadOnly ? { unread: "true" } : {}), cursor } as ApiInput<"API-67">["query"],
      });
      setItems((prev) => [...prev, ...(res.data as unknown as MyNotificationDto[])]);
      setCursor(res.nextCursor ?? null);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  };

  const toggleUnread = () => {
    const next = new URLSearchParams(searchParams);
    if (unreadOnly) next.delete("unread");
    else next.set("unread", "true");
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* 未読だけ（ホームの通知指標と同じ条件。docs/05 API-28「countはその一覧の件数と必ず一致」） */}
        <button
          type="button"
          aria-pressed={unreadOnly}
          onClick={toggleUnread}
          className={
            "inline-flex min-h-11 items-center gap-1.5 rounded-pill px-4 text-[13px] font-bold " +
            (unreadOnly ? "bg-attention/[.16] text-attention" : "bg-white/[.06] text-ink-sub hover:bg-white/[.1]")
          }
        >
          <Icon name={unreadOnly ? "mark_email_unread" : "mark_email_read"} className="text-[17px]" />
          未読のみ
        </button>
        {canManage && (
          <Link
            to="/app/tasks-notifications/notifications/new"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-pill bg-white/[.08] px-4 text-[13px] font-bold text-ink"
          >
            <Icon name="add" className="text-[17px]" />
            通知を作成
          </Link>
        )}
      </div>

      {phase === "loading" && (
        <div className="flex flex-col gap-2">
          {[1, 2].map((n) => (
            <div key={n} className="h-20 animate-pulse rounded-[20px] bg-white/[.05]" />
          ))}
        </div>
      )}
      {phase === "error" && (
        <Banner tone="error" eyebrow="ERROR" role="alert" title="通知の一覧を取得できませんでした">
          通信を確認して、再読み込みしてください。
        </Banner>
      )}
      {phase === "ready" && items.length === 0 && (
        <Banner tone="info" eyebrow="EMPTY" title={unreadOnly ? "未読の通知はありません" : "自分宛の通知はまだありません"}>
          {unreadOnly ? "やることはすべて完了しています。" : "対象の通知が承認・送信されると、ここに現れます。"}
        </Banner>
      )}

      {/* prototype ホームのお知らせ欄と同じ行の構成（状態札・本文・日付・未読/既読） */}
      <ul className="flex flex-col gap-2" aria-label="自分宛の通知">
        {items.map((n) => (
          <li key={n.id}>
            <Link
              to={`/app/tasks-notifications/notifications/${n.id}`}
              className="flex items-center gap-3 rounded-[20px] bg-white/[.04] p-3.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,.07)] hover:bg-white/[.07]"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-2">
                  {n.myReadAt ? <Chip tone="neutral">既読</Chip> : <Chip tone="alert">未読</Chip>}
                  <MyDeliveryChip n={n} />
                </span>
                <span className="line-clamp-2 whitespace-pre-wrap text-[14px] font-bold leading-[1.5]">{n.body}</span>
                <span className="font-mono text-[11px] text-ink-muted">{fmtInstant(n.createdAt)}</span>
              </span>
              <Icon name="chevron_right" className="flex-none text-[20px] text-ink-dim" />
            </Link>
          </li>
        ))}
      </ul>

      {cursor && (
        <Button variant="secondary" busy={phase === "loading"} onClick={() => void loadMore()} className="max-lg:min-h-11">
          さらに読み込む
        </Button>
      )}
    </div>
  );
}

/** 自分の配送状態の札（myDelivery。docs/11 配送。受付≠到達≠既読を混同しない） */
function MyDeliveryChip({ n }: { n: MyNotificationDto }) {
  if (!n.myDelivery) return null;
  const s = n.myDelivery.status;
  if (s === "provider_accepted") return <Chip tone="ok">受付済み</Chip>;
  if (s === "unknown") return <Chip tone="attention">到達不明</Chip>;
  if (s === "failed" || s === "retry_wait") return <Chip tone="alert">失敗</Chip>;
  if (s === "cancelled") return <Chip tone="neutral">取消</Chip>;
  return null; // pending/sendingは未読/既読の札だけで足りる（画面を粗くしない）
}

/**
 * 通知の詳細（API-65）。応答は呼び出し者で投影が変わる: 送信者（PER-12）=全体（recipients・配送結果）、
 * 対象者=自分の分（本文・myReadAt・myDelivery）。実行値で区別して视图を出し分ける（docs/05 API-65）。
 */
function NotificationDetailRoute({ id }: { id: string }) {
  const names = useMemberNames();
  const [data, setData] = useState<NotificationDto | MyNotificationDto | "loading" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  useEffect(() => {
    let alive = true;
    setData("loading");
    void (async () => {
      try {
        const d = (await api("API-65", { params: { id } })) as unknown as NotificationDto | MyNotificationDto;
        if (alive) setData(d);
      } catch {
        if (alive) setData("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, reloadKey]);

  if (data === "loading" || names === null) {
    return (
      <div className="flex max-w-[720px] flex-col gap-3">
        <SubHeader backTo="/app/tasks-notifications" />
        <div className="h-40 animate-pulse rounded-card bg-white/[.05]" />
        <div className="h-24 animate-pulse rounded-card bg-white/[.05]" />
      </div>
    );
  }
  if (data === "error") {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <SubHeader backTo="/app/tasks-notifications" />
        <Banner tone="info" eyebrow="NOT FOUND" title="この通知は存在しないか、閲覧できません">
          <Link to="/app/tasks-notifications" className="underline">一覧へ戻る</Link>
        </Banner>
      </div>
    );
  }
  if (isSenderProjection(data)) return <SenderNotificationDetail initial={data} />;
  return <MyNotificationDetail data={data} names={names} onRead={reload} />;}

/**
 * 対象者としての通知の詳細。既読は「内容を確認」の明示操作（API-100。docs/11「既読は本人のみ」）。
 * 旧版（409）は最新を読み直して1回だけやり直す（承認・配送・既読で版が進むため。docs/16 T050）。
 */
function MyNotificationDetail({ data, onRead }: { data: MyNotificationDto; names: Map<string, string>; onRead: () => void }) {
  const read = useMutation("API-100");
  const [rereading, setRereading] = useState(false);

  const readNow = async () => {
    const r = await read.run({ params: { id: data.id }, body: { notificationVersion: data.version } });
    if (!r && read.state.kind === "conflict") {
      // 版が進んでいた（配送・既読の並行）。最新を読み直して同じ内容で1回だけやり直す
      setRereading(true);
      try {
        const latest = (await api("API-65", { params: { id: data.id } })) as unknown as MyNotificationDto;
        if (!latest.myReadAt) {
          await read.run({ params: { id: data.id }, body: { notificationVersion: latest.version } });
        }
      } catch {
        /* 再読込で拾う */
      }
      setRereading(false);
      onRead();
    }
    if (r) onRead();
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <SubHeader
        backTo="/app/tasks-notifications"
        right={data.myReadAt ? <Chip tone="ok">既読</Chip> : <Chip tone="alert">未読</Chip>}
      />

      <div className="flex flex-col gap-2 px-0.5">
        <span className="font-mono text-[11px] text-ink-muted">{fmtInstant(data.createdAt)}</span>
      </div>

      <Card className="flex flex-col gap-2">
        <p className="whitespace-pre-wrap text-[14px] font-medium leading-[1.7]">{data.body}</p>
      </Card>

      {/* 配送と既読は別（受付・到達不明は配送の記録、既読は本人の確認。docs/07 §5） */}
      {data.myDelivery?.status === "unknown" && (
        <Notice tone="warning" icon="help">
          この通知の宛先の結果が確認できていません（到達不明）。分からないままにせず、分団の幹部に確認してください。
        </Notice>
      )}

      {data.myReadAt ? (
        <Card className="flex items-center gap-2.5">
          <Chip tone="ok" icon="task_alt">既読</Chip>
          <span className="text-[13px] text-ink-sub">{fmtInstant(data.myReadAt)} に確認しました。</span>
        </Card>
      ) : (
        <Card className="flex flex-col gap-3" aria-label="この通知は未読です">
          <Notice tone="warning" icon="mark_email_unread">
            この通知は未読です。読んだら「内容を確認」を押してください（確認の記録は自分に付きます）。
          </Notice>
          <Button busy={read.saving || rereading} onClick={() => void readNow()}>
            内容を確認
          </Button>
        </Card>
      )}
      <MutationStatus state={read.state.kind === "saved" ? read.state : { kind: "idle" }} toastBottom={100} />

      <p className="text-[12px] text-ink-muted">
        受付や配送の記録と、自分の確認（既読）は別のものとして扱われます（docs/11「受付≠到達≠既読」）。
      </p>
    </div>
  );
}
