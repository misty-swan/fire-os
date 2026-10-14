import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../../api";
import { PageTitle } from "../../components/Page";
import { Banner, Card, Chip } from "../../components/ui";
import type { EquipmentDto, VehicleDto } from "../../../shared/contracts/assets";

/**
 * 車両・資機材の詳細（T026、SCR-14）。台帳種別・番号・数量単位・保管先・状態を明示し、
 * 点検/異常/使用履歴への導線を作る（docs/16 T026: 未入力と0を分ける。物理削除しない）。
 */
export function AssetPage() {
  const params = useParams<{ type: "vehicle" | "equipment"; id: string }>();
  const type = params.type!;
  const id = params.id!;
  const [asset, setAsset] = useState<VehicleDto | EquipmentDto | "loading" | "notfound">("loading");

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = (await api("API-51", { params: { type, id } })) as unknown as VehicleDto | EquipmentDto;
        if (alive) setAsset(data);
      } catch {
        if (alive) setAsset("notfound");
      }
    })();
    return () => {
      alive = false;
    };
  }, [type, id]);

  if (asset === "loading") {
    return <div className="h-40 animate-pulse rounded-card bg-white/[.05]" />;
  }
  if (asset === "notfound") {
    return (
      <div className="flex max-w-[720px] flex-col gap-4">
        <Banner tone="info" eyebrow="NOT FOUND" title="この資産は存在しないか、閲覧できません">
          <Link to="/app/assets" className="underline">一覧へ戻る</Link>
        </Banner>
      </div>
    );
  }

  const isEquipment = "quantity" in asset;
  const storage = isEquipment
    ? (asset as EquipmentDto).storage.note ?? ((asset as EquipmentDto).storage.vehicleId ? "車両に保管" : (asset as EquipmentDto).storage.facilityId ? "施設に保管" : "—")
    : (asset as VehicleDto).storageFacilityId ? "施設に保管" : "—";
  const status = asset.status;

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
        <Chip tone={status === "廃止" ? "neutral" : status === "修繕中" ? "attention" : "ok"}>{status}</Chip>
      </div>

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

      {/* 導線: 点検履歴（T033の点検から作られる）。使用履歴はPH3（出動・使用記録）で接続 */}
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
    </div>
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
