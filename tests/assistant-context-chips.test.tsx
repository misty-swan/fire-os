import { cleanup, render, screen } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetPendingKeysForTest } from "../src/client/useMutation";
import { AssistantPage } from "../src/client/features/assistant/AssistantPage";

/**
 * AIアシスタントの「記録を添える」チップ（T085レビューA-I4/D5の回帰）。
 * 確認待ちの異常が6件以上あるとき、いちばん新しく報告された異常がチップに出ること。
 * 旧実装はAPI-15を作成の古い順で先頭5件だけ取り、新しい異常を添えられなかった（フル走行のassistant.specで発見）。
 * サーバーの並び（order=newest）はtests/inspections-issues.test.tsで検査し、ここでは画面がその並びを要求することを確かめる。
 */
const issues = Array.from({ length: 7 }, (_, n) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`, title: `確認待ちの異常 ${n}`, status: "reported",
  createdAt: `2026-10-19T0${n}:00:00.000Z`,
}));

beforeEach(() => {
  vi.unstubAllGlobals();
  _resetPendingKeysForTest();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AssistantPage 記録を添える (T085 D5)", () => {
  it("newest_reported_issue_is_offered_when_more_than_five_are_waiting", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      const u = new URL(url, "http://localhost");
      let data: unknown = [];
      if (u.pathname === "/api/v1/issues") {
        // サーバーと同じ並び: order=newestなら新しい順、既定は古い順。limitで切る
        const sorted = u.searchParams.get("order") === "newest" ? [...issues].reverse() : issues;
        data = sorted.slice(0, Number(u.searchParams.get("limit") ?? 50));
      }
      return new Response(JSON.stringify({ data, meta: { requestId: "req-1" } }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    render(<RouterProvider router={createMemoryRouter([{ path: "/app/assistant", element: <AssistantPage /> }], { initialEntries: ["/app/assistant"] })} />);
    expect(await screen.findByRole("button", { name: /確認待ちの異常 6/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /確認待ちの異常 0/ })).toBeNull();
    expect(urls.filter((x) => x.startsWith("/api/v1/issues")).every((x) => x.includes("order=newest"))).toBe(true);
  });
});
