import { useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { ConfirmDialog } from "../../components/Overlay";
import { MutationStatus } from "../../components/MutationStatus";
import { PageTitle } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, Notice, TextArea, TextField } from "../../components/ui";
import { initialOf, useMe } from "../../me";
import type { MutationState } from "../../useMutation";
import { useMutation } from "../../useMutation";
import { MfaPanel } from "../auth/MfaPanel";
import { ROLE_LABEL, ROLE_OPTIONS, STATUS_LABEL, useMembers, type MemberRow } from "../members/useMembers";
import { AuditPanel } from "./AuditPanel";
import { InspectionTemplatesPanel } from "./InspectionTemplatesPanel";

/** サーバーが返した理由コードを、利用者に分かる文にする（コードを見せない） */
const REASON_TEXT: Record<string, string> = {
  last_admin: "最後の管理者は停止・降格できません。先に別の管理者を指名してください",
  self_escalation: "自分自身の権限を上げることはできません",
  member_already_linked: "この団員にはすでにアカウントがあります",
  member_not_linked: "アカウントがある団員だけが対象です（先に招待してください）",
  member_not_active: "在団中の団員だけが対象です",
  unsupported_entity_type: "この種類の担当はまだ設定できません",
  permission_not_applicable: "この対象には設定できない権限です",
  reactivation_not_supported: "停止したアカウントを再開する操作はまだありません",
  status_change_must_be_alone: "状態の変更は、他の項目と同時にはできません",
  reason_required: "理由を入力してください",
  mfa_required: "管理者の操作は、二要素認証の設定が済むまでできません。下の「二要素認証」から設定してください",
  already_expired: "期限が過去になっています",
  cross_origin: "この操作は許可されていません",
};

function ReasonLine({ state }: { state: MutationState }) {
  if (state.kind !== "rejected" && state.kind !== "forbidden" && state.kind !== "conflict") return null;
  const text = state.details.map((d) => REASON_TEXT[d.reason]).find(Boolean);
  if (!text) return null;
  return (
    <Notice tone="warning" icon="info" role="status">
      {text}
    </Notice>
  );
}

function Section({ title, icon, children }: { title: string; icon: string; children: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-3.5 p-4 lg:p-5">
      <h3 className="flex items-center gap-2 text-[15px] font-bold">
        <Icon name={icon} className="text-[20px] text-ink-muted" />
        {title}
      </h3>
      {children}
    </Card>
  );
}

const fmtDate = (iso: string) => new Date(iso).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** 招待の発行・再発行・取消。生tokenは発行直後の一回だけ表示する */
function InvitationSection({ member, enabled, onChanged }: { member: MemberRow; enabled: boolean; onChanged: () => void }) {
  const invite = useMutation("API-33");
  const cancel = useMutation("API-34");
  const [email, setEmail] = useState("");
  const [hours, setHours] = useState(48);
  const [issued, setIssued] = useState<{ token: string; expiresAt: string } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  if (member.hasAccount) {
    return (
      <Section title="アカウントと招待" icon="mail">
        <Chip tone="ok" icon="check_circle">アカウントあり</Chip>
        <p className="text-[12px] leading-[1.6] text-ink-muted">この団員は招待を受け取り済みです。ログインできなくする場合は「利用停止」を使います。</p>
      </Section>
    );
  }
  if (member.status !== "active") {
    return (
      <Section title="アカウントと招待" icon="mail">
        <Notice tone="info" icon="info">{STATUS_LABEL[member.status]}の団員には招待できません。</Notice>
      </Section>
    );
  }
  const pending = member.invitation ?? null;
  async function issue() {
    const r = await invite.run({ body: { memberId: member.id, email, expiresInHours: hours } });
    if (r?.data.token) {
      setIssued({ token: r.data.token, expiresAt: r.data.expiresAt });
      setEmail("");
      onChanged();
    }
  }
  async function doCancel() {
    const r = await cancel.run({ params: { id: pending!.id }, body: { version: pending!.version, reason: cancelReason } });
    if (r) {
      setCancelling(false);
      setCancelReason("");
      setIssued(null);
      onChanged();
    }
  }
  const url = issued ? `${window.location.origin}/login#invite=${issued.token}` : "";
  return (
    <Section title="アカウントと招待" icon="mail">
      {issued && (
        <Banner tone="warning" eyebrow="ONE TIME" role="status" title="招待リンクは今だけ表示されます">
          <p>この画面を閉じると再表示できません（紛失したら取り消して再発行します）。安全な経路で本人に渡してください。有効期限 {fmtDate(issued.expiresAt)}</p>
          <p className="mt-2 break-all rounded-xl bg-black/30 p-3 font-mono text-[12px] text-ink" aria-label="招待リンク">{url}</p>
          <Button variant="secondary" className="mt-2 !h-[42px] !text-[12px]" onClick={() => void navigator.clipboard?.writeText(url)}>
            <Icon name="content_copy" className="text-[16px]" />
            リンクをコピー
          </Button>
        </Banner>
      )}
      {pending ? (
        <div className="flex flex-col gap-2.5">
          <Chip tone="attention" icon="schedule">招待中（{fmtDate(pending.expiresAt)}まで）</Chip>
          <p className="text-[12px] leading-[1.6] text-ink-muted">tokenは再表示できません。紛失した場合は取り消して、新しく発行してください。</p>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={!enabled} onClick={() => setCancelling(true)} className="!h-[46px] !text-[13px]">招待を取り消す</Button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-3 border-t border-white/5 pt-3.5">
        <p className="text-[12px] font-bold text-ink-sub">{pending ? "新しい招待を発行（古い招待は自動で取り消されます）" : "招待を発行"}</p>
        <TextField name="invite-email" label="招待先のメールアドレス" type="email" value={email} onChange={(e) => setEmail(e.target.value)} hint="この宛先のメールアドレスだけが、この招待で登録できます" className="font-mono" />
        <label className="flex flex-col gap-2 text-[12px] font-bold text-ink-sub">
          有効期間
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="hairline h-[54px] rounded-field bg-white/[.06] px-4 text-[16px] font-medium text-ink">
            {[24, 48, 72, 168].map((h) => <option key={h} value={h}>{h}時間</option>)}
          </select>
        </label>
        <MutationStatus state={invite.state} toastBottom={100} />
        <ReasonLine state={invite.state} />
        <Button busy={invite.saving} disabled={!enabled || !email.includes("@")} onClick={() => void issue()} className="!h-[46px] !text-[13px]">
          {invite.saving ? "発行しています…" : "招待を発行する"}
        </Button>
      </div>
      {cancelling && (
        <ConfirmDialog title="招待を取り消す" confirmLabel="取り消す" danger busy={cancel.saving} onCancel={() => setCancelling(false)} onConfirm={() => void doCancel()}>
          <p><b>{member.displayName}</b> さんへの招待を取り消します。取り消した招待リンクは使えなくなります。</p>
          <TextArea name="cancel-reason" label="取り消す理由" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
          <MutationStatus state={cancel.state} />
          <ReasonLine state={cancel.state} />
        </ConfirmDialog>
      )}
    </Section>
  );
}

/** 役割と担当（全置換）。変更前後の差分を確認してから実行する。自分自身の権限は上げられない */
function RolesSection({ member, members, enabled, isSelf, onChanged }: { member: MemberRow; members: MemberRow[]; enabled: boolean; isSelf: boolean; onChanged: () => void }) {
  const put = useMutation("API-37");
  const [roles, setRoles] = useState<Set<string>>(new Set(member.roleCodes ?? []));
  const [scopeIds, setScopeIds] = useState<Set<string>>(new Set((member.scopes ?? []).filter((s) => s.entityType === "member").map((s) => s.entityId)));
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    setRoles(new Set(member.roleCodes ?? []));
    setScopeIds(new Set((member.scopes ?? []).filter((s) => s.entityType === "member").map((s) => s.entityId)));
  }, [member.id, member.version, member.roleCodes, member.scopes]);

  if (!member.hasAccount || member.status !== "active" || !member.account) {
    return (
      <Section title="役割と担当" icon="admin_panel_settings">
        <Notice tone="info" icon="info">アカウントのある在団中の団員だけが対象です。</Notice>
      </Section>
    );
  }
  const before = new Set<string>(member.roleCodes ?? []);
  const beforeScopes = new Set((member.scopes ?? []).filter((s) => s.entityType === "member").map((s) => s.entityId));
  const nameOf = (id: string) => members.find((m) => m.id === id)?.displayName ?? "（不明な団員）";
  const addedRoles = [...roles].filter((r) => !before.has(r));
  const removedRoles = [...before].filter((r) => !roles.has(r));
  const addedScopes = [...scopeIds].filter((s) => !beforeScopes.has(s));
  const removedScopes = [...beforeScopes].filter((s) => !scopeIds.has(s));
  const changed = addedRoles.length + removedRoles.length + addedScopes.length + removedScopes.length > 0;
  const toggle = (set: Set<string>, v: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setter(next);
  };
  async function submit() {
    const keptOther = (member.scopes ?? []).filter((s) => s.entityType !== "member");
    const r = await put.run({
      params: { id: member.id },
      body: {
        version: member.version,
        expectedAuthzVersion: member.account!.authzVersion,
        roleCodes: ROLE_OPTIONS.filter((x) => roles.has(x)),
        scopes: [
          ...keptOther.map((s) => ({ entityType: s.entityType, entityId: s.entityId, permissions: s.permissions, ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}) })),
          // 既にある担当は期限ごと保持し、新しく選んだ分だけを無期限で追加する（期限を黙って外さない）
          ...[...scopeIds].map((id) => {
            const existing = (member.scopes ?? []).find((s) => s.entityType === "member" && s.entityId === id);
            return existing
              ? { entityType: "member", entityId: id, permissions: existing.permissions, ...(existing.expiresAt ? { expiresAt: existing.expiresAt } : {}) }
              : { entityType: "member", entityId: id, permissions: ["PER-06"] };
          }),
        ],
        reason,
      },
    });
    if (r) {
      setConfirming(false);
      setReason("");
      onChanged();
    }
  }
  return (
    <Section title="役割と担当" icon="admin_panel_settings">
      <p className="text-[12px] leading-[1.6] text-ink-muted">
        役割（役職とは別）で操作できる範囲が決まります。管理者の役割だけでは、他の団員の連絡先は読めません。読む必要がある場合は「担当」で団員を指定します。
      </p>
      {isSelf && <Notice tone="info" icon="info">自分自身の権限を上げることはできません（下げることはできます）。</Notice>}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-[12px] font-bold text-ink-sub">役割</legend>
        {ROLE_OPTIONS.map((r) => (
          <label key={r} className="flex min-h-11 items-center gap-3 rounded-xl bg-white/[.04] px-3.5 text-[14px] font-bold">
            <input type="checkbox" className="size-[18px]" checked={roles.has(r)} onChange={() => toggle(roles, r, setRoles)} disabled={!enabled} />
            {ROLE_LABEL[r]}
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-[12px] font-bold text-ink-sub">連絡先を読める団員（担当）</legend>
        <div className="fo-scroll flex max-h-52 flex-col gap-1.5 overflow-y-auto">
          {members.filter((m) => m.status === "active").map((m) => (
            <label key={m.id} className="flex min-h-11 items-center gap-3 rounded-xl bg-white/[.04] px-3.5 text-[13px] font-bold">
              <input type="checkbox" className="size-[18px]" checked={scopeIds.has(m.id)} onChange={() => toggle(scopeIds, m.id, setScopeIds)} disabled={!enabled} />
              {m.displayName}
            </label>
          ))}
        </div>
      </fieldset>
      <TextArea name="roles-reason" label="変更の理由" value={reason} onChange={(e) => setReason(e.target.value)} />
      <MutationStatus state={put.state} toastBottom={100} />
      <ReasonLine state={put.state} />
      <Button disabled={!enabled || !changed || reason.trim() === "" || roles.size === 0} onClick={() => setConfirming(true)} className="!h-[46px] !text-[13px]">
        変更内容を確認する
      </Button>
      {confirming && (
        <ConfirmDialog title="役割と担当の変更を確認" confirmLabel="この内容で変更する" busy={put.saving} onCancel={() => setConfirming(false)} onConfirm={() => void submit()}>
          <p>対象：<b>{member.displayName}</b></p>
          <ul className="list-inside list-disc">
            {addedRoles.map((r) => <li key={`+${r}`}>役割を追加：{ROLE_LABEL[r as keyof typeof ROLE_LABEL]}</li>)}
            {removedRoles.map((r) => <li key={`-${r}`}>役割を外す：{ROLE_LABEL[r as keyof typeof ROLE_LABEL]}</li>)}
            {addedScopes.map((s) => <li key={`+${s}`}>担当を追加：{nameOf(s)} の連絡先</li>)}
            {removedScopes.map((s) => <li key={`-${s}`}>担当を外す：{nameOf(s)} の連絡先</li>)}
          </ul>
          <p>理由：{reason}</p>
          <p>変更するとこの利用者の認可版が更新され、処理中の操作は再確認になります。</p>
          <MutationStatus state={put.state} />
          <ReasonLine state={put.state} />
        </ConfirmDialog>
      )}
    </Section>
  );
}

/** 利用停止（休団・退団）と全セッション失効。過去の記録は消さず、アカウントだけを止める */
function StopSection({ member, enabled, isSelf, onChanged }: { member: MemberRow; enabled: boolean; isSelf: boolean; onChanged: () => void }) {
  const stop = useMutation("API-04");
  const revoke = useMutation("API-38");
  const [status, setStatus] = useState<"paused" | "retired">("paused");
  const [reason, setReason] = useState("");
  const [revokeReason, setRevokeReason] = useState("");
  const [confirm, setConfirm] = useState<"stop" | "revoke" | null>(null);
  const [revokeResult, setRevokeResult] = useState<"completed" | "pending" | null>(null);

  async function doStop() {
    const r = await stop.run({ params: { id: member.id }, body: { version: member.version, status, reason } });
    if (r) {
      setConfirm(null);
      setReason("");
      onChanged();
    }
  }
  async function doRevoke() {
    const r = await revoke.run({ params: { id: member.account!.userId }, body: { expectedAuthzVersion: member.account!.authzVersion, reason: revokeReason } });
    if (r) {
      setRevokeResult(r.data.sessionRevocation);
      setConfirm(null);
      setRevokeReason("");
      onChanged();
    }
  }
  if (member.status !== "active") {
    return (
      <Section title="利用停止" icon="block">
        <Chip tone="neutral">{STATUS_LABEL[member.status]}</Chip>
        <p className="text-[12px] leading-[1.6] text-ink-muted">この団員は停止済みです。過去の活動記録は保持されています。停止を取り消す操作はまだありません。</p>
      </Section>
    );
  }
  return (
    <Section title="利用停止・セッション" icon="block">
      {member.hasAccount && member.account && (
        <div className="flex flex-col gap-2.5">
          <p className="text-[12px] leading-[1.6] text-ink-muted">端末の紛失などで、ログイン中の全端末をいますぐ解除します（アカウントは使えるままです）。</p>
          {revokeResult && (
            <Notice tone={revokeResult === "completed" ? "info" : "warning"} icon={revokeResult === "completed" ? "check_circle" : "hourglass_top"} role="status">
              {revokeResult === "completed" ? "全端末のログインを解除しました" : "解除を再試行しています。この利用者の古いログインは、すでに業務の操作ができません"}
            </Notice>
          )}
          <Button variant="secondary" disabled={!enabled} onClick={() => setConfirm("revoke")} className="!h-[46px] !text-[13px]">全セッションを失効させる</Button>
        </div>
      )}
      <div className="flex flex-col gap-3 border-t border-white/5 pt-3.5">
        <p className="text-[12px] leading-[1.6] text-ink-muted">
          休団・退団にすると、アカウントは停止され全端末のログインが解除されます。団員の行と<b>過去の活動記録を保持</b>します（削除されません）。
        </p>
        {isSelf && <Notice tone="warning" icon="warning">自分自身を停止すると、ただちにログアウトされます。</Notice>}
        <label className="flex flex-col gap-2 text-[12px] font-bold text-ink-sub">
          停止後の状態
          <select value={status} onChange={(e) => setStatus(e.target.value as "paused" | "retired")} className="hairline h-[54px] rounded-field bg-white/[.06] px-4 text-[16px] font-medium text-ink">
            <option value="paused">休団</option>
            <option value="retired">退団</option>
          </select>
        </label>
        <TextArea name="stop-reason" label="停止理由" value={reason} onChange={(e) => setReason(e.target.value)} hint="変更された団員の記録に残ります（監査ログには本文を複製しません）" />
        <MutationStatus state={stop.state} toastBottom={100} />
        <ReasonLine state={stop.state} />
        <Button disabled={!enabled || reason.trim() === ""} onClick={() => setConfirm("stop")} className="!h-[46px] !text-[13px] !bg-danger hover:!bg-danger-hover">
          停止の内容を確認する
        </Button>
      </div>
      {confirm === "stop" && (
        <ConfirmDialog title="利用停止の確認" confirmLabel="停止する" danger busy={stop.saving} onCancel={() => setConfirm(null)} onConfirm={() => void doStop()}>
          <p>対象：<b>{member.displayName}</b>　→　<b>{STATUS_LABEL[status]}</b></p>
          <p>理由：{reason}</p>
          <ul className="list-inside list-disc">
            <li>アカウントは停止され、全端末のログインが解除されます</li>
            <li>過去の活動記録・履歴は保持されます</li>
            <li>この操作の取り消しは、まだ提供されていません</li>
          </ul>
          <MutationStatus state={stop.state} />
          <ReasonLine state={stop.state} />
        </ConfirmDialog>
      )}
      {confirm === "revoke" && (
        <ConfirmDialog title="全セッションの失効" confirmLabel="失効させる" danger busy={revoke.saving} onCancel={() => setConfirm(null)} onConfirm={() => void doRevoke()}>
          <p><b>{member.displayName}</b> さんがログイン中の全端末を解除します。本人は再度ログインが必要になります。</p>
          <TextArea name="revoke-reason" label="理由" value={revokeReason} onChange={(e) => setRevokeReason(e.target.value)} />
          <MutationStatus state={revoke.state} />
          <ReasonLine state={revoke.state} />
        </ConfirmDialog>
      )}
    </Section>
  );
}

/**
 * SCR-17 管理（PH1：招待/取消、役割/担当、利用停止、二要素認証、監査）。prototypeに該当ページが無いため、
 * Design Systemの共通部品（Card/Chip/Banner/Notice/Button/TextField）で作る。PCは左に団員、右に選択した団員の操作を併置。
 * 画面の出し分けは便宜で、権限の判定はサーバー（PER-07、二要素必須）。
 */
export function AccessPanel() {
  const { me, refresh } = useMe();
  const { state, reload } = useMembers();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const isAdmin = me.roles.includes("admin");
  const mfaReady = me.mfaEnabled || !me.mfaRequired;
  const rows = state.kind === "ready" ? state.rows : [];
  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? null, [rows, selectedId]);
  const changed = () => {
    void reload();
    void refresh();
  };

  if (!isAdmin) {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <PageTitle eyebrow="ADMIN" className="lg:[&_h2]:hidden">管理</PageTitle>
        <Banner tone="warning" eyebrow="FORBIDDEN" role="alert" title="この画面は管理者だけが使えます">
          招待・権限・利用停止は、管理者の操作です。必要な場合は分団の管理者へ連絡してください。
        </Banner>
        <Card className="flex flex-col gap-3 p-4">
          <h3 className="text-[15px] font-bold">自分の二要素認証</h3>
          <MfaPanel />
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 lg:max-w-[1440px]">
      <PageTitle eyebrow="ADMIN" className="lg:[&_h2]:hidden">管理</PageTitle>
      {!mfaReady && (
        <Banner tone="warning" eyebrow="MFA REQUIRED" role="alert" title="二要素認証の設定が必要です">
          管理者の操作（招待・権限変更・利用停止・監査）は、二要素認証の設定が済むまでできません。下の「二要素認証」から設定してください。
        </Banner>
      )}
      {state.kind === "loading" && <p role="status" className="text-[13px] text-ink-muted">読み込んでいます…</p>}
      {state.kind === "error" && (
        <Banner tone="error" eyebrow="ERROR" role="alert" title="名簿を取得できません" action={<Button variant="secondary" onClick={() => void reload()}>再読み込み</Button>}>
          通信を確認してもう一度お試しください。
        </Banner>
      )}
      {state.kind === "ready" && (
        <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)] lg:items-start">
          <Card className="flex flex-col gap-2 p-3.5">
            <h3 className="px-1 pb-1 text-[13px] font-bold text-ink-sub">団員を選ぶ</h3>
            <ul aria-label="管理する団員" className="fo-scroll flex max-h-[420px] flex-col gap-1 overflow-y-auto lg:max-h-[640px]">
              {rows.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-pressed={r.id === selectedId}
                    onClick={() => { setSelectedId(r.id); if (window.innerWidth < 1024) setTimeout(() => { detailRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); detailRef.current?.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true }); }, 50); }}
                    className={clsx("flex min-h-[52px] w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-white/[.05]", r.id === selectedId && "bg-white/[.08]")}
                  >
                    <span aria-hidden="true" className="grid size-9 flex-none place-items-center rounded-full bg-[#1a2740] text-[13px] font-bold">{initialOf(r.displayName)}</span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[13px] font-bold">{r.displayName}</span>
                      <span className="truncate text-[11px] text-ink-muted">{r.rank ?? "団員"}{r.roleCodes && r.roleCodes.length ? ` · ${r.roleCodes.map((x) => ROLE_LABEL[x]).join("・")}` : ""}</span>
                    </span>
                    {r.status !== "active" ? <Chip tone="neutral">{STATUS_LABEL[r.status]}</Chip> : r.invitation ? <Chip tone="attention">招待中</Chip> : r.hasAccount ? <Chip tone="ok">利用中</Chip> : <Chip tone="neutral">未招待</Chip>}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <div ref={detailRef} className="flex flex-col gap-4 scroll-mt-4">
            {selected ? (
              <>
                <h3 tabIndex={-1} className="text-[19px] font-bold outline-none">{selected.displayName} <span className="text-[13px] font-medium text-ink-muted">の管理</span></h3>
                <InvitationSection key={`i-${selected.id}`} member={selected} enabled={mfaReady} onChanged={changed} />
                <RolesSection member={selected} members={rows} enabled={mfaReady} isSelf={selected.id === me.profile.memberId} onChanged={changed} />
                <StopSection key={`s-${selected.id}`} member={selected} enabled={mfaReady} isSelf={selected.id === me.profile.memberId} onChanged={changed} />
              </>
            ) : (
              <Notice tone="info" icon="touch_app">左の一覧から団員を選ぶと、招待・役割・利用停止の操作が表示されます。</Notice>
            )}
          </div>
        </div>
      )}
      <Card className="flex flex-col gap-3.5 p-4 lg:p-5">
        <h3 className="flex items-center gap-2 text-[15px] font-bold">
          <Icon name="shield" className="text-[20px] text-ink-muted" />
          二要素認証
        </h3>
        <MfaPanel />
      </Card>
      <AuditPanel enabled={mfaReady} members={rows} />
          <InspectionTemplatesPanel />
    </div>
  );
}
