/**
 * 文書抽出のfixture（T064）。**すべて架空の訓練用テキスト**（実団体・実地名・実文書を含まない）。
 *
 * 生成方法（決定的。乱数・現在時刻を使わない）:
 *
 *   npx tsx scripts/generate-document-fixtures.ts
 *
 * 生成物（コミットする。このmoduleがテキストの正本、PDFバイト列の生成手順の正本）:
 *  - tests/fixtures/documents/sample-ja.pdf      日本語3頁（見出し・本文・表。改ページ/見出し/表を含む）
 *  - tests/fixtures/documents/image-only-ja.pdf  画像のみ（テキスト演算子が1つも無い=抽出不能スキャン相当）
 *  - tests/fixtures/documents/broken-flate.pdf   検査（FileScanner）は通るがFlateDecodeが壊れているPDF
 *
 * PDFの構成（docs/06 §5の抽出対象。src/server/reports/render.tsの最小PDFと同じ方針で、抽出経路の
 * 検証に必要な要素だけを持つ）:
 *  - Type0フォント（/Encoding /Identity-H）+ **ToUnicode CMap**（Flate圧縮。bfrangeでCID→UTF-16BE）。
 *    CIDはUnicode符号単位と同じ値を入れる（抽出のroundtrip検証のため。グリフ自体は非埋め込みなので
 *    実表示は対象外=このfixtureは抽出経路専用）。
 *  - ページの内容ストリームは**FlateDecode圧縮**（抽出器のDecompressionStream経路を検証する）。
 *    1行=1つの `<16進> Tj`、行間は `0 -20 Td`。抽出器は行を"\n"で結合するため、
 *    抽出テキスト=下のPAGESの文字列と**1文字も違わず**一致しなければならない（試験の核心）。
 */

/** 各ページの原本テキスト（抽出結果はこれと完全一致しなければならない。行="\n"結合） */
export const SAMPLE_JA_PAGES: readonly string[] = [
  // 1頁目: 冒頭（見出しでない本文=chunkのsectionはnull）→ 第1章
  [
    "この要領は架空の訓練資料である。",
    "第1章 出動体制（架空）",
    "出動伝達を受けた場合、分団員は15分以内に団庫へ集合する。",
    "防災対策本部の設置は、分団長の判断で行う。",
    "無線のチャンネルは毎年4月に確認する。",
  ].join("\n"),
  // 2頁目: 表（行を1つのTjで描く簡易表）
  [
    "第2章 給水活動の記録（架空）",
    "給水活動では次の表の項目を記録する。",
    "記録項目 | 確認方法 | 責任",
    "給水量 | メーター読取 | 機材係",
    "搬送路 | 現地確認 | 班長",
  ].join("\n"),
  // 3頁目: 短い見出し行（備考）→ 本文 → 第3章
  [
    "備考",
    "この資料は訓練用の架空文書であり、実在の分団や地名を含まない。",
    "第3章 改訂履歴（架空）",
    "2026年第1版を作成した。改訂は承認後に反映される。",
  ].join("\n"),
];

/** テキストをUTF-16BEの16進へ（Identity-Hの2バイトコード=Unicode符号単位。reports/render.tsと同じ） */
function utf16beHex(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += text.charCodeAt(i).toString(16).padStart(4, "0");
  return out.toUpperCase();
}

/** DecompressionStreamと対のCompressionStreamでzlib圧縮（PDFのFlateDecode=zlib形式） */
async function flate(bytes: Uint8Array): Promise<Uint8Array> {
  // DOM型のCompressionStream.writableはBufferSource受けておりUint8ArrayのpipeThroughと合わないため、
  // 実行時の実型（Uint8Arrayをそのまま受ける）に揃えて使う
  const deflateStream = new CompressionStream("deflate") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const compressed = input.pipeThrough(deflateStream);
  const reader = compressed.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) {
      parts.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const latin1 = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

/** ToUnicode CMap（CID→UTF-16BEの恒等map。抽出器のcodespacerange/bfrange解析経路を検証する） */
async function toUnicodeStream(): Promise<Uint8Array> {
  const cmap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    "1 beginbfrange",
    "<0000> <FFFF> <0000>",
    "endbfrange",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  ].join("\n");
  return flate(latin1(cmap));
}

/** 1行=1つのTj、行間は0 -20 Td。Flate圧縮して返す */
async function textContentStream(lines: readonly string[]): Promise<Uint8Array> {
  const ops = lines.map((line, i) => (i === 0 ? "48 780 Td" : "0 -20 Td") + ` <${utf16beHex(line)}> Tj`);
  const content = ["BT", "/F1 11 Tf", ...ops, "ET"].join("\n");
  return flate(latin1(content));
}

/** 画像1個を描くだけの内容ストリーム（テキスト演算子なし=抽出テキストは0字になる） */
async function imageContentStream(): Promise<Uint8Array> {
  return flate(latin1(["q", "100 0 0 100 200 400 cm", "/Im1 Do", "Q"].join("\n")));
}

/** 画像1個（1x1のDeviceGray。抽出器はXObjectを解析しない=画像の中身は見ない） */
async function tinyImageStream(): Promise<Uint8Array> {
  return flate(new Uint8Array([0x00]));
}

/** 検査を通るが伸長に失敗するストリーム（FlateDecodeと称する壊れデータ。捏造テキストを作らない検証用） */
function brokenStream(): Uint8Array {
  return latin1("!!not-a-deflate-stream!!");
}

interface PdfObject {
  /** 辞書部（/Lengthは後に埋めるため %LENGTH% プレースホルダ） */
  dict: string;
  stream: Uint8Array | null;
}

/** PDFバイト列を組み立てる（reports/render.tsと同じ直列化。1=Catalog、2=Pages、3=Font、以降は自由） */
function assemblePdf(objects: PdfObject[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let offset = 0;
  const push = (s: string) => {
    const b = encoder.encode(s);
    parts.push(b);
    offset += b.length;
  };
  const pushBytes = (b: Uint8Array) => {
    parts.push(b);
    offset += b.length;
  };
  push("%PDF-1.4\n");
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets[i] = offset;
    const dict = obj.stream ? obj.dict.replace("%LENGTH%", String(obj.stream.length)) : obj.dict;
    push(`${i + 1} 0 obj\n${dict}\n`);
    if (obj.stream) {
      push("stream\n");
      pushBytes(obj.stream);
      push("\nendstream\n");
    }
    push("endobj\n");
  });
  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  push(xref);
  const all = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}

/** sample-ja.pdf（3頁。Type0+Identity-H+ToUnicode、内容ストリームはFlateDecode） */
export async function sampleJaPdf(): Promise<Uint8Array> {
  const toUnicode = await toUnicodeStream();
  const objects: PdfObject[] = [];
  // 1: Catalog（%PAGES%はPages確定後に置換）
  objects.push({ dict: "<< /Type /Catalog /Pages %PAGES% 0 R >>", stream: null });
  objects.push({ dict: "<< /Type /Pages /Count %COUNT% /Kids [%KIDS%] >>", stream: null });
  // 3: フォント（Type0+Identity-H+ToUnicode。グリフ非埋め込み=抽出経路専用のfixture）
  objects.push({
    dict:
      "<< /Type /Font /Subtype /Type0 /BaseFont /FireOS-Fixture /Encoding /Identity-H " +
      "/DescendantFonts [<< /Type /Font /Subtype /CIDFontType2 /BaseFont /FireOS-Fixture " +
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>] " +
      "/ToUnicode %TOUNICODE% 0 R >>",
    stream: null,
  });
  // 4: ToUnicode CMap
  objects.push({ dict: "<< /Length %LENGTH% /Filter /FlateDecode >>", stream: toUnicode });
  const pageObjNums: number[] = [];
  for (const lines of SAMPLE_JA_PAGES.map((p) => p.split("\n"))) {
    const contentNum = objects.length + 1;
    objects.push({ dict: "<< /Length %LENGTH% /Filter /FlateDecode >>", stream: await textContentStream(lines) });
    const pageNum = objects.length + 1;
    objects.push({
      dict: `<< /Type /Page /Parent %PAGES% 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`,
      stream: null,
    });
    pageObjNums.push(pageNum);
  }
  const pagesNum = 2;
  objects[0]!.dict = objects[0]!.dict.replace("%PAGES%", String(pagesNum));
  objects[1]!.dict = objects[1]!.dict
    .replace("%COUNT%", String(pageObjNums.length))
    .replace("%KIDS%", pageObjNums.map((n) => `${n} 0 R`).join(" "));
  objects[2]!.dict = objects[2]!.dict.replace("%TOUNICODE%", "4");
  for (const n of pageObjNums) objects[n - 1]!.dict = objects[n - 1]!.dict.replace("%PAGES%", String(pagesNum));
  return assemblePdf(objects);
}

/** image-only-ja.pdf（テキスト演算子が1つも無い画像のみの1頁。抽出はdocument_ocr_requiredで保留になる） */
export async function imageOnlyJaPdf(): Promise<Uint8Array> {
  const image = await tinyImageStream();
  const objects: PdfObject[] = [];
  objects.push({ dict: "<< /Type /Catalog /Pages %PAGES% 0 R >>", stream: null });
  objects.push({ dict: "<< /Type /Pages /Count 1 /Kids [%PAGE% 0 R] >>", stream: null });
  const contentNum = objects.length + 1;
  objects.push({ dict: "<< /Length %LENGTH% /Filter /FlateDecode >>", stream: await imageContentStream() });
  const imageNum = objects.length + 1;
  objects.push({
    dict: "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceGray /Length %LENGTH% /Filter /FlateDecode >>",
    stream: image,
  });
  const pageNum = objects.length + 1;
  objects.push({
    dict: `<< /Type /Page /Parent %PAGES% 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 ${imageNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
    stream: null,
  });
  objects[0]!.dict = objects[0]!.dict.replace("%PAGES%", "2");
  objects[1]!.dict = objects[1]!.dict.replace("%PAGE%", String(pageNum));
  objects[pageNum - 1]!.dict = objects[pageNum - 1]!.dict.replace("%PAGES%", "2");
  return assemblePdf(objects);
}

/** broken-flate.pdf（FileScannerの字句検査は通るが、内容ストリームのFlateDecodeが壊れている。抽出はfail-closedで保留） */
export async function brokenFlatePdf(): Promise<Uint8Array> {
  const objects: PdfObject[] = [];
  objects.push({ dict: "<< /Type /Catalog /Pages %PAGES% 0 R >>", stream: null });
  objects.push({ dict: "<< /Type /Pages /Count 1 /Kids [%PAGE% 0 R] >>", stream: null });
  const contentNum = objects.length + 1;
  objects.push({ dict: "<< /Length %LENGTH% /Filter /FlateDecode >>", stream: brokenStream() });
  const pageNum = objects.length + 1;
  objects.push({
    dict: `<< /Type /Page /Parent %PAGES% 0 R /MediaBox [0 0 595 842] /Contents ${contentNum} 0 R >>`,
    stream: null,
  });
  objects[0]!.dict = objects[0]!.dict.replace("%PAGES%", "2");
  objects[1]!.dict = objects[1]!.dict.replace("%PAGE%", String(pageNum));
  objects[pageNum - 1]!.dict = objects[pageNum - 1]!.dict.replace("%PAGES%", "2");
  return assemblePdf(objects);
}
