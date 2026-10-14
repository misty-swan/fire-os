import { useMemo, useState, type FormEvent } from "react";
import { clsx } from "clsx";
import { Link } from "react-router";
import { ConfirmDialog, Drawer, Modal } from "../../components/Overlay";
import { MutationStatus } from "../../components/MutationStatus";
import { PageTitle } from "../../components/Page";
import { Banner, Button, Chip, Icon, Notice, TextField } from "../../components/ui";
import { initialOf, useMe } from "../../me";
import { useMutation } from "../../useMutation";
import { MemberForm } from "./MemberForm";
import { ROLE_LABEL, STATUS_LABEL, useMembers, type MemberRow } from "./useMembers";

const STATUS_TONE = { active: "ok", paused: "attention", retired: "neutral" } as const;

function QualPills({ quals }: { quals: string[] }) {
  if (quals.length === 0) return <span className="text-[12px] text-ink-dim">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {quals.map((q) => (
        <span key={q} className="whitespace-nowrap rounded-md bg-white/[.08] px-[7px] py-[3px] text-[10px] font-bold text-[#c3cad6]">
          {q}
        </span>
      ))}
    </span>
  );
}

function Avatar({ name, size }: { name: string; size: number }) {
  return (
    <span aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.375 }} className="grid flex-none place-items-center rounded-full bg-[#1a2740] font-bold">
      {initialOf(name)}
    </span>
  );
}

/** 本人が自分の連絡先（許可列）を編集する（API-04）。管理者でも他人の分は編集できない */
function OwnPrivateForm({ member, onSaved }: { member: MemberRow; onSaved: () => void }) {
  const update = useMutation("API-04");
  const [phone, setPhone] = useState(member.privateFields?.phone ?? "");
  const [emergency, setEmergency] = useState(member.privateFields?.emergencyContact ?? "");
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await update.run({
      params: { id: member.id },
      body: { version: member.version, privateFields: { phone: phone || null, emergencyContact: emergency || null } },
    });
    if (r) onSaved();
  }
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3 rounded-card bg-white/[.03] p-3.5">
      <TextField name="own-phone" label="電話番号" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className="font-mono" />
      <TextField name="own-emergency" label="緊急連絡先" value={emergency} onChange={(e) => setEmergency(e.target.value)} />
      <MutationStatus state={update.state} toastBottom={100} />
      <Button type="submit" busy={update.saving} className="!h-[46px] !text-[13px]">
        {update.saving ? "保存しています…" : "連絡先を保存"}
      </Button>
    </form>
  );
}

/** 団員ドロワー（prototype：幅440px、アバター64px、緊急連絡先は伏せて「表示」で開く） */
function MemberDrawer({ member, canManage, isSelf, onClose, onChanged, onDirtyChange }: { member: MemberRow; canManage: boolean; isSelf: boolean; onClose: () => void; onChanged: () => void; onDirtyChange: (d: boolean) => void }) {
  const [reveal, setReveal] = useState(false);
  const [editing, setEditing] = useState<"basic" | "private" | null>(null);
  const priv = member.privateFields;
  const mask = (v: string) => v.replace(/\d(?=[\d-]*\d{4}$)/g, "*");
  return (
    <Drawer label={`${member.displayName}のプロフィール`} eyebrow="MEMBER PROFILE" onClose={onClose}>
      <div className="flex items-center gap-4 px-6">
        <Avatar name={member.displayName} size={64} />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[22px] font-bold">{member.displayName}</span>
          <span className="text-[13px] text-ink-sub">
            {[member.squad, member.rank ?? "団員", member.joinedOn ? `入団 ${member.joinedOn.slice(0, 4)}` : null].filter(Boolean).join(" · ")}
          </span>
          <span className="flex gap-1.5">
            <Chip tone={STATUS_TONE[member.status]}>{STATUS_LABEL[member.status]}</Chip>
            {canManage && member.roleCodes && member.roleCodes.length > 0 && <Chip tone="neutral">{ROLE_LABEL[member.roleCodes.includes("admin") ? "admin" : member.roleCodes.includes("officer") ? "officer" : member.roleCodes.includes("operator") ? "operator" : "member"]}</Chip>}
          </span>
        </div>
      </div>

      {/* 訓練参加率・活動・出動は出欠/実績（PH3）が入るまで表示しない（prototypeの3指標の枠だけ置く） */}
      <div className="mx-6 mt-5 grid grid-cols-3 gap-px overflow-hidden rounded-2xl bg-white/[.07]">
        {["訓練参加率", "今年度の活動", "出動"].map((l) => (
          <div key={l} className="flex flex-col gap-1 bg-panel p-3">
            <span className="text-[10px] text-ink-muted">{l}</span>
            <span className="font-mono text-[18px] font-semibold text-ink-dim">—</span>
          </div>
        ))}
      </div>

      <div className="mx-6 mt-3.5 flex items-center gap-2.5 rounded-[14px] bg-white/[.04] px-3.5 py-3">
        <Icon name="call" className="text-[19px] text-ink-muted" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[10px] text-ink-muted">緊急連絡先</span>
          {priv && (priv.phone || priv.emergencyContact) ? (
            <>
              {priv.phone && <span className="text-[13px] font-semibold"><span className="mr-1.5 text-[10px] font-medium text-ink-muted">電話</span><span className="font-mono">{reveal ? priv.phone : mask(priv.phone)}</span></span>}
              {priv.emergencyContact && <span className="text-[13px] font-semibold"><span className="mr-1.5 text-[10px] font-medium text-ink-muted">連絡先</span>{reveal ? priv.emergencyContact : "••••••"}</span>}
            </>
          ) : (
            <span className="text-[12px] text-ink-dim">{isSelf ? "未登録です" : "本人と、担当する者だけが表示できます"}</span>
          )}
        </span>
        {priv && (priv.phone || priv.emergencyContact) && (
          <button type="button" onClick={() => setReveal((v) => !v)} aria-pressed={reveal} className="flex h-8 items-center gap-1 rounded-pill bg-white/[.08] px-3 text-[11px] font-bold max-lg:min-h-11">
            <Icon name={reveal ? "visibility_off" : "visibility"} className="text-[15px]" />
            {reveal ? "隠す" : "表示"}
          </button>
        )}
      </div>
      <span className="mx-6 mt-1.5 block text-[10px] text-ink-dim">他の団員の連絡先を読み込んだ記録は、監査ログに残ります</span>

      <div className="px-6 pb-2 pt-[22px] text-[13px] font-bold">資格・講習</div>
      <div className="hairline mx-6 rounded-2xl bg-white/[.03]">
        {member.qualifications.length === 0 ? (
          <p className="px-3.5 py-3 text-[12px] text-ink-dim">登録されていません</p>
        ) : (
          member.qualifications.map((q) => (
            <div key={q} className="flex items-center justify-between border-b border-white/5 px-3.5 py-3 last:border-0">
              <span className="text-[13px] font-bold">{q}</span>
            </div>
          ))
        )}
      </div>

      <div className="flex flex-col gap-3 px-6 pb-8 pt-[22px]">
        {isSelf && (
          <>
            <div className="text-[13px] font-bold">自分の連絡先</div>
            {editing === "private" ? (
              <OwnPrivateForm member={member} onSaved={() => { setEditing(null); onChanged(); }} />
            ) : (
              <Button variant="secondary" onClick={() => setEditing("private")} className="!h-[46px] !text-[13px]">
                連絡先を編集する
              </Button>
            )}
          </>
        )}
        {canManage && (
          <>
            <div className="pt-2 text-[13px] font-bold">管理</div>
            {editing === "basic" ? (
              <MemberForm member={member} onSaved={() => { setEditing(null); onChanged(); }} onCancel={() => setEditing(null)} onDirtyChange={onDirtyChange} />
            ) : (
              <Button variant="secondary" onClick={() => setEditing("basic")} className="!h-[46px] !text-[13px]">
                基本情報を編集する
              </Button>
            )}
            <Link to="/app/admin" className="text-[12px] font-bold text-ember-soft underline">
              招待・役割・利用停止は「管理」で行います
            </Link>
          </>
        )}
      </div>
    </Drawer>
  );
}

/**
 * SCR-15 団員名簿（prototype Desktop MEMBERS）：検索＋班タブ＋件数＋「団員を追加」、一覧（団員/班/役職/資格・講習）、団員ドロワー440px。
 * 訓練参加率・次回の出欠はPH3のデータが入るまで出さない。スマホはカード一覧、行を押すとドロワーが全幅で開く。
 */
export function MembersPage() {
  const { me } = useMe();
  const { state, reload } = useMembers();
  const [q, setQ] = useState("");
  const [squad, setSquad] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // 入力途中の編集フォームがあるとき、ドロワー/モーダルを閉じる前に確認する（Esc・幕・×のどれでも）
  const [formDirty, setFormDirty] = useState(false);
  const [discard, setDiscard] = useState<(() => void) | null>(null);
  const guard = (close: () => void) => (formDirty ? setDiscard(() => close) : close());
  const canManage = me.roles.includes("admin");

  const rows = state.kind === "ready" ? state.rows : [];
  const squads = useMemo(() => ["all", ...[...new Set(rows.map((r) => r.squad).filter((s): s is string => !!s))].sort()], [rows]);
  const filtered = rows.filter((r) => {
    if (squad !== "all" && r.squad !== squad) return false;
    const needle = q.trim();
    return !needle || [r.displayName, r.squad ?? "", r.rank ?? "", ...r.qualifications].join(" ").includes(needle);
  });
  const open = rows.find((r) => r.id === openId) ?? null;

  return (
    <div className="flex flex-col gap-[18px] lg:max-w-[1440px]">
      <PageTitle eyebrow="MEMBERS" className="lg:hidden">団員名簿</PageTitle>

      <div className="flex flex-wrap items-center gap-2.5">
        <label className="hairline flex h-[42px] w-full items-center gap-2 rounded-xl bg-white/5 px-3 max-lg:min-h-11 lg:w-80">
          <Icon name="search" className="text-[18px] text-ink-muted" />
          <span className="sr-only">氏名・班・資格で絞り込み</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="氏名・班・資格で絞り込み"
            className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink placeholder:text-ink-dim"
          />
        </label>
        <div role="group" aria-label="班で絞り込み" className="fo-scroll flex max-w-full gap-1 overflow-x-auto rounded-[14px] bg-white/[.04] p-1">
          {squads.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={squad === s}
              onClick={() => setSquad(s)}
              className={clsx("h-[34px] flex-none whitespace-nowrap rounded-[10px] px-3 text-[12px] font-bold max-lg:min-h-11", squad === s ? "bg-white/10 text-ink" : "text-ink-muted")}
            >
              {s === "all" ? "すべて" : s}
            </button>
          ))}
        </div>
        <span className="font-mono text-[12px] text-ink-muted" role="status">{filtered.length} / {rows.length}名</span>
        <button
          type="button"
          disabled={!canManage}
          onClick={() => setAdding(true)}
          title={canManage ? undefined : "団員の追加は管理者だけができます"}
          className="flex h-[42px] items-center gap-1.5 rounded-pill bg-white/[.07] px-4 max-lg:min-h-11 text-[13px] font-bold text-ink-sub enabled:hover:bg-white/10 disabled:cursor-not-allowed disabled:text-ink-dim lg:ml-auto"
        >
          <Icon name={canManage ? "person_add" : "lock"} className="text-[17px]" />
          団員を追加
        </button>
      </div>

      {state.kind === "loading" && <p role="status" className="text-[13px] text-ink-muted">読み込んでいます…</p>}
      {state.kind === "error" && (
        <Banner tone="error" eyebrow="ERROR" role="alert" title="名簿を取得できません" action={<Button variant="secondary" onClick={() => void reload()}>再読み込み</Button>}>
          通信を確認してもう一度お試しください。
        </Banner>
      )}
      {state.kind === "ready" && (
        <div className="hairline overflow-hidden rounded-card bg-panel">
          <div aria-hidden="true" className="hidden grid-cols-[minmax(200px,1.4fr)_80px_100px_minmax(160px,1.3fr)_110px] gap-3.5 border-b border-white/[.06] px-5 py-3 font-mono text-[10px] font-semibold tracking-[.1em] text-ink-dim lg:grid">
            <span>団員</span><span>班</span><span>役職</span><span>資格・講習</span><span>状態</span>
          </div>
          <ul aria-label="団員一覧">
            {filtered.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(r.id)}
                  className={clsx(
                    "grid w-full items-center gap-3.5 border-b border-white/5 px-5 py-2.5 text-left hover:bg-white/[.03] lg:grid-cols-[minmax(200px,1.4fr)_80px_100px_minmax(160px,1.3fr)_110px]",
                    r.id === openId && "bg-white/[.04]",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Avatar name={r.displayName} size={32} />
                    <span className="flex min-w-0 flex-col gap-px">
                      <span className="truncate text-[13px] font-bold">{r.displayName}</span>
                      <span className="font-mono text-[11px] text-ink-dim">{r.joinedOn ? `入団 ${r.joinedOn.slice(0, 4)}` : "入団 —"}</span>
                    </span>
                    <span className="ml-auto lg:hidden"><Chip tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Chip></span>
                  </span>
                  <span className="text-[12px] text-ink-sub"><span className="text-ink-dim lg:hidden">班 </span>{r.squad ?? "—"}</span>
                  <span className={clsx("text-[12px] font-bold", r.rank && r.rank !== "団員" ? "text-ink" : "text-ink-sub")}><span className="font-medium text-ink-dim lg:hidden">役職 </span>{r.rank ?? "団員"}</span>
                  <QualPills quals={r.qualifications} />
                  <span className="hidden lg:block"><Chip tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Chip></span>
                </button>
              </li>
            ))}
          </ul>
          {filtered.length === 0 && (
            <div className="flex flex-col items-center gap-2 px-5 py-10">
              <Icon name="person_search" className="text-[28px] text-[#5f6a7d]" />
              <span className="text-[14px] font-bold">条件に合う団員がいません</span>
              <button type="button" onClick={() => { setQ(""); setSquad("all"); }} className="text-[12px] font-bold text-ember-soft">絞り込みを解除</button>
            </div>
          )}
        </div>
      )}

      {!canManage && <Notice tone="info" icon="lock">連絡先などの個人情報は、本人と、その団員を担当する者だけが表示できます。</Notice>}

      {open && <MemberDrawer member={open} canManage={canManage} isSelf={open.id === me.profile.memberId} onClose={() => guard(() => setOpenId(null))} onChanged={() => void reload()} onDirtyChange={setFormDirty} />}
      {adding && (
        <Modal title="団員を追加" sub="登録後、「管理」から招待を送ります" onClose={() => guard(() => setAdding(false))}>
          <MemberForm onSaved={() => { setAdding(false); void reload(); }} onCancel={() => guard(() => setAdding(false))} onDirtyChange={setFormDirty} />
        </Modal>
      )}
      {discard && (
        <ConfirmDialog title="入力を破棄しますか" confirmLabel="破棄して閉じる" danger onCancel={() => setDiscard(null)} onConfirm={() => { const close = discard; setDiscard(null); setFormDirty(false); close(); }}>
          <p>保存されていない入力があります。閉じると失われます。</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
