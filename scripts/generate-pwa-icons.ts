/**
 * PWAアイコンの生成（T074）。BrandMark.tsx と同じ意匠（濃紺の角丸＋同心円2つ＋橙の点）をSVGで描き、
 * Playwright(Chromium)でPNGに raster化する。アイコンを変えるときは public/icons/ で再実行する:
 *   npx tsx scripts/generate-pwa-icons.ts
 * icon.svg はファビコン兼ソース。maskable は全面背景にして中央の安全域（直径80%）に収める。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

/** BrandMark.tsx の比率（32px基準: 角丸0.3125・リング0.6/0.37・点0.156）を size に拡大する */
function iconSvg(size: number, maskable: boolean): string {
  const r = (ratio: number) => Math.round(size * ratio * 10) / 10;
  const stroke = r(1 / 32); // BrandMarkのbox-shadow 1px @32px と同じ太さの比率
  const corner = maskable ? 0 : size * 0.3125;
  const border = maskable ? "" : `<rect x="${stroke}" y="${stroke}" width="${size - stroke * 2}" height="${size - stroke * 2}" rx="${corner}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="${stroke * 2}"/>`;
  const bg = maskable
    ? `<rect width="${size}" height="${size}" fill="url(#bg)"/>`
    : `<rect width="${size}" height="${size}" rx="${corner}" fill="url(#bg)"/>`;
  // リングは円の内側に沿う線（inset box-shadowと同じ）。点のまわりに小さな発光
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#16223a"/>
      <stop offset="1" stop-color="#0c1526"/>
    </linearGradient>
    <radialGradient id="glow">
      <stop offset="0.4" stop-color="rgba(255,90,46,.85)"/>
      <stop offset="1" stop-color="rgba(255,90,46,0)"/>
    </radialGradient>
  </defs>
  ${bg}
  ${border}
  <circle cx="${size / 2}" cy="${size / 2}" r="${r(0.6) / 2 - stroke}" fill="none" stroke="rgba(255,106,61,.25)" stroke-width="${stroke}"/>
  <circle cx="${size / 2}" cy="${size / 2}" r="${r(0.37) / 2 - stroke}" fill="none" stroke="rgba(255,106,61,.55)" stroke-width="${stroke}"/>
  <circle cx="${size / 2}" cy="${size / 2}" r="${r(0.19)}" fill="url(#glow)"/>
  <circle cx="${size / 2}" cy="${size / 2}" r="${r(0.156) / 2}" fill="#ff5a2e"/>
</svg>`;
}

async function main() {
  mkdirSync("public/icons", { recursive: true });
  writeFileSync("public/icons/icon.svg", iconSvg(512, false));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const targets = [
    ["icon-192", 192, false],
    ["icon-512", 512, false],
    ["maskable-192", 192, true],
    ["maskable-512", 512, true],
  ] as const;
  for (const [name, size, maskable] of targets) {
    const svg = Buffer.from(iconSvg(size, maskable)).toString("base64");
    await page.setViewportSize({ width: size, height: size });
    await page.goto(`data:image/svg+xml;base64,${svg}`);
    await page.screenshot({ path: `public/icons/${name}.png` });
    console.log(`public/icons/${name}.png`);
  }
  await browser.close();
}

void main();
