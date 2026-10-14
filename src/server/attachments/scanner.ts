import { sha256OfBytes } from "./sizes";

/**
 * 添付の内容検査（T016、docs/07 §3.3〜3.4）。
 *
 * 方式: Workersで実行できる**構造検査と無害化**（magic/断片の完全性/CRC/能動的埋込/UTF-8）。
 * メタデータ（EXIF・XMP・テキストチャンク）は**削除して再構築**する（再符号化ではないため画素は不変）。
 *
 * **限界（V02で実ファイル検証する。docs/evidence/V02-files.md）:**
 *  - pixelの完全なデコード検証はWorkersでは行わない（画像デコーダを持たない）。壊れ画像は
 *    チャンク/セグメントの整合で検出するが、見た目の破綻までは分からない。
 *  - PDFは限定的な字句検査で、難読化された埋込は見逃し得る。マルウェアスキャンは別基盤（D16/D12で判断）。
 *  - 検査できない・取得できない場合は rejected にも clean にもしない（unavailable=再試行）。
 */

export type ScanResult =
  | { verdict: "clean"; bytes: Uint8Array; sha256: string; changed: boolean }
  | { verdict: "rejected"; reason: string }
  | { verdict: "unavailable"; reason: string };

let crcTable: number[] | undefined;
/** PNGチャンクのCRC32（ISO-3309/ZLIB。チャンクの破損検出に使う） */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ascii = (bytes: Uint8Array, start: number, len: number): string => {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[start + i]!);
  return s;
};

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const clean = async (bytes: Uint8Array, changed: boolean): Promise<ScanResult> =>
  ({ verdict: "clean", bytes, sha256: await sha256OfBytes(bytes), changed });

/** PNG: チャンク構造とCRCを検証し、メタデータチャンク（eXIf/テキスト系/カラープロファイル）を削除する */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_META = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME", "hIST", "sPLT", "gIFx", "iCCP"]);

function scanPng(bytes: Uint8Array): ScanResult | Promise<ScanResult> {
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_MAGIC[i]) return { verdict: "rejected", reason: "png_bad_magic" };
  const out: Uint8Array[] = [bytes.subarray(0, 8)];
  const dropped: string[] = [];
  let sawIHDR = false;
  let sawIDAT = false;
  let o = 8;
  for (;;) {
    if (o + 12 > bytes.length) return { verdict: "rejected", reason: "png_truncated" };
    const dv = new DataView(bytes.buffer, bytes.byteOffset + o);
    const len = dv.getUint32(0);
    if (o + 12 + len > bytes.length) return { verdict: "rejected", reason: "png_truncated" };
    const type = ascii(bytes, o + 4, 4);
    const crcStored = dv.getUint32(8 + len);
    const crcActual = crc32(bytes.subarray(o + 4, o + 8 + len));
    if (crcStored !== crcActual) return { verdict: "rejected", reason: "png_crc_mismatch" };
    if (type === "IHDR") {
      if (out.length !== 1) return { verdict: "rejected", reason: "png_ihdr_not_first" };
      sawIHDR = true;
    }
    if (type === "IDAT") sawIDAT = true;
    const keep = !PNG_META.has(type);
    if (keep) out.push(bytes.subarray(o, o + 12 + len));
    else dropped.push(type);
    o += 12 + len;
    if (type === "IEND") break;
  }
  if (o !== bytes.length) return { verdict: "rejected", reason: "png_trailing_data" };
  if (!sawIHDR || !sawIDAT) return { verdict: "rejected", reason: "png_incomplete" };
  if (dropped.length === 0) return clean(bytes, false);
  return clean(concat(out), true);
}

/** JPEG: セグメントを検証し、APP1(EXIF/XMP)とCOM（コメント）を削除する */
function scanJpeg(bytes: Uint8Array): ScanResult | Promise<ScanResult> {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return { verdict: "rejected", reason: "jpeg_bad_magic" };
  const out: Uint8Array[] = [bytes.subarray(0, 2)];
  let dropped = 0;
  let o = 2;
  for (;;) {
    if (o + 2 > bytes.length) return { verdict: "rejected", reason: "jpeg_truncated" };
    if (bytes[o] !== 0xff) return { verdict: "rejected", reason: "jpeg_marker_expected" };
    const marker = bytes[o + 1]!;
    if (marker === 0xff) { out.push(bytes.subarray(o, o + 1)); o += 1; continue; } // 詰めの0xFF
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { out.push(bytes.subarray(o, o + 2)); o += 2; continue; }
    if (marker === 0xd9) { out.push(bytes.subarray(o, o + 2)); o += 2; break; } // EOI
    if (o + 4 > bytes.length) return { verdict: "rejected", reason: "jpeg_truncated" };
    const len = (bytes[o + 2]! << 8) | bytes[o + 3]!;
    if (len < 2 || o + 2 + len > bytes.length) return { verdict: "rejected", reason: "jpeg_truncated" };
    const seg = bytes.subarray(o, o + 2 + len);
    if (marker === 0xda) {
      // SOS以降はエントロピー符号化データ。末尾のEOIを見つけてそのまま复制する
      out.push(seg);
      o += 2 + len;
      const eoi = bytes.lastIndexOf(0xd9);
      if (eoi < 1 || bytes[eoi - 1] !== 0xff || eoi < o) return { verdict: "rejected", reason: "jpeg_no_eoi" };
      out.push(bytes.subarray(o, eoi - 1));
      out.push(bytes.subarray(eoi - 1, eoi + 1));
      o = eoi + 1;
      break;
    }
    // APP1(EXIF/XMP)とCOMは削除。ICC(APP2)は表示に影響するため残す
    if (marker === 0xe1 || marker === 0xfe) dropped++;
    else out.push(seg);
    o += 2 + len;
  }
  if (o !== bytes.length) return { verdict: "rejected", reason: "jpeg_trailing_data" };
  if (dropped === 0) return clean(bytes, false);
  return clean(concat(out), true);
}

/** WebP: RIFFチャンクを検証し、EXIF/XMPチャンクを削除してVP8Xのフラグを落とす */
function scanWebp(bytes: Uint8Array): ScanResult | Promise<ScanResult> {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return { verdict: "rejected", reason: "webp_bad_magic" };
  let o = 12;
  const chunks: { fourcc: string; data: Uint8Array }[] = [];
  let dropped = false;
  let vp8xFlags = -1;
  for (;;) {
    if (o + 8 > bytes.length) return { verdict: "rejected", reason: "webp_truncated" };
    const fourcc = ascii(bytes, o, 4);
    const size = new DataView(bytes.buffer, bytes.byteOffset + o).getUint32(4, true);
    if (o + 8 + size > bytes.length) return { verdict: "rejected", reason: "webp_truncated" };
    if (fourcc === "VP8X") vp8xFlags = bytes[o + 8]!;
    if (fourcc !== "EXIF" && fourcc !== "XMP ") chunks.push({ fourcc, data: bytes.subarray(o + 8, o + 8 + size) });
    else dropped = true;
    o += 8 + size + (size % 2);
    if (o === bytes.length) break;
  }
  if (!dropped) return clean(bytes, false);
  const body: Uint8Array[] = [new TextEncoder().encode("WEBP")];
  for (const chunk of chunks) {
    let data = chunk.data;
    if (chunk.fourcc === "VP8X" && vp8xFlags >= 0) {
      const fixed = new Uint8Array(data);
      fixed[0] = vp8xFlags & ~0x08 & ~0x04; // EXIF/XMPフラグを落とす
      data = fixed;
    }
    const head = new Uint8Array(8);
    for (let i = 0; i < 4; i++) head[i] = chunk.fourcc.charCodeAt(i);
    new DataView(head.buffer).setUint32(4, data.length, true);
    body.push(head, data);
    if (data.length % 2 === 1) body.push(new Uint8Array(1));
  }
  const payload = concat(body);
  const head = new Uint8Array(8);
  head.set(new TextEncoder().encode("RIFF"));
  new DataView(head.buffer).setUint32(4, payload.length, true);
  return clean(concat([head, payload]), true);
}

/** PDF: 字句検査。能動的埋込（JavaScript/起動/添付/リッチメディア）は拒否する */
const PDF_DANGEROUS = ["/JavaScript", "/JS", "/Launch", "/OpenAction", "/EmbeddedFile", "/RichMedia", "/SubmitForm", "/ImportData"];
function scanPdf(bytes: Uint8Array): ScanResult | Promise<ScanResult> {
  const text = new TextDecoder("latin1").decode(bytes);
  if (!text.startsWith("%PDF-")) return { verdict: "rejected", reason: "pdf_bad_magic" };
  if (!text.includes("%%EOF")) return { verdict: "rejected", reason: "pdf_incomplete" };
  const hit = PDF_DANGEROUS.find((t) => text.includes(t));
  if (hit) return { verdict: "rejected", reason: "pdf_active_content" };
  return clean(bytes, false);
}

/** CSV: UTF-8として厳密に解読できること。NULを含まないこと（式注入は出力側API-55で防ぐ） */
function scanCsv(bytes: Uint8Array): ScanResult | Promise<ScanResult> {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\u0000")) return { verdict: "rejected", reason: "csv_nul_byte" };
    if (text.trim().length === 0) return { verdict: "rejected", reason: "csv_empty" };
  } catch {
    return { verdict: "rejected", reason: "csv_invalid_utf8" };
  }
  return clean(bytes, false);
}

const SCAN_BY_TYPE: Record<string, (bytes: Uint8Array) => ScanResult | Promise<ScanResult>> = {
  "image/png": scanPng,
  "image/jpeg": scanJpeg,
  "image/webp": scanWebp,
  "application/pdf": scanPdf,
  "text/csv": scanCsv,
};

export const FileScanner = {
  /**
   * stagingの実体を検査する。取れない・読めない場合は unavailable（合格にも不合格にもしない）。
   * 取得した実体のhashが選択時のhashと違う場合は拒否（選択後に書き換えられた実体を渡さない）。
   */
  async scan(input: { key: string; contentType: string; sha256: string }, files: R2Bucket): Promise<ScanResult> {
    const scanner = SCAN_BY_TYPE[input.contentType];
    if (!scanner) return { verdict: "rejected", reason: "unsupported_content_type" };
    let bytes: Uint8Array;
    try {
      const obj = await files.get(input.key);
      if (!obj) return { verdict: "unavailable", reason: "object_missing" };
      bytes = new Uint8Array(await obj.arrayBuffer());
    } catch {
      return { verdict: "unavailable", reason: "storage_unavailable" };
    }
    if (input.sha256 && (await sha256OfBytes(bytes)) !== input.sha256) {
      return { verdict: "rejected", reason: "hash_mismatch" };
    }
    return scanner(bytes);
  },
};
