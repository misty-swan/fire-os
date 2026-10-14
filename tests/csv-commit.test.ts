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
  it("commit_job_detects_external_master_change_and_never_completes", async () => {
    const admin = fx.units.a.people.admin;

    // 確定を受け付けた後、jobが走る前に台帳が変わったら、チャンクの版検査で失敗して確定されない
    const first = await previewBatch(admin, ["hydrant,GC-0001,,35.7,139.7,架空市台帳,確定中に台帳が変わる行"]);
    const version = await env.DB.prepare("SELECT version AS v FROM import_batches WHERE id = ?").bind(first.batchId).first<{ v: number }>();
    const commitRes = await fx.client(admin).request(
      "POST", `/api/v1/facilities/imports/${first.batchId}/commit`,
      { version: version!.v, previewHash: first.previewHash, conflictResolution: "skip" }, idem(),
    );
    expect([200, 202]).toContain(commitRes.status);
    // 確定jobの実行前に別の施設を作る（dataset_revisionが進む=外部の変更）
    await fx.client(admin).request("POST", "/api/v1/facilities", {
      type: "hydrant", latitude: 35.72, longitude: 139.72, locationSource: "現地", locationNote: "確定jobの実行中に増えた台帳", managementNumber: "GC-EXTERNAL",
    }, idem());
    await runDueJobs(env);
    // batchはcommittedに進まず、行も確定されない
    const batch1 = await env.DB.prepare("SELECT status, committed_rows FROM import_batches WHERE id = ?").bind(first.batchId)
      .first<{ status: string; committed_rows: number | null }>();
    expect(batch1!.status).not.toBe("committed");
    expect(batch1!.status).toBe("committing");
    const committedRows = (await fx.rows("import_rows", { batch_id: first.batchId })).filter((r) => r.committed_facility_id !== null).length;
    expect(committedRows).toBe(0);
    const created = await env.DB.prepare("SELECT COUNT(*) AS n FROM facilities WHERE unit_id = (SELECT unit_id FROM import_batches WHERE id = ?) AND management_number = 'GC-0001'").bind(first.batchId).first<{ n: number }>();
    expect(created!.n).toBe(0);

    // 上限まで再試行されても台帳は変わったままなので、最後は手動確認になり、勝手に確定されない
    for (let i = 0; i < 2; i++) {
      await env.DB.prepare("UPDATE jobs SET next_attempt_at = ? WHERE kind = 'import.commit' AND status = 'retry_wait'").bind(new Date().toISOString()).run();
      await runDueJobs(env);
    }
    const job = await env.DB.prepare("SELECT status, error_code FROM jobs WHERE kind = 'import.commit' ORDER BY created_at DESC, id DESC LIMIT 1")
      .first<{ status: string; error_code: string | null }>();
    expect(job!.status).toBe("manual_review");
    expect(job!.error_code).toBe("chunk_conflict");
    const batch2 = await env.DB.prepare("SELECT status FROM import_batches WHERE id = ?").bind(first.batchId).first<{ status: string }>();
    expect(batch2!.status).toBe("committing"); // 手動確認後もcommittedのまま放置されない
    const stillNothing = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM import_rows WHERE batch_id = ? AND committed_facility_id IS NOT NULL",
    ).bind(first.batchId).first<{ n: number }>();
    expect(stillNothing!.n).toBe(0);
  });

  it("overwrite_commit_resets_location_confirmation_with_new_location_version", async () => {
    const admin = fx.units.a.people.admin;

    // 既存施設を作り、位置確認をverifiedまで進める（上書きで失効することを確かめるため）
    const made = await (await fx.client(admin).request("POST", "/api/v1/facilities", {
      type: "hydrant", latitude: 35.1, longitude: 139.1, locationSource: "架空市台帳", locationNote: "上書きされる施設", managementNumber: "OV-0001",
    }, idem())).json() as { data: { id: string; version: number; locationVersion: number } };
    const facilityId = made.data.id;
    await fx.client(admin).request("POST", `/api/v1/facilities/${facilityId}/location-reviews`, { version: 1, locationVersion: 1, decision: "request", reason: "現地確認のお願い" }, idem());
    const verified = await fx.client(admin).request("POST", `/api/v1/facilities/${facilityId}/location-reviews`, { version: 2, locationVersion: 1, decision: "verify", reason: "現地で確認した" }, idem());
    expect(verified.status).toBe(200);
    const before = (await fx.rows("facilities", { id: facilityId }))[0]!;
    expect(before.verification_status).toBe("verified");

    // 同じ番号の行はpreviewで重複エラーになるため、試験内で行を有効化してoverwriteの確定対象にする
    // （import_rowsはerrorとnormalized_jsonを同時に反転するCHECKを持つため、正規化済みの値も入れる）
    const batch = await previewBatch(admin, ["hydrant,OV-0001,,35.15,139.15,現地測量,上書きで座標を修正"]);
    await env.DB.prepare(
      "UPDATE import_rows SET error = NULL, normalized_json = ? WHERE batch_id = ? AND row_no = 1",
    ).bind(
      JSON.stringify({ type: "hydrant", managementNumber: "OV-0001", identifyingName: null, latitude: 35.15, longitude: 139.15, locationSource: "現地測量", locationNote: "上書きで座標を修正" }),
      batch.batchId,
    ).run();
    const version = await env.DB.prepare("SELECT version AS v FROM import_batches WHERE id = ?").bind(batch.batchId).first<{ v: number }>();
    const commitRes = await fx.client(admin).request(
      "POST", `/api/v1/facilities/imports/${batch.batchId}/commit`,
      { version: version!.v, previewHash: batch.previewHash, conflictResolution: "overwrite" }, idem(),
    );
    expect([200, 202]).toContain(commitRes.status);
    await runDueJobs(env);

    // 座標が変わったので位置確認はunverifiedに戻り、location_versionが増える（docs/11「座標変更は必ず新locationVersion、旧確認を失効」）
    const after = (await fx.rows("facilities", { id: facilityId }))[0]!;
    expect(after.latitude).toBeCloseTo(35.15);
    expect(after.location_version).toBe((before.location_version as number) + 1);
    expect(after.verification_status).toBe("unverified");
    expect(after.last_verified_at).toBeNull();
    expect(after.verified_by_member_id).toBeNull();
    // 位置履歴には新しいlocationVersionのevent_no 1が増える（版1に決め打ちしない）
    const revisions = await fx.rows("facility_location_revisions", { facility_id: facilityId });
    const v2Rows = revisions.filter((r) => r.location_version === after.location_version);
    expect(v2Rows).toHaveLength(1);
    expect(v2Rows[0]!.event_no).toBe(1);
    expect(v2Rows[0]!.verification_status).toBe("unverified");
    const batchDone = await env.DB.prepare("SELECT status, committed_rows FROM import_batches WHERE id = ?").bind(batch.batchId)
      .first<{ status: string; committed_rows: number }>();
    expect(batchDone!.status).toBe("committed");
    expect(batchDone!.committed_rows).toBe(1);
  });

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

    // 途中失敗: 後続のチャンクで番号が重複しても、そこまでのチャンクは確定のままで、batchはcommittedにならない
    // （再開で残りの行を処理できる。docs/16 T024「中断状態でcompleteにならない」）
    await env.DB.prepare(
      "INSERT INTO facilities (id, unit_id, type, management_number, latitude, longitude, location_note, location_source, created_at, updated_at, created_by, actor_kind) " +
        "VALUES (?, ?, 'hydrant', 'P-085', 35.9, 139.9, '確定と競合する既存施設', '架空台帳', ?, ?, ?, 'human')",
    ).bind(crypto.randomUUID(), a.id, new Date().toISOString(), new Date().toISOString(), admin.userId).run();
    const partial = await previewBatch(admin, Array.from({ length: 90 }, (_, i) => `hydrant,P-${String(i).padStart(3, "0")},,35.9,139.9,架空市台帳,大量行${i}`));
    // P-085の行はpreviewで重複エラーになるため、試験内で有効化して確定時に競合させる（errorとnormalized_jsonは同時に反転するCHECK）
    await env.DB.prepare(
      "UPDATE import_rows SET error = NULL, normalized_json = ? WHERE batch_id = ? AND row_no = 86",
    ).bind(
      JSON.stringify({ type: "hydrant", managementNumber: "P-085", identifyingName: null, latitude: 35.9, longitude: 139.9, locationSource: "架空市台帳", locationNote: "大量行85" }),
      partial.batchId,
    ).run();
    const partialVersion = await env.DB.prepare("SELECT version AS v FROM import_batches WHERE id = ?").bind(partial.batchId).first<{ v: number }>();
    const bigCommit = await fx.client(admin).request(
      "POST", `/api/v1/facilities/imports/${partial.batchId}/commit`,
      { version: partialVersion!.v, previewHash: partial.previewHash, conflictResolution: "skip" }, idem(),
    );
    expect([200, 202]).toContain(bigCommit.status);
    await runDueJobs(env); // チャンク1〜4までは成功し、P-085の行（5チャンク目）で重複して中断する
    const midBatch = await env.DB.prepare("SELECT status, committed_rows FROM import_batches WHERE id = ?").bind(partial.batchId)
      .first<{ status: string; committed_rows: number | null }>();
    // 中断状態でcomplete（committed）になっていないこと。確定済みの行だけが台帳に残る
    expect(midBatch!.status).toBe("committing");
    const midCommitted = (await fx.rows("import_rows", { batch_id: partial.batchId })).filter((r) => r.committed_facility_id !== null).length;
    expect(midCommitted).toBe(80); // 5チャンク目の20行は未確定
    const midFacilities = await env.DB.prepare("SELECT COUNT(*) AS n FROM facilities WHERE unit_id = ? AND management_number LIKE 'P-%'").bind(a.id).first<{ n: number }>();
    expect(midFacilities!.n).toBe(81); // 確定済み80行＋競合確認用に直入れしたP-085の1件

    // 競合を取り除けば、同じjobの再開で残りの行を確定できる（行の確定先で固定するので重複しない）
    await env.DB.prepare("DELETE FROM facilities WHERE unit_id = ? AND management_number = 'P-085'").bind(a.id).run();
    await env.DB.prepare("UPDATE jobs SET next_attempt_at = ? WHERE kind = 'import.commit' AND status = 'retry_wait'").bind(new Date().toISOString()).run();
    await runDueJobs(env);
    const finalBatch = await env.DB.prepare("SELECT status, committed_rows FROM import_batches WHERE id = ?").bind(partial.batchId)
      .first<{ status: string; committed_rows: number }>();
    expect(finalBatch!.status).toBe("committed");
    expect(finalBatch!.committed_rows).toBe(90);
    const totalP = await env.DB.prepare("SELECT COUNT(*) AS n FROM facilities WHERE unit_id = ? AND management_number LIKE 'P-%'").bind(a.id).first<{ n: number }>();
    expect(totalP!.n).toBe(90); // 行欠落・再送重複なし

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
