import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api";
import { FormErrors } from "../../components/FormErrors";
import { LeaveConfirm } from "../../components/LeaveConfirm";
import { MutationStatus } from "../../components/MutationStatus";
import { SubHeader } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, Notice, TextArea, TextField } from "../../components/ui";
import { useMutation } from "../../useMutation";
import type { ActivityDto } from "../../../shared/contracts/operations";
import { incidentKinds } from "../../../shared/states";
import { INCIDENT_KIND } from "./IncidentsPage";
import { instantFromInput } from "../activities/time";
import { ResourceUsageEditor, type UsageDraft } from "../operations/ResourceUsageEditor";

/**
 * 出動記録の登録（T044、SCR-22。prototypeに出動の登録フォームが無いため共通部品で構成）。
 * 種別（模擬/訓練/実出動記録）は目立つ文字で選ばせ（docs/03 SCR-11）、発生日時・概要を記録する（API-22）。
 * 関連活動（任意）は既存の未リンク活動から選ぶ（作成時に活動側operationへ一致。docs/04:94「リンク時operation一致」。
 * 既に別の出動へリンク済みの活動はサーバーが409で拒否する）。使用資産（任意）はResourceUsageEditorの下書き。
 * **この登録は出動指令文として送信されない**（docs/03 SCR-22。docs/14 D08「正式指令を発行しない」）。
 */

export function IncidentEditorPage() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<(typeof incidentKinds)[number]>("simulation");
  const [occurredAt, setOccurredAt] = useState("");
  const [summary, setSummary] = useState("");
  const [activities, setActivities] = useState<ActivityDto[] | null>(null);
  const [activityQuery, setActivityQuery] = useState("");
  const [activityId, setActivityId] = useState<string | null>(null);
  const [usages, setUsages] = useState<UsageDraft[]>([]);
  const [touched, setTouched] = useState(false);
  /** 保存が確定したら離脱確認を外す（保存後の自動遷移を確認ダイアログで止めない） */
  const [completed, setCompleted] = useState(false);
  const create = useMutation("API-22");

  // 関連活動の候補（既存活動。API-05。一覧はoccurred順で最新が先に来るとは限らないため題で絞れるようにする）
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = (await api("API-05", { query: { limit: 50 } })) as unknown as ActivityDto[];
        if (alive) setActivities(rows);
      } catch {
        if (alive) setActivities([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const occurred = instantFromInput(occurredAt);
  const linkedActivity = activities?.find((a) => a.id === activityId) ?? null;
  // 候補は題の部分一致（既に他の出動へリンク済みの活動はサーバーが409で拒否するため、ここでは外さない）
  const candidates = (activities ?? []).filter((a) => activityQuery.trim() === "" || a.title.includes(activityQuery.trim()));

  const errors: { field: string; reason: string }[] = [];
  if (touched) {
    if (!occurred) errors.push({ field: "occurredAt", reason: "発生日時を入力してください" });
    if (!summary.trim()) errors.push({ field: "summary", reason: "概要を入力してください" });
  }

  const submit = async () => {
    setTouched(true);
    if (errors.length > 0) return;
    const result = await create.run({
      body: {
        kind,
        occurredAt: occurred!,
        summary: summary.trim(),
        ...(activityId ? { activityId } : {}),
        ...(usages.length > 0 ? { resourceUsages: usages } : {}),
      },
    });
    if (result) {
      setCompleted(true);
      setTouched(false);
      await new Promise((r) => setTimeout(r, 1000)); // 「保存しました」のトーストが見える時間を確保してから戻る
      navigate(`/app/incidents/${(result.data as { id: string }).id}`);
    }
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-5">
      <SubHeader
        title="出動記録の登録"
        sub="出動の記録を作ります（正式な指令ではありません）"
        backTo="/app/incidents"
        right={<Chip tone="neutral">記録として作成</Chip>}
      />

      <Notice tone="info" icon="info" role="status">
        この登録は<b>正式な指令ではありません</b>。出動指令文として送信されることもありません。現場の指揮は団長・消防署の指示に従ってください。
      </Notice>

      <Card className="flex flex-col gap-4">
        {/* 種別（docs/03 SCR-11「模擬/訓練/実出動記録を目立つ文字で区分」。prototypeの3択ボタンと同じ流儀） */}
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-bold text-ink-sub">種別</span>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="種別">
            {incidentKinds.map((k) => {
              const meta = INCIDENT_KIND[k];
              const on = kind === k;
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    setTouched(true);
                    setKind(k);
                  }}
                  className={`flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-[18px] px-2 text-[15px] font-bold transition ${on ? "" : "bg-white/[.05] text-ink"}`}
                  style={on ? { background: `${meta.color}26`, color: meta.color, boxShadow: `inset 0 0 0 2px ${meta.color}` } : { boxShadow: "inset 0 0 0 1px rgba(255,255,255,.08)" }}
                >
                  {meta.label}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-ink-muted">実出動の記録は、後から種別を訂正できます（理由が必須です）。</p>
        </div>

        <TextField
          name="occurredAt"
          label="発生日時"
          type="datetime-local"
          value={occurredAt}
          onChange={(e) => {
            setTouched(true);
            setOccurredAt(e.target.value);
          }}
          error={errors.find((e) => e.field === "occurredAt")?.reason}
        />
        <TextArea
          name="summary"
          label="概要"
          value={summary}
          onChange={(e) => {
            setTouched(true);
            setSummary(e.target.value);
          }}
          placeholder="例: 川辺町3丁目 付近 → 第三分団詰所へ参集"
          error={errors.find((e) => e.field === "summary")?.reason}
        />

        {/* 関連活動（任意。docs/03 SCR-22「関連活動」。リンクは後から詳細画面からもできる） */}
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-bold text-ink-sub">関連活動（任意）</span>
          {linkedActivity ? (
            <div className="flex flex-wrap items-center gap-2 rounded-field bg-white/[.06] px-3 py-2.5">
              <Icon name="link" className="text-[18px] text-ink-muted" />
              <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{linkedActivity.title}</span>
              <Chip tone="neutral">登録時に関連付け</Chip>
              <button
                type="button"
                onClick={() => setActivityId(null)}
                className="inline-flex min-h-11 items-center text-[12px] font-bold text-ink-sub underline lg:min-h-9"
              >
                外す
              </button>
            </div>
          ) : (
            <>
              <label className="hairline flex h-[42px] items-center gap-2 rounded-xl bg-white/[.06] px-3">
                <Icon name="search" className="text-[18px] text-ink-muted" />
                <span className="sr-only">活動を探す</span>
                <input
                  value={activityQuery}
                  onChange={(e) => setActivityQuery(e.target.value)}
                  placeholder="活動の題で探す"
                  className="min-w-0 flex-1 border-none bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-ink-dim"
                />
              </label>
              <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto" aria-label="関連付けられる活動">
                {candidates.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setTouched(true);
                        setActivityId(a.id);
                        setActivityQuery("");
                      }}
                      className="flex w-full items-center gap-2 rounded-field bg-white/[.04] px-3 py-2 text-left text-[13px] font-medium hover:bg-white/[.08]"
                    >
                      <span aria-hidden="true" className="size-[7px] flex-none rounded-[2px]" style={{ background: "#c3cad6" }} />
                      <span className="min-w-0 flex-1 truncate">{a.title}</span>
                      <span className="font-mono text-[11px] text-ink-muted">{a.kind}</span>
                    </button>
                  </li>
                ))}
                {activities !== null && candidates.length === 0 && <li className="px-1 text-[12px] text-ink-muted">該当する活動はありません。</li>}
                {activities === null && <li className="px-1 text-[12px] text-ink-muted">活動を読み込んでいます…</li>}
              </ul>
            </>
          )}
          <p className="text-[11px] text-ink-muted">1つの活動に関連付けられる出動記録は1件です。既に別の出動へ関連付いた活動は選べません（保存時に拒否されます）。</p>
        </div>

        {/* 使用資産（任意。API-22のresourceUsages。出動と同じ保存で作られる） */}
        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-bold text-ink-sub">使用資産（任意）</span>
          <ResourceUsageEditor mode="draft" value={usages} onChange={setUsages} />
        </div>

        <FormErrors issues={errors} labels={{ occurredAt: "発生日時", summary: "概要" }} />
        {create.state.kind === "conflict" && (
          <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
            選んだ活動は、他の出動記録ですでに使われています。活動を外すか、別の活動を選んでください。この操作は保存されていません。
          </div>
        )}
        {create.state.kind === "rejected" && (
          <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
            この内容では登録できません（使用資産の対象や時間を確認してください）。
          </div>
        )}
        {create.state.kind === "unknown" && (
          <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
            結果を確認できません。同じ内容で再送しても二重には登録されません。
          </div>
        )}
        <MutationStatus state={create.state.kind === "saved" ? create.state : { kind: "idle" }} toastBottom={100} />
        <Banner tone="info" eyebrow="NOTE" title="出動指令ではありません">
          この記録から、関係機関への通知や出動命令は発行されません。
        </Banner>
        <Button busy={create.saving} onClick={() => void submit()}>
          {create.state.kind === "processing" ? "処理中（完了ではありません）" : "登録する"}
        </Button>
      </Card>
      <LeaveConfirm dirty={touched && !completed} />
    </div>
  );
}
