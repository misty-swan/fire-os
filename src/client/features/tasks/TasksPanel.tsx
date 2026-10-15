import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../../api";
import { ConfirmDialog } from "../../components/Overlay";
import { MutationStatus } from "../../components/MutationStatus";
import { Banner, Button, Card, Chip, Icon, TextArea } from "../../components/ui";
import type { TaskDetailDto, TaskEventDto } from "../../../shared/contracts/operations";
import { useMe } from "../../me";
import { useMutation } from "../../useMutation";

/**
 * 自分の担当タスク（T052、SCR-21のタスクタブ。docs/03 SCR-21「自分の担当タスク一覧・状態操作・期限・履歴」）。
 * 一覧はAPI-102（assignee=本人。status省略時は open/assigned/in_progress＝ホームの「自分のタスク」指標と
 * 同じ条件。?status=done で完了済みを確認できる。docs/05 API-102）。
 * 状態操作はAPI-87（docs/11の許可辺のみ）。着手・完了は定型理由（内容を確認しました等）を画面が送り、
 * 再開（done→in_progress）だけ理由必須の確認ダイアログ（docs/03 SCR-07の流儀と同じ）。
 * 担当変更はPER-04/10の保持者にだけ出す（担当scopeの保持者は画面からは判定できないためサーバーが拒否する。
 * announcementsのcanManageと同じ注記）。履歴（task_events）はAPI-102の応答のeventsを開いて見せる。
 */

/** タスクの状態は色＋文字で示す（docs/11 業務タスクの列挙。cancelledは終端で一覧の操作対象外） */
export const TASK_STATUS: Record<TaskDetailDto["status"], { label: string; tone: "neutral" | "attention" | "ok" }> = {
  open: { label: "未着手", tone: "neutral" },
  assigned: { label: "担当済み", tone: "attention" },
  in_progress: { label: "着手中", tone: "attention" },
  done: { label: "完了", tone: "ok" },
  cancelled: { label: "中止", tone: "neutral" },
};

/** 一覧の行の操作で画面が送る定型理由（API-87は理由が必須。docs/05 §1。SCR-07と同じ流儀） */
const FIXED_REASONS = { start: "着手しました", done: "完了しました" } as const;

/** 履歴1行の表示（actionはtask_eventsの規約 `status.<from>_to_<to>` / created / assignee.changed） */
function eventLabel(e: TaskEventDto): string {
  if (e.action === "created") return "作成";
  if (e.action === "assignee.changed") return "担当を変更";
  const m = /^status\.([a-z_]+)_to_([a-z_]+)$/.exec(e.action);
  if (m) return `${TASK_STATUS[m[1] as TaskDetailDto["status"]]?.label ?? m[1]} → ${TASK_STATUS[m[2] as TaskDetailDto["status"]]?.label ?? m[2]}`;
  return e.action;
}

export function TasksPanel() {
  const { me } = useMe();
  const [searchParams, setSearchParams] = useSearchParams();
  /** URLクエリで絞りを持つ（?status=done。戻る・再読込で消えない。ActivitiesPageと同じ流儀） */
  const statusParam = searchParams.get("status") ?? "";
  const [items, setItems] = useState<TaskDetailDto[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);

  // PER-04/10は幹部・管理者が所属内で持つ（docs/10）。担当scopeの保持者は画面からは判定できないためサーバーが拒否する
  const canManage = me.roles.includes("officer") || me.roles.includes("admin") || me.roles.includes("operator");

  useEffect(() => {
    let alive = true;
    setPhase("loading");
    void (async () => {
      try {
        const rows = (await api("API-102", {
          query: { limit: 50, ...(statusParam ? { status: statusParam as TaskDetailDto["status"] } : {}) },
        })) as unknown as TaskDetailDto[];
        if (alive) {
          setItems(rows);
          setPhase("ready");
        }
      } catch {
        if (alive) setPhase("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [statusParam, reloadKey]);

  const patch = useMutation("API-87");
  const [reopenTarget, setReopenTarget] = useState<TaskDetailDto | null>(null);
  const [reopenReason, setReopenReason] = useState("");
  const [assignTarget, setAssignTarget] = useState<TaskDetailDto | null>(null);
  const [assigneeId, setAssigneeId] = useState("");
  const [assignReason, setAssignReason] = useState("");

  /** 状態変更（着手・完了は定型理由で確認なし。docs/03 SCR-07の流儀）。成功したら一覧を読み直す */
  const changeStatus = async (task: TaskDetailDto, status: TaskDetailDto["status"], reason: string) => {
    const r = await patch.run({ params: { id: task.id }, body: { version: task.version, status, reason } });
    if (r) setReloadKey((k) => k + 1);
  };

  const setParam = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "") next.delete("status");
    else next.set("status", value);
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex flex-col gap-3">
      {/* 絞り（既定=活動中。ホームの「自分のタスク」指標と同じ条件。完了は?status=done） */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="hairline flex h-[46px] items-center gap-2 rounded-field bg-white/[.06] px-4">
          <span className="text-[12px] font-bold text-ink-sub">状態</span>
          <select
            aria-label="状態で絞る"
            value={statusParam}
            onChange={(e) => setParam(e.target.value)}
            className="min-w-0 border-none bg-transparent text-[14px] font-medium text-ink outline-none"
          >
            <option value="">対応中（未着手・着手中）</option>
            <option value="done">完了</option>
            <option value="cancelled">中止</option>
          </select>
        </label>
      </div>

      {phase === "loading" && (
        <div className="flex flex-col gap-2">
          {[1, 2].map((n) => (
            <div key={n} className="h-24 animate-pulse rounded-[20px] bg-white/[.05]" />
          ))}
        </div>
      )}
      {phase === "error" && (
        <Banner tone="error" eyebrow="ERROR" role="alert" title="タスクの一覧を取得できませんでした">
          通信を確認して、再読み込みしてください。
        </Banner>
      )}
      {phase === "ready" && items.length === 0 && (
        <Banner tone="info" eyebrow="EMPTY" title={statusParam ? "この状態のタスクはありません" : "自分の担当タスクはありません"}>
          やることが決まったら、ここに現れます（割当てられたタスクだけが見えます）。
        </Banner>
      )}

      <ul className="flex flex-col gap-2" aria-label="自分のタスク">
        {items.map((task) => {
          const meta = TASK_STATUS[task.status];
          const overdue = task.dueDate !== null && task.status !== "done" && task.status !== "cancelled" && task.dueDate < new Date().toISOString().slice(0, 10);
          return (
            <li key={task.id} className="hairline rounded-[20px] bg-white/[.04] p-3.5">
              <div className="flex items-start gap-3">
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <Chip tone={meta.tone} icon={task.status === "done" ? "task_alt" : undefined}>{meta.label}</Chip>
                    {task.dueDate && (
                      <span className="flex items-center gap-1 font-mono text-[11px] text-ink-muted">
                        <Icon name="event" className="text-[14px]" />
                        期限 {task.dueDate}
                        {overdue && <Chip tone="alert">期限超過</Chip>}
                      </span>
                    )}
                  </span>
                  <span className="text-[15px] font-bold leading-[1.5]">{task.title}</span>
                </span>
              </div>

              {/* 状態操作（docs/11の許可辺のみ。着手・完了は確認なし、再開は理由必須の確認ダイアログ） */}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {(task.status === "open" || task.status === "assigned") && (
                  <Button
                    variant="secondary"
                    busy={patch.saving}
                    className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11"
                    onClick={() => void changeStatus(task, "in_progress", FIXED_REASONS.start)}
                  >
                    着手
                  </Button>
                )}
                {task.status === "in_progress" && (
                  <Button
                    busy={patch.saving}
                    className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11"
                    onClick={() => void changeStatus(task, "done", FIXED_REASONS.done)}
                  >
                    完了する
                  </Button>
                )}
                {task.status === "done" && (
                  <Button
                    variant="secondary"
                    className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11"
                    onClick={() => {
                      setReopenReason("");
                      setReopenTarget(task);
                    }}
                  >
                    再開する
                  </Button>
                )}
                {/* 担当変更（PER-04/10。完了・中止ではできない＝サーバーが422。docs/16 T049裁定） */}
                {canManage && (task.status === "open" || task.status === "assigned" || task.status === "in_progress") && (
                  <Button
                    variant="secondary"
                    className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11"
                    onClick={() => {
                      setAssigneeId(task.assigneeMemberId ?? "");
                      setAssignReason("");
                      setAssignTarget(task);
                    }}
                  >
                    担当を変更
                  </Button>
                )}
              </div>

              {/* 履歴（task_events。API-102の応答に載っている分だけ。docs/03 SCR-21「履歴」） */}
              {task.events.length > 0 && (
                <details className="mt-2.5">
                  <summary className="flex min-h-11 cursor-pointer items-center gap-1.5 text-[12px] font-bold text-ink-muted">
                    <Icon name="history" className="text-[16px]" />
                    履歴（{task.events.length}件）
                  </summary>
                  <ul className="mt-1.5 flex flex-col gap-1 border-l border-white/[.08] pl-3">
                    {task.events.map((e) => (
                      <li key={e.id} className="text-[12px] font-medium leading-[1.6] text-ink-sub">
                        {eventLabel(e)}
                        {e.reason && <span className="text-ink-muted">（{e.reason}）</span>}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ul>

      <MutationStatus state={patch.state} toastBottom={100} />

      {/* 再開（done→in_progress。docs/11「再開理由」。理由必須の確認ダイアログ） */}
      {reopenTarget && (
        <ConfirmDialog
          title="このタスクを再開しますか"
          confirmLabel="再開する"
          busy={patch.saving}
          confirmDisabled={!reopenReason.trim()}
          onConfirm={async () => {
            const target = reopenTarget;
            setReopenTarget(null);
            await changeStatus(target, "in_progress", reopenReason.trim());
          }}
          onCancel={() => {
            setReopenTarget(null);
            setReopenReason("");
          }}
        >
          <p>「{reopenTarget.title}」を着手中に戻します。完了の記録は履歴に残ります。</p>
          <TextArea name="reopen-reason" label="再開の理由（必須）" value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} />
          {!reopenReason.trim() && <p className="text-[12px] font-medium text-attention">理由を入力してください</p>}
        </ConfirmDialog>
      )}

      {/* 担当変更（PER-04/10。open/assigned/in_progressから。担当はactive団員のみ＝サーバーが検査する） */}
      {assignTarget && (
        <ConfirmDialog
          title="担当を変更しますか"
          confirmLabel="変更する"
          busy={patch.saving}
          confirmDisabled={!assignReason.trim()}
          onConfirm={async () => {
            const target = assignTarget;
            setAssignTarget(null);
            const r = await patch.run({
              params: { id: target.id },
              body: { version: target.version, assigneeMemberId: assigneeId || null, reason: assignReason.trim() },
            });
            if (r) setReloadKey((k) => k + 1);
          }}
          onCancel={() => {
            setAssignTarget(null);
            setAssignReason("");
          }}
        >
          <p>「{assignTarget.title}」の担当を変更します。</p>
          <AssigneeSelect value={assigneeId} onChange={setAssigneeId} currentId={assignTarget.assigneeMemberId} />
          <TextArea name="assign-reason" label="変更の理由（必須）" value={assignReason} onChange={(e) => setAssignReason(e.target.value)} />
          {!assignReason.trim() && <p className="text-[12px] font-medium text-attention">理由を入力してください</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}

/** 担当者の選択（名簿の有効な団員。ActivityEditorPageと同じ選択肢の作り方） */
function AssigneeSelect({ value, onChange, currentId }: { value: string; onChange: (id: string) => void; currentId: string | null }) {
  const [members, setMembers] = useState<{ id: string; displayName: string; status: string }[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = (await api("API-02", { query: { limit: 200 } })) as unknown as { id: string; displayName: string; status: string }[];
        if (alive) setMembers(rows);
      } catch {
        if (alive) setMembers([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return (
    <label className="flex flex-col gap-2">
      <span className="text-[12px] font-bold text-ink-sub">新しい担当（空欄で担当なし）</span>
      <select
        aria-label="新しい担当"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="hairline h-[54px] rounded-field bg-white/[.06] px-4 text-[14px] font-medium text-ink outline-none"
      >
        <option value="">担当なし</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.displayName}
            {m.id === currentId ? "（現在の担当）" : ""}
            {m.status !== "active" ? "（名簿で対象外）" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
