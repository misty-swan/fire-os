import type { AppEnv } from "../../env";
import { loadAttachment } from "../../attachments/upload";
import { sha256OfBytes } from "../../attachments/sizes";
import { CSV_TEMPLATE_VERSION, parseFacilityCsv, validateFacilityRow } from "../../gis/csv";
import { canonicalJson } from "../../mutations/hash";
import { enqueueJobStatement, type JobOutcome, type LeasedJob } from "../store";
import { registerJobHandler } from "../runner";

/**
 * 施設CSV取込みの解析job（T023）。
 * CSVの実体を検査して行ごとの有効/エラーを import_rows に書き、batch を ready にする。
 * 業務台帳（facilities）は変更しない。確定はT024の import.commit が行う。
 */
export async function parseImport(job: LeasedJob, env: AppEnv): Promise<JobOutcome> {
  const batch = await env.DB.prepare("SELECT * FROM import_batches WHERE id = ?").bind(job.sourceId)
    .first<{ id: string; unit_id: string; status: string; version: number; attachment_id: string; template_version: string }>();
  if (!batch || batch.unit_id !== job.unitId) return { kind: "stale", errorCode: "batch_missing" };
  if (batch.version !== job.sourceVersion) return { kind: "stale", errorCode: "source_changed" };
  if (batch.status === "ready" || batch.status === "committed" || batch.status === "committing") return { kind: "stale", errorCode: "already_parsed" };
  if (batch.status !== "pending") return { kind: "stale", errorCode: "unexpected_status" };

  const fail = async (code: string): Promise<JobOutcome> => {
    const res = await env.DB.prepare(
      "UPDATE import_batches SET status = 'failed', error_code = ?, version = version + 1, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ? AND status = 'pending'",
    ).bind(code, new Date().toISOString(), batch.id, batch.unit_id, batch.version).run();
    return (res.meta.changes ?? 0) === 1 ? { kind: "succeeded", resultRef: `failed:${code}` } : { kind: "stale", errorCode: "source_changed" };
  };

  const att = await loadAttachment(env, batch.attachment_id, batch.unit_id);
  if (!att || !att.ready_key || !att.sha256) return fail("attachment_not_ready");
  let bytes: Uint8Array;
  try {
    const obj = await env.FILES.get(att.ready_key);
    if (!obj) return { kind: "retryable", errorCode: "csv_object_missing" };
    bytes = new Uint8Array(await obj.arrayBuffer());
  } catch {
    return { kind: "retryable", errorCode: "storage_unavailable" };
  }

  // 解析中へ動かす（二重実行の間はこの更新の版ガードが1つしか通さない）
  const nowIso = new Date().toISOString();
  const marked = await env.DB.prepare(
    "UPDATE import_batches SET status = 'parsing', version = version + 1, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ? AND status = 'pending'",
  ).bind(nowIso, batch.id, batch.unit_id, batch.version).run();
  if ((marked.meta.changes ?? 0) !== 1) return { kind: "stale", errorCode: "source_changed" };
  const parsingVersion = batch.version + 1;

  const parsed = parseFacilityCsv(bytes, batch.template_version);
  if (!parsed.ok) return fail(parsed.error);

  // 行ごとに検証（ファイル内の番号重複は先に出た行を優先）
  const seenNumbers = new Map<string, number>();
  const results: { rowNo: number; error: string | null; normalized: Record<string, unknown> | null }[] = [];
  for (const row of parsed.rows) {
    const valid = validateFacilityRow(row.cells);
    if (!valid.ok) { results.push({ rowNo: row.rowNo, error: valid.error, normalized: null }); continue; }
    const key = `${valid.normalized.type}:${valid.normalized.managementNumber ?? ""}`;
    if (valid.normalized.managementNumber && seenNumbers.has(key)) {
      results.push({ rowNo: row.rowNo, error: "duplicate_number_in_file", normalized: null });
      continue;
    }
    if (valid.normalized.managementNumber) seenNumbers.set(key, row.rowNo);
    results.push({ rowNo: row.rowNo, error: null, normalized: valid.normalized });
  }

  // 台帳にある番号との重複もエラーにする（D19: 分団×種別×番号の一意。確定時の409を避ける）
  for (const r of results.filter((x) => x.error === null)) {
    const n = (r.normalized as { managementNumber: string | null }).managementNumber;
    if (!n) continue;
    const t = (r.normalized as { type: string }).type;
    const exists = await env.DB.prepare("SELECT id FROM facilities WHERE unit_id = ? AND type = ? AND management_number = ?")
      .bind(batch.unit_id, t, n).first<{ id: string }>();
    if (exists) { r.error = "duplicate_number_in_master"; r.normalized = null; }
  }

  // 行を書き込む（D1の1文100bind制限に対して余裕のある分割で）
  const inserts = results.map((r) =>
    env.DB.prepare(
      "INSERT INTO import_rows (id, unit_id, batch_id, row_no, normalized_json, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      crypto.randomUUID(), batch.unit_id, batch.id, r.rowNo,
      r.normalized ? JSON.stringify(r.normalized) : null, r.error, nowIso,
    ),
  );
  for (let i = 0; i < inserts.length; i += 40) {
    await env.DB.batch(inserts.slice(i, i + 40));
  }

  const validCount = results.filter((r) => r.error === null).length;
  const previewHash = await sha256OfBytes(new TextEncoder().encode(canonicalJson({ rows: results.map((r) => [r.rowNo, r.error]) })));
  const inputHash = await sha256OfBytes(bytes);
  const unit = await env.DB.prepare("SELECT dataset_revision FROM units WHERE id = ?").bind(batch.unit_id).first<{ dataset_revision: number }>();
  const done = await env.DB.batch([
    env.DB.prepare(
      "UPDATE import_batches SET status = 'ready', input_hash = ?, preview_hash = ?, total_rows = ?, valid_rows = ?, error_rows = ?, base_dataset_revision = ?, version = version + 1, updated_at = ? " +
        "WHERE id = ? AND unit_id = ? AND version = ? AND status = 'parsing'",
    ).bind(inputHash, previewHash, results.length, validCount, results.length - validCount, unit!.dataset_revision, nowIso, batch.id, batch.unit_id, parsingVersion),
  ]);
  if ((done[0]?.meta.changes ?? 0) !== 1) return { kind: "stale", errorCode: "source_changed" };
  return { kind: "succeeded", resultRef: `ready:${validCount}/${results.length}` };
}

// job登録（Cron/Queueと同じ登録点）
registerJobHandler("import.parse", parseImport);
void enqueueJobStatement;
void CSV_TEMPLATE_VERSION;
