import { useEffect, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { api, apiCall, type ApiInput } from "../../api";
import { MutationStatus } from "../../components/MutationStatus";
import { PageTitle, SubHeader } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, Notice } from "../../components/ui";
import { useMutation } from "../../useMutation";
import type { AiEvaluationDto } from "../../../shared/contracts/ai";
import type { Job } from "../../../shared/contracts/common";
import { AiReviewDetail } from "./AiReviewDetail";

/**
 * AIレビュー（T055、SCR-18 /app/ai/reviews。docs/03 §2「元版変化はstale、効果対象を承認前に表示」、
 * docs/06 §3「レビューには原文、元の版、AI候補、確定予定値、対象タスク/通知、現権限を表示」）。
 *
 * - 一覧（API-30。PER-10）＋源（異常・点検）ごとのレビューパネル＋候補の詳細（別入口 /:id。AiReviewDetail）を
 *   同じSCRの別入口で扱う（お知らせSCR-16と同じ方式。prototypeにSCR-18専用画面が無いため共通部品で構成し、
 *   「AIは紫、決めるのは人」の語彙（docs/03 §1.1）を候補の表示に使う）。
 * - 処理中の候補はまだai_evaluationsに行が無いため、源のパネルでAPI-29の受付時に返されたjob（202）を
 *   API-86で2.5秒ごとに読み直す（NotificationApprovalの配送結果と同じ流儀）。manual_review/timeout/staleは
 *   「保留（AIだけで決めない）」の語彙で表示し、完了（成功）を偽装しない（docs/03 §1「202は処理中であり完了ではない」）。
 * - 単一件の読み取り契約が無いため、源の異常はAPI-15の一覧をページ送りで探す（上限10ページ。docs/03 §1.1-11と同じ流儀）。
 */

export const PROPOSAL_STATUS: Record<AiEvaluationDto["status"], { label: string; tone: "ai" | "ok" | "attention" | "neutral" }> = {
  pending: { label: "承認待ち", tone: "ai" },
  approved: { label: "承認済み", tone: "ok" },
  approved_with_edit: { label: "修正承認済み", tone: "ok" },
  rejected: { label: "却下", tone: "neutral" },
  stale: { label: "要再確認", tone: "attention" },
};

/** 分類の語彙（docs/06 §2のcriteriaどおり。確定分類も同じ語彙で表示する） */
export const CATEGORY_LABELS: Record<string, string> = {
  equipment_issue: "設備の問題",
  access_obstruction: "接近障害",
  missing_equipment: "収納物不足",
  no_issue: "異常報告なし",
  other: "その他",
};

export const SOURCE_TYPE_LABELS: Record<AiEvaluationDto["sourceType"], string> = {
  facility_inspection: "施設の点検",
  asset_inspection: "資産の点検",
  issue: "異常",
  // 横断AIの提案（T068。確認・承認はAIアシスタント画面〔SCR-28〕で行う旨の案内表示。docs/16 T068。PH5レビューC中3）
  assistant: "横断AIの提案",
};

/** URLの ?source= （例: issue:<id>）を解釈する。未知の形式はnull（到達できない画面を作らない） */
export function parseSourceParam(value: string | null): { sourceType: AiEvaluationDto["sourceType"]; sourceId: string } | null {
  if (!value) return null;
  const i = value.indexOf(":");
  if (i <= 0) return null;
  const sourceType = value.slice(0, i);
  const sourceId = value.slice(i + 1);
  if (!(sourceType in SOURCE_TYPE_LABELS) || !sourceId) return null;
  return { sourceType: sourceType as AiEvaluationDto["sourceType"], sourceId };
}

/** API-15の1行（provisional DTO。画面で使う列だけを型にする） */
export interface IssueRow {
  id: string;
  version: number;
  target: { type: "facility" | "vehicle" | "equipment"; id: string };
  title: string;
  description: string;
  status: string;
  confirmedCategory: string | null;
}

/**
 * 異常をIDで探す（単一件のGET契約が無いため一覧のページ送りで探す。docs/03 §1.1-11と同じ打ち切りつき）。
 * truncated=trueのときは続きを読めていない（画面でその旨を出す。黙って切り捨てない）。
 */
export async function findIssue(id: string): Promise<{ row: IssueRow | null; truncated: boolean }> {
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await apiCall("API-15", {
      query: { limit: 200, ...(cursor ? { cursor } : {}) } as ApiInput<"API-15">["query"],
    });
    const rows = res.data as unknown as IssueRow[];
    const found = rows.find((r) => r.id === id);
    if (found) return { row: found, truncated: false };
    if (!res.nextCursor) return { row: null, truncated: false };
    cursor = res.nextCursor;
  }
  return { row: null, truncated: true };
}

/** ある源の候補を探す（API-30にsourceIdの絞り込みが無いためsourceTypeで読んで画面で絞る。上限20ページ） */
export async function findCandidatesForSource(
  sourceType: AiEvaluationDto["sourceType"],
  sourceId: string,
): Promise<{ items: AiEvaluationDto[]; truncated: boolean }> {
  const items: AiEvaluationDto[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await apiCall("API-30", {
      query: { limit: 50, sourceType, ...(cursor ? { cursor } : {}) } as ApiInput<"API-30">["query"],
    });
    items.push(...(res.data as unknown as AiEvaluationDto[]).filter((r) => r.sourceId === sourceId));
    if (!res.nextCursor) return { items, truncated: false };
    cursor = res.nextCursor;
  }
  return { items, truncated: true };
}

/** 候補が無いjobの保留理由（jobのerror_code。docs/06 §2「原本を失わず失敗表示する」） */
export const JOB_ERROR_LABELS: Record<string, string> = {
  ai_unavailable: "この環境ではAIを使えないため、自動分類は保留になりました（元の記録は変わっていません）。",
  ai_output_invalid: "AIの応答が契約外だったため、保留になりました（元の記録は変わっていません）。",
  input_too_large: "元の記録が大きすぎるため、保留になりました（元の記録は変わっていません）。",
  budget_stopped: "AIの月次上限に達したため、人の確認用に保留になりました（元の記録は変わっていません）。停止の解除は運用側で行います。",
  source_changed: "依頼の後に元の記録が変わったため、この結果は採用しません。現行版で再依頼してください。",
  requester_unauthorized: "依頼した人が権限を失ったため、この結果は採用しません。",
  question_version_unknown: "質問の版が廃止されたため、この結果は採用しません。",
  source_missing: "元の記録が見つからないため、この結果は採用しません。",
};

/** SCR-18の別入口（/app/ai/reviews、/:id）。パスで一覧＋源パネル/詳細を出し分ける */
export function AiReviewsPage() {
  const params = useParams<{ id?: string }>();
  if (params.id) return <AiReviewDetail id={params.id} />;
  return <AiReviewList />;
}

/** 一覧（API-30）。?source=（と?job=）があるときは源のレビューパネルを上に出す */
function AiReviewList() {
  const [searchParams] = useSearchParams();
  const source = parseSourceParam(searchParams.get("source"));
  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <PageTitle eyebrow="2026 · AI REVIEW" className="lg:[&_h2]:hidden">
        AIレビュー
      </PageTitle>
      {source ? <SourceReviewPanel sourceType={source.sourceType} sourceId={source.sourceId} /> : null}
      <CandidateList />
    </div>
  );
}

/**
 * 源（異常・点検）ごとのレビューパネル。候補が無い間は依頼・処理中・保留を示し、
 * 候補ができたら一覧へ出す（docs/06 §3のレビュー表示本体は詳細（AiReviewDetail）が持つ）。
 */
function SourceReviewPanel({ sourceType, sourceId }: { sourceType: AiEvaluationDto["sourceType"]; sourceId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const jobId = searchParams.get("job");
  const [issue, setIssue] = useState<{ row: IssueRow | null; truncated: boolean } | "loading" | "error" | null>(
    sourceType === "issue" ? "loading" : null,
  );
  const [candidates, setCandidates] = useState<{ items: AiEvaluationDto[]; truncated: boolean } | "loading" | "error">("loading");
  const [job, setJob] = useState<Job | null>(null);
  const [jobAttempts, setJobAttempts] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const request = useMutation("API-29");

  // 源の異常（現行版・原文）を取る（点検源は単一件の読み取り契約が無いため読まない）
  useEffect(() => {
    if (sourceType !== "issue") return;
    let alive = true;
    setIssue("loading");
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
  }, [sourceType, sourceId, reloadKey]);

  // 源の候補（API-30）。jobの完了後にも読み直す
  useEffect(() => {
    let alive = true;
    setCandidates("loading");
    void (async () => {
      try {
        const found = await findCandidatesForSource(sourceType, sourceId);
        if (alive) setCandidates(found);
      } catch {
        if (alive) setCandidates("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [sourceType, sourceId, reloadKey]);

  const loaded = candidates !== "loading" && candidates !== "error" ? candidates : null;
  const hasCandidate = loaded !== null && loaded.items.length > 0;
  const jobTerminal = (status: string | undefined) => status === "succeeded" || status === "manual_review" || status === "stale" || status === "cancelled";
  /** 依頼中のjob（URLの?job=）。候補が既に在っても（再生成の2本目）動かす */
  const jobActive = jobId !== null && !jobTerminal(job?.status);

  // 処理中のjob（API-86）を2.5秒ごとに読み直す（NotificationApprovalの配送結果と同じ流儀）。
  // terminal（succeeded/manual_review/stale/cancelled）で止める。succeededのときは候補も読み直す
  useEffect(() => {
    if (!jobActive || jobAttempts >= 480) return; // 約20分で打ち切り（毎分Cronの環境では完了する。打ち切り後は再読み込みを案内）
    let alive = true;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const j = (await api("API-86", { params: { id: jobId! } })) as unknown as Job;
          if (!alive) return;
          setJob(j);
          setJobAttempts((n) => n + 1);
          if (j.status === "succeeded") setReloadKey((k) => k + 1); // 候補の再読込
        } catch {
          /* 次の再読込で拾う（結果を確認できない画面状態にはしない） */
        }
      })();
    }, 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [jobActive, jobAttempts, jobId]);

  /** 分類を依頼（API-29。202=jobの受付）。依頼後はURLにjobを持たせて再読込に強くする。
   *  横断AIの提案（assistant源・T068）は分類の再依頼を持たない（提案の作成はAPI-77） */
  const requestClassification = async (currentVersion: number) => {
    if (sourceType === "assistant") return;
    const res = await request.run({
      body: { sourceType, sourceId, sourceVersion: currentVersion, questionVersion: "v1" },
    });
    if (res?.status === 202) {
      const j = res.data as unknown as { id: string };
      const next = new URLSearchParams(searchParams);
      next.set("job", j.id);
      setSearchParams(next, { replace: true });
    }
  };

  const issueLoaded = issue !== null && issue !== "loading" && issue !== "error";
  const issueRow = issueLoaded ? issue.row : null;
  const currentVersion = issueRow?.version ?? null;
  const jobDone = job !== null && jobTerminal(job.status);
  const jobSucceededButEmpty = job?.status === "succeeded" && !hasCandidate;

  return (
    <section className="flex flex-col gap-2" aria-label="この源のAIレビュー">
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="ai" icon="auto_awesome" size="lg">
            {SOURCE_TYPE_LABELS[sourceType]}のAIレビュー
          </Chip>
          {currentVersion !== null && <span className="font-mono text-[11px] text-ink-muted">現行版 v{currentVersion}</span>}
        </div>

        {/* 原文（issue源はAPI-15の本文。docs/06 §3「レビューには原文…を表示」） */}
        {issueRow && (
          <div className="flex flex-col gap-1">
            <span className="text-[14px] font-bold">{issueRow.title}</span>
            <p className="text-[13px] leading-[1.7] text-ink-sub">{issueRow.description}</p>
          </div>
        )}
        {issueLoaded && !issueRow && (
          <p className="text-[13px] text-ink-muted">
            {issue!.truncated
              ? "この源の記録は一覧の続きにあります（読み取り上限に達しました）。時間をおいて開き直してください。"
              : "この源の記録は存在しないか、閲覧できません。"}
          </p>
        )}
        {issue === "error" && <p className="text-[13px] text-attention">源の記録を取得できませんでした（通信を確認してください）。</p>}
        {sourceType !== "issue" && (
          <p className="text-[12px] text-ink-muted">
            点検の原文は一覧（源ごとの点検履歴）の画面接続後に表示します。現状は異常（点検管理）の源から依頼・承認できます。
          </p>
        )}

        {/* 処理中のjob（依頼の202＝jobの受付。docs/03 §1「202は処理中であり完了ではない」。
            再生成の2本目（既存候補がある間も）は候補の一覧の上にこの表示を出す） */}
        {jobActive && (
          <Notice tone="ai" icon="hourglass_top" role="status">
            <span className="font-bold">AIの処理中です</span>　受け付けました。完了するまで新しい候補は現れません（完了ではありません）。
          </Notice>
        )}

        {/* 候補の一覧（この源。新しい順） */}
        {candidates === "loading" && <div className="h-14 animate-pulse rounded-[18px] bg-white/[.05]" />}
        {candidates === "error" && (
          <Banner tone="error" eyebrow="ERROR" role="alert" title="候補の一覧を取得できませんでした">
            通信を確認して、再読み込みしてください。
          </Banner>
        )}
        {loaded && loaded.items.length > 0 && (
          <ul className="flex flex-col gap-2">
            {loaded.items.map((c) => {
              const meta = PROPOSAL_STATUS[c.status];
              return (
                <li key={c.id}>
                  <Link
                    to={`/app/ai/reviews/${c.id}`}
                    className="hairline flex min-h-11 items-center gap-3 rounded-[18px] bg-white/[.04] p-3 hover:bg-white/[.07]"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-[13px] font-bold">
                        分類の候補 v{c.sourceVersion}
                        <span className="ml-2 font-normal text-ink-sub">
                          {c.sourceType === "assistant" ? "横断AIの提案" : CATEGORY_LABELS[c.outputJson.categories.representative]}
                        </span>
                      </span>
                      <span className="font-mono text-[11px] text-ink-muted">{c.createdAt.slice(0, 16).replace("T", " ")}</span>
                    </span>
                    <Chip tone={meta.tone}>{meta.label}</Chip>
                    <Icon name="chevron_right" className="flex-none text-[18px] text-ink-dim" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {loaded?.truncated && (
          <p className="text-[12px] text-ink-muted">この源の候補は読み取り上限を超えました。古い候補は時間をおいて開き直して確認してください。</p>
        )}

        {/* 候補が無い間の状態（依頼・保留。処理中は上の表示。docs/06 §2「原本を失わず失敗表示する」） */}
        {!hasCandidate && loaded && (
          <div className="flex flex-col gap-2">
            {job === null && !jobId && currentVersion !== null && (
              <div className="flex flex-col gap-1.5">
                <Button busy={request.saving} onClick={() => void requestClassification(currentVersion)}>
                  AI分類を依頼
                </Button>
                <p className="text-[12px] text-ink-muted">
                  AIに元の記録の分類を依頼します（最小限の本文だけを送ります）。候補は人の承認待ちとして保存され、承認するまで業務は変わりません。
                </p>
              </div>
            )}
            {jobDone && job!.status !== "succeeded" && (
              <Banner tone="warning" eyebrow="HOLD" role="status" title="保留（AIだけで決めない）">
                <p>{JOB_ERROR_LABELS[job!.errorCode ?? ""] ?? `保留になりました（${job!.errorCode ?? "理由の記録なし"}）。元の記録は変わっていません。`}</p>
                {currentVersion !== null && (
                  <Button
                    variant="secondary"
                    busy={request.saving}
                    className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11"
                    onClick={() => void requestClassification(currentVersion)}
                  >
                    現行版で再依頼
                  </Button>
                )}
              </Banner>
            )}
            {jobSucceededButEmpty && (
              <Banner tone="warning" eyebrow="STATE" title="候補の読み取りを更新してください">
                jobは完了しましたが、候補がまだ見つかりません。時間をおいて開き直してください。
              </Banner>
            )}
            {jobAttempts >= 480 && !jobDone && (
              <Banner tone="warning" eyebrow="WAIT" title="時間内に完了しませんでした">
                処理の完了を確認できません。時間をおいて開き直してください（受付は残っています）。
              </Banner>
            )}
          </div>
        )}
      </Card>
      <MutationStatus state={request.state} toastBottom={160} />
    </section>
  );
}

/** 候補の一覧（API-30。作成降順のkeyset。状態はURLクエリにもつ） */
function CandidateList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const status = searchParams.get("status") ?? "";

  const [items, setItems] = useState<AiEvaluationDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");

  const query = (): Partial<ApiInput<"API-30">["query"]> => ({
    limit: 50,
    ...(status ? { status: status as AiEvaluationDto["status"] } : {}),
  });

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    setPhase("loading");
    setItems([]);
    void (async () => {
      try {
        const res = await apiCall("API-30", { query: query() as ApiInput<"API-30">["query"] }, { signal: ctrl.signal });
        if (!alive) return;
        setItems(res.data as unknown as AiEvaluationDto[]);
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
      const res = await apiCall("API-30", { query: { ...query(), cursor } as ApiInput<"API-30">["query"] });
      setItems((prev) => [...prev, ...(res.data as unknown as AiEvaluationDto[])]);
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

  return (
    <section className="flex flex-col gap-3" aria-label="AI候補の一覧">
      <SubHeader title="候補の一覧" sub="AIの候補は人の承認待ちです。承認するまで業務は変わりません。" />
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
            {Object.entries(PROPOSAL_STATUS).map(([value, meta]) => (
              <option key={value} value={value}>
                {meta.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {phase === "loading" && (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-20 animate-pulse rounded-[20px] bg-white/[.05]" />
          ))}
        </div>
      )}
      {phase === "error" && (
        <Banner tone="error" eyebrow="ERROR" role="alert" title="候補の一覧を取得できませんでした">
          通信を確認して、再読み込みしてください。
        </Banner>
      )}
      {phase === "ready" && items.length === 0 && (
        <Banner tone="info" eyebrow="EMPTY" title="AIの候補はまだありません">
          点検や異常の記録から「AI分類を依頼」すると、ここに承認待ちの候補が現れます。
        </Banner>
      )}

      <ul className="flex flex-col gap-2">
        {items.map((c) => {
          const meta = PROPOSAL_STATUS[c.status];
          return (
            <li key={c.id}>
              <Link
                to={`/app/ai/reviews/${c.id}`}
                className="flex items-center gap-3 rounded-[20px] bg-white/[.04] p-3.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,.07)] hover:bg-white/[.07]"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex items-center gap-2">
                    <Chip tone={meta.tone} icon={c.status === "pending" ? "auto_awesome" : undefined}>
                      {meta.label}
                    </Chip>
                    <span className="font-mono text-[11px] text-ink-muted">
                      {SOURCE_TYPE_LABELS[c.sourceType]} v{c.sourceVersion}
                    </span>
                  </span>
                  <span className="truncate text-[15px] font-bold">
                    {c.sourceType === "assistant"
                      ? "横断AIの提案（参照した記録と書込候補つき）"
                      : CATEGORY_LABELS[c.outputJson.categories.representative]}
                  </span>
                  <span className="truncate font-mono text-[11px] text-ink-muted">{c.createdAt.slice(0, 16).replace("T", " ")}</span>
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
    </section>
  );
}
