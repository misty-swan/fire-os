import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../../api";
import { PageTitle } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, TextField } from "../../components/ui";
import { useMutation } from "../../useMutation";

/**
 * 車両・資機材（T026、SCR-13/14）。台帳種別・番号・数量単位・保管先・状態を明示し、
 * 点検/異常への導線を作る。未入力と0を分ける（docs/16 T026）。
 * ?due=overdue（T048）は点検期限が超過した現役資産だけに絞る（API-18/19のdue=overdue。
 * ホームの「点検期限」タイル（API-28 inspectionDue）と同じ条件・同じ件数になる）。
 * filterはURLクエリにもつ（ActivitiesPage T039と同じ流儀。ホームからのドリルダウンで同じURLを開ける）。
 */

interface VehicleRow {
  id: string; version: number; assetCode: string; name: string; status: string;
  storageFacilityId: string | null; archivedAt: string | null;
}
interface EquipmentRow {
  id: string; version: number; assetCode: string; name: string; quantity: number; quantityUnit: string;
  status: string;
  storage: { facilityId: string | null; vehicleId: string | null; note: string | null };
  archivedAt: string | null;
}

export function AssetsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // 点検期限の絞り込み（T048。ホームの「点検期限」からのドリルダウン。API-18/19のdue=overdue）
  const dueOverdue = searchParams.get("due") === "overdue";
  const [tab, setTab] = useState<"vehicle" | "equipment">("vehicle");
  const [vehicles, setVehicles] = useState<VehicleRow[] | "loading" | "error">("loading");
  const [equipment, setEquipment] = useState<EquipmentRow[] | "loading" | "error">("loading");
  const [creating, setCreating] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [q, setQ] = useState("");
  const [appliedQ, setAppliedQ] = useState("");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // 検索はAPI-18/19のq（サーバー側で絞り込む。docs/03 SCR-13「検索」）
        const query = {
          ...(appliedQ.trim() ? { q: appliedQ.trim() } : {}),
          ...(dueOverdue ? { due: "overdue" as const } : {}),
        };
        const v = (await api("API-18", { query })) as unknown as VehicleRow[];
        const e = (await api("API-19", { query })) as unknown as EquipmentRow[];
        if (alive) { setVehicles(v); setEquipment(e); }
      } catch {
        if (alive) { setVehicles("error"); setEquipment("error"); }
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadKey, appliedQ, dueOverdue]);

  const rows = tab === "vehicle" ? vehicles : equipment;

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <PageTitle eyebrow="ASSETS" className="lg:hidden">車両・資機材</PageTitle>

      {/* 検索（API-18/19のq。Enterで絞り込む。docs/03 SCR-13） */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setAppliedQ(q);
        }}
        className="flex gap-2"
      >
        <label className="hairline flex h-[42px] min-w-0 flex-1 items-center gap-2 rounded-xl bg-white/[.06] px-3 max-lg:min-h-11">
          <Icon name="search" className="text-[18px] text-ink-muted" />
          <span className="sr-only">名称・管理番号で検索</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="名称・管理番号で検索"
            className="min-w-0 flex-1 border-none bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-ink-dim"
          />
        </label>
        <Button variant="secondary" type="submit" className="!h-[42px] max-lg:min-h-11 !w-auto flex-none px-4 !text-[13px]">
          検索
        </Button>
        {appliedQ && (
          <button type="button" onClick={() => { setQ(""); setAppliedQ(""); }} className="flex min-h-11 flex-none items-center text-[12px] font-bold text-ink-muted underline">
            解除
          </button>
        )}
      </form>

      {/* 点検期限の絞り込み中（T048。ホームの「点検期限」からのドリルダウン）。解除で全件に戻る */}
      {dueOverdue && (
        <div className="flex items-center gap-2">
          <Chip tone="attention">点検期限を超過した資産だけ表示中</Chip>
          <button
            type="button"
            onClick={() => {
              const next = new URLSearchParams(searchParams);
              next.delete("due");
              setSearchParams(next, { replace: true });
            }}
            className="flex min-h-11 items-center text-[12px] font-bold text-ink-muted underline lg:min-h-9"
          >
            解除
          </button>
        </div>
      )}

      <div className="flex gap-1.5">
        {(["vehicle", "equipment"] as const).map((t) => (
          <button
            key={t}
            type="button"
            data-testid={`assets-tab-${t}`}
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
            className={`flex h-9 flex-none items-center gap-1.5 rounded-pill px-3 text-[12px] font-bold max-lg:min-h-11 ${tab === t ? "bg-[rgba(20,30,50,.92)] text-ink shadow-[inset_0_0_0_1px_var(--color-ember)]" : "bg-[rgba(20,30,50,.6)] text-ink-sub"}`}
          >
            {t === "vehicle" ? "車両" : "資機材"}
            <span className="font-mono text-[11px] text-ink-muted">{Array.isArray(t === "vehicle" ? vehicles : equipment) ? (t === "vehicle" ? vehicles.length : equipment.length) : "—"}</span>
          </button>
        ))}
      </div>

      <Button variant="secondary" className="max-lg:min-h-11 self-start px-4" onClick={() => setCreating((v) => !v)}>
        <Icon name={creating ? "close" : "add"} className="text-[19px]" />
        {creating ? "閉じる" : tab === "vehicle" ? "車両を追加" : "資機材を追加"}
      </Button>

      {creating && <AssetCreateForm type={tab} onCreated={() => { setCreating(false); setReloadKey((k) => k + 1); }} />}

      {rows === "loading" && <div className="h-24 animate-pulse rounded-card bg-white/[.05]" />}
      {rows === "error" && <Banner tone="error" eyebrow="ERROR" title="一覧を取得できませんでした" />}
      {Array.isArray(rows) && rows.length === 0 && (
        <Banner tone="info" eyebrow="EMPTY" title="まだ登録がありません">
          上の「{tab === "vehicle" ? "車両を追加" : "資機材を追加"}」から登録できます。
        </Banner>
      )}
      {Array.isArray(rows) && rows.map((r) => {
        const id = "id" in r ? r.id : "";
        const code = "assetCode" in r ? r.assetCode : "";
        const name = "name" in r ? r.name : "";
        const status = "status" in r ? r.status : "";
        const storage = "storage" in r && r.storage
          ? r.storage.note ?? (r.storage.vehicleId ? "車両に保管" : r.storage.facilityId ? "施設に保管" : "—")
          : "storageFacilityId" in r && r.storageFacilityId ? "施設に保管" : "—";
        return (
          <Card key={id} className="flex items-center gap-3">
            <span aria-hidden="true" className="grid size-11 flex-none place-items-center rounded-[12px] bg-white/[.06]">
              <Icon name={tab === "vehicle" ? "local_shipping" : "inventory_2"} className="text-[22px] text-ink-sub" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12px] font-semibold text-ink-muted">{code}</span>
                <Chip tone={status === "廃止" ? "neutral" : status === "修繕中" ? "attention" : "ok"}>{status}</Chip>
              </div>
              <p className="truncate text-[14px] font-bold">{name}</p>
              <p className="text-[12px] text-ink-muted">
                {"quantity" in r ? `数量 ${r.quantity}${r.quantityUnit} · ` : ""}{storage}
              </p>
            </div>
            <Link to={`/app/assets/${tab}/${id}`} aria-label={`${name}の詳細`} className="grid size-11 flex-none place-items-center rounded-full bg-white/[.08]">
              <Icon name="chevron_right" className="text-[20px]" />
            </Link>
          </Card>
        );
      })}
      <button type="button" onClick={() => navigate("/app/map")} className="self-start text-[13px] text-ink-muted underline">
        マップへ戻る
      </button>
    </div>
  );
}

/** 登録フォーム（SCR-13の「登録」。資機材は保管先を施設/車両/外部から選ぶ。D15の検証設定） */
function AssetCreateForm({ type, onCreated }: { type: "vehicle" | "equipment"; onCreated: () => void }) {
  const [assetCode, setAssetCode] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState(type === "vehicle" ? "運用" : "在庫");
  const [quantity, setQuantity] = useState("");
  const [quantityUnit, setQuantityUnit] = useState("本");
  const [storageMode, setStorageMode] = useState<"note" | "facilityId" | "vehicleId">(type === "vehicle" ? "facilityId" : "note");
  const [facilityId, setFacilityId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const create = useMutation(type === "vehicle" ? "API-47" : "API-49");

  const errors: { field: string; reason: string }[] = [];
  if (touched) {
    if (!assetCode.trim()) errors.push({ field: "assetCode", reason: "管理番号を入力してください" });
    if (!name.trim()) errors.push({ field: "name", reason: "名称を入力してください" });
    if (type === "equipment" && quantity !== "" && Number.isNaN(Number(quantity))) errors.push({ field: "quantity", reason: "数量は数値で入力してください" });
  }

  const submit = async () => {
    setTouched(true);
    if (errors.length > 0) return;
    if (type === "vehicle") {
      const res = await create.run({
        body: { assetCode: assetCode.trim(), name: name.trim(), status, ...(facilityId.trim() ? { storageFacilityId: facilityId.trim() } : {}) },
      });
      if (res) onCreated();
    } else {
      const storage =
        storageMode === "facilityId" ? { facilityId: facilityId.trim() }
          : storageMode === "vehicleId" ? { vehicleId: vehicleId.trim() }
            : { note: note.trim() || "詰所" };
      // API-49の作成入力にstatusは無い（docs/05。serverが「在庫」で作る。状態の変更はPATCH/API-50）
      const res = await create.run({
        body: {
          assetCode: assetCode.trim(), name: name.trim(),
          quantity: quantity === "" ? 0 : Number(quantity), quantityUnit: quantityUnit.trim() || "本",
          storage,
        },
      });
      if (res) onCreated();
    }
  };

  return (
    <Card className="flex flex-col gap-3" aria-label={`${type === "vehicle" ? "車両" : "資機材"}を追加`}>
      <TextField name="asset-code" label="管理番号" value={assetCode} onChange={(e) => setAssetCode(e.target.value)} placeholder="例: PUMP-1" error={errors.find((e) => e.field === "assetCode")?.reason} />
      <TextField name="asset-name" label="名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="例: 消防ポンプ車" error={errors.find((e) => e.field === "name")?.reason} />
      {type === "equipment" && (
        <>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <TextField name="asset-qty" label="数量（未入力なら0）" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} error={errors.find((e) => e.field === "quantity")?.reason} />
            </div>
            <div className="w-24 flex-none">
              <TextField name="asset-unit" label="単位" value={quantityUnit} onChange={(e) => setQuantityUnit(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[12px] font-bold text-ink-sub">保管先（どれか一つ）</span>
            <div className="flex gap-2">
              {[["note", "外部保管"], ["facilityId", "施設"], ["vehicleId", "車両"]].map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={storageMode === mode}
                  onClick={() => setStorageMode(mode as typeof storageMode)}
                  className={`flex min-h-11 flex-1 items-center justify-center rounded-field text-[13px] font-bold ${storageMode === mode ? "bg-ember text-white" : "bg-white/[.06] text-ink-sub"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {storageMode === "facilityId" && <TextField name="storage-facility" label="施設のID" value={facilityId} onChange={(e) => setFacilityId(e.target.value)} />}
            {storageMode === "vehicleId" && <TextField name="storage-vehicle" label="車両のID" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} />}
            {storageMode === "note" && <TextField name="storage-note" label="保管場所のメモ" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例: 詰所" />}
          </div>
        </>
      )}
      {type === "vehicle" && <TextField name="v-storage-facility" label="保管施設のID（省略可）" value={facilityId} onChange={(e) => setFacilityId(e.target.value)} />}
      {/* 状態欄は車両だけ。資機材はAPI-49にstatusが無く、サーバーが「在庫」で作る（変更は詳細のAPI-50） */}
      {type === "vehicle" && <TextField name="asset-status" label="状態" value={status} onChange={(e) => setStatus(e.target.value)} />}
      {type === "equipment" && <p className="text-[12px] text-ink-muted">資機材は「在庫」で登録されます。状態の変更は詳細画面からできます。</p>}
      {create.state.kind === "conflict" && <Banner tone="warning" eyebrow="CONFLICT" title="同じ管理番号が既に登録されています" />}
      {create.state.kind === "invalid" && <Banner tone="warning" eyebrow="INVALID" title="入力を確認してください">保管先のIDや数量を確認してください。</Banner>}
      <Button busy={create.saving} onClick={() => void submit()}>登録する</Button>
    </Card>
  );
}
