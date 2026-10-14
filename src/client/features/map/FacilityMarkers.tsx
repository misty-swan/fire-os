import { clsx } from "clsx";
import { FACILITY_TYPES, facilityName, locationStatusLabel, type FacilityItem, type FacilityType } from "./useFacilities";

/**
 * 施設マーカー（T021）。種別ごとの形と色は prototype・docs/03 のトークンどおり
 * （消火栓=赤い円、防火水槽=青い丸角四角、格納箱=橙のひし形。色だけに頼らずアイコンも併記）。
 * 地図面は prototype と同じプレースホルダー（実地図の接続はV05。docs/14）。
 */

export interface MarkerBox {
  /** 施設の緯度経度を表示範囲に収めた 0〜100 の位置 */
  x: number;
  y: number;
  facility: FacilityItem;
}

/** 表示範囲（架空市。実地図の移動はV05で接続するまで固定範囲） */
export const CITY_BBOX = { west: 138.9, south: 34.9, east: 140.1, north: 36.1 };

export function toMarkerBox(f: FacilityItem): MarkerBox {
  const { west, south, east, north } = CITY_BBOX;
  const x = ((f.longitude - west) / (east - west)) * 100;
  const y = ((north - f.latitude) / (north - south)) * 100;
  return { x: Math.min(97, Math.max(3, x)), y: Math.min(97, Math.max(3, y)), facility: f };
}

export function FacilityMarker({
  facility,
  x,
  y,
  selected,
  onSelect,
}: MarkerBox & { selected: boolean; onSelect: (f: FacilityItem) => void }) {
  const t = FACILITY_TYPES[facility.type as FacilityType];
  return (
    <button
      type="button"
      aria-label={facilityName(facility)}
      aria-pressed={selected}
      onClick={() => onSelect(facility)}
      style={{ left: `${x}%`, top: `${y}%`, transform: `translate(-50%,-50%) scale(${selected ? 1.25 : 1})`, transition: "transform .25s cubic-bezier(.2,.8,.2,1)" }}
      className="absolute flex flex-col items-center gap-[5px] outline-none focus-visible:[&>span:first-child]:ring-2 focus-visible:[&>span:first-child]:ring-white/90"
    >
      <span className="relative flex size-10 items-center justify-center">
        <span
          aria-hidden="true"
          style={{ background: t.color, borderRadius: t.radius, transform: t.tf, boxShadow: selected ? "0 0 0 3px #08101c,0 0 0 5px rgba(255,255,255,.9),0 6px 14px rgba(0,0,0,.5)" : "0 0 0 2px #08101c,0 6px 14px rgba(0,0,0,.5)" }}
          className="absolute inset-[2px]"
        />
        <span aria-hidden="true" className="ms relative text-[20px] text-white [font-variation-settings:'FILL'_1]">
          {t.icon}
        </span>
      </span>
      <span className="rounded-[4px] bg-[rgba(8,16,28,.82)] px-[5px] py-px font-mono text-[10px] font-semibold text-ink">
        {facility.managementNumber ?? facility.identifyingName}
      </span>
    </button>
  );
}

/** 種別チップ（prototype: 形+色+件数。押すと表示/非表示を切り替える） */
export function TypeChip({
  type,
  count,
  on,
  onToggle,
}: {
  type: FacilityType;
  count: number;
  on: boolean;
  onToggle: () => void;
}) {
  const t = FACILITY_TYPES[type];
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      style={{ boxShadow: `inset 0 0 0 1px ${on ? t.color + "88" : "rgba(255,255,255,.08)"}` }}
      className={clsx(
        "flex h-9 max-lg:min-h-11 flex-none items-center gap-[7px] rounded-pill px-3 pl-2 text-[12px] font-bold transition",
        on ? "bg-[rgba(20,30,50,.92)] text-ink" : "bg-[rgba(20,30,50,.6)] text-ink-dim",
      )}
    >
      <span aria-hidden="true" className="relative flex size-[18px] items-center justify-center">
        <span style={{ background: t.color, borderRadius: t.radius, transform: t.tf, opacity: on ? 1 : 0.3 }} className="absolute inset-[2px]" />
      </span>
      {t.label}
      <span className="font-mono text-[11px] font-medium text-ink-muted">{count}</span>
    </button>
  );
}

/** 選択シート（スマホ）。prototype の bottom sheet（角丸28・状態3列・主ボタン52px） */
export function SelectionSheet({
  facility,
  onClose,
  onInspect,
  onDetail,
  mapsUrl,
}: {
  facility: FacilityItem;
  onClose: () => void;
  onInspect: () => void;
  onDetail: () => void;
  mapsUrl: string;
}) {
  const t = FACILITY_TYPES[facility.type as FacilityType];
  const status = locationStatusLabel[facility.verificationStatus];
  const statusTone = { neutral: "text-ink", attention: "text-attention", ok: "text-ok", alert: "text-alert" }[status.tone];
  return (
    <div className="max-lg:absolute inset-x-2.5 bottom-[94px] lg:hidden" role="dialog" aria-label={facilityName(facility)}>
      <div className="rounded-[28px] bg-[rgba(14,22,38,.97)] px-[18px] pb-[18px] pt-[10px] shadow-[inset_0_0_0_1px_rgba(255,255,255,.1),0_-10px_40px_rgba(0,0,0,.5)]">
        <div aria-hidden="true" className="mx-auto mb-3 h-1 w-10 rounded-[2px] bg-white/[.18]" />
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="relative flex size-[46px] flex-none items-center justify-center">
            <span style={{ background: t.color, borderRadius: t.radius, transform: t.tf }} className="absolute inset-1" />
            <span className="ms relative text-[21px] text-white [font-variation-settings:'FILL'_1]">{t.icon}</span>
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <span className="text-[11px] font-medium text-ink-muted">
              {t.label} · {facility.managementNumber ?? facility.identifyingName}
            </span>
            <span className="text-[18px] font-bold">{facilityName(facility)}</span>
            <span className="text-[12px] font-medium text-ink-sub">{facility.locationNote}</span>
          </div>
          <button type="button" aria-label="閉じる" onClick={onClose} className="grid size-9 place-items-center rounded-full bg-white/[.07] max-lg:size-11">
            <span aria-hidden="true" className="ms text-[19px]">close</span>
          </button>
        </div>
        <div className="mt-3.5 grid grid-cols-3 gap-px overflow-hidden rounded-[14px] bg-white/[.07]">
          <div className="flex flex-col gap-1 bg-[#0e1626] px-3 py-2.5">
            <span className="text-[10px] font-medium text-ink-muted">位置確認</span>
            <span className={clsx("text-[12px] font-bold", statusTone)}>{status.text}</span>
          </div>
          <div className="flex flex-col gap-1 bg-[#0e1626] px-3 py-2.5">
            <span className="text-[10px] font-medium text-ink-muted">位置出典</span>
            <span className="truncate text-[12px] font-semibold">{facility.locationSource}</span>
          </div>
          <div className="flex flex-col gap-1 bg-[#0e1626] px-3 py-2.5">
            <span className="text-[10px] font-medium text-ink-muted">管理番号</span>
            <span className="truncate font-mono text-[12px] font-semibold">{facility.managementNumber ?? "—"}</span>
          </div>
        </div>
        <div className="mt-3.5 flex gap-2">
          <button
            type="button"
            onClick={onInspect}
            className="flex h-[52px] flex-1 items-center justify-center gap-2 rounded-pill bg-ember text-[15px] font-bold text-white shadow-[0_10px_24px_-8px_rgba(255,90,46,.7)] active:scale-[.98]"
          >
            <span aria-hidden="true" className="ms text-[20px]">fact_check</span>
            点検する
          </button>
          <button type="button" onClick={onDetail} className="h-[52px] rounded-pill bg-white/[.08] px-[18px] text-[14px] font-bold">
            詳細
          </button>
          <a
            href={mapsUrl}
            target="_blank"
            rel="noreferrer"
            aria-label="Googleマップで経路を開く"
            className="grid size-[52px] flex-none place-items-center rounded-full bg-white/[.08] max-lg:size-[52px]"
          >
            <span aria-hidden="true" className="ms text-[21px]">directions</span>
          </a>
        </div>
      </div>
    </div>
  );
}
