import { expect, test } from "@playwright/test";
import { adminApi, BASE, apiHeaders } from "./helpers";

/**
 * マップ（T021、SCR-03）。地図/一覧切替・種別チップ・選択シート・全件取得の世代管理。
 * 期待は prototype（FireOS Prototype マップ / Desktop Map）の構成・文言。
 */
const isPhone = (viewport: { width: number } | null) => (viewport?.width ?? 0) < 1024;

test.beforeEach(async ({ request }) => {
  // 種別の異なる施設を3件（API-11。管理番号は試験ごとに一意）。座標も実行ごとにずらす
  // （D1は1実行中に共有されるため、同じ座標のマーカーが重なって押せなくならないようにする）
  const tag = crypto.randomUUID().slice(0, 6);
  const jitter = [...tag].reduce((n, c) => n + c.charCodeAt(0), 0) % 30;
  const facilities = [
    { type: "hydrant", managementNumber: `E2E-H-${tag}`, latitude: 35.05 + jitter * 0.01, longitude: 139.05 + jitter * 0.012 },
    { type: "hydrant", managementNumber: `E2E-H2-${tag}`, latitude: 35.55 + jitter * 0.01, longitude: 139.25 + jitter * 0.012 },
    { type: "cistern", managementNumber: `E2E-S-${tag}`, latitude: 35.3 + jitter * 0.01, longitude: 139.65 + jitter * 0.012 },
  ] as const;
  for (const f of facilities) {
    const res = await adminApi(request, "POST", "/api/v1/facilities", {
      ...f, locationSource: "架空市台帳", locationNote: `試験用の施設 ${f.managementNumber}`,
    });
    if (res.status !== 201) throw new Error(`facility seed failed: ${JSON.stringify(res.data)}`);
  }
  (test as unknown as { tag: string }).tag = tag;
});

async function seedOf(page: import("@playwright/test").Page): Promise<{ hydrant: string[]; cistern: string[] }> {
  const res = await page.request.fetch(`${BASE}/api/v1/facilities?limit=200`, { headers: apiHeaders() });
  const body = (await res.json()) as { data: { id: string; type: string; managementNumber: string }[] };
  const tag = (test as unknown as { tag: string }).tag;
  const mine = body.data.filter((f) => f.managementNumber.includes(tag));
  return {
    hydrant: mine.filter((f) => f.type === "hydrant").map((f) => f.managementNumber),
    cistern: mine.filter((f) => f.type === "cistern").map((f) => f.managementNumber),
  };
}

test("old_map_response_cannot_replace_new_viewport", async ({ page }) => {
  const seed = await seedOf(page);
  // 最初の読み込み（旧世代）を遅らせ、その応答には条件外の「消えたはずの施設」を混ぜる。
  // 条件を変えた後の新しい世代の応答で表示が置き換わり、遅れて届いた旧応答は破棄される（docs/05 §5）
  let firstLoad = true;
  // 遅延した旧世代の応答は、試験の終了前に処理を終わらせる（次の試験に遅延を残さない）
  let settleOldGeneration: () => void = () => {};
  const oldGenerationSettled = new Promise<void>((resolve) => { settleOldGeneration = resolve; });
  await page.route("**/api/v1/facilities?*", async (route) => {
    if (firstLoad) {
      firstLoad = false;
      await new Promise((r) => setTimeout(r, 2000)); // 旧世代を遅らせる
      const res = await route.fetch();
      const json = (await res.json()) as { data: { id: string; type: string; managementNumber: string }[] };
      // 種別は絞り込み後も見える「防火水槽」にする（消火栓はクライアント側の絞り込みで隠れるため、
      // 世代の破棄が壊れても検出できない。docs/16の「旧応答で置き換わらない」を確かめる対象）
      json.data = [...json.data, { id: crypto.randomUUID(), type: "cistern", managementNumber: "OLDGEN-STALE" }];
      // bodyを差し替えるので、元の応答のcontent-lengthを引きずらない（待ち続けて固まるため）
      await route.fulfill({ status: res.status(), headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
      settleOldGeneration();
      return;
    }
    return route.continue();
  });

  await page.goto("/app/map");
  // 完走までは「取得中」を表示する
  await expect(page.getByText("施設一覧を取得中…")).toBeVisible();
  const labelBeforeFinalPage = await page.locator("body").textContent();

  // 条件を変える（消火栓チップをOFF）→ 新しい世代の要求が走り、こちらが先に採用される
  await page.getByRole("button", { name: /^消火栓 [0-9]/ }).click();

  // 絞り込み後は防火水槽だけ。遅延した旧応答（OLDGEN-STALE=防火水槽を含む）で置き換わらない。
  // マーカー（スマホ）はaria-labelに種別+番号、PCの右パネルの行は名前テキストを持つ
  if (isPhone(page.viewportSize())) {
    await expect(page.getByRole("button", { name: `防火水槽 ${seed.cistern[0]}` })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: `消火栓 ${seed.hydrant[0]}` })).toHaveCount(0);
  } else {
    await expect(page.getByText(`防火水槽 ${seed.cistern[0]}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(`消火栓 ${seed.hydrant[0]}`)).toBeHidden();
  }
  // 旧世代の応答に混ぜた施設（防火水槽。絞り込み後も見えるはずの種別）が表示されない＝旧応答は破棄されている
  await expect(page.getByRole("button", { name: `防火水槽 OLDGEN-STALE` })).toHaveCount(0);
  const visibleIds = await page
    .locator("body")
    .textContent()
    .then((t) => seed.cistern.filter((id) => t!.includes(id)));
  expect(visibleIds).toEqual(seed.cistern);
  expect(labelBeforeFinalPage).toBeTruthy();

  // 地図のマーカーと一覧が同じ結果を操作できる（PCは一覧が常設。スマホは切替で確認する）
  if (isPhone(page.viewportSize())) {
    await page.getByRole("button", { name: "一覧" }).click();
    for (const id of seed.cistern) {
      await expect(page.getByRole("button", { name: `防火水槽 ${id}` })).toBeVisible();
    }
  } else {
    await expect(page.getByText("施設一覧")).toBeVisible();
  }
  // 遅延していた旧世代の応答が破棄されるまで待ってから終わる（次の試験にエラーを残さない）
  await oldGenerationSettled;
});

test("map_selection_sheet_matches_prototype_and_opens_detail", async ({ page }) => {
  test.setTimeout(45_000); // 全体試験では負荷が上がるため（1件は数秒で終わる）
  const seed = await seedOf(page);
  await page.goto("/app/map");
  // 実行ごとに同じ座標の施設が増えるため、PCは右パネルの一覧の最後の行（この実行の施設）から選ぶ
  const target = page.getByRole("button", { name: `消火栓 ${seed.hydrant[0]}` });
  await expect(target.first()).toBeVisible({ timeout: 10_000 });
  await (isPhone(page.viewportSize()) ? target : target.last()).click();

  if (isPhone(page.viewportSize())) {
    // 選択シート: 種別・番号・状態3列・点検する/詳細/経路（prototype の構成）
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("位置確認")).toBeVisible();
    await expect(sheet.getByText("未確認")).toBeVisible();
    await expect(sheet.getByRole("button", { name: /点検する/ })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "詳細" })).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Googleマップで経路を開く" })).toBeVisible();
    // 閉じると消える
    await sheet.getByRole("button", { name: "閉じる" }).click();
    await expect(sheet).toBeHidden();
  } else {
    // PCは右パネルに詳細（一覧に戻れる）
    await expect(page.getByText("座標（外部マップへ送る値）")).toBeVisible();
    await expect(page.getByRole("button", { name: /この施設を点検する/ })).toBeVisible();
    await page.getByRole("button", { name: "一覧に戻る" }).click();
    await expect(page.getByText("施設一覧")).toBeVisible();
  }
});
