import type { AppEnv } from "../env";
import { EXTRACTOR_VERSION } from "./chunk";

/**
 * 許諾文書原本からのテキスト抽出（T064、docs/06 §5「画像PDF/OCR必要性はD20で決定し、ページ/節/文字offsetを保持」、
 * docs/14 D16/D20）。依存ライブラリを増やさない**自前の最小PDF抽出器**（プリフライト裁定2）:
 *
 *   PDF構造走査（"N G obj"の走査+辞書解析。xref解釈の代わりにCatalog→Pages→Kidsを辿る）
 *   → FlateDecode展開（DecompressionStream。workerd/nodeの両方で動く。Node専用APIは使わない）
 *   → テキスト演算子（BT/Tf/Td/TD/Tm/TL/TJ/Tj/'/" と改行表示のT*）
 *   → フォントのToUnicode CMap（bfchar/bfrange+codespacerange）またはUniJIS-UCS2系のUCS2直mapで文字へ復元。
 *
 * **fail-closed（プリフライト裁定3）**: 復元できないものは決して推測した文字列を作らない。
 *  - 復元不能な要素（ToUnicode無しのType0、/Differences、インライン画像BI、予測子付きFlate、暗号化、
 *    未対応フィルタ、対応の無いコード）は1つでもあれば例外（unextractable_document）にしてchunkを保存しない。
 *  - テキスト演算子が1つも無い（画像のみ）PDFはdocument_ocr_required。OCRは未実装
 *    （対応方式と限界・残手順はdocs/evidence/V04-retrieval.md）。
 *
 * 抽出契約（chunk.tsと対になる。試験の核心=引用→原文spanの完全一致）:
 *  - 各頁のテキストは「表示オペレータ（Tj等）ごとの文字列を行として"\n"で結合」したもの。
 *    生成側が1行=1つのTjで描いていれば、抽出結果は埋め込んだ元テキストと1文字も違わない。
 *  - 同じY位置での複数表示（表の同一行など）は改行なしで連結する（決定的）。
 */

/** 抽出できない内容（jobはmanual_reviewになりchunkを1字も保存しない。error_codeは短いコード） */
export type ExtractErrorCode =
  | "unextractable_document" // 構造が解析できない・復元できない（fail-closed）
  | "document_ocr_required" // 画像のみなど抽出すべきテキストが無い（OCRは未実装=D20）
  | "pdf_encrypted" // 暗号化PDF（複合は対象外）
  | "attachment_not_ready" // 原本添付がreadyでない
  | "hash_mismatch"; // 原本の実bytesが版のcontent_hashと一致しない

export class DocumentExtractError extends Error {
  constructor(
    /** jobのerror_codeに入る短いコード（内部の例外本文は保存しない） */
    public readonly errorCode: ExtractErrorCode,
    detail: string,
  ) {
    super(`document extract: ${errorCode} (${detail})`);
  }
}

/** R2の取得に失敗した（一時的。handlerはretryableにする） */
export class ExtractStorageError extends Error {}

export interface ExtractedPage {
  /** 1始まり（PDFのページ順=ページツリーのKids順） */
  pageNo: number;
  /** 頁の抽出テキスト（行="\n"結合。chunk化の正本座標） */
  text: string;
}

/** extractDocumentの成功結果（chunk.tsのchunkDocumentに入力する） */
export interface ExtractedDocument {
  versionId: string;
  documentId: string;
  unitId: string;
  /** 原本のsha256（document_versions.content_hashと照合済み。source_offsets.contentHashの値） */
  contentHash: string;
  /** 抽出器の版（chunk.tsのEXTRACTOR_VERSIONと同じ値） */
  extractorVersion: string;
  pages: ExtractedPage[];
}

export interface ExtractInput {
  versionId: string;
  attachmentId: string;
}

type ExtractEnv = Pick<AppEnv, "DB" | "FILES">;

/**
 * 版と原本添付からテキストを抽出する（docs/16 T064のInterface）。
 * 実行時の再検査（attachmentのreadyと原本hash照合=docs/06 §3流儀）もここで行う。
 */
export async function extractDocument(env: ExtractEnv, input: ExtractInput): Promise<ExtractedDocument> {
  const version = await env.DB.prepare("SELECT id, unit_id, document_id, content_hash FROM document_versions WHERE id = ?")
    .bind(input.versionId)
    .first<{ id: string; unit_id: string; document_id: string; content_hash: string }>();
  if (!version) throw new DocumentExtractError("unextractable_document", "version_missing");
  const att = await env.DB.prepare("SELECT id, unit_id, status, ready_key, sha256, content_type FROM attachments WHERE id = ?")
    .bind(input.attachmentId)
    .first<{ id: string; unit_id: string; status: string; ready_key: string | null; sha256: string | null; content_type: string }>();
  if (!att || att.unit_id !== version.unit_id) throw new DocumentExtractError("unextractable_document", "attachment_missing");
  if (att.status !== "ready" || !att.ready_key) throw new DocumentExtractError("attachment_not_ready", att.status);
  // 原本hash照合（docs/06 §3「原本hash/抽出版と頁/section/offsetを保存」。不一致は捏造の可能性があるため保存しない）
  if (!att.sha256 || att.sha256 !== version.content_hash) throw new DocumentExtractError("hash_mismatch", "attachment_sha256");
  if (att.content_type !== "application/pdf") {
    // T064の抽出対象はPDFのみ（docs/14 D20「必要Office/PDF対応を無断削除しない」。他形式の対応方式はV04に記録）
    throw new DocumentExtractError("unextractable_document", `unsupported_content_type:${att.content_type}`);
  }

  let bytes: Uint8Array;
  try {
    const obj = await env.FILES.get(att.ready_key);
    if (!obj) throw new ExtractStorageError(`ready object missing: ${att.ready_key}`);
    bytes = new Uint8Array(await obj.arrayBuffer());
  } catch (err) {
    if (err instanceof ExtractStorageError) throw err;
    throw new ExtractStorageError(String(err));
  }
  // 実bytesのhashも照合する（ready鍵は内容hashで固定だが、版との一致をここでも確かめる）
  if ((await sha256Hex(bytes)) !== version.content_hash) throw new DocumentExtractError("hash_mismatch", "original_bytes");

  const pages = await extractPdfPages(bytes);
  const totalText = pages.reduce((n, p) => n + p.text.length, 0);
  if (pages.length === 0 || totalText === 0) {
    // テキスト演算子が1つも無い（画像のみのスキャン等）。OCRは未実装なので捏造せず保留へ（docs/evidence/V04-retrieval.md）
    throw new DocumentExtractError("document_ocr_required", "no_text_operators");
  }
  return {
    versionId: version.id,
    documentId: version.document_id,
    unitId: version.unit_id,
    contentHash: version.content_hash,
    extractorVersion: EXTRACTOR_VERSION,
    pages,
  };
}

const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// --- PDF構造の最小パーサ（latin1文字列で走査する。latin1はバイトと1:1なので文字位置=バイト位置） ---

class PdfName {
  constructor(readonly name: string) {}
}
class PdfRef {
  constructor(readonly num: number, readonly gen: number) {}
}
class PdfDict {
  readonly entries = new Map<string, PdfValue>();
  get(key: string): PdfValue | undefined {
    return this.entries.get(key);
  }
  getName(key: string): string | null {
    const v = this.entries.get(key);
    return v instanceof PdfName ? v.name : null;
  }
  getDict(key: string): PdfDict | null {
    const v = this.entries.get(key);
    return v instanceof PdfDict ? v : null;
  }
  getArray(key: string): PdfValue[] | null {
    const v = this.entries.get(key);
    return Array.isArray(v) ? v : null;
  }
}
type PdfValue = number | string | boolean | null | PdfName | PdfRef | PdfValue[] | PdfDict;

const DELIMITERS = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);
const isWs = (c: string): boolean => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isBoundary = (src: string, i: number): boolean => i >= src.length || isWs(src[i]!) || DELIMITERS.has(src[i]!);

function skipWs(src: string, i: number): number {
  for (;;) {
    while (i < src.length && isWs(src[i]!)) i++;
    if (src[i] === "%") {
      // コメント行（%からEOLまで）
      while (i < src.length && src[i] !== "\n" && src[i] !== "\r") i++;
      continue;
    }
    return i;
  }
}

/** 数値トークン（int/float。解析できなければnull） */
function readNumber(src: string, i: number): { value: number | null; next: number } {
  let j = i;
  if (src[j] === "+" || src[j] === "-") j++;
  let dot = false;
  while (j < src.length && (isDigit(src[j]!) || (src[j] === "." && !dot))) {
    if (src[j] === ".") dot = true;
    j++;
  }
  const n = Number(src.slice(i, j));
  return { value: Number.isFinite(n) ? n : null, next: j };
}

/** 16進文字列（バイト列をlatin1文字列として返す） */
function parseHexString(src: string, start: number): string {
  const end = src.indexOf(">", start);
  let hex = "";
  for (let i = start; i < end && i < src.length; i++) {
    const c = src[i]!;
    if (isWs(c)) continue;
    hex += c;
  }
  if (hex.length % 2 === 1) hex += "0";
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** リテラル文字列の生の内側（エスケープは解除しない）と終了位置を返す */
function literalStringBody(src: string, start: number): { body: string; next: number } {
  let i = start + 1;
  let depth = 1;
  const begin = i;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "\\") i += 2;
    else if (c === "(") {
      depth++;
      i++;
    } else if (c === ")") {
      depth--;
      i++;
      if (depth === 0) return { body: src.slice(begin, i - 1), next: i };
    } else i++;
  }
  throw new DocumentExtractError("unextractable_document", "literal_string_unterminated");
}

/** リテラル文字列のエスケープ解除（8進最大3桁・行継続・既知の1文字エスケープ） */
function unescapeLiteral(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = body[i + 1];
    if (e === undefined) break;
    if (isDigit(e) && e <= "7") {
      let oct = "";
      let k = i + 1;
      while (k < body.length && oct.length < 3 && body[k]! >= "0" && body[k]! <= "7") {
        oct += body[k]!;
        k++;
      }
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      i = k - 1;
      continue;
    }
    if (e === "\n") {
      i++;
      continue; // 行継続（EOLは読み飛ばす）
    }
    if (e === "\r") {
      i += body[i + 2] === "\n" ? 2 : 1;
      continue;
    }
    out += e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : e === "b" ? "\b" : e === "f" ? "\f" : e;
    i++;
  }
  return out;
}

/** 辞書・配列・スカラーの解析（値と終了位置を返す。位置はlatin1文字列上のインデックス=バイトオフセット） */
function parseValue(src: string, i: number): { value: PdfValue; next: number } {
  i = skipWs(src, i);
  if (i >= src.length) return { value: null, next: i };
  const c = src[i]!;
  if (c === "<" && src[i + 1] === "<") return parseDict(src, i);
  if (c === "<") {
    const end = src.indexOf(">", i + 1);
    if (end < 0) throw new DocumentExtractError("unextractable_document", "hex_string_unterminated");
    return { value: parseHexString(src, i + 1), next: end + 1 };
  }
  if (c === "[") {
    const arr: PdfValue[] = [];
    i++;
    for (;;) {
      i = skipWs(src, i);
      if (src[i] === "]") return { value: arr, next: i + 1 };
      if (i >= src.length) throw new DocumentExtractError("unextractable_document", "array_unterminated");
      const item = parseValue(src, i);
      arr.push(item.value);
      i = item.next;
    }
  }
  if (c === "/") {
    let j = i + 1;
    while (j < src.length && !isWs(src[j]!) && !DELIMITERS.has(src[j]!)) {
      j += src[j] === "#" ? 3 : 1;
    }
    let name = "";
    for (let k = i + 1; k < j; k++) {
      if (src[k] === "#") {
        name += String.fromCharCode(parseInt(src.slice(k + 1, k + 3), 16));
        k += 2;
      } else name += src[k];
    }
    return { value: new PdfName(name), next: j };
  }
  if (c === "(") {
    const { body, next } = literalStringBody(src, i);
    return { value: unescapeLiteral(body), next };
  }
  if (c === "+" || c === "-" || c === "." || isDigit(c)) {
    // 数値。直後に「数値 数値 R」が来れば間接参照（参照先は走査で解決する）
    const num1 = readNumber(src, i);
    const j = skipWs(src, num1.next);
    if (num1.value !== null && isDigit(src[j] ?? "")) {
      const num2 = readNumber(src, j);
      const k = skipWs(src, num2.next);
      if (
        num1.value !== null && num2.value !== null &&
        Number.isInteger(num1.value) && Number.isInteger(num2.value) &&
        src.startsWith("R", k) && isBoundary(src, k + 1)
      ) {
        return { value: new PdfRef(num1.value, num2.value), next: k + 1 };
      }
    }
    return { value: num1.value, next: num1.next };
  }
  // キーワード（true/false/null/endobj/endstream/stream等）
  let j = i;
  while (j < src.length && !isWs(src[j]!) && !DELIMITERS.has(src[j]!)) j++;
  const word = src.slice(i, j);
  if (word === "true") return { value: true, next: j };
  if (word === "false") return { value: false, next: j };
  if (word === "null") return { value: null, next: j };
  return { value: word, next: j };
}

function parseDict(src: string, i: number): { value: PdfDict; next: number } {
  const dict = new PdfDict();
  i = skipWs(src, i + 2); // "<<"を飛ばす
  for (;;) {
    i = skipWs(src, i);
    if (src.startsWith(">>", i)) return { value: dict, next: i + 2 };
    if (i >= src.length) throw new DocumentExtractError("unextractable_document", "dict_unterminated");
    const key = parseValue(src, i);
    if (!(key.value instanceof PdfName)) throw new DocumentExtractError("unextractable_document", "dict_key_not_name");
    const value = parseValue(src, key.next);
    dict.entries.set(key.value.name, value.value);
    i = value.next;
  }
}

interface PdfObject {
  num: number;
  dict: PdfDict | null;
  /** ストリームの実bytes（同じオブジェクトにstreamが無ければnull） */
  stream: Uint8Array | null;
}

const MAX_PAGES = 2_000;
const MAX_DEPTH = 64;

/**
 * PDFバイト列から頁ごとのテキストを抽出する（fail-closed。復元できない要素は例外）。
 * xrefは解釈せず「N G obj〜endobj」の走査+Catalog→Pages→Kidsの辿りで頁を集める（最小実装）。
 */
async function extractPdfPages(bytes: Uint8Array): Promise<ExtractedPage[]> {
  const src = new TextDecoder("latin1").decode(bytes);
  if (!src.startsWith("%PDF-")) throw new DocumentExtractError("unextractable_document", "pdf_bad_magic");

  const objects = new Map<number, PdfObject>();
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  for (;;) {
    const m = objRe.exec(src);
    if (!m) break;
    const num = Number(m[1]);
    let i = skipWs(src, m.index + m[0].length);
    let dict: PdfDict | null = null;
    if (src.startsWith("<<", i)) {
      const parsed = parseDict(src, i);
      dict = parsed.value;
      i = parsed.next;
    }
    i = skipWs(src, i);
    let stream: Uint8Array | null = null;
    if (src.startsWith("stream", i) && isBoundary(src, i + 6)) {
      // ストリームのデータはEOL（CRLF/LF/CR）の直後から
      let dataStart = i + 6;
      if (src.startsWith("\r\n", dataStart)) dataStart += 2;
      else if (src[dataStart] === "\n" || src[dataStart] === "\r") dataStart += 1;
      let dataEnd = -1;
      const lengthValue = dict?.get("Length");
      if (typeof lengthValue === "number" && Number.isInteger(lengthValue) && dataStart + lengthValue <= src.length) {
        dataEnd = dataStart + lengthValue;
      } else {
        // /Lengthが間接参照等のときはendstreamまで読む（仕様が読者に許す後退）
        const found = src.indexOf("endstream", dataStart);
        if (found < 0) throw new DocumentExtractError("unextractable_document", "stream_unterminated");
        dataEnd = found;
        while (dataEnd > dataStart && (src[dataEnd - 1] === "\n" || src[dataEnd - 1] === "\r")) dataEnd--;
      }
      stream = bytes.slice(dataStart, dataEnd);
      i = src.indexOf("endobj", dataEnd);
      if (i < 0) throw new DocumentExtractError("unextractable_document", "obj_unterminated");
    }
    objects.set(num, { num, dict, stream });
  }
  if (objects.size === 0) throw new DocumentExtractError("unextractable_document", "no_objects");

  // ObjStm（PDF1.5以降の圧縮オブジェクトコンテナ）を展開する
  const budget: InflateBudget = { remaining: MAX_INFLATED_BYTES };
  await expandObjectStreams(src, bytes, objects, budget);

  // 暗号化PDFは対象外（複合せず保留へ）
  for (const obj of objects.values()) {
    if (obj.dict?.getName("Type") === "Encrypt") throw new DocumentExtractError("pdf_encrypted", "encrypt_dict");
  }

  // Catalog（無ければPages）から頁を集める
  let root: PdfDict | null = null;
  for (const obj of objects.values()) {
    if (obj.dict?.getName("Type") === "Catalog") {
      const pages = resolveDict(objects, obj.dict.get("Pages"));
      if (pages) {
        root = pages;
        break;
      }
    }
  }
  if (!root) {
    for (const obj of objects.values()) {
      if (obj.dict?.getName("Type") === "Pages") {
        root = obj.dict;
        break;
      }
    }
  }
  if (!root) throw new DocumentExtractError("unextractable_document", "catalog_missing");

  const pageNodes: { dict: PdfDict; resources: PdfDict | null }[] = [];
  collectPages(objects, root, null, pageNodes, 0);
  if (pageNodes.length === 0) throw new DocumentExtractError("unextractable_document", "no_pages");
  if (pageNodes.length > MAX_PAGES) throw new DocumentExtractError("unextractable_document", "too_many_pages");

  const fontCache = new Map<number, FontDecoder>();
  const pages: ExtractedPage[] = [];
  for (let index = 0; index < pageNodes.length; index++) {
    const node = pageNodes[index]!;
    const parts: string[] = [];
    const contents = node.dict.get("Contents");
    const contentRefs = Array.isArray(contents) ? contents : contents === undefined || contents === null ? [] : [contents];
    for (const ref of contentRefs) {
      const obj = resolveObject(objects, ref);
      if (!obj) throw new DocumentExtractError("unextractable_document", "content_missing");
      const decoded = await decodeStream(obj, budget);
      parts.push(new TextDecoder("latin1").decode(decoded));
    }
    pages.push({
      pageNo: index + 1,
      text: await extractTextFromContent(parts.join(""), node.resources, objects, fontCache, src, bytes, budget),
    });
  }
  return pages;
}

function resolveObject(objects: Map<number, PdfObject>, value: PdfValue | undefined): PdfObject | null {
  if (!(value instanceof PdfRef)) return null;
  return objects.get(value.num) ?? null;
}

function resolveDict(objects: Map<number, PdfObject>, value: PdfValue | undefined): PdfDict | null {
  if (value instanceof PdfDict) return value;
  const obj = resolveObject(objects, value);
  return obj?.dict ?? null;
}

/** ObjStmの中に格納されたオブジェクトを展開してobjectsへ加える（PDF1.5以降の一般的な保存形） */
async function expandObjectStreams(src: string, bytes: Uint8Array, objects: Map<number, PdfObject>, budget: InflateBudget): Promise<void> {
  for (const obj of [...objects.values()]) {
    if (obj.dict?.getName("Type") !== "ObjStm") continue;
    const count = obj.dict.get("N");
    const first = obj.dict.get("First");
    if (typeof count !== "number" || typeof first !== "number" || !obj.stream) continue;
    let data: string;
    try {
      data = new TextDecoder("latin1").decode(await decodeStream(obj, budget));
    } catch (err) {
      if (err instanceof DocumentExtractError) throw err;
      throw new DocumentExtractError("unextractable_document", "objstm_decode_failed");
    }
    // ヘッダは「オブジェクト番号 位置」の対
    const header: { num: number; pos: number }[] = [];
    let at = 0;
    for (let k = 0; k < count; k++) {
      const n1 = readNumber(data, at);
      at = skipWs(data, n1.next);
      const n2 = readNumber(data, at);
      at = skipWs(data, n2.next);
      if (n1.value === null || n2.value === null) throw new DocumentExtractError("unextractable_document", "objstm_header");
      header.push({ num: n1.value, pos: n2.value });
    }
    header.forEach((entry, k) => {
      const bodyEnd = k + 1 < header.length ? first + header[k + 1]!.pos : data.length;
      const body = data.slice(first + entry.pos, Math.max(first + entry.pos, Math.min(bodyEnd, data.length)));
      const parsed = parseValue(body, skipWs(body, 0));
      if (parsed.value instanceof PdfDict) objects.set(entry.num, { num: entry.num, dict: parsed.value, stream: null });
    });
  }
}

/** Pagesツリーを再帰的に辿って頁を並べる（Resourcesは親から継承する） */
function collectPages(
  objects: Map<number, PdfObject>,
  node: PdfDict,
  inheritedResources: PdfDict | null,
  out: { dict: PdfDict; resources: PdfDict | null }[],
  depth: number,
): void {
  if (depth > MAX_DEPTH || out.length > MAX_PAGES) throw new DocumentExtractError("unextractable_document", "page_tree_limit");
  const type = node.getName("Type");
  const resources = node.getDict("Resources") ?? inheritedResources;
  if (type === "Page") {
    out.push({ dict: node, resources });
    return;
  }
  if (type === "Pages") {
    const kids = node.getArray("Kids");
    if (!kids) throw new DocumentExtractError("unextractable_document", "kids_missing");
    for (const kid of kids) {
      const child = resolveDict(objects, kid);
      if (child) collectPages(objects, child, resources, out, depth + 1);
    }
  }
}

// --- ストリームの伸長（FlateDecodeのみ。予測子は未対応=例外にする） ---

async function decodeStream(obj: PdfObject, budget: InflateBudget): Promise<Uint8Array> {
  if (!obj.stream) throw new DocumentExtractError("unextractable_document", "no_stream");
  const dict = obj.dict;
  const filter = dict?.get("Filter");
  const filters: string[] =
    filter instanceof PdfName
      ? [filter.name]
      : Array.isArray(filter)
        ? filter.filter((f): f is PdfName => f instanceof PdfName).map((f) => f.name)
        : [];
  if (filters.some((f) => f !== "FlateDecode")) {
    throw new DocumentExtractError("unextractable_document", `filter:${filters.join(",") || "unknown"}`);
  }
  const parms = dict?.get("DecodeParms");
  const parmList = parms instanceof PdfDict ? [parms] : Array.isArray(parms) ? parms.filter((p): p is PdfDict => p instanceof PdfDict) : [];
  for (const p of parmList) {
    const predictor = p.get("Predictor");
    if (typeof predictor === "number" && predictor > 1) throw new DocumentExtractError("unextractable_document", "flate_predictor");
  }
  if (filters.length === 0) {
    // 非圧縮streamも同じ文書全体の予算へ計上する（同一refの反復で掛け算させない。T091-S10）
    budget.remaining -= obj.stream.length;
    if (budget.remaining < 0) throw new DocumentExtractError("unextractable_document", "inflate_limit_exceeded");
    return obj.stream;
  }
  return inflate(obj.stream, budget);
}

/** zlib（FlateDecode）の展開。zlib形式で失敗したらraw deflateを試す（壊れたPDFは両方で失敗する）。
 *  展開の合計はMAX_INFLATED_BYTESまで、1文書ぶんを全decode（非圧縮streamの利用も含む）で共有する
 *  （PH5レビューA低5・T091-S10。高圧縮ストリーム〔zip爆弾様〕や同一refの反復でメモリを大量消費させない。
 *  超過はunextractable_documentで例外→jobはmanual_review。fontCacheに載ったdecoderは再計上しない） */
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;

/** 文書全体で共有する展開量の残り（T091-S10。/Contentsの同一ref反復や多数のToUnicodeで
 *  streamごとの上限を掛け算で超えないよう、extractPdfPagesが1文書につき1つ作って全展開で使い回す） */
interface InflateBudget {
  remaining: number;
}

async function inflate(stream: Uint8Array, budget: InflateBudget): Promise<Uint8Array> {
  // DOM型のDecompressionStream.writableはBufferSource受けておりUint8ArrayのpipeThroughと合わないため、
  // 実行時の実型（Uint8Arrayをそのまま受ける）に揃えて使う
  const inflateStream = (format: "deflate" | "deflate-raw"): ReadableWritablePair<Uint8Array, Uint8Array> =>
    new DecompressionStream(format) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  for (const format of ["deflate", "deflate-raw"] as const) {
    let charged = 0; // この試行で予算から引いた量（失敗時に戻す）
    try {
      const input = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(stream);
          controller.close();
        },
      });
      const reader = input.pipeThrough(inflateStream(format)).getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
          total += value.length;
          charged += value.length;
          budget.remaining -= value.length;
          if (budget.remaining < 0) {
            throw new DocumentExtractError("unextractable_document", "inflate_limit_exceeded");
          }
          parts.push(value);
        }
      }
      const out = new Uint8Array(total);
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    } catch (err) {
      // 上限超過などの抽出不能の確定は次の形式へ落とさずそのまま通知する
      if (err instanceof DocumentExtractError) throw err;
      // 次の形式を試す。失敗した試行で引いた分は予算へ戻す（同じ予算を二重に引かない）
      budget.remaining += charged;
    }
  }
  throw new DocumentExtractError("unextractable_document", "flate_decode_failed");
}

// --- フォントの文字対応（ToUnicode CMap／UniJIS-UCS2系の直map） ---

interface FontDecoder {
  /** コード→文字。ToUnicodeが無い場合はnull（directUcs2またはASCIIのみのフォールバック） */
  map: Map<number, string> | null;
  /** 1コードのバイト幅（Type0は2。ToUnicodeのcodespacerangeがあればそれに従う） */
  codeWidth: 1 | 2;
  /** ToUnicode無しでUniJIS-UCS2系（CID=UTF-16符号単位の直map） */
  directUcs2: boolean;
}

async function buildFontDecoder(objects: Map<number, PdfObject>, fontValue: PdfValue | undefined, src: string, bytes: Uint8Array, budget: InflateBudget): Promise<FontDecoder> {
  const obj = fontValue instanceof PdfDict ? { dict: fontValue, stream: null } : resolveObject(objects, fontValue);
  const dict = obj?.dict ?? null;
  if (!dict || dict.getName("Type") !== "Font") throw new DocumentExtractError("unextractable_document", "font_missing");
  const toUnicode = await loadToUnicodeMap(objects, dict, src, bytes, budget);
  if (dict.getName("Subtype") === "Type0") {
    const encoding = dict.get("Encoding");
    const encName = encoding instanceof PdfName ? encoding.name : null;
    if (!encName) throw new DocumentExtractError("unextractable_document", "type0_encoding");
    const directUcs2 = toUnicode === null && /UCS2/.test(encName); // UniJIS-UCS2-H/V 等（CID=UTF-16符号単位）
    const twoByte = directUcs2 || /^Identity-[HV]$/.test(encName) || toUnicode?.codeWidth === 2;
    if (!toUnicode && !directUcs2) {
      // ToUnicodeが無くコード→文字の対応が確定できない場合、推測した文字列は作らない（fail-closed）
      throw new DocumentExtractError("unextractable_document", "font_without_tounicode");
    }
    return { map: toUnicode?.map ?? null, codeWidth: twoByte ? 2 : 1, directUcs2 };
  }
  // 単純フォント（Type1等）: /Differences（グリフ名の再定義）があると文字が確定できないため例外
  const encoding = dict.get("Encoding");
  if (encoding instanceof PdfDict && encoding.get("Differences") !== undefined) {
    throw new DocumentExtractError("unextractable_document", "font_differences");
  }
  if (!toUnicode) return { map: null, codeWidth: 1, directUcs2: false }; // ASCIIのみ（0x20〜0x7E）
  return { map: toUnicode.map, codeWidth: toUnicode.codeWidth === 2 ? 2 : 1, directUcs2: false };
}

async function loadToUnicodeMap(
  objects: Map<number, PdfObject>,
  dict: PdfDict,
  src: string,
  bytes: Uint8Array,
  budget: InflateBudget,
): Promise<{ map: Map<number, string>; codeWidth: 1 | 2 } | null> {
  const ref = dict.get("ToUnicode");
  const obj = resolveObject(objects, ref);
  if (!obj) return null;
  const cmapSrc = new TextDecoder("latin1").decode(await decodeStream(obj, budget));
  const map = new Map<number, string>();
  let codeWidth: 1 | 2 = 2;
  // codespacerange（コードのバイト幅）
  const codespace = cmapSrc.match(/begincodespacerange([\s\S]*?)endcodespacerange/);
  const loMatch = codespace?.[1]?.match(/<([0-9A-Fa-f]+)>/);
  if (loMatch) codeWidth = Math.max(1, Math.min(2, Math.floor(loMatch[1]!.length / 2))) as 1 | 2;
  // bfchar（<code> <utf16be>）
  for (const block of cmapSrc.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const tokens = block[1]!.match(/<[0-9A-Fa-f]*>/g) ?? [];
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      const code = parseInt(tokens[i]!.slice(1, -1) || "0", 16);
      map.set(code, utf16beToString(tokens[i + 1]!.slice(1, -1)));
    }
  }
  // bfrange（<lo> <hi> <utf16be開始> または <lo> <hi> [<d1> <d2> ...]）
  for (const block of cmapSrc.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1]!;
    const arrayForm = body.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]*)\]/);
    if (arrayForm) {
      const lo = parseInt(arrayForm[1]!, 16);
      const hi = parseInt(arrayForm[2]!, 16);
      const dsts = (arrayForm[3]!.match(/<[0-9A-Fa-f]*>/g) ?? []).map((t) => utf16beToString(t.slice(1, -1)));
      if (hi >= lo && hi - lo <= 65_535) {
        for (let c = lo; c <= hi && c - lo < dsts.length; c++) map.set(c, dsts[c - lo]!);
      }
      continue;
    }
    const tokens = body.match(/<[0-9A-Fa-f]+>/g) ?? [];
    for (let i = 0; i + 2 < tokens.length; i += 3) {
      const lo = parseInt(tokens[i]!.slice(1, -1), 16);
      const hi = parseInt(tokens[i + 1]!.slice(1, -1), 16);
      const startUnits = hexToCodeUnits(tokens[i + 2]!.slice(1, -1));
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo || hi - lo > 65_535 || startUnits.length === 0) continue;
      for (let c = lo; c <= hi; c++) {
        const offset = c - lo;
        const units = [...startUnits.slice(0, -1), (startUnits[startUnits.length - 1] ?? 0) + offset];
        map.set(c, String.fromCharCode(...units));
      }
    }
  }
  return { map, codeWidth };
}

const hexToCodeUnits = (hex: string): number[] => {
  const units: number[] = [];
  for (let i = 0; i + 4 <= hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
  return units;
};

const utf16beToString = (hex: string): string => String.fromCharCode(...hexToCodeUnits(hex));

/** 文字列（latin1バイト列）をコード列へ復元して文字列へ（Type0は2バイト単位、単純フォントは1バイト） */
function decodeCodeBytes(bytesStr: string, decoder: FontDecoder): string {
  const codes: number[] = [];
  if (decoder.codeWidth === 2) {
    for (let i = 0; i + 1 < bytesStr.length; i += 2) {
      codes.push((bytesStr.charCodeAt(i) << 8) | bytesStr.charCodeAt(i + 1));
    }
  } else {
    for (let i = 0; i < bytesStr.length; i++) codes.push(bytesStr.charCodeAt(i));
  }
  let out = "";
  for (const code of codes) {
    if (decoder.map) {
      const mapped = decoder.map.get(code);
      // 対応の無いコードは推測できない（fail-closed。部分的なテキストも作らない）
      if (mapped === undefined) throw new DocumentExtractError("unextractable_document", "unmapped_code");
      out += mapped;
    } else if (decoder.directUcs2) {
      out += String.fromCharCode(code);
    } else if (code >= 0x20 && code <= 0x7e) {
      out += String.fromCharCode(code); // 単純フォントはASCIIのみ
    } else {
      throw new DocumentExtractError("unextractable_document", "unmapped_simple_code");
    }
  }
  return out;
}

// --- 内容ストリームのテキスト抽出（BT/Tf/Td/TD/Tm/T*/TL/TJ/Tj/'/"） ---

const skipContentWs = (src: string, i: number): number => {
  while (i < src.length && isWs(src[i]!)) i++;
  return i;
};

const lastNumber = (operands: unknown[], fromEnd: number): number => {
  const v = operands[operands.length - fromEnd];
  return typeof v === "number" ? v : 0;
};

const lastNumbers = (operands: unknown[], count: number): number[] =>
  operands.slice(-count).filter((v): v is number => typeof v === "number");

const lastStringOperand = (operands: unknown[]): string => {
  const last = operands[operands.length - 1];
  if (typeof last === "string") return last;
  throw new DocumentExtractError("unextractable_document", "string_operand_missing");
};

/** 内容ストリームからテキストを抽出する（テキストのY位置が変わったところで改行を挿入する） */
async function extractTextFromContent(
  content: string,
  resources: PdfDict | null,
  objects: Map<number, PdfObject>,
  fontCache: Map<number, FontDecoder>,
  src: string,
  bytes: Uint8Array,
  budget: InflateBudget,
): Promise<string> {
  let text = "";
  let lastY: number | null = null;
  let lineMatrix: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
  let leading = 0;
  let currentFont: FontDecoder | null = null;
  const fonts = new Map<string, FontDecoder>();
  const operands: unknown[] = [];
  const fontFor = async (name: string): Promise<FontDecoder> => {
    const cached = fonts.get(name);
    if (cached) return cached;
    const value = resources?.getDict("Font")?.get(name);
    if (value === undefined) throw new DocumentExtractError("unextractable_document", `font_resource_missing:${name}`);
    const cacheKey = value instanceof PdfRef ? value.num : -1;
    const decoder =
      cacheKey >= 0 && fontCache.has(cacheKey)
        ? fontCache.get(cacheKey)!
        : await buildFontDecoder(objects, value, src, bytes, budget);
    if (cacheKey >= 0) fontCache.set(cacheKey, decoder);
    fonts.set(name, decoder);
    return decoder;
  };
  /** Tj等で文字を描く（Y位置の変化で改行を挿入する。同じYは連結=表の同一行） */
  const show = (bytesStr: string) => {
    if (!currentFont) throw new DocumentExtractError("unextractable_document", "font_not_selected");
    const y = lineMatrix[5];
    if (lastY !== null && Math.abs(y - lastY) > 0.001) text += "\n";
    text += decodeCodeBytes(bytesStr, currentFont);
    lastY = y;
  };
  /** Td（行マトリクスの平行移動。lm = [1 0 0 1 tx ty] × lm） */
  const moveText = (tx: number, ty: number) => {
    const [a, b, c, d, e, f] = lineMatrix;
    lineMatrix = [a, b, c, d, tx * a + ty * c + e, tx * b + ty * d + f];
  };

  let i = 0;
  while (i < content.length) {
    i = skipContentWs(content, i);
    if (i >= content.length) break;
    const c = content[i]!;
    if (c === "(") {
      const { body, next } = literalStringBody(content, i);
      operands.push(unescapeLiteral(body));
      i = next;
      continue;
    }
    if (c === "<" && content[i + 1] !== "<") {
      const end = content.indexOf(">", i);
      if (end < 0) throw new DocumentExtractError("unextractable_document", "hex_string_unterminated");
      operands.push(parseHexString(content, i + 1));
      i = end + 1;
      continue;
    }
    if (c === "<") {
      const parsed = parseDict(content, i);
      operands.push(parsed.value);
      i = parsed.next;
      continue;
    }
    if (c === "[") {
      // TJの配列（文字列と数値。それ以外の要素は確定できないため例外）
      const elements: (number | string)[] = [];
      let j = i + 1;
      for (;;) {
        j = skipContentWs(content, j);
        if (j >= content.length) throw new DocumentExtractError("unextractable_document", "array_unterminated");
        if (content[j] === "]") break;
        if (content[j] === "(") {
          const { body, next } = literalStringBody(content, j);
          elements.push(unescapeLiteral(body));
          j = next;
        } else if (content[j] === "<" && content[j + 1] !== "<") {
          const end = content.indexOf(">", j);
          if (end < 0) throw new DocumentExtractError("unextractable_document", "hex_string_unterminated");
          elements.push(parseHexString(content, j + 1));
          j = end + 1;
        } else if (content[j] === "[" || content[j] === "/" || content[j] === "<") {
          throw new DocumentExtractError("unextractable_document", "unexpected_tj_element");
        } else {
          const num = readNumber(content, j);
          if (num.value === null) throw new DocumentExtractError("unextractable_document", "bad_array_element");
          elements.push(num.value);
          j = num.next;
        }
      }
      operands.push(elements);
      i = j + 1;
      continue;
    }
    if (c === "/") {
      let j = i + 1;
      while (j < content.length && !isWs(content[j]!) && !DELIMITERS.has(content[j]!)) j++;
      operands.push(new PdfName(content.slice(i + 1, j)));
      i = j;
      continue;
    }
    if (c === "+" || c === "-" || c === "." || isDigit(c)) {
      const num = readNumber(content, i);
      operands.push(num.value ?? 0);
      i = num.next;
      continue;
    }
    // 演算子（区切りまでの語）
    let j = i;
    while (j < content.length && !isWs(content[j]!) && !DELIMITERS.has(content[j]!)) j++;
    const op = content.slice(i, j);
    i = j;
    switch (op) {
      case "BT":
        lastY = null; // テキストブロックの先頭（直前の行位置を引き継がない）
        break;
      case "Tf": {
        // オペランドは「/F1 11」の順なので、後ろから名前を探す（直後の数値が最後のオペランドになる）
        let fontName: string | undefined;
        for (let k = operands.length - 1; k >= 0; k--) {
          const cand = operands[k];
          if (cand instanceof PdfName) {
            fontName = cand.name;
            break;
          }
          if (typeof cand === "number") continue;
          break;
        }
        currentFont = await fontFor(fontName ?? "");
        break;
      }
      case "Td":
        moveText(lastNumber(operands, 2), lastNumber(operands, 1));
        break;
      case "TD": {
        const ty = lastNumber(operands, 1);
        leading = -ty;
        moveText(lastNumber(operands, 2), ty);
        break;
      }
      case "Tm": {
        const nums = lastNumbers(operands, 6);
        if (nums.length !== 6) throw new DocumentExtractError("unextractable_document", "bad_tm");
        lineMatrix = [nums[0]!, nums[1]!, nums[2]!, nums[3]!, nums[4]!, nums[5]!];
        break;
      }
      case "T*":
        moveText(0, -leading);
        break;
      case "TL":
        leading = lastNumber(operands, 1);
        break;
      case "Tj":
        show(lastStringOperand(operands));
        break;
      case "'":
        moveText(0, -leading);
        show(lastStringOperand(operands));
        break;
      case '"':
        show(lastStringOperand(operands));
        break;
      case "TJ": {
        const arr = operands[operands.length - 1];
        if (!Array.isArray(arr)) throw new DocumentExtractError("unextractable_document", "tj_without_array");
        for (const el of arr) if (typeof el === "string") show(el); // 数値（カーニング）は文字を生まない
        break;
      }
      case "BI":
        // インライン画像は解析しない（画像の前後のテキストも確定しないため例外=fail-closed）
        throw new DocumentExtractError("unextractable_document", "inline_image");
      default:
        break; // それ以外の演算子（q/Q/cm/gs等）は文字を生まない
    }
    operands.length = 0;
  }
  return text;
}
