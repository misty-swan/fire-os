import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { BASE } from "./helpers";

/**
 * CSV取り込み（T024、SCR-20）。プレビュー→確定→結果。プレビューでは台帳は変わらない。
 * 式先頭=+-@のescape（docs/16: import_commit_detects_master_change_and_escapes_formula）。
 */

const CSV_HEADER = "type,management_number,identifying_name,latitude,longitude,location_source,location_note";

function csvFile(rows: string[]): Buffer {
  return Buffer.from([CSV_HEADER, ...rows].join("\r\n"), "utf8");
}

// 幅: desktop限定（幅で変わる断言なし（流れ・データの断言））
test("csv_import_preview_then_commit_updates_master", async ({ page }) => {
  test.setTimeout(120_000);
  const tag = crypto.randomUUID().slice(0, 6);
  const before = await page.request.fetch(`${BASE}/api/v1/facilities?limit=200`, { headers: { "cf-connecting-ip": "10.1.1.1" } });
  const beforeBody = (await before.json()) as { data: unknown[] };

  await page.goto("/app/facilities/import");
  // プレビュー（式注入のセルを含むCSV）
  await page.setInputFiles('input[type="file"]', {
    name: `facilities-${tag}.csv`, mimeType: "text/csv",
    buffer: csvFile([
      `hydrant,CSV-${tag}-1,,35.71,139.71,架空市台帳,正常な行`,
      `hydrant,=${tag},,35.72,139.72,架空市台帳,式のように見える番号`, // 式注入のescape対象（実行ごとに一意な番号）
      `hydrant,CSV-${tag}-1,,35.73,139.73,架空市台帳,ファイル内重複`, // 重複エラー
    ]),
  });
  await page.getByRole("button", { name: "プレビュー" }).click();
  await expect(page.getByText("プレビューの結果")).toBeVisible({ timeout: 60_000 });
  // プレビューの結果: 全体3件、エラー1件（重複）、取込2件
  await expect(page.getByText(/^3$/).first()).toBeVisible();
  await expect(page.getByText(/^1$/)).toBeVisible();

  // プレビューで台帳は変わらない
  const mid = await page.request.fetch(`${BASE}/api/v1/facilities?limit=200`);
  const midBody = (await mid.json()) as { data: unknown[] };
  expect(midBody.data.length).toBe(beforeBody.data.length);

  // 確定
  await page.getByRole("button", { name: "この内容で確定する" }).click();
  await expect(page.getByText("取り込みました")).toBeVisible({ timeout: 90_000 });

  // 台帳が増えている（2件）。書き出しで式セルがescapeされている
  const after = await page.request.fetch(`${BASE}/api/v1/facilities?limit=200`);
  const afterBody = (await after.json()) as { data: { managementNumber: string | null }[] };
  expect(afterBody.data.length).toBe(beforeBody.data.length + 2);
  const exportRes = await page.request.fetch(`${BASE}/api/v1/facilities/export?type=hydrant`);
  const csv = await exportRes.text();
  const formulaCellsEscaped = csv.includes(`'=${tag}`);
  expect(formulaCellsEscaped).toBe(true);
  void readFileSync;
});
