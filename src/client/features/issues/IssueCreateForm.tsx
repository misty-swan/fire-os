import { useState } from "react";
import { api } from "../../api";
import { MutationStatus } from "../../components/MutationStatus";
import { PageTitle } from "../../components/Page";
import { Banner, Button, Card, Chip, TextField } from "../../components/ui";
import { useMutation } from "../../useMutation";

const targetOptions = [
  { type: "facility", label: "施設" },
  { type: "vehicle", label: "車両" },
  { type: "equipment", label: "資機材" },
] as const;

/** 異常の手動報告フォーム（SCR-07内の導線。起点点検なし） */
export function IssueCreateForm({ onCreated }: { onCreated?: () => void }) {
  const [open, setOpen] = useState(false);
  const [targetType, setTargetType] = useState<(typeof targetOptions)[number]["type"]>("facility");
  const [targetId, setTargetId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [touched, setTouched] = useState(false);
  const create = useMutation("API-16");

  const uuidOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(targetId.trim());
  const errors: { field: string; reason: string }[] = [];
  if (touched) {
    if (!uuidOk) errors.push({ field: "targetId", reason: "対象のID（UUID）を入力してください" });
    if (!title.trim()) errors.push({ field: "title", reason: "件名を入力してください" });
    if (!description.trim()) errors.push({ field: "description", reason: "内容を入力してください" });
  }

  const submit = async () => {
    setTouched(true);
    if (errors.length > 0) return;
    const res = await create.run({
      body: {
        target: { type: targetType, id: targetId.trim() },
        title: title.trim(),
        description: description.trim(),
        attachmentIds: [],
      },
    });
    if (res) {
      setOpen(false);
      setTargetId(""); setTitle(""); setDescription(""); setTouched(false);
      onCreated?.();
    }
  };

  if (!open) {
    return (
      <Button variant="secondary" className="max-lg:min-h-11 flex-none px-4 self-start" onClick={() => setOpen(true)}>
        異常を報告
      </Button>
    );
  }

  return (
    <Card className="flex flex-col gap-3" role="form" aria-label="異常を報告">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-bold">異常を報告</span>
        <button type="button" aria-label="閉じる" onClick={() => setOpen(false)} className="text-[13px] text-ink-muted">閉じる</button>
      </div>
      <div className="flex gap-2">
        {targetOptions.map((t) => (
          <button
            key={t.type}
            type="button"
            aria-pressed={targetType === t.type}
            onClick={() => setTargetType(t.type)}
            className={`flex min-h-11 flex-1 items-center justify-center rounded-field text-[13px] font-bold ${targetType === t.type ? "bg-ember text-white" : "bg-white/[.06] text-ink-sub"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <TextField name="issue-target" label="対象のID（詳細画面のURLに含まれるID）" value={targetId} onChange={(e) => setTargetId(e.target.value)} error={errors.find((e) => e.field === "targetId")?.reason} />
      <TextField name="issue-title" label="件名" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例: 蓋の開閉不良" error={errors.find((e) => e.field === "title")?.reason} />
      <TextField name="issue-desc" label="内容" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="状況・位置など" error={errors.find((e) => e.field === "description")?.reason} />
      {create.state.kind === "conflict" && <Banner tone="warning" eyebrow="CONFLICT" title="他の操作で更新されています" />}
      {create.state.kind === "unknown" && <Banner tone="warning" eyebrow="UNKNOWN" title="結果を確認できません" />}
      {/* 報告の成功はトースト（docs/03 §1.1。savedのときだけ出す） */}
      <MutationStatus state={create.state.kind === "saved" ? create.state : { kind: "idle" }} toastBottom={110} />
      <Button busy={create.saving} onClick={() => void submit()}>
        {create.state.kind === "processing" ? "処理中（完了ではありません）" : "報告する"}
      </Button>
      <p className="flex items-center gap-2 text-[12px] text-ink-muted">
        <Chip tone="neutral" icon="fact_check">点検の「異常あり」からは自動で作られます</Chip>
      </p>
    </Card>
  );
}

void PageTitle;
