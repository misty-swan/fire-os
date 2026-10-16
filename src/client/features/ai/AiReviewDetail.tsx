import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, apiCall, type ApiInput } from "../../api";
import { ConfirmDialog } from "../../components/Overlay";
import { MutationStatus } from "../../components/MutationStatus";
import { SubHeader } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, Notice, TextField } from "../../components/ui";
import { useMe } from "../../me";
import { useMutation } from "../../useMutation";
import type { AiEvaluationDto } from "../../../shared/contracts/ai";
import {
  CATEGORY_LABELS,
  PROPOSAL_STATUS,
  SOURCE_TYPE_LABELS,
  findIssue,
  type IssueRow,
} from "./AiReviewsPage";

/**
 * AI候補の詳細（T055、SCR-18の別入口 /app/ai/reviews/:id。docs/06 §3「レビューには原文、元の版、AI候補、
 * 確定予定値、対象タスク/通知、現権限を表示」、docs/03 §2 SCR-18「元版変化はstale、効果対象を承認前に表示」）。
 *
 * - stale（元の記録の更新）は表示時に候補のsource_versionと源の現行versionを比較して示す
 *   （docs/16 T055裁定。ai_evaluations側のstale遷移は未実装のため、画面の比較＋サーバー側の409（T054）の二段構え。
 *   staleの候補の承認操作は無効（強制承認の抜け道は無い）で、再生成はAPI-29を現行版で再依頼する
 *   （新しいjob/候補。旧候補はstale表示のまま残す＝docs/11「staleは再生成/再レビュー、旧決定書換なし」）。
 * - 確定予定値（confirmed_categoryになる値・作られるタスク）は承認前に「（予定）」として表示し、
 *   未承認案を確認済み分類・正式タスクのようには見せない（docs/16 T055完了条件）。
 * - 単一件の読み取り契約が無いため候補はAPI-30の一覧から探す（上限20ページ。docs/03 §1.1-11と同じ流儀）。
 *   点検源の現行版は読み取り契約が無いため比較できず、その場合はサーバー側の版再検査（409）だけが防御になる旨を出す。
 */

/** API-30の一覧から候補を探す（上限20ページ。見つからない/続きに在る場合は画面で案内する） */
async function findCandidate(id: string): Promise<{ candidate: AiEvaluationDto | null; truncated: boolean }> {
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await apiCall("API-30", {
      query: { limit: 50, ...(cursor ? { cursor } : {}) } as ApiInput<"API-30">["query"],
    });
    const rows = res.data as unknown as AiEvaluationDto[];
    const found = rows.find((r) => r.id === id);
    if (found) return { candidate: found, truncated: false };
    if (!res.nextCursor) return { candidate: null, truncated: false };
    cursor = res.nextCursor;
  }
  return { candidate: null, truncated: true };
}

/** 現在の承認者の権限表示（権限判定そのものはサーバー。docs/10 PER-10） */
function permissionText(roles: readonly string[]): string {
  if (roles.includes("admin") || roles.includes("officer")) {
    return "幹部・管理者の権限で承認と反映ができます。";
  }
  return "この源と反映先への担当（scope）が必要です。権限が無い操作は、送信の前にサーバーが拒否します。";
}

export function AiReviewDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const [candidate, setCandidate] = useState<AiEvaluationDto | "loading" | "notfound" | "error">("loading");
  const [issue, setIssue] = useState<{ row: IssueRow | null; truncated: boolean } | null | "error">(null);

  useEffect(() => {
    let alive = true;
    setCandidate("loading");
    void (async () => {
      try {
        const found = await findCandidate(id);
        if (!alive) return;
        setCandidate(found.candidate ?? "notfound");
      } catch {
        if (alive) setCandidate("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  const sourceType = candidate !== "loading" && candidate !== "notfound" && candidate !== "error" ? candidate.sourceType : null;
  const candidateLoaded = candidate !== "loading" && candidate !== "notfound" && candidate !== "error";
  /** 源（異常）の現行版。決定の後にも読み直す（確定分類の記録を表示するため）。候補自体は再取得しない
   * （決定の応答で状態が分かるため。トーストを消さないために詳細の再マウントはしない） */
  const [issueKey, setIssueKey] = useState(0);
  useEffect(() => {
    if (sourceType !== "issue") return;
    const sourceId = (candidate as AiEvaluationDto).sourceId;
    let alive = true;
    void (async () => {
      try {
        const found = await findIssue(sourceId);
        if (alive) setIssue(found);
      } catch {
        if (alive) setIssue("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [sourceType, candidateLoaded, issueKey]);

  if (candidate === "loading") {
    return (
      <div className="flex max-w-[720px] flex-col gap-3">
        <SubHeader backTo="/app/ai/reviews" />
        <div className="h-40 animate-pulse rounded-card bg-white/[.05]" />
        <div className="h-64 animate-pulse rounded-card bg-white/[.05]" />
      </div>
    );
  }
  if (candidate === "error") {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <SubHeader backTo="/app/ai/reviews" />
        <Banner tone="error" eyebrow="ERROR" role="alert" title="候補を取得できませんでした">
          通信を確認して、再読み込みしてください。
        </Banner>
      </div>
    );
  }
  if (candidate === "notfound") {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <SubHeader backTo="/app/ai/reviews" />
        <Banner tone="info" eyebrow="NOT FOUND" title="この候補は存在しないか、閲覧できません">
          <Link to="/app/ai/reviews" className="underline">
            一覧へ戻る
          </Link>
        </Banner>
      </div>
    );
  }

  const meta = PROPOSAL_STATUS[candidate.status];
  const issueRow = issue && issue !== "error" ? issue.row : null;

  return (
    <DetailBody
      candidate={candidate}
      issueRow={issueRow}
      meta={meta}
      onDecided={() => setIssueKey((k) => k + 1)}
      navigate={navigate}
    />
  );
}

/**
 * 詳細の本体（候補と源が揃ってから描画する。確定予定値の編集状態はこの中で持つ）。
 * 決定の後は候補を再取得せず、応答の状態をこの場で表示に反映する（トーストを消さないため）。
 */
function DetailBody({
  candidate,
  issueRow,
  meta: initialMeta,
  onDecided,
  navigate,
}: {
  candidate: AiEvaluationDto;
  issueRow: IssueRow | null;
  meta: { label: string; tone: "ai" | "ok" | "attention" | "neutral" };
  onDecided: () => void;
  navigate: (path: string) => void;
}) {
  const { me } = useMe();
  const out = candidate.outputJson;
  const representative = out.categories.representative;
  /** 決定後の状態（API-31の応答。docs/11語彙で返る）。未決定の間は読み込み時の状態 */
  const [decided, setDecided] = useState<AiEvaluationDto["status"] | null>(null);
  const status = decided ?? candidate.status;
  const meta = status === candidate.status ? initialMeta : PROPOSAL_STATUS[status];
  /** 確定予定値（人の修正の初期値はAI候補。AIが決めるのではなく、候補を出すだけ＝docs/03 §1.1の原則） */
  const [category, setCategory] = useState<string>(representative);
  const [taskEnabled, setTaskEnabled] = useState(true);
  const [taskTitle, setTaskTitle] = useState("AI分類の確認");
  const [assignee, setAssignee] = useState<string>(me.profile.memberId);
  const [dueDate, setDueDate] = useState("");
  const [confirmDecision, setConfirmDecision] = useState<"approve" | "approve_with_edit" | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [members, setMembers] = useState<{ id: string; displayName: string }[] | null>(null);

  const decide = useMutation("API-31");
  const regenerateMutation = useMutation("API-29");

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

  const nameOf = (memberId: string | null) => (memberId ? (members?.find((m) => m.id === memberId)?.displayName ?? null) : null);
  const taskTitleError = taskEnabled && !taskTitle.trim() ? "題名を入力してください" : undefined;
  /** stale（元の記録の更新）: 表示時の比較。点検源は現行版の読み取り契約が無いため比較できない（注記を出す） */
  const stale = status === "pending" && issueRow !== null && issueRow.version !== candidate.sourceVersion;
  const canApprove = status === "pending" && !stale;

  /** 承認要求（docs/06 §3「承認要求はsourceVersion/proposalVersionを含む」） */
  const buildPayload = () => ({
    version: 1, // 提案は追記型で1提案=1行のため、初回決定の前提版は常に1（docs/06 §3）
    sourceVersion: candidate.sourceVersion,
    decision: confirmDecision!,
    confirmedPayload: {
      // 人の確定分類（AI候補から変えていれば必ず送る。候補どおりなら省略＝サーバーが代表分類を確認とみなす）
      ...(confirmDecision === "approve_with_edit" || category !== representative ? { confirmedCategory: category } : {}),
      // 作られるタスク（承認後に作られる。予定の表示値＝確定予定値）
      ...(taskEnabled && taskTitle.trim()
        ? {
            task: {
              title: taskTitle.trim(),
              ...(assignee ? { assigneeMemberId: assignee } : {}),
              ...(dueDate ? { dueDate } : {}),
            },
          }
        : {}),
    },
  });

  const runApprove = async () => {
    const res = await decide.run({ params: { id: candidate.id }, body: buildPayload() });
    if (res) {
      // 応答の保存語彙（docs/11語彙）をこの場で表示に反映する（候補の再取得はしない＝トーストを消さない）
      setDecided(res.data.decision as AiEvaluationDto["status"]);
      setConfirmDecision(null);
      onDecided(); // 源の確定分類を読み直す
    }
  };

  const runReject = async () => {
    const res = await decide.run({
      params: { id: candidate.id },
      body: { version: 1, sourceVersion: candidate.sourceVersion, decision: "reject", confirmedPayload: {}, reviewNote: rejectReason.trim() },
    });
    if (res) {
      setDecided(res.data.decision as AiEvaluationDto["status"]);
      setConfirmReject(false);
      setRejectReason("");
      onDecided();
    }
  };

  /** 再生成（docs/16 T055裁定: API-29を現行版で再依頼。新しいjob/候補。旧候補はstale表示のまま残す） */
  const regenerate = async () => {
    if (!issueRow) return; // 点検源は現行版の読み取り契約が無いため再生成は不可（承認時のサーバー検査が防御）
    const res = await regenerateMutation.run({
      body: { sourceType: candidate.sourceType, sourceId: candidate.sourceId, sourceVersion: issueRow.version, questionVersion: candidate.questionVersion },
    });
    if (res?.status === 202) {
      const job = res.data as unknown as { id: string };
      navigate(
        `/app/ai/reviews?source=${encodeURIComponent(`${candidate.sourceType}:${candidate.sourceId}`)}&job=${encodeURIComponent(job.id)}`,
      );
    }
  };

  const assigneeName = nameOf(assignee) ?? "読み込み中…";
  const confirmedCategoryLabel = CATEGORY_LABELS[category] ?? category;

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <SubHeader backTo="/app/ai/reviews" right={<Chip tone={meta.tone}>{meta.label}</Chip>} />

      <div className="flex flex-col gap-1 px-0.5">
        <span className="font-mono text-[11px] text-ink-muted">
          {SOURCE_TYPE_LABELS[candidate.sourceType]} · 元の版 v{candidate.sourceVersion}
          {issueRow ? ` · 現行版 v${issueRow.version}` : ""}
        </span>
        <h2 className="text-[26px] font-bold leading-[1.3]">分類の候補</h2>
      </div>

      {/* stale（元の記録の更新）。承認操作は無効（強制承認の抜け道は無い）。docs/16 T055裁定① */}
      {stale && (
        <Banner tone="warning" eyebrow="STALE" role="alert" title="元の記録が更新されています">
          <p>
            この候補は古い版（v{candidate.sourceVersion}）をもとに作られています（現行版はv{issueRow!.version}）。承認はできません。
            現行版で再生成するか、このまま残してください（この候補の記録が変わることはありません）。
          </p>
          {issueRow && (
            <Button variant="secondary" busy={regenerateMutation.saving} className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={() => void regenerate()}>
              現行版で再生成
            </Button>
          )}
        </Banner>
      )}
      {status === "pending" && !issueRow && candidate.sourceType !== "issue" && (
        <Notice tone="info" icon="visibility_off">
          点検の現行版は単一件の読み取り契約が無いため、画面では版の一致を確認できません。承認のときにサーバーが版を再検査し、変わっていれば承認は拒否されます（409）。
        </Notice>
      )}

      {/* 原文（docs/06 §3。issue源はAPI-15の本文。点検源は記録の参照だけ） */}
      <Card className="flex flex-col gap-2" aria-label="原文">
        <span className="text-[12px] font-bold text-ink-sub">原文</span>
        {issueRow ? (
          <>
            <span className="text-[14px] font-bold">{issueRow.title}</span>
            <p className="whitespace-pre-wrap text-[13px] leading-[1.7] text-ink-sub">{issueRow.description}</p>
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
              <span className="font-mono">現行版 v{issueRow.version}</span>
              <span>確定分類: {issueRow.confirmedCategory ? (CATEGORY_LABELS[issueRow.confirmedCategory] ?? issueRow.confirmedCategory) : "未確定（人の承認の後に記録されます）"}</span>
              <Link to="/app/issues" className="inline-flex min-h-11 items-center gap-1 rounded-pill bg-white/[.08] px-3 text-[12px] font-bold text-ink lg:min-h-9">
                異常を開く
                <Icon name="chevron_right" className="text-[15px]" />
              </Link>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-1 text-[13px] text-ink-sub">
            <span>点検の原文は一覧（源ごとの点検履歴）の画面接続後に表示します。</span>
            <span className="font-mono text-[11px] text-ink-muted">記録: {candidate.inputSnapshotRef ?? "参照なし"}</span>
          </div>
        )}
      </Card>

      {/* AI候補（紫。docs/03 §1.1「AIは紫、決めるのは人」。prototype 点検登録の候補欄と同じ語彙） */}
      <div className="flex flex-col gap-3 rounded-[22px] bg-ai/[.07] p-4 shadow-[inset_0_0_0_1px_rgba(185,169,255,.26)]" aria-label="AI候補">
        <div className="flex items-center gap-2">
          <Icon name="auto_awesome" className="text-[19px] text-ai" />
          <span className="text-[14px] font-bold text-ink">AIによる分類候補</span>
          <span className="ml-auto rounded-[5px] bg-ai/[.14] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-ai">JEV</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-ink-sub">代表分類</span>
          <Chip tone="ai" size="lg">
            {CATEGORY_LABELS[representative] ?? representative}
          </Chip>
          {out.categories.multipleIssues && <Chip tone="attention">複数の異常のおそれ</Chip>}
        </div>
        {out.categories.probabilities && (
          <ul className="flex flex-col gap-1.5">
            {Object.entries(out.categories.probabilities)
              .sort((a, b) => b[1] - a[1])
              .map(([key, value]) => (
                <li key={key} className="flex items-center gap-2 text-[12px]">
                  <span className="w-24 flex-none truncate text-ink-sub">{CATEGORY_LABELS[key] ?? key}</span>
                  <span aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-pill bg-white/[.08]">
                    <span className="block h-full rounded-pill bg-ai" style={{ width: `${Math.round((value ?? 0) * 100)}%` }} />
                  </span>
                  <span className="w-12 flex-none text-right font-mono text-[11px] text-ink-muted">{Math.round((value ?? 0) * 100)}%</span>
                </li>
              ))}
          </ul>
        )}
        <div className="flex flex-col gap-0.5 text-[12px] text-ink-sub">
          <span>
            保留度（要確認の目安）: <span className="font-mono">{out.needsReview}</span>
          </span>
          <span className="text-[11px] text-ink-muted">AIの保留の度合いです。正答の確率・確約ではありません。</span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-ink-muted">
          <span>モデル {candidate.modelId}</span>
          <span>実モデル版 {candidate.actualModelVersion ?? "—"}</span>
          <span>質問版 {candidate.questionVersion}</span>
          {candidate.usageJson && (
            <span>
              tokens {candidate.usageJson.promptTokens}/{candidate.usageJson.completionTokens}
            </span>
          )}
        </div>
      </div>

      {/* 確定予定値（docs/03 SCR-18「効果対象を承認前に表示」。未承認案は確定済みのようには見せない） */}
      {status === "pending" && (
        <Card className="flex flex-col gap-3" aria-label="承認後の確定（予定）">
          <span className="text-[14px] font-bold">承認後の確定（予定）</span>
          <p className="text-[12px] text-ink-muted">
            承認したときに記録される予定の値です。AIは候補を出すだけで、最終判断は人です。
          </p>
          <label className="hairline flex h-[46px] items-center gap-2 rounded-field bg-white/[.06] px-3">
            <span className="flex-none text-[12px] font-bold text-ink-sub">承認後の確定分類</span>
            <select
              aria-label="承認後の確定分類"
              value={category}
              disabled={!canApprove}
              onChange={(e) => setCategory(e.target.value)}
              className="min-w-0 flex-1 border-none bg-transparent text-[13px] font-medium text-ink outline-none"
            >
              {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex min-h-11 items-center gap-2.5 text-[13px] font-bold text-ink">
            <input
              type="checkbox"
              checked={taskEnabled}
              disabled={!canApprove}
              onChange={(e) => setTaskEnabled(e.target.checked)}
              className="size-5 accent-[var(--color-ember)]"
            />
            確認タスクを作る（承認後に作られます）
          </label>
          {taskEnabled && (
            <div className="flex flex-col gap-2 rounded-[16px] bg-white/[.03] p-3">
              <TextField name="task-title" label="タスクの題名" value={taskTitle} disabled={!canApprove} error={taskTitleError} onChange={(e) => setTaskTitle(e.target.value)} />
              <label className="hairline flex h-[46px] items-center gap-2 rounded-field bg-white/[.06] px-3">
                <span className="flex-none text-[12px] font-bold text-ink-sub">担当</span>
                <select
                  aria-label="タスクの担当"
                  value={assignee}
                  disabled={!canApprove}
                  onChange={(e) => setAssignee(e.target.value)}
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
                  value={dueDate}
                  disabled={!canApprove}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="hairline h-[46px] flex-1 rounded-field bg-white/[.06] px-3 text-[13px] font-medium text-ink"
                />
              </label>
            </div>
          )}
          <Notice tone="info" icon="notifications">
            この源の種別では通知の下書きを作りません（通知の源は予定・お知らせ・点検期限です）。連絡が必要なときはタスク・通知で別途作成してください（宛先の人数はそこで確認します）。
          </Notice>
        </Card>
      )}

      {/* 現権限（docs/06 §3。判定そのものはサーバーが毎要求行う） */}
      <Card className="flex items-start gap-3" aria-label="現権限">
        <span className="mt-0.5 flex-none text-[12px] font-bold text-ink-sub">現権限</span>
        <span className="text-[13px] text-ink-sub">{permissionText(me.roles)}</span>
      </Card>

      {/* 承認済み・却下済みの表示（docs/11「旧決定書換なし」。決定の詳細読取APIは無いため状態と源の記録で示す） */}
      {status !== "pending" && (
        <Card className="flex flex-col gap-2" aria-label="決定の記録">
          <div className="flex items-center gap-2">
            <Chip tone={meta.tone} icon={meta.tone === "ok" ? "task_alt" : undefined} size="lg">
              {meta.label}
            </Chip>
            {status === "rejected" && <span className="text-[13px] text-ink-sub">この候補からは業務への反映はありません。</span>}
          </div>
          {issueRow && (status === "approved" || status === "approved_with_edit") && (
            <span className="text-[13px] text-ink-sub">
              この源の確定分類: {issueRow.confirmedCategory ? (CATEGORY_LABELS[issueRow.confirmedCategory] ?? issueRow.confirmedCategory) : "—（決定の詳細は監査の記録を確認してください）"}
            </span>
          )}
          <span className="text-[12px] text-ink-muted">
            承認で作ったタスク・通知は
            <Link to="/app/tasks-notifications" className="underline">
              設定・通知
            </Link>
            で確認できます。この候補の記録はもう変わりません。
          </span>
        </Card>
      )}

      {/* 操作（docs/03 SCR-18「承認/編集/却下/タスク」。stale・決定済みは押せない表示にする） */}
      {status === "pending" && (
        <div className="flex flex-wrap items-center gap-2" aria-label="承認の操作">
          <Button busy={decide.saving} disabled={!canApprove || (taskEnabled && !taskTitle.trim())} onClick={() => setConfirmDecision("approve")}>
            候補どおり承認
          </Button>
          <Button variant="secondary" busy={decide.saving} disabled={!canApprove || (taskEnabled && !taskTitle.trim())} onClick={() => setConfirmDecision("approve_with_edit")}>
            修正して承認
          </Button>
          <Button variant="secondary" busy={decide.saving} disabled={!canApprove} className="!text-alert" onClick={() => setConfirmReject(true)}>
            却下
          </Button>
          {stale && <span className="text-[12px] font-medium text-attention">元の記録が更新されているため、承認・却下はできません。</span>}
        </div>
      )}
      <MutationStatus state={decide.state} toastBottom={160} />
      <MutationStatus state={regenerateMutation.state} toastBottom={160} />

      {/* 承認の確認（確定予定値を明示してから行う。docs/03「効果対象を承認前に表示」） */}
      {confirmDecision && (
        <ConfirmDialog
          title="このAI候補を確定しますか"
          confirmLabel={confirmDecision === "approve" ? "候補どおり承認" : "修正して承認"}
          busy={decide.saving}
          onConfirm={() => void runApprove()}
          onCancel={() => setConfirmDecision(null)}
        >
          <p>
            承認すると、この候補は{confirmDecision === "approve" ? "AI候補どおり" : "人の修正どおり"}に確定し、業務に反映されます（取り消しはできません。記録は残ります）。
          </p>
          <div className="hairline flex flex-col gap-1.5 rounded-card bg-white/[.04] p-3 text-[13px]">
            <span>
              確定分類: <span className="font-bold">{confirmedCategoryLabel}</span>
            </span>
            {taskEnabled && taskTitle.trim() ? (
              <span>
                作られるタスク: 「{taskTitle.trim()}」／担当 {assignee ? assigneeName : "未定"}
                {dueDate ? `／期限 ${dueDate}` : ""}
              </span>
            ) : (
              <span>作られるタスク: なし</span>
            )}
            <span className="text-[12px] text-ink-muted">通知の下書きはこの操作では作りません（自動送信もありません）。</span>
          </div>
        </ConfirmDialog>
      )}

      {/* 却下（理由必須。効果は0。docs/06 §3「rejectはconfirmedPayload空・理由必須で効果0」） */}
      {confirmReject && (
        <ConfirmDialog
          title="このAI候補を却下しますか"
          confirmLabel="却下する"
          busy={decide.saving}
          danger
          confirmDisabled={!rejectReason.trim()}
          onConfirm={() => void runReject()}
          onCancel={() => {
            setConfirmReject(false);
            setRejectReason("");
          }}
        >
          <p>却下すると、この候補からはタスクも分類の記録も作られません（候補と理由の記録は残ります）。</p>
          <textarea
            aria-label="却下の理由（必須）"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="例: 現地で確認したところ該当しなかった"
            className="hairline min-h-24 w-full resize-none rounded-[16px] bg-white/[.06] px-3.5 py-3 text-[14px] font-medium text-ink placeholder:text-ink-dim"
          />
          {!rejectReason.trim() && <p className="text-[12px] font-medium text-attention">理由を入力してください</p>}
        </ConfirmDialog>
      )}
    </div>
  );
}
