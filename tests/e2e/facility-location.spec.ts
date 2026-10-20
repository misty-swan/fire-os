import { expect, test } from "@playwright/test";
import { BASE } from "./helpers";

/**
 * 施設の登録・詳細・位置（T022、SCR-04/05）。
 * GPSの拒否時は手入力で完走し、常時の追跡（watchPosition）やRoutes APIを呼ばない（docs/03 §4、MAP-09）。
 */
// Chromiumのモバイルエミュレーションは操作のたびに window.innerWidth を広げることがあり、
// 合成入力の座標がずれて押せなくなる。画面幅の確認は360pxのまま行うため、入力方式をデスクトップに合わせる。
test.use({ isMobile: false, hasTouch: false });
const isPhone = (viewport: { width: number } | null) => (viewport?.width ?? 0) < 1024;
const LAT = "35.123456";
const LNG = "139.123456";

test("gps_denial_allows_manual_entry_without_tracking", async ({ page, context }, info) => {
  // 位置情報は拒否されている（grantPermissionsをしない）。watchPositionは一度も呼ばれないこと
  await context.addInitScript(() => {
    const calls = { watch: 0, getCurrent: 0 };
    const geo = navigator.geolocation;
    Object.defineProperty(navigator, "__geoCalls", { get: () => calls });
    Object.defineProperty(navigator, "geolocation", {
      value: {
        watchPosition: () => { calls.watch++; throw new Error("watchPosition must not be used"); },
        getCurrentPosition: (ok: (p: GeolocationPosition) => void, err: (e: GeolocationPositionError) => void) => {
          calls.getCurrent++;
          err({ PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, code: 1, message: "denied" } as GeolocationPositionError);
        },
        clearWatch: () => {},
      } as Geolocation,
    });
  });
  let routesApiCalls = 0;
  await context.route(/maps\.googleapis\.com|maps\.google\.com\/maps\/api\/directions/, (route) => {
    routesApiCalls++;
    return route.abort();
  });

  const tag = crypto.randomUUID().slice(0, 6);
  await page.goto("/app/facilities/new");
  await page.getByRole("button", { name: "消火栓" }).click();
  await page.getByLabel("管理番号（識別名どちらか必須）").fill(`E2E-LOC-${tag}`);
  await page.getByRole("button", { name: /GPS/ }).click();
  // 拒否されたら手入力へ落ちる（docs/03 §4）
  await expect(page.getByText(/位置情報を使えませんでした/)).toBeVisible();
  await page.getByLabel("緯度").fill(LAT);
  await page.getByLabel("経度").fill(LNG);
  await page.getByLabel("位置の出典").fill("現地測量");
  await page.getByLabel("目印・場所のメモ").fill("試験用の交差点北西");
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/facilities/[0-9a-f-]{36}$`), { timeout: 10_000 });

  // watchPositionは不使用。Routes API（経路の自動取得）も呼ばない
  const watchPositionCalls = await page.evaluate(() => (navigator as unknown as { __geoCalls: { watch: number } }).__geoCalls.watch);
  expect(watchPositionCalls).toBe(0);
  expect(routesApiCalls).toBe(0);

  // 詳細: 位置確認（点検結果と混同しない表示）・座標・外部経路
  await expect(page.getByLabel("位置確認")).toBeVisible();
  await expect(page.getByText("位置：未確認")).toBeVisible();
  await expect(page.getByText(`${LAT}, ${LNG}`, { exact: true })).toBeVisible();
  // 外部経路は送る座標を明示してMaps URLを開く（api=1、destination=座標）。
  // hrefは押す前に待って検査する（旧来の`querySelector('a[aria-label*=…]')!.href`フォールバックは
  // このリンクがaria-labelを持たず（名前は本文から）、popupを取り逃したときnull参照で落ちていた＝FLAKE-2b）
  const mapsLink = page.getByRole("link", { name: /Googleマップで経路を開く/ });
  await expect(mapsLink).toHaveAttribute("target", "_blank"); // 別タブで開く（開く操作そのものは下で実際に走らせる）
  const href = await mapsLink.getAttribute("href");
  expect(new URL(href!, BASE).searchParams.get("destination")).toBe(`${LAT},${LNG}`);
  expect(new URL(href!).searchParams.get("api")).toBe("1");
  const popupPromise = page.waitForEvent("popup", { timeout: 15_000 });
  await mapsLink.click();
  const popup = await popupPromise;
  // popup.url()は作成直後の_pending_ URL（遷移先）を読む。完了待ち（waitForURL）は外部網の届かない環境で
  // 永遠に確定しないため使わない（押す前のhref検査でURLの組み立ては確定済み）
  expect(new URL(popup.url()).searchParams.get("destination")).toBe(`${LAT},${LNG}`); // 開いた先も同じ座標
  await popup.close();

  // 座標を変えると位置確認が失効する（docs/11）: 編集UI（API-13）から座標を変え、詳細の表示が切り替わることを確認
  const id = new URL(page.url()).pathname.split("/").pop()!;
  await page.getByRole("link", { name: "編集" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/facilities/${id}/edit$`));
  // 編集画面には「座標・出典を変えると確認が失効する」注記が出る
  await expect(page.getByText(/位置確認は失効/)).toBeVisible();
  await page.getByLabel("緯度").fill("35.5");
  await page.getByLabel("経度").fill("139.5");
  await page.getByLabel("位置の出典").fill("現地測量");
  await page.getByLabel("目印・場所のメモ").fill("位置を修正した");
  await page.getByRole("button", { name: "変更を保存" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/facilities/${id}$`), { timeout: 15_000 });
  await expect(page.getByText("位置：未確認")).toBeVisible(); // 旧確認は失効済み
  await expect(page.getByText(/座標v2/)).toBeVisible(); // 履歴に新しい版が残る
  void isPhone;
  void info;
});
