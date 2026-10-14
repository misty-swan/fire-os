import { expect, test } from "@playwright/test";
import { apiHeaders, BASE } from "./helpers";

// ChromiumのAndroidエミュレーションはファイル選択でレイアウトビューポートを広げたまま戻らないことがあり、
// 以降の操作が当たらなくなる。画面幅の確認は360pxのまま行うため、この画面だけ入力方式をデスクトップに合わせる。
test.use({ isMobile: false, hasTouch: false });

/**
 * 添付のアップロードUI（T018）。転送と検査を別の状態で示し、検査の済んだものだけを親に渡す。
 * docs/16: checking_file_is_not_submitted_as_ready — 未検査/拒否を保存済みと表示しない。
 */

/** 最小のPNG（1px。実写真情報は載せない） */
function pngBytes(fill = 1): Buffer {
  let table: number[] = [];
  const crc32 = (bytes: Uint8Array) => {
    if (!table.length) {
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    }
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01])), chunk("IEND", Buffer.alloc(0))];
  return Buffer.concat(parts);
}

test("checking_file_is_not_submitted_as_ready", async ({ page }) => {
  test.setTimeout(90_000); // 写真の検査（job）の完了を画面で待つため
  const tag = crypto.randomUUID().slice(0, 6);
  await page.goto("/app/facilities/new");

  // 正常な写真を追加 → 転送 → 検査中 → 準備完了（jobの検査は別状態）
  await page.setInputFiles('input[type="file"]', { name: "photo.png", mimeType: "image/png", buffer: pngBytes(1) });
  await expect(page.getByText("検査中…")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("準備完了")).toBeVisible({ timeout: 30_000 });

  // 検査を通らないファイルは「保存できません」と表示され、準備完了にならない
  const broken = pngBytes(2);
  broken[40] = 0xff; // IDATのCRC領域を壊す
  await page.setInputFiles('input[type="file"]', { name: "broken.png", mimeType: "image/png", buffer: broken });
  await expect(page.getByText(/保存できません/).or(page.getByText(/この形式は保存できません/))).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("準備完了")).toHaveCount(1); // readyは最初の1件だけ

  // 親フォームの保存には ready だけが渡る（検査待ち・拒否は渡らない）
  await page.getByLabel("管理番号（識別名どちらか必須）").fill(`E2E-ATT-${tag}`);
  await page.getByLabel("緯度").fill("35.201");
  await page.getByLabel("経度").fill("139.201");
  await page.getByLabel("位置の出典").fill("現地測量");
  await page.getByLabel("目印・場所のメモ").fill("添付の試験用施設");
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/facilities/[0-9a-f-]{36}$`), { timeout: 10_000 });
  const facilityId = new URL(page.url()).pathname.split("/").pop()!;

  // 作成先に紐付いた添付は ready の1件だけ（拒否した2件目は紐付かない=未検査を保存済みにしない）
  const detail = await (await page.request.fetch(`${BASE}/api/v1/facilities/${facilityId}`, { headers: apiHeaders() })).json() as {
    data: { attachments: { id: string; status: string }[] };
  };
  const submittedAttachmentIds = detail.data.attachments.map((a) => a.id);
  expect(submittedAttachmentIds).toHaveLength(1);
  const readyIdsOnly = await page.evaluate(() => Array.from(document.querySelectorAll("img[alt^='施設写真']")).length);
  expect(readyIdsOnly).toBeGreaterThanOrEqual(1);
  // リンクは1つだけ（同じ写真の二重リンク無し）
  const duplicateReadyLinks = detail.data.attachments.length - new Set(submittedAttachmentIds).size;
  expect(duplicateReadyLinks).toBe(0);
  for (const a of detail.data.attachments) expect(a.status).toBe("ready");

  // 詳細画面で写真が表示される（検査済実体のみ）
  await expect(page.getByRole("img", { name: "施設写真1" })).toBeVisible();
});
