import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { clsx } from "clsx";
import { PageTitle } from "../../components/Page";
import { Notice } from "../../components/ui";
import { Icon } from "../../components/ui";
import { buildMapsUrl } from "../facilities/location";
import { FacilityMarker, SelectionSheet, TypeChip, toMarkerBox, CITY_BBOX } from "./FacilityMarkers";
import { facilityName, locationStatusLabel, useFacilities, type FacilityItem, type FacilityType } from "./useFacilities";

/**
 * マップ（T021、SCR-03。prototype FireOS Prototype マップ / FireOS Desktop Map）。
 * 検索＋地図/一覧切替、種別チップ（件数）、現在地、選択シート（スマホ）/右420pxの一覧と詳細（PC）。
 * 地図面は prototype と同じプレースホルダー。Google Maps実地図の接続はV05（docs/14）。
 * 応答は世代番号で管理し、全cursor完走まで「取得中」を表示する（docs/05 §5）。
 */
export function MapPage() {
  const navigate = useNavigate();
  const [mapView, setMapView] = useState<"map" | "list">("map");
  const [selected, setSelected] = useState<string | null>(null);
  const [types, setTypes] = useState<Record<FacilityType, boolean>>({ hydrant: true, cistern: true, box: true });
  const [q, setQ] = useState("");

  const { items, state, reload } = useFacilities({ bbox: `${CITY_BBOX.west},${CITY_BBOX.south},${CITY_BBOX.east},${CITY_BBOX.north}` });

  // 種別チップは表示のON/OFF（prototype filters）。件数は読めた施設から数える
  const counts = useMemo(() => {
    const c: Record<FacilityType, number> = { hydrant: 0, cistern: 0, box: 0 };
    for (const f of items) c[f.type]!++;
    return c;
  }, [items]);
  const shown = useMemo(() => {
    const query = q.trim().toLowerCase();
    return items.filter((f) => types[f.type]).filter((f) => {
      if (!query) return true;
      const hay = `${facilityName(f)} ${f.managementNumber ?? ""} ${f.identifyingName ?? ""} ${f.locationNote}`.toLowerCase();
      return hay.includes(query);
    });
  }, [items, types, q]);

  const selectedFacility = shown.find((f) => f.id === selected) ?? items.find((f) => f.id === selected) ?? null;
  const select = (f: FacilityItem) => setSelected(f.id);
  const openDetail = (f: FacilityItem) => navigate(`/app/facilities/${f.id}`);

  const searchResults = q.trim()
    ? shown.slice(0, 4).map((f) => ({ facility: f, onOpen: () => { setQ(""); setSelected(f.id); setMapView("map"); } }))
    : [];

  const listRow = (f: FacilityItem) => {
    const status = locationStatusLabel[f.verificationStatus];
    const tone = { neutral: "bg-white/[.08] text-[#c3cad6]", attention: "bg-attention/[.14] text-attention", ok: "bg-ok/[.14] text-ok", alert: "bg-alert/[.16] text-alert" }[status.tone];
    return (
      <button
        key={f.id}
        type="button"
        onClick={() => (window.innerWidth >= 1024 ? select(f) : openDetail(f))}
        className="flex w-full items-center gap-3 border-t border-white/[.05] px-4 py-3 text-left hover:bg-white/[.03] max-lg:min-h-11 max-lg:rounded-card max-lg:bg-white/[.03] max-lg:mx-4 max-lg:border max-lg:border-transparent"
      >
        <TypeGlyph type={f.type} size={32} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] font-bold">{facilityName(f)}</span>
          <span className="truncate text-[11px] text-ink-muted">{f.locationNote}</span>
        </span>
        <span className={clsx("rounded-pill px-2 py-1 text-[11px] font-bold", tone)}>{status.text}</span>
      </button>
    );
  };

  return (
    <div className="flex max-w-[1440px] flex-col gap-4">
      {/* スマホ: 等幅の小見出し＋画面名。PCはヘッダーに出るので本文では隠す */}
      <PageTitle eyebrow="MAP" className="lg:hidden">
        マップ
      </PageTitle>
      <div aria-hidden="true" className="hidden lg:block" />

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_420px] lg:overflow-hidden lg:rounded-[20px] lg:border lg:border-white/[.06]">
        {/* 地図面（スマホは全幅・高さ固定。PCは左列） */}
        <div className="relative h-[420px] overflow-hidden bg-[radial-gradient(900px_600px_at_50%_45%,#122036,#0a121e)] max-lg:h-[calc(100vh-232px)] lg:h-[calc(100vh-64px)]">
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-[repeating-linear-gradient(135deg,rgba(255,255,255,.028)_0_2px,transparent_2px_14px)]"
          />
          <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center font-mono text-[10px] leading-[1.7] tracking-[.08em] text-[#4b5870]">
            MAP PLACEHOLDER
            <br />
            Google Maps JS API · ダークスタイル
          </span>

          {/* 検索と切替（スマホの上端。prototype の位置）。空き領域はマップの下にタップを通す */}
          <div className="pointer-events-none absolute inset-x-0 top-0 z-30 flex flex-col gap-2.5 px-4 pb-3.5 pt-2 max-lg:bg-[linear-gradient(180deg,rgba(8,16,28,.95)_60%,rgba(8,16,28,0))] lg:left-5 lg:right-5 lg:top-4 lg:bg-transparent lg:px-0 lg:pt-0">
            <div className="pointer-events-auto flex gap-2">
              <div className="flex h-[50px] min-w-0 flex-1 items-center gap-2 rounded-pill bg-[rgba(20,30,50,.9)] px-4 shadow-[inset_0_0_0_1px_rgba(255,255,255,.1)]">
                <Icon name="search" className="text-[20px] text-ink-dim" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="施設名・管理番号で検索"
                  aria-label="施設を検索"
                  className="min-w-0 flex-1 border-none bg-transparent font-medium text-ink outline-none placeholder:text-ink-dim"
                />
              </div>
              <button
                type="button"
                onClick={() => { setMapView(mapView === "map" ? "list" : "map"); setSelected(null); }}
                className="flex h-[50px] flex-none items-center gap-1.5 whitespace-nowrap rounded-pill bg-[rgba(20,30,50,.9)] px-4 text-[13px] font-bold shadow-[inset_0_0_0_1px_rgba(255,255,255,.1)] max-lg:min-h-11"
              >
                <Icon name={mapView === "map" ? "list" : "map"} className="text-[19px]" />
                {mapView === "map" ? "一覧" : "地図"}
              </button>
            </div>
            {searchResults.length > 0 && (
              <div className="pointer-events-auto overflow-hidden rounded-[18px] bg-[#101a2b] shadow-[inset_0_0_0_1px_rgba(255,255,255,.1)]">
                {searchResults.map((r) => (
                  <button key={r.facility.id} type="button" onClick={r.onOpen} className="flex w-full justify-between border-b border-white/[.06] px-4 py-3 text-left last:border-b-0">
                    <span className="text-[13px] font-bold">{facilityName(r.facility)}</span>
                    <span className="text-[11px] font-medium text-ink-muted">{r.facility.managementNumber}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="fo-scroll pointer-events-auto flex gap-1.5 overflow-x-auto">
              {(Object.keys(FACILITY_TYPE_KEYS) as FacilityType[]).map((k) => (
                <TypeChip key={k} type={k} count={counts[k]!} on={types[k]!} onToggle={() => { setTypes((prev) => ({ ...prev, [k]: !prev[k] })); reload(); }} />
              ))}
            </div>
          </div>

          {/* 取得状態（docs/05 §5: 完走まで部分取得を表示） */}
          {state !== "complete" && (
            <div className="absolute bottom-3 left-5 z-30">
              <Notice tone="info" icon="cloud_sync">
                {state === "error" ? (
                  <>
                    一覧を取得できませんでした。
                    <button type="button" onClick={reload} className="ml-1 rounded-pill bg-white/[.08] px-2.5 py-1 text-[12px] font-bold max-lg:min-h-11">
                      再試行
                    </button>
                  </>
                ) : (
                  "施設一覧を取得中…"
                )}
              </Notice>
            </div>
          )}

          {/* 地図/一覧の本体 */}
          {mapView === "map" ? (
            <>
              {shown.map((f) => {
                const box = toMarkerBox(f);
                return <FacilityMarker key={f.id} {...box} facility={f} selected={selected === f.id} onSelect={select} />;
              })}
              <button
                type="button"
                aria-label="現在地"
                onClick={() => { /* 現在地の表示は端末の位置情報。保存はしない（docs/03 §4） */ }}
                className="absolute bottom-[110px] right-4 z-[25] grid size-[50px] place-items-center rounded-full bg-[rgba(20,30,50,.92)] shadow-[inset_0_0_0_1px_rgba(255,255,255,.12),0_8px_20px_rgba(0,0,0,.4)] max-lg:min-h-11 max-lg:min-w-11"
              >
                <Icon name="my_location" className="text-[22px] text-[#4f9bff]" />
              </button>
            </>
          ) : (
            <div className="fo-scroll absolute inset-0 overflow-y-auto pt-[132px]">
              <div className="mx-4 mb-3 flex items-baseline justify-between">
                <span className="text-[16px] font-bold">施設一覧</span>
                <span className="font-mono text-[12px] text-ink-muted">{shown.length}件</span>
              </div>
              {shown.map(listRow)}
              {shown.length === 0 && state === "complete" && (
                <div className="mx-5 flex flex-col items-center gap-2 rounded-[18px] border border-dashed border-white/[.14] px-5 py-7 text-center">
                  <Icon name="search_off" className="text-[26px] text-ink-dim" />
                  <span className="text-[14px] font-bold">該当する施設がありません</span>
                  <span className="text-[12px] text-ink-muted">管理番号（例：K-112）でも検索できます</span>
                </div>
              )}
              <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4">
                <Link to="/app/facilities/new" className="flex min-h-11 items-center gap-1.5 rounded-pill bg-white/[.08] px-4 text-[13px] font-bold">
                  <Icon name="add_location_alt" className="text-[18px]" />
                  施設を登録
                </Link>
                <Link to="/app/facilities/import" className="flex min-h-11 items-center text-[12px] font-bold text-ink-muted underline">
                  施設CSV取込
                </Link>
              </div>
            </div>
          )}

          {/* 選択シート（スマホ） */}
          {selectedFacility && mapView === "map" && (
            <SelectionSheet
              facility={selectedFacility}
              onClose={() => setSelected(null)}
              onInspect={() => navigate(`/app/facilities/${selectedFacility.id}/inspections/new`)}
              onDetail={() => openDetail(selectedFacility)}
              mapsUrl={buildMapsUrl(selectedFacility)}
            />
          )}
        </div>

        {/* PC: 右420pxの一覧/詳細（prototype Desktop Map） */}
        <div className="fo-scroll hidden border-l border-white/[.06] bg-[#0a1220] lg:block lg:overflow-y-auto">
          {selectedFacility ? (
            <FacilityPanelDetail facility={selectedFacility} onBack={() => setSelected(null)} onInspect={() => navigate(`/app/facilities/${selectedFacility.id}/inspections/new`)} />
          ) : (
            <>
              <div className="sticky top-0 z-[2] flex flex-col gap-3 bg-[#0a1220] px-5 pb-2.5 pt-[18px]">
                <div className="flex items-baseline justify-between">
                  <span className="text-[16px] font-bold">施設一覧</span>
                  <span className="font-mono text-[12px] text-ink-muted">{shown.length}件{state === "partial" ? "（取得中）" : ""}</span>
                </div>
                <div className="flex h-10 items-center gap-2 rounded-[12px] bg-white/[.05] px-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,.08)]">
                  <Icon name="search" className="text-[18px] text-ink-dim" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="施設名・管理番号・住所"
                    aria-label="施設を検索"
                    className="min-w-0 flex-1 border-none bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-ink-dim"
                  />
                </div>
              </div>
              {shown.map(listRow)}
              {shown.length === 0 && state === "complete" && (
                <div className="m-5 flex flex-col items-center gap-2 rounded-[18px] border border-dashed border-white/[.14] px-5 py-7 text-center">
                  <Icon name="search_off" className="text-[26px] text-ink-dim" />
                  <span className="text-[14px] font-bold">該当する施設がありません</span>
                </div>
              )}
              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 py-5">
                <Link to="/app/facilities/new" className="flex items-center gap-1.5 rounded-pill bg-white/[.08] px-4 py-2.5 text-[13px] font-bold">
                  <Icon name="add_location_alt" className="text-[18px]" />
                  施設を登録
                </Link>
                <Link to="/app/facilities/import" className="flex min-h-11 items-center text-[12px] font-bold text-ink-muted underline">
                  施設CSV取込
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
      {selectedFacility && (
        <div className="lg:hidden">
          {/* 選択中のスマホの詳細への導線はシートの「詳細」。地図の下に補足は出さない */}
        </div>
      )}
    </div>
  );
}

const FACILITY_TYPE_KEYS = { hydrant: true, cistern: true, box: true } as const;

/** 種別の字形（サイズ可変。一覧32px・シート46px） */
export function TypeGlyph({ type, size }: { type: FacilityType; size: number }) {
  const t = FACILITY_TYPE_KEYS[type] ? MAP_TYPES[type] : MAP_TYPES.hydrant;
  const s = size;
  return (
    <span aria-hidden="true" className="relative flex flex-none items-center justify-center" style={{ width: s, height: s }}>
      <span style={{ background: t.color, borderRadius: t.radius, transform: t.tf }} className="absolute inset-[3px]" />
      <span className="ms relative text-white [font-variation-settings:'FILL'_1]" style={{ fontSize: s * 0.5 }}>
        {t.icon}
      </span>
    </span>
  );
}
import { FACILITY_TYPES as MAP_TYPES } from "./useFacilities";

/** PC右パネルの詳細（prototype Desktop の選択中ビュー） */
function FacilityPanelDetail({ facility, onBack, onInspect }: { facility: FacilityItem; onBack: () => void; onInspect: () => void }) {
  const status = locationStatusLabel[facility.verificationStatus];
  const tone = { neutral: "bg-white/[.08] text-[#c3cad6]", attention: "bg-attention/[.14] text-attention", ok: "bg-ok/[.14] text-ok", alert: "bg-alert/[.16] text-alert" }[status.tone];
  return (
    <div className="flex flex-col">
      <div className="relative flex h-[180px] items-center justify-center bg-[linear-gradient(180deg,#16233a,#0b1422)]">
        <span aria-hidden="true" className="absolute inset-0 bg-[repeating-linear-gradient(135deg,rgba(255,255,255,.035)_0_2px,transparent_2px_12px)]" />
        <span className="font-mono text-[10px] tracking-[.1em] text-[#5a6780]">施設写真</span>
        <button type="button" onClick={onBack} aria-label="一覧に戻る" className="absolute left-3.5 top-3.5 flex h-[34px] items-center gap-1 rounded-pill bg-[rgba(8,16,28,.75)] pl-2 pr-3 text-[12px] font-bold">
          <Icon name="chevron_left" className="text-[18px]" />
          一覧
        </button>
      </div>
      <div className="flex flex-col gap-2 px-[22px] pt-[18px]">
        <div className="flex gap-1.5">
          <span className="rounded-pill px-[9px] py-[3px] text-[11px] font-bold text-white" style={{ background: MAP_TYPES[facility.type].color }}>
            {MAP_TYPES[facility.type].label}
          </span>
          <span className={clsx("rounded-pill px-[9px] py-[3px] text-[11px] font-bold", tone)}>位置：{status.text}</span>
        </div>
        <span className="text-[22px] font-bold">{facilityName(facility)}</span>
        <span className="text-[12px] text-ink-sub">{facility.locationNote}</span>
      </div>
      <div className="mx-[22px] mt-3.5 grid grid-cols-2 gap-px overflow-hidden rounded-[14px] bg-white/[.07]">
        <InfoCell label="管理番号" value={facility.managementNumber ?? "—"} mono />
        <InfoCell label="識別名" value={facility.identifyingName ?? "—"} />
        <InfoCell label="位置出典" value={facility.locationSource} />
        <InfoCell label="位置確認" value={status.text} />
      </div>
      <div className="flex items-center gap-2.5 mx-[22px] mt-3.5 rounded-[14px] bg-white/[.04] px-3.5 py-3">
        <Icon name="place" className="text-[19px] text-[#4f9bff]" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[10px] text-ink-muted">座標（外部マップへ送る値）</span>
          <span className="font-mono text-[12px]">{facility.latitude}, {facility.longitude}</span>
        </span>
        <a
          href={buildMapsUrl(facility)}
          target="_blank"
          rel="noreferrer"
          aria-label="Googleマップで開く"
          className="grid size-[46px] place-items-center rounded-full bg-white/[.08]"
        >
          <Icon name="directions" className="text-[20px]" />
        </a>
      </div>
      <div className="flex gap-2 px-[22px] pb-[18px] pt-5">
        <button type="button" onClick={onInspect} className="flex h-[46px] flex-1 items-center justify-center gap-1.5 rounded-pill bg-ember text-[13px] font-bold text-white">
          <Icon name="send" className="text-[18px]" />
          点検を依頼
        </button>
      </div>
    </div>
  );
}

function InfoCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 bg-[#0d1626] px-[13px] py-[11px]">
      <span className="text-[10px] font-medium text-ink-muted">{label}</span>
      <span className={clsx("text-[13px] font-semibold", mono && "font-mono")}>{value}</span>
    </div>
  );
}
