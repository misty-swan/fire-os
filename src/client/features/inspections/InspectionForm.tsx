import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../../api";
import { AttachmentUploader } from "../attachments/AttachmentUploader";
import { FormErrors } from "../../components/FormErrors";
import { LeaveConfirm } from "../../components/LeaveConfirm";
import { MutationStatus } from "../../components/MutationStatus";
import { SubHeader } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, Notice, TextArea } from "../../components/ui";
import { useMutation } from "../../useMutation";
import { useMe } from "../../me";

/**
 * 点検登録（T033、SCR-06。prototype 点検登録の3ステップ: チェック→写真・メモ→確認）。
 * 承認済み様式の項目ごとに結果を選び、写真の検査が済んだものだけをいっしょに保存する。
 * AI分類の候補枠は紫で示す（確定は人の操作。依頼と承認はAIレビュー（SCR-18）で行う＝T055）。
 */

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
  const params = useParams<{ id: string }>();
  const facilityId = params.id!;
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
  const save = useMutation("API-14");

  useEffect(() => {
    void (async () => {
      try {
        const data = (await api("API-94", { query: { targetType: "facility" } })) as unknown as TemplateVersion[];
        // 現在の承認版（currentVersion）だけを入力画面の候補にする（docs/16 T028: 現承認版を選べる）
        const approved = data
          .filter((t) => t.status === "active" && t.currentVersion?.status === "approved")
          .map((t) => ({ ...t, currentVersion: t.currentVersion! }));
        setTemplates(approved);
      } catch {
        setTemplates("none");
      }
    })();
  }, []);

  const schema = Array.isArray(templates) ? templates[chosen]?.currentVersion.itemSchema ?? [] : [];
  const missingRequired = schema.filter((s) => s.required && !results[s.code]);

  const submit = useCallback(async () => {
    setTouched(true);
    if (missingRequired.length > 0 || busyAttachments) return;
    const result = save.state;
    void result;
    const res = await save.run({
      params: { id: facilityId },
      body: {
        templateVersionId: (Array.isArray(templates) ? templates[chosen]?.currentVersion.id : "") ?? "",
        inspectedAt: new Date().toISOString(),
        inspectorMemberId: myMemberId,
        result: Object.values(results).some((r) => r === "needs_review") ? "needs_review" : "ok",
        checkItems: schema.map((s) => ({ code: s.code, result: results[s.code] ?? "unknown" })),
        note: note.trim() || "特記事項なし",
        createIssue: Object.values(results).some((r) => r === "needs_review"),
        attachmentIds: readyIds,
        ...(draftId ? {} : {}),
      },
    } as never);
    if (res) {
      setCompleted(true);
      // 「保存しました」のトーストが見える時間を確保してから遷移する（離脱確認の番もこの間に降りる）
      await new Promise((r) => setTimeout(r, 1000));
      navigate(`/app/facilities/${facilityId}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingRequired.length, busyAttachments, results, note, readyIds, draftId, facilityId, schema, templates, chosen, myMemberId]);

  if (templates === "loading") {
    return (
      <div className="flex flex-col gap-3">
        <div className="h-10 w-1/2 animate-pulse rounded bg-white/[.05]" />
        <div className="h-40 animate-pulse rounded-card bg-white/[.05]" />
      </div>
    );
  }
  if (templates === "none" || templates.length === 0) {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <SubHeader title="点検登録" closeIcon backTo={`/app/facilities/${facilityId}`} />
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
        title="点検登録"
        closeIcon
        backTo={`/app/facilities/${facilityId}`}
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
              target={{ type: "facility", id: facilityId }}
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
          {Object.values(results).some((r) => r === "needs_review") && (
            <Notice tone="warning" icon="report" role="status">
              異常ありの項目があります。保存すると異常の報告が作成されます。
            </Notice>
          )}
          {save.state.kind === "conflict" && (
            <Banner tone="warning" eyebrow="CONFLICT" title="他の操作で更新されています">内容を確認して再度保存してください。</Banner>
          )}
          {save.state.kind === "unknown" && (
            <Banner tone="warning" eyebrow="UNKNOWN" title="結果を確認できません">同じ内容で再送しても二重登録にはなりません。</Banner>
          )}
          {/* 保存の成功はトースト（docs/03 §1.1。savedのときだけ出す） */}
          <MutationStatus state={save.state.kind === "saved" ? save.state : { kind: "idle" }} toastBottom={110} />
          <FormErrors issues={save.state.kind === "invalid" ? save.state.details : []} />
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setStep(2)} className="max-lg:min-h-11 flex-none px-5">戻る</Button>
            <Button busy={save.saving || busyAttachments} onClick={() => void submit()} className="flex-1">
              {save.state.kind === "processing" ? "処理中（完了ではありません）" : "点検を保存"}
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


