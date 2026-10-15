import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { api } from "../../api";
import { ConfirmDialog } from "../../components/Overlay";
import { MutationStatus } from "../../components/MutationStatus";
import { PageTitle } from "../../components/Page";
import { Banner, Button, Card, Chip, Icon, TextField } from "../../components/ui";
import { useMutation } from "../../useMutation";
import type { AssetDetailDto, EquipmentDto, VehicleDto } from "../../../shared/contracts/assets";

/**
 * 車両・資機材の詳細（T026、SCR-14）。台帳種別・番号・数量単位・保管先・状態を明示し、
 * 点検/異常/使用履歴への導線を作る（docs/16 T026: 未入力と0を分ける。物理削除しない）。
 * 編集・廃止はAPI-48（車両）/API-50（資機材）。廃止は状態を「廃止」にする変更（docs/04）。
 * 使用履歴はAPI-51の子Page（T042で接続。cancelledも履歴として残る。docs/04:100）。書込は出動/活動側。
 * ?from= があれば「元の記録に戻る」を出す（T044。出動/活動の使用履歴から来たときの相互導線。
 * operationIdだけでは元の記録を引けないため、遷移元をURLで受け取る。/app 配下だけを許す）。
 */
export function AssetPage() {
  const params = useParams<{ type: "vehicle" | "equipment"; id: string }>();
  const type = params.type!;
  const id = params.id!;
  const [searchParams] = useSearchParams();
  // 遷移元（出動/活動の詳細）。/app 配下の経路だけを受け入れる（オープンリダイレクトにしない）
  const fromParam = searchParams.get("from") ?? "";
  const fromPath = fromParam.startsWith("/app/") && !fromParam.includes("//") ? fromParam : null;
  const [detail, setDetail] = useState<AssetDetailDto | "loading" | "notfound">("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = await api("API-51", { params: { type, id }, query: {} });
        if (alive) setDetail(data);
      } catch {
        if (alive) setDetail("notfound");
      }
    })();
    return () => {
      alive = false;
    };
  }, [type, id, reloadKey]);

  if (detail === "loading") {
    return <div className="h-40 animate-pulse rounded-card bg-white/[.05]" />;
  }
  if (detail === "notfound") {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <Banner tone="info" eyebrow="NOT FOUND" title="この資産は存在しないか、閲覧できません">
          <Link to="/app/assets" className="underline">一覧へ戻る</Link>
        </Banner>
      </div>
    );
  }
  const asset = detail.asset;

  const isEquipment = "quantity" in asset;
  const storage = isEquipment
    ? (asset as EquipmentDto).storage.note ?? ((asset as EquipmentDto).storage.vehicleId ? "車両に保管" : (asset as EquipmentDto).storage.facilityId ? "施設に保管" : "—")
    : (asset as VehicleDto).storageFacilityId ? "施設に保管" : "—";
  const status = asset.status;
  const retired = status === "廃止";

  return (
    <div className="flex max-w-[720px] flex-col gap-4">
      <PageTitle eyebrow={type === "vehicle" ? "VEHICLE" : "EQUIPMENT"} className="lg:hidden">
        {type === "vehicle" ? "車両の詳細" : "資機材の詳細"}
      </PageTitle>

      <div className="flex items-center gap-3 px-1">
        <span aria-hidden="true" className="grid size-12 flex-none place-items-center rounded-[14px] bg-white/[.06]">
          <span className="ms text-[24px] text-ink-sub">{type === "vehicle" ? "local_shipping" : "inventory_2"}</span>
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="font-mono text-[12px] text-ink-muted">{asset.assetCode}</span>
          <span className="truncate text-[22px] font-bold">{asset.name}</span>
        </div>
        <Chip tone={retired ? "neutral" : status === "修繕中" ? "attention" : "ok"}>{status}</Chip>
        {!retired && (
          <Button variant="secondary" className="ml-auto !h-[46px] !w-auto px-4 !text-[13px] max-lg:min-h-11" onClick={() => setEditing((v) => !v)}>
            <Icon name={editing ? "close" : "edit"} className="text-[17px]" />
            {editing ? "閉じる" : "編集"}
          </Button>
        )}
      </div>

      {editing && !retired && <AssetEditForm type={type} asset={asset} onSaved={() => { setReloadKey((k) => k + 1); }} />}

      <Card className="grid grid-cols-2 gap-px overflow-hidden bg-white/[.07] p-0" aria-label="台帳">
        <InfoCell label="台帳種別" value={type === "vehicle" ? "車両" : "資機材"} />
        <InfoCell label="管理番号" value={asset.assetCode} mono />
        {isEquipment ? (
          <>
            <InfoCell label="数量単位" value={`${(asset as EquipmentDto).quantity}${(asset as EquipmentDto).quantityUnit}`} mono />
          </>
        ) : null}
        <InfoCell label="保管先" value={storage} />
        <InfoCell label="状態" value={status} />
      </Card>

      {/* 導線: 点検履歴（T033の点検から作られる）。使用履歴は下のカード（T042でAPI-51の子Pageに接続） */}
      <Card className="flex flex-col gap-2" aria-label="履歴">
        <span className="text-[14px] font-bold">点検履歴</span>
        <p className="text-[13px] text-ink-sub">
          この{type === "vehicle" ? "車両" : "資機材"}の点検記録は、点検の保存後にここに表示されます。
        </p>
        <Link
          to={type === "vehicle" ? `/app/assets/vehicle/${id}/inspection` : `/app/assets/equipment/${id}/inspection`}
          className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-pill bg-white/[.08] px-3.5 text-[13px] font-bold text-ink lg:min-h-9"
        >
          点検を記録する
        </Link>
        <p className="text-[12px] text-ink-muted">異常の状況は<Link to="/app/issues" className="underline">点検管理</Link>で確認できます。</p>
      </Card>

      {/* 使用履歴（T042。docs/04:100。出動・活動の記録で車両/機材を登録するとここに出る。
          取消された行も履歴として残る（docs/05 §1「抜けた既存行はcancelled」）。在庫は使用で動かさない=D15） */}
      <Card className="flex flex-col gap-2" aria-label="使用履歴">
        <span className="text-[14px] font-bold">使用履歴</span>
        {fromPath && (
          <Link
            to={fromPath}
            className="inline-flex min-h-11 items-center gap-1.5 self-start rounded-pill bg-white/[.08] px-3.5 text-[13px] font-bold text-ink lg:min-h-9"
          >
            <Icon name="undo" className="text-[16px]" />
            {fromPath.startsWith("/app/incidents/") ? "元の出動記録に戻る" : fromPath.startsWith("/app/activities/") ? "元の活動に戻る" : "元の記録に戻る"}
          </Link>
        )}
        {detail.usages.length === 0 ? (
          <p className="text-[13px] text-ink-sub">
            この{type === "vehicle" ? "車両" : "資機材"}の使用記録は、出動・活動の記録に登録するとここに表示されます。
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {detail.usages.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-field bg-white/[.04] px-3 py-2 text-[13px]">
                <span className="font-mono text-[12px] text-ink-muted">{u.usedFrom ? u.usedFrom.slice(0, 10) : "日時未記録"}</span>
                <span>数量 {u.quantity}</span>
                {u.status === "cancelled" ? <Chip tone="neutral">取消</Chip> : <Chip tone="ok">使用中</Chip>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** 状態の候補（docs/11 §2の暫定扱い。自由な値も通るため、今の値が候補外ならその値も選べるようにする） */
const STATUS_CANDIDATES = ["運用", "修繕中", "廃止", "在庫"] as const;

/** 編集フォーム（API-48車両 / API-50資機材）。保管先は施設か車両のどちらか一方（排他はサーバー422） */
function AssetEditForm({ type, asset, onSaved }: { type: "vehicle" | "equipment"; asset: VehicleDto | EquipmentDto; onSaved: () => void }) {
  const isEquipment = "quantity" in asset;
  const [name, setName] = useState(asset.name);
  const [status, setStatus] = useState(asset.status);
  const [quantity, setQuantity] = useState(isEquipment ? String((asset as EquipmentDto).quantity) : "");
  const [quantityUnit, setQuantityUnit] = useState(isEquipment ? (asset as EquipmentDto).quantityUnit : "");
  // 車両は施設1択、資機材は施設/車両/外部保管（備考）のどれか。
  // 保管先が未指定の資機材は「指定しない」（変更しない）で開く。未指定のまま黙って備考を書かない
  const [storageMode, setStorageMode] = useState<"none" | "facilityId" | "vehicleId" | "note">(
    isEquipment
      ? (asset as EquipmentDto).storage.facilityId
        ? "facilityId"
        : (asset as EquipmentDto).storage.vehicleId
          ? "vehicleId"
          : (asset as EquipmentDto).storage.note
            ? "note"
            : "none"
      : (asset as VehicleDto).storageFacilityId ? "facilityId" : "none",
  );
  const [facilityId, setFacilityId] = useState(
    isEquipment ? (asset as EquipmentDto).storage.facilityId ?? "" : (asset as VehicleDto).storageFacilityId ?? "",
  );
  const [vehicleId, setVehicleId] = useState(isEquipment ? (asset as EquipmentDto).storage.vehicleId ?? "" : "");
  const [note, setNote] = useState(isEquipment ? (asset as EquipmentDto).storage.note ?? "" : "");
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [touched, setTouched] = useState(false);
  const patch = useMutation(type === "vehicle" ? "API-48" : "API-50");

  const errors: { field: string; reason: string }[] = [];
  if (touched) {
    if (!name.trim()) errors.push({ field: "name", reason: "名称を入力してください" });
    if (!status.trim()) errors.push({ field: "status", reason: "状態を選んでください" });
    if (isEquipment && quantity !== "" && Number.isNaN(Number(quantity))) errors.push({ field: "quantity", reason: "数量は数値で入力してください" });
  }

  const submit = async () => {
    setTouched(true);
    if (errors.length > 0) return;
    if (type === "vehicle") {
      const currentFacilityId = (asset as VehicleDto).storageFacilityId;
      const storageBody =
        storageMode === "facilityId"
          ? facilityId.trim() !== (currentFacilityId ?? "")
            ? { storageFacilityId: facilityId.trim() || null }
            : {}
          : currentFacilityId !== null
            ? { storageFacilityId: null }
            : {};
      const res = await patch.run({
        params: { id: asset.id },
        body: {
          version: asset.version,
          ...(name.trim() !== asset.name ? { name: name.trim() } : {}),
          ...(status.trim() !== asset.status ? { status: status.trim() } : {}),
          ...storageBody,
        },
      });
      if (res) onSaved();
      return;
    }
    const current = asset as EquipmentDto;
    // どれか一つだけ送る（契約はnullを拒否するので、選んでいない列は省略する。サーバーが他をnullにして排他を作る）。
    // 「指定しない」は変更しない（storage自体を送らない。黙って備考を書かない）
    const nextStorage:
      | { facilityId: string; vehicleId?: undefined; note?: undefined }
      | { facilityId?: undefined; vehicleId: string; note?: undefined }
      | { facilityId?: undefined; vehicleId?: undefined; note: string }
      | null =
      storageMode === "none" ? null
        : storageMode === "facilityId" ? { facilityId: facilityId.trim() }
          : storageMode === "vehicleId" ? { vehicleId: vehicleId.trim() }
            : { note: note.trim() || "詰所" };
    const storageChanged =
      nextStorage !== null &&
      ((nextStorage.facilityId ?? null) !== current.storage.facilityId || (nextStorage.vehicleId ?? null) !== current.storage.vehicleId || (nextStorage.note ?? null) !== current.storage.note);
    const res = await patch.run({
      params: { id: asset.id },
      body: {
        version: asset.version,
        ...(name.trim() !== current.name ? { name: name.trim() } : {}),
        ...(status.trim() !== current.status ? { status: status.trim() } : {}),
        ...(Number(quantity) !== current.quantity ? { quantity: quantity === "" ? 0 : Number(quantity) } : {}),
        ...(quantityUnit.trim() !== current.quantityUnit ? { quantityUnit: quantityUnit.trim() || "本" } : {}),
        ...(nextStorage && storageChanged ? { storage: nextStorage } : {}),
      },
    });
    if (res) onSaved();
  };

  const retire = async () => {
    const res = await patch.run({ params: { id: asset.id }, body: { version: asset.version, status: "廃止" } as never });
    if (res) {
      setConfirmRetire(false);
      onSaved();
    }
  };

  const statusChoices = [
    ...STATUS_CANDIDATES,
    ...(STATUS_CANDIDATES.includes(status as (typeof STATUS_CANDIDATES)[number]) ? [] : [status]),
  ];

  return (
    <Card className="flex flex-col gap-3" aria-label="台帳の編集">
      <span className="text-[14px] font-bold">台帳を編集</span>
      <TextField name="asset-edit-name" label="名称" value={name} onChange={(e) => setName(e.target.value)} error={errors.find((e) => e.field === "name")?.reason} />
      <div className="flex flex-col gap-2">
        <span className="text-[12px] font-bold text-ink-sub">状態</span>
        <div className="flex flex-wrap gap-2">
          {statusChoices.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
              className={`flex min-h-11 flex-1 items-center justify-center rounded-field px-3 text-[13px] font-bold ${status === s ? "bg-ember text-white" : "bg-white/[.06] text-ink-sub"}`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      {isEquipment && (
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <TextField name="asset-edit-qty" label="数量（未入力なら0）" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} error={errors.find((e) => e.field === "quantity")?.reason} />
          </div>
          <div className="w-24 flex-none">
            <TextField name="asset-edit-unit" label="単位" value={quantityUnit} onChange={(e) => setQuantityUnit(e.target.value)} />
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <span className="text-[12px] font-bold text-ink-sub">保管先（{type === "vehicle" ? "施設" : "施設か車両のどちらか一方"}）</span>
        {type === "equipment" && (
          <div className="flex gap-2">
            {([["none", "指定しない"], ["note", "外部保管"], ["facilityId", "施設"], ["vehicleId", "車両"]] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                aria-pressed={storageMode === mode}
                onClick={() => setStorageMode(mode)}
                className={`flex min-h-11 flex-1 items-center justify-center rounded-field text-[12px] font-bold ${storageMode === mode ? "bg-ember text-white" : "bg-white/[.06] text-ink-sub"}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {storageMode === "facilityId" && <TextField name="asset-edit-facility" label="施設のID" value={facilityId} onChange={(e) => setFacilityId(e.target.value)} />}
        {storageMode === "vehicleId" && <TextField name="asset-edit-vehicle" label="車両のID" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} />}
        {storageMode === "note" && <TextField name="asset-edit-note" label="外部保管の備考" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例: 市貸出庫" />}
      </div>
      <MutationStatus state={patch.state} toastBottom={110} />
      {patch.state.kind === "rejected" && (
        <Banner tone="warning" eyebrow="STATE" role="alert" title="この状態では実行できません">
          保管先は施設か車両のどちらか一方で指定してください。最新の内容を確認してください。
        </Banner>
      )}
      <div className="flex flex-wrap gap-2">
        <Button busy={patch.saving} onClick={() => void submit()} className="min-w-[180px] flex-1">変更を保存</Button>
        <Button variant="secondary" busy={patch.saving} className="max-lg:min-h-11 flex-none px-4" onClick={() => setConfirmRetire(true)}>
          廃止にする
        </Button>
      </div>

      {confirmRetire && (
        <ConfirmDialog
          title="廃止にしますか"
          confirmLabel="廃止にする"
          busy={patch.saving}
          danger
          onConfirm={() => void retire()}
          onCancel={() => setConfirmRetire(false)}
        >
          <p>「{asset.name}」の状態を「廃止」にします。記録は残り、削除はされません。廃止すると一覧の既定表示から外れます。取り消し（復活）はこの画面からはできません（後続の復帰機能まで）。</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

function InfoCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 bg-[#0d1626] p-3.5">
      <span className="text-[11px] font-medium text-ink-muted">{label}</span>
      <span className={`text-[15px] font-semibold ${mono ? "font-mono text-[14px]" : ""}`}>{value}</span>
    </div>
  );
}
