import { useEffect, useState } from "react";
import { LeaveConfirm } from "../../components/LeaveConfirm";
import { ConfirmDialog } from "../../components/Overlay";
import { MutationStatus } from "../../components/MutationStatus";
import { PageTitle } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, Notice, TextArea, TextField } from "../../components/ui";
import type { PatrolPlan, PatrolStop } from "../../../shared/contracts/ai";
import { buildMapsUrl } from "../facilities/location";
import { FACILITY_TYPES, facilityName, useFacilities } from "../map/useFacilities";
import { useMutation } from "../../useMutation";

/**
 * 巡回計画（T071、SCR-25 /app/patrol-plans。docs/03 SCR-25「対象施設/日/順序/計画案/人の確定」。
 * prototypeに専用画面が無いため共通部品で構成（文書SCR-24・活動分析SCR-26と同じ扱い。docs/03 §1.1-20））。
 *
 * - 案の作成（API-78）→順序の編集（上下移動。押下領域44px）→**人の確定**（API-79 decision=confirm。
 *   確認ダイアログで日付・順序・対象施設を明示）→確定済み表示（終端）／取り消し（cancel。理由必須）。
 * - **計画を確定しても出動・タスク・通知は自動では作られない**（サーバーも作らない＝T071）。この旨の注記を
 *   常時出す（「計画確定を実災害の指令/設備安全判断にしない」＝docs/03 SCR-25の完了条件）。
 *   巡回計画の正式採否は未決のため、**了承済みとは表示しない**（検証設定の注記。docs/14 D01）。
 * - 順序の候補はサーバーが施設座標から提案した最近傍順（外部の経路最適化は使わない）。編集は画面内で行い、
 *   確定のときに送る。各行の「地図で開く」は施設詳細と同じ destination座標の外部リンク（docs/03 §4）。
 * - **計画の一覧はこの画面で作成した分だけ**（計画の取得契約が102 API台帳に無いため。docs/16 T071）。
 *   再読込後・他の人が作った計画は現れない旨を注記する（取得できるように見せない）。
 * - 操作の可否は画面で判定せずサーバーが毎要求判定する（PER-14。担当scopeの保持者にも操作枠を出す）。
 */

const STATUS_CHIP: Record<PatrolPlan["status"], { label: string; tone: "attention" | "ok" | "neutral" }> = {
  draft: { label: "案", tone: "attention" },
  confirmed: { label: "確定済み", tone: "ok" },
  cancelled: { label: "取り消し済み", tone: "neutral" },
};

/** 確定の定型理由（契約のreasonは必須。人の確定の記録。取消は本人が理由を入力する） */
const CONFIRM_REASON = "対象と順序を確認して確定した（巡回計画の人的確定）";

/**
 * この画面で作成した計画（module直置き。T069の依頼job追跡と同じ流儀）。
 * 一覧取得契約が無いためセッション中の作業リストとして扱う（docs/16 T071）。
 */
const sessionPlans: PatrolPlan[] = [];

/** 上位の承認待ち等ではなく、この画面内の状態遷移。planの更新を作業リストへ反映する */
function upsertPlan(plan: PatrolPlan): void {
  const i = sessionPlans.findIndex((x) => x.id === plan.id);
  if (i >= 0) sessionPlans[i] = plan;
  else sessionPlans.unshift(plan);
}

export function PatrolPlansPage() {
  const [plans, setPlans] = useState<PatrolPlan[]>([...sessionPlans]);
  const refresh = () => setPlans([...sessionPlans]);
  const onUpdate = (plan: PatrolPlan) => {
    upsertPlan(plan);
    refresh();
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <PageTitle eyebrow="2026 · PATROL" className="lg:[&_h2]:hidden">
        巡回計画
      </PageTitle>

      {/* 常時注記（docs/03 SCR-25「計画確定を実災害の指令/設備安全判断にしない」＋D01の検証設定） */}
      <Notice tone="warning" icon="info" role="status">
        巡回計画は<strong className="font-bold">点検の補助</strong>のための計画です。計画を確定しても、出動・タスク・通知は
        <strong className="font-bold">自動では作られません</strong>。この計画は実災害の指令や設備の安全判断ではありません。
      </Notice>
      <Notice tone="info" icon="science" role="status">
        巡回計画の機能は正式採用の確認待ちの検証設定です。運用での使い方は、これから確認します。
      </Notice>

      <PlanCreateForm onCreated={onUpdate} />

      <section className="flex flex-col gap-3" aria-label="作成した計画">
        <h3 className="text-[16px] font-bold">作成した計画</h3>
        <p className="text-[12px] leading-[1.6] text-ink-muted">
          この画面で作成した計画だけを表示しています（計画の一覧取得はまだできないため）。ページを再読込すると消えます。
          他の人が作った計画はここには表示されません。
        </p>
        {plans.length === 0 ? (
          <Card className="flex flex-col gap-2 p-4">
            <p className="text-[14px] text-ink-sub">まだ計画はありません。上のフォームから案を作成してください。</p>
          </Card>
        ) : (
          plans.map((plan) => <PlanCard key={plan.id} plan={plan} onUpdate={onUpdate} />)
        )}
      </section>
    </div>
  );
}

/** 案の作成フォーム（API-78。日付・目的・対象施設。対象は自分の分団の現役施設 = API-10） */
function PlanCreateForm({ onCreated }: { onCreated: (plan: PatrolPlan) => void }) {
  const { items, state, reload } = useFacilities({});
  const [date, setDate] = useState("");
  const [objective, setObjective] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [issues, setIssues] = useState<{ field: string; reason: string }[]>([]);
  const create = useMutation("API-78");

  const dirty = date !== "" || objective !== "" || selected.size > 0;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = async () => {
    const local: { field: string; reason: string }[] = [];
    if (!date) local.push({ field: "date", reason: "巡回日を入力してください" });
    if (objective.trim() === "") local.push({ field: "objective", reason: "目的を入力してください" });
    if (selected.size === 0) local.push({ field: "facilityIds", reason: "対象施設を1件以上選んでください" });
    setIssues(local);
    if (local.length > 0) return;
    const result = await create.run({
      body: { facilityIds: [...selected], date, objective },
    });
    if (result) {
      onCreated(result.data as unknown as PatrolPlan);
      setDate("");
      setObjective("");
      setSelected(new Set());
      setIssues([]);
    }
  };

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[16px] font-bold">計画案を作成</h3>
        {state === "partial" && (
          <Chip tone="neutral" icon="hourglass_top">
            施設一覧を取得中…
          </Chip>
        )}
      </div>
      <p className="text-[12px] leading-[1.6] text-ink-muted">
        対象施設の巡回順は、施設の座標から近い順に自動で提案されます（地図アプリでの経路最適化は行いません）。
        提案された順序は、確定の前に自分で並べ替えできます。
      </p>
      <TextField
        name="date"
        label="巡回日"
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        error={issues.find((i) => i.field === "date")?.reason}
      />
      <TextField
        name="objective"
        label="目的"
        value={objective}
        onChange={(e) => setObjective(e.target.value)}
        placeholder="例: 水利の定期巡回"
        error={issues.find((i) => i.field === "objective")?.reason}
      />
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-bold text-ink-sub">対象施設（{selected.size}件選択）</span>
        {state === "error" && (
          <Banner
            tone="error"
            eyebrow="OFFLINE"
            title="施設一覧を取得できませんでした"
            action={
              <Button variant="secondary" onClick={reload} className="mt-1 max-lg:min-h-11">
                再試行
              </Button>
            }
          >
            通信を確認して、もう一度お試しください。
          </Banner>
        )}
        <div className="flex flex-col divide-y divide-white/[.06]">
          {items.map((f) => (
            <label key={f.id} className="flex min-h-11 cursor-pointer items-center gap-3 py-1.5">
              <input
                type="checkbox"
                className="size-5 flex-none"
                checked={selected.has(f.id)}
                onChange={() => toggle(f.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium">{facilityName(f)}</span>
                <span className="block text-[11px] text-ink-muted">
                  {FACILITY_TYPES[f.type].label}
                  {f.verificationStatus === "unverified" ? "・位置未確認" : ""}
                </span>
              </span>
            </label>
          ))}
        </div>
        {issues.find((i) => i.field === "facilityIds") && (
          <p className="text-[13px] font-medium text-alert">{issues.find((i) => i.field === "facilityIds")?.reason}</p>
        )}
      </div>
      <Button busy={create.saving} disabled={state === "loading" || state === "error"} onClick={submit} className="max-lg:min-h-11">
        計画案を作成する
      </Button>
      <MutationStatus state={create.state} toastBottom={100} />
      <LeaveConfirm dirty={dirty} />
    </Card>
  );
}

/** 作成した計画のカード。案のときは順序の編集（上下移動）と確定/取消を出す。確定済みは終端として表示する */
function PlanCard({ plan, onUpdate }: { plan: PatrolPlan; onUpdate: (plan: PatrolPlan) => void }) {
  // 編集中の順序（案のときだけ動かせる。確定のときにサーバーへ送る。docs/03 SCR-25「順序編集」）
  const [order, setOrder] = useState<PatrolStop[]>(plan.stops);
  useEffect(() => setOrder(plan.stops), [plan]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const decide = useMutation("API-79");

  const status = STATUS_CHIP[plan.status];
  const isDraft = plan.status === "draft";
  const orderChanged = isDraft && (order.map((s) => s.facilityId).join(",") !== plan.stops.map((s) => s.facilityId).join(","));

  const move = (index: number, delta: -1 | 1) => {
    setOrder((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };

  const runDecision = async (decision: "confirm" | "cancel") => {
    const result = await decide.run({
      params: { id: plan.id },
      body: {
        version: plan.version,
        orderedFacilityIds: order.map((s) => s.facilityId),
        decision,
        reason: decision === "confirm" ? CONFIRM_REASON : cancelReason,
      },
    });
    if (result) {
      onUpdate(result.data as unknown as PatrolPlan);
      setConfirmOpen(false);
      setCancelOpen(false);
      setCancelReason("");
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={status.tone}>{status.label}</Chip>
        <span className="text-[16px] font-bold">{plan.date} の巡回</span>
        <span className="text-[12px] text-ink-muted">{plan.objective}</span>
      </div>

      {plan.status === "confirmed" && (
        <Notice tone="info" icon="lock" role="status">
          確定済みの計画はもう変わりません（変更は新しい案を作って行います）。
          {plan.decidedAt ? `（${plan.decidedAt.slice(0, 10)}に確定）` : ""}
        </Notice>
      )}
      {plan.status === "cancelled" && (
        <p className="text-[13px] text-ink-sub">取り消した案は使えません。同じ内容で巡回するときは、新しい案を作成してください。</p>
      )}

      <ol className="flex flex-col divide-y divide-white/[.06]" aria-label="巡回順">
        {order.map((stop, i) => (
          <li key={stop.facilityId} className="flex items-center gap-2.5 py-2">
            <span className="grid size-8 flex-none place-items-center rounded-full bg-white/[.08] text-[13px] font-bold">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium">{stop.facilityName}</span>
              {/* 外部経路（施設詳細と同じdestination座標の外部リンク。経路の自動最適化は行わない） */}
              <a
                href={buildMapsUrl(stop)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center gap-1 text-[12px] font-bold text-ai lg:min-h-9"
              >
                <Icon name="map" className="text-[14px]" />
                地図で開く（{stop.latitude.toFixed(5)}, {stop.longitude.toFixed(5)}を送る）
              </a>
            </span>
            {isDraft && (
              <span className="flex flex-none gap-1">
                <button
                  type="button"
                  aria-label={`${stop.facilityName} を上へ移動`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  className="grid size-11 place-items-center rounded-[10px] bg-white/[.06] disabled:opacity-40 lg:size-9"
                >
                  <Icon name="arrow_upward" className="text-[18px]" />
                </button>
                <button
                  type="button"
                  aria-label={`${stop.facilityName} を下へ移動`}
                  disabled={i === order.length - 1}
                  onClick={() => move(i, 1)}
                  className="grid size-11 place-items-center rounded-[10px] bg-white/[.06] disabled:opacity-40 lg:size-9"
                >
                  <Icon name="arrow_downward" className="text-[18px]" />
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>

      {isDraft && (
        <>
          <p className="text-[12px] leading-[1.6] text-ink-muted">
            {orderChanged ? "順序を変更しています（まだ保存されていません）。確定のときに送ります。" : "並び替えは、確定するまで保存されません。"}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button busy={decide.saving} onClick={() => setConfirmOpen(true)} className="max-lg:min-h-11">
              この順序で確定する
            </Button>
            <Button variant="secondary" onClick={() => setCancelOpen(true)} className="max-lg:min-h-11">
              案を取り消す
            </Button>
          </div>
        </>
      )}

      <MutationStatus state={decide.state} toastBottom={100} />
      <LeaveConfirm dirty={orderChanged} />
      {/* 確定の確認（日付・順序・対象施設を明示。docs/03 SCR-25）。確定は人の操作で、効果は自動では起きない */}
      {confirmOpen && (
        <ConfirmDialog
          title="この巡回順で確定しますか"
          confirmLabel="確定する"
          busy={decide.saving}
          onConfirm={() => void runDecision("confirm")}
          onCancel={() => setConfirmOpen(false)}
        >
          <p>巡回日: {plan.date}</p>
          <p>目的: {plan.objective}</p>
          <ol className="list-decimal list-inside">
            {order.map((s) => (
              <li key={s.facilityId}>{s.facilityName}</li>
            ))}
          </ol>
          <p>確定した計画はもう変わりません。変更するときは、新しい案を作成します。</p>
          <p>確定しても、出動・タスク・通知は自動では作られません。この計画は点検の補助であり、実災害の指令や設備の安全判断ではありません。</p>
        </ConfirmDialog>
      )}

      {/* 取消は理由必須（docs/05 API-79） */}
      {cancelOpen && (
        <ConfirmDialog
          title="この案を取り消しますか"
          confirmLabel="取り消す"
          danger
          busy={decide.saving}
          confirmDisabled={cancelReason.trim() === ""}
          onConfirm={() => void runDecision("cancel")}
          onCancel={() => setCancelOpen(false)}
        >
          <p>
            巡回日 {plan.date}／目的 {plan.objective}／対象 {order.length}件
          </p>
          <TextArea
            name="cancel-reason"
            label="取り消しの理由（必須）"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
          />
          <p>取り消した案はもう使えません。同じ対象で巡回するときは、新しい案を作成します。</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}
