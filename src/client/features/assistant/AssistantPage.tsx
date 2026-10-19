import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiError, api, apiCall, type ApiInput } from "../../api";
import { LeaveConfirm } from "../../components/LeaveConfirm";
import { ConfirmDialog } from "../../components/Overlay";
import { MutationStatus } from "../../components/MutationStatus";
import { PageTitle } from "../../components/Page";
import { Banner, Card, Chip, Icon, Notice, TextField } from "../../components/ui";
import { useMe } from "../../me";
import { useMutation } from "../../useMutation";
import type { AssistantProposalDto, AssistantProposedEffectDto, AssistantReadingType } from "../../../shared/contracts/ai";
import type { ApiResponse } from "../../../shared/contracts/registry";
import type { NotificationDto } from "../../../shared/contracts/content";
import { CitationPanel } from "./CitationPanel";
import { useMemberNames } from "../notifications/names";
import { fmtInstant } from "../activities/time";
import { randomUuid } from "../../uuid";

/**
 * AIアシスタント（T070、SCR-28 /app/assistant。docs/03 §2「権限付き横断検索/RAG、引用原文、
 * 書込/通知提案の確認」。AI-06/AI-07）。prototype（FireOS Prototype.dc.html のAI画面）の語彙・見た目に従う:
 * 「団員権限で参照」の注記・質問欄（質問や依頼を入力）・提案チップ・思考ステップ（処理中表示）・
 * タスク下書き（確認して作成/破棄）・連絡文下書き。
 *
 * - 質問1件ごとに API-76（RAG。出典つきの回答）と API-77（横断読取と書込提案）を呼ぶ。
 *   **AI発言は命令・確定した事実として表示しない**: 回答は「AIによる回答（出典つき）」の紫ブロック＋
 *   出典（CitationPanelの「参照元」）を別に出す（docs/03 §1.1のデザイン原則③。AIは紫、決めるのは人）。
 * - **読取結果と書込候補は別カード**。書込候補は「確認して作成」（API-31の承認。確認ダイアログで
 *   作られる値を明示＝差分確認）／「破棄」（理由必須の却下）／「再生成」（同じ質問の再実行。旧候補は残る）。
 *   承認しても通知の送信はされず、実送信はAPI-64の送信確認（本文・対象を明示するダイアログ＝T052流儀）。
 * - abstained（根拠不足）は「確認できない（根拠が足りません）」＋手動検索への導線（docs/06 §5.4）。
 * - 1提案=1決定（docs/11「1提案=1行」）のため、承認は提案ごとに1回。同じ種別の候補が複数あるときは
 *   選んだ1件だけが confirmedPayload に入る（API-31の confirmedPayload.task/.notification は各1件）。
 * - 権限: PER-09（幹部・管理者＋担当scopeの既定。docs/10）。権限が無い質問は送信できず、
 *   サーバーの403をそのまま案内に出す（画面では権限を判定しない。担当scopeは画面からは分からない）。
 * - 回答・提案の過去分の再取得契約は無いため、画面は応答をそのまま表示する（ページを離れると消える）。
 */

/** 読取結果の種別の表示語彙（assistantReadingTypes。docs/05 API-77行） */
const READING_TYPE_LABELS: Record<AssistantReadingType, string> = {
  facility_inspection: "施設点検",
  asset_inspection: "資産点検",
  issue: "異常",
  activity: "予定・活動",
  document: "文書",
};

type RagAnswer = ApiResponse<"API-76">;
type CitationDto = RagAnswer["citations"][number];

/** 質問1件の応答（過去提案の再表示契約は無いため、この画面の状態としてだけ持つ） */
interface Turn {
  id: string;
  question: string;
  askedAtIso: string;
  phase: "loading" | "done";
  rag: RagAnswer | null;
  ragError: string | null;
  proposal: AssistantProposalDto | null;
  proposalError: string | null;
}

interface ContextOption {
  key: string;
  type: AssistantReadingType;
  id: string;
  kindLabel: string;
  label: string;
}

/** 送信系エラーの案内（403=権限・503=AI無し/一時失敗。docs/05 §1の区分どおりに分ける） */
function submitErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return "この質問は送信できませんでした（権限が足りません）。AIアシスタントは幹部・管理者（または担当の記録）が対象です。";
    if (e.status === 429) return "AI・検索の利用上限に達しました。しばらく待ってから、もう一度お試しください。";
    if (e.status === 503) return "AIサービスが今使えないため回答を作成できませんでした。しばらく待ってから、もう一度お試しください。";
    if (e.status === 404) return "添えた記録を読めませんでした（存在しないか、閲覧できなくなりました）。";
  }
  return "回答を取得できませんでした。通信を確認して、もう一度お試しください。";
}

/** 根拠不足・失敗のときの手動検索への導線（docs/06 §5.4「根拠不足では確認できない＋手動で探す」） */
function ManualSearchLinks() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[12px] text-ink-muted">手動で探す:</span>
      <Link to="/app/documents" className="inline-flex min-h-11 items-center gap-1 rounded-pill bg-white/[.08] px-3 text-[12px] font-bold text-ink lg:min-h-9">
        <Icon name="folder" className="text-[15px]" />
        文書・規程の一覧を開く
      </Link>
      <Link to="/app/map" className="inline-flex min-h-11 items-center gap-1 rounded-pill bg-white/[.08] px-3 text-[12px] font-bold text-ink lg:min-h-9">
        <Icon name="map" className="text-[15px]" />
        マップを開く
      </Link>
    </div>
  );
}

/** 読取結果の1行（種別・出典版・要約。元記録へ辿れる画面が有る種別だけリンクを出す） */
function ReadResultRow({ result }: { result: ApiResponse<"API-77">["readResults"][number] }) {
  const label = READING_TYPE_LABELS[result.type];
  const href =
    result.type === "activity"
      ? `/app/activities/${result.id}`
      : result.type === "document"
        ? `/app/documents/${result.id}?revision=${result.version}`
        : result.type === "issue"
          ? "/app/issues"
          : null;
  return (
    <li className="flex flex-col gap-1 border-b border-white/[.06] px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="neutral">{label}</Chip>
        <span className="font-mono text-[11px] text-ink-muted">出典版 第{result.version}版</span>
        {href && (
          <Link to={href} className="ml-auto inline-flex min-h-11 items-center gap-0.5 text-[12px] font-bold text-ink underline underline-offset-4 lg:min-h-9">
            元の記録を開く
            <Icon name="chevron_right" className="text-[14px]" />
          </Link>
        )}
      </div>
      <p className="whitespace-pre-wrap text-[12px] leading-[1.7] text-ink-sub">{result.summary}</p>
    </li>
  );
}

/** 承認（API-31）の入力。assistant源のsource_versionは1固定（docs/16 T068） */
const ASSISTANT_SOURCE_VERSION = 1;

/**
 * 提案（書込候補）のカードと承認フロー。1提案=1決定のため、承認・破棄はこの提案で1回だけ。
 * タスクは題名・担当・期限を確認ダイアログの中で確認・修正でき（確定予定値＝T055と同じ考え方）、
 * 通知は本文・対象を確認してから承認する（送信は別の承認。T052の送信確認ダイアログと同じ区分）。
 */
function ProposalCard({ proposal, onRegenerate }: { proposal: AssistantProposalDto; onRegenerate: () => void }) {
  const { me } = useMe();
  const names = useMemberNames();
  const decide = useMutation("API-31");
  const effects = proposal.proposedEffects;

  // 同じ種別の候補は1件だけ選べる（API-31のconfirmedPayload.task/.notificationは各1件＝docs/05 §3）
  const [chosen, setChosen] = useState<number[]>(() => (effects.length > 0 ? [0] : []));
  const toggle = (i: number): void =>
    setChosen((prev) => {
      const kind = effects[i]!.kind;
      if (prev.includes(i)) return prev.filter((x) => x !== i);
      const others = effects.map((e, idx) => (e.kind === kind ? idx : -1)).filter((idx) => idx >= 0 && idx !== i);
      return [...prev.filter((x) => !others.includes(x)), i].sort();
    });

  // 確定予定値（人の修正の初期値はAI候補。AIは候補を出すだけで、最終判断は人）
  const [taskTitles, setTaskTitles] = useState<string[]>(() => effects.map((e) => (e.kind === "task" ? e.title : "")));
  const [taskAssignees, setTaskAssignees] = useState<string[]>(() => effects.map((e) => (e.kind === "task" ? me.profile.memberId : "")));
  const [taskDues, setTaskDues] = useState<string[]>(() => effects.map((e) => (e.kind === "task" ? (e.dueDate ?? "") : "")));
  const [members, setMembers] = useState<{ id: string; displayName: string }[] | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = (await api("API-02", { query: { limit: 200 } })) as unknown as { id: string; displayName: string }[];
        if (alive) setMembers(rows);
      } catch {
        if (alive) setMembers([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const nameOf = (id: string | null | undefined): string => (id ? (names?.get(id) ?? members?.find((m) => m.id === id)?.displayName ?? "読み込み中…") : "未定");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  /** 決定後（docs/11「旧決定書換なし」。再表示契約は無いため応答の状態をこの場で表示に反映する） */
  const [decided, setDecided] = useState<"approved" | "rejected" | null>(null);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const [createdNotificationId, setCreatedNotificationId] = useState<string | null>(null);

  const chosenTask = chosen.map((i) => effects[i]!).find((e): e is Extract<AssistantProposedEffectDto, { kind: "task" }> => e.kind === "task");
  const chosenTaskIndex = chosenTask ? effects.findIndex((e) => e === chosenTask) : -1;
  const chosenNotification = chosen.map((i) => effects[i]!).find((e): e is Extract<AssistantProposedEffectDto, { kind: "notification" }> => e.kind === "notification");

  /** 人の修正（題名・担当・期限の変更、候補の選択）があれば approve_with_edit（docs/11語彙。T054の変換） */
  const edited =
    chosen.length !== effects.length ||
    effects.some((e, i) => {
      if (e.kind !== "task") return false;
      const t = taskTitles[i]?.trim() ?? "";
      const a = taskAssignees[i] ?? "";
      const d = taskDues[i] ?? "";
      return t !== e.title || a !== (e.assigneeMemberId ?? "") || d !== (e.dueDate ?? "");
    });
  const decision = edited ? "approve_with_edit" : "approve";

  const submitApprove = async (): Promise<void> => {
    if (chosen.length === 0) return;
    const r = await decide.run({
      params: { id: proposal.proposalId! },
      body: {
        version: 1, // 提案は追記型で1提案=1行のため、初回決定の前提版は常に1（docs/06 §3）
        sourceVersion: ASSISTANT_SOURCE_VERSION,
        decision,
        confirmedPayload: {
          // タスクは確認ダイアログで確認・修正した値（確定予定値）。通知は候補どおり（対象は源から抽出）
          ...(chosenTask
            ? {
                task: {
                  title: (taskTitles[chosenTaskIndex]?.trim() || chosenTask.title),
                  ...(taskAssignees[chosenTaskIndex] ? { assigneeMemberId: taskAssignees[chosenTaskIndex] } : {}),
                  ...(taskDues[chosenTaskIndex] ? { dueDate: taskDues[chosenTaskIndex] } : {}),
                },
              }
            : {}),
          ...(chosenNotification
            ? {
                notification: {
                  source: chosenNotification.source,
                  ...(chosenNotification.body ? { body: chosenNotification.body } : {}),
                  ...(chosenNotification.audienceMemberIds ? { audienceMemberIds: chosenNotification.audienceMemberIds } : {}),
                  channels: chosenNotification.channels,
                  ...(chosenNotification.expiresAt ? { expiresAt: chosenNotification.expiresAt } : {}),
                },
              }
            : {}),
        },
      },
    });
    if (r) {
      const effectIds = r.data.effectIds;
      setCreatedTaskId(chosenTask ? (effectIds[1] ?? null) : null);
      setCreatedNotificationId(chosenNotification ? (effectIds[1 + (chosenTask ? 1 : 0)] ?? null) : null);
      setDecided("approved");
      setConfirmOpen(false);
    }
  };

  const submitReject = async (): Promise<void> => {
    if (!rejectReason.trim()) return;
    const r = await decide.run({
      params: { id: proposal.proposalId! },
      body: { version: 1, sourceVersion: ASSISTANT_SOURCE_VERSION, decision: "reject", confirmedPayload: {}, reviewNote: rejectReason.trim() },
    });
    if (r) {
      setDecided("rejected");
      setRejectOpen(false);
      setRejectReason("");
    }
  };

  const canDecide = decided === null;

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2.5">
        {effects.map((effect, i) => {
          const on = chosen.includes(i);
          return (
            <li key={i}>
              {effect.kind === "task" ? (
                // タスクの下書き（prototypeのタスクカード。紫枠＋pill＋「確認して作成/破棄」）
                <div className="flex flex-col gap-2.5 rounded-[22px] bg-[#0f1a2d] p-4 shadow-[inset_0_0_0_1px_rgba(185,169,255,.32)]">
                  <div className="flex items-center gap-2">
                    <Chip tone="ai">AI提案</Chip>
                    <span className="text-[11px] text-ink-muted">タスクの候補</span>
                    {canDecide && (
                      <label className="ml-auto flex min-h-11 items-center gap-2 text-[12px] font-bold text-ink lg:min-h-9">
                        <input type="checkbox" checked={on} onChange={() => toggle(i)} className="size-5 accent-[var(--color-ai)]" />
                        作成する
                      </label>
                    )}
                  </div>
                  <span className="text-[16px] font-bold leading-[1.4]">{effect.title}</span>
                  <div className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
                    <span className="text-ink-muted">担当</span>
                    <span>{effect.assigneeMemberId ? (nameOf(effect.assigneeMemberId)) : "未定（承認時に選べます）"}</span>
                    <span className="text-ink-muted">期限</span>
                    <span className="font-mono">{effect.dueDate ?? "未定"}</span>
                  </div>
                </div>
              ) : (
                // 連絡文の下書き（prototypeのノートカード。ラベル＋本文＋送信は別権限の注記）
                <div className="flex flex-col gap-2.5 rounded-[22px] bg-[#0f1a2d] p-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,.1)]">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-ink-muted">連絡文の下書き</span>
                    <span className="font-mono text-[10px] text-ink-dim">{effect.channels.join(" / ")}</span>
                    {canDecide && (
                      <label className="ml-auto flex min-h-11 items-center gap-2 text-[12px] font-bold text-ink lg:min-h-9">
                        <input type="checkbox" checked={on} onChange={() => toggle(i)} className="size-5 accent-[var(--color-ai)]" />
                        作成する
                      </label>
                    )}
                  </div>
                  <p className="whitespace-pre-wrap text-[14px] font-medium leading-[1.8] text-[#dfe4ec]">{effect.body ?? "（本文は源から提案されます）"}</p>
                  <Notice tone="warning" icon="lock">
                    全体への送信は班長以上の権限が必要です。この承認で作るのは下書きで、送信は別の承認（本文・対象の確認）で行われます。
                  </Notice>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/* 操作（prototypeの「確認して作成/破棄」。決定後は作った記録への導線に切り替える） */}
      {canDecide ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={chosen.length === 0 || decide.saving}
            onClick={() => setConfirmOpen(true)}
            className="inline-flex h-[46px] items-center justify-center gap-2 rounded-pill bg-ai px-5 text-[14px] font-bold text-[#0b1220] transition active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-white/[.08] disabled:text-ink-dim max-lg:min-h-11"
          >
            <Icon name="task_alt" className="text-[17px]" />
            確認して作成
          </button>
          <button
            type="button"
            disabled={decide.saving}
            onClick={() => {
              setRejectReason("");
              setRejectOpen(true);
            }}
            className="inline-flex h-[46px] items-center justify-center gap-2 rounded-pill bg-white/[.07] px-4 text-[13px] font-bold text-ink max-lg:min-h-11"
          >
            破棄
          </button>
          <button
            type="button"
            onClick={onRegenerate}
            className="inline-flex min-h-11 items-center gap-1 rounded-pill px-3 text-[12px] font-bold text-ink-muted underline underline-offset-4 lg:min-h-9"
          >
            <Icon name="refresh" className="text-[15px]" />
            再生成
          </button>
          <span className="text-[11px] text-ink-muted">承認するまで、タスクも通知も作られません。</span>
        </div>
      ) : decided === "approved" ? (
        <div className="flex flex-col gap-1.5">
          {createdTaskId && (
            <span className="flex items-center gap-1.5 text-[13px] font-bold text-ok">
              <Icon name="check_circle" className="text-[17px]" />
              タスクを作成しました（
              <Link to="/app/tasks-notifications?tab=tasks" className="underline underline-offset-4">
                自分のタスクで確認する
              </Link>
              ）
            </span>
          )}
          {createdNotificationId && <NotificationSendPanel notificationId={createdNotificationId} />}
          {effects.length > chosen.length && (
            <span className="text-[12px] text-ink-muted">選ばなかった候補は作られていません（作り直すときは「再生成」を使います）。</span>
          )}
        </div>
      ) : (
        <Notice tone="info" icon="event_busy">
          この提案は破棄されました。タスクも通知も作られていません（提案と理由の記録は残ります）。
        </Notice>
      )}
      <MutationStatus state={decide.state} toastBottom={160} />

      {/* 差分の確認（docs/03「効果対象を承認前に表示」。作られる値を明示してからAPI-31で承認する） */}
      {confirmOpen && canDecide && (
        <ConfirmDialog title="この候補を作成しますか" confirmLabel="作成する" busy={decide.saving} confirmDisabled={chosen.length === 0} onConfirm={() => void submitApprove()} onCancel={() => setConfirmOpen(false)}>
          <p>承認すると、表示中の値で業務に反映されます（この提案の決定は1回だけです）。</p>
          {chosen.map((i) => {
            const effect = effects[i]!;
            return effect.kind === "task" ? (
              <div key={i} className="hairline flex flex-col gap-2 rounded-card bg-white/[.04] p-3">
                <span className="text-[12px] font-bold text-ink-sub">作られるタスク</span>
                <TextField name={`task-title-${i}`} label="題名" value={taskTitles[i] ?? ""} onChange={(e) => setTaskTitles((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))} />
                <label className="hairline flex h-[46px] items-center gap-2 rounded-field bg-white/[.06] px-3">
                  <span className="flex-none text-[12px] font-bold text-ink-sub">担当</span>
                  <select
                    aria-label="タスクの担当"
                    value={taskAssignees[i] ?? ""}
                    onChange={(e) => setTaskAssignees((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))}
                    className="min-w-0 flex-1 border-none bg-transparent text-[13px] font-medium text-ink outline-none"
                  >
                    <option value="">未定</option>
                    {(members ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-[12px] font-bold text-ink-sub">
                  期限（任意）
                  <input
                    type="date"
                    aria-label="タスクの期限"
                    value={taskDues[i] ?? ""}
                    onChange={(e) => setTaskDues((prev) => prev.map((v, idx) => (idx === i ? e.target.value : v)))}
                    className="hairline h-[46px] flex-1 rounded-field bg-white/[.06] px-3 text-[13px] font-medium text-ink"
                  />
                </label>
              </div>
            ) : (
              <div key={i} className="hairline flex flex-col gap-1.5 rounded-card bg-white/[.04] p-3">
                <span className="text-[12px] font-bold text-ink-sub">作られる通知の下書き</span>
                <span className="whitespace-pre-wrap text-[13px] leading-[1.6]">{effect.body ?? "（本文は源から提案されます）"}</span>
                <span className="text-[12px] text-ink-muted">
                  源: {READING_TYPE_LABELS[effect.source.type as AssistantReadingType] ?? effect.source.type}の記録・対象:{" "}
                  {effect.audienceMemberIds
                    ? `${effect.audienceMemberIds.length}人（${effect.audienceMemberIds.map((id) => nameOf(id)).join("・")}）`
                    : "源から抽出します（作成後に送信承認で確認します）"}
                </span>
              </div>
            );
          })}
          <p className="text-[12px] text-ink-muted">通知の送信は別の承認（本文・対象を確認する送信の承認）で行われます。この操作で送信は始まりません。</p>
        </ConfirmDialog>
      )}

      {/* 破棄（理由必須の却下。効果は0。docs/06 §3「rejectはconfirmedPayload空・理由必須で効果0」） */}
      {rejectOpen && canDecide && (
        <ConfirmDialog
          title="この提案を破棄しますか"
          confirmLabel="破棄する"
          danger
          busy={decide.saving}
          confirmDisabled={!rejectReason.trim()}
          onConfirm={() => void submitReject()}
          onCancel={() => {
            setRejectOpen(false);
            setRejectReason("");
          }}
        >
          <p>破棄すると、この提案からタスクも通知も作られません（提案と理由の記録は残ります）。</p>
          <textarea
            aria-label="破棄の理由（必須）"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="例: 現地で確認したため不要になった"
            className="hairline min-h-24 w-full resize-none rounded-[16px] bg-white/[.06] px-3.5 py-3 text-[14px] font-medium text-ink placeholder:text-ink-dim"
          />
          {!rejectReason.trim() && <p className="text-[12px] font-medium text-attention">理由を入力してください</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * 作成した通知draftの送信承認（API-64。本文・対象を明示する送信確認ダイアログ＝T052の通知作成flow流儀）。
 * API-65は送信者（PER-12）にだけ全体を見せるため、権限が無いときは成功に見せず案内を出す。
 */
function NotificationSendPanel({ notificationId }: { notificationId: string }) {
  const names = useMemberNames();
  const approval = useMutation("API-64");
  const [draft, setDraft] = useState<NotificationDto | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const d = (await api("API-65", { params: { id: notificationId } })) as unknown as NotificationDto;
        if (alive) setDraft(d);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [notificationId]);

  const audienceIds = draft?.audienceMemberIds ?? [];
  const approvable = draft?.status === "draft";

  const submitApprove = async (): Promise<void> => {
    if (!draft) return;
    const r = await approval.run({
      params: { id: draft.id },
      body: { version: draft.version, bodyHash: draft.bodyHash, audienceHash: draft.audienceHash, decision: "approve" },
    });
    if (r) {
      setConfirmSend(false);
      const fresh = (await api("API-65", { params: { id: draft.id } }).catch(() => null)) as unknown as NotificationDto | null;
      if (fresh) setDraft(fresh);
    }
  };

  if (failed) {
    return (
      <Notice tone="warning" icon="report">
        作成した通知の下書きをここで開けませんでした（閲覧権限が無いか、取り消されています）。タスク・通知の画面で確認してください。
      </Notice>
    );
  }
  if (!draft) {
    return <div className="h-24 animate-pulse rounded-card bg-white/[.05]" />;
  }
  return (
    <section aria-label="作成した通知の下書き" data-notification-id={draft.id} className="flex flex-col gap-2.5 rounded-[22px] bg-white/[.04] p-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,.1)]">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-bold">作成した通知の下書き</span>
        {approvable ? <Chip tone="neutral">下書き</Chip> : <Chip tone="attention" icon="hourglass_top">承認済み・配送を準備しています</Chip>}
      </div>
      <p className="whitespace-pre-wrap text-[13px] leading-[1.7] text-ink-sub">{draft.body}</p>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
        <Icon name="groups" className="text-[16px]" />
        対象者（{audienceIds.length}人）: {audienceIds.map((id) => names?.get(id) ?? "読み込み中…").join("・") || "—"}
      </div>
      {approvable && (
        <button
          type="button"
          disabled={approval.saving}
          onClick={() => setConfirmSend(true)}
          className="inline-flex h-[46px] items-center justify-center gap-2 self-start rounded-pill bg-white/[.08] px-4 text-[13px] font-bold text-ink max-lg:min-h-11"
        >
          <Icon name="send" className="text-[16px]" />
          送信を承認する
        </button>
      )}
      <MutationStatus state={approval.state} toastBottom={160} />
      {confirmSend && approvable && (
        <ConfirmDialog title="この通知を承認して送信しますか" confirmLabel="承認する" busy={approval.saving} onConfirm={() => void submitApprove()} onCancel={() => setConfirmSend(false)}>
          <p>承認すると対象者への配送が始まります。本文と対象は承認した内容で固定されます（配送の受付は202で、完了は別に確認します）。</p>
          <div className="hairline rounded-card bg-white/[.04] p-3">
            <span className="text-[13px] font-bold">本文</span>
            <p className="mt-1 whitespace-pre-wrap text-[13px] font-medium leading-[1.6]">{draft.body}</p>
          </div>
          <div className="hairline rounded-card bg-white/[.04] p-3">
            <span className="text-[13px] font-bold">対象（{audienceIds.length}人）</span>
            <ul className="mt-1.5 flex flex-col gap-1">
              {audienceIds.map((id) => (
                <li key={id} className="text-[13px] font-medium">
                  {names?.get(id) ?? "読み込み中…"}
                </li>
              ))}
            </ul>
          </div>
        </ConfirmDialog>
      )}
    </section>
  );
}

/** 質問1件の表示（質問の吹き出し→処理中→回答→出典→読取結果→書込候補の順） */
function TurnView({ turn, onRegenerate }: { turn: Turn; onRegenerate: (turn: Turn) => void }) {
  return (
    <div className="flex flex-col gap-3">
      {/* 質問（自分の入力。右寄せの吹き出し＝prototype） */}
      <div className="max-w-[80%] self-end rounded-[20px_20px_6px_20px] bg-[#1d2a44] px-4 py-3 text-[14px] font-medium leading-[1.6]">{turn.question}</div>

      {turn.phase === "loading" && (
        <div role="status" className="flex flex-col gap-1.5 px-1">
          <span className="flex items-center gap-2 text-[12px] text-ink-sub">
            <Icon name="auto_awesome" className="animate-pulse text-[16px] text-ai" />
            権限内の記録を読み、回答と候補を作成しています…
          </span>
        </div>
      )}

      {turn.phase === "done" && (
        <>
          {/* 回答（AI発言は命令・確定事実として表示しない。紫ブロック＋出典は別＝docs/03 §1.1の原則③） */}
          {turn.ragError ? (
            <Banner tone="error" eyebrow="ERROR" role="alert" title="回答を取得できませんでした">
              <p>{turn.ragError}</p>
              <ManualSearchLinks />
            </Banner>
          ) : turn.rag?.abstained ? (
            <section aria-label="保留（根拠不足）" className="flex flex-col gap-2.5 rounded-[22px] bg-white/[.04] p-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,.1)]">
              <Chip tone="attention" icon="help" size="lg">
                確認できない（根拠が足りません）
              </Chip>
              <p className="whitespace-pre-wrap text-[14px] font-medium leading-[1.8] text-ink-sub">{turn.rag.answer}</p>
              <ManualSearchLinks />
            </section>
          ) : turn.rag ? (
            <section aria-label="AIによる回答" className="flex flex-col gap-3 rounded-[22px] bg-ai/[.07] p-4 shadow-[inset_0_0_0_1px_rgba(185,169,255,.26)]">
              <div className="flex items-center gap-2">
                <Icon name="auto_awesome" className="text-[19px] text-ai" />
                <span className="text-[14px] font-bold">AIによる回答（出典つき）</span>
              </div>
              <p className="whitespace-pre-wrap text-[14px] font-medium leading-[1.8] text-ink">{turn.rag.answer}</p>
              {turn.rag.citations.length > 0 && <CitationPanel citations={turn.rag.citations} />}
              <p className="text-[11px] leading-[1.6] text-ink-muted">
                AIの回答は命令・確定した事実ではありません。出典の原文で確認してください。出典版は回答時点のもので、開くたびに現在の閲覧権限で改めて確認されます。
              </p>
            </section>
          ) : null}

          {/* 読取結果と書込候補（別カード＝docs/16 T070） */}
          {turn.proposalError ? (
            <Banner tone="warning" eyebrow="ASSISTANT" role="alert" title="提案を作成できませんでした">
              <p>{turn.proposalError}</p>
            </Banner>
          ) : turn.proposal ? (
            <>
              <Card className="flex flex-col gap-2 p-0" aria-label="読み取り結果">
                <div className="flex items-center gap-2 border-b border-white/[.06] px-4 py-3">
                  <Icon name="plagiarism" className="text-[19px] text-ink-muted" />
                  <span className="text-[13px] font-bold">読み取り結果</span>
                  <span className="ml-auto font-mono text-[11px] text-ink-muted">{turn.proposal.readResults.length}件</span>
                </div>
                {turn.proposal.abstained || turn.proposal.readResults.length === 0 ? (
                  <p className="px-4 py-3 text-[13px] text-ink-sub">読み取れた記録はありませんでした（根拠が足りません）。</p>
                ) : (
                  <ul>
                    {turn.proposal.readResults.map((r, i) => (
                      <ReadResultRow key={`${r.type}:${r.id}:${i}`} result={r} />
                    ))}
                  </ul>
                )}
              </Card>

              {turn.proposal.abstained ? (
                <Notice tone="ai" icon="help" role="status">
                  提案も作成できませんでした（{turn.proposal.answer}）
                </Notice>
              ) : turn.proposal.proposalId && turn.proposal.proposedEffects.length > 0 ? (
                <ProposalCard proposal={turn.proposal} onRegenerate={() => onRegenerate(turn)} />
              ) : (
                <Notice tone="info" icon="info">
                  この質問から作れる書込の候補はありませんでした。タスクや連絡が必要なときは、タスク・通知の画面から作成できます。
                </Notice>
              )}
            </>
          ) : null}

          {/* 確認日時（docs/06 §5「保存回答の再取得と引用原文取得でも現ACLを検査」の画面側注記） */}
          <p className="px-1 text-[11px] text-ink-muted">
            この質問の回答は {fmtInstant(turn.askedAtIso)} に取得しました。回答は取得した時点の記録に基づきます。出典の原文は開くたびに、現在の閲覧権限で改めて確認されます（失効していれば開けません）。
          </p>
        </>
      )}
    </div>
  );
}

/**
 * 確認待ちの異常のうち新しい順にn件（記録を添えるチップ用）。API-15は作成の古い順のkeysetなので、
 * 先頭n件だけ取ると古い異常しか出ず、新しく報告された異常を添えられなかった（T085の統合試験で発見。
 * 確認待ちが5件を超えると再現）。続きを最後まで読み（200件×最大10頁）、作成の新しい順に並べ替える。
 */
async function newestReportedIssues(n: number): Promise<{ id: string; title: string }[]> {
  const rows: { id: string; title: string; createdAt: string }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await apiCall("API-15", { query: { status: "reported", limit: 200, ...(cursor ? { cursor } : {}) } as ApiInput<"API-15">["query"] });
    rows.push(...(res.data as unknown as { id: string; title: string; createdAt: string }[]));
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, n);
}

/** SCR-28の本体。質問欄・提案チップ（記録を添える）・応答の繰り返し（prototypeのAI画面と同じ構成） */
export function AssistantPage() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<ContextOption[]>([]);
  const [attached, setAttached] = useState<Set<string>>(new Set());

  // 提案チップ（記録を添える。これからの予定＋確認待ちの異常。既存の一覧APIだけを使う）
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [acts, issues] = await Promise.allSettled([
        api("API-05", { query: { status: "scheduled", from: new Date().toISOString(), limit: 5 } as ApiInput<"API-05">["query"] }),
        newestReportedIssues(5),
      ]);
      if (!alive) return;
      const next: ContextOption[] = [];
      if (acts.status === "fulfilled") {
        for (const a of acts.value as unknown as { id: string; title: string }[]) {
          next.push({ key: `activity:${a.id}`, type: "activity", id: a.id, kindLabel: "予定", label: a.title });
        }
      }
      if (issues.status === "fulfilled") {
        for (const i of issues.value as unknown as { id: string; title: string }[]) {
          next.push({ key: `issue:${i.id}`, type: "issue", id: i.id, kindLabel: "異常", label: i.title });
        }
      }
      setOptions(next);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const ask = (text: string, refs: { type: AssistantReadingType; id: string }[]): void => {
    const turn: Turn = {
      id: randomUuid(),
      question: text,
      askedAtIso: new Date().toISOString(),
      phase: "loading",
      rag: null,
      ragError: null,
      proposal: null,
      proposalError: null,
    };
    setTurns((prev) => [...prev, turn]);
    setBusy(true);
    void (async () => {
      // API-76（読み取り専用POST。Idempotency-Key不要）と API-77（提案を保存するため必須）を並行で呼ぶ
      const [ragRes, proposalRes] = await Promise.allSettled([
        apiCall("API-76", { body: { query: text } }),
        apiCall("API-77", { body: { query: text, contextRefs: refs } }),
      ]);
      setTurns((prev) =>
        prev.map((t) => {
          if (t.id !== turn.id) return t;
          const next: Turn = { ...t, phase: "done" };
          if (ragRes.status === "fulfilled") next.rag = ragRes.value.data;
          else next.ragError = submitErrorText(ragRes.reason);
          if (proposalRes.status === "fulfilled") next.proposal = proposalRes.value.data;
          else next.proposalError = submitErrorText(proposalRes.reason);
          return next;
        }),
      );
      setBusy(false);
    })();
  };

  const submit = (): void => {
    const text = question.trim();
    if (!text || busy) return;
    const refs = options.filter((o) => attached.has(o.key)).map((o) => ({ type: o.type, id: o.id }));
    setQuestion("");
    ask(text, refs);
  };

  const regenerate = (turn: Turn): void => {
    if (busy) return;
    const refs = turn.proposal?.references?.map((r) => ({ type: r.type, id: r.id })) ?? [];
    ask(turn.question, refs); // 同じ質問の再実行（新しい提案になる。旧候補の記録は残る＝docs/11）
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      {/* prototypeのAIヘッダーに小見出しは無いためeyebrowは置かない（docs/03 §1.1-19⑬。PH5レビューC低1） */}
      <PageTitle
        className="lg:[&_h2]:hidden"
        right={
          // prototype語彙: 「団員権限で参照」（読み取りは依頼者の現権限で境界。docs/10 PER-09）
          <span className="flex items-center gap-1.5 text-[11px] text-ink-muted">
            <Icon name="shield_person" className="text-[15px]" />
            団員権限で参照
          </span>
        }
      >
        AIアシスタント
      </PageTitle>

      {turns.length === 0 && (
        <div className="flex flex-col gap-3 px-0.5 pt-6">
          <span className="text-[26px] font-bold leading-[1.4]">
            予定・点検・記録を
            <br />
            横断して答えます。
          </span>
          <span className="text-[13px] leading-[1.7] text-ink-muted">
            データの変更や通知の送信は、必ずあなたの確認を経てから実行します。回答には出典（文書の版・頁・引用位置）が付きます。
          </span>
        </div>
      )}

      <div className="flex flex-col gap-5">
        {turns.map((t) => (
          <TurnView key={t.id} turn={t} onRegenerate={regenerate} />
        ))}
      </div>

      {/* 入力欄（prototypeの丸pill＋紫の送信ボタン）。質問の入力中に離れるときは確認する */}
      <div className="sticky bottom-24 z-10 flex flex-col gap-2 lg:bottom-4">
        {options.length > 0 && (
          <div className="fo-scroll flex gap-1.5 overflow-x-auto pb-0.5" aria-label="記録を添える">
            <span className="flex-none self-center whitespace-nowrap text-[11px] text-ink-muted">記録を添える（任意）</span>
            {options.map((o) => {
              const on = attached.has(o.key);
              return (
                <button
                  key={o.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setAttached((prev) => {
                      const next = new Set(prev);
                      if (next.has(o.key)) next.delete(o.key);
                      else next.add(o.key);
                      return next;
                    })
                  }
                  className={
                    "flex h-9 flex-none items-center whitespace-nowrap rounded-pill px-3 text-[12px] font-medium transition max-lg:min-h-11 " +
                    (on ? "bg-ai/[.16] text-[#e4ddff] shadow-[inset_0_0_0_1px_rgba(185,169,255,.4)]" : "bg-white/[.06] text-ink-sub shadow-[inset_0_0_0_1px_rgba(255,255,255,.1)]")
                  }
                >
                  {o.kindLabel}「{o.label}」
                </button>
              );
            })}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex h-[54px] items-center gap-2 rounded-pill bg-[rgba(20,30,50,.92)] pl-4 pr-2 shadow-[inset_0_0_0_1px_rgba(170,150,255,.32)]"
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="質問や依頼を入力"
            aria-label="質問や依頼を入力"
            className="min-w-0 flex-1 border-none bg-transparent text-[14px] font-medium text-ink outline-none placeholder:text-ink-dim"
          />
          <button
            type="submit"
            aria-label="送信"
            disabled={busy || !question.trim()}
            className="grid size-11 flex-none place-items-center rounded-full bg-ai text-[#0b1220] transition active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-white/[.08] disabled:text-ink-dim lg:size-10"
          >
            <Icon name={busy ? "hourglass_top" : "arrow_upward"} className="text-[20px]" />
          </button>
        </form>
      </div>
      <LeaveConfirm dirty={question.trim().length > 0} />
    </div>
  );
}
