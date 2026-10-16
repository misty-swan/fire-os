/**
 * コミット済みPDF fixture（wrangler.jsoncのrules type:DataでDataモジュール=ArrayBufferとして束ねられる）を
 * 試験へ渡すための型の橋渡し（T064）。src/vite-env.d.ts経由のvite/client資産宣言（*.pdf→stringのURL）が
 * 型上は勝つため、実行時の実型（ArrayBuffer）へはここで検査してからnarrowする
 * （ローダーの設定違いは黙って通さず例外にする=fail-fast）。
 */
import brokenFlate from "./broken-flate.pdf";
import imageOnlyJa from "./image-only-ja.pdf";
import sampleJa from "./sample-ja.pdf";

const asBytes = (module: unknown, name: string): Uint8Array => {
  if (!(module instanceof ArrayBuffer)) {
    throw new Error(`PDF fixtureがDataモジュール（ArrayBuffer）として読めません: ${name}（${typeof module}）`);
  }
  return new Uint8Array(module);
};

/** コミット済みfixtureの実bytes（生成手順=scripts/generate-document-fixtures.ts） */
export const loadPdfFixtures = (): { sample: Uint8Array; imageOnly: Uint8Array; broken: Uint8Array } => ({
  sample: asBytes(sampleJa, "sample-ja.pdf"),
  imageOnly: asBytes(imageOnlyJa, "image-only-ja.pdf"),
  broken: asBytes(brokenFlate, "broken-flate.pdf"),
});
