import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../../api";
import { AttachmentUploader } from "../attachments/AttachmentUploader";
import { FormErrors } from "../../components/FormErrors";
import { LeaveConfirm } from "../../components/LeaveConfirm";
import { MutationStatus } from "../../components/MutationStatus";
import { SubHeader } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, Notice, TextArea } from "../../components/ui";
import { useMutation } from "../../useMutation";
import { useMe } from "../../me";
import { jstDay, type InspectionHistoryRow } from "./InspectionHistory";

/**
 * 点検登録（T033、SCR-06。prototype 点検登録の3ステップ: チェック→写真・メモ→確認）。
 * 承認済み様式の項目ごとに結果を選び、写真の検査が済んだものだけをいっしょに保存する。
 * AI分類の候補枠は紫で示す（確定は人の操作。依頼と承認はAIレビュー（SCR-18）で行う＝T055）。
 *
 * T033の残作業をT085で接続: 同じ3ステップの部品で
 *  - 資産（車両・資機材）の点検登録（SCR-23 /app/assets/:type/:id/inspection。API-20）
 *  - 点検の訂正（?correct=<点検ID>。API-46。元の結果・メモを入れた状態で始め、理由を必須にする。
 *    訂正は新しい原本で、元の原本は書き換えない＝docs/11 §3。訂正できるのは系列の現在版だけ＝409で止まる）
 * 実施日時は最初の送信で固定する（T085で発見: 送るたびに作り直すと、応答が失われた保存を送り直したとき
 * 内容が変わって別の送信鍵になり、二重登録になっていた。同じ内容なら同じ鍵＝docs/03 §1「結果を確認できません」）。
 */

type InspectionTarget = { type: "facility" | "vehicle" | "equipment"; id: string };

/** 訂正の元（API-44／API-51の点検履歴の1行。実施者は元の記録のまま引き継ぐ） */
type OriginalInspection = InspectionHistoryRow & { inspectorMemberId: string };

interface TemplateVersion {
  id: string;
  name?: string;
  status: string;
  currentVersion: { id: string; revisionNo: number; status: string; itemSchema: { code: string; label: string; valueType: string; required: boolean; allowedResults?: string[] }[] };
}

const RESULT_LABELS: Record<string, { label: string; tone: "ok" | "alert" | "neutral" }> = {
  ok: { label: "良好", tone: "ok" },
  needs_review: { label: "異常あり", tone: "alert" },
  unknown: { label: "未確認", tone: "neutral" },
};

export function InspectionFormPage() {
  const navigate = useNavigate();
  const params = useParams<{ id: string; type?: string }>();
  const [search] = useSearchParams();
  const target: InspectionTarget = {
    type: params.type === "vehicle" || params.type === "equipment" ? params.type : "facility",
    id: params.id!,
  };
  const isAsset = target.type !== "facility";
  const correctId = search.get("correct");
  const backTo = isAsset ? `/app/assets/${target.type}/${target.id}` : `/app/facilities/${target.id}`;
  const title = correctId ? "点検の訂正" : isAsset ? "資産の点検登録" : "点検登録";
  const { me } = useMe();
  const myMemberId = me?.profile.memberId ?? "";
  const [templates, setTemplates] = useState<TemplateVersion[] | "loading" | "none">("loading");
  const [chosen, setChosen] = useState<number>(0);
  const [step, setStep] = useState(1);
  const [results, setResults] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [draftId, setDraftId] = useState<string | undefined>(undefined);
  const [readyIds, setReadyIds] = useState<string[]>([]);
  const [busyAttachments, setBusyAttachments] = useState(false);
  const [touched, setTouched] = useState(false);
  /** 保存が完了したら離脱確認を外す（保存後の自動遷移を確認ダイアログで止めない） */
  const [completed, setCompleted] = useState(false);
  const [reason, setReason] = useState("");
  /** 訂正の元。notCurrent=より新しい記録がある（訂正は現在版だけ）、missing=見つからない */
  const [original, setOriginal] = useState<OriginalInspection | "loading" | "missing" | "notCurrent" | null>(correctId ? "loading" : null);
  /** 最初の送信で固定する実施日時（送り直しで内容を変えない＝同じ送信鍵） */
  const inspectedAtRef = useRef<string | null>(null);
  const saveFacility = useMutation("API-14");
  const saveAsset = useMutation("API-20");
  const saveCorrection = useMutation("API-46");
  const save = correctId ? saveCorrection : isAsset ? saveAsset : saveFacility;

  useEffect(() => {
    void (async () => {
      try {
        const data = (await api("API-94", { query: { targetType: target.type } })) as unknown as TemplateVersion[];
        // 現在の承認版（currentVersion）だけを入力画面の候補にする（docs/16 T028: 現承認版を選べる）
        const approved = data
          .filter((t) => t.status === "active" && t.currentVersion?.status === "approved")
          .map((t) => ({ ...t, currentVersion: t.currentVersion! }));
        setTemplates(approved);
      } catch {
        setTemplates("none");
      }
    })();
  }, [target.type]);

  // 訂正の元を読み、結果・メモを入れた状態で始める。訂正できるのは系列の現在版だけ（API-46の版ガード）なので、
  // 施設はAPI-44 current=true（現在版1件）、資産はAPI-51の点検履歴から読む（T085レビューA-m1）
  useEffect(() => {
    if (!correctId) return;
    void (async () => {
      try {
        let found: OriginalInspection | undefined;
        if (isAsset) {
          const detail = (await api("API-51", { params: { type: target.type as "vehicle" | "equipment", id: target.id }, query: {} })) as unknown as { inspections: OriginalInspection[] };
          found = detail.inspections.find((r) => r.id === correctId);
        } else {
          const current = (await api("API-44", { params: { id: target.id }, query: { current: "true", limit: 1 } })) as unknown as OriginalInspection[];
          found = current[0]?.id === correctId ? current[0] : undefined;
          if (!found) {
            setOriginal(current[0] ? "notCurrent" : "missing");
            return;
          }
        }
        if (!found) {
          setOriginal("missing");
          return;
        }
        if (!found.isCurrent) {
          setOriginal("notCurrent");
          return;
        }
        setOriginal(found);
        setResults(Object.fromEntries(found.items.map((i) => [i.code, i.result])));
        setNote(found.note);
      } catch {
        setOriginal("missing");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [correctId]);

  // 訂正では元の点検で使った様式版を選ぶ。その版が今の承認版の候補に無い（様式が改版された等）ときは訂正させない
  // （明細のcodeが様式と合わず、別の様式で上書きすることになるため。T085レビューA-m2。docs/03 §1.1-27）
  const correctionTemplateIndex = Array.isArray(templates) && original && typeof original !== "string"
    ? templates.findIndex((t) => t.currentVersion.id === original.templateVersionId)
    : -1;
  useEffect(() => {
    if (correctionTemplateIndex >= 0) setChosen(correctionTemplateIndex);
  }, [correctionTemplateIndex]);

  const schema = Array.isArray(templates) ? templates[chosen]?.currentVersion.itemSchema ?? [] : [];
  const missingRequired = schema.filter((s) => s.required && !results[s.code]);

  const correcting = original !== null && typeof original !== "string" ? original : null;
  // 異常を起票するか（新規は異常ありのとき。訂正は「元の記録に異常ありが無く、訂正で異常ありになった」ときだけ＝
  // サーバーも同じ規則で拒否する。T085レビューA-I2・裁定R17）
  const originalHadReview = correcting ? correcting.result === "needs_review" || correcting.items.some((i) => i.result === "needs_review") : false;
  const willCreateIssue = Object.values(results).some((r) => r === "needs_review") && !originalHadReview;
  const submit = useCallback(async () => {
    setTouched(true);
    if (missingRequired.length > 0 || busyAttachments) return;
    if (correctId && (!correcting || !reason.trim())) return;
    // 実施日時: 訂正は元の点検の日時のまま。新規は最初の送信の時刻で固定し、送り直しでは変えない
    inspectedAtRef.current ??= correcting ? correcting.inspectedAt : new Date().toISOString();
    const hasReview = Object.values(results).some((r) => r === "needs_review");
    const shape = {
      templateVersionId: (Array.isArray(templates) ? templates[chosen]?.currentVersion.id : "") ?? "",
      inspectedAt: inspectedAtRef.current,
      // 実施者: 訂正は元の記録の実施者のまま（訂正した人は監査に残る）。新規は自分
      inspectorMemberId: correcting ? correcting.inspectorMemberId : myMemberId,
      result: hasReview ? "needs_review" : "ok",
      checkItems: schema.map((s) => ({ code: s.code, result: results[s.code] ?? "unknown" })),
      note: note.trim() || "特記事項なし",
      createIssue: willCreateIssue,
      attachmentIds: readyIds,
    };
    const res = correcting
      ? await saveCorrection.run({
        params: { type: target.type, id: correcting.id },
        body: { seriesVersion: correcting.seriesVersion, supersedesId: correcting.id, reason: reason.trim(), ...shape },
      } as never)
      : isAsset
        ? await saveAsset.run({ body: { target: { type: target.type, id: target.id }, ...shape } } as never)
        : await saveFacility.run({ params: { id: target.id }, body: shape } as never);
    if (res) {
      setCompleted(true);
      // 「保存しました」のトーストが見える時間を確保してから遷移する（離脱確認の番もこの間に降りる）
      await new Promise((r) => setTimeout(r, 1000));
      navigate(backTo);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingRequired.length, busyAttachments, results, note, readyIds, draftId, target.id, target.type, schema, templates, chosen, myMemberId, reason, correcting]);

  if (templates === "loading" || original === "loading") {
    return (
      <div className="flex flex-col gap-3">
        <div className="h-10 w-1/2 animate-pulse rounded bg-white/[.05]" />
        <div className="h-40 animate-pulse rounded-card bg-white/[.05]" />
      </div>
    );
  }
  if (original === "notCurrent") {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <SubHeader title={title} closeIcon backTo={backTo} />
        <Banner tone="warning" eyebrow="NOT LATEST" title="この記録は最新ではないため訂正できません">
          訂正できるのは、この対象のいちばん新しい点検の記録だけです。詳細の画面から最新の記録を開き直してください。
        </Banner>
      </div>
    );
  }
  if (correctId && Array.isArray(templates) && original && typeof original !== "string" && correctionTemplateIndex < 0) {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <SubHeader title={title} closeIcon backTo={backTo} />
        <Banner tone="warning" eyebrow="TEMPLATE CHANGED" title="元の点検の様式が現在の承認版ではないため訂正できません">
          様式が改版された後は、この画面では訂正できません。必要なら新しい点検として記録してください。
        </Banner>
      </div>
    );
  }
  if (original === "missing") {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <SubHeader title={title} closeIcon backTo={backTo} />
        <Banner tone="warning" eyebrow="NOT FOUND" title="訂正する点検の記録が見つかりません">
          記録が削除されたのではなく、表示できる範囲に無い可能性があります。詳細の画面から開き直してください。
        </Banner>
      </div>
    );
  }
  if (templates === "none" || templates.length === 0) {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <SubHeader title={title} closeIcon backTo={backTo} />
        <Banner tone="info" eyebrow="NO TEMPLATE" title="承認済みの点検様式がまだありません">
          管理画面で様式を承認すると点検を登録できます。
        </Banner>
      </div>
    );
  }

  const stepBars = [1, 2, 3].map((n) => ({
    bg: n <= step ? "bg-ember" : "bg-white/[.12]",
    fg: n <= step ? "text-ink" : "text-ink-dim",
    t: n === 1 ? "チェック" : n === 2 ? "写真・メモ" : "確認",
  }));

  return (
    <div className="flex flex-col gap-4 pb-28">
      <SubHeader
        title={title}
        closeIcon
        backTo={backTo}
        right={<span className="font-mono text-[11px] text-ink-muted">{stepLabel(step)}</span>}
      />
      <div className="grid grid-cols-3 gap-1.5 px-1">
        {stepBars.map((b) => (
          <div key={b.t} className="flex flex-col gap-1.5">
            <span aria-hidden="true" className={`h-1 rounded-[2px] ${b.bg}`} />
            <span className={`text-[11px] font-bold ${b.fg}`}>{b.t}</span>
          </div>
        ))}
      </div>

      {correcting && (
        <Notice tone="info" icon="history" role="status">
          {jstDay(correcting.inspectedAt)}の点検を訂正します。元の記録は書き換えず、訂正した記録を新しく残します。
        </Notice>
      )}

      {step === 1 && (
        <div className="flex flex-col gap-2.5">
          {/* 様式の選択（現承認版のみ。docs/11: 承認様式版） */}
          <Card className="flex flex-col gap-2">
            <span className="text-[12px] font-bold text-ink-sub">点検様式（承認済み）</span>
            {templates.map((t, i) => (
              <button
                key={t.id}
                type="button"
                aria-pressed={i === chosen}
                onClick={() => { setChosen(i); setResults({}); }}
                className={`flex min-h-11 items-center justify-between rounded-field px-3 text-left text-[13px] font-bold ${i === chosen ? "bg-ember/15 text-ink shadow-[inset_0_0_0_1px_var(--color-ember)]" : "bg-white/[.06] text-ink-sub"}`}
              >
                {t.name ?? "点検様式"}
                <span className="font-mono text-[11px] text-ink-muted">rev{t.currentVersion.revisionNo}</span>
              </button>
            ))}
          </Card>
          {schema.map((item, i) => (
            <Card key={item.code} className="flex flex-col gap-3">
              <div className="flex gap-2.5">
                <span className="pt-0.5 font-mono text-[11px] font-semibold text-ink-dim">{String(i + 1).padStart(2, "0")}</span>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[15px] font-bold">
                    {item.label}
                    {item.required && <span className="ml-1.5 text-[11px] font-medium text-ink-muted">必須</span>}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {(item.allowedResults ?? ["ok", "needs_review"]).map((r) => {
                  const on = results[item.code] === r;
                  const meta = RESULT_LABELS[r] ?? { label: r, tone: "neutral" as const };
                  // 選択中はprototype（941行付近）と同じベタ塗り＋濃色文字。色だけでなく文字・アイコンでも判別できる
                  const onStyles =
                    meta.tone === "ok" ? "bg-[#3ad08f] text-[#06231a]"
                      : meta.tone === "alert" ? "bg-[#ff7a66] text-[#2a0b06]"
                        : "bg-white text-[#08101c]";
                  return (
                    <button
                      key={r}
                      type="button"
                      aria-pressed={on}
                      onClick={() => { setResults((prev) => ({ ...prev, [item.code]: r })); setTouched(true); }}
                      className={`flex h-12 items-center justify-center gap-1.5 rounded-[14px] text-[14px] font-bold transition max-lg:min-h-11 ${
                        on ? onStyles : "bg-white/[.05] text-ink-sub"
                      }`}
                    >
                      <Icon name={r === "ok" ? "check_circle" : r === "needs_review" ? "warning" : "help"} className="text-[19px]" />
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </Card>
          ))}
          <Button onClick={() => setStep(2)} disabled={missingRequired.length > 0}>
            {missingRequired.length > 0 ? `未回答の必須項目が${missingRequired.length}件` : "写真・メモへ進む"}
          </Button>
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-[14px] font-bold">写真</span>
            <AttachmentUploader
              // 施設の新規点検は従来どおり施設を直targetにする（保存時に点検へ移る）。資産と訂正は点検向けの予約で受け、保存と同時に点検へリンクする
              target={!isAsset && !correctId ? { type: "facility", id: target.id } : { type: "inspection" }}
              onReady={(ids, draft) => { setReadyIds(ids); if (draft) setDraftId(draft); }}
              onChange={setBusyAttachments}
            />
          </div>
          {/* AI分類の候補枠（紫。異常ありの項目があるときだけ・ステップ2に出す。prototypeの配置と語彙。
              保存前の点検は源がまだ無いため依頼はできない＝保存後にAIレビュー（SCR-18）へ導線する。T055） */}
          {Object.values(results).some((r) => r === "needs_review") && (
            <div className="flex flex-col gap-1.5 rounded-[18px] bg-ai/[.07] p-3.5 shadow-[inset_0_0_0_1px_rgba(185,169,255,.26)]" role="status">
              <div className="flex items-center gap-2">
                <Icon name="auto_awesome" className="text-[19px] text-ai" />
                <span className="text-[14px] font-bold">AIによる分類候補</span>
                <span className="ml-auto rounded-[5px] bg-ai/[.14] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-ai">JEV</span>
              </div>
              <p className="text-[12px] leading-[1.7] text-ink-sub">
                保存が済んだら、作られた異常の記録からAI分類を依頼できます（AIレビュー画面）。AIは候補を出すだけで、最終判断は人です。
              </p>
            </div>
          )}
          {/* 班長への確認タスク（prototype ステップ2のトグル。タスク機能の接続は後のフェーズなので押せない状態で置く） */}
          <div className="flex items-center gap-3 rounded-[18px] bg-white/[.04] p-3.5" aria-disabled="true">
            <span aria-hidden="true" className="relative h-[22px] w-[38px] flex-none rounded-pill bg-white/[.15]">
              <span className="absolute left-[3px] top-[3px] size-4 rounded-full bg-white/60" />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-bold text-ink-sub">班長への確認タスクを作成</span>
              <span className="text-[11px] text-ink-muted">タスク機能は後のフェーズで接続されます</span>
            </span>
          </div>
          <TextArea name="inspection-note" label="メモ・特記事項" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例: 蓋の開閉が重い。表示板に汚れ" />
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStep(1)} className="max-lg:min-h-11 flex-none px-5">戻る</Button>
            <Button onClick={() => setStep(3)} className="flex-1">確認へ進む</Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="flex flex-col gap-4">
          <Card className="flex flex-col gap-3">
            <span className="text-[14px] font-bold">確認</span>
            {schema.map((s) => (
              <div key={s.code} className="flex items-center justify-between text-[13px]">
                <span className="text-ink-sub">{s.label}</span>
                {(() => {
                  const chosen = results[s.code];
                  const meta = chosen ? RESULT_LABELS[chosen] : undefined;
                  return <Chip tone={meta?.tone ?? "neutral"}>{meta?.label ?? "未回答"}</Chip>;
                })()}
              </div>
            ))}
            <div className="flex items-center justify-between text-[13px]">
              <span className="text-ink-sub">写真</span>
              <span>{readyIds.length}件（検査済み）</span>
            </div>
            {note.trim() && <p className="text-[12px] text-ink-muted">{note}</p>}
          </Card>
          {willCreateIssue && (
            <Notice tone="warning" icon="report" role="status">
              異常ありの項目があります。保存すると異常の報告が作成されます。
            </Notice>
          )}
          {/* 訂正で元から異常ありの記録は、既にある異常の報告をそのまま使う（新しく起票しない。T085裁定R17・docs/11 §3） */}
          {!willCreateIssue && correcting && Object.values(results).some((r) => r === "needs_review") && (
            <Notice tone="info" icon="report" role="status">
              元の記録の異常の報告がすでにあるため、新しい異常の報告は作りません。
            </Notice>
          )}
          {save.state.kind === "conflict" && (
            <Banner tone="warning" eyebrow="CONFLICT" title="他の操作で更新されています">
              {correctId ? "この対象の点検の記録が他の操作で更新されています（訂正された、または新しい点検が記録された）。詳細の画面から最新の記録を開き直して訂正してください。" : "内容を確認して再度保存してください。"}
            </Banner>
          )}
          {save.state.kind === "unknown" && (
            <Banner tone="warning" eyebrow="UNKNOWN" title="結果を確認できません">同じ内容で再送しても二重登録にはなりません。</Banner>
          )}
          {/* 保存の成功はトースト（docs/03 §1.1。savedのときだけ出す） */}
          <MutationStatus state={save.state.kind === "saved" ? save.state : { kind: "idle" }} toastBottom={110} />
          {correctId && (
            <TextArea name="correction-reason" label="訂正の理由（必須）" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="例: 結果の記入を誤った" />
          )}
          {save.state.kind === "rejected" && (
            <Banner tone="warning" eyebrow="REJECTED" title="この内容では保存できません">
              {save.state.details.some((d) => d.reason === "issue_already_raised")
                ? "この所見の異常の報告は以前の記録ですでに作られています。異常ありのまま訂正するときは、新しい異常の報告は作られません。"
                : "写真の検査が終わっているか、様式が承認済みかを確認してください。"}
            </Banner>
          )}
          <FormErrors issues={save.state.kind === "invalid" ? save.state.details : []} />
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStep(2)} className="max-lg:min-h-11 flex-none px-5">戻る</Button>
            <Button busy={save.saving || busyAttachments} disabled={Boolean(correctId) && !reason.trim()} onClick={() => void submit()} className="flex-1">
              {save.state.kind === "processing" ? "処理中（完了ではありません）" : correctId ? "訂正を保存" : "点検を保存"}
            </Button>
          </div>
        </div>
      )}
      <LeaveConfirm dirty={touched && !completed} />
    </div>
  );
}

function stepLabel(step: number): string {
  return `STEP ${step}/3`;
}


