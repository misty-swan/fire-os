import type { ExtractedDocument } from "./extract";

/**
 * 抽出原文のchunk化（T064、docs/04:152、docs/06 §5「ページ/節/文字offsetを保持」）。
 *
 * - **決定的・AI不使用**: 入力（ExtractedDocument）が同じなら出力も常に同じ。検索（T065/T066）や
 *   回答（T067）の根拠はこのchunkとsource_offsetsを通って原本へ逆引きできる。
 * - **chunk.textは頁テキストの部分列そのもの**（正規化・要約・空白の詰めを行わない）。
 *   source_offsets.start/end が頁テキスト内の区間で、`pageText.slice(start,end) === text` が常に成立する。
 *   区切りの改行1字はchunkに含まない（次のchunkのstartがそれに当たる）。
 * - 区切り: ページ境界（頁をまたがない）／見出し行（見出しで必ずchunkを閉じる）／
 *   MAX_CHUNK_CHARS超過（行境界で分割。1行が上限を超えるときだけ行の途中で分割する）。
 * - sectionは見出しの決定的ルール（isHeadingLine。docs/16 T064）だけで付け、AIは使わない。
 */

/** 1chunkの上限文字数（document_chunks.textのCHECK上限は20,000。検索用途の分割幅はT065/T066で再調整できる） */
export const MAX_CHUNK_CHARS = 200;

/** 1版あたりのchunk上限（handlerが1つのD1 batchで確定できる範囲。超過は捏造せず保留にする） */
export const CHUNK_MAX_PER_VERSION = 300;

/** 抽出器の版（source_offsets.extractorVersion。抽出方式を変えたら上げる） */
export const EXTRACTOR_VERSION = "document-extract-v1";

/** source_offsets（document_chunks.source_offsetsのJSON語彙。docs/06 §5の頁/節/文字offset） */
export interface DocumentChunkSourceOffsets {
  /** 原本のsha256（このoffsetが前提とする抽出版の同一性。document_versions.content_hashと一致する） */
  contentHash: string;
  /** 抽出器の版 */
  extractorVersion: string;
  /** 原本の頁（1始まり。PDFのページ境界） */
  pageNo: number;
  /** 頁テキスト内の開始offset（0始まり。UTF-16コード単位） */
  start: number;
  /** 頁テキスト内の終端（含まない） */
  end: number;
}

/** document_chunksへの書込1件（handlerがこれをD1 batchで確定する） */
export interface DocumentChunkInput {
  /** 1始まりで版内連番（UNIQUE(unit_id,version_id,chunk_no)） */
  chunkNo: number;
  /** 原本の頁（PDF抽出では必ず1以上。将来の非頁形式のためnull可） */
  pageNo: number | null;
  /** 見出し（chunkの開始位置で有効な見出し。無ければnull） */
  section: string | null;
  /** 頁テキストの部分列そのもの（1〜MAX_CHUNK_CHARS。20,000上限の内側） */
  text: string;
  sourceOffsets: DocumentChunkSourceOffsets;
  /**
   * chunk同定用の決定的ダイジェスト（FNV-1a 64bit×2の16進。T066のindex_key候補・重複検出に使う）。
   * **暗号学的hashではない**（改竄検出の正はcontent_hash=原本のsha256が担う）。
   */
  hash: string;
}

/**
 * 引用spanの原文逆引き（T067の回答・引用検証と試験が使う）。
 * chunk内の位置（spanStart/spanEnd）を、頁テキスト上の位置へ写像して該当文字列を返す。
 */
export function resolveCitationSpan(
  pageText: string,
  offsets: Pick<DocumentChunkSourceOffsets, "start" | "end">,
  spanStart: number,
  spanEnd: number,
): string {
  if (!Number.isInteger(spanStart) || !Number.isInteger(spanEnd) || spanStart < 0 || spanEnd < spanStart) {
    throw new Error("resolveCitationSpan: spanの位置が不正です");
  }
  if (offsets.start < 0 || offsets.end > pageText.length) {
    throw new Error("resolveCitationSpan: source_offsetsが頁テキストの範囲外です");
  }
  if (offsets.end - offsets.start < spanEnd) throw new Error("resolveCitationSpan: spanがchunkの範囲外です");
  return pageText.slice(offsets.start + spanStart, offsets.start + spanEnd);
}

/**
 * 見出しの決定的ルール（AI不使用。docs/16 T064）:
 *  - 「第N章/節/編」（Nは半角・全角数字・漢数字）
 *  - 行頭の「1.」「2．」「(1)」「（一）」等の番号付き短い行
 *  - それ以外の12文字以内で句読点を含まない行（「備考」「注意」等）
 */
export function isHeadingLine(line: string): boolean {
  if (line.length === 0 || line.length > 40) return false;
  if (/[。、！？：；,.;:!?]/.test(line)) return false;
  if (/^第[0-9０-９一二三四五六七八九十百]+[章節編]/.test(line)) return true;
  if (/^[0-9０-９]{1,3}[.．、　 ]/.test(line)) return true;
  if (/^[（(][0-9０-９一二三四五六七八九十]+[)）]/.test(line)) return true;
  return line.length <= 12;
}

/** FNV-1a（64bit相当を2系統。JavaScriptの数値精度で安全な32bit演算の組合せ） */
function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

const chunkDigest = (offsets: DocumentChunkSourceOffsets, text: string): string =>
  (fnv1a32(text, 0x811c9dc5) ^ fnv1a32(`${offsets.contentHash}:${offsets.pageNo}`, 0x01000193)).toString(16).padStart(8, "0") +
  fnv1a32(`${offsets.start}:${offsets.end}:${text.length}:${text}`, 0x811c9dc5).toString(16).padStart(8, "0");

interface OpenChunk {
  pageNo: number;
  section: string | null;
  start: number;
  end: number;
}

/**
 * ExtractedDocumentをchunkへ分割する（決定的。docs/16 T064のInterface）。
 * text/source_offsetsは必ず頁テキストと一致する（extract.tsの抽出器契約）。
 */
export function chunkDocument(input: ExtractedDocument): DocumentChunkInput[] {
  const chunks: DocumentChunkInput[] = [];
  const flush = (pageText: string, open: OpenChunk | null) => {
    if (!open) return;
    const text = pageText.slice(open.start, open.end);
    if (text.length === 0 || text.length > MAX_CHUNK_CHARS || text.length > 20_000) {
      throw new Error(`chunkDocument: chunkの長さが不正です（${text.length}字）`);
    }
    const sourceOffsets: DocumentChunkSourceOffsets = {
      contentHash: input.contentHash,
      extractorVersion: input.extractorVersion,
      pageNo: open.pageNo,
      start: open.start,
      end: open.end,
    };
    chunks.push({
      chunkNo: chunks.length + 1,
      pageNo: open.pageNo,
      section: open.section,
      text,
      sourceOffsets,
      hash: chunkDigest(sourceOffsets, text),
    });
  };

  for (const page of input.pages) {
    const pageText = page.text;
    // 行の開始位置（頁テキスト内。行間の"\n"1字を含めて採番する）
    const lineStarts: number[] = [];
    const lines: string[] = [];
    {
      let at = 0;
      for (const line of pageText.split("\n")) {
        lineStarts.push(at);
        lines.push(line);
        at += line.length + 1;
      }
    }
    let currentSection: string | null = null;
    let open: OpenChunk | null = null;
    const close = () => {
      flush(pageText, open);
      open = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const start = lineStarts[i]!;
      const end = start + line.length;
      if (line.length > MAX_CHUNK_CHARS) {
        // 1行が上限を超える: 行の途中で分割する（offsetは頁テキストに厳密に一致させる）
        close();
        for (let at = start; at < end; at += MAX_CHUNK_CHARS) {
          const pieceEnd = Math.min(at + MAX_CHUNK_CHARS, end);
          const text = pageText.slice(at, pieceEnd);
          const sourceOffsets: DocumentChunkSourceOffsets = {
            contentHash: input.contentHash,
            extractorVersion: input.extractorVersion,
            pageNo: page.pageNo,
            start: at,
            end: pieceEnd,
          };
          chunks.push({
            chunkNo: chunks.length + 1,
            pageNo: page.pageNo,
            section: currentSection,
            text,
            sourceOffsets,
            hash: chunkDigest(sourceOffsets, text),
          });
        }
        continue;
      }
      if (isHeadingLine(line)) {
        close();
        currentSection = line;
        open = { pageNo: page.pageNo, section: currentSection, start, end };
        continue;
      }
      if (line.length === 0) continue; // 空行はchunkに含めない（次の行が挟む区間として現れる）
      if (open && end - open.start > MAX_CHUNK_CHARS) close(); // 行境界で分割
      if (!open) open = { pageNo: page.pageNo, section: currentSection, start, end };
      else open.end = end; // 空行や見出し以外は現在のchunkへ延ばす（間の"\n"は区間に含まれる）
    }
    close(); // ページ境界で必ず閉じる（docs/16 T064「ページ区切りはPDFのページ境界」）
  }
  return chunks;
}
