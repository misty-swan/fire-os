import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapPage } from "../src/client/features/map/MapPage";
import { GoogleMapCanvas } from "../src/client/features/map/GoogleMapCanvas";
import { resetGoogleMapsLoaderForTests, useGoogleMaps } from "../src/client/features/map/useGoogleMaps";
import type { FacilityItem } from "../src/client/features/map/useFacilities";

/**
 * 実地図（V05。docs/14）。Google Maps JS APIはキー（VITE_GOOGLE_MAPS_API_KEY）がある環境だけで読み、
 * キーが無い環境では現行の置き換え絵のまま（ローカル・試験・e2eも不変。キーの値はGitに載せない）。
 * ①キー無し: MapPageは置き換え絵（CITY_BBOXベースのマーカーbox）を選ぶ（scriptは挿入しない）
 * ②キー無し: useGoogleMapsは loaded:false・error:null のまま（呼び出しは無害）
 * ③キー有り: script（maps.googleapis.com/maps/api/js）は一度だけ挿入。jsdomでは解決しない
 *   （ローダーはPromiseを返すだけで、解決は地図callback待ち＝試験でネットワークを呼ばない）
 * ④ロード失敗（gm_authFailure）: 置き換え絵へフォールバックし「地図を読み込めませんでした。
 *   一覧で確認できます。」の案内（role="status"）を出す
 * ⑤ロード成功: google.maps.Map を作り施設範囲でfitBoundsし、FacilityMarkerと同じDOM（種別の形・色・
 *   管理番号。prototypeどおり）をOverlayViewの画素位置に載せる（google.maps.Markerのpinは使わない）
 */

const item = (id: string): FacilityItem => ({
  id, version: 1, type: "hydrant", managementNumber: id.toUpperCase(), identifyingName: null,
  latitude: 35.1, longitude: 139.1, locationSource: "架空市台帳", locationNote: `試験 ${id}`,
  locationVersion: 1, verificationStatus: "unverified", lastVerifiedAt: null, metadata: {},
});

const responseOf = (data: FacilityItem[]) =>
  new Response(JSON.stringify({ data, meta: { requestId: "req-1" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const mapsScripts = () => document.querySelectorAll('script[src*="maps.googleapis"]');

/** 実地図APIの最小スタブ（jsdomは描画しない。Map/OverlayViewの呼び出しを記録するだけ） */
function stubGoogleMapsApi() {
  const calls: { method: string; args: unknown[] }[] = [];
  class StubMap {
    constructor(container: HTMLElement, options: unknown) {
      calls.push({ method: "constructor", args: [container, options] });
    }
    fitBounds(...args: unknown[]) {
      calls.push({ method: "fitBounds", args });
    }
  }
  class StubLatLng {
    constructor(lat: number, lng: number) {
      calls.push({ method: "LatLng", args: [lat, lng] });
    }
  }
  class StubLatLngBounds {
    extend(point: unknown) {
      calls.push({ method: "extend", args: [point] });
    }
  }
  class StubOverlayView {
    onAdd?: () => void;
    draw?: () => void;
    onRemove?: () => void;
    setMap(map: unknown) {
      if (map) {
        this.onAdd?.();
        this.draw?.();
      } else {
        this.onRemove?.();
      }
    }
    getPanes() {
      // overlayMouseTarget（マーカーを受けるとこ。jsdomではbodyに置いて中身を検査できるようにする）
      const pane = document.createElement("div");
      document.body.appendChild(pane);
      return { overlayMouseTarget: pane };
    }
    getProjection() {
      return { fromLatLngToDivPixel: () => ({ x: 12, y: 34 }) };
    }
  }
  vi.stubGlobal("google", { maps: { Map: StubMap, LatLng: StubLatLng, LatLngBounds: StubLatLngBounds, OverlayView: StubOverlayView } });
  return calls;
}

beforeEach(() => {
  // 単一ロードの状態を試験ごとに戻す（scriptの挿入も片付ける）
  resetGoogleMapsLoaderForTests();
  for (const s of mapsScripts()) s.remove();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("マップの実地図（キーがある環境だけ。V05）", () => {
  it("without_api_key_map_page_keeps_the_placeholder_board_and_inserts_no_script", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseOf([item("f1")])));
    render(
      <MemoryRouter initialEntries={["/app/map"]}>
        <MapPage />
      </MemoryRouter>,
    );
    // 置き換え絵（MAP PLACEHOLDERの板）とCITY_BBOXベースのマーカー
    await screen.findByRole("button", { name: "消火栓 F1" });
    expect(document.body.textContent).toContain("MAP PLACEHOLDER");
    expect(mapsScripts().length).toBe(0);
  });

  it("without_api_key_loader_stays_inert_without_error", () => {
    const { result } = renderHook(() => useGoogleMaps());
    expect(result.current.loaded).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mapsScripts().length).toBe(0);
  });

  it("with_api_key_canvas_inserts_the_maps_script_exactly_once", async () => {
    vi.stubEnv("VITE_GOOGLE_MAPS_API_KEY", "test-key");
    const facilities = [item("f1"), item("f2")];
    const props = { facilities, selectedId: null as string | null, onSelect: () => {} };
    render(<GoogleMapCanvas {...props} />);
    render(<GoogleMapCanvas {...props} />);
    // 単一ロード: 置き換え絵のマーカーは読み込み中も見え（2つのmountに1つずつ）、scriptは2回renderしても1本だけ
    expect((await screen.findAllByRole("button", { name: "消火栓 F1" })).length).toBe(2);
    const scripts = mapsScripts();
    expect(scripts.length).toBe(1);
    const src = scripts[0]!.getAttribute("src") ?? "";
    expect(src).toContain("key=test-key");
    expect(src).toContain("callback=__fireosMapsCallback");
    expect(src).toContain("loading=async");
    expect(src).toContain("language=ja");
    expect(src).toContain("region=JP");
    // 認証・quota失敗の検知用（script挿入前に置かれる）
    expect(typeof (window as { gm_authFailure?: unknown }).gm_authFailure).toBe("function");
  });

  it("when_maps_fails_canvas_falls_back_to_placeholder_with_notice", async () => {
    vi.stubEnv("VITE_GOOGLE_MAPS_API_KEY", "test-key");
    render(<GoogleMapCanvas facilities={[item("f1")]} selectedId={null} onSelect={() => {}} />);
    // 読み込み中も置き換え絵のマーカーのまま（空にならない）
    await screen.findByRole("button", { name: "消火栓 F1" });
    // エラー注入: 認証失敗（キーの誤り・制限・quota。Maps側が gm_authFailure を呼ぶ）
    act(() => {
      (window as { gm_authFailure?: () => void }).gm_authFailure?.();
    });
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("地図を読み込めませんでした。一覧で確認できます。");
    // フォールバック先は置き換え絵＝マーカーは一覧で確認できる
    expect(screen.getByRole("button", { name: "消火栓 F1" })).toBeTruthy();
  });

  it("when_maps_loads_canvas_places_the_marker_dom_on_overlay_pixel_positions", async () => {
    vi.stubEnv("VITE_GOOGLE_MAPS_API_KEY", "test-key");
    const calls = stubGoogleMapsApi();
    render(<GoogleMapCanvas facilities={[item("f1"), item("f2")]} selectedId={null} onSelect={() => {}} />);
    // ロード完了: 地図callback（ローダーがwindowに置く。試験が代わりに発火する＝ネットワークは呼ばない）
    await act(async () => {
      (window as unknown as { __fireosMapsCallback: () => void }).__fireosMapsCallback();
    });
    await waitFor(() => expect(calls.some((c) => c.method === "fitBounds")).toBe(true));
    // 初期視点は施設の緯度経度のmin/max（2件ともboundsに含める）
    expect(calls.filter((c) => c.method === "extend")).toHaveLength(2);
    // マーカーはOverlayViewの画素位置（スタブの投影値 12,34）に載り、二重にはならない
    await screen.findByRole("button", { name: "消火栓 F1" });
    expect(screen.getAllByRole("button", { name: "消火栓 F1" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "消火栓 F2" })).toHaveLength(1);
    const slot = screen.getByRole("button", { name: "消火栓 F1" }).closest("div[style]") as HTMLElement | null;
    expect(slot).toBeTruthy();
    expect(slot!.style.left).toBe("12px");
    expect(slot!.style.top).toBe("34px");
  });
});
