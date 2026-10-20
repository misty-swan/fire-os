import { expect, test, type Page } from "@playwright/test";
import { isPhone } from "./helpers";

/**
 * PWA shell・キャッシュ除外・更新案内（T074、docs/07 §4・D14・CT-10）。
 *
 * Service Workerがcacheするのは静的shellだけ:
 *  - /api/* の応答（認証・名簿・RAG回答・添付本文を含む）をcacheしない
 *  - Google（fonts.googleapis.com / fonts.gstatic.com / maps.googleapis.com 等）の資産をcacheしない
 *  - offlineでもshellは起動する。取得できないデータは偽装せず、画面が正直に失敗を示す（docs/03）
 *  - 新しい版は勝手に適用しない。案内の「更新」でも再読込しない＝未保存の入力を消さない
 *
 * 更新版の試験は、wrangler devの生成物（dist/client）を書き換えるとworkerの再読み込みが起きて
 * 他の試験と衝突するため、Playwrightのrouteで sw.js への応答だけにバイト差分を作る（diskは汚さない）。
 */

/** SWが登録・起動済みで、このページを制御しているまで待つ（未実装ならここが赤になる） */
async function expectSwControls(page: Page): Promise<void> {
  await expect(async () => {
    const controlled = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg?.active?.state === "activated" && navigator.serviceWorker.controller != null;
    });
    expect(controlled, "Service Workerが登録・起動しページを制御していること（T074の実装）").toBe(true);
  }).toPass({ timeout: 15_000 });
}

/** CacheStorageに載っている全URLを列挙する（SWの作ったcache以外が混ざればそれも赤で分かる） */
function collectCacheUrls(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) urls.push(request.url);
    }
    return urls;
  });
}

// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("offline_cache_contains_no_api_response_or_google_tiles", async ({ page }) => {
  const phone = isPhone(page.viewportSize());
  const heading = (h2: string, h1: string) => (phone ? { level: 2 as const, name: h2 } : { level: 1 as const, name: h1 });

  // --- ログイン済みで主要画面を開き、SWの下でAPI・資産リクエストを実際に通す ---
  await page.goto("/app");
  await expect(page.getByRole("heading", heading("ホーム", "ダッシュボード"))).toBeVisible();
  await expectSwControls(page);

  // 名簿(機微)・マップ(施設/地図)・AIアシスタント(RAG)・お知らせ(添付写真の画面)を開く。
  // データが空でもよい。試験の対象は「SWが何をcacheするか」であって、データの有無ではない
  await page.goto("/app/members");
  await expect(page.getByRole("heading", heading("団員名簿", "団員"))).toBeVisible();
  await page.goto("/app/map");
  await expect(page.getByRole("heading", heading("マップ", "消防水利・施設マップ"))).toBeVisible();
  await page.goto("/app/assistant");
  await expect(page.getByRole("heading", heading("AIアシスタント", "AIアシスタント"))).toBeVisible();
  await page.goto("/app/announcements");
  await expect(page.getByRole("heading", heading("お知らせ", "お知らせ"))).toBeVisible();

  // --- offline化して再読込: shellだけが起動する ---
  await page.context().setOffline(true);
  await page.reload();
  // APIは取れないので、アプリは「利用者情報を取得できない」と正直に失敗を示す（shell起動の証拠でもある）
  await expect(page.getByText("利用者情報を取得できません")).toBeVisible({ timeout: 15_000 });

  // --- cacheの中身を全部列挙して、機微・外部資産が無いことを確かめる ---
  const urls = await collectCacheUrls(page);
  const cachedApiUrls = urls.filter((u) => new URL(u).pathname.startsWith("/api/"));
  const cachedGoogleUrls = urls.filter((u) => /(^|\.)(googleapis|gstatic|google)\.com$/.test(new URL(u).hostname));
  const cachedAttachmentUrls = urls.filter((u) => u.includes("/attachments/"));
  expect(cachedApiUrls).toEqual([]);
  expect(cachedGoogleUrls).toEqual([]);
  expect(cachedAttachmentUrls).toEqual([]);

  const offlineShellAvailable = await page.evaluate(
    () => (document.querySelector("#root")?.children.length ?? 0) > 0 && navigator.serviceWorker.controller != null,
  );
  expect(offlineShellAvailable).toBe(true);

  await page.context().setOffline(false);
});

// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("sw_update_notifies_and_does_not_destroy_unsaved_input", async ({ page, context }) => {
  // 「新しい版」を作る。dist/clientを書き換えるとwrangler devがworkerごと再読み込みし、直後の
  // 他の試験の要求が「Your worker is reloading」に当たる。またsw.jsのupdate()での再取得は
  // ブラウザ本体から発行されるためPlaywrightのrouteで差し替えられない。
  // そこで**同じscopeへの別URL登録**を使う: script URLが違うとブラウザは版が違うものとして
  // install→待機に入れる（本番どおり「待機→案内→更新→引き継ぎ」の経路をそのまま通る）。
  // 応答はrouteで差し替えるだけなのでdiskは汚さない
  const original = await (await page.request.get("/sw.js")).text();
  const updated = `${original}\n// pwa update probe (e2e)\n`;
  try {
    await page.goto("/app");
    await expectSwControls(page);

    // 未保存の入力を作る（保存はしない）
    await page.goto("/app/facilities/new");
    const field = page.getByLabel("管理番号（識別名どちらか必須）");
    await field.fill("T074-未保存の入力");

    await context.route("**/sw-update-probe.js", (route) => route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: updated }));
    await expect(async () => {
      await page.evaluate(() => void navigator.serviceWorker.register("/sw-update-probe.js", { scope: "/" }).catch(() => undefined));
      const waiting = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting != null);
      expect(waiting).toBe(true);
    }).toPass({ timeout: 20_000 });

    // 勝手には適用しない。案内が出る
    await expect(page.getByTestId("pwa-update-notice").getByText("新しい版があります")).toBeVisible();

    // 「更新」を押しても再読込しない＝未保存の入力は消えない（次回の起動から新しい版）。
    // 入力が残っていること自体が「再読込していない」証拠になる（再読込すれば内容は消える）
    await page.getByRole("button", { name: "更新" }).click();
    await expect(page.getByTestId("pwa-update-notice").getByText("更新しました")).toBeVisible();
    await expect(field).toHaveValue("T074-未保存の入力");
  } finally {
    // 差し替えを外す（このcontext内の話なので他の試験への影響は無いが、掃除はしておく）
    await context.unroute("**/sw-update-probe.js").catch(() => undefined);
  }
});
