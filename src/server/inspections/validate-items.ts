import { LIMITS } from "../../shared/contracts/common";

/**
 * 点検明細の検査（T027、docs/04 inspection_items「様式版の型/必須検査」、D06）。
 * 保存される点検の明細が、承認された様式版の項目（code/型/必須/結果の選択肢）に合うことを確かめる。
 * 様式は架空の検証設定であり、正式な点検票ではない（D06未承認）。
 */

export interface InspectionItemSchemaEntry {
  code: string;
  label: string;
  valueType: "boolean" | "number" | "text" | "select";
  required: boolean;
  allowedResults?: string[];
}

export interface InspectionItemInput {
  code: string;
  result: string;
  value?: string | number | boolean;
  note?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: { code: string; reason: string }[];
}

/** 様式版の項目schema（contracts/assets.ts の ItemSchema と同じ形の保存データ）を検査する */
export function parseItemSchema(raw: string): InspectionItemSchemaEntry[] {
  return JSON.parse(raw) as InspectionItemSchemaEntry[];
}

/**
 * 明細を様式版で検査する:
 *  - schemaに無いcodeは不可（様式外の項目を勝手に増やさない）
 *  - required の項目は必須（明細が無い・結果が空は不可）
 *  - value の型は valueTypes に一致（boolean/number/text/select。selectは選択肢の文字列）
 *  - allowedResults がある項目は、その結果のいずれか
 */
export function validateItems(schema: InspectionItemSchemaEntry[], items: InspectionItemInput[]): ValidationResult {
  const errors: { code: string; reason: string }[] = [];
  const byCode = new Map(schema.map((s) => [s.code, s]));
  const seen = new Set<string>();
  for (const item of items) {
    const entry = byCode.get(item.code);
    if (!entry) {
      errors.push({ code: item.code, reason: "unknown_item_code" });
      continue;
    }
    if (seen.has(item.code)) {
      errors.push({ code: item.code, reason: "duplicate_item" });
      continue;
    }
    seen.add(item.code);
    const hasResult = typeof item.result === "string" && item.result.trim() !== "";
    if (entry.required && !hasResult) {
      errors.push({ code: item.code, reason: "required_result_missing" });
      continue;
    }
    if (entry.allowedResults && hasResult && !entry.allowedResults.includes(item.result)) {
      errors.push({ code: item.code, reason: "result_not_allowed" });
    }
    if (item.value !== undefined) {
      const typeOk =
        (entry.valueType === "boolean" && typeof item.value === "boolean") ||
        (entry.valueType === "number" && typeof item.value === "number" && Number.isFinite(item.value)) ||
        (entry.valueType === "text" && typeof item.value === "string" && item.value.length <= LIMITS.titleMax) ||
        (entry.valueType === "select" && typeof item.value === "string");
      if (!typeOk) errors.push({ code: item.code, reason: "value_type_mismatch" });
    }
  }
  for (const entry of schema) {
    if (entry.required && !seen.has(entry.code)) {
      errors.push({ code: entry.code, reason: "required_item_missing" });
    }
  }
  return { valid: errors.length === 0, errors };
}
