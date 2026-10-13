import { readFileSync } from "node:fs";
import { useState, type FormEvent } from "react";
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, apiCall, authEvents } from "../src/client/api";
import { FormErrors, errorFor } from "../src/client/components/FormErrors";
import { LeaveConfirm } from "../src/client/components/LeaveConfirm";
import { MutationStatus } from "../src/client/components/MutationStatus";
import { Button, TextField } from "../src/client/components/ui";
import { buildRoutes } from "../src/client/routes";
import { bottomTabs, matchScreen, screens } from "../src/client/screens";
import { useMutation } from "../src/client/useMutation";

const ID = "11111111-1111-4111-8111-111111111111";

// --- fetch スタブ ---
type Reply = { status: number; body?: unknown } | Error;
function stubFetch(...replies: Reply[]) {
  const queue = [...replies];
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
    const r = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (r instanceof Error) throw r;
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const ok = (data: unknown, status = 200): Reply => ({ status, body: { data, meta: { requestId: "req-1" } } });
const fail = (status: number, code: string, details: { field: string; reason: string }[] = []): Reply => ({
  status,
  body: { error: { code, message: "x", details }, meta: { requestId: "req-9" } },
});

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => cleanup());

// --- 保存フォームの見本（API-25 お知らせ作成）。共通部品が実際の画面で使われる形を再現する ---
function SampleForm() {
  const { state, run, saving } = useMutation("API-25");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const issues = state.kind === "invalid" ? state.details : [];
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run({ body: { title, body, audienceMemberIds: [ID] } });
  };
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <LeaveConfirm dirty={(title !== "" || body !== "") && state.kind !== "saved"} />
      <FormErrors issues={issues} labels={{ title: "件名", body: "本文" }} />
      <TextField name="title" label="件名" value={title} onChange={(e) => setTitle(e.target.value)} error={errorFor(issues, "title")} />
      <TextField name="body" label="本文" value={body} onChange={(e) => setBody(e.target.value)} error={errorFor(issues, "body")} />
      <MutationStatus state={state} />
      <Button type="submit" busy={saving}>
        {saving ? "保存しています…" : "保存する"}
      </Button>
    </form>
  );
}

function renderShell(path: string, overrides: Record<string, React.ReactNode> = { "SCR-02": <SampleForm /> }) {
  const router = createMemoryRouter(buildRoutes(overrides), { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

async function fillAndSave(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("件名"), "訓練のお知らせ");
  await user.type(screen.getByLabelText("本文"), "今週末に実施します");
  await user.click(screen.getByRole("button", { name: "保存する" }));
}

describe("client shell (T005)", () => {
  it("accepted_job_and_conflict_are_not_saved_success", async () => {
    const user = userEvent.setup();
    renderShell("/app");

    // 202 受付: 「処理中」。完了ではない
    stubFetch(ok({ id: ID, status: "queued", attempts: 0, errorCode: null, resultRef: null }, 202));
    await fillAndSave(user);
    const acceptedText = (await screen.findByText("処理中です")).closest("[role=status]")!.textContent!;
    let savedSuccessVisible = screen.queryByText("保存しました") !== null;
    expect(acceptedText).toContain("処理中");
    expect(acceptedText).toContain("完了ではありません");
    expect(savedSuccessVisible).toBe(false);

    // 409 競合: 「再確認」。保存されていない
    stubFetch(fail(409, "VERSION_CONFLICT"));
    await user.click(screen.getByRole("button", { name: "保存する" }));
    const conflictText = (await screen.findByText("他の操作で更新されています")).closest("[role=alert]")!.textContent!;
    savedSuccessVisible = screen.queryByText("保存しました") !== null;
    expect(conflictText).toContain("再確認");
    expect(conflictText).toContain("保存されていません");
    expect(savedSuccessVisible).toBe(false);

    // 401: ログインが必要。保存されていない。shellはログインへ誘導するが、入力中の内容があるので黙って捨てず確認する
    stubFetch(fail(401, "UNAUTHENTICATED"));
    await user.click(screen.getByRole("button", { name: "保存する" }));
    expect(await screen.findByText("ログインが必要です")).toBeTruthy();
    expect(screen.queryByText("保存しました")).toBeNull();
    await user.click(await screen.findByRole("button", { name: "保存せずに移動する" }));
    await waitFor(() => expect(screen.queryByRole("heading", { level: 2, name: "ログイン" })).not.toBeNull());
  });

  it("server_validation_error_moves_focus_to_the_first_invalid_field", async () => {
    const user = userEvent.setup();
    renderShell("/app");
    stubFetch(fail(400, "VALIDATION_ERROR", [{ field: "title", reason: "必須です" }, { field: "body", reason: "長すぎます" }]));
    await fillAndSave(user);

    const firstInvalidField = await screen.findByLabelText("件名");
    await waitFor(() => expect(document.activeElement).toBe(firstInvalidField));
    const focusedField = document.activeElement;
    expect(focusedField).toBe(firstInvalidField);
    expect(firstInvalidField.getAttribute("aria-invalid")).toBe("true");
    // 誤りの一覧は欄へのリンク。エラー文は欄に関連付く
    expect(within(screen.getAllByRole("alert")[0]!).getByRole("link", { name: "件名" }).getAttribute("href")).toBe("#field-title");
    expect(firstInvalidField.getAttribute("aria-describedby")).toContain("field-title-error");
    expect(screen.queryByText("保存しました")).toBeNull();
  });

  it("network_failure_and_5xx_mean_unknown_result_and_retry_reuses_the_same_key", async () => {
    const user = userEvent.setup();
    renderShell("/app");
    const fetchMock = stubFetch(new TypeError("Failed to fetch"), ok({ id: ID }, 201));
    await fillAndSave(user);
    expect(await screen.findByText("結果を確認できませんでした")).toBeTruthy();
    expect(screen.queryByText("保存しました")).toBeNull();
    await user.click(screen.getByRole("button", { name: "保存する" })); // 同じ内容でもう一度
    expect(await screen.findByText("保存しました")).toBeTruthy();
    const keys = fetchMock.mock.calls.map((c) => (c[1]!.headers as Record<string, string>)["idempotency-key"]);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]); // 結果不明のあとの再送は同じ鍵（サーバーが二重登録を防ぐ）

    // 5xxも結果不明。内容を変えたら新しい鍵
    cleanup();
    const user2 = userEvent.setup();
    renderShell("/app");
    const f2 = stubFetch(fail(503, "DEPENDENCY_UNAVAILABLE"), ok({ id: ID }, 201));
    await fillAndSave(user2);
    expect(await screen.findByText("結果を確認できませんでした")).toBeTruthy();
    await user2.type(screen.getByLabelText("本文"), "追記");
    await user2.click(screen.getByRole("button", { name: "保存する" }));
    await screen.findByText("保存しました");
    const k2 = f2.mock.calls.map((c) => (c[1]!.headers as Record<string, string>)["idempotency-key"]);
    expect(k2[1]).not.toBe(k2[0]);
  });

  it("double_tap_while_saving_sends_one_request", async () => {
    const user = userEvent.setup();
    renderShell("/app");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ data: { id: ID }, meta: { requestId: "r" } }), { status: 201, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await user.type(screen.getByLabelText("件名"), "a");
    await user.type(screen.getByLabelText("本文"), "b");
    const button = screen.getByRole("button", { name: "保存する" });
    await user.click(button);
    const busy = await screen.findByRole("button", { name: "保存しています…" });
    expect(busy.hasAttribute("disabled")).toBe(true);
    await user.click(busy);
    await user.keyboard("{Enter}");
    release();
    await screen.findByText("保存しました");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("useMutation_ignores_a_second_run_while_the_first_is_in_flight", async () => {
    // ボタンが無効化されない経路（別ボタン・Enter連打・プログラムからの呼び出し）でも二重送信しない
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ data: { id: ID }, meta: { requestId: "r" } }), { status: 201, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useMutation("API-25"));
    const input = { body: { title: "t", body: "b", audienceMemberIds: [ID] } };
    let first!: Promise<unknown>;
    let second!: unknown;
    await act(async () => {
      first = result.current.run(input);
      second = await result.current.run(input); // 1回目の最中に2回目
    });
    expect(second).toBeUndefined();
    release();
    await act(async () => { await first; });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.state.kind).toBe("saved");
  });

  it("keyboard_can_reach_and_operate_the_main_navigation", async () => {
    const user = userEvent.setup();
    const router = renderShell("/app");
    // 最初のTabは「メインコンテンツへ移動」
    await user.tab();
    expect(document.activeElement?.textContent).toBe("メインコンテンツへ移動");
    // 下部ナビに5つの入口（docs/03 §1）
    const bottom = screen.getByTestId("bottom-nav");
    // アイコン(aria-hidden)を除いた「読み上げ時の名前」で5つの入口を確認する
    const names = bottomTabs.map((t) => within(bottom).getByRole("link", { name: t.label }).getAttribute("href"));
    expect(bottomTabs.map((t) => t.label)).toEqual(["ホーム", "マップ", "予定・活動", "AI", "メニュー"]); // prototype navDef
    expect(names).toEqual(["/app", "/app/map", "/app/activities", "/app/assistant", "/app/menu"]);
    expect(within(bottom).getByRole("link", { name: "ホーム" }).getAttribute("aria-current")).toBe("page");
    // キーボードだけで「マップ」へ移動できる
    const map = within(bottom).getByRole("link", { name: "マップ" });
    map.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/app/map"));
    expect(screen.getByRole("heading", { level: 2, name: "マップ" })).toBeTruthy();
    // 画面が変わったら本文へフォーカスが移る
    await waitFor(() => expect(document.activeElement?.id).toBe("main"));
    expect(within(bottom).getByRole("link", { name: "マップ" }).getAttribute("aria-current")).toBe("page");
  });

  it("sub_screens_highlight_their_parent_tab", () => {
    renderShell("/app/facilities/abc");
    const bottom = screen.getAllByRole("navigation", { name: "主要メニュー" }).find((n) => within(n).queryAllByRole("link").length === 5)!;
    expect(within(bottom).getByRole("link", { name: "マップ" }).getAttribute("aria-current")).toBe("page");
    expect(within(bottom).getByRole("link", { name: "ホーム" }).getAttribute("aria-current")).toBeNull();
    // 活動・報告書は「予定・活動」、出動や名簿などその他は「メニュー」、点検登録は下部ナビなしの全画面フロー
    cleanup();
    renderShell("/app/activities/xyz");
    const b2 = screen.getAllByRole("navigation", { name: "主要メニュー" }).find((n) => within(n).queryAllByRole("link").length === 5)!;
    expect(within(b2).getByRole("link", { name: "予定・活動" }).getAttribute("aria-current")).toBe("page");
    cleanup();
    renderShell("/app/members");
    const b3 = screen.getAllByRole("navigation", { name: "主要メニュー" }).find((n) => within(n).queryAllByRole("link").length === 5)!;
    expect(within(b3).getByRole("link", { name: "メニュー" }).getAttribute("aria-current")).toBe("page");
    cleanup();
    renderShell("/app/facilities/abc/inspections/new");
    expect(screen.queryByTestId("bottom-nav")).toBeNull();
  });

  it("menu_tab_is_a_screen_with_profile_tiles_and_a_disabled_logout_until_auth_exists", () => {
    renderShell("/app/menu");
    expect(screen.getByRole("heading", { level: 2, name: "メニュー" })).toBeTruthy();
    // prototype modules の8項目（順序どおり）
    const tiles = screen.getAllByRole("link").filter((l) => l.closest("ul.grid"));
    expect(tiles.slice(0, 8).map((l) => l.textContent?.replace(/^[a-z_0-9]+/, ""))).toEqual([
      "団員名簿", "車両・資機材", "お知らせ", "文書・規程", "出動履歴", "活動分析", "設定・通知", "使い方ガイド",
    ]);
    expect(tiles.find((l) => l.textContent?.includes("団員名簿"))!.getAttribute("href")).toBe("/app/members");
    // docs/03の画面は全て到達できる（prototypeに入口が無かった分は追加タイルで）
    const hrefs = tiles.map((l) => l.getAttribute("href"));
    for (const path of ["/app/issues", "/app/patrol-plans", "/app/ai/reviews", "/app/sync", "/app/admin"]) expect(hrefs).toContain(path);
    expect(screen.getByRole("button", { name: /ログアウト/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText("一般団員").length).toBeGreaterThan(0); // メニューのカードとPCサイドバー
  });

  it("desktop_sidebar_and_header_follow_the_prototype_desktop_structure", () => {
    renderShell("/app/map");
    const side = screen.getAllByRole("navigation", { name: "主要メニュー" }).find((n) => within(n).queryByText("OVERVIEW") !== null)!;
    const text = side.textContent!;
    // 見出しと項目の順序（prototype navGroups）
    const order = ["OVERVIEW", "ダッシュボード", "OPERATIONS", "マップ・水利", "予定・出欠", "活動記録", "点検管理", "お知らせ", "ORGANIZATION", "団員", "車両・資機材", "文書・規程", "活動分析"];
    let at = -1;
    for (const t of order) {
      const idx = text.indexOf(t, at + 1);
      expect(idx, t).toBeGreaterThan(at);
      at = idx;
    }
    expect(within(side).getByRole("link", { name: "マップ・水利" }).getAttribute("aria-current")).toBe("page");
    // 赤枠の出動管理ボタン・利用者ブロック・分団カード
    expect(screen.getByRole("link", { name: "出動管理" }).getAttribute("href")).toBe("/app/incidents");
    expect(screen.getByText("架空 団員")).toBeTruthy();
    expect(screen.getByText("第一分団", { selector: "span.font-bold" })).toBeTruthy();
    // ヘッダー: パンくず＋画面名(PC用の名前)、検索欄(後続まで無効)、AIアシスタント
    expect(screen.getByRole("heading", { level: 1, name: "消防水利・施設マップ" })).toBeTruthy();
    expect(screen.getByText("第一分団 / 運用")).toBeTruthy();
    expect(screen.getByRole("button", { name: /団員・施設・記録を検索/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("link", { name: "AIアシスタント" }).getAttribute("href")).toBe("/app/assistant");
  });

  it("home_has_the_mobile_top_row_with_status_demo_and_notifications", () => {
    renderShell("/app", {});
    expect(screen.getAllByText("DEMO")).toHaveLength(2); // PCサイドバーのロゴ横＋スマホ最上段
    expect(screen.getAllByText("オンライン").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "タスク・通知" })[0]!.getAttribute("href")).toBe("/app/tasks-notifications");
  });

  it("leaving_with_unsaved_changes_asks_first_and_returns_focus", async () => {
    const user = userEvent.setup();
    const router = renderShell("/app");
    await user.type(screen.getByLabelText("件名"), "書きかけ");
    const bottom = screen.getAllByRole("navigation", { name: "主要メニュー" }).find((n) => within(n).queryAllByRole("link").length === 5)!;
    await user.click(within(bottom).getByRole("link", { name: "マップ" }));
    const dialog = await screen.findByRole("dialog", { name: "保存されていない変更があります" });
    expect(router.state.location.pathname).toBe("/app"); // まだ移動しない
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "編集に戻る" })); // 既定は安全側
    await user.click(within(dialog).getByRole("button", { name: "編集に戻る" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(router.state.location.pathname).toBe("/app");
    // 離れると決めた場合は移動する
    await user.click(within(bottom).getByRole("link", { name: "マップ" }));
    await user.click(await screen.findByRole("button", { name: "保存せずに移動する" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/app/map"));
  });

  it("offline_is_shown_with_text_not_only_color", async () => {
    renderShell("/app");
    expect(screen.queryByText(/オフラインです/)).toBeNull();
    window.dispatchEvent(new Event("offline"));
    expect(await screen.findByText(/オフラインです。通信が回復するまで保存できません/)).toBeTruthy();
    window.dispatchEvent(new Event("online"));
    await waitFor(() => expect(screen.queryByText(/オフラインです/)).toBeNull());
  });
});

describe("screen registry (T005)", () => {
  it("registers_all_28_screens_with_the_paths_in_docs_03", () => {
    const doc = readFileSync("docs/03_画面設計・遷移.md", "utf8");
    const rows = [...doc.matchAll(/^\| (SCR-\d{2}) (\/\S*) \|/gm)].map((m) => [m[1], m[2]!.replace(/（.*$/, "")] as const); // 「（PCは別入口…）」の注記は除く
    expect(rows).toHaveLength(28);
    expect(screens).toHaveLength(28);
    for (const [id, path] of rows) {
      expect(screens.find((s) => s.id === id)?.path, id).toBe(path);
    }
  });

  it("fixed_paths_win_over_id_paths", () => {
    expect(matchScreen("/app/facilities/new")?.id).toBe("SCR-05");
    expect(matchScreen("/app/facilities/import")?.id).toBe("SCR-20");
    expect(matchScreen("/app/facilities/abc")?.id).toBe("SCR-04");
    expect(matchScreen("/app/incidents/new")?.id).toBe("SCR-22");
    expect(matchScreen("/app/incidents/xyz")?.id).toBe("SCR-12");
    expect(matchScreen("/app/assets/vehicle/abc/inspection")?.id).toBe("SCR-23");
    expect(matchScreen("/app/assets/vehicle/abc")?.id).toBe("SCR-14");
    expect(matchScreen("/app/nothing")).toBeUndefined();
    expect(matchScreen("/app/incidents/xyz/extra")).toBeUndefined();
  });

  it("every_screen_renders_a_visible_not_implemented_placeholder", () => {
    const concrete = (p: string) => p.replace(/:type/g, "vehicle").replace(/:id/g, "abc");
    for (const sc of screens.filter((s) => s.id !== "SCR-01")) {
      const router = createMemoryRouter(buildRoutes(), { initialEntries: [concrete(sc.path)] });
      const { unmount } = render(<RouterProvider router={router} />);
      expect(screen.getByRole("heading", { level: 2, name: sc.title }), sc.id).toBeTruthy();
      expect(screen.getByText("未実装"), sc.id).toBeTruthy();
      expect(screen.getByText(new RegExp(sc.ownerTask)), sc.id).toBeTruthy();
      unmount();
    }
    // シェルの画面（メニュー/使い方ガイド）とPCの別入口 /app/reports
    expect(matchScreen("/app/menu")?.id).toBe("SHELL-MENU");
    expect(matchScreen("/app/help")?.id).toBe("SHELL-HELP");
    expect(matchScreen("/app/reports")?.id).toBe("SCR-19");
    expect(matchScreen("/app/reports/abc/draft")?.id).toBe("SCR-19");
  });
});

describe("api client (T005)", () => {
  it("builds_the_url_from_the_contract_and_sends_idempotency_key_only_for_writes", async () => {
    const f = stubFetch(ok({ id: ID, status: "queued", attempts: 0, errorCode: null, resultRef: null }));
    await api("API-86", { params: { id: ID } });
    expect(f.mock.calls[0]![0]).toBe(`/api/v1/jobs/${ID}`);
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>)["idempotency-key"]).toBeUndefined();
    expect(f.mock.calls[0]![1]!.credentials).toBe("same-origin");

    stubFetch(ok({}, 200));
    const g = stubFetch(ok({}, 200));
    await apiCall("API-40", { params: { id: ID }, body: { version: 2, reason: "雨天のため" } }, { idempotencyKey: "key-123" });
    expect((g.mock.calls[0]![1]!.headers as Record<string, string>)["idempotency-key"]).toBe("key-123");
    expect(g.mock.calls[0]![0]).toBe(`/api/v1/activities/${ID}/cancellation`);
    expect(JSON.parse(g.mock.calls[0]![1]!.body as string)).toEqual({ version: 2, reason: "雨天のため" });
  });

  it("invalid_input_is_rejected_before_any_network_call", async () => {
    const f = stubFetch(ok({}));
    const err = await apiCall("API-40", { params: { id: ID }, body: { reason: "x" } as never }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(err.details.map((d: { field: string }) => d.field)).toContain("version");
    expect(f).not.toHaveBeenCalled();
  });

  it("errors_carry_status_code_details_and_request_id_and_401_notifies_the_shell", async () => {
    const seen = vi.fn();
    authEvents.addEventListener("unauthenticated", seen);
    stubFetch(fail(401, "UNAUTHENTICATED"));
    const e1 = await api("API-01", {}).catch((e) => e);
    expect(e1).toMatchObject({ status: 401, code: "UNAUTHENTICATED", requestId: "req-9" });
    expect(seen).toHaveBeenCalledTimes(1);
    authEvents.removeEventListener("unauthenticated", seen);

    stubFetch(fail(409, "VERSION_CONFLICT", [{ field: "version", reason: "旧版" }]));
    const e2 = await apiCall("API-40", { params: { id: ID }, body: { version: 1, reason: "r" } }).catch((e) => e);
    expect(e2).toMatchObject({ status: 409, code: "VERSION_CONFLICT", details: [{ field: "version", reason: "旧版" }] });
  });

  it("unreadable_response_to_a_write_is_unknown_but_to_a_read_is_a_plain_error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>gateway</html>", { status: 200 })));
    const w = await apiCall("API-40", { params: { id: ID }, body: { version: 1, reason: "r" } }).catch((e) => e);
    expect(w).toMatchObject({ code: "RESPONSE_UNKNOWN" });
    const r = await api("API-01", {}).catch((e) => e);
    expect(r).toMatchObject({ code: "BAD_RESPONSE" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await api("API-01", {}).catch((e) => e)).toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });

  it("204_has_no_body_and_abort_is_not_converted_to_an_api_error", async () => {
    stubFetch({ status: 204 });
    const res = await apiCall("API-85", { params: { id: ID }, body: { version: 1, reason: "r" } });
    expect(res).toMatchObject({ status: 204, data: undefined });
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("aborted", "AbortError"); }));
    controller.abort();
    await expect(api("API-01", {}, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
