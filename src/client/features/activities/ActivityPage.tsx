import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../../api";
import { ConfirmDialog } from "../../components/Overlay";
import { LeaveConfirm } from "../../components/LeaveConfirm";
import { MutationStatus } from "../../components/MutationStatus";
import { SubHeader } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, TextArea } from "../../components/ui";
import { initialOf, useMe } from "../../me";
import { useMutation } from "../../useMutation";
import type { ActivityDetailDto, ActivityResultDto, ActivityResultRevisionDto } from "../../../shared/contracts/operations";
import { ACTIVITY_STATUS, kindColor } from "./ActivitiesPage";
import { ActualResultForm, type ActualFormInitial } from "./ActualResultForm";
import { fmtDay, fmtHM, fmtInstant } from "./time";
import { ResourceUsageEditor, useAssetName } from "../operations/ResourceUsageEditor";

/** 使用履歴の行の資産名（useAssetName。読み込み中は「読み込み中…」。IDをそのまま出さない） */
function AssetName({ target, targetId }: { target: "vehicle" | "equipment"; targetId: string }) {
  const name = useAssetName(target, targetId);
  return <>{name ?? "読み込み中…"}</>;
}

/**
 * 予定・活動の詳細（T039、SCR-09。prototype の活動詳細）。
 * 本人出欠（API-08。締切と受付状態を表示）、対象者の一覧と代理回答（API-41。D05の許可scope＋理由必須）、
 * 予定の公開・中止（API-39/40）、実績の入力・訂正・旧版（API-09/42/43）を同じ画面で完結させる。
 * 「参加予定」（出欠attending）と「実参加」（actual participated）は必ず別の語で表示する（docs/11:34 固定語彙）。
 */

type AttendanceResponse = ActivityDetailDto["attendance"][number]["response"];

/** 出欠の回答は色と文字で示す（docs/11 出欠。prototype rsvpOptsの語彙） */
const RESPONSE_META: Record<AttendanceResponse, { label: string; tone: "neutral" | "ok" | "attention" | "alert" }> = {
  attending: { label: "参加", tone: "ok" },
  undecided: { label: "未定", tone: "attention" },
  absent: { label: "不参加", tone: "alert" },
  unanswered: { label: "未回答", tone: "neutral" },
};
/** 実参加の状態（docs/11:34「実参加」を固定語彙として使う。出欠の「参加」と混同しない） */
const ACTUAL_META: Record<ActivityResultRevisionDto["participants"][number]["actualStatus"], { label: string; tone: "neutral" | "ok" }> = {
  participated: { label: "実参加", tone: "ok" },
  absent: { label: "欠席", tone: "neutral" },
  unconfirmed: { label: "未確認", tone: "neutral" },
};

const RSVP_CHOICES: { value: Exclude<AttendanceResponse, "unanswered">; label: string; icon: string; color: string }[] = [
  { value: "attending", label: "参加", icon: "check_circle", color: "#3ad08f" },
  { value: "undecided", label: "未定", icon: "help", color: "#ffc35c" },
  { value: "absent", label: "不参加", icon: "cancel", color: "#ff7a66" },
];

interface HistoryData {
  result: ActivityResultDto;
  revisions: ActivityResultRevisionDto[];
}

export function ActivityPage() {
  const params = useParams<{ id: string }>();
  const id = params.id!;
  const { me } = useMe();
  /** PER-03/04は幹部・管理者が所属内で持つ（docs/10）。担当者scopeは画面からは判定できないためサーバーが拒否する */
  const canManage = me.roles.includes("officer") || me.roles.includes("admin");

  const [detail, setDetail] = useState<ActivityDetailDto | "loading" | "error">("loading");
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [names, setNames] = useState<Map<string, string> | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [revisionNo, setRevisionNo] = useState<number | null>(null); // null=現行版
  const [formMode, setFormMode] = useState<"closed" | "create" | "correct">("closed");
  const [editingUsages, setEditingUsages] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState<"in_progress" | "completed" | null>(null);
  const [statusReason, setStatusReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");

  const transition = useMutation("API-39");
  const cancel = useMutation("API-40");
  const rsvp = useMutation("API-08");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = (await api("API-07", { params: { id } })) as unknown as ActivityDetailDto;
        if (!alive) return;
        setDetail(data);
        setHistory(null);
        setRevisionNo(null);
        if (data.result) {
          const h = (await api("API-43", { params: { id }, query: {} })) as unknown as HistoryData;
          if (alive) setHistory(h);
        }
      } catch {
        if (alive) setDetail("error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, reloadKey]);

  // 名前の対応（API-02。対象者・実参加の表示）。取得できないときはIDの先頭で代用しない（読み込み中表示のまま）
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
        <SubHeader backTo="/app/activities" />
        <div className="h-40 animate-pulse rounded-card bg-white/[.05]" />
        <div className="h-64 animate-pulse rounded-card bg-white/[.05]" />
      </div>
    );
  }
  if (detail === "error") {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <SubHeader backTo="/app/activities" />
        <Banner tone="info" eyebrow="NOT FOUND" title="この予定は存在しないか、閲覧できません">
          <Link to="/app/activities" className="underline">
            一覧へ戻る
          </Link>
        </Banner>
      </div>
    );
  }

  const meta = ACTIVITY_STATUS[detail.status];
  const nowIso = new Date().toISOString();
  const receptionOpen = detail.status === "scheduled" || detail.status === "in_progress";
  const duePassed = detail.responseDueAt !== null && detail.responseDueAt < nowIso;
  const usages = detail.resourceUsages;

  // 対象snapshot（activity_audience）と出欠の行。未回答=対象snapshot−(response≠unansweredの行)（docs/04、T036の方式）
  const rowByMember = new Map(detail.attendance.map((r) => [r.memberId, r]));
  const audienceRows = detail.audience.map((memberId) => ({ memberId, row: rowByMember.get(memberId) }));
  const responseOf = (memberId: string): AttendanceResponse => rowByMember.get(memberId)?.response ?? "unanswered";
  const counts = {
    attending: audienceRows.filter((r) => responseOf(r.memberId) === "attending").length,
    undecided: audienceRows.filter((r) => responseOf(r.memberId) === "undecided").length,
    absent: audienceRows.filter((r) => responseOf(r.memberId) === "absent").length,
    unanswered: audienceRows.filter((r) => responseOf(r.memberId) === "unanswered").length,
  };
  const myRow = rowByMember.get(me.profile.memberId);
  const inAudience = detail.audience.includes(me.profile.memberId);

  const currentRevision = detail.result?.currentRevision ?? null;
  const selectedRevision =
    history?.revisions.find((r) => r.revisionNo === revisionNo) ?? (revisionNo === null ? currentRevision : undefined) ?? null;
  const actualNames =
    currentRevision?.participants.filter((p) => p.actualStatus === "participated").map((p) => nameOf(p.memberId) ?? "（名前を取得できません）") ?? [];
  const plannedNames = audienceRows.filter((r) => responseOf(r.memberId) === "attending").map((r) => nameOf(r.memberId) ?? "（名前を取得できません）");

  const actualInitial: ActualFormInitial | null =
    currentRevision === null
      ? null
      : {
          content: currentRevision.content,
          actualStartsAt: currentRevision.actualStartsAt,
          actualEndsAt: currentRevision.actualEndsAt,
          participants: currentRevision.participants,
        };

  const respondSelf = async (response: AttendanceResponse) => {
    const r = await rsvp.run({ params: { id }, body: { version: myRow?.version ?? 0, response } });
    if (r) setReloadKey((k) => k + 1);
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <SubHeader backTo="/app/activities" right={<Chip tone={meta.tone}>{meta.label}</Chip>} />

      {/* 種別＋題（prototype: 色の点＋種別、28pxの題） */}
      <div className="flex flex-col gap-2 px-0.5">
        <span className="flex items-center gap-1.5 font-mono text-[11px] font-semibold tracking-[.1em]" style={{ color: kindColor(detail.kind) }}>
          <span aria-hidden="true" className="size-2 rounded-[2px]" style={{ background: kindColor(detail.kind) }} />
          {detail.kind}
        </span>
        <h2 className="text-[28px] font-bold leading-[1.3]">{detail.title}</h2>
      </div>

      {/* 日時・場所・担当・締切（prototype の情報カード。持ち物は契約に無い列のため出さない） */}
      <Card className="flex flex-col gap-0 overflow-hidden p-0">
        <InfoRow icon="schedule" mono>
          {fmtDay(detail.plannedStartsAt)} {fmtHM(detail.plannedStartsAt)}
          {detail.plannedEndsAt ? ` – ${fmtHM(detail.plannedEndsAt)}` : " – 未記載"}
        </InfoRow>
        <InfoRow icon="location_on">{detail.locationText}</InfoRow>
        <InfoRow icon="person">担当 {nameOf(detail.ownerMemberId) ?? "読み込み中…"}</InfoRow>
        {detail.responseDueAt && <InfoRow icon="event_busy">回答締切 {fmtDay(detail.responseDueAt)}</InfoRow>}
      </Card>

      {/* 予定の操作（幹部。公開/開催/終了はdocs/11の許可辺。中止は理由必須） */}
      {canManage && detail.status !== "cancelled" && (
        <div className="flex flex-wrap items-center gap-2">
          {detail.status === "draft" && (
            <Button
              busy={transition.saving}
              className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11"
              onClick={async () => {
                const r = await transition.run({ params: { id }, body: { version: detail.version, status: "scheduled" } });
                if (r) setReloadKey((k) => k + 1);
              }}
            >
              予定を公開
            </Button>
          )}
          {detail.status === "scheduled" && (
            <Button variant="secondary" busy={transition.saving} className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={() => setConfirmStatus("in_progress")}>
              開催する
            </Button>
          )}
          {detail.status === "in_progress" && (
            <Button variant="secondary" busy={transition.saving} className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={() => setConfirmStatus("completed")}>
              終了する
            </Button>
          )}
          <Link
            to={`/app/activities/${id}/edit`}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-pill bg-white/[.08] px-4 text-[13px] font-bold text-ink"
          >
            予定を編集
          </Link>
          {(detail.status === "draft" || detail.status === "scheduled") && (
            <Button variant="secondary" busy={cancel.saving} className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={() => setConfirmCancel(true)}>
              中止にする
            </Button>
          )}
        </div>
      )}
      <MutationStatus state={transition.state} toastBottom={100} />
      <MutationStatus state={cancel.state} toastBottom={100} />
      <MutationStatus state={rsvp.state} toastBottom={100} />

      {/* あなたの出欠（prototype: 3択の大きなボタン。受付中だけ操作できる） */}
      {inAudience && receptionOpen && (
        <SelfAttendance
          due={detail.responseDueAt}
          duePassed={duePassed}
          myRow={myRow}
          busy={rsvp.saving}
          onRespond={(response) => void respondSelf(response)}
        />
      )}

      {/* 出欠の状況（対象snapshotの全員。他人の行は幹部だけに見える＝API-07の可視性にそのまま従う） */}
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[14px] font-bold">出欠の状況</h3>
          {canManage && (
            <span className="font-mono text-[12px] text-ink-muted">
              参加 {counts.attending} · 未定 {counts.undecided} · 不参加 {counts.absent} · 未回答 {counts.unanswered}
            </span>
          )}
        </div>
        {!canManage && <p className="text-[12px] text-ink-muted">他の人の回答は、幹部だけに表示されます。</p>}
        {canManage && <AttendanceList activityId={id} rows={audienceRows} me={me.profile.memberId} nameOf={nameOf} onChanged={() => setReloadKey((k) => k + 1)} />}
        {/* 未回答者への通知（T052。源=この活動の未回答者抽出。SCR-21の作成 flow へ。docs/03 §1.1-14） */}
        {canManage && (
          <Link
            to={`/app/tasks-notifications/notifications/new?source=activity&id=${id}`}
            className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-pill bg-white/[.08] px-4 text-[13px] font-bold text-ink"
          >
            <Icon name="notifications" className="text-[17px]" />
            未回答の人に通知を作成
          </Link>
        )}
      </section>

      {/* 参加予定（出欠）と実参加（実績）は別の枠で必ず並べて示す（docs/11:34 固定語彙） */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="flex flex-col gap-2">
          <h3 className="text-[14px] font-bold">参加予定</h3>
          {canManage ? (
            plannedNames.length > 0 ? (
              <ul aria-label="参加予定" className="flex flex-col gap-1.5">
                {plannedNames.map((n) => (
                  <li key={n} className="flex items-center gap-2 rounded-[12px] bg-white/[.04] px-3 py-1.5 text-[13px] font-medium">
                    {n}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-ink-muted">「参加」と答えた人はまだいません。</p>
            )
          ) : (
            <p className="text-[13px] text-ink-muted">出欠の回答は本人と幹部に表示されます。</p>
          )}
        </Card>
        <Card className="flex flex-col gap-2">
          <h3 className="text-[14px] font-bold">実参加</h3>
          {detail.result ? (
            actualNames.length > 0 ? (
              <ul aria-label="実参加" className="flex flex-col gap-1.5">
                {actualNames.map((n) => (
                  <li key={n} className="flex items-center gap-2 rounded-[12px] bg-white/[.04] px-3 py-1.5 text-[13px] font-medium">
                    {n}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-ink-muted">「実参加」の人はまだいません。</p>
            )
          ) : (
            <p className="text-[13px] text-ink-muted">まだ実績がありません。</p>
          )}
        </Card>
      </div>

      {/* 実績（作成→訂正→旧版。docs/05 API-09/42/43） */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[14px] font-bold">実績</h3>
          {detail.result && canManage && formMode === "closed" && (
            <Button variant="secondary" className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={() => setFormMode("correct")}>
              実績を訂正
            </Button>
          )}
        </div>

        {!detail.result && canManage && formMode === "closed" && (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-ink-sub">その日の実参加と内容を記録します（1活動につき1件。訂正は版が残ります）。</p>
            <Button className="max-lg:min-h-11" onClick={() => setFormMode("create")}>
              実績を入力
            </Button>
          </div>
        )}

        {formMode !== "closed" && (
          <ActualResultForm
            key={formMode}
            activityId={id}
            mode={formMode === "create" ? "create" : "correct"}
            activityVersion={detail.version}
            resultVersion={detail.result?.version}
            audience={detail.audience.map((memberId) => ({ memberId, displayName: nameOf(memberId) ?? memberId }))}
            initial={formMode === "correct" ? actualInitial : null}
            onSaved={() => setReloadKey((k) => k + 1)}
            onDone={() => setFormMode("closed")}
            onCancel={() => setFormMode("closed")}
          />
        )}

        {detail.result && !history && <div className="h-40 animate-pulse rounded-card bg-white/[.05]" />}
        {history && history.revisions.length > 1 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="実績の版">
            {history.revisions.map((r) => (
              <button
                key={r.id}
                type="button"
                aria-pressed={(revisionNo ?? history.result.currentRevision.revisionNo) === r.revisionNo}
                onClick={() => setRevisionNo(r.revisionNo)}
                className={`flex h-9 flex-none items-center rounded-pill px-3 text-[12px] font-bold max-lg:min-h-11 ${
                  (revisionNo ?? history.result.currentRevision.revisionNo) === r.revisionNo
                    ? "bg-[rgba(20,30,50,.92)] text-ink shadow-[inset_0_0_0_1px_var(--color-ember)]"
                    : "bg-[rgba(20,30,50,.6)] text-ink-sub"
                }`}
              >
                第{r.revisionNo}版
              </button>
            ))}
          </div>
        )}
        {history && selectedRevision && (
          <RevisionView revision={selectedRevision} isCurrent={selectedRevision.id === history.result.currentRevisionId} nameOf={nameOf} />
        )}
      </section>

      {/* 使用資産（T044。出動と活動で共用のResourceUsageEditor。API-57。 cancelled行も履歴として残る）。
          cancelledの出動（voided）と違い、活動に取消状態は無いため終了後も編集できる（docs/11 開催） */}
      <section className="flex flex-col gap-2" aria-label="使用資産">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[14px] font-bold">車両・機材の使用</h3>
          {!editingUsages && (
            <Button variant="secondary" className="!h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={() => setEditingUsages((v) => !v)}>
              {editingUsages ? "閉じる" : "使用履歴を編集"}
            </Button>
          )}
        </div>
        {editingUsages ? (
          <ResourceUsageEditor
            mode="edit"
            operationId={detail.operationId}
            initialRows={usages}
            operationVersion={detail.operationVersion}
            onSaved={() => setReloadKey((k) => k + 1)}
            onDone={() => setEditingUsages(false)}
            onCancel={() => setEditingUsages(false)}
          />
        ) : (
          <Card className="flex flex-col gap-2">
            {usages.length === 0 ? (
              <p className="text-[13px] text-ink-sub">使用した車両・機材の記録はまだありません。「使用履歴を編集」から登録できます。</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {usages.map((u) => (
                  <li key={u.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-field bg-white/[.04] px-3 py-2 text-[13px]">
                    <span aria-hidden="true" className="ms text-[18px] text-ink-muted">
                      {u.target.type === "vehicle" ? "local_shipping" : "inventory_2"}
                    </span>
                    <Link
                      to={`/app/assets/${u.target.type}/${u.target.id}?from=${encodeURIComponent(`/app/activities/${id}`)}`}
                      className="min-w-0 flex-1 truncate font-bold underline"
                    >
                      <AssetName target={u.target.type} targetId={u.target.id} />
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
            <p className="text-[12px] text-ink-muted">
              この活動に関連する出動は<Link to={`/app/incidents?activity=${id}`} className="underline">関連する出動記録</Link>の一覧で確認できます。
            </p>
          </Card>
        )}
      </section>

      {/* 中止（API-40。出欠・対象・履歴は保持される。docs/11 §3）。
          理由が空のまま実行を送って422にしないよう、空の間は実行を無効化する（AnnouncementEditorと同じ流儀） */}
      {confirmCancel && (
        <ConfirmDialog
          title="この予定を中止しますか"
          confirmLabel="中止にする"
          busy={cancel.saving}
          danger
          confirmDisabled={cancelReason.trim() === ""}
          onConfirm={async () => {
            const r = await cancel.run({ params: { id }, body: { version: detail.version, reason: cancelReason.trim() } });
            if (r) {
              setConfirmCancel(false);
              setCancelReason("");
              setReloadKey((k) => k + 1);
            }
          }}
          onCancel={() => setConfirmCancel(false)}
        >
          <p>「{detail.title}」を中止にします。すでに付いた出欠と記録は消えません。中止後は予定を動かせません。</p>
          <TextArea name="cancel-reason" label="中止の理由（必須）" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
          {cancelReason.trim() === "" && <p className="text-[12px] font-medium text-attention">理由を入力してください</p>}
        </ConfirmDialog>
      )}

      {/* 開催・終了（API-39。公開済みの状態変更は理由が必須。docs/05 API-39） */}
      {confirmStatus && (
        <ConfirmDialog
          title={confirmStatus === "in_progress" ? "この予定を開催中にしますか" : "この活動を終了しますか"}
          confirmLabel={confirmStatus === "in_progress" ? "開催する" : "終了する"}
          busy={transition.saving}
          onConfirm={async () => {
            if (!statusReason.trim()) return;
            const r = await transition.run({ params: { id }, body: { version: detail.version, status: confirmStatus, reason: statusReason.trim() } });
            if (r) {
              setConfirmStatus(null);
              setStatusReason("");
              setReloadKey((k) => k + 1);
            }
          }}
          onCancel={() => {
            setConfirmStatus(null);
            setStatusReason("");
          }}
        >
          <p>{confirmStatus === "in_progress" ? "出欠の受け付けは締切まで続きます。" : "実績の入力は終了後もできます。"}</p>
          <TextArea name="status-reason" label="理由（必須）" value={statusReason} onChange={(e) => setStatusReason(e.target.value)} />
          {statusReason.trim() === "" && <p className="text-[12px] font-medium text-attention">理由を入力してください</p>}
        </ConfirmDialog>
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

/** 本人の出欠（API-08）。最初の回答はversion=0で行が作られ、付け直しは読んだ版で上書きする（docs/05 §2） */
function SelfAttendance({
  due,
  duePassed,
  myRow,
  busy,
  onRespond,
}: {
  due: string | null;
  duePassed: boolean;
  myRow?: { version: number; response: AttendanceResponse; respondedAt: string | null };
  busy: boolean;
  onRespond: (response: AttendanceResponse) => void;
}) {
  const current = myRow?.response ?? "unanswered";
  return (
    <section className="flex flex-col gap-2.5" aria-label="あなたの出欠">
      <div className="flex items-baseline justify-between px-0.5">
        <h3 className="text-[14px] font-bold">あなたの出欠</h3>
        {due && (duePassed ? <Chip tone="attention">締切済</Chip> : <span className="text-[12px] text-ink-muted">締切 {fmtDay(due)}</span>)}
      </div>
      {duePassed ? (
        <p className="text-[13px] text-ink-sub">回答の締切が過ぎています。変更は幹部へ相談してください。</p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {RSVP_CHOICES.map((c) => {
            const on = current === c.value;
            return (
              <button
                key={c.value}
                type="button"
                aria-pressed={on}
                disabled={busy}
                onClick={() => onRespond(c.value)}
                className="flex h-16 flex-col items-center justify-center gap-0.5 rounded-[18px] bg-white/[.05] text-[13px] font-bold transition"
                style={{
                  color: on ? c.color : "#edf1f7",
                  background: on ? `${c.color}26` : "rgba(255,255,255,.05)",
                  boxShadow: `inset 0 0 0 1.5px ${on ? c.color : "rgba(255,255,255,.08)"}`,
                }}
              >
                <span aria-hidden="true" className="ms text-[20px]">
                  {c.icon}
                </span>
                {c.label}
              </button>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 px-0.5 text-[12px] text-ink-muted">
        あなたの回答：
        <Chip tone={RESPONSE_META[current].tone}>{RESPONSE_META[current].label}</Chip>
        {myRow && current !== "unanswered" && (
          <button type="button" onClick={() => onRespond("unanswered")} className="inline-flex min-h-11 items-center text-[12px] text-ink-sub underline lg:min-h-0">
            回答を取り下げる
          </button>
        )}
      </div>
    </section>
  );
}

/** 出欠の一覧（幹部。API-07の可視行＋対象snapshot。未回答者へ絞れる。prototype Desktopのタブと表） */
const TABS = [
  { key: "all", label: "全員" },
  { key: "unanswered", label: "未回答" },
  { key: "attending", label: "参加" },
  { key: "undecided", label: "未定" },
] as const;

function AttendanceList({
  activityId,
  rows,
  me,
  nameOf,
  onChanged,
}: {
  activityId: string;
  rows: { memberId: string; row: ActivityDetailDto["attendance"][number] | undefined }[];
  me: string;
  nameOf: (id: string) => string | null;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("all");
  const responseOf = (memberId: string): AttendanceResponse =>
    rows.find((r) => r.memberId === memberId)?.row?.response ?? "unanswered";
  const countOf = (key: (typeof TABS)[number]["key"]) => (key === "all" ? rows.length : rows.filter((r) => responseOf(r.memberId) === key).length);
  const shown = rows.filter((r) => tab === "all" || responseOf(r.memberId) === tab);

  return (
    <div className="flex flex-col gap-2">
      <div className="fo-scroll flex gap-1.5 overflow-x-auto" role="group" aria-label="出欠の絞り込み">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            aria-pressed={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`flex h-9 flex-none items-center gap-1.5 rounded-pill px-3 text-[12px] font-bold max-lg:min-h-11 ${
              tab === t.key ? "bg-[rgba(20,30,50,.92)] text-ink shadow-[inset_0_0_0_1px_var(--color-ember)]" : "bg-[rgba(20,30,50,.6)] text-ink-sub"
            }`}
          >
            {t.label}
            <span className="font-mono text-[11px] text-ink-muted">{countOf(t.key)}</span>
          </button>
        ))}
      </div>
      <ul aria-label="出欠の一覧" className="flex flex-col gap-1.5">
        {shown.map(({ memberId, row }) => (
          <li key={memberId} className="flex flex-wrap items-center gap-2 rounded-[14px] bg-white/[.05] px-3 py-1.5">
            <span aria-hidden="true" className="grid size-[26px] flex-none place-items-center rounded-full bg-[#1a2740] text-[11px] font-bold text-[#c3cad6]">
              {initialOf(nameOf(memberId) ?? "?")}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
              {nameOf(memberId) ?? "読み込み中…"}
              {memberId === me && <span className="ml-1 text-[12px] text-ink-muted">（自分）</span>}
            </span>
            <Chip tone={RESPONSE_META[responseOf(memberId)].tone}>{RESPONSE_META[responseOf(memberId)].label}</Chip>
            <span className="w-[118px] flex-none text-right font-mono text-[11px] text-ink-muted">{row?.respondedAt ? fmtInstant(row.respondedAt) : "—"}</span>
            {memberId !== me && <ProxyAnswer activityId={activityId} memberId={memberId} displayName={nameOf(memberId) ?? "対象者"} version={row?.version ?? 0} onSaved={onChanged} />}
          </li>
        ))}
        {shown.length === 0 && <li className="text-[12px] text-ink-muted">該当する団員はいません。</li>}
      </ul>
    </div>
  );
}

/**
 * 代理回答（API-41）。対象団員×PER-02の承認済み担当(scope)を持つ者だけが保存でき、理由が必須（docs/10、D05）。
 * 権限が無いときはサーバーが403で返し、その案内をそのまま出す（画面では権限の有無を判定できない）。
 */
function ProxyAnswer({
  activityId,
  memberId,
  displayName,
  version,
  onSaved,
}: {
  activityId: string;
  memberId: string;
  displayName: string;
  version: number;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [response, setResponse] = useState<"参加" | "未定" | "不参加">("参加");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const save = useMutation("API-41");
  const reasonError = touched && !reason.trim() ? "理由を入力してください" : undefined;

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="min-h-11 flex-none rounded-pill bg-white/[.08] px-3 text-[12px] font-bold text-ink lg:min-h-9">
        代理で回答
      </button>
    );
  }

  const submit = async () => {
    setTouched(true);
    if (!reason.trim()) return;
    const value = response === "参加" ? "attending" : response === "未定" ? "undecided" : "absent";
    const r = await save.run({ params: { id: activityId, memberId }, body: { version, response: value, reason: reason.trim() } });
    if (r) {
      setOpen(false);
      setResponse("参加"); // 保存済みは下書きではない。前回の回答値を残すと、開き直したときに離脱警告が誤って出る
      setReason("");
      setTouched(false);
      onSaved();
    }
  };

  return (
    <div className="flex w-full flex-col gap-2 rounded-[12px] bg-white/[.03] p-2.5" aria-label={`${displayName}さんの代理回答`}>
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-bold text-ink-sub">{displayName}さんの回答（代理）</span>
        <select
          aria-label={`${displayName}さんの代理回答の内容`}
          value={response}
          onChange={(e) => setResponse(e.target.value as typeof response)}
          className="hairline ml-auto h-[46px] rounded-xl bg-white/[.06] px-3 text-[13px] font-medium text-ink outline-none"
        >
          <option value="参加">参加</option>
          <option value="未定">未定</option>
          <option value="不参加">不参加</option>
        </select>
      </div>
      <TextArea
        name={`proxy-reason-${memberId}`}
        label="代理で回答する理由（必須）"
        value={reason}
        onChange={(e) => {
          setReason(e.target.value);
          setTouched(true);
        }}
        error={reasonError}
      />
      <MutationStatus state={save.state} toastBottom={100} />
      <div className="flex gap-2">
        <Button busy={save.saving} onClick={() => void submit()} className="!h-[46px] max-lg:min-h-11 !text-[13px]">
          代理で回答を保存
        </Button>
        <Button variant="secondary" busy={save.saving} onClick={() => setOpen(false)} className="!h-[46px] max-lg:min-h-11 flex-none px-4 !text-[13px]">
          閉じる
        </Button>
      </div>
      {/* 入力あり・未保存の間だけ離脱を確認する（docs/03:78。自分の出欠は押した瞬間に保存されるため対象外） */}
      <LeaveConfirm dirty={reason.trim() !== "" || response !== "参加"} />
    </div>
  );
}

/** 実績の1版の表示（現行/旧版。個人時間の未知は「未記載」。docs/05 §3） */
function RevisionView({
  revision,
  isCurrent,
  nameOf,
}: {
  revision: ActivityResultRevisionDto;
  isCurrent: boolean;
  nameOf: (id: string) => string | null;
}) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={isCurrent ? "ok" : "neutral"}>{isCurrent ? "現行" : "旧版"}</Chip>
        <span className="font-mono text-[11px] text-ink-muted">{fmtInstant(revision.createdAt)}に記録</span>
      </div>
      {revision.correctionReason && <p className="text-[12px] leading-[1.6] text-ink-sub">訂正理由：{revision.correctionReason}</p>}
      <p className="whitespace-pre-wrap text-[14px] font-medium leading-[1.7]">{revision.content}</p>
      <div className="grid gap-px overflow-hidden rounded-[12px] bg-white/[.07] lg:grid-cols-2" aria-label="実施時間">
        <div className="bg-[#0d1626] p-3">
          <span className="text-[11px] text-ink-muted">実施（開始）</span>
          <p className="font-mono text-[14px] font-semibold">{revision.actualStartsAt ? fmtInstant(revision.actualStartsAt) : "未記載"}</p>
        </div>
        <div className="bg-[#0d1626] p-3">
          <span className="text-[11px] text-ink-muted">実施（終了）</span>
          <p className="font-mono text-[14px] font-semibold">{revision.actualEndsAt ? fmtInstant(revision.actualEndsAt) : "未記載"}</p>
        </div>
      </div>
      <ul aria-label="実参加の記録" className="flex flex-col gap-1.5">
        {revision.participants.map((p) => {
          const meta = ACTUAL_META[p.actualStatus];
          const both = p.individualStartsAt && p.individualEndsAt;
          return (
            <li key={p.memberId} className="flex flex-wrap items-center gap-2 rounded-[12px] bg-white/[.04] px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{nameOf(p.memberId) ?? "読み込み中…"}</span>
              <Chip tone={meta.tone}>{meta.label}</Chip>
              <span className="font-mono text-[11px] text-ink-muted">{both ? `${fmtHM(p.individualStartsAt!)}–${fmtHM(p.individualEndsAt!)}` : "個人時間 未記載"}</span>
            </li>
          );
        })}
        {revision.participants.length === 0 && <li className="text-[12px] text-ink-muted">実参加の記録はありません。</li>}
      </ul>
    </Card>
  );
}
