import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import "../src/server/jobs/handlers/attachment"; // job handler の登録（Cron/Queueと同じ登録）
import { runDueJobs } from "../src/server/jobs/runner";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const sha256 = async (bytes: Uint8Array) => {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) => (await r.json()) as { data?: Record<string, unknown>; error?: { code: string } };

// --- 架空のバイナリ（検査対象の入力。実在の写真は載せない） ---
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
let CRC_TABLE: number[] | undefined;
function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  new DataView(out.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  new DataView(out.buffer).setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const IHDR = () => {
  const d = new Uint8Array(13);
  new DataView(d.buffer).setUint32(0, 1); // width
  new DataView(d.buffer).setUint32(4, 1); // height
  d.set([8, 6, 0, 0, 0], 8);
  return d;
};
/** EXIF(GPS)入りのPNG。IDATは1px分のダミー（内容の解読はしない構造検査のため） */
const pngWithExif = () => concat([
  new Uint8Array(PNG_MAGIC),
  pngChunk("IHDR", IHDR()),
  pngChunk("eXIf", new TextEncoder().encode("GPS\x00\x01\x02\x03 tether-desktop")),
  pngChunk("IDAT", new Uint8Array([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01])),
  pngChunk("IEND", new Uint8Array(0)),
]);
const brokenPng = () => concat([new Uint8Array(PNG_MAGIC), pngChunk("IHDR", IHDR())]); // IEND無し・IDAT無し

function seg(marker: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  out[0] = 0xff; out[1] = marker;
  out[2] = (payload.length + 2) >> 8; out[3] = (payload.length + 2) & 0xff;
  out.set(payload, 4);
  return out;
}
const jpegWithExif = () => concat([
  new Uint8Array([0xff, 0xd8]),
  seg(0xe1, concat([new TextEncoder().encode("Exif\x00\x00"), new TextEncoder().encode("GPS-tether-xx")])),
  seg(0xe0, new TextEncoder().encode("JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")),
  seg(0xda, new Uint8Array([0x00, 0x02, 0x00, 0x00])), // SOS
  new Uint8Array([0x12, 0x34, 0x00]),
  new Uint8Array([0xff, 0xd9]), // EOI
]);

function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const padded = data.length % 2 === 0 ? data : concat([data, new Uint8Array(1)]);
  const out = new Uint8Array(8 + padded.length);
  for (let i = 0; i < 4; i++) out[i] = fourcc.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(padded, 8);
  return out;
}
const webpWithExif = () => {
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x08; // EXIFフラグ
  vp8x[4] = 1; vp8x[5] = 0; vp8x[6] = 1; vp8x[7] = 0; // canvas 1x1
  const exif = riffChunk("EXIF", new TextEncoder().encode("GPS-tether-yy"));
  const body = concat([new Uint8Array([0x57, 0x45, 0x42, 0x50]), riffChunk("VP8X", vp8x), exif, riffChunk("VP8 ", new Uint8Array([1, 2, 3, 4]))]);
  const out = new Uint8Array(8 + body.length);
  out.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
};
const pdfClean = () => new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");
const pdfWithJs = () => new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /OpenAction << /JS (app.alert\\(1\\)) >> >>\nendobj\n%%EOF\n");
const csvClean = () => new TextEncoder().encode("種別,番号\n消火栓,1\n");
const csvBrokenUtf8 = () => concat([new TextEncoder().encode("a,b\n1,"), new Uint8Array([0xff, 0xfe]), new TextEncoder().encode("\n")]);
const csvWithNul = () => concat([new TextEncoder().encode("a,"), new Uint8Array([0x00]), new TextEncoder().encode("b\n")]);

// --- 添付を「検査待ち」まで進めるヘルパ（T015のAPI経由） ---
async function makeUploaded(who: Identity, contentType: string, bytes: Uint8Array): Promise<string> {
  const dRes = await fx.client(who).request("POST", "/api/v1/attachment-drafts", { intendedEntityType: "facility" }, idem());
  const draft = (await json(dRes)).data!;
  const iRes = await fx.client(who).request(
    "POST", "/api/v1/attachments/upload-intents",
    { target: { type: "attachment_draft", id: draft.id }, contentType, byteSize: bytes.byteLength }, idem(),
  );
  const intent = (await json(iRes)).data! as { id: string; uploadToken: string };
  const up = await fx.raw(who)(new Request(`http://example.com/api/v1/attachments/${intent.id}/upload`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "x-upload-token": intent.uploadToken },
    body: bytes as BufferSource,
  }));
  expect(up.status).toBe(200);
  const attempt = (await json(up)).data! as { id: string; sha256: string };
  const cRes = await fx.client(who).request(
    "POST", `/api/v1/attachments/${intent.id}/completion`,
    { version: 1, uploadAttemptId: attempt.id, sha256: attempt.sha256 }, idem(),
  );
  expect(cRes.status).toBe(202);
  return intent.id;
}
const statusOf = async (id: string) =>
  (await env.DB.prepare("SELECT status, ready_key, staging_key, sha256, byte_size, version FROM attachments WHERE id = ?").bind(id)
    .first<{ status: string; ready_key: string | null; staging_key: string | null; sha256: string | null; byte_size: number; version: number }>())!;
const lastJobOf = async (attachmentId: string) =>
  (await env.DB.prepare("SELECT id, status, error_code FROM jobs WHERE source_type = 'attachment' AND source_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").bind(attachmentId)
    .first<{ id: string; status: string; error_code: string | null }>())!;

describe("ファイル検査とready確定 (T016)", () => {
  it("forged_mime_or_scanner_failure_never_becomes_ready", async () => {
    const admin = fx.units.a.people.admin;

    // 正常系: EXIF入りのPNG → ready（EXIFは除去され、画素データ(IDAT)は保たれる）
    const pngId = await makeUploaded(admin, "image/png", pngWithExif());
    await runDueJobs(env);
    const png = await statusOf(pngId);
    expect(png.status).toBe("ready");
    expect(png.ready_key).toMatch(/^ready\//);
    const readyPng = await env.FILES.get(png.ready_key!);
    const readyBytes = new Uint8Array(await readyPng!.arrayBuffer());
    const chunkTypes = (() => {
      const types: string[] = [];
      let o = 8;
      while (o + 8 <= readyBytes.length) {
        const dv = new DataView(readyBytes.buffer, readyBytes.byteOffset + o);
        const len = dv.getUint32(0);
        types.push(String.fromCharCode(...readyBytes.subarray(o + 4, o + 8)));
        o += 12 + len;
      }
      return types;
    })();
    const exifGpsAfter = chunkTypes.find((t) => t === "eXIf");
    expect(exifGpsAfter).toBeUndefined();
    expect(chunkTypes).toContain("IDAT");
    expect(chunkTypes).toContain("IEND");
    // readyの鍵は内容hashで固定され、D1にも検査後のhashが残る
    expect(png.sha256).toBe(await sha256(readyBytes));
    expect(png.byte_size).toBe(readyBytes.byteLength);

    // JPEG/WebPのEXIFも除去。PDFの能動的埋込は拒否、無害なPDF/CSVはready
    const jpegId = await makeUploaded(admin, "image/jpeg", jpegWithExif());
    const webpId = await makeUploaded(admin, "image/webp", webpWithExif());
    const pdfOkId = await makeUploaded(admin, "application/pdf", pdfClean());
    const csvOkId = await makeUploaded(admin, "text/csv", csvClean());
    await runDueJobs(env);
    const jpegBytes = new Uint8Array(await (await env.FILES.get((await statusOf(jpegId)).ready_key!))!.arrayBuffer());
    expect(new TextDecoder("latin1").decode(jpegBytes)).not.toContain("Exif");
    const webpBytes = new Uint8Array(await (await env.FILES.get((await statusOf(webpId)).ready_key!))!.arrayBuffer());
    expect(new TextDecoder("latin1").decode(webpBytes)).not.toContain("GPS-tether");
    expect((await statusOf(pdfOkId)).status).toBe("ready");
    expect((await statusOf(csvOkId)).status).toBe("ready");
    const csvReady = new Uint8Array(await (await env.FILES.get((await statusOf(csvOkId)).ready_key!))!.arrayBuffer());
    expect(new TextDecoder().decode(csvReady)).toContain("消火栓");

    // 拒否系: 偽MIME（中身はPNGなのにCSVと申告）・壊れたPNG・危険なPDF・壊れたUTF-8/NUL入りCSV
    const forgedId = await makeUploaded(admin, "text/csv", pngWithExif());
    const brokenId = await makeUploaded(admin, "image/png", brokenPng());
    const dangerId = await makeUploaded(admin, "application/pdf", pdfWithJs());
    const badUtf8Id = await makeUploaded(admin, "text/csv", csvBrokenUtf8());
    const nulCsvId = await makeUploaded(admin, "text/csv", csvWithNul());
    await runDueJobs(env);
    const invalidStatuses = await Promise.all([forgedId, brokenId, dangerId, badUtf8Id, nulCsvId].map(async (id) => (await statusOf(id)).status));
    expect(invalidStatuses).not.toContain("ready");
    for (const id of [forgedId, brokenId, dangerId, badUtf8Id, nulCsvId]) {
      expect((await statusOf(id)).status).toBe("rejected");
      expect((await lastJobOf(id)).status).toBe("succeeded"); // 検査=不合格はjobとして正しい終端
    }
    // rejectedの ready_key は無い（検査を通っていない実体を配信しない）
    for (const id of [forgedId, brokenId, dangerId, badUtf8Id, nulCsvId]) expect((await statusOf(id)).ready_key).toBeNull();

    // 検査不能（R2から取得できない）は不合格とも合格ともしない。checkingのまま再試行
    const missingId = await makeUploaded(admin, "image/png", pngWithExif());
    const before = await statusOf(missingId);
    await env.FILES.delete(before.staging_key!);
    await runDueJobs(env);
    const scannerUnavailable = await statusOf(missingId);
    expect(scannerUnavailable.status).toBe("checking"); // readyにしない
    expect((await lastJobOf(missingId)).error_code).toBe("scanner_unavailable");

    // 検査中に元版が変わったら、遅れたjobは確定しない（readyの実体も変わらない）
    const readyHashBefore = await sha256(new Uint8Array(await (await env.FILES.get(png.ready_key!))!.arrayBuffer()));
    await env.DB.prepare(
      "INSERT INTO jobs (id, unit_id, kind, source_type, source_id, source_version, config_version, dedupe_key, status, attempts, max_attempts, next_attempt_at, created_at, updated_at) " +
        "VALUES (?, ?, 'attachment.inspect', 'attachment', ?, 99, 'v1', ?, 'queued', 0, 3, ?, ?, ?)",
    ).bind(crypto.randomUUID(), fx.units.a.id, pngId, `${fx.units.a.id}|attachment.inspect|late-${pngId}`, new Date().toISOString(), new Date().toISOString(), new Date().toISOString()).run();
    await runDueJobs(env);
    expect((await lastJobOf(pngId)).status).toBe("stale");
    const readyHashAfterLateJob = await sha256(new Uint8Array(await (await env.FILES.get(png.ready_key!))!.arrayBuffer()));
    expect(readyHashAfterLateJob).toBe(readyHashBefore);
    expect((await statusOf(pngId)).status).toBe("ready");
  });
});
