import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { useMutation } from "../../useMutation";
import { Banner, Button, Card, Chip, Icon, Notice, TextArea, TextField } from "../../components/ui";

/**
 * 点検様式の版・承認パネル（T028、SCR-17に追加。docs/16 T028）。
 * 必須項目の追加→版比較→申請→承認（承認済み様式は変更不可。新しい下書き版を作る）。
 * 様式は検証用の設定（D06未承認）で、実団体の正式点検票として承認済みと表示しない。
 */

interface TemplateVersionDto {
  id: string;
  revisionNo: number;
  status: string;
  itemSchema: ItemSchemaEntry[];
}
interface TemplateDto {
  id: string;
  version: number;
  name: string;
  targetType: "facility" | "vehicle" | "equipment";
  status: string;
  versions: TemplateVersionDto[];
}

type ItemSchemaEntry = { code: string; label: string; valueType: "boolean" | "number" | "text" | "select"; required: boolean; allowedResults?: string[] };

/** 版の差分（docs/16 T028「新旧の版比較」の最小実装。code・label・valueType・requiredの変化を示す） */
function diffSchema(a: ItemSchemaEntry[], b: ItemSchemaEntry[]) {
  const aBy = new Map(a.map((e) => [e.code, e]));
  const bBy = new Map(b.map((e) => [e.code, e]));
  const added = b.filter((e) => !aBy.has(e.code));
  const removed = a.filter((e) => !bBy.has(e.code));
  const changed = b.filter((e) => {
    const old = aBy.get(e.code);
    return old !== undefined && (old.label !== e.label || old.valueType !== e.valueType || old.required !== e.required);
  });
  return { added, removed, changed };
}

const DESC = { added: "追加", removed: "削除", changed: "変更" } as const;
const DEFAULT_SCHEMA: ItemSchemaEntry[] = [
  { code: "exterior", label: "本体の外観", valueType: "select", required: true, allowedResults: ["ok", "needs_review"] },
];

export function InspectionTemplatesPanel() {
  const [templates, setTemplates] = useState<TemplateDto[] | "loading" | "error">("loading");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [targetType, setTargetType] = useState<"facility" | "vehicle" | "equipment">("facility");
  const [schemaText, setSchemaText] = useState(JSON.stringify(DEFAULT_SCHEMA, null, 2));
  const [editing, setEditing] = useState<TemplateDto | null>(null);
  const [editSchema, setEditSchema] = useState("");
  const [compare, setCompare] = useState<{ templateId: string; a: number; b: number } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = (await api("API-94", { query: {} })) as unknown as TemplateDto[];
      setTemplates(data);
    } catch {
      setTemplates("error");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, reloadKey]);

  const createTemplate = useMutation("API-95");
  const createVersion = useMutation("API-96");
  const decide = useMutation("API-97");

  /** 様式rootの現在の版（決定APIに渡す。申請/承認でもrootの版が進むため、直前に読み直す） */
  const currentVersionOf = useCallback(async (t: TemplateDto): Promise<number> => {
    const fresh = (await api("API-94", { query: {} })) as unknown as TemplateDto[];
    return fresh.find((x) => x.id === t.id)?.version ?? t.version;
  }, []);

  const submitCreate = async () => {
    let schema: unknown;
    try {
      schema = JSON.parse(schemaText);
    } catch {
      setMessage("項目のJSONを読めません。形式を確認してください。");
      return;
    }
    const res = await createTemplate.run({ body: { name: name.trim(), targetType, itemSchema: schema as ItemSchemaEntry[] } });
    if (res) {
      setCreating(false);
      setName("");
      setMessage("様式を作成しました（下書き）。申請→承認で使えるようになります。");
      void reload();
    }
  };

  const submitNewVersion = async (t: TemplateDto) => {
    let schema: unknown;
    try {
      schema = JSON.parse(editSchema);
    } catch {
      setMessage("項目のJSONを読めません。形式を確認してください。");
      return;
    }
    const templateVersion = await currentVersionOf(t);
    const res = await createVersion.run({ params: { id: t.id }, body: { version: templateVersion, itemSchema: schema as ItemSchemaEntry[], reason: "項目の更新" } });
    if (res) {
      setEditing(null);
      setMessage("新しい下書き版を作成しました。申請→承認で切り替わります。");
      void reload();
    }
  };

  const decideVersion = async (t: TemplateDto, versionId: string, decision: "request_review" | "approve" | "changes_requested") => {
    const templateVersion = await currentVersionOf(t);
    const res = await decide.run({
      params: { id: t.id },
      body: {
        version: templateVersion, templateVersionId: versionId, decision,
        reason: decision === "approve" ? "内容を確認した" : decision === "request_review" ? "確認をお願いします" : "修正が必要です",
      },
    });
    if (res) {
      setMessage(
        decision === "approve" ? "承認しました。この版が現在の承認版です。"
          : decision === "request_review" ? "申請しました。"
            : "差し戻しました。",
      );
      void reload();
    }
  };

  return (
    <Card className="flex flex-col gap-3" aria-label="点検様式">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-bold">点検様式の版・承認</span>
        <Button variant="secondary" className="max-lg:min-h-11 px-3" onClick={() => setCreating((v) => !v)}>
          <Icon name={creating ? "close" : "add"} className="text-[18px]" />
          様式を追加
        </Button>
      </div>
      <Notice tone="ai" icon="info" role="status">
        様式は検証用の設定です（実団体の正式点検票ではありません）。
      </Notice>

      {creating && (
        <div className="flex flex-col gap-2 rounded-card bg-white/[.04] p-3">
          <TextField name="tpl-name" label="様式名" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="flex gap-2">
            {(["facility", "vehicle", "equipment"] as const).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={targetType === t}
                onClick={() => setTargetType(t)}
                className={`flex min-h-11 flex-1 items-center justify-center rounded-field text-[13px] font-bold ${targetType === t ? "bg-ember text-white" : "bg-white/[.06] text-ink-sub"}`}
              >
                {t === "facility" ? "施設" : t === "vehicle" ? "車両" : "資機材"}
              </button>
            ))}
          </div>
          <TextArea name="tpl-schema" label="項目（JSON）" value={schemaText} onChange={(e) => setSchemaText(e.target.value)} className="font-mono text-[12px]" />
          <Button busy={createTemplate.saving} onClick={() => void submitCreate()}>作成する</Button>
        </div>
      )}

      {message && <Notice tone="info" icon="check_circle" role="status">{message}</Notice>}
      {templates === "error" && <Banner tone="error" eyebrow="ERROR" title="一覧を取得できませんでした" />}
      {templates === "loading" && <div className="h-20 animate-pulse rounded-card bg-white/[.05]" />}

      {Array.isArray(templates) && templates.length === 0 && (
        <Banner tone="info" eyebrow="EMPTY" title="様式はまだありません">「様式を追加」から作成できます。</Banner>
      )}

      {Array.isArray(templates) && templates.map((t) => (
        <div key={t.id} className="flex flex-col gap-2 rounded-card bg-white/[.03] p-3">
          <div className="flex items-center justify-between">
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[14px] font-bold">{t.name}</span>
              <span className="text-[11px] text-ink-muted">
                {t.targetType === "facility" ? "施設用" : t.targetType === "vehicle" ? "車両用" : "資機材用"} · {t.versions.length}版
              </span>
            </div>
            <Chip tone={t.status === "active" ? "ok" : "neutral"}>{t.status === "active" ? "運用中" : "下書き"}</Chip>
          </div>
          {t.versions.map((v) => (
            <div key={v.id} className="flex items-center justify-between rounded-[12px] bg-white/[.04] px-3 py-2">
              <span className="font-mono text-[12px] text-ink-muted">
                rev{v.revisionNo} · {v.status === "approved" ? "承認済" : v.status === "in_review" ? "確認中" : v.status === "changes_requested" ? "差戻し" : "下書き"}
              </span>
              <div className="flex gap-1.5">
                {v.status === "draft" && (
                  <Button variant="secondary" className="max-lg:min-h-11 px-3" busy={decide.saving} onClick={() => void decideVersion(t, v.id, "request_review")}>
                    申請
                  </Button>
                )}
                {v.status === "in_review" && (
                  <>
                    <Button variant="secondary" className="max-lg:min-h-11 px-3" busy={decide.saving} onClick={() => void decideVersion(t, v.id, "changes_requested")}>
                      差戻し
                    </Button>
                    <Button className="max-lg:min-h-11 px-3" busy={decide.saving} onClick={() => void decideVersion(t, v.id, "approve")}>
                      承認
                    </Button>
                  </>
                )}
                {v.status === "approved" && (
                  <span className="inline-flex items-center gap-1 text-[12px] text-ok">
                    <Icon name="verified" className="text-[16px]" />
                    現在の承認版
                  </span>
                )}
              </div>
            </div>
          ))}
          {editing?.id === t.id ? (
            <div className="flex flex-col gap-2">
              <TextArea name="tpl-edit" label="項目（JSON）" value={editSchema} onChange={(e) => setEditSchema(e.target.value)} className="font-mono text-[12px]" />
              <div className="flex gap-2">
                <Button variant="secondary" className="max-lg:min-h-11 px-4" onClick={() => setEditing(null)}>キャンセル</Button>
                <Button busy={createVersion.saving} onClick={() => void submitNewVersion(t)}>新しい下書き版を作成</Button>
              </div>
            </div>
          ) : (
            <Button
              variant="secondary"
              className="max-lg:min-h-11 self-start px-4"
              onClick={() => {
                setEditing(t);
                setEditSchema(JSON.stringify(t.versions[t.versions.length - 1]?.itemSchema ?? DEFAULT_SCHEMA, null, 2));
              }}
            >
              <Icon name="edit" className="text-[18px]" />
              編集（新しい版）
            </Button>
          )}

          {/* 版を比較（docs/16 T028。2つの版を選ぶと項目の追加/削除/変更を示す） */}
          {t.versions.length >= 2 && (
            <div className="flex flex-col gap-2">
              {compare?.templateId === t.id ? (
                <VersionCompare versions={t.versions} a={compare.a} b={compare.b} onSelect={(which, idx) => setCompare({ templateId: t.id, a: which === "a" ? idx : compare.a, b: which === "b" ? idx : compare.b })} onClose={() => setCompare(null)} />
              ) : (
                <Button
                  variant="secondary"
                  className="max-lg:min-h-11 self-start px-4"
                  onClick={() => setCompare({ templateId: t.id, a: 0, b: t.versions.length - 1 })}
                >
                  <Icon name="compare_arrows" className="text-[18px]" />
                  版を比較
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}

/** 版の比較表示。古い版(a)と新しい版(b)を選ぶと項目差分の表を出す */
function VersionCompare({
  versions, a, b, onSelect, onClose,
}: {
  versions: TemplateVersionDto[];
  a: number;
  b: number;
  onSelect: (which: "a" | "b", index: number) => void;
  onClose: () => void;
}) {
  const diff = diffSchema(versions[a!]?.itemSchema ?? [], versions[b!]?.itemSchema ?? []);
  const rows: { kind: keyof typeof DESC; entry: ItemSchemaEntry }[] = [
    ...diff.added.map((entry) => ({ kind: "added" as const, entry })),
    ...diff.removed.map((entry) => ({ kind: "removed" as const, entry })),
    ...diff.changed.map((entry) => ({ kind: "changed" as const, entry })),
  ];
  const revLabel = (v: TemplateVersionDto) => `rev${v.revisionNo} · ${v.status === "approved" ? "承認済" : v.status === "in_review" ? "確認中" : v.status === "changes_requested" ? "差戻し" : "下書き"}`;
  return (
    <div className="flex flex-col gap-2 rounded-[14px] bg-white/[.04] p-3" aria-label="版の比較">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-bold text-ink-sub">版の比較</span>
        <button type="button" onClick={onClose} className="text-[12px] text-ink-muted underline">閉じる</button>
      </div>
      <div className="flex gap-2">
        <label className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-[10px] bg-white/[.05] px-2.5">
          <span className="text-[10px] text-ink-muted">古い版</span>
          <select value={a} onChange={(e) => onSelect("a", Number(e.target.value))} className="border-none bg-transparent text-[12px] font-bold text-ink outline-none">
            {versions.map((v, i) => (
              <option key={v.id} value={i}>{revLabel(v)}</option>
            ))}
          </select>
        </label>
        <label className="flex min-h-11 min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-[10px] bg-white/[.05] px-2.5">
          <span className="text-[10px] text-ink-muted">新しい版</span>
          <select value={b} onChange={(e) => onSelect("b", Number(e.target.value))} className="border-none bg-transparent text-[12px] font-bold text-ink outline-none">
            {versions.map((v, i) => (
              <option key={v.id} value={i}>{revLabel(v)}</option>
            ))}
          </select>
        </label>
      </div>
      {rows.length === 0 ? (
        <p className="text-[12px] text-ink-muted">この2つの版に項目の差分はありません。</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map(({ kind, entry }, i) => (
            <li key={`${kind}-${entry.code}-${i}`} className="flex items-baseline gap-2 text-[12px] leading-[1.6]">
              <span className={`flex-none font-bold ${kind === "added" ? "text-ok" : kind === "removed" ? "text-alert" : "text-attention"}`}>{DESC[kind]}</span>
              <span className="font-mono text-ink-muted">{entry.code}</span>
              <span className="min-w-0 flex-1 text-ink-sub">
                {entry.label} · {entry.valueType}{entry.required ? " · 必須" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
