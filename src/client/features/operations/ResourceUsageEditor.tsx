import { useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { MutationStatus } from "../../components/MutationStatus";
import { Banner, Button, Card, Chip, TextField } from "../../components/ui";
import { useMutation } from "../../useMutation";
import type { ResourceUsageListDto, ResourceUsageRowDto } from "../../../shared/contracts/operations";

/**
 * 車両・機材の使用履歴の編集（T044、docs/04:100、docs/05 API-57/22）。
 * 出動の詳細（IncidentPage）と活動の詳細（ActivityPage）から使う共通編集部品と、
 * 出動の登録フォーム（IncidentEditorPage。API-22のresourceUsages）のための下書きモードを持つ。
 * - API-57は「全有効集合PUT」: 保存時に入力した行で有効(active)集合を置換し、来なかった既存行は
 *   cancelledで残る（物理削除しない。docs/04:100）。cancelledは終端（docs/11 §3）なので入力欄には出さず、
 *   読み取り専用の履歴として下に並べる（統合・訂正のあとも全部見える）。
 * - 対象は車両/資機材のちょうど一つ、数量>0、時間は両方既知のときだけ順序を検査する（片方未知は保留）。
 * - 在庫の自動減算はしない（docs/14 D15）＝台帳の数量は使用で動かない。
 * - 廃止済みの資産は保存できない（サーバーが404）ため、選択肢には出さない。
 */

/** 登録フォーム（API-22）に載せる1行の下書き。idは無い（新規行だけ）。時刻は未入力なら送らない */
export interface UsageDraft {
  target: { type: "vehicle" | "equipment"; id: string };
  quantity: number;
  from?: string;
  to?: string;
}

interface AssetOption {
  type: "vehicle" | "equipment";
  id: string;
  name: string;
  assetCode: string;
}

type EditorProps =
  | {
      mode: "edit";
      operationId: string;
      initialRows: ResourceUsageRowDto[];
      operationVersion: number;
      /** 保存成功。親はここで詳細を引き直す（フォームは「保存済み」の表示のまま残る） */
      onSaved: (next: ResourceUsageListDto) => void;
      /** 保存済みの表示（2.6秒）が過ぎたあとに閉じる */
      onDone?: () => void;
      onCancel?: () => void;
    }
  | { mode: "draft"; value: UsageDraft[]; onChange: (next: UsageDraft[]) => void };

interface DraftRow {
  /** 既存行のid（編集モードのみ。無い行は新規作成） */
  id?: string;
  target: { type: "vehicle" | "equipment"; id: string } | null;
  quantity: string;
  from: string;
  to: string;
}

const localInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const instantFromInput = (v: string) => (v === "" ? undefined : new Date(v).toISOString());

/** 使用履歴の行に載せる資産名（API-18/19を一度読む。読めない間は表示を待つ。IDの先頭で代用しない） */
export function useAssetName(target: "vehicle" | "equipment", targetId: string): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = (await api(target === "vehicle" ? "API-18" : "API-19", { query: { limit: 200 } })) as unknown as {
          id: string;
          name: string;
        }[];
        if (alive) setName(rows.find((r) => r.id === targetId)?.name ?? null);
      } catch {
        if (alive) setName(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [target, targetId]);
  return name;
}

export function ResourceUsageEditor(props: EditorProps) {
  const editing = props.mode === "edit";
  const [assets, setAssets] = useState<AssetOption[] | null>(null);

  // 選択肢は車両と資機材の台帳（API-18/19）。廃止済みは保存できないため出さない
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [vehicles, equipment] = await Promise.all([
          api("API-18", { query: { limit: 200 } }) as Promise<unknown>,
          api("API-19", { query: { limit: 200 } }) as Promise<unknown>,
        ]);
        if (!alive) return;
        const v = (vehicles as { id: string; name: string; assetCode: string; status: string; archivedAt: string | null }[])
          .filter((r) => r.status !== "廃止" && !r.archivedAt)
          .map<AssetOption>((r) => ({ type: "vehicle", id: r.id, name: r.name, assetCode: r.assetCode }));
        const e = (equipment as { id: string; name: string; assetCode: string; status: string; archivedAt: string | null }[])
          .filter((r) => r.status !== "廃止" && !r.archivedAt)
          .map<AssetOption>((r) => ({ type: "equipment", id: r.id, name: r.name, assetCode: r.assetCode }));
        setAssets([...v, ...e]);
      } catch {
        if (alive) setAssets([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 編集モード: 有効行だけを入力欄に載せる（cancelledは終端のため下の編集対象外。読み取り専用で表示）
  const initial = editing ? props.initialRows : [];
  const [rows, setRows] = useState<DraftRow[]>(() =>
    initial
      .filter((r) => r.status === "active")
      .map((r) => ({
        id: r.id,
        target: { type: r.target.type, id: r.target.id },
        quantity: String(r.quantity),
        from: localInput(r.usedFrom),
        to: localInput(r.usedTo),
      })),
  );
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const save = useMutation("API-57");

  // 下書きモードは親の値を镜像する（親がAPI-22のbodyを組み立てる）
  useEffect(() => {
    if (props.mode !== "draft") return;
    setRows(
      props.value.map((u) => ({
        target: { type: u.target.type, id: u.target.id },
        quantity: String(u.quantity),
        from: localInput(u.from ?? null),
        to: localInput(u.to ?? null),
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mode]);

  const nameOf = (target: DraftRow["target"]) =>
    target ? assets?.find((a) => a.type === target.type && a.id === target.id) ?? null : null;

  const errors: { field: string; reason: string }[] = [];
  if (touched) {
    rows.forEach((r, i) => {
      const label = `使用履歴 ${i + 1}行目`;
      if (!r.target) errors.push({ field: `rows.${i}.target`, reason: `${label}の対象を選んでください` });
      if (r.quantity === "" || Number.isNaN(Number(r.quantity))) errors.push({ field: `rows.${i}.quantity`, reason: `${label}の数量を数値で入力してください` });
      else if (!(Number(r.quantity) > 0)) errors.push({ field: `rows.${i}.quantity`, reason: `${label}の数量は1以上にしてください` });
      const from = instantFromInput(r.from);
      const to = instantFromInput(r.to);
      if (from && to && to < from) errors.push({ field: `rows.${i}.to`, reason: `${label}の終了は開始以降にしてください` });
    });
    if (editing && reason.trim() === "") errors.push({ field: "reason", reason: "編集の理由を入力してください" });
  }

  const nextDraft = (next: DraftRow[]): UsageDraft[] =>
    next
      .filter((r) => r.target && r.quantity !== "" && Number(r.quantity) > 0)
      .map((r) => ({
        target: r.target!,
        quantity: Number(r.quantity),
        ...(instantFromInput(r.from) ? { from: instantFromInput(r.from) } : {}),
        ...(instantFromInput(r.to) ? { to: instantFromInput(r.to) } : {}),
      }));

  const updateRow = (index: number, patch: Partial<DraftRow>) => {
    setTouched(true);
    setRows((prev) => {
      const next = prev.map((r, i) => (i === index ? { ...r, ...patch } : r));
      if (props.mode === "draft") props.onChange(nextDraft(next));
      return next;
    });
  };

  const addRow = () => {
    setTouched(true);
    setRows((prev) => {
      const next = [...prev, { target: null, quantity: "", from: "", to: "" }];
      if (props.mode === "draft") props.onChange(nextDraft(next));
      return next;
    });
  };

  const removeRow = (index: number) => {
    setTouched(true);
    setRows((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (props.mode === "draft") props.onChange(nextDraft(next));
      return next;
    });
  };

  const cancelledRows = useMemo(() => (editing ? props.initialRows.filter((r) => r.status !== "active") : []), [editing, props]);
  /** 保存済み。表示の間は入力欄を出さない（ActualResultFormと同じ流儀） */
  const [completed, setCompleted] = useState(false);

  const submit = async () => {
    setTouched(true);
    if (errors.length > 0) return;
    if (props.mode !== "edit") return;
    const result = await save.run({
      params: { id: props.operationId },
      body: {
        version: props.operationVersion,
        reason: reason.trim(),
        usages: rows.map((r) => ({
          ...(r.id ? { id: r.id } : {}),
          target: r.target!,
          quantity: Number(r.quantity),
          ...(instantFromInput(r.from) ? { from: instantFromInput(r.from) } : {}),
          ...(instantFromInput(r.to) ? { to: instantFromInput(r.to) } : {}),
        })),
      },
    });
    if (result) {
      props.onSaved(result.data as unknown as ResourceUsageListDto);
      setCompleted(true);
      if (props.onDone) setTimeout(props.onDone, 2600); // トーストと同じ時間が過ぎたら入力欄を閉じる
    }
  };

  if (completed && props.mode === "edit") {
    return (
      <Card aria-label="使用履歴の編集" className="flex flex-col gap-3">
        <MutationStatus state={{ kind: "saved" }} toastBottom={110} />
        <p className="text-[13px] text-ink-sub">使用履歴を保存しました。取り消した行は履歴として残ります。</p>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4" aria-label={editing ? "使用履歴の編集" : "使用履歴の下書き"}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[14px] font-bold">車両・機材の使用</span>
        <span className="text-[12px] text-ink-muted">台帳の数量は動きません（記録だけです）</span>
      </div>

      {assets !== null && assets.length === 0 && (
        <Banner tone="info" eyebrow="EMPTY" title="選べる車両・資機材がありません">
          <span>
            台帳に登録すると選べます。<a className="underline" href="/app/assets">車両・資機材へ</a>
          </span>
        </Banner>
      )}

      <ul className="flex flex-col gap-2.5">
        {rows.map((r, i) => {
          const n = i + 1;
          const known = nameOf(r.target);
          return (
            <li key={r.id ?? `new-${i}`} className="flex flex-col gap-2.5 rounded-field bg-white/[.04] p-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] font-semibold text-ink-muted">{n}行目</span>
                {known && <Chip tone="neutral">{known.type === "vehicle" ? "車両" : "資機材"}</Chip>}
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  className="ml-auto inline-flex min-h-11 items-center text-[12px] font-bold text-ink-sub underline lg:min-h-9"
                >
                  この行を外す
                </button>
              </div>
              <label className="hairline flex h-[54px] items-center gap-2 rounded-field bg-white/[.06] px-4">
                <span className="text-[12px] font-bold text-ink-sub">対象</span>
                <select
                  aria-label={`使用履歴 ${n}行目の対象`}
                  value={r.target ? `${r.target.type}:${r.target.id}` : ""}
                  onChange={(e) => {
                    const [type, id] = e.target.value.split(":");
                    updateRow(i, { target: id ? { type: type as "vehicle" | "equipment", id } : null });
                  }}
                  className="min-w-0 flex-1 border-none bg-transparent text-[14px] font-medium text-ink outline-none"
                >
                  <option value="">選んでください</option>
                  {(assets ?? []).map((a) => (
                    <option key={`${a.type}:${a.id}`} value={`${a.type}:${a.id}`}>
                      {a.name}（{a.assetCode}）
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid gap-2.5 lg:grid-cols-3">
                <TextField
                  name={`usage-${n}-quantity`}
                  label={`使用履歴 ${n}行目の数量`}
                  inputMode="decimal"
                  value={r.quantity}
                  onChange={(e) => updateRow(i, { quantity: e.target.value })}
                  error={errors.find((e) => e.field === `rows.${i}.quantity`)?.reason}
                />
                <TextField
                  name={`usage-${n}-from`}
                  label={`使用履歴 ${n}行目の開始`}
                  type="datetime-local"
                  value={r.from}
                  onChange={(e) => updateRow(i, { from: e.target.value })}
                />
                <TextField
                  name={`usage-${n}-to`}
                  label={`使用履歴 ${n}行目の終了`}
                  type="datetime-local"
                  value={r.to}
                  onChange={(e) => updateRow(i, { to: e.target.value })}
                />
              </div>
              <p className="text-[11px] text-ink-muted">わからない時刻は空欄にしてください（未記載のまま残ります）。</p>
            </li>
          );
        })}
        {rows.length === 0 && <li className="text-[13px] text-ink-sub">使用の行はまだありません。</li>}
      </ul>

      <Button variant="secondary" className="!h-[46px] !w-auto self-start px-4 !text-[13px] max-lg:min-h-11" onClick={addRow}>
        行を追加
      </Button>

      {editing && (
        <>
          <TextField
            name="usage-reason"
            label="編集の理由（必須）"
            value={reason}
            onChange={(e) => {
              setTouched(true);
              setReason(e.target.value);
            }}
            placeholder="例: 忘れていた使用を追加"
            error={errors.find((e) => e.field === "reason")?.reason}
          />
          {cancelledRows.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-bold text-ink-sub">取り消された行（履歴として残ります。編集はできません）</span>
              <ul className="flex flex-col gap-1">
                {cancelledRows.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-field bg-white/[.03] px-3 py-1.5 text-[12px] text-ink-muted">
                    <span className="font-mono">{r.usedFrom ? r.usedFrom.slice(0, 10) : "日時未記録"}</span>
                    <span>数量 {r.quantity}</span>
                    <Chip tone="neutral">取消</Chip>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {save.state.kind === "conflict" && (
            <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
              他の操作で使用履歴が更新されています。閉じて画面を開き直し、最新の内容でやり直してください。この操作は保存されていません。
            </div>
          )}
          {save.state.kind === "rejected" && (
            <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
              この内容では保存できません（取り消した行を編集していないか確認してください）。
            </div>
          )}
          {save.state.kind === "unknown" && (
            <div role="alert" className="hairline rounded-card bg-[rgba(255,195,92,.08)] p-3.5 text-[13px] text-[#ffdca0]">
              結果を確認できません。同じ内容で再送しても二重には登録されません。
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button busy={save.saving} onClick={() => void submit()} className="min-w-[200px] flex-1">
              使用履歴を保存
            </Button>
            {props.onCancel && (
              <Button variant="secondary" busy={save.saving} className="flex-none px-4" onClick={props.onCancel}>
                閉じる
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
