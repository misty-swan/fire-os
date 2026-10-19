import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../../api";
import { FormErrors } from "../../components/FormErrors";
import { LeaveConfirm } from "../../components/LeaveConfirm";
import { MutationStatus } from "../../components/MutationStatus";
import { SubHeader } from "../../components/Page";
import { Banner, Button, Card, Chip, TextField } from "../../components/ui";
import { useMe } from "../../me";
import { useMutation } from "../../useMutation";
import type { ActivityDetailDto } from "../../../shared/contracts/operations";
import { ACTIVITY_STATUS } from "./ActivitiesPage";
import { instantFromInput, inputFromInstant } from "./time";

/**
 * 予定の登録・編集（T039、SCR-10。prototypeに登録フォームが無いため共通部品で構成）。
 * 登録はAPI-06（下書きで作る。公開は詳細画面から）。編集はAPI-39（version＋変更列のみ。
 * 公開済みの変更は理由が必須。docs/05 API-39、docs/11 開催）。対象者は対象snapshotになる。
 */

const KIND_OPTIONS = ["訓練", "点検", "行事"] as const;

interface MemberOption {
  id: string;
  displayName: string;
  status: string;
}

export function ActivityEditorPage() {
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const editId = params.id ?? null;
  const editing = editId !== null;
  const { me } = useMe();

  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">(editing ? "loading" : "ready");
  const [original, setOriginal] = useState<ActivityDetailDto | null>(null);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<string>("訓練");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [locationText, setLocationText] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [ownerMemberId, setOwnerMemberId] = useState(me.profile.memberId);
  const [audience, setAudience] = useState<Set<string>>(() => new Set([me.profile.memberId]));
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  /** 保存が確定したら離脱確認を外す（保存後の自動遷移を確認ダイアログで止めない） */
  const [completed, setCompleted] = useState(false);
  const create = useMutation("API-06");
  const update = useMutation("API-39");
  const save = editing ? update : create;

  // 名簿（担当・対象者の選択肢。有効な団員＋既存の対象/担当）。API-02はIssuesPageの担当選択と同じ使い方
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = (await api("API-02", { query: { limit: 200 } })) as unknown as MemberOption[];
        if (alive) setMembers(rows);
      } catch {
        if (alive) setMembers([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!editId) return;
    let alive = true;
    void (async () => {
      try {
        const data = (await api("API-07", { params: { id: editId } })) as unknown as ActivityDetailDto;
        if (!alive) return;
        setOriginal(data);
        setTitle(data.title);
        setKind(data.kind);
        setStartsAt(inputFromInstant(data.plannedStartsAt));
        setEndsAt(inputFromInstant(data.plannedEndsAt));
        setLocationText(data.locationText);
        setDueAt(inputFromInstant(data.responseDueAt));
        setOwnerMemberId(data.ownerMemberId);
        setAudience(new Set(data.audience));
        setLoadState("ready");
      } catch {
        if (alive) setLoadState("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [editId]);

  /** 選択肢は有効な団員。既に対象/担当になっている団員（休団など）も外さずに出す */
  const options = useMemo(() => {
    const byId = new Map(members.map((m) => [m.id, m]));
    for (const id of audience) if (!byId.has(id)) byId.set(id, { id, displayName: id, status: "unknown" });
    if (ownerMemberId && !byId.has(ownerMemberId)) byId.set(ownerMemberId, { id: ownerMemberId, displayName: ownerMemberId, status: "unknown" });
    return [...byId.values()].sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1));
  }, [members, audience, ownerMemberId]);

  const startsInstant = instantFromInput(startsAt);
  const endsInstant = instantFromInput(endsAt);
  const dueInstant = instantFromInput(dueAt);
  const reasonRequired = editing && original !== null && original.status !== "draft";

  /** 編集は変更のあった列だけを送る（API-39は部分更新）。changeの検査はフォームの現在値と読んだ値の比較 */
  const changes = useMemo(() => {
    const o = original;
    if (!o) return null;
    const diff: Record<string, unknown> = {};
    if (title.trim() !== o.title) diff.title = title.trim();
    if (kind !== o.kind) diff.kind = kind;
    if (startsInstant !== o.plannedStartsAt) diff.plannedStartsAt = startsInstant;
    if ((endsInstant ?? null) !== o.plannedEndsAt) diff.plannedEndsAt = endsInstant ?? null;
    if (locationText.trim() !== o.locationText) diff.locationText = locationText.trim();
    if ((dueInstant ?? null) !== o.responseDueAt) diff.responseDueAt = dueInstant ?? null;
    if (ownerMemberId !== o.ownerMemberId) diff.ownerMemberId = ownerMemberId;
    const audienceChanged = audience.size !== o.audience.length || [...audience].some((id) => !o.audience.includes(id));
    if (audienceChanged) diff.audienceMemberIds = [...audience];
    return diff;
  }, [original, title, kind, startsInstant, endsInstant, locationText, dueInstant, ownerMemberId, audience]);

  const errors: { field: string; reason: string }[] = [];
  if (touched) {
    if (!title.trim()) errors.push({ field: "title", reason: "件名を入力してください" });
    if (!startsInstant) errors.push({ field: "plannedStartsAt", reason: "開始日時を入力してください" });
    if (!locationText.trim()) errors.push({ field: "locationText", reason: "場所を入力してください" });
    if (!ownerMemberId) errors.push({ field: "ownerMemberId", reason: "担当を選んでください" });
    if (audience.size === 0) errors.push({ field: "audienceMemberIds", reason: "対象者を1人以上選んでください" });
    if (startsInstant && endsInstant && endsInstant < startsInstant) errors.push({ field: "plannedEndsAt", reason: "終了日時は開始日時以降にしてください" });
    if (editing && changes !== null && Object.keys(changes).length === 0) errors.push({ field: "(body)", reason: "変更がありません。どこかを直してから保存してください。" });
    if (reasonRequired && Object.keys(changes ?? {}).length > 0 && !reason.trim()) errors.push({ field: "reason", reason: "公開済みの予定を変える理由を入力してください" });
  }

  const submit = async () => {
    setTouched(true);
    if (errors.length > 0) return;
    if (editing && original) {
      const result = await update.run({
        params: { id: editId! },
        body: {
          version: original.version,
          ...changes,
          ...(reasonRequired ? { reason: reason.trim() } : {}),
        } as never,
      });
      if (result) {
        setCompleted(true);
        setTouched(false);
        await new Promise((r) => setTimeout(r, 1000)); // 「保存しました」のトーストが見える時間を確保してから戻る
        navigate(`/app/activities/${editId}`);
      }
      return;
    }
    const result = await create.run({
      body: {
        title: title.trim(),
        kind,
        plannedStartsAt: startsInstant!,
        ...(endsInstant ? { plannedEndsAt: endsInstant } : {}),
        locationText: locationText.trim(),
        ownerMemberId,
        audienceMemberIds: [...audience],
        ...(dueInstant ? { responseDueAt: dueInstant } : {}),
      },
    });
    if (result) {
      setCompleted(true);
      setTouched(false);
      await new Promise((r) => setTimeout(r, 1000));
      navigate(`/app/activities/${(result.data as { id: string }).id}`);
    }
  };

  if (loadState === "loading") {
    return (
      <div className="flex max-w-[720px] flex-col gap-3">
        <SubHeader title="予定の編集" backTo={`/app/activities/${editId}`} />
        <div className="h-64 animate-pulse rounded-card bg-white/[.05]" />
      </div>
    );
  }
  if (loadState === "error") {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <SubHeader title="予定の編集" backTo="/app/activities" />
        <Banner tone="info" eyebrow="NOT FOUND" title="この予定は存在しないか、閲覧できません" />
      </div>
    );
  }

  return (
    <div className="flex max-w-[720px] flex-col gap-5">
      <SubHeader
        title={editing ? "予定の編集" : "予定の登録"}
        sub={editing ? "予定の内容を修正します" : "出欠を聞く予定を作ります（最初は下書き）"}
        backTo={editing ? `/app/activities/${editId}` : "/app/activities"}
        right={
          editing && original ? (
            <Chip tone={ACTIVITY_STATUS[original.status].tone}>
              {ACTIVITY_STATUS[original.status].label} v{original.version}
            </Chip>
          ) : (
            <Chip tone="neutral">下書きで作成</Chip>
          )
        }
      />
      <Card className="flex flex-col gap-4">
        <TextField name="title" label="件名" value={title} onChange={(e) => { setTouched(true); setTitle(e.target.value); }} placeholder="例: ポンプ車操法訓練" />
        <label className="hairline flex h-[54px] items-center gap-2 rounded-field bg-white/[.06] px-4">
          <span className="text-[12px] font-bold text-ink-sub">種別</span>
          <select
            aria-label="種別"
            value={kind}
            onChange={(e) => { setTouched(true); setKind(e.target.value); }}
            className="min-w-0 flex-1 border-none bg-transparent text-[14px] font-medium text-ink outline-none"
          >
            {[...new Set([...KIND_OPTIONS, kind])].map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <TextField name="plannedStartsAt" label="開始日時" type="datetime-local" value={startsAt} onChange={(e) => { setTouched(true); setStartsAt(e.target.value); }} />
          <TextField name="plannedEndsAt" label="終了日時（わからなければ空欄）" type="datetime-local" value={endsAt} onChange={(e) => { setTouched(true); setEndsAt(e.target.value); }} />
        </div>
        <TextField name="locationText" label="場所" value={locationText} onChange={(e) => { setTouched(true); setLocationText(e.target.value); }} placeholder="例: 第三分団詰所・前庭" />
        <TextField name="responseDueAt" label="回答期限（出欠の締切。空欄なら締切なし）" type="datetime-local" value={dueAt} onChange={(e) => { setTouched(true); setDueAt(e.target.value); }} />
        <label className="hairline flex h-[54px] items-center gap-2 rounded-field bg-white/[.06] px-4">
          <span className="text-[12px] font-bold text-ink-sub">担当</span>
          <select
            aria-label="担当"
            value={ownerMemberId}
            onChange={(e) => { setTouched(true); setOwnerMemberId(e.target.value); }}
            className="min-w-0 flex-1 border-none bg-transparent text-[14px] font-medium text-ink outline-none"
          >
            {options.map((m) => (
              <option key={m.id} value={m.id}>
                {m.status === "active" ? m.displayName : `${m.displayName}（対象外）`}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-col gap-2">
          <span className="text-[12px] font-bold text-ink-sub">対象者（出欠を聞く人。このメンバーで固定されます）</span>
          <ul className="flex flex-col gap-1">
            {options.map((m) => (
              <li key={m.id}>
                <label className="flex min-h-11 items-center gap-3 rounded-xl bg-white/[.04] px-3">
                  <input
                    type="checkbox"
                    className="size-5"
                    checked={audience.has(m.id)}
                    onChange={(e) => {
                      setTouched(true);
                      setAudience((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(m.id);
                        else next.delete(m.id);
                        return next;
                      });
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
                    {m.displayName}
                    {m.id === me.profile.memberId && <span className="ml-1 text-[12px] text-ink-muted">（自分）</span>}
                    {m.status !== "active" && <span className="ml-1 text-[12px] text-ink-muted">（名簿で対象外）</span>}
                  </span>
                </label>
              </li>
            ))}
            {members.length === 0 && <li className="text-[12px] text-ink-muted">団員の一覧を読み込んでいます…</li>}
          </ul>
        </div>

        {reasonRequired && (
          <TextField
            name="reason"
            label="変更の理由（公開済みの予定は必須）"
            value={reason}
            onChange={(e) => { setTouched(true); setReason(e.target.value); }}
            placeholder="例: 場所が詰所に変わった"
          />
        )}

        <FormErrors issues={errors} labels={{ title: "件名", plannedStartsAt: "開始日時", plannedEndsAt: "終了日時", locationText: "場所", ownerMemberId: "担当", audienceMemberIds: "対象者", reason: "理由" }} />
        {save.state.kind === "conflict" && (
          <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
            他の操作で更新されています。画面を開き直して最新の内容を確認してください。この操作は保存されていません。
          </div>
        )}
        {save.state.kind === "rejected" && (
          <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
            この状態では実行できません（担当が名簿で対象外になった等）。最新の内容を確認してください。
          </div>
        )}
        {save.state.kind === "unknown" && (
          <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
            結果を確認できません。同じ内容で再送しても二重には登録されません。
          </div>
        )}
        <MutationStatus state={save.state.kind === "saved" ? save.state : { kind: "idle" }} toastBottom={100} />
        <Button busy={save.saving} onClick={() => void submit()}>
          {save.state.kind === "processing" ? "処理中（完了ではありません）" : editing ? "変更を保存" : "登録する"}
        </Button>
        {editing && (
          <p className="text-[12px] text-ink-muted">
            保存すると{original ? ACTIVITY_STATUS[original.status].label : "予定"}の内容が変わります。対象者を変えても、すでに付いた回答は消えません。
          </p>
        )}
      </Card>
      <LeaveConfirm dirty={touched && !completed} />
    </div>
  );
}
