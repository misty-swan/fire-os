/**
 * 施設CSVの解析（T023、docs/05 API-53、D09/D19）。
 * テンプレート csv-facilities-v1: type,management_number,identifying_name,latitude,longitude,location_source,location_note
 * UTF-8（BOM可）・RFC4180風の引用符（"" でエスケープ、値内の改行/カンマ可）・CRLF/LF。
 * 未知の列は黙って落とさず、ヘッダーが一致しなければ解析失敗にする。
 */

export const CSV_TEMPLATE_VERSION = "csv-facilities-v1";
export const CSV_COLUMNS = ["type", "management_number", "identifying_name", "latitude", "longitude", "location_source", "location_note"] as const;
/** 1取込みの行数上限（docs/05 §1の配列上限と同じ。それ以上は分割して再取込みする） */
export const CSV_MAX_ROWS = 100;

export interface ParsedRow {
  rowNo: number;
  cells: string[];
}

export type CsvParseResult = { ok: true; rows: ParsedRow[] } | { ok: false; error: "bad_header" | "too_many_rows" | "invalid_utf8" | "empty" };

/** RFC4180風の分割。引用符内のカンマ・改行・"" エスケープを扱う */
function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else { inQuotes = false; }
      } else cell += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(cell); cell = ""; continue; }
    if (ch === "\r") { if (text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += ch;
  }
  // 末尾の改行なしの行
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  // 全セルが空の行は捨てる
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** 行をまたぐ引用符（値内の改行）はsplitCsvが処理済みの「物理行」ではなく論理行として返る */
export function parseFacilityCsv(bytes: Uint8Array, templateVersion: string): CsvParseResult {
  if (templateVersion !== CSV_TEMPLATE_VERSION) return { ok: false, error: "bad_header" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: "invalid_utf8" };
  }
  if (text.startsWith("﻿")) text = text.slice(1);
  const table = splitCsv(text);
  if (table.length === 0) return { ok: false, error: "empty" };
  const header = table[0]!.map((c) => c.trim());
  const expected = [...CSV_COLUMNS];
  if (header.length !== expected.length || header.some((c, i) => c !== expected[i])) return { ok: false, error: "bad_header" };
  const rows = table.slice(1).map((cells, i) => ({ rowNo: i + 1, cells }));
  if (rows.length > CSV_MAX_ROWS) return { ok: false, error: "too_many_rows" };
  return { ok: true, rows };
}

/** 1行の検証（docs/04 facilities と同じ規則。D19案の重複は呼び出し側がDBと照合する） */
export function validateFacilityRow(cells: string[]): { ok: true; normalized: Record<string, unknown> } | { ok: false; error: string } {
  const [type, managementNumber, identifyingName, latitude, longitude, locationSource, locationNote] = cells;
  const trim = (v: string | undefined) => v?.trim() ?? "";
  if (cells.length !== CSV_COLUMNS.length) return { ok: false, error: "column_count" };
  if (!["hydrant", "cistern", "box"].includes(trim(type))) return { ok: false, error: "invalid_type" };
  if (!trim(managementNumber) && !trim(identifyingName)) return { ok: false, error: "missing_ident" };
  const lat = Number(trim(latitude));
  const lng = Number(trim(longitude));
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { ok: false, error: "invalid_latitude" };
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { ok: false, error: "invalid_longitude" };
  if (!trim(locationSource)) return { ok: false, error: "missing_source" };
  if (!trim(locationNote)) return { ok: false, error: "missing_note" };
  return {
    ok: true,
    normalized: {
      type: trim(type),
      managementNumber: trim(managementNumber) || null,
      identifyingName: trim(identifyingName) || null,
      latitude: lat,
      longitude: lng,
      locationSource: trim(locationSource),
      locationNote: trim(locationNote),
    },
  };
}

/** CSV出力の式注入防止（docs/05 API-55）。=+-@ とタブで始まるセルは ' を前置し、区切りを含む値は引用する */
export function csvCell(value: string): string {
  const escaped = value.startsWith("=") || value.startsWith("+") || value.startsWith("-") || value.startsWith("@") || value.startsWith("\t")
    ? `'${value}`
    : value;
  return /[",\r\n]/.test(escaped) ? `"${escaped.replaceAll('"', '""')}"` : escaped;
}
