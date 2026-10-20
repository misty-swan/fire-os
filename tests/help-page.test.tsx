import { cleanup, render, screen, within } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { buildRoutes } from "../src/client/routes";

/**
 * 使い方ガイド（T086・SHELL-HELP /app/help）。
 * docs/USER_GUIDE.md と同じ章立て（導入/通常利用/点検/通知/承認/通信断/復旧＋困ったとき）の要点が
 * プレースホルダー（ScreenPlaceholder の「未実装」チップ）の代わりに出ることを確認する。
 * 旧実装（プレースホルダー）には章の見出しも本文も無いため、この試験は赤→緑の対象。
 */

const ID = "11111111-1111-4111-8111-111111111111";
/** API-01 の応答の代わり（認証済みの団員）。MeGate の取得を省いてシェルを描く */
const TEST_ME = {
  profile: { memberId: ID, displayName: "架空 団員", rank: "団員" },
  unitId: ID,
  unitName: "架空市 第一分団",
  roles: ["member" as const],
  authzVersion: 1,
  policyVersion: "test",
  mfaEnabled: false,
  mfaRequired: false,
};

/** USER_GUIDE.md の章立てと同じ8章（順序も文書どおり: 点検→通知→承認） */
const CHAPTERS = [
  "導入（はじめて使うとき）",
  "通常利用（ホーム・出欠・名簿・お知らせ）",
  "点検（施設・資機材・異常・訂正）",
  "通知（受け取る・送る）",
  "承認（AIの提案・帳票）",
  "通信断（圏外・つながらないとき）",
  "復旧（通信が戻った・競合したとき）",
  "困ったとき",
];

function renderHelp() {
  const router = createMemoryRouter(buildRoutes({}, { me: TEST_ME }), { initialEntries: ["/app/help"] });
  render(<RouterProvider router={router} />);
  return router;
}

afterEach(() => cleanup());

describe("help screen (T086)", () => {
  it("user_guide_chapters_appear_as_headings", () => {
    renderHelp();
    // 画面の見出し（スマホ本文側のh2。PCはヘッダーがh1を持つため 本文のh2 は lg で隠れるが jsdom では両方出る）
    expect(screen.getByRole("heading", { level: 2, name: "使い方ガイド" })).toBeTruthy();
    // USER_GUIDEと同じ章立ての見出しがすべて出る（旧プレースホルダーには1つも無い＝赤になる断言）
    for (const name of CHAPTERS) {
      expect(screen.getByRole("heading", { level: 3, name }), name).toBeTruthy();
    }
  });

  it("placeholder_is_replaced_by_numbered_steps_and_answers", () => {
    renderHelp();
    // プレースホルダーの「未実装」チップと T086 告知文は出ない（実内容に置き換わった）
    expect(screen.queryByText("未実装")).toBeNull();
    expect(screen.queryByText(/この画面は.*で実装します/)).toBeNull();
    // はじめに載せる3原則（USER_GUIDE と同じ語彙）
    expect(screen.getByText(/正式な指令・連絡は/)).toBeTruthy();
    expect(screen.getByText(/AIが決めることはありません/)).toBeTruthy();
    // 各章は短い番号付きステップ（ol）。困ったときは状況→対処の並び
    for (const name of CHAPTERS.filter((c) => c !== "困ったとき")) {
      const heading = screen.getByRole("heading", { level: 3, name });
      const section = heading.closest("section")!;
      expect(section, name).toBeTruthy();
      const steps = within(section).getAllByRole("listitem");
      expect(steps.length, name).toBeGreaterThanOrEqual(2);
      expect(steps.length, `${name} は要約に収める`).toBeLessThanOrEqual(4);
    }
    const trouble = screen.getByRole("heading", { level: 3, name: "困ったとき" }).closest("section")!;
    expect(within(trouble).getByText(/招待のリンク/)).toBeTruthy();
    expect(within(trouble).getByText(/再発行/)).toBeTruthy();
    // 全文は操作説明書への誘導が出る（画面文面に内部文書名〔USER_GUIDE〕は出さない＝PH7と同じ方針）
    expect(screen.getByText(/操作説明書/)).toBeTruthy();
    expect(screen.queryByText(/USER_GUIDE/)).toBeNull();
  });
});
