import { useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { api, apiCall, type ApiInput } from "../../api";
import { ConfirmDialog } from "../../components/Overlay";
import { MutationStatus } from "../../components/MutationStatus";
import { PageTitle, SubHeader } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, Notice, TextArea } from "../../components/ui";
import { initialOf, useMe } from "../../me";
import { useMutation } from "../../useMutation";
import type { AnnouncementDto } from "../../../shared/contracts/content";
import { fmtDay, fmtInstant } from "../activities/time";
import { AttachmentUploader } from "../attachments/AttachmentUploader";
import { ANNOUNCEMENT_STATUS, AnnouncementEditor, loadAnnouncement } from "./AnnouncementEditor";

/**
 * お知らせ（T046、SCR-16。prototypeでは予告ページのため共通部品で構成。docs/03 SCR-16の節を参照）。
 * 一覧（API-24。publishedは対象者だけ、draftはPER-03保持者、archivedは対象者＋PER-03保持者に現れる）、
 * 詳細（公開先・公開日時・版・添付。対象者は明示操作で本人既読API-66）、
 * 作成・編集（AnnouncementEditor。API-25/72）を同じSCRの別入口で扱う。
 */

/** 名前の対応（API-02。対象者・作成者の表示）。ActivityPageと同じく読み込み中はIDを出さない */
function useMemberNames(): Map<string, string> | null {
  const [names, setNames] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = (await api("API-02", { query: { limit: 200 } })) as unknown as { id: string; displayName: string }[];
        if (alive) setNames(new Map(rows.map((r) => [r.id, r.displayName])));
      } catch {
        if (alive) setNames(new Map());
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return names;
}

/** SCR-16の別入口（/app/announcements、/new、/:id/edit、/:id）。パスで一覧/詳細/フォームを出し分ける */
export function AnnouncementsPage() {
  const params = useParams<{ id?: string }>();
  const location = useLocation();
  if (location.pathname === "/app/announcements/new") return <AnnouncementEditor mode="create" />;
  if (params.id && location.pathname.endsWith("/edit")) return <AnnouncementEditor mode="edit" id={params.id} />;
  if (params.id) return <AnnouncementDetail id={params.id} />;
  return <AnnouncementList />;
}

/** 一覧（SCR-16）。状態はURLクエリにもつ（?status=。戻る・再読込で絞り込みが消えない） */
function AnnouncementList() {
  const { me } = useMe();
  const names = useMemberNames();
  /** PER-03は幹部・管理者が所属内で持つ（docs/10）。担当scopeの保持者は画面からは判定できないためサーバーが拒否する */
  const canManage = me.roles.includes("officer") || me.roles.includes("admin");
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get("status") ?? "";

  const [items, setItems] = useState<AnnouncementDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");

  const query = (): Partial<ApiInput<"API-24">["query"]> => ({
    limit: 50,
    ...(status ? { status: status as AnnouncementDto["status"] } : {}),
  });

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    setPhase("loading");
    setItems([]);
    void (async () => {
      try {
        const res = await apiCall("API-24", { query: query() as ApiInput<"API-24">["query"] }, { signal: ctrl.signal });
        if (!alive) return;
        setItems(res.data as unknown as AnnouncementDto[]);
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
  }, [status]);

  const loadMore = async () => {
    if (!cursor) return;
    setPhase("loading");
    try {
      const res = await apiCall("API-24", { query: { ...query(), cursor } as ApiInput<"API-24">["query"] });
      setItems((prev) => [...prev, ...(res.data as unknown as AnnouncementDto[])]);
      setCursor(res.nextCursor ?? null);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  };

  const setParam = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "") next.delete("status");
    else next.set("status", value);
    setSearchParams(next, { replace: true });
  };

  const nameOf = (id: string | null) => (id ? (names?.get(id) ?? null) : null);

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <PageTitle
        eyebrow="2026 · ANNOUNCEMENTS"
        className="lg:[&_h2]:hidden"
        right={
          <span aria-hidden="true" className="grid size-11 place-items-center rounded-full bg-white/[.06]">
            <Icon name="campaign" className="text-[21px] text-ink-muted" />
          </span>
        }
      >
        お知らせ
      </PageTitle>

      <div className="flex flex-wrap items-center gap-2">
        <label className="hairline flex h-[46px] items-center gap-2 rounded-field bg-white/[.06] px-4">
          <span className="text-[12px] font-bold text-ink-sub">状態</span>
          <select
            aria-label="状態で絞る"
            value={status}
            onChange={(e) => setParam(e.target.value)}
            className="min-w-0 border-none bg-transparent text-[14px] font-medium text-ink outline-none"
          >
            <option value="">すべて</option>
            {Object.entries(ANNOUNCEMENT_STATUS).map(([value, meta]) => (
              <option key={value} value={value}>
                {meta.label}
              </option>
            ))}
          </select>
        </label>
        {canManage && (
          <Link
            to="/app/announcements/new"
            className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-pill bg-white/[.08] px-4 text-[13px] font-bold text-ink"
          >
            <Icon name="add" className="text-[17px]" />
            お知らせを作成
          </Link>
        )}
      </div>

      {phase === "loading" && (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-20 animate-pulse rounded-[20px] bg-white/[.05]" />
          ))}
        </div>
      )}
      {phase === "error" && (
        <Banner tone="error" eyebrow="ERROR" role="alert" title="お知らせの一覧を取得できませんでした">
          通信を確認して、再読み込みしてください。
        </Banner>
      )}
      {phase === "ready" && items.length === 0 && (
        <Banner tone="info" eyebrow="EMPTY" title="お知らせはまだありません">
          {canManage ? "「お知らせを作成」から作ってください。" : "対象のお知らせが公開されたら、ここに現れます。"}
        </Banner>
      )}

      {/* prototype ホームのお知らせ欄と同じ行の構成（札・題・作成者と日付・既読） */}
      <ul className="flex flex-col gap-2">
        {items.map((a) => {
          const meta = ANNOUNCEMENT_STATUS[a.status];
          const author = nameOf(a.createdByMemberId);
          return (
            <li key={a.id}>
              <Link
                to={`/app/announcements/${a.id}`}
                className="flex items-center gap-3 rounded-[20px] bg-white/[.04] p-3.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,.07)] hover:bg-white/[.07]"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex items-center gap-2">
                    <Chip tone={meta.tone}>{meta.label}</Chip>
                    <span className="font-mono text-[11px] text-ink-muted">第{a.revisionNo}版</span>
                    {a.readAt && <Chip tone="ok">既読</Chip>}
                  </span>
                  <span className="truncate text-[15px] font-bold">{a.title}</span>
                  <span className="truncate font-mono text-[11px] text-ink-muted">
                    {author ?? "読み込み中…"} · {a.publishedAt ? fmtDay(a.publishedAt) : "公開前"}
                  </span>
                </span>
                <Icon name="chevron_right" className="flex-none text-[20px] text-ink-dim" />
              </Link>
            </li>
          );
        })}
      </ul>

      {cursor && (
        <Button variant="secondary" busy={phase === "loading"} onClick={() => void loadMore()} className="max-lg:min-h-11">
          さらに読み込む
        </Button>
      )}
    </div>
  );
}

/** お知らせの1件の表示。対象者は「内容を確認」の明示操作で既読（API-66。docs/11「既読は版に束縛」） */
function AnnouncementDetail({ id }: { id: string }) {
  const { me } = useMe();
  const names = useMemberNames();
  const canManage = me.roles.includes("officer") || me.roles.includes("admin");
  const [detail, setDetail] = useState<AnnouncementDto | "loading" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<AnnouncementDto["attachments"][number] | null>(null);
  const [unlinkReason, setUnlinkReason] = useState("");

  const publish = useMutation("API-72");
  const archive = useMutation("API-72");
  const read = useMutation("API-66");
  const unlink = useMutation("API-101");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = await loadAnnouncement(id);
        if (alive) setDetail(data);
      } catch {
        if (alive) setDetail("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, reloadKey]);

  const nameOf = (memberId: string | null) => (memberId ? (names?.get(memberId) ?? null) : null);

  if (detail === "loading" || names === null) {
    return (
      <div className="flex max-w-[720px] flex-col gap-3">
        <SubHeader backTo="/app/announcements" />
        <div className="h-40 animate-pulse rounded-card bg-white/[.05]" />
        <div className="h-64 animate-pulse rounded-card bg-white/[.05]" />
      </div>
    );
  }
  if (detail === "error") {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <SubHeader backTo="/app/announcements" />
        <Banner tone="info" eyebrow="NOT FOUND" title="このお知らせは存在しないか、閲覧できません">
          <Link to="/app/announcements" className="underline">
            一覧へ戻る
          </Link>
        </Banner>
      </div>
    );
  }

  const meta = ANNOUNCEMENT_STATUS[detail.status];
  // 対象者ID一覧は管理権限（PER-03）の応答にだけ載る。対象者の応答では省略されるため
  // 「公開済なら閲覧できる＝対象者」と可視性の規則で代替する（docs/05 §1。一覧は対象者だけに現れる）
  const inAudience = detail.audienceMemberIds
    ? detail.audienceMemberIds.includes(me.profile.memberId)
    : detail.status !== "draft";
  const readyAttachments = detail.attachments.filter((a) => a.status === "ready");

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <SubHeader backTo="/app/announcements" right={<Chip tone={meta.tone}>{meta.label}</Chip>} />

      <div className="flex flex-col gap-2 px-0.5">
        <span className="flex items-center gap-2 font-mono text-[11px] text-ink-muted">
          第{detail.revisionNo}版
          {detail.readAt && <Chip tone="ok">既読</Chip>}
        </span>
        <h2 className="text-[26px] font-bold leading-[1.3]">{detail.title}</h2>
        <p className="font-mono text-[11px] text-ink-muted">
          {nameOf(detail.createdByMemberId) ?? "読み込み中…"}
          {detail.publishedAt ? ` · ${fmtDay(detail.publishedAt)}` : ""}
        </p>
      </div>

      {/* 公開先・公開日時・版（docs/03 SCR-16。対象は現行版のsnapshot） */}
      <Card className="flex flex-col gap-0 overflow-hidden p-0">
        <InfoRow icon="person">作成者 {nameOf(detail.createdByMemberId) ?? "読み込み中…"}</InfoRow>
        <InfoRow icon="event" mono>
          {detail.status === "draft"
            ? detail.publishedAt
              ? `公開予定 ${fmtInstant(detail.publishedAt)}`
              : "公開日時 未設定（公開操作のときに記録）"
            : `公開日時 ${fmtInstant(detail.publishedAt ?? "")}`}
        </InfoRow>
        <InfoRow icon="groups">
          {/* 公開先の一覧は管理権限（PER-03）の応答にだけ載る。対象者の詳細では省略（docs/05 §1） */}
          {detail.audienceMemberIds && (
            <>
              公開先 {detail.audienceMemberIds.length}人
              <span className="mt-1 flex flex-wrap gap-1">
                {detail.audienceMemberIds.map((memberId) => (
                  <span key={memberId} className="inline-flex items-center gap-1.5 rounded-pill bg-white/[.06] px-2 py-0.5 text-[12px] font-medium">
                    <span aria-hidden="true" className="grid size-5 place-items-center rounded-full bg-[#1a2740] text-[9px] font-bold text-[#c3cad6]">
                      {initialOf(nameOf(memberId) ?? "?")}
                    </span>
                    {nameOf(memberId) ?? "読み込み中…"}
                    {memberId === me.profile.memberId && <span className="text-[11px] text-ink-muted">（自分）</span>}
                  </span>
                ))}
              </span>
            </>
          )}
        </InfoRow>
      </Card>

      {/* 本文（現行版。旧版は契約に読み取り経路が無いため表示しない。docs/03に記録） */}
      <Card className="flex flex-col gap-2">
        <p className="whitespace-pre-wrap text-[14px] font-medium leading-[1.7]">{detail.body}</p>
      </Card>

      {/* 添付（対象者に見える形で表示。追加・解除は編集権の保持者。解除は理由必須のAPI-101） */}
      <section className="flex flex-col gap-2" aria-label="添付">
        <h3 className="text-[14px] font-bold">添付</h3>
        {readyAttachments.length === 0 && <p className="text-[13px] text-ink-muted">添付はまだありません。</p>}
        {readyAttachments.length > 0 && (
          <ul className="flex flex-col gap-2">
            {readyAttachments.map((a, i) => (
              <li key={a.linkId} className="hairline flex items-center gap-3 rounded-card bg-white/[.04] p-2.5">
                {a.contentType.startsWith("image/") ? (
                  <img
                    src={`/api/v1/attachments/${a.id}/content`}
                    alt={`お知らせの添付${i + 1}`}
                    className="size-20 flex-none rounded-[12px] object-cover"
                    loading="lazy"
                  />
                ) : (
                  <a
                    href={`/api/v1/attachments/${a.id}/content`}
                    className="hairline flex min-h-11 flex-1 items-center gap-2 rounded-field bg-white/[.05] px-3 text-[13px] font-bold underline"
                  >
                    <Icon name="draft" className="text-[19px] text-ink-muted" />
                    添付ファイル{i + 1}（画像以外は保存されます）
                  </a>
                )}
                {canManage && (
                  <Button
                    variant="secondary"
                    className="!h-[46px] !w-auto flex-none px-4 !text-[13px] max-lg:min-h-11"
                    onClick={() => {
                      setUnlinkReason("");
                      setUnlinkTarget(a);
                    }}
                  >
                    外す
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <div className="flex flex-col gap-1">
            <AttachmentUploader target={{ type: "announcement", id }} onReady={(ids) => { if (ids.length > 0) setReloadKey((k) => k + 1); }} />
            <p className="text-[12px] text-ink-muted">検査の済んだ添付は、このお知らせが見える対象者に表示されます。</p>
          </div>
        )}
      </section>

      {/* 本人既読（対象者だけ。自動でなく明示操作。docs/11「既読を参加/配送完了と混同しない」） */}
      {inAudience && detail.status === "published" && (
        detail.readAt ? (
          <Card className="flex items-center gap-2.5">
            <Chip tone="ok" icon="task_alt">
              既読
            </Chip>
            <span className="text-[13px] text-ink-sub">第{detail.revisionNo}版を {fmtInstant(detail.readAt)} に確認しました。</span>
          </Card>
        ) : (
          <Card className="flex flex-col gap-3" aria-label="この版は未確認">
            <Notice tone="warning" icon="mark_email_unread">
              この版は未確認です。読んだら「内容を確認」を押してください（確認の記録は版ごとに付きます）。
            </Notice>
            <Button busy={read.saving} onClick={() => void read.run({ params: { id }, body: { revisionNo: detail.revisionNo } }).then((r) => { if (r) setReloadKey((k) => k + 1); })}>
              内容を確認
            </Button>
          </Card>
        )
      )}
      {inAudience && detail.status === "draft" && (
        <Notice tone="info" icon="visibility_off">
          これは下書きです。公開すると対象者の一覧に現れます。
        </Notice>
      )}
      <MutationStatus state={read.state} toastBottom={100} />

      {/* 管理の操作（PER-03。公開と終了はdocs/11の遷移辺。公開は確認ダイアログで公開先を見てから） */}
      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          {detail.status === "draft" && (
            <Button busy={publish.saving} className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={() => setConfirmPublish(true)}>
              公開する
            </Button>
          )}
          {detail.status !== "archived" && (
            <Link
              to={`/app/announcements/${id}/edit`}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-pill bg-white/[.08] px-4 text-[13px] font-bold text-ink"
            >
              編集
            </Link>
          )}
          {detail.status === "published" && (
            <Button variant="secondary" busy={archive.saving} className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={() => setConfirmArchive(true)}>
              終了する
            </Button>
          )}
        </div>
      )}
      {detail.status === "archived" && (
        <Notice tone="info" icon="lock">
          終了したお知らせです。変更はできません（記録は残ります）。
        </Notice>
      )}
      <MutationStatus state={publish.state} toastBottom={100} />
      <MutationStatus state={archive.state} toastBottom={100} />
      <MutationStatus state={unlink.state} toastBottom={100} />

      {/* 通知依頼の導線は後続の通知タスク（PH4）で接続するため無効表示（docs/03に記録） */}
      {canManage && (
        <Notice tone="ai" icon="notifications_paused">
          対象者への通知の依頼は、通知機能（後のフェーズ）で接続されます。現時点では一覧とホームのお知らせ欄から読めます。
        </Notice>
      )}

      {/* 公開（API-72 status=published。理由欄は契約に無いため確認だけ。公開先を見てから行う） */}
      {confirmPublish && (
        <ConfirmDialog
          title="このお知らせを公開しますか"
          confirmLabel="公開する"
          busy={publish.saving}
          onConfirm={async () => {
            const r = await publish.run({ params: { id }, body: { version: detail.version, status: "published" } });
            if (r) {
              setConfirmPublish(false);
              setReloadKey((k) => k + 1);
            }
          }}
          onCancel={() => setConfirmPublish(false)}
        >
          <p>公開すると対象者の一覧に現れ、対象者は本文の確認（既読）を求められます。公開後も編集できますが、その場合は新しい版になります。</p>
          <div className="hairline rounded-card bg-white/[.04] p-3">
            {/* 公開確認は管理権限（PER-03）専用なので対象者一覧は必ず載る（docs/05 §1） */}
            <h3 className="text-[13px] font-bold">公開先（{(detail.audienceMemberIds ?? []).length}人）</h3>
            <ul className="mt-1.5 flex flex-col gap-1">
              {(detail.audienceMemberIds ?? []).map((memberId) => (
                <li key={memberId} className="text-[13px] font-medium">
                  {nameOf(memberId) ?? "読み込み中…"}
                  {memberId === me.profile.memberId && <span className="ml-1 text-[11px] text-ink-muted">（自分）</span>}
                </li>
              ))}
            </ul>
          </div>
        </ConfirmDialog>
      )}

      {/* 終了（published→archived。archivedは終端で以後変更できない。docs/11 お知らせ） */}
      {confirmArchive && (
        <ConfirmDialog
          title="このお知らせの掲載を終了しますか"
          confirmLabel="終了する"
          busy={archive.saving}
          danger
          onConfirm={async () => {
            const r = await archive.run({ params: { id }, body: { version: detail.version, status: "archived" } });
            if (r) {
              setConfirmArchive(false);
              setReloadKey((k) => k + 1);
            }
          }}
          onCancel={() => setConfirmArchive(false)}
        >
          <p>「{detail.title}」の掲載を終了します。終了すると対象者の新一覧には現れず、以後は変更できません（記録と監査は残ります）。</p>
        </ConfirmDialog>
      )}

      {/* 添付の解除（API-101。理由必須。linkはtombstoneとして残る） */}
      {unlinkTarget && (
        <ConfirmDialog
          title="この添付を外しますか"
          confirmLabel="外す"
          busy={unlink.saving}
          danger
          confirmDisabled={!unlinkReason.trim()}
          onConfirm={async () => {
            const r = await unlink.run({
              params: { id: unlinkTarget.id, linkId: unlinkTarget.linkId },
              body: { version: unlinkTarget.linkVersion, reason: unlinkReason.trim() },
            });
            if (r) {
              setUnlinkTarget(null);
              setUnlinkReason("");
              setReloadKey((k) => k + 1);
            }
          }}
          onCancel={() => {
            setUnlinkTarget(null);
            setUnlinkReason("");
          }}
        >
          <p>外した添付は対象者に見えなくなります（リンクの記録と理由は残ります）。追加しなおすには、もう一度アップロードしてください。</p>
          <TextArea name="unlink-reason" label="外す理由（必須）" value={unlinkReason} onChange={(e) => setUnlinkReason(e.target.value)} />
          {!unlinkReason.trim() && <p className="text-[12px] font-medium text-attention">理由を入力してください</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}

/** 情報カードの1行（ActivityPageのInfoRowと同じprototype語彙：アイコン＋14px） */
function InfoRow({ icon, mono, children }: { icon: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-white/[.06] px-4 py-3.5 last:border-b-0">
      <span aria-hidden="true" className="ms mt-0.5 text-[20px] text-ink-muted">
        {icon}
      </span>
      <div className={`min-w-0 flex-1 text-[14px] font-medium ${mono ? "font-mono" : ""}`}>{children}</div>
    </div>
  );
}
