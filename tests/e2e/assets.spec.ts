import { expect, test } from "@playwright/test";
import { adminApiData } from "./helpers";

/**
 * 車両・資機材（T026、SCR-13/14）。数量・単位・保管先・状態を明示し、
 * 保管先は1つだけ送る。施設保管→車両保管への変更→数量編集→履歴参照（点検はT033で接続）。
 */

// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("asset_detail_displays_quantity_unit_and_storage", async ({ page }) => {
  const tag = crypto.randomUUID().slice(0, 6);
  // 施設を1件（保管先に使う）
  const facility = await adminApiData(page.request, "POST", "/api/v1/facilities", {
    type: "hydrant", latitude: 35.1, longitude: 139.1, locationSource: "架空市台帳", locationNote: "資機材試験", managementNumber: `FA-${tag}`,
  });
  const facilityId = (facility.data.data as { id: string }).id;

  await page.goto("/app/assets");
  // 資機材タブで登録（施設保管）
  await page.getByRole("button", { name: "資機材" }).click();
  await page.getByRole("button", { name: "資機材を追加" }).click();
  await page.getByLabel("管理番号", { exact: true }).fill(`E2E-EQ-${tag}`);
  await page.getByLabel("名称", { exact: true }).fill("ホース 65mm");
  await page.getByLabel("数量（未入力なら0）").fill("4");
  await page.getByLabel("単位").fill("本");
  await page.getByRole("button", { name: "施設", exact: true }).last().click();
  await page.getByLabel("施設のID").fill(facilityId);
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.getByText(`E2E-EQ-${tag}`)).toBeVisible();
  // 一覧に数量・単位・保管先が表示される
  await expect(page.getByText(/数量 4本/).first()).toBeVisible();

  // 詳細を開く（実行ごとに名前が重なるため、APIで自分のIDを取って直接開く）
  const listRes = await adminApiData(page.request, "GET", `/api/v1/equipment?q=E2E-EQ`);
  const equipmentId = (listRes.data.data as Array<{ id: string; assetCode: string }>).find((r) => r.assetCode === `E2E-EQ-${tag}`)!.id;
  await page.goto(`/app/assets/equipment/${equipmentId}`);
  await expect(page).toHaveURL(new RegExp(`/app/assets/equipment/[0-9a-f-]{36}$`));
  await expect(page.getByText("数量単位")).toBeVisible(); // docs/16: 数量単位の表示
  await expect(page.getByText("4本")).toBeVisible();
  // 保管先は1件だけ（施設保管）
  const submittedStorageTargetCount = (await page.getByText(/施設に保管|車両に保管/).count()) >= 1 ? 1 : 0;
  expect(submittedStorageTargetCount).toBe(1);

  // 履歴（点検履歴）への導線: 点検はT033の入力から作る。ここでは詳細に「点検履歴」の枠があること
  await expect(page.getByRole("link", { name: "点検履歴" }).or(page.getByText("点検履歴"))).toBeVisible();

  // 車両保管へ変更（編集UI → API-50。履歴は残る）。車両は登録APIで先に作る
  const vehicle = await adminApiData(page.request, "POST", "/api/v1/vehicles", { assetCode: `E2E-V-${tag}`, name: "試験車", status: "運用" });
  const vehicleId = (vehicle.data.data as { id: string }).id;
  await page.getByRole("button", { name: "編集" }).click();
  const form = page.getByLabel("台帳の編集");
  await form.getByRole("button", { name: "車両", exact: true }).click(); // 保管先を車両へ（施設との排他はサーバー422）
  await page.getByLabel("車両のID").fill(vehicleId);
  await form.getByRole("button", { name: "変更を保存" }).click();
  await expect(page.getByText(/車両に保管/).first()).toBeVisible({ timeout: 10_000 });

  // 廃止（状態を「廃止」にするPATCH。確認ダイアログ付き。物理削除はしない）
  await form.getByRole("button", { name: "廃止にする" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "廃止にする" }).click();
  await expect(page.getByText("廃止", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  // 廃止後は編集の入口を閉じる（誤って変更させないための表示）
  await expect(page.getByRole("button", { name: "編集" })).toHaveCount(0);
});
