import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { brokenFlatePdf, imageOnlyJaPdf, sampleJaPdf } from "../tests/fixtures/documents/sample-ja";

/**
 * 文書抽出のfixture（T064）を決定的に生成して書き込む（生成方法の正本=tests/fixtures/documents/sample-ja.ts）。
 *
 *   npx tsx scripts/generate-document-fixtures.ts
 *   npx tsx scripts/generate-document-fixtures.ts --check   （既存ファイルとの一致のみ検査する。書換え無し）
 *
 * すべて架空データ（実データを載せない＝AGENTS.md）。乱数・現在時刻を使わないため、
 * 同じ入力からは同じバイト列になる（PDFのzlib圧縮は実行環境のzlib実装に依存するため、
 * 環境が変わると圧縮結果が変わることがある。その場合は差分を確認して意図した再生成としてコミットする）。
 */

const OUT_DIR = "tests/fixtures/documents";

const targets: { file: string; generate: () => Promise<Uint8Array> }[] = [
  { file: "sample-ja.pdf", generate: sampleJaPdf },
  { file: "image-only-ja.pdf", generate: imageOnlyJaPdf },
  { file: "broken-flate.pdf", generate: brokenFlatePdf },
];

const checkOnly = process.argv.includes("--check");
let mismatch = 0;

for (const { file, generate } of targets) {
  const bytes = await generate();
  const path = join(OUT_DIR, file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const existing = (() => {
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  })();
  if (checkOnly) {
    const ok = existing !== null && createHash("sha256").update(existing).digest("hex") === sha256;
    console.log(`${ok ? "OK" : "MISMATCH"} ${path} sha256=${sha256}`);
    if (!ok) mismatch++;
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  console.log(`written ${path} (${bytes.length} bytes) sha256=${sha256}`);
}

if (mismatch > 0) {
  console.error(`${mismatch}件のfixtureが生成結果と一致しません。scripts/generate-document-fixtures.ts で再生成してください。`);
  process.exit(1);
}
