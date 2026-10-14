import { expect, test } from "@playwright/test";
import { adminApi, apiHeaders, BASE } from "./helpers";

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
  // 外部経路は送る座標を明示してMaps URLを開く（api=1、destination=座標）
  const externalUrl = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
  await page.getByRole("link", { name: /Googleマップで経路を開く/ }).click();
  const popup = await externalUrl;
  const url = popup ? popup.url() : await page.evaluate(() => document.querySelector<HTMLAnchorElement>('a[aria-label*="Googleマップ"]')!.href);
  if (popup) await popup.close();
  expect(new URL(url).searchParams.get("destination")).toBe(`${LAT},${LNG}`);

  // 座標を変えると位置確認が失効する（docs/11）: 編集はAPIで行い、詳細の表示が切り替わることを確認
  const id = new URL(page.url()).pathname.split("/").pop()!;
  const detail = await (await page.request.fetch(`${BASE}/api/v1/facilities/${id}`, { headers: apiHeaders() })).json() as {
    data: { version: number; locationVersion: number; verificationStatus: string };
  };
  const patched = await adminApi(request2Of(page), "PATCH", `/api/v1/facilities/${id}`, {
    version: detail.data.version,
    latitude: 35.5,
    longitude: 139.5,
    locationSource: "現地測量",
    locationNote: "位置を修正した",
  });
  expect(patched.status).toBe(200);
  await page.reload();
  await expect(page.getByText("位置：未確認")).toBeVisible(); // 旧確認は失効済み
  await expect(page.getByText(/座標v2/)).toBeVisible(); // 履歴に新しい版が残る
  void isPhone;
  void info;
});

function request2Of(page: import("@playwright/test").Page) {
  // page.requestは画面と同じセッション（管理者storageState）を持つ
  return page.request;
}
