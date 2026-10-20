import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFacilities, type FacilityItem } from "../src/client/features/map/useFacilities";
import { SelectionSheet } from "../src/client/features/map/FacilityMarkers";

/**
 * ① 施設一覧の再取得と点滅（PH2-C15・T086。docs/evidence/ph2-review.md C15）。
 * 種別チップのトグルは表示フィルタ（prototype）で、件数を最新にする再取得は裏で走る。
 * 再取得の間も現在の一覧・件数を表示し続け（一覧を空にして点滅させない）、
 * 新しい世代の結果は揃ったときだけ差し替わる。初回の読み込みだけ「取得中」を通る。
 *
 * ② 選択シートのEscとフォーカス（PH2-C19・T086。docs/evidence/ph2-review.md C19〜C21）。
 * シートはrole="dialog"のため、Escで閉じられる・開いたら中へフォーカスが移る・
 * 閉じたら開いた操作へ戻る（docs/03 §1 共通UIの「閉じたら操作位置へフォーカスを戻す」と
 * Overlay〔ドロワー/モーダル〕と同じ挙動。地図は操作できるままの非モーダルのためTabトラップは持たない）。
 */

const item = (id: string, type: FacilityItem["type"] = "hydrant"): FacilityItem => ({
  id, version: 1, type, managementNumber: id.toUpperCase(), identifyingName: null,
  latitude: 35.1, longitude: 139.1, locationSource: "架空市台帳", locationNote: `試験 ${id}`,
  locationVersion: 1, verificationStatus: "unverified", lastVerifiedAt: null, metadata: {},
});

type Reply = { data: FacilityItem[]; nextCursor?: string };
const responseOf = (r: Reply, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify({ data: r.data, meta: { requestId: "req-1", ...(r.nextCursor ? { nextCursor: r.nextCursor } : {}) } }), {
    status,
    headers: { "content-type": "application/json" },
  });

const URL_OF = (url: string) => url;

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("マップの施設一覧（useFacilities）", () => {
  it("reload_keeps_current_list_while_refreshing_and_swaps_when_complete", async () => {
    // 初回: 2ページ（cursor完走まで部分表示＝既存の docs/05 §5 の挙動）
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = URL_OF(String(input));
        seen.push(url);
        if (url.includes("cursor=")) return responseOf({ data: [item("f2", "cistern")] });
        return responseOf({ data: [item("f1")], nextCursor: "c2" });
      }),
    );
    const { result } = renderHook(() => useFacilities({ bbox: "139.0,35.0,140.1,35.9" }));
    await waitFor(() => expect(result.current.state).toBe("complete"));
    expect(result.current.items.map((f) => f.id)).toEqual(["f1", "f2"]);

    // チップのトグル（種別はクライアント側の表示フィルタ。件数を最新にするためreloadも呼ぶ）:
    // 再取得の応答が返るまでの間も、一覧は空にならず「取得中」にも戻らない（点滅しない）
    let release: (r: Reply) => void = () => {};
    const gate = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseOf(await gate)),
    );
    act(() => result.current.reload());
    expect(result.current.state).toBe("complete"); // 「loading」に戻さない
    expect(result.current.items.map((f) => f.id)).toEqual(["f1", "f2"]); // 空にしない

    // 新しい世代の結果（新しい施設 f3 を含む）が揃ったときだけ差し替わる
    await act(async () => {
      release({ data: [item("f1"), item("f2", "cistern"), item("f3", "box")] });
    });
    await waitFor(() => expect(result.current.items.map((f) => f.id)).toEqual(["f1", "f2", "f3"]));
    expect(result.current.state).toBe("complete");
    expect(seen.length).toBe(2); // 初回の2要求（reload後は差し替え完了で追加のcursorは無い）
  });

  it("reload_failure_keeps_the_last_list_and_shows_error_with_retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => responseOf({ data: [item("f1")] })));
    const { result } = renderHook(() => useFacilities({ bbox: "139.0,35.0,140.1,35.9" }));
    await waitFor(() => expect(result.current.state).toBe("complete"));

    // 再取得の失敗（通信断・500）では、今ある一覧を表示し続ける（NFR-09の縮退。空に戻さない）
    vi.stubGlobal("fetch", vi.fn(async () => responseOf({ data: [] }, 500)));
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.items.map((f) => f.id)).toEqual(["f1"]);
  });

  it("initial_load_still_shows_partial_and_loading", async () => {
    // 初回の読み込みは従来どおり: 「loading」→部分表示（partial。全cursor完走まで）→完走（complete）
    let release: (r: Reply) => void = () => {};
    const gate = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return call === 1 ? responseOf({ data: [item("f1")], nextCursor: "cx" }) : responseOf(await gate);
      }),
    );
    const { result } = renderHook(() => useFacilities({ bbox: "139.0,35.0,140.1,35.9" }));
    expect(result.current.state).toBe("loading");
    expect(result.current.items).toEqual([]);
    await waitFor(() => expect(result.current.state).toBe("partial"));
    expect(result.current.items.map((f) => f.id)).toEqual(["f1"]); // 途中から描画する（docs/05 §5）
    await act(async () => {
      release({ data: [item("f2", "cistern")] });
    });
    await waitFor(() => expect(result.current.state).toBe("complete"));
    expect(result.current.items.map((f) => f.id)).toEqual(["f1", "f2"]);
  });
});

describe("選択シートのEscとフォーカス（PH2-C19）", () => {
  /** マーカー（開く操作）とシートを並べた最小の装置。onCloseでシートを閉じる（MapPageと同じ状態遷移） */
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>消火栓 F1</button>
        {open && (
          <SelectionSheet
            facility={item("f1")}
            onClose={() => setOpen(false)}
            onInspect={() => {}}
            onDetail={() => {}}
            mapsUrl="https://maps.example.test/?q=35.1,139.1"
          />
        )}
      </>
    );
  }

  afterEach(() => {
    cleanup();
  });

  it("sheet_takes_focus_closes_on_escape_and_returns_focus_to_the_marker", async () => {
    render(<Harness />);
    const marker = screen.getByRole("button", { name: "消火栓 F1" });
    marker.focus();
    expect(document.activeElement).toBe(marker);

    // 開く: シートの中（閉じるボタン）へフォーカスが移る（赤: 旧実装はマーカーのまま動かない）
    fireEvent.click(marker);
    const sheet = screen.getByRole("dialog");
    expect(sheet).toBeTruthy();
    const close = screen.getByRole("button", { name: "閉じる" });
    await waitFor(() => expect(document.activeElement).toBe(close));

    // Escで閉じる（赤: 旧実装はEscを拾わずシートが残る）
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // 閉じたら開いた操作（マーカー）へフォーカスが戻る
    await waitFor(() => expect(document.activeElement).toBe(marker));
  });
});
