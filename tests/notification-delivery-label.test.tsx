import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { SenderNotificationDetail } from "../src/client/features/notifications/NotificationApproval";
import type { NotificationDto } from "../src/shared/contracts/content";

/**
 * 配送結果の終端表示（T084レビュー裁定R10。docs/16 Review Focus 5「保存/送信/到達/既読を混同しない」）。
 * 到達不明または失敗の宛先が1人以上あるとき、終端の札（ヘッダーの状態ラベルと配送結果のチップ）を
 * 緑（ok）・check_circleにしない。attentionトーンで「到達不明あり・要確認」等を併記する（docs/03 意図変更26）。
 * 全員が受付済みのときは従来どおり緑のまま（過剰に警告しない）。
 */

function stubFetch() {
  // useMemberNames（API-02）だけが呼ばれる。氏名は1人分返す
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "m-1", displayName: "架空 団員" }], meta: { requestId: "r" } }), { status: 200, headers: { "content-type": "application/json" } })));
}

const notification = (statuses: (string | null)[], status: NotificationDto["status"] = "finished"): NotificationDto => ({
  id: "00000000-0000-4000-8000-000000000001",
  version: 3,
  status,
  sourceType: "activity",
  sourceId: "00000000-0000-4000-8000-000000000002",
  body: "架空の出欠確認",
  bodyHash: "a".repeat(64),
  audienceHash: "b".repeat(64),
  channels: ["inapp"],
  expiresAt: null,
  approvedAt: "2026-10-19T00:00:00.000Z",
  audienceMemberIds: statuses.map((_, i) => `m-${i + 1}`),
  recipients: statuses.map((s, i) => ({ memberId: `m-${i + 1}`, channel: "inapp", addressRef: `member:m-${i + 1}#inbox`, readAt: "2026-10-19T01:00:00.000Z", deliveryStatus: s as never })),
  deliveryJob: null,
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
});

const renderDetail = (n: NotificationDto) =>
  render(
    <MemoryRouter>
      <SenderNotificationDetail initial={n} />
    </MemoryRouter>,
  );

/** 札（Chip）の要素。トーンはクラス（text-ok / text-attention）で見る */
const chipOf = (text: RegExp) => screen.getAllByText(text).map((el) => el.closest("span.rounded-pill") ?? el);

beforeEach(() => stubFetch());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("配送結果の終端表示 (T084 R10)", () => {
  it("finished_with_unknown_recipient_is_not_shown_as_green_done", () => {
    renderDetail(notification(["provider_accepted", "unknown"]));
    // 配送結果のチップ: 「要確認」を併記し、緑・check_circleにしない
    const resultChips = chipOf(/配送の処理を終えました/);
    expect(resultChips).toHaveLength(1);
    expect(resultChips[0]!.textContent).toMatch(/到達不明あり・要確認/);
    expect(resultChips[0]!.className).toMatch(/text-attention/);
    expect(resultChips[0]!.className).not.toMatch(/text-ok/);
    expect(resultChips[0]!.textContent).not.toMatch(/check_circle/);
    // ヘッダーの状態ラベルも同じ扱い
    const header = chipOf(/配送処理済み/);
    expect(header[0]!.textContent).toMatch(/要確認/);
    expect(header[0]!.className).toMatch(/text-attention/);
  });

  it("finished_with_failed_recipient_is_not_shown_as_green_done", () => {
    renderDetail(notification(["provider_accepted", "failed"]));
    const resultChips = chipOf(/配送の処理を終えました/);
    expect(resultChips[0]!.textContent).toMatch(/失敗あり・要確認/);
    expect(resultChips[0]!.className).toMatch(/text-attention/);
  });

  it("finished_with_all_accepted_stays_green", () => {
    renderDetail(notification(["provider_accepted", "provider_accepted"]));
    const resultChips = chipOf(/配送の処理を終えました/);
    expect(resultChips[0]!.textContent).not.toMatch(/要確認/);
    expect(resultChips[0]!.className).toMatch(/text-ok/);
    expect(chipOf(/配送処理済み/)[0]!.className).toMatch(/text-ok/);
  });
});
