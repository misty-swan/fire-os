import { useMemo, useState } from "react";
import { ConfirmDialog } from "../../components/Overlay";
import { MutationStatus } from "../../components/MutationStatus";
import { Button, Card, Chip, Icon, Notice, TextField } from "../../components/ui";
import type { DocumentDetailData } from "./DocumentVersionPanel";
import { useMe } from "../../me";
import { useMutation } from "../../useMutation";
import { useMemberNames } from "../notifications/names";

/**
 * 文書の閲覧許可（ACL）パネル（T069、SCR-24。docs/04:151「member/role片方、deny優先」、docs/05 API-99）。
 *
 * - 変更（API-99）は**ACLの全置換**（現在値の全行を消して入れ直す）＋分類の変更＋policy_version増分。
 *   可視範囲が広がる（緩和の向き）変更も、この管理PATCHの操作自体が承認とみなされ、必ず再索引のjobが
 *   作られ、向きは監査ログに記録される（docs/16 T063の裁定）。
 * - **現在のACL行を読むAPIは無い**（API-91の応答はACLを含まない）。そのため現在値の表示は「この端末の
 *   この画面で最後に送った内容」（文書の作成フォーム・このパネルの変更が覚えているもの）だけを行い、
 *   他の端末や他の人による変更は反映されない旨を注記する（偽装しない。docs/03 §1.1-18）。
 * - 行の対象は団員だけ（役割の一覧APIが無いため。docs/03 §1.1-18）。permission値は画面から送らない
 *   判定に使われないため「read」固定（T062の記録専用列。docs/16 T062に記録）。
 */

/** ACL入力の行（UIは団員行のみ。roleIdは契約上任意だが選択肢の一覧APIが無いため送らない） */
export interface AclRowInput {
  key: string;
  memberId: string;
  effect: "allow" | "deny";
}

const toAclEntries = (rows: AclRowInput[]) =>
  rows.map((r) => ({ memberId: r.memberId, permission: "read", effect: r.effect }));

/**
 * この端末で最後に送ったACL（文書idごと）。現在値を読むAPIが無いための画面内の覚え書きで、
 * 再読込すると消える（そのときは「分からない」を表示する。docs/03 §1.1-18）。
 */
const lastSubmittedAcl = new Map<string, AclRowInput[]>();
export function rememberAcl(documentId: string, rows: AclRowInput[]): void {
  lastSubmittedAcl.set(documentId, rows);
}

/** 行エディタ（作成フォームとこのパネルで共有）。行は団員＋許可/拒否。拒否は許可より優先される */
export function AclRowsEditor({ rows, onChange }: { rows: AclRowInput[]; onChange: (rows: AclRowInput[]) => void }) {
  const names = useMemberNames();
  const update = (key: string, patch: Partial<Omit<AclRowInput, "key">>) =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1" aria-label="閲覧の許可と拒否（ACL）">
        {rows.map((row, i) => (
          <li key={row.key} className="flex flex-wrap items-center gap-2">
            <select
              aria-label={`対象の団員${i + 1}`}
              value={row.memberId}
              onChange={(e) => update(row.key, { memberId: e.target.value })}
              className="h-[46px] min-w-0 flex-1 rounded-field bg-white/[.06] px-3 text-[14px] font-medium text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,.1)] outline-none"
            >
              {(names ? [...names.entries()] : []).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
              {!names && <option value={row.memberId}>読み込み中…</option>}
            </select>
            <select
              aria-label={`効果${i + 1}`}
              value={row.effect}
              onChange={(e) => update(row.key, { effect: e.target.value as AclRowInput["effect"] })}
              className="h-[46px] flex-none rounded-field bg-white/[.06] px-3 text-[14px] font-medium text-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,.1)] outline-none"
            >
              <option value="allow">許可</option>
              <option value="deny">拒否</option>
            </select>
            {rows.length > 1 && (
              <button
                type="button"
                aria-label={`行${i + 1}を削除`}
                onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
                className="grid size-11 flex-none place-items-center rounded-full bg-white/[.06]"
              >
                <Icon name="close" className="text-[18px]" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <div>
        <button
          type="button"
          onClick={() => onChange([...rows, { key: crypto.randomUUID(), memberId: "", effect: "allow" }])}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-pill bg-white/[.08] px-4 text-[13px] font-bold text-ink"
        >
          <Icon name="add" className="text-[17px]" />
          対象を追加
        </button>
      </div>
      <p className="text-[12px] text-ink-muted">
        拒否の設定は許可より優先されます。どの行にも当てはまらない団員は閲覧できません。
      </p>
    </div>
  );
}

const aclChips = (rows: AclRowInput[], nameOf: (id: string) => string): { label: string; tone: "ok" | "alert" }[] =>
  rows.map((r) => ({ label: `${nameOf(r.memberId)} を${r.effect === "allow" ? "許可" : "拒否"}`, tone: r.effect === "allow" ? "ok" : "alert" }));

export function DocumentAccessPanel({ detail, canManage, onChanged }: { detail: DocumentDetailData; canManage: boolean; onChanged: () => void }) {
  const { me } = useMe();
  const names = useMemberNames();
  const doc = detail.document;
  const change = useMutation("API-99");

  const nameOf = (id: string) => names?.get(id) ?? "読み込み中…";
  // 現在値として表示できるのは「この端末で最後に送った内容」だけ（読むAPIが無いため。docs/03 §1.1-18）
  const knownRows = lastSubmittedAcl.get(doc.id) ?? null;

  const initialRows = (): AclRowInput[] =>
    knownRows?.map((r) => ({ ...r, key: crypto.randomUUID() })) ??
    [{ key: crypto.randomUUID(), memberId: me.profile.memberId, effect: "allow" }];
  const [rows, setRows] = useState<AclRowInput[]>(initialRows);
  const [classification, setClassification] = useState(doc.classification);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const ready = rows.every((r) => r.memberId) && rows.length >= 1 && classification.trim().length > 0;

  /** 差分（表示できる現在値との比較。既知の行がないときは差分を出せない旨を出す） */
  const diff = useMemo(() => {
    if (!knownRows) return null;
    const current = new Map(knownRows.map((r) => [r.memberId, r.effect]));
    const next = new Map(rows.map((r) => [r.memberId, r.effect]));
    const added: string[] = [];
    const removed: string[] = [];
    for (const [memberId, effect] of next) {
      const before = current.get(memberId);
      if (before === undefined || before !== effect) added.push(`${nameOf(memberId)} を${effect === "allow" ? "許可" : "拒否"}`);
    }
    for (const [memberId, effect] of current) {
      if (next.get(memberId) !== effect) removed.push(`${nameOf(memberId)} を${effect === "allow" ? "許可" : "拒否"}`);
    }
    return { added, removed };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownRows, rows, names]);

  const submit = async () => {
    const r = await change.run({
      params: { id: doc.id },
      body: { version: doc.version, classification: classification.trim(), acl: toAclEntries(rows) },
    });
    if (r) {
      rememberAcl(doc.id, rows.map((r) => ({ key: crypto.randomUUID(), memberId: r.memberId, effect: r.effect })));
      setConfirmOpen(false);
      onChanged();
    }
  };

  return (
    <section className="flex flex-col gap-2" aria-label="閲覧の許可（ACL）">
      <h3 className="text-[14px] font-bold">閲覧の許可（ACL）</h3>
      <Card className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-bold">現在の設定</span>
          <Chip tone="neutral" icon="history">
            閲覧許可の改訂 第{doc.policyVersion}版
          </Chip>
        </div>
        {knownRows ? (
          <div className="flex flex-wrap gap-1.5">
            {aclChips(knownRows, nameOf).map((c) => (
              <Chip key={c.label} tone={c.tone}>
                {c.label}
              </Chip>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-ink-muted">
            現在の許可の一覧を取得するAPIがないため、この端末で最後に送った内容だけが分かります（文書を作った直後や、この画面で変更した直後など）。
          </p>
        )}
        <p className="text-[12px] text-ink-muted">分類 {doc.classification}</p>
      </Card>

      {canManage && (
        <Card className="flex flex-col gap-3">
          <h4 className="text-[14px] font-bold">閲覧許可を変更する</h4>
          <Notice tone="warning" icon="swap_horiz">
            変更は「全置換」です。下の行の内容で現在の設定を入れ替えます。閲覧範囲が広がる変更（許可の追加・拒否の解除）も、この変更の操作自体が承認として記録されます。
          </Notice>
          <TextField
            name="classification"
            label="分類（変更後）"
            value={classification}
            onChange={(e) => setClassification(e.target.value)}
            hint="例: 訓練資料、規程 など短い語。分類の変更でも改訂版が進みます。"
          />
          <AclRowsEditor rows={rows} onChange={setRows} />
          <Button busy={change.saving} disabled={!ready} onClick={() => setConfirmOpen(true)}>
            閲覧許可を変更する
          </Button>
        </Card>
      )}

      <MutationStatus state={change.state} toastBottom={100} />

      {confirmOpen && (
        <ConfirmDialog
          title="閲覧の許可を変更しますか"
          confirmLabel="変更する"
          busy={change.saving}
          onConfirm={() => void submit()}
          onCancel={() => setConfirmOpen(false)}
        >
          <p>
            変更は全置換です。現在の設定（第{doc.policyVersion}版）を、下の内容で入れ替えます。
            閲覧範囲が広がる変更（許可の追加・拒否の解除）も、この変更の操作自体が承認として記録され、検索の索引が作り直されます。
          </p>
          <div className="hairline rounded-card bg-white/[.04] p-3 text-[13px]">
            <p>分類: {doc.classification} → {classification.trim()}</p>
            {diff === null && <p className="mt-1 text-[12px] text-ink-muted">現在値が分からないため差分は出せません（全置換の内容をよく確認してください）。</p>}
            {diff !== null && diff.added.length > 0 && (
              <p className="mt-1">追加: {diff.added.join("、") || "（なし）"}</p>
            )}
            {diff !== null && diff.removed.length > 0 && (
              <p className="mt-1">解除: {diff.removed.join("、") || "（なし）"}</p>
            )}
            <ul className="mt-2 flex flex-col gap-1">
              {rows.map((r) => (
                <li key={r.key}>
                  {nameOf(r.memberId)} を{r.effect === "allow" ? "許可" : "拒否"}
                </li>
              ))}
            </ul>
          </div>
        </ConfirmDialog>
      )}
    </section>
  );
}
