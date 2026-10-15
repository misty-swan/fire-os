import { z } from "zod";
import manifestJson from "../../../config/report-templates/manifest.json";
import testActivityV1Json from "../../../config/report-templates/test-activity-v1.json";
import { HttpError } from "../http";

/**
 * 帳票様式artifact（docs/04 §3.5末尾、docs/14 D20、T056）。
 * - 帳票のtemplateVersionは点検様式（inspection_templates）と**別の**版付き不変設定artifact。manifestが
 *   allowlistの正本で、サーバーは読み込むだけ（API経由のCRUDは無い＝docs/04「新しい業務管理CRUDがあるとは主張しない」）。
 * - artifactは静的importでbundleに埋め込み、取得時にmanifestのhashと突き合わせる（正規化JSON＝
 *   JSON.parse→JSON.stringifyのUTF-8のSHA-256。不一致・不在はfail-closedで422）。
 * - artifactは架空の検証設定。実在の団体・正式帳票・承認を示さない（docs/14 D06の点検様式と同じ扱い）。
 */

const manifestSchema = z.object({
  note: z.string().min(1),
  templates: z
    .array(
      z.object({
        id: z.string().min(1),
        version: z.string().min(1),
        file: z.string().min(1),
        hash: z.string().regex(/^[0-9a-f]{64}$/),
        fieldSchemaSummary: z.array(z.string().min(1)).min(1),
        sourceRef: z.string().min(1),
        approverSectionNote: z.string().min(1),
      }),
    )
    .min(1),
});

/** 様式の項目（fieldSchema。computed欄の値は実績からサーバー計算し、input欄は人の本文） */
export interface ReportTemplateField {
  code: string;
  label: string;
  valueType: string;
  source: "input" | "computed" | "approverSection";
  required: boolean;
  computedFrom: string | null;
}

/** 帳票様式（docs/04 §3.5末尾「ID/版/hash/項目schema/原様式/承認者」） */
export interface ReportTemplate {
  id: string;
  version: string;
  /** manifestに固定したhash（取得時にartifactと再照合する） */
  hash: string;
  title: string;
  /** 原様式参照（架空の参照名） */
  sourceRef: string;
  /** 実団体承認済みと表示しないための注記（docs/14 D20） */
  fictionalNote: string;
  approverSection: Record<string, unknown>;
  fieldSchema: ReportTemplateField[];
}

/** artifactの登録点。新しい様式版はこの表とmanifest.jsonを一緒に更新する（bundleに静的importで埋め込む） */
const ARTIFACT_FILES: Record<string, unknown> = {
  "test-activity-v1.json": testActivityV1Json,
};

const manifest = manifestSchema.parse(manifestJson);
// 起動時に読むだけの検証（module読み込み時）。CRUDは無いので、manifestとbundleの不整合はここで落とす
for (const entry of manifest.templates) {
  if (!(entry.file in ARTIFACT_FILES)) {
    throw new Error(`report-templates manifest: ${entry.file} がbundleにありません（templates.tsの静的importに追加してください）`);
  }
}

const fieldSchemaSchema = z.array(
  z.object({
    code: z.string().min(1),
    label: z.string().min(1),
    valueType: z.string().min(1),
    source: z.enum(["input", "computed", "approverSection"]),
    required: z.boolean().optional(),
    computedFrom: z.string().min(1).nullable().optional(),
  }),
).min(1);

const cache = new Map<string, ReportTemplate>();

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * allowlistにある版だけを返す（docs/04 §3.5末尾「APIはallowlistにある版のみ受理。存在しない版は422」）。
 * manifestのhashと一致しないartifactも受理しない（fail-closed）。
 */
export async function getReportTemplate(version: string): Promise<ReportTemplate> {
  const cached = cache.get(version);
  if (cached) return cached;
  const entry = manifest.templates.find((t) => t.version === version);
  if (!entry) {
    throw new HttpError("UNAPPROVED_POLICY", undefined, [{ field: "templateVersion", reason: "version_not_allowed" }]);
  }
  const artifact = ARTIFACT_FILES[entry.file];
  // bundleに埋め込んだオブジェクトの正規化JSONでhashを再計算（manifest作成時と同じ手順。キー順は入力どおり）
  const actualHash = await sha256Hex(JSON.stringify(artifact));
  if (actualHash !== entry.hash) {
    console.error(JSON.stringify({ action: "report_template.hash_mismatch", version: entry.version }));
    throw new HttpError("UNAPPROVED_POLICY", undefined, [{ field: "templateVersion", reason: "hash_mismatch" }]);
  }
  const parsed = z
    .object({
      id: z.string().min(1),
      version: z.string().min(1),
      title: z.string().min(1),
      note: z.string().min(1),
      sourceRef: z.string().min(1),
      approverSection: z.record(z.string(), z.unknown()),
      fieldSchema: fieldSchemaSchema,
    })
    .safeParse(artifact);
  if (!parsed.success || parsed.data.id !== entry.id || parsed.data.version !== entry.version) {
    console.error(JSON.stringify({ action: "report_template.invalid_artifact", version: entry.version }));
    throw new HttpError("UNAPPROVED_POLICY", undefined, [{ field: "templateVersion", reason: "invalid_artifact" }]);
  }
  const template: ReportTemplate = {
    id: parsed.data.id,
    version: parsed.data.version,
    hash: entry.hash,
    title: parsed.data.title,
    sourceRef: parsed.data.sourceRef,
    fictionalNote: parsed.data.note,
    approverSection: parsed.data.approverSection,
    fieldSchema: parsed.data.fieldSchema.map((f) => ({
      code: f.code,
      label: f.label,
      valueType: f.valueType,
      source: f.source,
      required: f.required ?? false,
      computedFrom: f.computedFrom ?? null,
    })),
  };
  cache.set(version, template);
  return template;
}
