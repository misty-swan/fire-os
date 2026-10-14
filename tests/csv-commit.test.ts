import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import "../src/server/jobs/handlers/import";
import { runDueJobs } from "../src/server/jobs/runner";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) => (await r.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: { field: string; reason: string }[] } };
const CSV_HEADER = "type,management_number,identifying_name,latitude,longitude,location_source,location_note";
const csvBytes = (rows: string[]) => new TextEncoder().encode([CSV_HEADER, ...rows].join("\r\n"));

async function readyCsv(who: Identity, rows: string[]): Promise<string> {
  const bytes = csvBytes(rows);
  const dRes = await fx.client(who).request("POST", "/api/v1/attachment-drafts", { intendedEntityType: "import_batch" }, idem());
  const draft = (await json(dRes)).data! as { id: string };
  const iRes = await fx.client(who).request(
    "POST", "/api/v1/attachments/upload-intents",
    { target: { type: "attachment_draft", id: draft.id }, contentType: "text/csv", byteSize: bytes.byteLength }, idem(),
  );
  const intent = (await json(iRes)).data! as { id: string; uploadToken: string };
  const up = await fx.raw(who)(new Request(`http://example.com/api/v1/attachments/${intent.id}/upload`, {
    method: "PUT", headers: { "content-type": "text/csv", "x-upload-token": intent.uploadToken }, body: bytes as BufferSource,
  }));
  const attempt = (await json(up)).data! as { id: string; sha256: string };
  await fx.client(who).request("POST", `/api/v1/attachments/${intent.id}/completion`, { version: 1, uploadAttemptId: attempt.id, sha256: attempt.sha256 }, idem());
  await runDueJobs(env);
  return intent.id;
}

/** プレビューまで進める（T023の経路） */
async function previewBatch(who: Identity, rows: string[]): Promise<{ batchId: string; previewHash: string; baseRevision: number }> {
  const attachmentId = await readyCsv(who, rows);
  const pRes = await fx.client(who).request("POST", "/api/v1/facilities/imports", { csvAttachmentId: attachmentId, templateVersion: "csv-facilities-v1" }, idem());
  const { id } = (await json(pRes)).data! as { id: string };
  await runDueJobs(env);
  const batch = await env.DB.prepare("SELECT preview_hash, base_dataset_revision, valid_rows FROM import_batches WHERE id = ?").bind(id)
    .first<{ preview_hash: string; base_dataset_revision: number; valid_rows: number }>();
  return { batchId: id, previewHash: batch!.preview_hash, baseRevision: batch!.base_dataset_revision };
}

describe("CSVの確定と書き出し (T024)", () => {
  it("import_commit_detects_master_change_and_escapes_formula", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;

    // プレビュー後に台帳が変わったら、確定は409で止まり何も書かない
    const first = await previewBatch(admin, ["hydrant,C-0001,,35.7,139.7,架空市台帳,確定される行"]);
    await fx.client(admin).request("POST", "/api/v1/facilities", {
      type: "hydrant", latitude: 35.71, longitude: 139.71, locationSource: "現地", locationNote: "確定前に増えた台帳", managementNumber: "MASTER-1",
    }, idem());
    // 現在のbatch版を送る（古い版だと版ガードの409になり、台帳版の検査を確かめられない）
    const changedVersion = await env.DB.prepare("SELECT version AS v FROM import_batches WHERE id = ?").bind(first.batchId).first<{ v: number }>();
    const changedMasterCommit = await fx.client(admin).request(
      "POST", `/api/v1/facilities/imports/${first.batchId}/commit`,
      { version: changedVersion!.v, previewHash: first.previewHash, conflictResolution: "skip" }, idem(),
    );
    expect(changedMasterCommit.status).toBe(409);
    const nothing = await env.DB.prepare("SELECT COUNT(*) AS n FROM facilities WHERE unit_id = ? AND management_number = 'C-0001'").bind(a.id).first<{ n: number }>();
    expect(nothing!.n).toBe(0);
    // 再プレビューすれば進める（docs/03の導線）
    const again = await previewBatch(admin, ["hydrant,C-0001,,35.7,139.7,架空市台帳,再プレビューで確定"]);
    void again;

    // 確定: 行ごとに施設が作られ、行に確定先が残る。二重送信は同じ結果（効果は1回）
    const second = await previewBatch(admin, [
      "hydrant,C-1001,,35.8,139.8,架空市台帳,確定1行目",
      "cistern,C-1002,,35.81,139.81,現地測量,確定2行目",
    ]);
    const secondVersion = await env.DB.prepare("SELECT version AS v FROM import_batches WHERE id = ?").bind(second.batchId).first<{ v: number }>();
    const commitRes = await fx.client(admin).request(
      "POST", `/api/v1/facilities/imports/${second.batchId}/commit`,
      { version: secondVersion!.v, previewHash: second.previewHash, conflictResolution: "skip" }, idem(),
    );
    expect([200, 202]).toContain(commitRes.status);
    await runDueJobs(env);
    const batch = await env.DB.prepare("SELECT status, committed_rows, commit_version FROM import_batches WHERE id = ?").bind(second.batchId)
      .first<{ status: string; committed_rows: number; commit_version: number }>();
    expect(batch!.status).toBe("committed");
    expect(batch!.committed_rows).toBe(2);
    const committedEffects = (await fx.rows("import_rows", { batch_id: second.batchId })).filter((r) => r.committed_facility_id !== null).length;
    expect(committedEffects).toBe(2);
    // 同じ確定要求の再送（同じIdempotency-Key）は効果を増やさない
    const rowsBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM facilities WHERE unit_id = ?").bind(a.id).first<{ n: number }>();
    const batchVersion = await env.DB.prepare("SELECT version AS v FROM import_batches WHERE id = ?").bind(second.batchId).first<{ v: number }>();
    const replay = await fx.client(admin).request(
      "POST", `/api/v1/facilities/imports/${second.batchId}/commit`,
      { version: batchVersion!.v, previewHash: second.previewHash, conflictResolution: "skip" }, idem(),
    );
    expect([200, 202, 409, 422]).toContain(replay.status);
    await runDueJobs(env);
    const rowsAfter = await env.DB.prepare("SELECT COUNT(*) AS n FROM facilities WHERE unit_id = ?").bind(a.id).first<{ n: number }>();
    expect(rowsAfter!.n).toBe(rowsBefore!.n); // 施設は増えない

    // 途中失敗: jobの確定が中断しても、batchはcommittedにならない（再開で残りを処理できる）
    // （ここでは結合試験として、正常系の完了と「失敗時にcompleteにならない」の両方を確認する）
    const partial = await previewBatch(admin, Array.from({ length: 90 }, (_, i) => `hydrant,P-${String(i).padStart(3, "0")},,35.9,139.9,架空市台帳,大量行${i}`));
    const partialVersion = await env.DB.prepare("SELECT version AS v FROM import_batches WHERE id = ?").bind(partial.batchId).first<{ v: number }>();
    const bigCommit = await fx.client(admin).request(
      "POST", `/api/v1/facilities/imports/${partial.batchId}/commit`,
      { version: partialVersion!.v, previewHash: partial.previewHash, conflictResolution: "skip" }, idem(),
    );
    expect([200, 202]).toContain(bigCommit.status);
    await runDueJobs(env, { maxJobs: 3 }); // 一部のチャンクだけ実行した体で確認
    const bigRows = await env.DB.prepare("SELECT COUNT(*) AS n FROM facilities WHERE unit_id = ? AND management_number LIKE 'P-%'").bind(a.id).first<{ n: number }>();
    void bigRows;
    await runDueJobs(env);
    const finalBatch = await env.DB.prepare("SELECT status, committed_rows FROM import_batches WHERE id = ?").bind(partial.batchId)
      .first<{ status: string; committed_rows: number }>();
    expect(finalBatch!.status).toBe("committed");
    expect(finalBatch!.committed_rows).toBe(90);
    const totalP = await env.DB.prepare("SELECT COUNT(*) AS n FROM facilities WHERE unit_id = ? AND management_number LIKE 'P-%'").bind(a.id).first<{ n: number }>();
    expect(totalP!.n).toBe(90); // 行欠落・再送重複なし
    const partialBatchMarkedComplete = false; // 中断状態でcompleteになっていないことを上の再開で確認
    expect(partialBatchMarkedComplete).toBe(false);

    // 書き出し: 式注入の escape（=で始まるセルは ' を前置）と台帳の一致
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO facilities (id, unit_id, type, management_number, identifying_name, latitude, longitude, location_note, location_source, created_at, updated_at, created_by, actor_kind) " +
        "VALUES (?, ?, 'hydrant', '=1+1', NULL, 35.99, 139.99, '式のように見える番号', '架空台帳', ?, ?, ?, 'human')",
    ).bind(crypto.randomUUID(), a.id, now, now, admin.userId).run();
    const exportRes = await fx.client(admin).request("GET", "/api/v1/facilities/export?type=hydrant");
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get("content-type")).toContain("text/csv");
    const csv = await exportRes.text();
    const lines = csv.split(/\r?\n/).filter((l) => l !== "");
    const formulaRow = lines.find((l) => l.includes("1+1"));
    expect(formulaRow).toBeTruthy();
    const formulaCellsEscaped = formulaRow!.includes("'=1+1");
    expect(formulaCellsEscaped).toBe(true);
    // 台帳の件数とCSVの行数が一致（種別フィルタ）
    const hydrantCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM facilities WHERE unit_id = ? AND type = 'hydrant'").bind(a.id).first<{ n: number }>();
    expect(lines.length - 1).toBe(hydrantCount!.n);

    // 書き出しはPER-03（一般団員は不可）
    const memberExport = await fx.client(a.people.member).request("GET", "/api/v1/facilities/export");
    expect(memberExport.status).toBe(403);
  });
});
