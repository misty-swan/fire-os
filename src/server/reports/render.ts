import { csvCell } from "../gis/csv";
import { getReportTemplate, type ReportTemplate } from "./templates";

/**
 * 帳票の出力（T058、docs/05 API-61「format=pdf/csv;承認版のみ/D20」、docs/14 D20）。
 *
 * - 入力は**承認済みの版**（ApprovedReportVersion）だけ。未承認の版はrouteで出せない
 *   （API-61「承認版のみ」。未承認はnot 200）。
 * - 数値（参加人数・実施日時）は**承認時にサーバーが計算してconfirmed_payloadへ固定した値**
 *   を使う（docs/16 T058。元実績の後続変更で承認済みの出力が書変わりしない＝原本）。人の本文
 *   （text）は様式のinput欄のまま載る。
 * - CSVはallowlist帳票のfieldSchemaに沿った列で、**CSV式注入のescape**（=,+,-,@とタブで始まる
 *   セルの無害化。施設書き出し src/server/gis/csv.ts のcsvCellと同じ流儀。docs/05 API-55）。
 * - PDFは依存を増やさない最小実装（PDF 1.4、テキストのみ、標準CJKフォント参照）:
 *   フォントはPDF仕様Annex Dの標準CJKフォント（HeiseiMin-W3／UniJIS-UCS2-H）を**非埋め込みで
 *   参照**する。フォントを埋め込まないため、日本語の実表示はビューアのフォント代替に依存し、
 *   **実フォントでの検証が残る（局所完了）**。ローカル試験は「PDFとして妥当な先頭バイト
 *   （%PDF-）＋承認版のみ出せること＋CSVの内容正しさ」まで（docs/evidence/V07-report-render.md）。
 * - 改ページは固定行数（LINES_PER_PAGE）で行い、長い行は半角換算の表示幅で折り返す（簡易実装。
 *   文字幅は全角=2/半角=1の近似）。
 */

/** 出力の対象（承認済み版＋承認時に確定した値。docs/05 API-61）。routeが組み立てる */
export interface ApprovedReportVersion {
  /** 使用した様式版（allowlist。getReportTemplateでhash照合し、不在・不一致は422でfail-closed） */
  templateVersion: string;
  revisionNo: number;
  /** 人の入力本文（approved版では不変。様式のinput欄） */
  text: string;
  approvedAt: string;
  /** 承認時に確定した計算欄（fieldSchemaのcode→表示値。数値はサーバー計算値＝docs/16 T058） */
  computedFields: Record<string, string>;
  /** 承認者欄の表示名（作成者＝report_versions.created_byの団員、承認者＝reviewer_member_id） */
  creatorName: string | null;
  approverName: string | null;
}

/** 様式の1欄（PDFの「label: value」行とCSVの列の両方に使う） */
interface FieldRow {
  code: string;
  label: string;
  value: string;
}

/** fieldSchemaに沿って欄を並べる（approverSectionは作成者/承認者/承認日の3欄へ展開） */
function fieldRows(template: ReportTemplate, version: ApprovedReportVersion): FieldRow[] {
  const rows: FieldRow[] = [];
  for (const f of template.fieldSchema) {
    if (f.source === "computed") {
      rows.push({ code: f.code, label: f.label, value: version.computedFields[f.code] ?? "" });
    } else if (f.source === "input") {
      rows.push({ code: f.code, label: f.label, value: version.text });
    } else {
      // 承認者欄（docs/04 §3.5末尾「承認者欄注記」。作成者/承認者/承認日の配置はartifactの定義）
      rows.push({ code: "creator", label: "作成者", value: version.creatorName ?? "" });
      rows.push({ code: "approver", label: "承認者", value: version.approverName ?? "" });
      rows.push({ code: "approvedAt", label: "承認日", value: version.approvedAt });
    }
  }
  return rows;
}

/** CSV（docs/05 API-61「binary/CSV」。式注入escapeはcsvCell。BOM＋CRLFは施設書き出しと同じ） */
function csvDocument(template: ReportTemplate, version: ApprovedReportVersion): string {
  const rows = fieldRows(template, version);
  const codes = rows.map((r) => r.code);
  const values = rows.map((r) => r.value);
  // 正式様式未承認（docs/14 D20）であることを出力にも残す（実団体の承認済み帳票と偽らない）
  codes.push("templateNote");
  values.push(template.fictionalNote);
  const lines = [codes, values].map((cells) => cells.map(csvCell).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

// --- 最小PDF（PDF 1.4。テキストのみ。依存ライブラリは使わない） ---

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 48;
const FONT_SIZE = 11;
const LINE_HEIGHT = 16;
/** 1行の最大表示幅（半角換算。全角は2） */
const MAX_LINE_WIDTH = 88;
const LINES_PER_PAGE = Math.floor((PAGE_HEIGHT - MARGIN * 2) / LINE_HEIGHT);

/** 全角=2/半角=1の近似表示幅（文字幅の実測はV07の実表示検証と一緒に見直す） */
function charWidth(codePoint: number): number {
  return codePoint > 0xff ? 2 : 1;
}

function wrapLine(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let width = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 1);
    if (width + w > MAX_LINE_WIDTH) {
      lines.push(current);
      current = "";
      width = 0;
    }
    current += ch;
    width += w;
  }
  lines.push(current);
  return lines;
}

/** テキストをUTF-16BEの16進文字列へ（UniJIS-UCS2-Hの2バイトコード。escaping不要） */
function utf16beHex(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    out += text.charCodeAt(i).toString(16).padStart(4, "0");
  }
  return out.toUpperCase();
}

/** PDFページに載せる行（様式の欄順。本文の改行はそのまま行分割） */
function pdfLines(template: ReportTemplate, version: ApprovedReportVersion): string[] {
  const lines: string[] = [];
  lines.push(template.title);
  lines.push(`様式版: ${template.version} / 第${version.revisionNo}版`);
  lines.push("");
  for (const row of fieldRows(template, version)) {
    const parts = row.value.split("\n");
    lines.push(`${row.label}: ${parts[0] ?? ""}`);
    for (const extra of parts.slice(1)) lines.push(extra);
  }
  lines.push("");
  lines.push(template.fictionalNote);
  return lines.flatMap(wrapLine);
}

/**
 * PDF 1.4バイト列を組み立てる。オブジェクトは1=Catalog、2=Pages、3=Font、以降が
 * （Contents, Page）の対。xrefのオフセットはバイト長で計算する（全パートはASCIIのみ＝
 * テキストはUTF-16BEの16進列のため、バイト長=文字列長で一致する）。
 */
function pdfDocument(template: ReportTemplate, version: ApprovedReportVersion): Uint8Array {
  const lines = pdfLines(template, version);
  const bodies: string[] = [];
  const add = (body: string): number => {
    bodies.push(body);
    return bodies.length; // 1始まりのオブジェクト番号
  };

  // 標準CJKフォント（PDF仕様Annex D。非埋め込み＝ビューアのフォント代替に依存。V07で実検証）
  const fontNum = add(
    "<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiMin-W3 /Encoding /UniJIS-UCS2-H " +
      "/DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiMin-W3 " +
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /DW 1000 >>] >>",
  );
  const pageNums: number[] = [];
  for (let p = 0; p < lines.length; p += LINES_PER_PAGE) {
    const pageLines = lines.slice(p, p + LINES_PER_PAGE);
    const content = pageLines
      .map((line, i) => {
        const y = PAGE_HEIGHT - MARGIN - FONT_SIZE - i * LINE_HEIGHT;
        return `BT /F1 ${FONT_SIZE} Tf ${MARGIN} ${y} Td <${utf16beHex(line)}> Tj ET`;
      })
      .join("\n");
    const contentNum = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    pageNums.push(
      add(
        `<< /Type /Page /Parent %PAGES% 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
          `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
      ),
    );
  }
  const pagesNum = add(
    `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNums.length} >>`,
  );
  const catalogNum = add(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);
  // Pageの/ParentはPagesの番号が確定してから埋める
  bodies[pageNums[0]! - 1] = bodies[pageNums[0]! - 1]!.replace("%PAGES%", String(pagesNum));

  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let offset = 0;
  const push = (s: string) => {
    const b = encoder.encode(s);
    parts.push(b);
    offset += b.length;
  };
  push("%PDF-1.4\n");
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets[i] = offset;
    push(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xrefOffset = offset;
  let xref = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${bodies.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  push(xref);

  const all = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}

/** bytesを1チャンクのReadableStreamへ（Workers互換。Blobは使わない） */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * 承認済み帳票の出力（docs/16 T058のInterface）。様式はallowlist照合（fail-closedで422）を
 * ここでも行う（routeとrenderのどちらか一方の迂回を許さない）。
 */
export async function renderReport(
  version: ApprovedReportVersion,
  format: "pdf" | "csv",
): Promise<ReadableStream<Uint8Array>> {
  const template = await getReportTemplate(version.templateVersion);
  const bytes = format === "csv" ? new TextEncoder().encode(csvDocument(template, version)) : pdfDocument(template, version);
  return streamOf(bytes);
}
