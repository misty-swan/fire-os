import { expect, test } from "@playwright/test";
import { adminApi, BASE, apiHeaders } from "./helpers";

/**
 * マップ（T021、SCR-03）。地図/一覧切替・種別チップ・選択シート・全件取得の世代管理。
 * 期待は prototype（FireOS Prototype マップ / Desktop Map）の構成・文言。
 */
const isPhone = (viewport: { width: number } | null) => (viewport?.width ?? 0) < 1024;

test.beforeEach(async ({ request }) => {
  // 種別の異なる施設を4件（消火栓2・防火水槽1・格納箱1。API-11。管理番号は試験ごとに一意。格納箱はT085レビューB-I5で追加）。座標も実行ごとにずらす
  // （D1は1実行中に共有されるため、同じ座標のマーカーが重なって押せなくならないようにする）
  const tag = crypto.randomUUID().slice(0, 6);
  const jitter = [...tag].reduce((n, c) => n + c.charCodeAt(0), 0) % 30;
  const facilities = [
    { type: "hydrant", managementNumber: `E2E-H-${tag}`, latitude: 30.362 + jitter * 0.0004, longitude: 130.645 + jitter * 0.0005 },
    { type: "hydrant", managementNumber: `E2E-H2-${tag}`, latitude: 30.376 + jitter * 0.0004, longitude: 130.665 + jitter * 0.0005 },
    { type: "cistern", managementNumber: `E2E-S-${tag}`, latitude: 30.39 + jitter * 0.0004, longitude: 130.647 + jitter * 0.0005 },
    { type: "box", managementNumber: `E2E-B-${tag}`, latitude: 30.404 + jitter * 0.0004, longitude: 130.669 + jitter * 0.0005 }, // DEMO_BBOX（宮之浦周辺の表示範囲。東端130.70）の内側に収める
  ] as const;
  for (const f of facilities) {
    const res = await adminApi(request, "POST", "/api/v1/facilities", {
      ...f, locationSource: "架空市台帳", locationNote: `試験用の施設 ${f.managementNumber}`,
    });
    if (res.status !== 201) throw new Error(`facility seed failed: ${JSON.stringify(res.data)}`);
  }
  (test as unknown as { tag: string }).tag = tag;
});

async function seedOf(page: import("@playwright/test").Page): Promise<{ hydrant: string[]; cistern: string[]; box: string[] }> {
  const res = await page.request.fetch(`${BASE}/api/v1/facilities?limit=200`, { headers: apiHeaders() });
  const body = (await res.json()) as { data: { id: string; type: string; managementNumber: string }[] };
  const tag = (test as unknown as { tag: string }).tag;
  const mine = body.data.filter((f) => f.managementNumber.includes(tag));
  return {
    hydrant: mine.filter((f) => f.type === "hydrant").map((f) => f.managementNumber),
    cistern: mine.filter((f) => f.type === "cistern").map((f) => f.managementNumber),
    box: mine.filter((f) => f.type === "box").map((f) => f.managementNumber),
  };
}

// 幅: 両方（マーカー(スマホ)/一覧行(PC)の表示が分岐）
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

// 幅: 両方（スマホ=選択シート/PC=右パネルと導線が分岐）
test("map_selection_sheet_matches_prototype_and_opens_detail", async ({ page }) => {
  test.setTimeout(90_000); // 全体試験では負荷が上がるため（単独では数秒。ph1のruntime.test.tsと同じ扱い）
  const seed = await seedOf(page);
  await page.goto("/app/map");
  // 実行ごとに同じ座標の施設が増えるため、PCは右パネルの一覧の最後の行（この実行の施設）から選ぶ
  const target = page.getByRole("button", { name: `消火栓 ${seed.hydrant[0]}` });
  await expect(target.first()).toBeVisible({ timeout: 10_000 });
  // フル試験では同座標に他の試験の施設が重なり、最前面が別のマーカーになることがある。
  // ここで確かめたいのはシートの構成（prototype準拠）なので、スマホはヒットテストを強制する。
  // また読込中の再描画で選択が外れるため、全cursor完走（「取得中」の消滅）を待ってから選ぶ
  await expect(page.getByText("施設一覧を取得中…")).toBeHidden({ timeout: 20_000 });
  await (isPhone(page.viewportSize()) ? target.first().click({ force: true }) : target.last().click());

  if (isPhone(page.viewportSize())) {
    // 選択シート: 種別・番号・状態3列・点検する/詳細/経路（prototype の構成）
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText("位置確認")).toBeVisible();
    await expect(sheet.getByText("未確認")).toBeVisible();
    await expect(sheet.getByRole("button", { name: /点検する/ })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "詳細" })).toBeVisible();
    await expect(sheet.getByRole("link", { name: "Googleマップで経路を開く" })).toBeVisible();
    // 閉じるボタンで消える
    await sheet.getByRole("button", { name: "閉じる" }).click();
    await expect(sheet).toBeHidden();
    // Escでも閉じる（PH2-C19。シートはdialogのためOverlay〔ドロワー/モーダル〕と同じ挙動に揃えた）
    await target.first().click({ force: true });
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  } else {
    // PCは右パネルに詳細（一覧に戻れる）。CTAは「点検を依頼」（prototype Desktop。点検登録へ進む）
    await expect(page.getByText("座標（外部マップへ送る値）")).toBeVisible();
    await expect(page.getByRole("button", { name: /点検を依頼/ })).toBeVisible();
    await page.getByRole("button", { name: "一覧に戻る" }).click();
    await expect(page.getByText("施設一覧")).toBeVisible();
  }
});

/**
 * 3種の施設（消火栓・防火水槽・格納箱）を色だけでなく文字で識別できる（AT-MAP-02・TC-05。T085レビューB-I5）。
 * 各施設のマーカー（スマホ）・一覧の行（PC）は「種別名＋番号」のaccessible nameを持ち、種別チップ（凡例を兼ねる絞り込み）は
 * 3種とも文字ラベルで出る。地図面はプレースホルダー（実Google Mapsは未接続＝X-V05）。
 */
// 幅: 両方（一覧切替(スマホ)の分岐があり狭幅の代替を読む）
test("three_facility_types_are_identified_by_text_not_color_only", async ({ page }) => {
  test.setTimeout(90_000);
  const seed = await seedOf(page);
  expect([seed.hydrant.length, seed.cistern.length, seed.box.length]).toEqual([2, 1, 1]);
  await page.goto("/app/map");
  await expect(page.getByText("施設一覧を取得中…")).toBeHidden({ timeout: 20_000 });
  for (const label of ["消火栓", "防火水槽", "格納箱"]) {
    await expect(page.getByRole("button", { name: new RegExp(`^${label}`) }).first()).toBeVisible(); // 種別チップ（文字ラベル）
  }
  for (const [label, number] of [["消火栓", seed.hydrant[0]!], ["防火水槽", seed.cistern[0]!], ["格納箱", seed.box[0]!]] as const) {
    const named = page.getByRole("button", { name: `${label} ${number}` });
    await expect(named.first()).toBeAttached();
    expect(await named.count()).toBeGreaterThan(0);
  }
  // スマホは一覧へ切り替えても、行の文字で種別が読める（地図を見られない場合の代替）
  if (isPhone(page.viewportSize())) {
    await page.getByRole("button", { name: "一覧" }).first().click();
  }
  await expect(page.getByText(`格納箱 ${seed.box[0]}`).first()).toBeVisible();
});
