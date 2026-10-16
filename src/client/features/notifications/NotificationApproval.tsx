import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, type ApiInput } from "../../api";
import { ConfirmDialog } from "../../components/Overlay";
import { MutationStatus } from "../../components/MutationStatus";
import { SubHeader } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, Notice, TextArea } from "../../components/ui";
import { initialOf } from "../../me";
import { useMutation } from "../../useMutation";
import type { MyNotificationDto, NotificationDto } from "../../../shared/contracts/content";
import { LeaveConfirm } from "../../components/LeaveConfirm";
import { fmtInstant } from "../activities/time";
import type { MemberNameMap } from "./names";
import { useMemberNames } from "./names";

/**
 * 通知の作成と承認（T052、SCR-21の通知タブ。docs/03 SCR-21「通知draft/本文/対象/承認/配送失敗」）。
 *
 * 作成は一方向の流れで行う（docs/03 §1.1-14）:
 *  ①源の選択（未回答者抽出=activity／お知らせ=announcement。点検期限=inspection_dueは検出行の一覧を
 *    読むAPIが無いため入口を無効表示にして到達できない操作を出さない）
 *  ②本文/対象/人数の編集（対象は源からの提案を初期値にする。activityはAPI-07の対象snapshot−回答ありで
 *    画面が先に数えるだけの案内値で、作成時にサーバーが取り直す）
 *  ③下書きを作成（API-63）→承認前確認（本文・対象・人数。対象の変更は新しい下書きになる旨の注記）
 *  ④承認（API-64 approve。送信確認ダイアログで本文・対象・人数を明示。202=配送jobの受付で完了ではない）
 *    または取消（API-64 cancel。draft→cancelled）
 *  ⑤配送結果（API-65のrecipients。受付済み/失敗/到達不明/取消を別表示。docs/11「受付≠到達≠既読」）。
 *    到達不明は「結果を確認」で対象を開く。未送分の取消（cancel_unsent）は対象を明示してから行う。
 *
 * 既知の制限（docs/03 §1.1-14に記録）: 承認せずに離れた下書きは、送信者の一覧を読むAPIが無いため
 * この画面に戻れない（未承認のまま配送されず、対象者にも見えない。入力途中の離脱はLeaveConfirmで確認する）。
 */

/** 配送状態の表示語彙（docs/11 配送。色はDesign Systemの状態トークン。受付≠到達≠既読を混同しない） */
export const DELIVERY_LABEL: Record<string, { label: string; tone: "ok" | "attention" | "alert" | "neutral" }> = {
  provider_accepted: { label: "受付済み", tone: "ok" },
  failed: { label: "失敗", tone: "alert" },
  retry_wait: { label: "失敗（再送待ち）", tone: "alert" },
  unknown: { label: "到達不明", tone: "attention" },
  cancelled: { label: "取消", tone: "neutral" },
  pending: { label: "送信待ち", tone: "neutral" },
  sending: { label: "送信中", tone: "neutral" },
};
/** 未知・未確定の配送状態の既定表示（pending。noUncheckedIndexedAccessのため実体を別に持つ） */
const DELIVERY_PENDING = { label: "送信待ち", tone: "neutral" as const };

/** 送信者投影（Notification）か対象者投影（MyNotification）かを実行値で区別する（API-65は呼び出し者で投影が変わる） */
export const isSenderProjection = (data: NotificationDto | MyNotificationDto): data is NotificationDto =>
  "bodyHash" in data;

export function NotificationApproval({ mode }: { mode: "create" }) {
  const [step, setStep] = useState<"source" | "confirm">("source");
  // 別画面からの導線（?source=announcement|activity&id=<源のID>。お知らせ詳細・活動詳細から。docs/03 §1.1-14）
  const [searchParams] = useSearchParams();
  const [sourceType, setSourceType] = useState<"activity" | "announcement">(
    searchParams.get("source") === "announcement" ? "announcement" : "activity",
  );
  const [sourceId, setSourceId] = useState(searchParams.get("id") ?? "");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<Set<string>>(new Set());
  const [touched, setTouched] = useState(false);
  const [options, setOptions] = useState<{ activities: { id: string; title: string }[]; announcements: { id: string; title: string; body: string; status: string; audienceMemberIds?: string[] }[] }>({ activities: [], announcements: [] });
  const [draft, setDraft] = useState<NotificationDto | null>(null);
  const [formErrors, setFormErrors] = useState<{ field: string; reason: string }[]>([]);
  const [dialogKind, setDialogKind] = useState<"approve" | "cancel" | null>(null);
  const names = useMemberNames();

  const create = useMutation("API-63");
  const approval = useMutation("API-64");

  // 源の候補。activity=これからの予定（status=scheduled・開始>=現在。API-28の次回予定と同じ条件）、
  // announcement=自分が管理できるお知らせ（draft含む。PER-03保持者の一覧）
  useEffect(() => {
    let alive = true;
    void (async () => {
      const nowIso = new Date().toISOString();
      try {
        const [acts, anns] = await Promise.all([
          api("API-05", { query: { status: "scheduled", from: nowIso, limit: 200 } as ApiInput<"API-05">["query"] }).catch(() => []),
          api("API-24", { query: { limit: 200 } as ApiInput<"API-24">["query"] }).catch(() => []),
        ]);
        if (!alive) return;
        setOptions({
          activities: (acts as unknown as { id: string; title: string }[]).map((a) => ({ id: a.id, title: a.title })),
          announcements: (anns as unknown as { id: string; title: string; body: string; status: string; audienceMemberIds?: string[] }[])
            .filter((a) => a.status === "draft" || a.status === "published"),
        });
      } catch {
        if (alive) setOptions({ activities: [], announcements: [] });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 源からの提案（body/対象の初期値。API-63に渡す前の編集用。docs/16 T050「源からの既定値提案」の画面側）。
  // activityの未回答抽出は画面が先に数える案内値（対象snapshot−回答あり。T036/T047と同じ規則）で、
  // 作成時にサーバーがauthoritativeに取り直す
  useEffect(() => {
    if (!sourceId) return;
    let alive = true;
    void (async () => {
      if (sourceType === "activity") {
        try {
          const detail = (await api("API-07", { params: { id: sourceId } })) as unknown as {
            title: string; audience: string[]; attendance: { memberId: string; response: string }[];
          };
          if (!alive) return;
          const answered = new Set(detail.attendance.filter((r) => r.response !== "unanswered").map((r) => r.memberId));
          const proposal = detail.audience.filter((id) => !answered.has(id));
          setBody(`${detail.title}の出欠確認です。参加可否を予定ページから回答してください。`);
          setAudience(new Set(proposal));
          setTouched(false);
        } catch {
          if (alive) setAudience(new Set());
        }
      } else {
        const found = options.announcements.find((a) => a.id === sourceId);
        if (found && alive) {
          setBody(`${found.title}\n${found.body}`);
          setAudience(new Set(found.audienceMemberIds ?? []));
          setTouched(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [sourceId, sourceType, options.announcements]);

  const createDraft = async () => {
    const errors: { field: string; reason: string }[] = [];
    if (!sourceId) errors.push({ field: "source", reason: "源を選択してください" });
    if (!body.trim()) errors.push({ field: "body", reason: "本文を入力してください" });
    if (audience.size === 0) errors.push({ field: "audienceMemberIds", reason: "対象者を1人以上選んでください" });
    setFormErrors(errors);
    if (errors.length > 0) return;
    const r = await create.run({
      body: {
        source: { type: sourceType, id: sourceId },
        body: body,
        audienceMemberIds: [...audience],
        channels: ["inapp"],
      },
    });
    if (r) {
      setDraft(r.data as unknown as NotificationDto);
      setStep("confirm");
    }
  };

  if (step === "confirm" && draft) {
    return (
      <ConfirmStep
        draft={draft}
        names={names}
        approvalState={approval.state}
        approvalSaving={approval.saving}
        runApproval={async (decision) => {
          const r = await approval.run({
            params: { id: draft.id },
            body:
              decision === "approve"
                ? { version: draft.version, bodyHash: draft.bodyHash, audienceHash: draft.audienceHash, decision }
                : { version: draft.version, decision },
          });
          return r ? (r.data as unknown as NotificationDto) : null;
        }}
        onApprove={() => setDialogKind("approve")}
        onCancel={() => setDialogKind("cancel")}
        dialogKind={dialogKind}
        onDialogClose={() => setDialogKind(null)}
        onApproved={(updated) => {
          setDialogKind(null);
          setDraft(updated);
        }}
        onCancelled={(updated) => {
          setDialogKind(null);
          setDraft(updated);
        }}
      />
    );
  }

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      {/* 下書きは人が作る通知の状態のため中立（紫=AI由来だけ。Design System原則③。お知らせの下書きと同じ。PH4レビューC 低2） */}
      <SubHeader
        title="通知を作成"
        sub="対象者への連絡を下書きとして作り、確認してから承認（送信）します"
        backTo="/app/tasks-notifications"
        right={<Chip tone="neutral" icon="campaign">下書き</Chip>}
      />

      <Card className="flex flex-col gap-4">
        <label className="flex flex-col gap-2">
          <span className="text-[12px] font-bold text-ink-sub">通知の源</span>
          <select
            aria-label="通知の源"
            value={sourceType}
            onChange={(e) => {
              setTouched(true);
              setSourceType(e.target.value as "activity" | "announcement");
              setSourceId("");
            }}
            className="hairline h-[54px] rounded-field bg-white/[.06] px-4 text-[14px] font-medium text-ink outline-none"
          >
            <option value="activity">未回答者抽出（予定の出欠）</option>
            <option value="announcement">お知らせの内容を通知</option>
            {/* 点検期限（inspection_due）は検出行の一覧を読むAPIが無いため入口を出さない（docs/03 §1.1-14） */}
          </select>
        </label>

        {sourceType === "activity" ? (
          <label className="flex flex-col gap-2">
            <span className="text-[12px] font-bold text-ink-sub">抽出する予定（これからの予定。未回答の人だけが対象になります）</span>
            <select
              aria-label="抽出する予定"
              value={sourceId}
              onChange={(e) => {
                setTouched(true);
                setSourceId(e.target.value);
              }}
              className="hairline h-[54px] rounded-field bg-white/[.06] px-4 text-[14px] font-medium text-ink outline-none"
            >
              <option value="">選んでください</option>
              {options.activities.map((a) => (
                <option key={a.id} value={a.id}>{a.title}</option>
              ))}
            </select>
          </label>
        ) : (
          <label className="flex flex-col gap-2">
            <span className="text-[12px] font-bold text-ink-sub">通知するお知らせ</span>
            <select
              aria-label="通知するお知らせ"
              value={sourceId}
              onChange={(e) => {
                setTouched(true);
                setSourceId(e.target.value);
              }}
              className="hairline h-[54px] rounded-field bg-white/[.06] px-4 text-[14px] font-medium text-ink outline-none"
            >
              <option value="">選んでください</option>
              {options.announcements.map((a) => (
                <option key={a.id} value={a.id}>{a.title}</option>
              ))}
            </select>
          </label>
        )}

        <TextArea
          name="body"
          label="本文"
          value={body}
          onChange={(e) => {
            setTouched(true);
            setBody(e.target.value);
          }}
        />

        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-bold text-ink-sub">対象者（{audience.size}人。このメンバーで固定されます）</span>
          <ul className="flex flex-col gap-1">
            {[...audience].map((memberId) => (
              <li key={memberId} className="hairline flex min-h-11 items-center gap-3 rounded-xl bg-white/[.04] px-3">
                <span aria-hidden="true" className="grid size-7 flex-none place-items-center rounded-full bg-[#1a2740] text-[11px] font-bold text-[#c3cad6]">
                  {initialOf(names?.get(memberId) ?? "?")}
                </span>
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{names?.get(memberId) ?? "読み込み中…"}</span>
                <button
                  type="button"
                  aria-label={`${names?.get(memberId) ?? "対象者"}を外す`}
                  className="grid size-11 place-items-center rounded-full text-ink-muted hover:bg-white/[.06]"
                  onClick={() => {
                    setTouched(true);
                    setAudience((prev) => {
                      const next = new Set(prev);
                      next.delete(memberId);
                      return next;
                    });
                  }}
                >
                  <Icon name="close" className="text-[17px]" />
                </button>
              </li>
            ))}
            {audience.size === 0 && <li className="text-[12px] text-ink-muted">対象者がいません。源を選びなおすか、別の源をお試しください。</li>}
          </ul>
        </div>

        {formErrors.length > 0 && (
          <Banner tone="error" eyebrow="ERROR" role="alert" title="入力内容を確認してください">
            <ul className="list-inside list-disc">
              {formErrors.map((e) => (
                <li key={e.field}>{e.reason}</li>
              ))}
            </ul>
          </Banner>
        )}

        <Notice tone="info" icon="info">
          下書きの段階では誰にも届きません。承認（送信）は次の画面で、本文と対象を確認してから行います。
        </Notice>
        <Button busy={create.saving} onClick={() => void createDraft()}>
          {create.state.kind === "processing" ? "処理中（完了ではありません）" : "下書きを作成"}
        </Button>
        {/* 成功（saved/processing）だけでなく失敗（conflict/rejected/forbidden/unknown等）も通す。
            潰すと409・通信断のときダイアログが開いたまま無反応になり、成否の区別が付かない（docs/03 §1「conflictを区別」。
            失敗時はダイアログが開いたまま、既存の表示語彙の案内が出る） */}
        <MutationStatus state={create.state} toastBottom={100} />
      </Card>
      {/* 未保存の離脱は確認ダイアログ（docs/03 §1「未保存の離脱」。下書きを作成したあとは保存済みのため出ない） */}
      <LeaveConfirm dirty={touched} />
    </div>
  );
}

/** 承認前確認＋配送結果（create modeの後半。docs/03「本文/対象/人数の承認前確認→承認→取消→配送結果」） */
function ConfirmStep({
  draft, names, approvalState, approvalSaving, runApproval, onApprove, onCancel, dialogKind, onDialogClose, onApproved, onCancelled,
}: {
  draft: NotificationDto;
  names: MemberNameMap | null;
  approvalState: ReturnType<typeof useMutation<"API-64">>["state"];
  approvalSaving: boolean;
  /** 確認ダイアログの実行（API-64。decisionはapprove/cancel。docs/11 通知承認）。成功時に最新の通知を返す */
  runApproval: (decision: "approve" | "cancel") => Promise<NotificationDto | null>;
  onApprove: () => void;
  onCancel: () => void;
  /** 開いている確認ダイアログ（approve=送信確認／cancel=下書き取消。docs/03「送信確認ダイアログで本文・対象・人数を明示」） */
  dialogKind: "approve" | "cancel" | null;
  onDialogClose: () => void;
  onApproved: (updated: NotificationDto) => void;
  onCancelled: (updated: NotificationDto) => void;
}) {
  const audienceIds = draft.audienceMemberIds ?? [];
  const cancelled = draft.status === "cancelled";
  const approvable = draft.status === "draft";

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <SubHeader
        title="通知の承認前確認"
        sub="本文と対象を確認してから承認（送信）します"
        backTo="/app/tasks-notifications"
        right={<Chip tone={cancelled || approvable ? "neutral" : "ok"}>{cancelled ? "取消済み" : approvable ? "下書き" : "承認済み"}</Chip>}
      />

      <section aria-label="承認前の確認" className="flex flex-col gap-3">
        <Card className="flex flex-col gap-3">
          <p className="whitespace-pre-wrap text-[14px] font-medium leading-[1.7]">{draft.body}</p>
        </Card>
        <Card className="flex flex-col gap-2 p-0">
          <div className="flex items-center justify-between border-b border-white/[.06] px-4 py-3.5">
            <span className="flex items-center gap-2 text-[14px] font-medium">
              <Icon name="groups" className="text-[20px] text-ink-muted" />
              対象者（{audienceIds.length}人）
            </span>
            <span className="font-mono text-[11px] text-ink-muted">{draft.channels.join(" / ")}</span>
          </div>
          <ul className="flex flex-wrap gap-1.5 px-4 pb-3.5">
            {audienceIds.map((memberId) => (
              <li key={memberId} className="inline-flex items-center gap-1.5 rounded-pill bg-white/[.06] px-2 py-0.5 text-[12px] font-medium">
                <span aria-hidden="true" className="grid size-5 place-items-center rounded-full bg-[#1a2740] text-[9px] font-bold text-[#c3cad6]">
                  {initialOf(names?.get(memberId) ?? "?")}
                </span>
                {names?.get(memberId) ?? "読み込み中…"}
              </li>
            ))}
          </ul>
        </Card>
        <Notice tone="warning" icon="sync_lock">
          ここでの対象の変更は新しい下書きになります（作成済みの下書きの対象は変えられません）。変える場合は「あらためて作成」から。
        </Notice>
      </section>

      {cancelled && (
        <Card className="flex flex-col gap-2">
          <Chip tone="neutral" icon="event_busy">取消済み</Chip>
          <p className="text-[13px] text-ink-sub">この下書きは取消されました。誰にも届いていません（記録は残ります）。</p>
          <Link
            to="/app/tasks-notifications/notifications/new"
            className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-pill bg-white/[.08] px-4 text-[13px] font-bold text-ink"
          >
            あらためて作成
          </Link>
        </Card>
      )}

      {approvable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button busy={approvalSaving} onClick={onApprove}>承認する</Button>
          <Button variant="secondary" busy={approvalSaving} className="max-lg:min-h-11" onClick={onCancel}>取消する</Button>
          <Link
            to="/app/tasks-notifications/notifications/new"
            className="inline-flex min-h-11 items-center rounded-pill px-3 text-[13px] font-bold text-ink-muted underline-offset-4 hover:underline"
          >
            あらためて作成
          </Link>
        </div>
      )}

      {/* 承認後の配送結果（202=配送jobの受付。完了ではない。docs/05 §1） */}
      {!approvable && !cancelled && <DeliveryResultsSection draft={draft} names={names} />}

      {/* 成功だけでなく失敗（409競合・422・権限・通信断）も通す。潰すとダイアログが開いたまま無反応になる
          （docs/03 §1「conflictを区別」。PH4レビューC 中2。失敗時はダイアログが開いたまま案内が出る） */}
      <MutationStatus state={approvalState} toastBottom={100} />

      {/* 送信確認（docs/03「送信確認ダイアログで本文・対象・人数を明示」） */}
      {dialogKind && draft.status === "draft" && (
        dialogKind === "approve" ? (
          <ConfirmDialog
            title="この通知を承認して送信しますか"
            confirmLabel="承認する"
            busy={approvalSaving}
            onConfirm={() => {
              void runApproval("approve").then((r) => {
                if (r) onApproved(r);
              });
            }}
            onCancel={onDialogClose}
          >
            <p>承認すると対象者への配送が始まります。本文と対象は承認した内容で固定されます。</p>
            <div className="hairline rounded-card bg-white/[.04] p-3">
              <h3 className="text-[13px] font-bold">本文</h3>
              <p className="mt-1 whitespace-pre-wrap text-[13px] font-medium leading-[1.6]">{draft.body}</p>
            </div>
            <div className="hairline rounded-card bg-white/[.04] p-3">
              <h3 className="text-[13px] font-bold">対象（{audienceIds.length}人）</h3>
              <ul className="mt-1.5 flex flex-col gap-1">
                {audienceIds.map((memberId) => (
                  <li key={memberId} className="text-[13px] font-medium">
                    {names?.get(memberId) ?? "読み込み中…"}
                  </li>
                ))}
              </ul>
            </div>
          </ConfirmDialog>
        ) : (
          <ConfirmDialog
            title="この下書きを取消しますか"
            confirmLabel="取消する"
            danger
            busy={approvalSaving}
            onConfirm={() => {
              void runApproval("cancel").then((r) => {
                if (r) onCancelled(r);
              });
            }}
            onCancel={onDialogClose}
          >
            <p>まだ送信されていない下書きを取り消します。対象（{audienceIds.length}人）には届きません。取消の記録は残ります。</p>
          </ConfirmDialog>
        )
      )}
    </div>
  );
}

/**
 * 配送結果（送信者。API-65のrecipients。受付済み/失敗/到達不明/取消/送信待ちを別表示し、
 * 既読はその実数（docs/11「受付≠到達≠既読」）。承認・配送中は2.5秒ごとに読み直す）
 */
export function DeliveryResultsSection({ draft, names }: { draft: NotificationDto; names: MemberNameMap | null }) {
  const [live, setLive] = useState(draft);
  const [showAll, setShowAll] = useState(false);
  const cancelUnsent = useMutation("API-64");
  const [confirmUnsent, setConfirmUnsent] = useState(false);

  // 承認済み・配送中の間だけ再読込（jobの実行を待つ）。終端（finished/failed）でも既読が全員分に
  // なるまでは続ける（既読は対象者の明示操作で後から増えるため。docs/03「受付/配送/既読を別表示」）
  useEffect(() => setLive(draft), [draft]);
  const allRead = (live.recipients ?? []).length > 0 && (live.recipients ?? []).every((r) => r.readAt !== null);
  useEffect(() => {
    const active = live.status === "approved" || live.status === "dispatching" || ((live.status === "finished" || live.status === "failed") && !allRead);
    if (!active) return;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const data = (await api("API-65", { params: { id: live.id } })) as unknown as NotificationDto;
          setLive(data);
        } catch {
          /* 次の再読込で拾う（結果を確認できない画面状態にはしない） */
        }
      })();
    }, 2500);
    return () => clearInterval(timer);
  }, [live.id, live.status, allRead]);

  const recipients = live.recipients ?? [];
  const count = (predicate: (status: string | null | undefined) => boolean) => recipients.filter((r) => predicate(r.deliveryStatus)).length;
  const accepted = count((s) => s === "provider_accepted");
  const failed = count((s) => s === "failed" || s === "retry_wait");
  const unknown = count((s) => s === "unknown");
  const cancelledN = count((s) => s === "cancelled");
  const waiting = count((s) => s === null || s === undefined || s === "pending" || s === "sending");
  const readCount = recipients.filter((r) => r.readAt !== null).length;
  const unknownRecipients = recipients.filter((r) => r.deliveryStatus === "unknown");
  const unsentCount = waiting;

  return (
    <section aria-label="配送結果" className="flex flex-col gap-3">
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-[14px] font-bold">
            <Icon name="send" className="text-[20px] text-ink-muted" />
            配送結果
          </span>
          {(live.status === "approved" || live.status === "dispatching") && (
            <Chip tone="attention" icon="hourglass_top">配送を準備しています…</Chip>
          )}
          {live.status === "finished" && <Chip tone="ok" icon="check_circle">配送の処理を終えました</Chip>}
          {live.status === "failed" && <Chip tone="alert" icon="report">配送できなかった宛先があります</Chip>}
        </div>
        {/* 受付・到達・既読は別の行（混同しない。docs/11）。承認だけで到達したとは表示しない */}
        <ul className="flex flex-col gap-1.5 text-[13px] font-medium">
          <li className="flex items-center justify-between">
            <span className="flex items-center gap-1.5"><Chip tone="ok">受付済み</Chip>送信先で受け付けた</span>
            <span className="font-mono font-semibold">{accepted}人</span>
          </li>
          <li className="flex items-center justify-between">
            <span className="flex items-center gap-1.5"><Chip tone="alert">失敗</Chip>拒否され再送待ち</span>
            <span className="font-mono font-semibold">{failed}人</span>
          </li>
          <li className="flex items-center justify-between">
            <span className="flex items-center gap-1.5"><Chip tone="attention">到達不明</Chip>結果が確認できず人確認が必要</span>
            <span className="font-mono font-semibold">{unknown}人</span>
          </li>
          {cancelledN > 0 && (
            <li className="flex items-center justify-between">
              <span className="flex items-center gap-1.5"><Chip tone="neutral">取消</Chip>未送分を取り消し</span>
              <span className="font-mono font-semibold">{cancelledN}人</span>
            </li>
          )}
          {waiting > 0 && (
            <li className="flex items-center justify-between">
              <span className="flex items-center gap-1.5"><Chip tone="neutral">送信待ち</Chip>まだ送っていない</span>
              <span className="font-mono font-semibold">{waiting}人</span>
            </li>
          )}
          <li className="flex items-center justify-between border-t border-white/[.06] pt-1.5">
            <span className="flex items-center gap-1.5"><Chip tone="ok" icon="task_alt">既読</Chip>対象者が内容を確認</span>
            <span className="font-mono font-semibold"><span data-testid="read-count">{readCount}</span>人</span>
          </li>
        </ul>
        <p className="text-[12px] text-ink-muted">
          受付は送信先が受け付けたこと、既読は対象者が画面で確認したことを示します。到達や読了を保証する表示ではありません。
        </p>

        {/* 到達不明は「結果を確認」の導線で対象と対処を開く（docs/03 SCR-21） */}
        {unknown > 0 && (
          <div className="flex flex-col gap-2">
            <Button variant="secondary" className="max-lg:min-h-11 !w-auto self-start px-4 !text-[13px]" onClick={() => setShowAll(true)}>
              結果を確認
            </Button>
            {showAll && (
              <Notice tone="warning" icon="help">
                到達不明（{unknown}人）: {unknownRecipients.map((r) => names?.get(r.memberId) ?? "読み込み中…").join("・")}。
                宛先の結果が確認できていません。無条件の再送は行われないため、対象者に直接確認してください。
              </Notice>
            )}
          </div>
        )}

        {/* 宛先ごとの一覧（開いたとき。deliveryStatusと既読を並べる） */}
        {showAll && (
          <ul className="flex flex-col gap-1.5 border-t border-white/[.06] pt-2.5">
            {recipients.map((r) => {
              const meta = (r.deliveryStatus && DELIVERY_LABEL[r.deliveryStatus]) || DELIVERY_PENDING;
              return (
                <li key={`${r.memberId}:${r.channel}`} className="flex items-center gap-2.5 text-[13px] font-medium">
                  <Chip tone={meta.tone}>{meta.label}</Chip>
                  <span className="min-w-0 flex-1 truncate">{names?.get(r.memberId) ?? "読み込み中…"}</span>
                  {r.readAt ? <Chip tone="ok">既読</Chip> : <span className="text-[11px] text-ink-muted">未読</span>}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* 未送分の取消（承認後。docs/11「未送分取消」。対象を明示してから行う。docs/03 SCR-21） */}
      {unsentCount > 0 && (live.status === "approved" || live.status === "dispatching" || live.status === "finished" || live.status === "failed") && (
        <div>
          <Button variant="secondary" busy={cancelUnsent.saving} className="max-lg:min-h-11 !w-auto px-4 !text-[13px]" onClick={() => setConfirmUnsent(true)}>
            未送分を取り消す（{unsentCount}人）
          </Button>
          {/* 成功（saved）だけでなく失敗（409競合・権限・通信断）も通す（docs/03 §1「conflictを区別」。C中2と同じ） */}
          <MutationStatus state={cancelUnsent.state} toastBottom={100} />
        </div>
      )}

      {confirmUnsent && (
        <ConfirmDialog
          title="この通知の未送分を取り消しますか"
          confirmLabel="取り消す"
          danger
          busy={cancelUnsent.saving}
          onConfirm={() => {
            void (async () => {
              const r = await cancelUnsent.run({ params: { id: live.id }, body: { version: live.version, decision: "cancel_unsent" } });
              if (r) {
                setConfirmUnsent(false);
                setLive(r.data as unknown as NotificationDto);
              }
            })();
          }}
          onCancel={() => setConfirmUnsent(false)}
        >
          <p>まだ送っていない宛先（{unsentCount}人中、送信待ちの分）への送信をやめます。</p>
          <ul className="hairline flex flex-col gap-1 rounded-card bg-white/[.04] p-3">
            {recipients.filter((r) => r.deliveryStatus === null || r.deliveryStatus === undefined || r.deliveryStatus === "pending" || r.deliveryStatus === "sending").map((r) => (
              <li key={`${r.memberId}:${r.channel}`} className="text-[13px] font-medium">
                {names?.get(r.memberId) ?? "読み込み中…"}
              </li>
            ))}
          </ul>
          <p>すでに受付済み・到達不明の宛先は取り消せません（送ったものを未送には戻しません。docs/11）。</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

/** 通知の承認状態の表示（docs/11 通知承認。送信者に見える6状態。下書きは中立＝紫はAI由来だけに使う） */
export const APPROVAL_LABEL: Record<NotificationDto["status"], { label: string; tone: "neutral" | "ai" | "ok" | "alert" | "attention" }> = {
  draft: { label: "下書き", tone: "neutral" },
  approved: { label: "承認済み", tone: "attention" },
  cancelled: { label: "取消済み", tone: "neutral" },
  dispatching: { label: "配送中", tone: "attention" },
  finished: { label: "配送処理済み", tone: "ok" },
  failed: { label: "失敗あり", tone: "alert" },
};

/** 送信者として通知の1件を開いた画面（配送結果と未送分取消。再承認はできない＝状態遷移に無い） */
export function SenderNotificationDetail({ initial }: { initial: NotificationDto }) {
  const names = useMemberNames();
  const audienceIds = useMemo(() => initial.audienceMemberIds ?? [], [initial]);
  const terminal = initial.status === "cancelled" || initial.status === "draft";
  const meta = APPROVAL_LABEL[initial.status];
  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <SubHeader
        title="通知の詳細"
        sub={initial.status === "draft" ? "下書き（承認は作成 flow から）" : `承認 ${initial.approvedAt ? fmtInstant(initial.approvedAt) : "—"}`}
        backTo="/app/tasks-notifications"
        right={<Chip tone={meta.tone}>{meta.label}</Chip>}
      />
      <Card className="flex flex-col gap-2">
        <p className="whitespace-pre-wrap text-[14px] font-medium leading-[1.7]">{initial.body}</p>
      </Card>
      <Card className="flex flex-col gap-2 p-0">
        <div className="flex items-center justify-between border-b border-white/[.06] px-4 py-3.5">
          <span className="flex items-center gap-2 text-[14px] font-medium">
            <Icon name="groups" className="text-[20px] text-ink-muted" />
            対象者（{audienceIds.length}人）
          </span>
          <span className="font-mono text-[11px] text-ink-muted">{initial.channels.join(" / ")}</span>
        </div>
      </Card>
      {terminal ? (
        <Notice tone="info" icon="info">
          この通知は{initial.status === "cancelled" ? "取り消されています" : "まだ承認されていません"}。配送結果はありません。
        </Notice>
      ) : (
        <DeliveryResultsSection draft={initial} names={names} />
      )}
    </div>
  );
}
