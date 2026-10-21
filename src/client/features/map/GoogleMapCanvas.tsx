/// <reference types="google.maps" />
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Notice } from "../../components/ui";
import { DEMO_BBOX, FacilityMarker, FacilityMarkerFace, toMarkerBox } from "./FacilityMarkers";
import { type FacilityItem } from "./useFacilities";
import { useGoogleMaps } from "./useGoogleMaps";

/**
 * 実地図キャンバス（V05。docs/14。prototype FireOS Desktop Map の「ダークスタイル」）。
 * MapPageはキー（VITE_GOOGLE_MAPS_API_KEY）の有無でこのcomponentと現行の置き換え絵を選ぶ（分岐は1箇所）。
 * 読み込み中・失敗時は置き換え絵のマーカーのまま（失敗時は案内を出す。空の地図で固めない）。
 * マーカーは google.maps.Marker のSVG pinではなく、FacilityMarkerと同じDOM（種別の形・色・管理番号。
 * prototypeどおり）を google.maps.OverlayView で緯度経度へ載せる。帰属表示（「©Google」）はタイル由来で自動。
 * 種別チップ・一覧・選択シートはMapPageの既存stateのまま（このcomponentは地図面だけを担う）。
 */

export interface GoogleMapCanvasProps {
  facilities: FacilityItem[];
  selectedId: string | null;
  onSelect: (f: FacilityItem) => void;
}

export function GoogleMapCanvas({ facilities, selectedId, onSelect }: GoogleMapCanvasProps) {
  const { loaded, error } = useGoogleMaps();
  if (loaded) return <RealMapCanvas facilities={facilities} selectedId={selectedId} onSelect={onSelect} />;
  return (
    <>
      {/* 読み込み中・失敗時は置き換え絵のまま（板と文言はMapPageの地図面、マーカーはここ。空にしない） */}
      <PlaceholderMarkers facilities={facilities} selectedId={selectedId} onSelect={onSelect} />
      {error && (
        <div className="pointer-events-none absolute inset-x-4 top-[152px] z-20 flex justify-center">
          <Notice tone="warning" icon="map" role="status">
            地図を読み込めませんでした。一覧で確認できます。
          </Notice>
        </div>
      )}
    </>
  );
}

/** 置き換え絵のマーカー層（DEMO_BBOX基準の0〜100%位置。キー無しのMapPageと読み込み中・失敗時で共用） */
export function PlaceholderMarkers({ facilities, selectedId, onSelect }: GoogleMapCanvasProps) {
  return (
    <>
      {facilities.map((f) => {
        const box = toMarkerBox(f);
        return <FacilityMarker key={f.id} {...box} facility={f} selected={selectedId === f.id} onSelect={onSelect} />;
      })}
    </>
  );
}

/** 初期中心（DEMO_BBOX＝宮之浦周辺の中心。起動直後の一瞬だけ使われ、すぐ施設範囲のfitBoundsへ置き換わる） */
const CITY_CENTER = {
  lat: (DEMO_BBOX.north + DEMO_BBOX.south) / 2,
  lng: (DEMO_BBOX.east + DEMO_BBOX.west) / 2,
};

/** ダークスタイル（prototypeの指示。Googleの標準ダーク配色） */
const DARK_MAP_STYLES: google.maps.MapTypeStyle[] = [
  { elementType: "geometry", stylers: [{ color: "#242f3e" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#d59563" }] },
  { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#d59563" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#263c3f" }] },
  { featureType: "poi.park", elementType: "labels.text.fill", stylers: [{ color: "#6b9a76" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#38414e" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#212a37" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#9ca5b3" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#746855" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#1f2835" }] },
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#f3d19c" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#2f3948" }] },
  { featureType: "transit.station", elementType: "labels.text.fill", stylers: [{ color: "#d59563" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#17263c" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#515c6d" }] },
  { featureType: "water", elementType: "labels.text.stroke", stylers: [{ color: "#17263c" }] },
];

function RealMapCanvas({ facilities, selectedId, onSelect }: GoogleMapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [map, setMap] = useState<google.maps.Map | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // 初期視点は施設範囲のfitBounds（下のeffect）に任せる。中心・zoomは一瞬だけの既定値
    const m = new google.maps.Map(container, {
      center: CITY_CENTER,
      zoom: 13,
      styles: DARK_MAP_STYLES,
      mapTypeControl: false,
      fullscreenControl: false,
      streetViewControl: false,
      zoomControl: true,
      clickableIcons: false,
      gestureHandling: "greedy",
    });
    setMap(m);
  }, []);

  // 初期視点: 施設の緯度経度のmin/maxへfitBounds（パディングはマーカーが縁に隠れない分）
  const fitted = useRef(false);
  useEffect(() => {
    if (!map || fitted.current || facilities.length === 0) return;
    fitted.current = true;
    const bounds = new google.maps.LatLngBounds();
    for (const f of facilities) bounds.extend({ lat: f.latitude, lng: f.longitude });
    map.fitBounds(bounds, 64);
  }, [map, facilities]);

  return (
    <div className="absolute inset-0 bg-[#17263c]">
      <div ref={containerRef} className="absolute inset-0" />
      {map && <MarkerOverlays map={map} facilities={facilities} selectedId={selectedId} onSelect={onSelect} />}
    </div>
  );
}

/**
 * 施設ごとのOverlayView。overlayMouseTargetのpaneへwrapperを置き、draw()で画素位置へ動かす。
 * 中身（ボタン）はReactのportalでFacilityMarkerFaceをそのまま描く＝置き換え絵と同じDOM・挙動
 * （aria-label・aria-pressed・選択で1.25倍）が実地図でも効く。
 */
function MarkerOverlays({ map, facilities, selectedId, onSelect }: GoogleMapCanvasProps & { map: google.maps.Map }) {
  const facilitiesRef = useRef(facilities);
  facilitiesRef.current = facilities;
  // keyはidだけでなく緯度経度も含める（同じidの座標が直されたときoverlayを作り直して画素位置を追従させる）
  const facilityKey = useMemo(() => facilities.map((f) => `${f.id}:${f.latitude},${f.longitude}`).join(","), [facilities]);
  const [slots, setSlots] = useState<Array<{ id: string; div: HTMLDivElement; facility: FacilityItem }>>([]);

  useEffect(() => {
    const created = facilitiesRef.current.map((facility) => {
      const div = document.createElement("div");
      const overlay = createMarkerOverlay(map, { lat: facility.latitude, lng: facility.longitude }, div);
      return { id: facility.id, div, facility, overlay };
    });
    setSlots(created);
    return () => {
      for (const c of created) {
        c.overlay.setMap(null); // onRemoveでwrapperも外れる
      }
    };
  }, [map, facilityKey]);

  return (
    <>
      {slots.map((s) =>
        createPortal(
          <FacilityMarkerFace facility={s.facility} x="0px" y="0px" selected={s.facility.id === selectedId} onSelect={onSelect} />,
          s.div,
          s.id,
        ),
      )}
    </>
  );
}

function createMarkerOverlay(
  map: google.maps.Map,
  position: google.maps.LatLngLiteral,
  div: HTMLDivElement,
): google.maps.OverlayView {
  const overlay = new google.maps.OverlayView();
  overlay.onAdd = () => {
    const panes = overlay.getPanes();
    if (!panes) return;
    panes.overlayMouseTarget.appendChild(div);
  };
  overlay.draw = () => {
    const projection = overlay.getProjection();
    if (!projection) return;
    const point = projection.fromLatLngToDivPixel(new google.maps.LatLng(position));
    if (!point) return;
    div.style.position = "absolute";
    div.style.left = `${point.x}px`;
    div.style.top = `${point.y}px`;
  };
  overlay.onRemove = () => {
    div.remove();
  };
  overlay.setMap(map);
  return overlay;
}
