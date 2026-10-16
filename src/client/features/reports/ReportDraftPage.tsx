import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api, apiCall, ApiError, type ApiInput } from "../../api";
import { ConfirmDialog } from "../../components/Overlay";
import { MutationStatus } from "../../components/MutationStatus";
import { PageTitle, SubHeader } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, Notice, TextArea } from "../../components/ui";
import { useMe } from "../../me";
import { useMutation } from "../../useMutation";
import type { ActivityDetailDto } from "../../../shared/contracts/operations";
import type { ActivityDto } from "../../../shared/contracts/operations";
import type { Job } from "../../../shared/contracts/common";
import type { ReportHistoryDto, ReportVersionDto } from "../../../shared/contracts/content";
import { ACTIVITY_STATUS, kindColor } from "../activities/ActivitiesPage";
import { fmtDay, fmtHM, fmtInstant } from "../activities/time";
import { LeaveConfirm } from "../../components/LeaveConfirm";
import { REPORT_VERSION_STATUS, ReportVersionDiff } from "./ReportVersionDiff";

/**
 * 報告書の生成・編集・版比較・承認・出力画面（T059、SCR-19 /app/reports/:id/draft、別入口 /app/reports。
 * docs/03 §2 SCR-19、docs/06 §4「人編集→新版→承認→配布の順」、docs/11 報告書/文書版）。
 *
 * - 一覧（/app/reports）は実績のある活動（API-05 actual=true）を行で出し、行で `?activity=` を選ぶと
 *   「この活動の報告書」パネル（API-07のreportsで帳票を解決。帳票の一覧APIは無い）を一覧の上に出す
 *   （AIレビューSCR-18の?source=と同じ流儀）。PCも一覧→詳細の遷移にする（併置は作らない＝docs/03 §1.1に記録）。
 * - 生成依頼（API-32）の202は**受付であり報告書の完成ではない**（docs/03 §1「202は処理中であり完了ではない」）。
 *   job（API-86）を2.5秒ごとに読み「処理中」と出し、保留（manual_review/stale）は理由コードの日本語付きで
 *   「保留（AIだけで決めない）」と出す。e2eの環境（TEST_AI_FAKE=1）では報告書生成のAI bindingが無いため
 *   保留に落ちる＝偽の下書きを作らない（T057の設計。docs/evidence/V04-llm.md）。
 * - 人数/時刻は元実績と比較して表示する（docs/03 SCR-19「人数/時刻は元実績と比較」。元実績のサーバー計算と
 *   同じ集計〔実参加行数・JST時刻〕をAPI-07の実績から組み立てる。参加行が無い・時刻が無いは「未記載」で
 *   補完しない＝docs/06 §4）。版の保存値（sourceVersions）と現行の元実績がずれていれば「元の実績が更新されて
 *   います」を出し、申請・承認の操作を無効化する（T055と同じ二段構え。承認時のサーバー検査409が最終防御）。
 * - 編集は常に新しい版（API-59。旧版は不変＝docs/11）、承認は確認ダイアログで対象版と元実績の版を明示してから
 *   （API-60 approve。一版一決定）、差戻しは理由必須（changes_requested。決定行は作らない）。
 * - 出力（API-61）は承認済み版だけが出せる。ダウンロードはfetch→blob→a[download]（添付表示と同じ流儀）で、
 *   Content-Dispositionのfilename（report-<id>-r<版>.<ext>）をそのまま使う。
 */

/**
 * 様式の版（allowlist設定artifact。config/report-templates/manifest.json）。正式様式はD20承認後に
 * 差し替える（docs/14 D20）。様式の一覧APIは無いため画面はこの版を固定で使い、架空の検証設定である旨を出す
 */
const REPORT_TEMPLATE_VERSION = "test-activity-v1";

/** 生成jobの保留理由の日本語（jobのerror_code。docs/06 §2「原本を失わず失敗表示する」） */
const REPORT_JOB_ERROR_LABELS: Record<string, string> = {
  ai_unavailable: "この環境ではAIを使えないため、下書きの自動作成は保留になりました（元の実績は変わっていません）。手動で作成できます。",
  ai_output_invalid: "AIの応答が契約外だったため、保留になりました（元の実績は変わっていません）。手動で作成できます。",
  ai_run_failed: "AIの呼び出しが失敗したため、再試行しています。完了するまで報告書は現れません。",
  input_too_large: "元の実績が大きすぎるため、保留になりました（元の実績は変わっていません）。手動で作成できます。",
  source_changed: "依頼の後に元の実績が変わったため、この結果は採用しません。現行版で再依頼してください。",
  requester_unauthorized: "依頼した人が権限を失ったため、この結果は採用しません。",
  template_version_unknown: "様式の版が使えなくなったため、この結果は採用しません。",
  source_missing: "元の実績が見つからないため、この結果は採用しません。",
  fabricated_facts: "AIの出力に実績に無い人数・時刻が含まれていたため、保留になりました（元の実績は変わっていません）。手動で作成してください。",
};

/** SCR-19の別入口。パスで一覧（/app/reports）と詳細（/:id/draft）を出し分ける */
export function ReportDraftPage() {
  const params = useParams<{ id?: string }>();
  if (params.id) return <ReportDetail id={params.id} />;
  return <ReportList />;
}

/**
 * 一覧（/app/reports）。実績のある活動（報告書の元）を行で出す。
 * `?activity=` があるときは「この活動の報告書」パネルを一覧の上に出す（AIレビューの?source=と同じ流儀）。
 */
function ReportList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activityId = searchParams.get("activity");

  const [items, setItems] = useState<ActivityDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;
    setPhase("loading");
    setItems([]);
    void (async () => {
      try {
        // 実績の記録がある活動だけ（報告書の元になるもの。API-05のactual検索＝docs/03 SCR-08）
        const res = await apiCall(
          "API-05",
          { query: { limit: 50, actual: "true" } as ApiInput<"API-05">["query"] },
          { signal: ctrl.signal },
        );
        if (!alive) return;
        setItems(res.data as unknown as ActivityDto[]);
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
  }, []);

  const loadMore = async () => {
    if (!cursor) return;
    setPhase("loading");
    try {
      const res = await apiCall("API-05", {
        query: { limit: 50, actual: "true", cursor } as ApiInput<"API-05">["query"],
      });
      setItems((prev) => [...prev, ...(res.data as unknown as ActivityDto[])]);
      setCursor(res.nextCursor ?? null);
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  };

  const select = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("activity", id);
    setSearchParams(next, { replace: false });
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <PageTitle eyebrow="2026 · ACTIVITY LOG" className="lg:[&_h2]:hidden">
        活動記録
      </PageTitle>
      {activityId ? <ActivityReportsPanel key={activityId} activityId={activityId} /> : null}

      <section className="flex flex-col gap-3" aria-label="実績のある活動">
        <div className="flex flex-col gap-0.5 px-0.5">
          <h3 className="text-[14px] font-bold">実績のある活動</h3>
          <p className="text-[12px] text-ink-muted">活動記録（報告書）は、実績の記録がある活動から作ります。行を選ぶと報告書の作成・確認ができます。</p>
        </div>
        {phase === "loading" && (
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((n) => (
              <div key={n} className="h-16 animate-pulse rounded-[20px] bg-white/[.05]" />
            ))}
          </div>
        )}
        {phase === "error" && (
          <Banner tone="error" eyebrow="ERROR" role="alert" title="活動の一覧を取得できませんでした">
            通信を確認して、再読み込みしてください。
          </Banner>
        )}
        {phase === "ready" && items.length === 0 && (
          <Banner tone="info" eyebrow="EMPTY" title="実績の記録がある活動はまだありません">
            予定・活動の詳細から実績を記録すると、ここに現れます。
          </Banner>
        )}
        <ul className="flex flex-col gap-2">
          {items.map((a) => {
            const meta = ACTIVITY_STATUS[a.status];
            return (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => select(a.id)}
                  aria-pressed={activityId === a.id}
                  className="hairline flex w-full items-center gap-3 rounded-[20px] bg-white/[.04] p-3.5 text-left hover:bg-white/[.07]"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex items-center gap-2">
                      <Chip tone={meta.tone}>{meta.label}</Chip>
                      <span className="font-mono text-[11px] text-ink-muted" style={{ color: kindColor(a.kind) }}>
                        {a.kind}
                      </span>
                    </span>
                    <span className="truncate text-[15px] font-bold">{a.title}</span>
                    <span className="font-mono text-[11px] text-ink-muted">
                      {fmtDay(a.plannedStartsAt)} {fmtHM(a.plannedStartsAt)}
                    </span>
                  </span>
                  <Icon name="chevron_right" className="flex-none text-[20px] text-ink-dim" />
                </button>
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
    </div>
  );
}

/**
 * 「この活動の報告書」パネル。既存の帳票（API-07のreports）を出し、無ければ作る（AI生成／手動）。
 * 権限の判定そのものはサーバーが毎要求行う（PER-09生成依頼／PER-04手動作成。画面は幹部・管理者に操作を出す）。
 */
function ActivityReportsPanel({ activityId }: { activityId: string }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const jobId = searchParams.get("job");
  const navigate = useNavigate();
  const { me } = useMe();
  /** PER-03/04/09/10は幹部・管理者が所属内で持つ（docs/10）。担当scopeは画面からは判定できないためサーバーが拒否する */
  const canManage = me.roles.includes("officer") || me.roles.includes("admin");

  const [activity, setActivity] = useState<ActivityDetailDto | "loading" | "error">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualText, setManualText] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [jobAttempts, setJobAttempts] = useState(0);

  const generate = useMutation("API-32");
  const manual = useMutation("API-62");

  useEffect(() => {
    let alive = true;
    setActivity("loading");
    void (async () => {
      try {
        const data = (await api("API-07", { params: { id: activityId } })) as unknown as ActivityDetailDto;
        if (alive) setActivity(data);
      } catch {
        if (alive) setActivity("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [activityId, reloadKey]);

  const loaded = activity !== "loading" && activity !== "error" ? activity : null;
  const reports = loaded?.reports ?? [];
  const result = loaded?.result ?? null;

  /** 処理中のjob（API-86）を2.5秒ごとに読み直す（AiReviewsPageのSourceReviewPanelと同じ流儀） */
  const jobTerminal = (status: string | undefined) =>
    status === "succeeded" || status === "manual_review" || status === "stale" || status === "cancelled";
  const jobActive = jobId !== null && !jobTerminal(job?.status);
  useEffect(() => {
    if (!jobActive || jobAttempts >= 480) return; // 約20分で打ち切り（打ち切り後は再読み込みを案内）
    let alive = true;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const j = (await api("API-86", { params: { id: jobId! } })) as unknown as Job;
          if (!alive) return;
          setJob(j);
          setJobAttempts((n) => n + 1);
          if (j.status === "succeeded") setReloadKey((k) => k + 1); // 帳票の再読込（生成が成功したときだけ）
        } catch {
          /* 次の再読込で拾う */
        }
      })();
    }, 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [jobActive, jobAttempts, jobId]);

  /** AI生成を依頼（API-32。202=jobの受付。完了ではない）。依頼後はURLにjobを持たせて再読込に強くする */
  const requestGeneration = async () => {
    if (!result) return;
    const res = await generate.run({
      body: { activityId, resultVersion: result.version, templateVersion: REPORT_TEMPLATE_VERSION },
    });
    if (res?.status === 202) {
      const j = res.data as unknown as { id: string };
      const next = new URLSearchParams(searchParams);
      next.set("job", j.id);
      setSearchParams(next, { replace: true });
    }
  };

  /** 手動で下書きを作る（API-62。本文は空欄でもよく、空欄のままの必須欄は「未記載」として記録される） */
  const createManualDraft = async () => {
    if (!result) return;
    const res = await manual.run({
      body: { activityId, resultVersion: result.version, templateVersion: REPORT_TEMPLATE_VERSION, text: manualText },
    });
    if (res) {
      const history = res.data as unknown as ReportHistoryDto;
      setManualOpen(false);
      setManualText("");
      // stateの反映（dirty=falseへのコミット）を待ってから遷移する（保存後のnavigateが自分のLeaveConfirmに
      // ブロックされないように。ActivityEditorPageの「保存後に待ってからnavigate」と同じ流儀）
      await new Promise((r) => setTimeout(r, 1000));
      navigate(`/app/reports/${history.report.id}/draft`);
    }
  };

  const jobDone = job !== null && jobTerminal(job.status);

  return (
    <section className="flex flex-col gap-2" aria-label="この活動の報告書">
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone="ai" icon="description" size="lg">
            この活動の報告書
          </Chip>
          {loaded && (
            <Link to={`/app/activities/${activityId}`} className="inline-flex min-h-11 items-center gap-1 rounded-pill bg-white/[.08] px-3 text-[12px] font-bold text-ink lg:min-h-9">
              活動詳細
              <Icon name="chevron_right" className="text-[15px]" />
            </Link>
          )}
        </div>

        {activity === "loading" && <div className="h-20 animate-pulse rounded-[18px] bg-white/[.05]" />}
        {activity === "error" && (
          <Banner tone="error" eyebrow="ERROR" role="alert" title="活動を取得できませんでした">
            通信を確認して、再読み込みしてください。
          </Banner>
        )}

        {loaded && (
          <>
            {/* 既存の帳票（reports。AI生成と手動の区別は版のmodel_idで詳細に示す） */}
            {reports.length > 0 && (
              <ul className="flex flex-col gap-2">
                {reports.map((r) => (
                  <li key={r.id}>
                    <Link
                      to={`/app/reports/${r.id}/draft`}
                      className="hairline flex min-h-11 items-center gap-3 rounded-[18px] bg-white/[.04] p-3 hover:bg-white/[.07]"
                    >
                      <Icon name="description" className="flex-none text-[20px] text-ai" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-[13px] font-bold">報告書を開く</span>
                        <span className="font-mono text-[11px] text-ink-muted">{r.updatedAt.slice(0, 16).replace("T", " ")}</span>
                      </span>
                      <Chip tone={r.currentApprovedVersionId !== null ? "ok" : "neutral"}>
                        {r.currentApprovedVersionId !== null ? "承認済み版あり" : "下書き"}
                      </Chip>
                      <Icon name="chevron_right" className="flex-none text-[18px] text-ink-dim" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            {/* 作成（実績のある活動だけ。docs/05 API-62「実績が無い場合は422」） */}
            {canManage && result !== null && (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-2">
                  <Button busy={generate.saving} className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={() => void requestGeneration()}>
                    AIで下書き生成
                  </Button>
                  <Button variant="secondary" className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={() => setManualOpen((v) => !v)}>
                    手動で作成
                  </Button>
                </div>
                <p className="text-[12px] text-ink-muted">
                  AIは元の実績から下書きを作ります（最小限の本文だけを送ります）。人数・時刻は元の実績の値を使い、不足は「未記載」のままにします。
                  様式は架空の検証設定（{REPORT_TEMPLATE_VERSION}）です。正式様式は決定（D20）の後に差し替えます。
                </p>
                {/* 手動作成フォーム（開いたときだけ。本文は空欄でよい＝docs/05 API-62） */}
                {manualOpen && (
                  <div className="flex flex-col gap-2 rounded-[16px] bg-white/[.03] p-3">
                    <TextArea
                      name="manual-report-text"
                      label="実施内容"
                      value={manualText}
                      onChange={(e) => setManualText(e.target.value)}
                      placeholder="例: ポンプ車操法と放水訓練を実施した"
                    />
                    <p className="text-[12px] text-ink-muted">
                      空白のみの本文で作ると、この欄は「未記載」として記録されます（推測で補完しません。完全に空の本文は保存できません）。
                    </p>
                    <Button busy={manual.saving} className="!h-[46px] max-lg:min-h-11 !text-[13px]" onClick={() => void createManualDraft()}>
                      下書きを作成
                    </Button>
                    {manual.state.kind === "rejected" && (
                      <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
                        この状態では作成できません。実績の記録が変わっているかもしれないため、再読み込みして確認してください。
                      </div>
                    )}
                    {manual.state.kind === "unknown" && (
                      <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
                        結果を確認できません。同じ内容で再送しても二重には登録されません。
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
            {canManage && result === null && (
              <p className="text-[13px] text-ink-sub">報告書は、実績の記録がある活動から作れます。まず活動詳細で実績を記録してください。</p>
            )}
            {!canManage && reports.length === 0 && (
              <p className="text-[13px] text-ink-sub">報告書はまだありません（担当の幹部が作成します。承認済みの版はここから開けます）。</p>
            )}

            {/* 処理中のjob（受付の202。docs/03 §1「202は処理中であり完了ではない」） */}
            {jobActive && (
              <Notice tone="ai" icon="hourglass_top" role="status">
                <span className="font-bold">AIが下書きを作成しています</span>　受け付けました。完了するまで報告書は現れません（処理中であり完了ではありません）。
              </Notice>
            )}
            {/* 保留（AIだけで決めない。成功を偽装しない。docs/06 §2「原本を失わず失敗表示する」） */}
            {jobDone && job!.status !== "succeeded" && (
              <Banner tone="warning" eyebrow="HOLD" role="status" title="保留（AIだけで決めない）">
                <p>{REPORT_JOB_ERROR_LABELS[job!.errorCode ?? ""] ?? `保留になりました（${job!.errorCode ?? "理由の記録なし"}）。元の実績は変わっていません。`}</p>
                {result !== null && job!.status === "stale" && (
                  <Button
                    variant="secondary"
                    busy={generate.saving}
                    className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11"
                    onClick={() => void requestGeneration()}
                  >
                    現行版で再依頼
                  </Button>
                )}
              </Banner>
            )}
            {job !== null && job.status === "succeeded" && reports.length === 0 && (
              <Banner tone="warning" eyebrow="STATE" title="報告書の読み取りを更新してください">
                生成は完了しましたが、報告書がまだ見つかりません。時間をおいて開き直してください。
              </Banner>
            )}
            {jobAttempts >= 480 && !jobDone && (
              <Banner tone="warning" eyebrow="WAIT" title="時間内に完了しませんでした">
                処理の完了を確認できません。時間をおいて開き直してください（受付は残っています）。
              </Banner>
            )}
          </>
        )}
      </Card>
      {/* 対応表の既定110（prototype: home:160,map:110,schedule:100,ai:160,menu:100、その他110。SCR-19はschedule系だがサブ画面は既定に載る。
          一覧パネルだけ160だったのを110へ統一した。PH4レビューC 中5） */}
      <MutationStatus state={generate.state} toastBottom={110} />
      <MutationStatus state={manual.state} toastBottom={110} />
      {/* 未保存の離脱は確認ダイアログ（docs/03 §1.1「入力途中の離脱確認」。本文は2万字までの長文入力のため。
          値ベースのdirty判定: フォームを開いていて本文に空白以外の入力があれば離脱を確認する） */}
      <LeaveConfirm dirty={manualOpen && manualText.trim() !== ""} />
    </section>
  );
}

/**
 * 報告書の詳細（SCR-19の本体。docs/06 §4「人編集→新版→承認→配布の順」）。
 * 版の選択（ピル）→本文・不足欄・生成証跡・承認記録→元実績との比較→直前の版との差分→操作（編集/申請/承認/差戻し/出力）。
 */
function ReportDetail({ id }: { id: string }) {
  const { me } = useMe();
  const canManage = me.roles.includes("officer") || me.roles.includes("admin");

  /** null=引き直し中も前の表示を維持する（AiReviewDetailと同じ。トーストを消さないためremountしない） */
  const [history, setHistory] = useState<ReportHistoryDto | null | "loading" | "notfound" | "error">("loading");
  const [activity, setActivity] = useState<ActivityDetailDto | null | "error">(null);
  const [reloadKey, setReloadKey] = useState(0);
  /** null=初期（現draft版が無ければ承認版を選ぶ）。以降は選択した版のrevisionNo */
  const [revisionNo, setRevisionNo] = useState<number | null>(null);

  useEffect(() => {
    setRevisionNo(null);
    setActivity(null);
  }, [id]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = (await api("API-58", { params: { id }, query: {} })) as unknown as ReportHistoryDto;
        if (!alive) return;
        setHistory(data);
        // 元実績（人数/時刻の比較表示。docs/03 SCR-19「人数/時刻は元実績と比較」）
        void (async () => {
          try {
            const act = (await api("API-07", { params: { id: data.report.activityId } })) as unknown as ActivityDetailDto;
            if (alive) setActivity(act);
          } catch {
            if (alive) setActivity("error");
          }
        })();
      } catch (e) {
        if (!alive) return;
        // 担当外で承認版が無い帳票は存在も明かされない（404＝docs/05 API-58）
        setHistory(e instanceof ApiError && e.status === 404 ? "notfound" : "error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, reloadKey]);

  if (history === "loading" || history === null) {
    return (
      <div className="flex max-w-[720px] flex-col gap-3">
        <SubHeader backTo="/app/reports" />
        <div className="h-40 animate-pulse rounded-card bg-white/[.05]" />
        <div className="h-64 animate-pulse rounded-card bg-white/[.05]" />
      </div>
    );
  }
  if (history === "error" || history === "notfound") {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <SubHeader backTo="/app/reports" />
        <Banner tone="info" eyebrow="NOT FOUND" title="この報告書は存在しないか、閲覧できません">
          <p className="mb-1.5">未承認の報告書は、作成した人と活動の担当だけが開けます。</p>
          <Link to="/app/reports" className="underline">
            一覧へ戻る
          </Link>
        </Banner>
      </div>
    );
  }

  return (
    <ReportDetailBody
      history={history}
      activity={activity}
      canManage={canManage}
      revisionNo={revisionNo}
      onSelectRevision={setRevisionNo}
      onReload={() => setReloadKey((k) => k + 1)}
    />
  );
}

type ApiErrorShape = { status?: number };

/** 詳細の本体（history読み込み後。操作の状態はこの中で持つ） */
function ReportDetailBody({
  history,
  activity,
  canManage,
  revisionNo,
  onSelectRevision,
  onReload,
}: {
  history: ReportHistoryDto;
  activity: ActivityDetailDto | null | "error";
  canManage: boolean;
  revisionNo: number | null;
  onSelectRevision: (no: number) => void;
  onReload: () => void;
}) {
  const report = history.report;
  const versions = history.versions;
  const draftVersion = versions.find((v) => v.id === report.currentDraftVersionId) ?? null;
  const approvedVersion = versions.find((v) => v.id === report.currentApprovedVersionId) ?? null;
  // 初期選択は現draft版（無ければ承認版。それも無ければ最新版）
  const selected =
    versions.find((v) => v.revisionNo === revisionNo) ?? draftVersion ?? approvedVersion ?? versions[versions.length - 1]!;
  const before = versions.find((v) => v.revisionNo === selected.revisionNo - 1) ?? null;

  const edit = useMutation("API-59");
  const decision = useMutation("API-60");

  const [editOpen, setEditOpen] = useState(false);
  const [editText, setEditText] = useState("");
  /** フォームを開いた時点の本文（dirty判定の基準値。開いた時の値からの差分だけを「未保存」とみなす） */
  const [editInitialText, setEditInitialText] = useState("");
  const [editReason, setEditReason] = useState("");
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [approveReason, setApproveReason] = useState("内容を確認して承認しました");
  const [confirmReject, setConfirmReject] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [exporting, setExporting] = useState<"pdf" | "csv" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // ---- 元実績の現行値（人数/時刻の比較表示。サーバー計算〔API-60承認時〕と同じ集計を画面でも出す） ----
  const activityLoaded = activity !== null && activity !== "error" ? activity : null;
  const currentRevision = activityLoaded?.result?.currentRevision ?? null;
  /** 実参加の行があれば全員欠席の0名も「0名」と出す（行が無い「未記載」と区別。docs/03 §1.1-16⑤。
      「未入力と0を分ける」前例〔docs/16 T026・活動分析の未入力〕と同じ流儀。PH4レビューC 低5） */
  const participants = currentRevision?.participants ?? null;
  const participatedCount = participants === null ? null : participants.filter((p) => p.actualStatus === "participated").length;
  const participantText = participants === null || participants.length === 0 ? "未記載" : `${participatedCount}名`;
  const startsAtText = currentRevision?.actualStartsAt ? fmtInstant(currentRevision.actualStartsAt) : "未記載";
  const endsAtText = currentRevision?.actualEndsAt ? fmtInstant(currentRevision.actualEndsAt) : "未記載";

  /** 元実績の版の一致（版の保存値 sourceVersions と現行の活動/実績の版。ずれはstale表示＝docs/03 SCR-19） */
  const sourceNow = activityLoaded?.result
    ? { activityVersion: activityLoaded.version, resultVersion: activityLoaded.result.version, resultRevisionNo: currentRevision!.revisionNo }
    : null;
  const sourceStale =
    sourceNow !== null &&
    (sourceNow.activityVersion !== selected.sourceVersions.activityVersion ||
      sourceNow.resultVersion !== selected.sourceVersions.resultVersion ||
      sourceNow.resultRevisionNo !== selected.sourceVersions.resultRevisionNo);

  /** 操作の可否（状態はdocs/11の許可辺どおり。staleのときは申請・承認を無効化する。最終防御はサーバーの409） */
  const selectedIsDraft = selected.status === "draft";
  const selectedInReview = selected.status === "in_review";
  const canExport = report.currentApprovedVersionId !== null;
  const canSubmit = canManage && selectedIsDraft && !sourceStale;
  const canDecide = canManage && selectedInReview && !sourceStale;
  /** 承認版の後に新しい版を作る（docs/11「承認後訂正は新draft版」） */
  const canRevise = canManage && !selectedIsDraft && !selectedInReview && !sourceStale;

  const openEdit = () => {
    setEditText(draftVersion?.text ?? "");
    setEditInitialText(draftVersion?.text ?? "");
    setEditReason("");
    setEditOpen(true);
  };
  const openRevise = () => {
    setEditText(versions[versions.length - 1]!.text);
    setEditInitialText(versions[versions.length - 1]!.text);
    setEditReason("");
    setEditOpen(true);
  };

  /** 新しい版として保存（API-59。旧版は不変。reasonは訂正の記録） */
  const saveNewVersion = async () => {
    const res = await edit.run({
      params: { id: report.id },
      body: {
        version: report.version,
        text: editText,
        missingFields: [],
        sourceVersions: selected.sourceVersions,
        reason: editReason.trim(),
      },
    });
    if (res) {
      setEditOpen(false);
      setEditText("");
      setEditReason("");
      onSelectRevision(res.data.revisionNo);
      onReload();
    }
  };

  /** 申請（draft→in_review。決定行は作らない＝docs/11の核心。定型理由で記録する） */
  const submitForReview = async () => {
    const res = await decision.run({
      params: { id: report.id },
      body: {
        version: report.version,
        reportVersion: selected.revisionNo,
        decision: "request_review",
        sourceVersions: selected.sourceVersions,
        reason: "活動報告書の内容確認をお願いします",
      },
    });
    if (res) onReload();
  };

  /** 承認（一版一決定。対象版と元実績の版を確認ダイアログで明示してから。docs/03「効果対象を承認前に表示」の流儀） */
  const approveSelected = async () => {
    const res = await decision.run({
      params: { id: report.id },
      body: {
        version: report.version,
        reportVersion: selected.revisionNo,
        decision: "approve",
        sourceVersions: selected.sourceVersions,
        reason: approveReason.trim(),
      },
    });
    if (res) {
      setConfirmApprove(false);
      setApproveReason("内容を確認して承認しました");
      onReload();
    }
  };

  /** 差戻し（in_review→changes_requested。決定行は作らない。理由必須） */
  const requestChanges = async () => {
    const res = await decision.run({
      params: { id: report.id },
      body: {
        version: report.version,
        reportVersion: selected.revisionNo,
        decision: "changes_requested",
        sourceVersions: selected.sourceVersions,
        reason: rejectReason.trim(),
      },
    });
    if (res) {
      setConfirmReject(false);
      setRejectReason("");
      onReload();
    }
  };

  /** 出力（API-61。承認版だけ。ダウンロードは添付表示と同じfetch→blob→a[download]の流儀） */
  const exportContent = async (format: "pdf" | "csv") => {
    setExporting(format);
    setExportError(null);
    try {
      const response = await fetch(`/api/v1/reports/${report.id}/content?format=${format}`, { credentials: "same-origin" });
      if (!response.ok) {
        setExportError("出力できませんでした（承認済みの版が無いか、権限がありません）。");
        return;
      }
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `report.${format}`;
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setExportError("結果を確認できません。通信を確認して、もう一度お試しください。");
    } finally {
      setExporting(null);
    }
  };

  const statusMeta = REPORT_VERSION_STATUS[selected.status];
  const activityTitle = activityLoaded?.title ?? null;

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <SubHeader backTo="/app/reports" right={<Chip tone={statusMeta.tone}>{statusMeta.label}</Chip>} />

      <div className="flex flex-col gap-1 px-0.5">
        <span className="font-mono text-[11px] text-ink-muted">
          報告書 · 様式 {selected.templateVersion}
          {activityTitle ? ` · ${activityTitle}` : ""}
        </span>
        <h2 className="text-[26px] font-bold leading-[1.3]">活動記録（報告書）</h2>
        {activityLoaded && (
          <Link to={`/app/activities/${report.activityId}`} className="inline-flex min-h-11 w-fit items-center gap-1 rounded-pill bg-white/[.08] px-3 text-[12px] font-bold text-ink lg:min-h-9">
            元の活動を開く
            <Icon name="chevron_right" className="text-[15px]" />
          </Link>
        )}
      </div>

      {/* 元実績が更新されているときの案内（画面比較。最終防御は申請・承認時のサーバー409＝docs/11「引用元/実績版一致」） */}
      {sourceStale && (
        <Banner tone="warning" eyebrow="STALE" role="alert" title="元の実績が更新されています">
          <p>
            この版は古い記録（実績 v{selected.sourceVersions.resultVersion}・第{selected.sourceVersions.resultRevisionNo}版）をもとに作られています
            （現行は実績 v{sourceNow!.resultVersion}・第{sourceNow!.resultRevisionNo}版）。
            承認はできません。新しい版として保存し直してください（承認済みの版の記録が変わることはありません）。
          </p>
        </Banner>
      )}

      {/* 版の選択（第N版のピル。活動詳細の実績の版選択と同じ流儀） */}
      {versions.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="報告書の版">
          {versions.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-pressed={selected.revisionNo === v.revisionNo}
              onClick={() => onSelectRevision(v.revisionNo)}
              className={`flex h-9 flex-none items-center rounded-pill px-3 text-[12px] font-bold max-lg:min-h-11 ${
                selected.revisionNo === v.revisionNo
                  ? "bg-[rgba(20,30,50,.92)] text-ink shadow-[inset_0_0_0_1px_var(--color-ember)]"
                  : "bg-[rgba(20,30,50,.6)] text-ink-sub"
              }`}
            >
              第{v.revisionNo}版
            </button>
          ))}
        </div>
      )}

      {/* 選択中の版（本文・不足欄・生成証跡・承認記録。docs/03 SCR-19「本文/不足/元実績/様式/モデル/質問/版を表示」） */}
      <Card className="flex flex-col gap-3" aria-label={`第${selected.revisionNo}版の本文`}>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={statusMeta.tone} icon={selected.status === "approved" ? "task_alt" : undefined} size="lg">
            第{selected.revisionNo}版 · {statusMeta.label}
          </Chip>
          <span className="font-mono text-[11px] text-ink-muted">{selected.createdAt.slice(0, 16).replace("T", " ")}</span>
          {selected.modelId ? (
            <Chip tone="ai" icon="auto_awesome">
              AI生成
            </Chip>
          ) : (
            <Chip tone="neutral">手動で作成</Chip>
          )}
        </div>

        {/* 不足欄（missingFields。「未記載」として示し補完しない。docs/06 §4、docs/03 SCR-19） */}
        {selected.missingFields.length > 0 && (
          <Notice tone="warning" icon="error" role="status">
            <span>
              未記載の欄があります（入力が必要な欄が空です。推測で補完しません）:{" "}
              <span className="font-mono">{selected.missingFields.join("・")}</span>
            </span>
          </Notice>
        )}

        <p className="whitespace-pre-wrap text-[14px] leading-[1.7]">{selected.text === "" ? "（本文は空欄です）" : selected.text}</p>

        {/* 生成証跡（AI版のみ。docs/06 §3「モデル/実モデル版/質問版/usage」のSCR-19相当） */}
        {selected.modelId && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-ink-muted">
            <span>モデル {selected.modelId}</span>
            <span>質問版 {selected.promptVersion ?? "記録なし"}</span>
            {selected.usageJson && (
              <span>
                tokens {selected.usageJson.promptTokens}/{selected.usageJson.completionTokens}
              </span>
            )}
          </div>
        )}

        {/* 承認記録（approved版だけが持つ。docs/04:147「承認済み以降は承認列も不変」） */}
        {selected.status === "approved" && (
          <div className="hairline flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[14px] bg-white/[.04] px-3 py-2 text-[12px] text-ink-sub">
            <span className="font-bold text-ok">承認済み</span>
            <span className="font-mono">承認日時 {selected.approvedAt ? selected.approvedAt.slice(0, 16).replace("T", " ") : "—"}</span>
            <span className="text-[11px] text-ink-muted">この版の記録はもう変わりません（出力はこの版から行われます）。</span>
          </div>
        )}
      </Card>

      {/* 元実績との比較（人数/時刻。docs/03 SCR-19「人数/時刻は元実績と比較」。未記載は補完しない） */}
      <section className="flex flex-col gap-2" aria-label="元の実績との比較">
        <h3 className="text-[14px] font-bold">元の実績との比較</h3>
        {activityLoaded && currentRevision ? (
          <Card className="flex flex-col gap-2">
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-[12px] bg-white/[.04] p-3">
                <span className="text-[11px] text-ink-muted">参加人数（元の実績の「実参加」から数えた数）</span>
                <p className="font-mono text-[14px] font-semibold">{participantText}</p>
              </div>
              <div className="rounded-[12px] bg-white/[.04] p-3">
                <span className="text-[11px] text-ink-muted">実施（元の実績の記録。欠落は未記載のまま）</span>
                <p className="font-mono text-[13px] font-semibold">開始 {startsAtText}</p>
                <p className="font-mono text-[13px] font-semibold">終了時刻 {endsAtText}</p>
              </div>
            </div>
            <p className="text-[12px] text-ink-muted">
              本文に元の実績に無い人数・時刻を書き込まないでください（承認のときにサーバーが版を再検査し、元の実績が変わっていれば承認は拒否されます）。
            </p>
          </Card>
        ) : activityLoaded ? (
          <Card>
            <p className="text-[13px] text-ink-sub">元の実績の記録が見つかりません（実績が削除・変更された可能性があります）。</p>
          </Card>
        ) : (
          <div className="h-20 animate-pulse rounded-[18px] bg-white/[.05]" />
        )}
      </section>

      {/* 版比較（行単位の簡易diff＋記録欄の並列表示。docs/06 §4「本文を元実績と比較し、不足項目・引用参照を表示する」） */}
      <ReportVersionDiff before={before} after={selected} />

      {/* 操作（docs/11の許可辺どおり。権限が無い操作はサーバーが拒否する） */}
      {canManage && (
        <div className="flex flex-wrap items-center gap-2" aria-label="報告書の操作">
          {selectedIsDraft && (
            <>
              <Button busy={edit.saving} onClick={openEdit}>
                編集する
              </Button>
              <Button variant="secondary" busy={decision.saving} disabled={!canSubmit} onClick={() => void submitForReview()}>
                班長に確認を依頼
              </Button>
            </>
          )}
          {selectedInReview && (
            <>
              <Button busy={decision.saving} disabled={!canDecide} onClick={() => setConfirmApprove(true)}>
                承認する
              </Button>
              <Button variant="secondary" busy={decision.saving} disabled={!canDecide} className="!text-alert" onClick={() => setConfirmReject(true)}>
                差戻し
              </Button>
            </>
          )}
          {canRevise && (
            <Button variant="secondary" busy={edit.saving} onClick={openRevise}>
              あたらしく訂正する
            </Button>
          )}
          {sourceStale && <span className="text-[12px] font-medium text-attention">元の実績が更新されているため、申請・承認はできません。</span>}
        </div>
      )}

      {/* 出力（承認済み版だけ。docs/05 API-61「承認版のみ」。docs/03 SCR-19「承認前配布不可」） */}
      <section className="flex flex-col gap-2" aria-label="帳票の出力">
        <h3 className="text-[14px] font-bold">帳票の出力</h3>
        {canExport ? (
          <Card className="flex flex-col gap-2">
            <p className="text-[13px] text-ink-sub">
              承認済みの第{approvedVersion!.revisionNo}版を出力します（承認前の版は配布できません。出力の数値は承認時に確定した値です）。
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" busy={exporting === "pdf"} className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={() => void exportContent("pdf")}>
                <Icon name="picture_as_pdf" className="text-[18px]" />
                PDFを出力
              </Button>
              <Button variant="secondary" busy={exporting === "csv"} className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={() => void exportContent("csv")}>
                <Icon name="table_view" className="text-[18px]" />
                CSVを出力
              </Button>
            </div>
            {exportError && (
              <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
                {exportError}
              </div>
            )}
          </Card>
        ) : (
          <Card>
            <p className="text-[13px] text-ink-sub">承認済みの版が無いため、出力はまだできません（承認前に配布することはできません）。</p>
          </Card>
        )}
      </section>

      <MutationStatus state={edit.state} toastBottom={110} />
      <MutationStatus state={decision.state} toastBottom={110} />

      {/* 編集フォーム（新しい版として保存。docs/11「差戻し後/承認後訂正は新draft版、旧版不変」） */}
      {editOpen && (
        <Card className="flex flex-col gap-3" aria-label="新しい版を作成">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-bold">新しい版として保存</span>
            <span className="text-[12px] text-ink-muted">（直前の版は残ります。編集ではなく新しい版を作ります）</span>
          </div>
          <TextArea name="report-text" label="実施内容" value={editText} onChange={(e) => setEditText(e.target.value)} />
          <TextArea
            name="report-reason"
            label="訂正の理由（必須）"
            value={editReason}
            onChange={(e) => setEditReason(e.target.value)}
            placeholder="例: 空欄だった実施内容を修正した"
          />
          {editReason.trim() === "" && <p className="text-[12px] font-medium text-attention">理由を入力してください</p>}
          {edit.state.kind === "conflict" && (
            <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
              他の編集と競合しています。画面を再読み込みして最新の版を確認してください。
            </div>
          )}
          {edit.state.kind === "unknown" && (
            <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
              結果を確認できません。同じ内容で再送しても二重には登録されません。
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button busy={edit.saving} disabled={editReason.trim() === ""} onClick={() => void saveNewVersion()}>
              新しい版として保存
            </Button>
            <Button
              variant="secondary"
              busy={edit.saving}
              onClick={() => {
                setEditOpen(false);
                setEditText("");
                setEditReason("");
              }}
              className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11"
            >
              やめる
            </Button>
          </div>
        </Card>
      )}

      {/* 承認の確認（対象版と元実績の版を明示。docs/03「効果対象を承認前に表示」の流儀） */}
      {confirmApprove && (
        <ConfirmDialog
          title="この版を承認しますか"
          confirmLabel="承認する"
          busy={decision.saving}
          confirmDisabled={approveReason.trim() === ""}
          onConfirm={() => void approveSelected()}
          onCancel={() => {
            setConfirmApprove(false);
            setApproveReason("内容を確認して承認しました");
          }}
        >
          <p>
            第{selected.revisionNo}版を承認すると、この版が帳票の出力の対象になります（取り消しはできません。記録は残ります）。
          </p>
          <div className="hairline flex flex-col gap-1.5 rounded-card bg-white/[.04] p-3 text-[13px]">
            <span>
              承認する版: <span className="font-bold">第{selected.revisionNo}版（{statusMeta.label}）</span>
            </span>
            <span className="font-mono text-[12px]">
              元の実績: 予定 v{selected.sourceVersions.activityVersion}・実績 v{selected.sourceVersions.resultVersion}（第{selected.sourceVersions.resultRevisionNo}版）
            </span>
            {selected.missingFields.length > 0 && (
              <span className="text-attention">未記載の欄があります: {selected.missingFields.join("・")}</span>
            )}
            <span className="text-[12px] text-ink-muted">承認のときにサーバーが元の実績の版を再検査し、変わっていれば承認は拒否されます（409）。</span>
          </div>
          <TextArea name="approve-reason" label="承認の理由（必須）" value={approveReason} onChange={(e) => setApproveReason(e.target.value)} />
          {approveReason.trim() === "" && <p className="text-[12px] font-medium text-attention">理由を入力してください</p>}
        </ConfirmDialog>
      )}

      {/* 差戻し（理由必須。決定行は作らない＝docs/11。差戻し後の訂正は新しい版） */}
      {confirmReject && (
        <ConfirmDialog
          title="この版を差し戻しますか"
          confirmLabel="差し戻す"
          busy={decision.saving}
          danger
          confirmDisabled={rejectReason.trim() === ""}
          onConfirm={() => void requestChanges()}
          onCancel={() => {
            setConfirmReject(false);
            setRejectReason("");
          }}
        >
          <p>作成者に修正を求めます（この操作で承認の記録は作られません）。差戻し後の訂正は新しい版として保存されます。</p>
          <TextArea name="reject-reason" label="差戻しの理由（必須）" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
          {rejectReason.trim() === "" && <p className="text-[12px] font-medium text-attention">理由を入力してください</p>}
        </ConfirmDialog>
      )}

      {/* 未保存の離脱は確認ダイアログ（docs/03 §1.1「入力途中の離脱確認」。PH4レビューC 中3。
          値ベースのdirty判定: フォームを開いていて、開いた時点の本文からの変更または訂正理由の入力があれば確認する） */}
      <LeaveConfirm dirty={editOpen && (editText !== editInitialText || editReason.trim() !== "")} />
    </div>
  );
}
