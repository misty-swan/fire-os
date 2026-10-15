import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../../api";
import { ConfirmDialog } from "../../components/Overlay";
import { MutationStatus } from "../../components/MutationStatus";
import { SubHeader } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, Notice, TextArea, TextField } from "../../components/ui";
import { useOnline } from "../../components/AppShell";
import { initialOf, useMe } from "../../me";
import { useMutation } from "../../useMutation";
import type { ActivityDto, IncidentDetailDto } from "../../../shared/contracts/operations";
import {
  incidentKinds,
  incidentTransitions,
  mobilizationStates,
} from "../../../shared/states";
import { INCIDENT_KIND, INCIDENT_STATUS } from "./IncidentsPage";
import { fmtDay, fmtHM, fmtInstant } from "../activities/time";
import { ResourceUsageEditor, useAssetName } from "../operations/ResourceUsageEditor";

/**
 * 出動記録の詳細（T044、SCR-12。prototypeの出動モード=赤テーマの語彙・注記を踏襲）。
 * 概要/参集・帰還/関連活動/車両・機材/履歴を同じ画面で完結させる（docs/03 SCR-12）。
 * - 種別（模擬/訓練/実出動記録）と状態（記録中/出動中/終了/無効）は別の文字で示す（docs/11 出動イベント）。
 * - 状態遷移・種別・概要の訂正はAPI-69（理由必須）。voidedは終端で、参集・使用履歴の編集操作は出さない
 *   （APIが422/422で守る之上で、UIも操作を提示しない。T041の懸念への対応）。
 * - 参集・帰還は本人/代理でAPI-23。未知の時刻は未記載のまま（docs/11「欠落時刻を捏造しない」）。
 *   帰還のみの事後記録では到着時刻は空のまま残る。固定語彙「参集済」「帰還記録」（docs/11:34）。
 * - 関連活動は既存活動を検索してAPI-71でリンク（両rootのoperation版を画面が送る）。
 *   リンク後は活動の詳細からも「関連する出動記録」で戻れる（相互導線）。
 * - 使用履歴はAPI-57（全有効集合PUT。ResourceUsageEditor）。資産の詳細へは ?from= 付きで飛び、
 *   資産側の「元の出動記録に戻る」で戻れる。
 * - この画面は正式な指令系と別の記録である旨（D08）と、保存/同期状態を常に示す。
 */

/** 参集の状態（docs/11:34の固定語彙「参集済」「帰還記録」。出欠の不参加・実参加の欠席とは別物） */
const PARTICIPANT_META: Record<(typeof mobilizationStates)[number], { label: string; tone: "neutral" | "ok" | "attention" | "alert" }> = {
  unconfirmed: { label: "未確認", tone: "neutral" },
  mobilizing: { label: "参集中", tone: "attention" },
  arrived: { label: "参集済", tone: "ok" },
  returned: { label: "帰還記録", tone: "neutral" },
  unavailable: { label: "出動不可", tone: "alert" },
};

/** 遷移の候補に人の語を付ける（docs/11の許可辺だけを画面に出す） */
const SELF_NEXT: Partial<Record<(typeof mobilizationStates)[number], { value: (typeof mobilizationStates)[number]; label: string }[]>> = {
  unconfirmed: [
    { value: "mobilizing", label: "参集中にする" },
    { value: "arrived", label: "参集を記録" },
    { value: "returned", label: "帰還を記録" },
    { value: "unavailable", label: "出動不可にする" },
  ],
  mobilizing: [
    { value: "arrived", label: "参集を記録" },
    { value: "unavailable", label: "出動不可にする" },
  ],
  arrived: [{ value: "returned", label: "帰還を記録" }],
};

/** 遷移の候補に人の語を付ける（docs/11の許可辺だけを画面に出す）。primaryは区間ごとの主要アクション1つ */
const STATUS_TRANSITIONS: Partial<Record<string, { value: keyof typeof incidentTransitions; label: string; danger?: boolean; primary?: boolean }[]>> = {
  recording: [
    { value: "active", label: "出動中にする", primary: true },
    { value: "closed", label: "終了する" },
    { value: "voided", label: "無効にする", danger: true },
  ],
  active: [{ value: "closed", label: "終了する", primary: true }],
  closed: [{ value: "recording", label: "記録中に戻す（訂正）" }],
};

/** incident_events.action → 人の語（docs/04:95「種別訂正/操作元を保持」） */
const eventLabel = (action: string) => {
  if (action === "create") return "登録";
  if (action === "activity.link") return "活動と関連付け";
  const names: Record<string, string> = { status: "状態", kind: "種別", summary: "概要" };
  return action.split(".").map((t) => names[t] ?? t).join("・") + "を訂正";
};

const timeOrBlank = (iso: string | null) => (iso ? fmtHM(iso) : null);

export function IncidentPage() {
  const params = useParams<{ id: string }>();
  const id = params.id!;
  const { me } = useMe();
  /** PER-04は幹部・管理者が所属内で持つ（docs/10）。画面から権限一覧は持たないので操作は押してサーバーに判定させる */
  const canManage = me.roles.includes("officer") || me.roles.includes("admin");
  const online = useOnline();

  const [detail, setDetail] = useState<IncidentDetailDto | "loading" | "error">("loading");
  const [names, setNames] = useState<Map<string, string> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [statusTarget, setStatusTarget] = useState<string | null>(null);
  const [statusReason, setStatusReason] = useState("");
  const [correcting, setCorrecting] = useState(false);
  const [correctKind, setCorrectKind] = useState<(typeof incidentKinds)[number]>("simulation");
  const [correctSummary, setCorrectSummary] = useState("");
  const [correctReason, setCorrectReason] = useState("");
  const [linking, setLinking] = useState(false);
  const [editingUsages, setEditingUsages] = useState(false);

  const transition = useMutation("API-69");
  const link = useMutation("API-71");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = (await api("API-70", { params: { id } })) as unknown as IncidentDetailDto;
        if (alive) setDetail(data);
      } catch {
        if (alive) setDetail("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, reloadKey]);

  // 名前の対応（API-02。参集・登録者の表示）。取得できないときはIDの先頭で代用しない（読み込み中表示のまま）
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = (await api("API-02", { query: { limit: 200 } })) as unknown as { id: string; displayName: string }[];
        if (alive) setNames(new Map(rows.map((r) => [r.id, r.displayName])));
      } catch {
        if (alive) setNames(new Map());
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const nameOf = (memberId: string) => names?.get(memberId) ?? null;

  if (detail === "loading" || names === null) {
    return (
      <div className="flex max-w-[720px] flex-col gap-3">
        <SubHeader backTo="/app/incidents" />
        <div className="h-40 animate-pulse rounded-card bg-white/[.05]" />
        <div className="h-64 animate-pulse rounded-card bg-white/[.05]" />
      </div>
    );
  }
  if (detail === "error") {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <SubHeader backTo="/app/incidents" />
        <Banner tone="info" eyebrow="NOT FOUND" title="この出動記録は存在しないか、閲覧できません">
          <Link to="/app/incidents" className="underline">
            一覧へ戻る
          </Link>
        </Banner>
      </div>
    );
  }

  const kind = INCIDENT_KIND[detail.kind];
  const status = INCIDENT_STATUS[detail.status];
  const voided = detail.status === "voided";
  const myRow = detail.participants.find((p) => p.memberId === me.profile.memberId) ?? null;
  const backPath = `/app/incidents/${id}`;

  const runStatus = async (target: string) => {
    const r = await transition.run({
      params: { id },
      body: { version: detail.version, status: target as typeof detail.status, reason: statusReason.trim() },
    });
    if (r) {
      setStatusTarget(null);
      setStatusReason("");
      setReloadKey((k) => k + 1);
    }
  };

  const submitCorrection = async () => {
    const body: Record<string, unknown> = { version: detail.version, reason: correctReason.trim() };
    if (correctKind !== detail.kind) body.kind = correctKind;
    if (correctSummary.trim() !== detail.summary) body.summary = correctSummary.trim();
    const r = await transition.run({ params: { id }, body: body as never });
    if (r) {
      setCorrecting(false);
      setCorrectReason("");
      setReloadKey((k) => k + 1);
    }
  };

  const correctionHasChange = correctKind !== detail.kind || correctSummary.trim() !== detail.summary;

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <SubHeader
        backTo="/app/incidents"
        right={
          <span className="flex items-center gap-1.5">
            <Chip tone={status.tone}>{status.label}</Chip>
            <span className="hidden items-center gap-1.5 text-[11px] text-ink-muted lg:inline-flex">
              <span aria-hidden="true" className={`size-[7px] rounded-full ${online ? "bg-ok" : "bg-attention"}`} />
              {online ? "オンライン" : "オフライン"}
            </span>
          </span>
        }
      />

      {/* 種別＋概要（種別は目立つ文字で区分。docs/03 SCR-11/12） */}
      <div className="flex flex-col gap-2 px-0.5">
        <span className="flex items-center gap-1.5 font-mono text-[12px] font-bold tracking-[.1em]" style={{ color: kind.color }}>
          <span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: kind.color }} />
          {kind.label}
        </span>
        <h2 className="text-[26px] font-bold leading-[1.3]">{detail.summary}</h2>
        <p className="flex items-center gap-2 text-[12px] text-ink-muted">
          <span aria-hidden="true" className={`size-[7px] rounded-full ${online ? "bg-ok" : "bg-attention"}`} />
          {online ? "オンライン" : "オフライン"}（端末同期は後の機能で接続します）
        </p>
      </div>

      {/* 概要カード（発生日時・登録者・登録/更新） */}
      <Card className="flex flex-col gap-0 overflow-hidden p-0" aria-label="出動記録の概要">
        <InfoRow icon="schedule" mono>
          {fmtDay(detail.occurredAt)} {fmtHM(detail.occurredAt)}
        </InfoRow>
        <InfoRow icon="person">登録 {nameOf(detail.createdBy) ?? "読み込み中…"}</InfoRow>
        <InfoRow icon="history" mono>
          記録 {fmtInstant(detail.createdAt)} ・ 更新 {fmtInstant(detail.updatedAt)}
        </InfoRow>
      </Card>

      {/* 正式連絡に依存しない旨（docs/14 D08。prototype出動モードの注記を全画面で常時表示） */}
      <Notice tone="info" icon="info" role="status">
        この記録は正式な指令ではありません。現場の指揮は団長・消防署の指示に従ってください。本アプリは応答と記録の共有のための補助です。
      </Notice>

      {voided && (
        <Banner tone="warning" eyebrow="VOIDED" role="status" title="この出動記録は無効になっています">
          無効化された記録は閲覧だけできます（集計には含まれません）。参集や使用履歴の変更はできません。
        </Banner>
      )}

      {/* 状態の操作（API-69。理由必須。voidedは終端なので操作を出さない） */}
      {!voided && (
        <div className="flex flex-wrap items-center gap-2">
          {(STATUS_TRANSITIONS[detail.status] ?? []).map((t) => (
            <Button
              key={t.value}
              variant={t.primary ? "primary" : "secondary"}
              busy={transition.saving}
              className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11"
              onClick={() => {
                setStatusReason("");
                setStatusTarget(t.value);
              }}
            >
              {t.label}
            </Button>
          ))}
          <Button
            variant="secondary"
            busy={transition.saving}
            className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11"
            onClick={() => {
              setCorrectKind(detail.kind);
              setCorrectSummary(detail.summary);
              setCorrectReason("");
              setCorrecting(true);
            }}
          >
            種別・概要を訂正
          </Button>
        </div>
      )}
      <MutationStatus state={transition.state} toastBottom={110} />
      {/* リンクの保存結果はダイアログを閉じたあとも出す（ダイアログ内は失敗の案内だけ） */}
      {!linking && <MutationStatus state={link.state} toastBottom={110} />}

      {/* 関連活動（API-71で既存活動とリンク。リンク後は双方の詳細から相互導線） */}
      <section className="flex flex-col gap-2" aria-label="関連活動">
        <h3 className="text-[14px] font-bold">関連活動</h3>
        {detail.activity ? (
          <ActivityCard activity={detail.activity} linked />
        ) : (
          <Card className="flex flex-col gap-2">
            <p className="text-[13px] text-ink-sub">関連付けた活動はまだありません。既存の予定・活動と一つの出来事としてまとめられます。</p>
            {!voided && (
              <Button variant="secondary" className="!h-[46px] !w-auto self-start px-4 !text-[13px] max-lg:min-h-11" onClick={() => setLinking(true)}>
                関連活動を探す
              </Button>
            )}
          </Card>
        )}
      </section>

      {/* 参集・帰還（API-23。本人/代理。未知時刻は未記載） */}
      <Participants
        incidentId={id}
        detail={detail}
        myRow={myRow}
        nameOf={nameOf}
        me={me.profile.memberId}
        canManage={canManage}
        voided={voided}
        onChanged={() => setReloadKey((k) => k + 1)}
      />

      {/* 車両・機材の使用（API-57。docs/04:100。cancelledも履歴として残る。リンク後は活動側operationの行も全て見える） */}
      <section className="flex flex-col gap-2" aria-label="車両・機材の使用">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[14px] font-bold">車両・機材の使用</h3>
          {!voided && !editingUsages && (
            <Button variant="secondary" className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={() => setEditingUsages(true)}>
              使用履歴を編集
            </Button>
          )}
        </div>
        {editingUsages && !voided && (
          <ResourceUsageEditor
            mode="edit"
            operationId={detail.operationId}
            initialRows={detail.resourceUsages}
            operationVersion={detail.operationVersion}
            onSaved={() => setReloadKey((k) => k + 1)}
            onDone={() => setEditingUsages(false)}
            onCancel={() => setEditingUsages(false)}
          />
        )}
        <Card className="flex flex-col gap-2">
          {detail.resourceUsages.length === 0 ? (
            <p className="text-[13px] text-ink-sub">使用した車両・機材の記録はまだありません。</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {detail.resourceUsages.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-field bg-white/[.04] px-3 py-2 text-[13px]">
                  <span aria-hidden="true" className="ms text-[18px] text-ink-muted">
                    {u.target.type === "vehicle" ? "local_shipping" : "inventory_2"}
                  </span>
                  <Link
                    to={`/app/assets/${u.target.type}/${u.target.id}?from=${encodeURIComponent(backPath)}`}
                    className="min-w-0 flex-1 truncate font-bold underline"
                  >
                    <UsageName target={u.target.type} targetId={u.target.id} />
                  </Link>
                  <span>数量 {u.quantity}</span>
                  <span className="font-mono text-[11px] text-ink-muted">
                    {u.usedFrom ? `${fmtHM(u.usedFrom)}${u.usedTo ? `–${fmtHM(u.usedTo)}` : ""}` : "時刻 未記載"}
                  </span>
                  {u.status === "cancelled" ? <Chip tone="neutral">取消</Chip> : <Chip tone="ok">使用中</Chip>}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[12px] text-ink-muted">資産の詳細から「元の出動記録に戻る」でここへ戻れます。台帳の数量は使用で動きません。</p>
        </Card>
      </section>

      {/* 履歴（incident_events。docs/04:95「種別訂正/操作元を保持」） */}
      <section className="flex flex-col gap-2" aria-label="変更の履歴">
        <h3 className="text-[14px] font-bold">履歴</h3>
        <Card className="flex flex-col gap-2">
          {detail.events.length === 0 ? (
            <p className="text-[13px] text-ink-sub">まだ履歴がありません。</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {detail.events.map((e) => {
                const beforeStatus = typeof e.before.status === "string" ? INCIDENT_STATUS[e.before.status as keyof typeof INCIDENT_STATUS] : null;
                const afterStatus = typeof e.after.status === "string" ? INCIDENT_STATUS[e.after.status as keyof typeof INCIDENT_STATUS] : null;
                return (
                  <li key={e.id} className="flex flex-col gap-1 rounded-field bg-white/[.04] px-3 py-2">
                    <span className="flex flex-wrap items-center gap-2 text-[13px] font-bold">
                      {eventLabel(e.action)}
                      <span className="font-mono text-[11px] font-medium text-ink-muted">{fmtInstant(e.createdAt)}</span>
                    </span>
                    {beforeStatus && afterStatus && beforeStatus.label !== afterStatus.label && (
                      <span className="text-[12px] text-ink-sub">
                        {beforeStatus.label} → {afterStatus.label}
                      </span>
                    )}
                    {e.reason && <span className="text-[12px] leading-[1.6] text-ink-sub">理由：{e.reason}</span>}
                  </li>
                );
              })}
            </ol>
          )}
        </Card>
      </section>

      {/* 状態変更の確認（API-69は理由必須。docs/11「訂正/無効化理由」） */}
      {statusTarget && (
        <ConfirmDialog
          title={statusTarget === "voided" ? "この出動記録を無効にしますか" : `この出動記録を「${INCIDENT_STATUS[statusTarget as keyof typeof INCIDENT_STATUS].label}」にしますか`}
          confirmLabel={statusTarget === "voided" ? "無効にする" : "変更する"}
          busy={transition.saving}
          danger={statusTarget === "voided"}
          onConfirm={() => void runStatus(statusTarget)}
          onCancel={() => setStatusTarget(null)}
        >
          <p>
            {statusTarget === "voided"
              ? "無効にすると記録は残りますが集計から外れ、以後は閲覧だけになります。取り消しはできません。"
              : "変更の前後は履歴に残ります。"}
          </p>
          <TextArea name="status-reason" label="理由（必須）" value={statusReason} onChange={(e) => setStatusReason(e.target.value)} />
          {statusReason.trim() === "" && <p className="text-[12px] font-medium text-attention">理由を入力してください</p>}
        </ConfirmDialog>
      )}

      {/* 種別・概要の訂正（API-69。種別は状態と独立に訂正できる。docs/11） */}
      {correcting && (
        <ConfirmDialog
          title="種別・概要を訂正しますか"
          confirmLabel="訂正する"
          busy={transition.saving}
          onConfirm={() => {
            if (!correctionHasChange || !correctReason.trim()) return;
            void submitCorrection();
          }}
          onCancel={() => setCorrecting(false)}
        >
          <div className="flex flex-col gap-3 text-left">
            <div className="flex flex-col gap-2">
              <span className="text-[12px] font-bold text-ink-sub">種別</span>
              <div className="grid grid-cols-3 gap-2">
                {(["simulation", "training", "actual_record"] as const).map((k) => {
                  const meta = INCIDENT_KIND[k];
                  const on = correctKind === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setCorrectKind(k)}
                      className={`flex min-h-11 items-center justify-center rounded-field px-2 text-[13px] font-bold ${on ? "" : "bg-white/[.06] text-ink-sub"}`}
                      style={on ? { background: `${meta.color}26`, color: meta.color, boxShadow: `inset 0 0 0 1.5px ${meta.color}` } : {}}
                    >
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <TextField name="correct-summary" label="概要" value={correctSummary} onChange={(e) => setCorrectSummary(e.target.value)} />
            <TextArea name="correct-reason" label="訂正の理由（必須）" value={correctReason} onChange={(e) => setCorrectReason(e.target.value)} />
            {!correctionHasChange && <p className="text-[12px] font-medium text-attention">種別か概要を変えてください</p>}
            {correctionHasChange && correctReason.trim() === "" && <p className="text-[12px] font-medium text-attention">理由を入力してください</p>}
          </div>
        </ConfirmDialog>
      )}

      {/* 関連活動の検索とリンク（API-71。両root＋双方のoperation版をロック。理由必須） */}
      {linking && (
        <LinkDialog
          incident={detail}
          onClose={() => setLinking(false)}
          onLinked={() => {
            setLinking(false);
            setReloadKey((k) => k + 1);
          }}
          mutation={link}
        />
      )}
    </div>
  );
}

/** 情報カードの1行（prototype: アイコン＋14px。等幅の時刻） */
function InfoRow({ icon, mono, children }: { icon: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-white/[.06] px-4 py-3.5 last:border-b-0">
      <span aria-hidden="true" className="ms text-[20px] text-ink-muted">
        {icon}
      </span>
      <span className={`text-[14px] font-medium ${mono ? "font-mono" : ""}`}>{children}</span>
    </div>
  );
}

/** 使用履歴の行の資産名（useAssetName。読み込み中は「読み込み中…」。IDをそのまま出さない） */
function UsageName({ target, targetId }: { target: "vehicle" | "equipment"; targetId: string }) {
  const name = useAssetName(target, targetId);
  return <>{name ?? "読み込み中…"}</>;
}

/** 関連活動のカード（出動の詳細に載る活動。リンク後は活動側からも戻れる） */
function ActivityCard({ activity, linked }: { activity: ActivityDto; linked: boolean }) {
  return (
    <Link
      to={`/app/activities/${activity.id}`}
      className="flex flex-col gap-1 rounded-[20px] bg-white/[.04] p-3.5 shadow-[inset_0_0_0_1px_rgba(255,255,255,.07)] hover:bg-white/[.07]"
    >
      <span className="flex items-center gap-2 text-[11px] font-medium text-ink-sub">
        <Icon name="link" className="text-[14px]" />
        {linked ? "関連付けた活動" : "活動"}
      </span>
      <span className="truncate text-[15px] font-bold">{activity.title}</span>
      <span className="flex items-center gap-2 text-[12px] text-ink-muted">
        <span>{activity.kind}</span>
        <span className="font-mono">
          {fmtDay(activity.plannedStartsAt)} {fmtHM(activity.plannedStartsAt)}
        </span>
      </span>
    </Link>
  );
}

/**
 * 関連活動の検索とリンク（API-71）。出動と活動、双方の出来事rootの現行版を送る（docs/05「両rootロック」）。
 * 版は出動の詳細（API-70）と活動の詳細（API-07）のoperationVersion。読み取り直後の版なので、
 * 並行で変更が入っていればサーバーが409で全体を何も変えずに拒否する。
 */
function LinkDialog({
  incident,
  onClose,
  onLinked,
  mutation,
}: {
  incident: IncidentDetailDto;
  onClose: () => void;
  onLinked: () => void;
  mutation: ReturnType<typeof useMutation<"API-71">>;
}) {
  const [query, setQuery] = useState("");
  const [activities, setActivities] = useState<ActivityDto[] | null>(null);
  const [selected, setSelected] = useState<ActivityDto | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<{ version: number; operationId: string; operationVersion: number } | null>(null);
  const [selectedError, setSelectedError] = useState(false);
  const [reason, setReason] = useState("");

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

  const choose = async (a: ActivityDto) => {
    setSelected(a);
    setSelectedDetail(null);
    setSelectedError(false);
    try {
      const d = (await api("API-07", { params: { id: a.id } })) as unknown as {
        version: number;
        operationId: string;
        operationVersion: number;
      };
      setSelectedDetail(d);
    } catch {
      setSelectedError(true);
    }
  };

  const candidates = (activities ?? []).filter((a) => query.trim() === "" || a.title.includes(query.trim()));

  const submit = async () => {
    if (!selected || !selectedDetail || !reason.trim()) return;
    const r = await mutation.run({
      params: { id: incident.id },
      body: {
        version: incident.version,
        activityId: selected.id,
        activityVersion: selectedDetail.version,
        operationVersions: {
          [incident.operationId]: incident.operationVersion,
          [selectedDetail.operationId]: selectedDetail.operationVersion,
        },
        reason: reason.trim(),
      },
    });
    if (r) onLinked();
  };

  return (
    <ConfirmDialog
      title="関連活動の検索"
      confirmLabel="関連付ける"
      busy={mutation.saving}
      confirmDisabled={!selected || !selectedDetail || selectedError || !reason.trim()}
      onConfirm={() => void submit()}
      onCancel={onClose}
    >
      <div className="flex flex-col gap-3 text-left">
        {selected ? (
          <div className="flex flex-wrap items-center gap-2 rounded-field bg-white/[.06] px-3 py-2.5">
            <Icon name="link" className="text-[18px] text-ink-muted" />
            <span className="min-w-0 flex-1 truncate text-[14px] font-bold">{selected.title}</span>
            {selectedDetail ? <Chip tone="ok">版を確認済み</Chip> : selectedError ? <Chip tone="alert">読めません</Chip> : <Chip tone="neutral">確認中…</Chip>}
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setSelectedDetail(null);
              }}
              className="inline-flex min-h-11 items-center text-[12px] font-bold text-ink-sub underline lg:min-h-9"
            >
              外す
            </button>
          </div>
        ) : (
          <>
            <TextField name="link-query" label="活動を探す" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="活動の題で探す" />
            <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto" aria-label="候補の活動">
              {candidates.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => void choose(a)}
                    className="flex w-full items-center gap-2 rounded-field bg-white/[.04] px-3 py-2 text-left text-[13px] font-medium hover:bg-white/[.08]"
                  >
                    <span className="min-w-0 flex-1 truncate font-bold">{a.title}</span>
                    <span className="font-mono text-[11px] text-ink-muted">{a.kind}</span>
                  </button>
                </li>
              ))}
              {activities !== null && candidates.length === 0 && <li className="px-1 text-[12px] text-ink-muted">該当する活動はありません。</li>}
              {activities === null && <li className="px-1 text-[12px] text-ink-muted">活動を読み込んでいます…</li>}
            </ul>
          </>
        )}
        <TextArea name="link-reason" label="関連付ける理由（必須）" value={reason} onChange={(e) => setReason(e.target.value)} />
        {!reason.trim() && <p className="text-[12px] font-medium text-attention">理由を入力してください</p>}
        {selected && !selectedDetail && !selectedError && <p className="text-[12px] text-ink-muted">活動の最新の状態を確認しています…</p>}
        {selectedError && <p className="text-[12px] font-medium text-attention">活動の詳細を読めません。閉じて開き直してください。</p>}
        {/* 失敗は共通の状態表示（保存済みのトーストだけはダイアログを閉じた側の画面で出す） */}
        <MutationStatus state={mutation.state.kind === "saved" || mutation.state.kind === "idle" ? { kind: "idle" } : mutation.state} toastBottom={110} />
      </div>
    </ConfirmDialog>
  );
}

/**
 * 参集・帰還（API-23）。本人は自分の行を、代理は対象団員×PER-04の担当(scope)を持つ者だけが記録できる
 * （画面では権限の有無を判定できないため、押して403ならその案内をそのまま出す。T039と同じ流儀）。
 * 行の無い状態がunconfirmed（未確認）で、初回はversion=0で行を作る。voidedでは記録操作を出さない。
 */
function Participants({
  incidentId,
  detail,
  myRow,
  nameOf,
  me,
  canManage,
  voided,
  onChanged,
}: {
  incidentId: string;
  detail: IncidentDetailDto;
  myRow: IncidentDetailDto["participants"][number] | null;
  nameOf: (id: string) => string | null;
  me: string;
  canManage: boolean;
  voided: boolean;
  onChanged: () => void;
}) {
  return (
    <section className="flex flex-col gap-2" aria-label="参集・帰還">
      <h3 className="text-[14px] font-bold">参集・帰還</h3>
      <Card className="flex flex-col gap-2">
        <ul className="flex flex-col gap-1.5" aria-label="参集の記録">
          {detail.participants.map((p) => {
            const meta = PARTICIPANT_META[p.attendanceStatus];
            return (
              <li key={p.id} className="flex flex-col gap-1 rounded-field bg-white/[.04] px-3 py-2">
                <span className="flex flex-wrap items-center gap-2">
                  <span aria-hidden="true" className="grid size-[26px] flex-none place-items-center rounded-full bg-[#1a2740] text-[11px] font-bold text-[#c3cad6]">
                    {initialOf(nameOf(p.memberId) ?? "?")}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {nameOf(p.memberId) ?? "読み込み中…"}
                    {p.memberId === me && <span className="ml-1 text-[12px] text-ink-muted">（自分）</span>}
                  </span>
                  <Chip tone={meta.tone}>{meta.label}</Chip>
                </span>
                <span className="flex flex-wrap gap-x-3 gap-y-0.5 pl-[34px] font-mono text-[11px] text-ink-muted">
                  <span>出発 {timeOrBlank(p.mobilizedAt) ?? "未記載"}</span>
                  <span>到着 {timeOrBlank(p.arrivedAt) ?? "未記載"}</span>
                  <span>帰還 {timeOrBlank(p.returnedAt) ?? "未記載"}</span>
                </span>
              </li>
            );
          })}
          {detail.participants.length === 0 && <li className="text-[13px] text-ink-sub">参集の記録はまだありません。</li>}
        </ul>
        {!voided && <MyRecord incidentId={incidentId} myMemberId={me} myRow={myRow} onChanged={onChanged} />}
        {!voided && canManage && <ProxyRecord incidentId={incidentId} rows={detail.participants} onChanged={onChanged} />}
      </Card>
      <p className="text-[12px] text-ink-muted">わからない時刻は空欄のままで構いません（未記載として残ります）。帰還だけの事後記録もできます。</p>
    </section>
  );
}

/** 自分の参集・帰還の記録（API-23本人分）。状態の候補はdocs/11の許可辺だけを出す。
 * arrived→returned（帰還）は専用フォームで、到着時刻は既存値を維持する（事後の帰還記録では捏造しない）。
 * returned/unavailableは終端。同一状態での時刻の入力は「時刻の訂正」として送る（docs/11「履歴訂正は別イベント」）。
 */
function MyRecord({
  incidentId,
  myMemberId,
  myRow,
  onChanged,
}: {
  incidentId: string;
  myMemberId: string;
  myRow: IncidentDetailDto["participants"][number] | null;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<"none" | "status" | "next">("none");
  const record = useMutation("API-23");
  const close = () => setMode("none"); // 保存結果のトーストは下で出し続けるため state は触らない

  const submit = async (attendanceStatus: (typeof mobilizationStates)[number], times: Record<string, string>) => {
    const r = await record.run({
      params: { id: incidentId, memberId: myMemberId },
      body: {
        version: myRow?.version ?? 0,
        attendanceStatus,
        ...(Object.keys(times).length > 0 ? { times } : {}),
      },
    });
    if (r) {
      close();
      onChanged();
    }
  };

  const meta = myRow ? PARTICIPANT_META[myRow.attendanceStatus] : null;

  /** 既存行があるときのフォーム。状態の候補はdocs/11の許可辺＋同一状態での時刻の訂正 */
  const nextChoices: Record<string, { value: (typeof mobilizationStates)[number]; label: string }[]> = {
    mobilizing: [
      { value: "arrived", label: "参集済にする" },
      { value: "mobilizing", label: "参集中のまま時刻を訂正" },
      { value: "unavailable", label: "出動不可にする" },
    ],
    arrived: [
      { value: "returned", label: "帰還記録にする" },
      { value: "arrived", label: "参集済のまま時刻を訂正" },
    ],
    returned: [{ value: "returned", label: "帰還記録のまま時刻を訂正" }],
  };
  const nextLabel =
    myRow?.attendanceStatus === "mobilizing" ? "参集を記録" : myRow?.attendanceStatus === "arrived" ? "帰還を記録" : "時刻を訂正";
  const nextFormLabel =
    myRow?.attendanceStatus === "mobilizing" ? "自分の参集の記録" : myRow?.attendanceStatus === "arrived" ? "自分の帰還の記録" : "自分の時刻の訂正";

  const formBody = (choices: { value: (typeof mobilizationStates)[number]; label: string }[], formLabel: string) => (
    <RecordForm
      label={formLabel}
      previousStatus={myRow?.attendanceStatus ?? "unconfirmed"}
      choices={choices}
      initialTimes={{
        mobilizedAt: inputOrBlank(myRow?.mobilizedAt ?? null),
        arrivedAt: inputOrBlank(myRow?.arrivedAt ?? null),
        returnedAt: inputOrBlank(myRow?.returnedAt ?? null),
      }}
      busy={record.saving}
      state={record.state}
      submitLabel="記録を保存"
      onSubmit={submit}
      onCancel={close}
    />
  );

  const buttons = (
    <div className="flex flex-wrap items-center gap-2">
      {!myRow && (
        <Button variant="secondary" className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={() => setMode("status")}>
          自分の参集を記録
        </Button>
      )}
      {myRow && meta && (
        <>
          <span className="text-[12px] text-ink-sub">あなたの記録：</span>
          <Chip tone={meta.tone}>{meta.label}</Chip>
          {nextChoices[myRow.attendanceStatus] && (
            <Button busy={record.saving} className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={() => setMode("next")}>
              {nextLabel}
            </Button>
          )}
          {myRow.attendanceStatus === "unavailable" && (
            <span className="text-[12px] text-ink-muted">出動不可で終了しています（変更はできません）。</span>
          )}
        </>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-2">
      {mode === "status" &&
        formBody(
          (SELF_NEXT.unconfirmed ?? []).map((c) => ({ value: c.value, label: PARTICIPANT_META[c.value].label })),
          "自分の参集の記録",
        )}
      {mode === "next" && myRow && formBody(nextChoices[myRow.attendanceStatus] ?? [], nextFormLabel)}
      {buttons}
      {/* フォームを閉じたあとも「保存しました」が見えるように、フォームの外で保存結果を出す */}
      <MutationStatus state={record.state.kind === "saved" ? record.state : { kind: "idle" }} toastBottom={100} />
    </div>
  );
}

/** 代理での参集記録（API-23。対象団員×PER-04の担当scopeが無ければサーバーが403で返し、その案内を出す） */
function ProxyRecord({
  incidentId,
  rows,
  onChanged,
}: {
  incidentId: string;
  rows: IncidentDetailDto["participants"];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<{ id: string; displayName: string }[]>([]);
  const [memberId, setMemberId] = useState("");
  const [status, setStatus] = useState<(typeof mobilizationStates)[number]>("arrived");
  const [times, setTimes] = useState<{ mobilizedAt: string; arrivedAt: string; returnedAt: string }>({ mobilizedAt: "", arrivedAt: "", returnedAt: "" });
  const [reason, setReason] = useState("");
  const record = useMutation("API-23");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const list = (await api("API-02", { query: { limit: 200 } })) as unknown as { id: string; displayName: string }[];
        if (alive) setMembers(list);
      } catch {
        if (alive) setMembers([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!open) {
    return (
      <Button variant="secondary" className="!h-[46px] !w-auto self-start px-4 !text-[13px] max-lg:min-h-11" onClick={() => setOpen(true)}>
        他の人の参集を記録（代理）
      </Button>
    );
  }

  const close = () => {
    setOpen(false);
    setMemberId("");
    setTimes({ mobilizedAt: "", arrivedAt: "", returnedAt: "" });
    setReason("");
    record.reset();
  };

  const submit = async () => {
    if (!memberId) return;
    const payloadTimes = Object.fromEntries(Object.entries(times).filter(([, v]) => v !== ""));
    const r = await record.run({
      params: { id: incidentId, memberId },
      body: {
        version: rows.find((p) => p.memberId === memberId)?.version ?? 0,
        attendanceStatus: status,
        ...(Object.keys(payloadTimes).length > 0 ? { times: payloadTimes } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      },
    });
    if (r) {
      close();
      onChanged();
    }
  };

  return (
    <Card className="flex flex-col gap-3" aria-label="代理での参集の記録">
      <span className="text-[13px] font-bold">代理で参集を記録</span>
      <label className="hairline flex h-[54px] items-center gap-2 rounded-field bg-white/[.06] px-4">
        <span className="text-[12px] font-bold text-ink-sub">団員</span>
        <select
          aria-label="代理で記録する団員"
          value={memberId}
          onChange={(e) => setMemberId(e.target.value)}
          className="min-w-0 flex-1 border-none bg-transparent text-[14px] font-medium text-ink outline-none"
        >
          <option value="">選んでください</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-2" role="group" aria-label="代理で記録する状態">
        {(["mobilizing", "arrived", "returned", "unavailable"] as const).map((s) => {
          const meta = PARTICIPANT_META[s];
          const on = status === s;
          return (
            <button
              key={s}
              type="button"
              aria-pressed={on}
              onClick={() => setStatus(s)}
              className={`flex min-h-11 flex-1 items-center justify-center rounded-field px-3 text-[13px] font-bold ${on ? "bg-ember text-white" : "bg-white/[.06] text-ink-sub"}`}
            >
              {meta.label}
            </button>
          );
        })}
      </div>
      <TimeFields value={times} onChange={setTimes} />
      <TextField
        name="proxy-reason"
        label="代理で記録する理由（任意）"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="例: 本人から電話で連絡"
      />
      <p className="text-[11px] text-ink-muted">代理での記録には、その団員を対象にした担当（scope）が必要です。無ければ保存が拒否されます。</p>
      <MutationStatus state={record.state} toastBottom={100} />
      <div className="flex gap-2">
        <Button busy={record.saving} onClick={() => void submit()} className="!h-[46px] max-lg:min-h-11 !text-[13px]">
          代理で記録を保存
        </Button>
        <Button variant="secondary" busy={record.saving} onClick={close} className="!h-[46px] max-lg:min-h-11 flex-none px-4 !text-[13px]">
          閉じる
        </Button>
      </div>
    </Card>
  );
}

/** 参集フォームの時刻欄（3つとも任意。空欄は「わからない」で、既存値は維持される） */
function TimeFields({
  value,
  onChange,
  labels = { mobilizedAt: "出発（参集）時刻", arrivedAt: "到着時刻", returnedAt: "帰還時刻" },
}: {
  value: { mobilizedAt: string; arrivedAt: string; returnedAt: string };
  onChange: (next: { mobilizedAt: string; arrivedAt: string; returnedAt: string }) => void;
  labels?: { mobilizedAt: string; arrivedAt: string; returnedAt: string };
}) {
  return (
    <div className="grid gap-2.5 lg:grid-cols-3">
      <TextField name="time-mobilized" label={labels.mobilizedAt} type="datetime-local" value={value.mobilizedAt} onChange={(e) => onChange({ ...value, mobilizedAt: e.target.value })} />
      <TextField name="time-arrived" label={labels.arrivedAt} type="datetime-local" value={value.arrivedAt} onChange={(e) => onChange({ ...value, arrivedAt: e.target.value })} />
      <TextField name="time-returned" label={labels.returnedAt} type="datetime-local" value={value.returnedAt} onChange={(e) => onChange({ ...value, returnedAt: e.target.value })} />
    </div>
  );
}

/** 参集の記録フォーム（本人・代理の共用。状態の候補は呼び出し側が許可辺だけを渡す）。
 * 変更なしの送信は防ぐ（API-23の400 no_changesを画面で先に防ぐ）：状態が前と同じで、
 * 時刻も初期値から動いていないときは保存できない */
function RecordForm({
  label,
  choices,
  previousStatus,
  initialTimes,
  busy,
  state,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  label: string;
  choices: { value: (typeof mobilizationStates)[number]; label: string }[];
  previousStatus: (typeof mobilizationStates)[number];
  initialTimes: Partial<Record<"mobilizedAt" | "arrivedAt" | "returnedAt", string>>;
  busy: boolean;
  state: ReturnType<typeof useMutation<"API-23">>["state"];
  submitLabel: string;
  onSubmit: (status: (typeof mobilizationStates)[number], times: Record<string, string>) => Promise<void>;
  onCancel: () => void;
}) {
  const [status, setStatus] = useState<(typeof mobilizationStates)[number]>(choices[0]!.value);
  const [times, setTimes] = useState<{ mobilizedAt: string; arrivedAt: string; returnedAt: string }>({
    mobilizedAt: initialTimes.mobilizedAt ?? "",
    arrivedAt: initialTimes.arrivedAt ?? "",
    returnedAt: initialTimes.returnedAt ?? "",
  });
  const [touched, setTouched] = useState(false);
  const noChange =
    status === previousStatus &&
    times.mobilizedAt === (initialTimes.mobilizedAt ?? "") &&
    times.arrivedAt === (initialTimes.arrivedAt ?? "") &&
    times.returnedAt === (initialTimes.returnedAt ?? "");
  const submit = async () => {
    setTouched(true);
    if (noChange) return;
    const payloadTimes = Object.fromEntries(Object.entries(times).filter(([, v]) => v !== ""));
    await onSubmit(status, payloadTimes);
  };
  return (
    <Card className="flex flex-col gap-3" aria-label={label}>
      <span className="text-[13px] font-bold">{label}</span>
      <div className="flex flex-wrap gap-2" role="group" aria-label="状態">
        {choices.map((c) => {
          const on = status === c.value;
          return (
            <button
              key={c.value}
              type="button"
              aria-pressed={on}
              onClick={() => setStatus(c.value)}
              className={`flex min-h-11 flex-1 items-center justify-center rounded-field px-3 text-[13px] font-bold ${on ? "bg-ember text-white" : "bg-white/[.06] text-ink-sub"}`}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      <TimeFields value={times} onChange={setTimes} />
      <p className="text-[11px] text-ink-muted">わからない時刻は空欄にしてください（既存の時刻は維持され、未知のまま残ります）。</p>
      {touched && noChange && <p className="text-[12px] font-medium text-attention">状態か時刻を変えてください</p>}
      <MutationStatus state={state} toastBottom={100} />
      <div className="flex gap-2">
        <Button busy={busy} onClick={() => void submit()} className="!h-[46px] max-lg:min-h-11 !text-[13px]">
          {submitLabel}
        </Button>
        <Button variant="secondary" busy={busy} onClick={onCancel} className="!h-[46px] max-lg:min-h-11 flex-none px-4 !text-[13px]">
          閉じる
        </Button>
      </div>
    </Card>
  );
}

/** Instant → datetime-localの値。null（未知）は空欄のまま（activities/time.tsの入力変換と同じ） */
const inputOrBlank = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
