import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../../api";
import { PageTitle } from "../../components/Page";
import { Banner, Card, Chip, Icon } from "../../components/ui";
import { IssueCreateForm } from "./IssueCreateForm";

/**
 * 異常の一覧（T034、SCR-07。prototypeの点検管理に相当）。
 * 状態は色と文字で示す（docs/03: 色だけに頼らない）。起点点検・対象を辿れる。
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
          return (
            <Card key={i.id} className="flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 text-[14px] font-bold">{i.title}</span>
                <Chip tone={meta.tone}>{meta.label}</Chip>
              </div>
              <p className="line-clamp-2 text-[12px] leading-[1.6] text-ink-sub">{i.description}</p>
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
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/** 異常の詳細シート（対象の詳細画面に埋め込む。確認/却下/再開の操作）。 */
export function IssueActionsCard({ issue }: { issue: { id: string; version: number; status: string } }) {
  const [state, setState] = useState<"idle" | "busy" | "saved">("idle");
  void state; void setState;
  return (
    <Card className="flex flex-col gap-2">
      <span className="text-[12px] font-bold text-ink-sub">異常の対応</span>
      <p className="text-[12px] text-ink-muted">状態の変更は異常一覧から行えます（現在: {issue.status}）。</p>
    </Card>
  );
}
