import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import "../src/server/jobs/handlers/import";
import { runDueJobs } from "../src/server/jobs/runner";
import { sha256OfBytes } from "../src/server/attachments/sizes";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) => (await r.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: { field: string; reason: string }[] } };

const CSV_HEADER = "type,management_number,identifying_name,latitude,longitude,location_source,location_note";
const csvBytes = (rows: string[]): Uint8Array => new TextEncoder().encode([CSV_HEADER, ...rows].join("\r\n"));

/** CSVを添付としてreadyまで進める */
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
    method: "PUT",
    headers: { "content-type": "text/csv", "x-upload-token": intent.uploadToken },
    body: bytes as BufferSource,
  }));
  const attempt = (await json(up)).data! as { id: string; sha256: string };
  await fx.client(who).request("POST", `/api/v1/attachments/${intent.id}/completion`, { version: 1, uploadAttemptId: attempt.id, sha256: attempt.sha256 }, idem());
  await runDueJobs(env);
  return intent.id;
}

describe("CSV取り込みのプレビュー (T023)", () => {
  it("preview_changes_no_facility_even_with_valid_rows", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM facilities WHERE unit_id = ?").bind(a.id).first<{ n: number }>();

    // 有効な行・壊れた行が混在するCSV。引用符内の改行・BOM付きUTF-8も読める
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const body = new TextEncoder().encode(
      [
        CSV_HEADER,
        'hydrant,"P-0001",,35.5,139.5,架空市台帳,"1丁目, 公園脇"', // 引用内のカンマ
        'cistern,S-0001,,35.51,139.51,現地測量,小学校東側',
        'hydrant,P-0002,,91,139.5,架空市台帳,緯度が範囲外', // 誤座標
        'hydrant,P-0003,,35.52,139.52,,目印が無い', // 出典欠落
        'fountain,P-0004,,35.53,139.53,架空市台帳,未知の種別', // 種別違反
        'hydrant,,,"35.54,139.54",架空市台帳,x', // 列数違い
        'hydrant,P-0001,,35.55,139.55,架空市台帳,ファイル内重複', // 番号の重複（1行目と同じ）
      ].join("\r\n"),
    );
    const bytes = new Uint8Array(bom.length + body.length);
    bytes.set(bom); bytes.set(body, bom.length);
    const dRes = await fx.client(admin).request("POST", "/api/v1/attachment-drafts", { intendedEntityType: "import_batch" }, idem());
    const draft = (await json(dRes)).data! as { id: string };
    const iRes = await fx.client(admin).request(
      "POST", "/api/v1/attachments/upload-intents",
      { target: { type: "attachment_draft", id: draft.id }, contentType: "text/csv", byteSize: bytes.byteLength }, idem(),
    );
    const intent = (await json(iRes)).data! as { id: string; uploadToken: string };
    const up = await fx.raw(admin)(new Request(`http://example.com/api/v1/attachments/${intent.id}/upload`, {
      method: "PUT", headers: { "content-type": "text/csv", "x-upload-token": intent.uploadToken }, body: bytes as BufferSource,
    }));
    const attempt = (await json(up)).data! as { id: string; sha256: string };
    await fx.client(admin).request("POST", `/api/v1/attachments/${intent.id}/completion`, { version: 1, uploadAttemptId: attempt.id, sha256: attempt.sha256 }, idem());
    await runDueJobs(env);

    // プレビュー要求（job経由で解析される。202）
    const pRes = await fx.client(admin).request(
      "POST", "/api/v1/facilities/imports",
      { csvAttachmentId: intent.id, templateVersion: "csv-facilities-v1" }, idem(),
    );
    expect(pRes.status).toBe(202);
    const preview = (await json(pRes)).data! as { id: string; jobId: string };
    await runDueJobs(env);

    // プレビューだけで台帳は変わらない
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM facilities WHERE unit_id = ?").bind(a.id).first<{ n: number }>();
    expect(after!.n).toBe(before!.n);

    // 行ごとの結果: 有効2行、エラー5行（誤座標・出典欠落・未知種別・列数違い・ファイル内重複2行）
    const batch = await env.DB.prepare("SELECT status, total_rows, valid_rows, preview_hash, base_dataset_revision, input_hash FROM import_batches WHERE id = ?")
      .bind(preview.id).first<{ status: string; total_rows: number; valid_rows: number; preview_hash: string; base_dataset_revision: number; input_hash: string }>();
    expect(batch!.status).toBe("ready");
    expect(batch!.total_rows).toBe(7);
    expect(batch!.valid_rows).toBe(2);
    const rows = await fx.rows("import_rows", { batch_id: preview.id });
    const errorRowNumbers = rows.filter((r) => r.error !== null).map((r) => r.row_no as number).sort();
    expect(errorRowNumbers).toEqual([3, 4, 5, 6, 7]); // 行番号付きで検出（ヘッダー除く）
    expect(rows.filter((r) => r.error === null).map((r) => JSON.parse(r.normalized_json as string).managementNumber).sort())
      .toEqual(["P-0001", "S-0001"]);
    // 引用内のカンマが正しく処理されている
    expect(JSON.parse(rows.find((r) => r.row_no === 1)!.normalized_json as string).locationNote).toContain("公園脇");
    // 入力hashが記録される
    expect(batch!.input_hash).toBe(await sha256OfBytes(bytes));

    // 未対応のtemplateVersionは400
    const badTemplate = await fx.client(admin).request(
      "POST", "/api/v1/facilities/imports",
      { csvAttachmentId: intent.id, templateVersion: "unknown-v9" }, idem(),
    );
    expect(badTemplate.status).toBe(400);

    // 他unitのCSV添付は使えない（存在を明かさない404）
    const otherCsv = await readyCsv(fx.units.b.people.admin, ["hydrant,X-1,,35,139,src,note"]);
    const otherRes = await fx.client(admin).request("POST", "/api/v1/facilities/imports", { csvAttachmentId: otherCsv, templateVersion: "csv-facilities-v1" }, idem());
    expect(otherRes.status).toBe(404);

    // 100行超は拒否（配列上限）
    const many = Array.from({ length: 101 }, (_, i) => `hydrant,M-${i},,35,139,src,note`);
    const bigCsv = await readyCsv(admin, many);
    const bigRes = await fx.client(admin).request("POST", "/api/v1/facilities/imports", { csvAttachmentId: bigCsv, templateVersion: "csv-facilities-v1" }, idem());
    expect(bigRes.status).toBe(400);

    // 一般団員は取込を作れない（PER-03）
    const byMember = await fx.client(a.people.member).request(
      "POST", "/api/v1/facilities/imports", { csvAttachmentId: intent.id, templateVersion: "csv-facilities-v1" }, idem(),
    );
    expect(byMember.status).toBe(403);
  });
});
