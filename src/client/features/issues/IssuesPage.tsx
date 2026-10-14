import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../../api";
import { ConfirmDialog } from "../../components/Overlay";
import { MutationStatus } from "../../components/MutationStatus";
import { PageTitle } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, TextArea } from "../../components/ui";
import { clsx } from "clsx";
import { IssueCreateForm } from "./IssueCreateForm";
import { useMutation } from "../../useMutation";

/**
 * 異常の一覧と操作（T034、SCR-07。prototypeの点検管理に相当。prototypeに完成形が無いため共通部品で構成）。
 * 状態は色と文字で示す（docs/03: 色だけに頼らない）。行を押すと展開し、状態の操作（API-17）と
 * 担当の変更ができる。起点点検・対象を辿れる。
 */

interface IssueRow {
  id: string;
  version: number;
  target: { type: "facility" | "vehicle" | "equipment"; id: string };
  title: string;
  description: string;
  status: "reported" | "under_review" | "in_progress" | "resolved" | "closed";
  assigneeMemberId: string | null;
  originInspectionId: string | null;
}

const STATUS_LABELS: Record<IssueRow["status"], { label: string; tone: "alert" | "attention" | "ok" | "neutral" }> = {
  reported: { label: "確認待ち", tone: "alert" },
  under_review: { label: "確認中", tone: "attention" },
  in_progress: { label: "対応中", tone: "attention" },
  resolved: { label: "対応実施", tone: "ok" },
  closed: { label: "確認終了", tone: "neutral" },
};

const FILTERS = ["all", "reported", "under_review", "in_progress", "resolved", "closed"] as const;

export function IssuesPage() {
  const [issues, setIssues] = useState<IssueRow[] | "loading" | "error">("loading");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [reloadKey, setReloadKey] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = (await api("API-15", { query: {} })) as unknown as IssueRow[];
        if (alive) setIssues(data);
      } catch {
        if (alive) setIssues("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const shown = Array.isArray(issues) ? issues.filter((i) => filter === "all" || i.status === filter) : [];
  const counts = Object.fromEntries(
    FILTERS.map((f) => [f, Array.isArray(issues) ? (f === "all" ? issues.length : issues.filter((i) => i.status === f).length) : 0]),
  ) as Record<(typeof FILTERS)[number], number>;

  const targetLink = (i: IssueRow) =>
    i.target.type === "facility" ? `/app/facilities/${i.target.id}` : `/app/assets/${i.target.type}/${i.target.id}`;

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <PageTitle eyebrow="ISSUES" className="lg:hidden">
        点検管理
      </PageTitle>

      {/* 状態チップ（未確認/確認中/対応中/対応実施/終了。docs/03 SCR-07） */}
      <IssueCreateForm onCreated={() => setReloadKey((k) => k + 1)} />

      <div className="fo-scroll flex gap-1.5 overflow-x-auto">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={`flex h-9 flex-none items-center gap-1.5 rounded-pill px-3 text-[12px] font-bold max-lg:min-h-11 ${
              filter === f ? "bg-[rgba(20,30,50,.92)] text-ink shadow-[inset_0_0_0_1px_var(--color-ember)]" : "bg-[rgba(20,30,50,.6)] text-ink-sub"
            }`}
          >
            {f === "all" ? "すべて" : STATUS_LABELS[f as IssueRow["status"]].label}
            <span className="font-mono text-[11px] text-ink-muted">{counts[f]}</span>
          </button>
        ))}
      </div>

      {issues === "loading" && (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((n) => <div key={n} className="h-20 animate-pulse rounded-card bg-white/[.05]" />)}
        </div>
      )}
      {issues === "error" && (
        <Banner tone="error" eyebrow="ERROR" title="一覧を取得できませんでした">
          通信を確認して、再読み込みしてください。
        </Banner>
      )}
      {Array.isArray(issues) && shown.length === 0 && (
        <Banner tone="info" eyebrow="EMPTY" title="該当する異常はありません">
          施設や資産の点検で「異常あり」を選ぶと、ここに表示されます。
        </Banner>
      )}

      <div className="flex flex-col gap-2">
        {shown.map((i) => {
          const meta = STATUS_LABELS[i.status];
          const open = openId === i.id;
          return (
            <Card key={i.id} className="flex flex-col gap-2">
              {/* 行押下で展開し、状態の操作と担当の変更を出す（スマホは押下領域44pxを確保する） */}
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpenId(open ? null : i.id)}
                className="flex max-lg:min-h-11 items-start justify-between gap-2 py-1.5 text-left"
              >
                <span className="min-w-0 text-[14px] font-bold">
                  {i.title}
                  <Icon name={open ? "expand_less" : "expand_more"} className="ml-1 align-[-4px] text-[18px] text-ink-muted" />
                </span>
                <Chip tone={meta.tone}>{meta.label}</Chip>
              </button>
              <p className={clsx("text-[12px] leading-[1.6] text-ink-sub", !open && "line-clamp-2")}>{i.description}</p>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
                <span>{i.target.type === "facility" ? "施設" : i.target.type === "vehicle" ? "車両" : "資機材"}</span>
                {i.originInspectionId && (
                  <span className="inline-flex items-center gap-1">
                    <Icon name="fact_check" className="text-[14px]" />
                    点検が起点
                  </span>
                )}
                <Link to={targetLink(i)} className="ml-auto inline-flex min-h-11 items-center gap-1 rounded-pill bg-white/[.08] px-3 text-[12px] font-bold text-ink">
                  対象を開く
                  <Icon name="chevron_right" className="text-[15px]" />
                </Link>
              </div>
              {open && <IssueActions issue={i} onChanged={() => setReloadKey((k) => k + 1)} />}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/** 状態の遷移ボタン（docs/11の許可辺のみ。API-17は理由が常に必須） */
interface NextAction {
  next: IssueRow["status"];
  label: string;
  /** 終了・再開は空で、理由入力の確認ダイアログを出す */
  presetReason: string;
}
const NEXT_ACTIONS: Partial<Record<IssueRow["status"], NextAction[]>> = {
  reported: [{ next: "under_review", label: "確認する", presetReason: "内容を確認しました" }],
  under_review: [
    { next: "in_progress", label: "対応開始", presetReason: "対応を開始しました" },
    { next: "closed", label: "確認終了", presetReason: "" }, // 終了は理由入力の確認ダイアログ
  ],
  in_progress: [{ next: "resolved", label: "対応実施", presetReason: "対応を実施しました" }],
  resolved: [{ next: "closed", label: "確認終了", presetReason: "" }],
  closed: [{ next: "under_review", label: "再開", presetReason: "" }], // 再開も理由必須
};

/** 展開領域: 状態の操作（API-17）と担当の変更（API-02で団員を選ぶ）。終了・再開は理由入力の確認ダイアログ */
function IssueActions({ issue, onChanged }: { issue: IssueRow; onChanged: () => void }) {
  const save = useMutation("API-17");
  const [confirm, setConfirm] = useState<{ next: IssueRow["status"]; label: string } | null>(null);
  const [reason, setReason] = useState("");
  const [reasonTouched, setReasonTouched] = useState(false);
  const [members, setMembers] = useState<{ id: string; displayName: string }[] | null>(null);
  const [assignee, setAssignee] = useState<string>(issue.assigneeMemberId ?? "");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = (await api("API-02", { query: { limit: 200 } })) as unknown as { id: string; displayName: string }[];
        if (alive) setMembers(data);
      } catch {
        if (alive) setMembers([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const reasonError = reasonTouched && confirm && reason.trim() === "" ? "理由を入力してください" : undefined;

  // 一覧の再読込で新版が来たら、担当の選択も最新に揃える
  useEffect(() => {
    setAssignee(issue.assigneeMemberId ?? "");
  }, [issue.assigneeMemberId]);

  const runTransition = async (next: IssueRow["status"], presetReason: string) => {
    const finalReason = presetReason || reason.trim();
    if (!finalReason) {
      setReasonTouched(true);
      return;
    }
    const res = await save.run({
      params: { id: issue.id },
      body: { version: issue.version, status: next, reason: finalReason },
    });
    if (res) {
      setConfirm(null);
      setReason("");
      setReasonTouched(false);
      onChanged(); // 一覧を再読込（新しい状態と版を取る）
    }
  };

  const runAssignee = async (memberId: string | null) => {
    const res = await save.run({
      params: { id: issue.id },
      body: { version: issue.version, assigneeMemberId: memberId, reason: memberId ? "担当を更新しました" : "担当を外しました" },
    });
    if (res) onChanged();
  };

  const actions = NEXT_ACTIONS[issue.status] ?? [];
  const closedLabel = issue.status === "closed" ? "再開しますか" : "確認終了にしますか";

  return (
    <div className="flex flex-col gap-3 rounded-[18px] bg-white/[.03] p-3" aria-label="異常の操作">
      <span className="text-[12px] font-bold text-ink-sub">状態の操作</span>
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <Button
            key={a.next}
            variant={a.next === "closed" ? "secondary" : "primary"}
            busy={save.saving}
            className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11"
            onClick={() => (a.presetReason ? void runTransition(a.next, a.presetReason) : setConfirm({ next: a.next, label: a.label }))}
          >
            {a.label}
          </Button>
        ))}
        {actions.length === 0 && <span className="text-[12px] text-ink-muted">この状態から次の操作はありません。</span>}
      </div>

      <span className="text-[12px] font-bold text-ink-sub">担当</span>
      <div className="flex flex-wrap items-center gap-2">
        <label className="hairline flex h-[46px] min-w-0 flex-1 items-center gap-2 rounded-xl bg-white/[.06] px-3">
          <span className="sr-only">担当者を選ぶ</span>
          <Icon name="person" className="text-[18px] text-ink-muted" />
          <select
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            className="min-w-0 flex-1 border-none bg-transparent text-[13px] font-medium text-ink outline-none"
          >
            <option value="">未担当</option>
            {(members ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          busy={save.saving}
          disabled={members === null || assignee === (issue.assigneeMemberId ?? "")}
          className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11"
          onClick={() => void runAssignee(assignee === "" ? null : assignee)}
        >
          担当を更新
        </Button>
        {issue.assigneeMemberId && (
          <Button
            variant="secondary"
            busy={save.saving}
            className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11"
            onClick={() => {
              setAssignee("");
              void runAssignee(null);
            }}
          >
            担当を外す
          </Button>
        )}
      </div>
      {members === null && <p className="text-[12px] text-ink-muted">団員の一覧を読み込んでいます…</p>}

      {/* 409は競合、422は状態の問題、通信断は結果不明。保存済みはトースト（docs/03 §1.1） */}
      <MutationStatus state={save.state} toastBottom={110} />
      {save.state.kind === "rejected" && save.state.details.length > 0 && (
        <Banner tone="warning" eyebrow="STATE" role="alert" title="理由を確認してください">
          <ul className="list-disc pl-4">
            {save.state.details.map((d, i) => (
              <li key={i}>{d.field}: {d.reason}</li>
            ))}
          </ul>
        </Banner>
      )}

      {confirm && (
        <ConfirmDialog
          title={closedLabel}
          confirmLabel={confirm.label}
          busy={save.saving}
          danger={confirm.next === "closed"}
          onConfirm={() => void runTransition(confirm.next, "")}
          onCancel={() => {
            setConfirm(null);
            setReason("");
            setReasonTouched(false);
          }}
        >
          <p>「{issue.title}」を{confirm.next === "closed" ? "確認終了にします。終了後も「再開」で戻せます。" : "確認中に戻します。"}</p>
          <TextArea
            name="issue-reason"
            label="理由（必須）"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setReasonTouched(true);
            }}
            error={reasonError}
          />
        </ConfirmDialog>
      )}
    </div>
  );
}
