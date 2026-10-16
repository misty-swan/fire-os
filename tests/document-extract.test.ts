import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { authorizedDocumentVersions } from "../src/server/documents/authorized";
import { EXTRACTOR_VERSION, resolveCitationSpan } from "../src/server/documents/chunk";
import { extractDocumentVersion } from "../src/server/jobs/handlers/document-extract";
import { runDueJobs } from "../src/server/jobs/runner";
import type { LeasedJob } from "../src/server/jobs/store";
import type { RoleCode } from "../src/server/auth/authorize";
import type { AuthzPrincipal } from "../src/server/auth/principal";
import { ROLE_IDS } from "./fixtures/core";
import { SAMPLE_JA_PAGES } from "./fixtures/documents/sample-ja";
import { loadPdfFixtures } from "./fixtures/documents/pdf-bytes";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

/**
 * 文書抽出・ページ/段落/offset付きchunk（T064、docs/06 §5、docs/04:152、docs/14 D16/D20、docs/16 T064）。
 *
 * - API-74が登録した document.extract job（kind='document.extract' / source_type='document_version' /
 *   source_id=versionId / dedupe_key=`unit|document.extract|documentId|versionId`）のhandlerを実装する。
 * - **抽出の実行対象と検索可能性は分離**（プリフライト裁定。docs/06 §5「承認済有効版だけをchunk化/索引化」
 *   の安全面の本体は「非承認版が検索・回答に現れない」こと）: handlerはwithdrawnでない版（draftを含む）の
 *   chunk計算を行うが、index_status='pending'は**検索可能を意味しない**。検索はT066が承認済み＋
 *   authorizedDocumentVersionsで二重に絞る。withdrawn版の抽出は実行時再検査でstaleになる。
 * - 引用→原文spanの完全一致（試験の核心）: chunk.text は抽出原文（頁テキスト）の部分列そのもので、
 *   source_offsets（start/end）で原本の頁と文字位置へ逆引きできる。chunk.text.slice(spanStart,spanEnd)
 *   が原本の該当文字列と完全一致する。
 * - 画像のみのPDF・壊れたPDFは**fail-closed**: jobをmanual_reviewにしてchunk本文を1字も保存しない
 *   （OCRは未実装=docs/evidence/V04-retrieval.md。捏造テキストを作らない）。
 * - chunkの確定は1つのD1 batch（全削除+再INSERT）で冪等。job再実行・lease失効後の再実行でも重複0。
 */
let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) =>
  (await r.json()) as {
    data?: Record<string, unknown>;
    error?: { code: string; details?: { field: string; reason: string }[] };
  };

/**
 * jobの受付時刻（next_attempt_at）はenqueueJobの既定＝実時刻で記録されるため、runnerは
 * **実時刻+1時間**を基準に回す（固定過去時刻を渡さない。tests/jev.test.tsと同じ流儀）。
 */
const runJobs = () => runDueJobs(env, { clock: { now: () => new Date(Date.now() + 3_600_000) } });

const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** 公開文書（全役割allow。deny優先のACL判定で全員に見える） */
async function createPublicDocument(who: Identity, title: string) {
  const res = await fx.client(who).request("POST", "/api/v1/documents", {
    title, classification: "訓練資料",
    acl: [
      { roleId: ROLE_IDS.member, permission: "PER-11", effect: "allow" },
      { roleId: ROLE_IDS.operator, permission: "PER-11", effect: "allow" },
      { roleId: ROLE_IDS.officer, permission: "PER-11", effect: "allow" },
      { roleId: ROLE_IDS.admin, permission: "PER-11", effect: "allow" },
    ],
  }, idem());
  expect(res.status).toBe(201);
  return (await json(res)).data! as { id: string; version: number; status: string };
}

/** 文書の原本としてPDFを添付し、検査jobでreadyまで進める（API-26 direct target） */
async function uploadPdfOriginal(who: Identity, documentId: string, bytes: Uint8Array): Promise<string> {
  const iRes = await fx.client(who).request("POST", "/api/v1/attachments/upload-intents",
    { target: { type: "document", id: documentId }, contentType: "application/pdf", byteSize: bytes.length }, idem());
  expect(iRes.status).toBe(201);
  const intent = (await json(iRes)).data! as { id: string; uploadToken: string };
  const up = await fx.raw(who)(new Request(`http://example.com/api/v1/attachments/${intent.id}/upload`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "x-upload-token": intent.uploadToken },
    body: bytes as BufferSource,
  }));
  expect(up.status).toBe(200);
  const attempt = (await json(up)).data! as { id: string; sha256: string };
  expect(attempt.sha256).toBe(await sha256Hex(bytes)); // コミット済みfixtureの原本hash
  const comp = await fx.client(who).request("POST", `/api/v1/attachments/${intent.id}/completion`,
    { version: 1, uploadAttemptId: attempt.id, sha256: attempt.sha256 }, idem());
  expect(comp.status).toBe(202);
  await runJobs(); // 検査job（attachment.inspect）でreadyへ
  expect((await fx.rows("attachments", { id: intent.id }))[0]!.status).toBe("ready");
  return intent.id;
}

/** 版作成（API-74。202=抽出jobの受付） */
async function createVersion(who: Identity, documentId: string, attachmentId: string) {
  const root = (await fx.rows("documents", { id: documentId }))[0]!;
  const res = await fx.client(who).request("POST", `/api/v1/documents/${documentId}/versions`,
    { version: root.version as number, attachmentId, licenseRef: "架空・自団体作成 (2026)" }, idem());
  expect(res.status).toBe(202);
  const data = (await json(res)).data! as {
    version: { id: string; revisionNo: number; contentHash: string };
    job: { id: string; status: string };
  };
  return data;
}

interface ChunkRow {
  id: string; chunk_no: number; page_no: number | null; section: string | null;
  text: string; source_offsets: string; index_status: string; index_key: string | null;
}

const chunkRows = async (versionId: string): Promise<ChunkRow[]> =>
  (await fx.rows("document_chunks", { version_id: versionId }))
    .map((r) => r as unknown as ChunkRow)
    .sort((a, b) => a.chunk_no - b.chunk_no);

/** authorizedDocumentVersionsへ渡す主体（document-policy.test.tsと同じ試験用の最小構成） */
const principalOf = (who: Identity): AuthzPrincipal => ({
  userId: who.userId,
  memberId: who.memberId ?? "",
  unitId: who.unitId,
  authzVersion: 1,
  roles: (who.roleCode ? [who.roleCode] : []) as RoleCode[],
  scopes: [],
  displayName: "試験主体",
  rank: null,
  unitName: "試験分団",
  mfaEnabled: true,
});

/** lease失効後の再実行を模倣してhandlerを直接呼ぶ（completeJobは別なのでjob行は触らない） */
const reRunHandler = async (jobId: string): Promise<unknown> => {
  const row = (await fx.rows("jobs", { id: jobId }))[0]!;
  const job = {
    id: row.id as string, unitId: row.unit_id as string, kind: row.kind as string,
    sourceType: row.source_type as string, sourceId: row.source_id as string,
    sourceVersion: row.source_version as number, configVersion: row.config_version as string,
    dedupeKey: row.dedupe_key as string, status: "running" as const, attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number, nextAttemptAt: row.next_attempt_at as string,
    errorCode: null, resultRef: row.result_ref as string | null, requestedBy: null,
    createdAt: row.created_at as string, updatedAt: row.updated_at as string,
    leaseToken: "test-lease", leaseUntil: new Date(Date.now() + 120_000).toISOString(),
  } satisfies LeasedJob;
  return extractDocumentVersion(job, env);
};

describe("文書抽出・ページ/段落/offset付きchunk (T064)", () => {
  it("chunk_citation_can_be_resolved_to_exact_original_span", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const member = a.people.member;
    const fixtures = loadPdfFixtures();
    const sampleBytes = fixtures.sample;
    expect(sampleBytes.byteLength).toBeGreaterThan(100); // コミット済みfixtureが読めている

    // === 主経路: 日本語PDF（3頁・見出し・表）の抽出と引用→原文spanの完全一致 ===
    const docA = await createPublicDocument(admin, "水防活動要領（架空版）");
    const originalA = await uploadPdfOriginal(admin, docA.id, sampleBytes);
    const originalHash = await sha256Hex(sampleBytes);
    const createdA = await createVersion(admin, docA.id, originalA);
    expect(createdA.version.revisionNo).toBe(1);
    expect(createdA.version.contentHash).toBe(originalHash); // content_hash=原本のsha256
    expect(createdA.job.status).toBe("queued"); // handlerが走るまでqueuedで滞在する
    const jobRowA = (await fx.rows("jobs", { id: createdA.job.id }))[0]!;
    expect(jobRowA.kind).toBe("document.extract");
    expect(jobRowA.source_type).toBe("document_version");
    expect(jobRowA.source_id).toBe(createdA.version.id);
    expect(jobRowA.dedupe_key).toBe(`${a.id}|document.extract|${docA.id}|${createdA.version.id}`);
    expect(await chunkRows(createdA.version.id)).toEqual([]); // 実行前はchunk無し

    // --- 抽出jobの実行（Cron/Queueと同じrunDueJobs経路） ---
    await runJobs();
    const jobAfter = (await fx.rows("jobs", { id: createdA.job.id }))[0]!;
    expect(jobAfter.status).toBe("succeeded");
    const resultRef = jobAfter.result_ref as string;
    expect(resultRef).toMatch(/^ready:\d+:\d+$/); // `ready:<chunk数>:<頁数>`（CSV解析jobのresult_ref流儀）

    const rows = await chunkRows(createdA.version.id);
    const [, resultChunks, resultPages] = resultRef.split(":");
    expect(Number(resultChunks)).toBe(rows.length);
    expect(Number(resultPages)).toBe(SAMPLE_JA_PAGES.length);

    // --- chunkの構造: 連番・ページ・index_status（語彙はpending/indexed/removed。0027のCHECK） ---
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.chunk_no)).toEqual(rows.map((_, i) => i + 1)); // 1から連番（UNIQUE(version_id,chunk_no)）
    for (const row of rows) {
      expect(row.index_status).toBe("pending"); // 抽出直後は索引化待ち。**検索可能を意味しない**
      expect(row.index_key).toBeNull(); // index_keyはT066（索引化）が設定する
      expect(row.page_no).not.toBeNull();
      expect(row.page_no as number).toBeGreaterThanOrEqual(1);
      expect(row.page_no as number).toBeLessThanOrEqual(SAMPLE_JA_PAGES.length);
      const offsets = JSON.parse(row.source_offsets) as {
        contentHash: string; extractorVersion: string; pageNo: number; start: number; end: number;
      };
      // 原本hashの鎖: chunkのoffsetが指す抽出版=版のcontent_hash=原本添付のsha256
      expect(offsets.contentHash).toBe(originalHash);
      expect(offsets.contentHash).toBe(createdA.version.contentHash);
      expect((await fx.rows("attachments", { id: originalA }))[0]!.sha256).toBe(originalHash);
      expect(offsets.extractorVersion).toBe(EXTRACTOR_VERSION);
      expect(offsets.pageNo).toBe(row.page_no);
    }

    // --- 引用→原文spanの完全一致（試験の核心）: chunk.textは頁テキストの部分列そのもの ---
    for (const row of rows) {
      const pageText = SAMPLE_JA_PAGES[(row.page_no as number) - 1]!;
      const offsets = JSON.parse(row.source_offsets) as { start: number; end: number };
      expect(row.text).toBe(pageText.slice(offsets.start, offsets.end));
      expect(row.text.length).toBeGreaterThan(0);
    }
    // 各ページでchunkが頁テキストを隙間なく覆う（行境界の改行1字だけがchunkの区切り）
    for (let p = 1; p <= SAMPLE_JA_PAGES.length; p++) {
      const pageRows = rows.filter((r) => r.page_no === p);
      const pageText = SAMPLE_JA_PAGES[p - 1]!;
      expect(pageRows.length).toBeGreaterThan(0);
      expect(pageRows[0]!.source_offsets && (JSON.parse(pageRows[0]!.source_offsets) as { start: number }).start).toBe(0);
      for (let i = 1; i < pageRows.length; i++) {
        const prev = JSON.parse(pageRows[i - 1]!.source_offsets) as { end: number };
        const cur = JSON.parse(pageRows[i]!.source_offsets) as { start: number };
        expect(cur.start).toBe(prev.end + 1); // 区切りの"\n"1字
      }
      const last = JSON.parse(pageRows[pageRows.length - 1]!.source_offsets) as { end: number };
      expect(last.end).toBe(pageText.length);
      // 読みやすい同値形式: 行区切りの"\n"で結合すると原本の頁テキストに戻る
      expect(pageRows.map((r) => r.text).join("\n")).toBe(pageText);
    }

    // --- 各頁の引用（quotedSpan）が原文の該当文字列と完全一致し、頁も合う ---
    const citations: { quoted: string; expectedPageNo: number }[] = [
      { quoted: "防災対策本部の設置", expectedPageNo: 1 }, // 1頁目の本文
      { quoted: "給水量 | メーター読取 | 機材係", expectedPageNo: 2 }, // 2頁目の表の行
      { quoted: "改訂は承認後に反映される", expectedPageNo: 3 }, // 3頁目の本文
    ];
    for (const { quoted, expectedPageNo } of citations) {
      const chunk = rows.find((r) => r.page_no === expectedPageNo && r.text.includes(quoted));
      expect(chunk).toBeDefined();
      const spanStart = chunk!.text.indexOf(quoted);
      const spanEnd = spanStart + quoted.length;
      const offsets = JSON.parse(chunk!.source_offsets) as { pageNo: number; start: number; end: number };
      // chunk上の引用spanをsource_offsetsで原本（抽出版テキスト）の位置へ逆引きする
      const resolvedSpan = resolveCitationSpan(SAMPLE_JA_PAGES[offsets.pageNo - 1]!, offsets, spanStart, spanEnd);
      expect(resolvedSpan).toBe(chunk!.text.slice(spanStart, spanEnd)); // ブリーフのassertion
      expect(resolvedSpan).toBe(quoted); // 原本の該当文字列との完全一致
      const pdfCitation = { pageNo: offsets.pageNo };
      expect(pdfCitation.pageNo).toBe(expectedPageNo); // ブリーフのassertion（頁の逆引き）
    }

    // --- section（見出し。AI不使用の決定的ルール）: chunkの開始位置で有効な見出しが付く ---
    expect(rows.map((r) => r.section)).toEqual([
      null, // 1頁目の冒頭（見出し前の本文）
      "第1章 出動体制（架空）",
      "第2章 給水活動の記録（架空）",
      "備考", // 行頭の短い行の決定的ルール
      "第3章 改訂履歴（架空）",
    ]);

    // --- 抽出の実行対象と検索可能性は分離: draft版にchunkは有るが、検索の正本（T066/T067が
    //     authorizedDocumentVersionsで二重に絞る）には承認前の版は現れない ---
    expect((await authorizedDocumentVersions(env, principalOf(member), [createdA.version.id])).map((v) => v.id)).toEqual([]);
    expect((await authorizedDocumentVersions(env, principalOf(admin), [createdA.version.id])).map((v) => v.id)).toEqual([]);

    // --- 同じjobの再実行（lease失効後の再実行を模倣）でも重複0（全削除+再INSERTで冪等） ---
    expect(await reRunHandler(createdA.job.id)).toMatchObject({ kind: "succeeded" });
    const rowsAfterRerun = await chunkRows(createdA.version.id);
    expect(rowsAfterRerun.map((r) => r.chunk_no)).toEqual(rows.map((r) => r.chunk_no));
    expect(new Set(rowsAfterRerun.map((r) => r.chunk_no)).size).toBe(rowsAfterRerun.length);
    expect(rowsAfterRerun.map((r) => r.text)).toEqual(rows.map((r) => r.text));
    expect(rowsAfterRerun.map((r) => r.section)).toEqual(rows.map((r) => r.section));

    // === 画像のみのPDF: manual_review（document_ocr_required）。chunk本文は1字も保存しない ===
    const docB = await createPublicDocument(admin, "点検結果のスキャン（架空版）");
    const originalB = await uploadPdfOriginal(admin, docB.id, fixtures.imageOnly);
    const createdB = await createVersion(admin, docB.id, originalB);
    await runJobs();
    const jobB = (await fx.rows("jobs", { id: createdB.job.id }))[0]!;
    const unextractable = { status: jobB.status, errorCode: jobB.error_code };
    expect(unextractable.status).toBe("manual_review"); // ブリーフのassertion
    expect(unextractable.errorCode).toBe("document_ocr_required");
    const chunksB = await chunkRows(createdB.version.id);
    const inventedOcrText = chunksB.length > 0; // OCR未実装で本文を捏造していない
    expect(inventedOcrText).toBe(false); // ブリーフのassertion

    // === 壊れたPDF（検査は通るがFlateDecodeが壊れている）: manual_review。chunk0件 ===
    const docC = await createPublicDocument(admin, "壊れた資料（架空版）");
    const originalC = await uploadPdfOriginal(admin, docC.id, fixtures.broken);
    const createdC = await createVersion(admin, docC.id, originalC);
    await runJobs();
    const jobC = (await fx.rows("jobs", { id: createdC.job.id }))[0]!;
    expect(jobC.status).toBe("manual_review");
    expect(jobC.error_code).toBe("unextractable_document");
    expect(await chunkRows(createdC.version.id)).toEqual([]);

    // === withdrawn版の抽出は実行時再検査でstale（jobをstaleにしてchunkを作らない） ===
    const docD = await createPublicDocument(admin, "撤回される資料（架空版）");
    const originalD = await uploadPdfOriginal(admin, docD.id, sampleBytes);
    const createdD = await createVersion(admin, docD.id, originalD);
    // 撤回（API-92）。document.deindex jobのhandlerはT066（本タスクの対象外）なので
    // 未処理のdeindexだけ先に取消す（unknown_kindの保留を作らないため。抽出jobの検証には影響しない）
    await env.DB.prepare("UPDATE jobs SET status = 'cancelled' WHERE kind = 'document.deindex' AND status IN ('queued', 'retry_wait')").run();
    const withdrawal = await fx.client(admin).request("POST", `/api/v1/documents/${docD.id}/withdrawal`,
      { version: (await fx.rows("documents", { id: docD.id }))[0]!.version as number, reason: "許諾の期限切れ（架空）" }, idem());
    expect(withdrawal.status).toBe(200);
    await runJobs();
    const jobD = (await fx.rows("jobs", { id: createdD.job.id }))[0]!;
    expect(jobD.status).toBe("stale");
    expect(jobD.error_code).toBe("document_withdrawn");
    expect(await chunkRows(createdD.version.id)).toEqual([]);
  });

  /**
   * PDF展開（inflate）の合計上限32MB（PH5レビューA低5）。高圧縮ストリーム（zip爆弾様）で
   * メモリを大量消費できるため、展開合計が上限を超えたらunextractable_documentで例外→
   * jobはmanual_review（chunk本文は1字も保存しない）。旧実装は無上限で展開するため、
   * テキスト演算子の無い33MBの内容はdocument_ocr_requiredでFAILする。
   */
  it("inflate_over_32mb_falls_back_to_manual_review", async () => {
    const admin = fx.units.a.people.admin;

    // 展開で33MBになる高圧縮ストリーム（ゼロ列。deflateで数十KBに縮む）を作る
    const mb = new Uint8Array(1024 * 1024);
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 33; i++) controller.enqueue(mb);
        controller.close();
      },
    });
    const reader = input.pipeThrough(new CompressionStream("deflate") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>).getReader();
    const parts: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) parts.push(value);
    }
    const deflated = concatBytes(parts);
    expect(deflated.length).toBeLessThan(1024 * 1024); // 高圧縮の前提（元は33MB）

    const pdf = buildMinimalPdfWithFlateStream(deflated);
    const doc = await createPublicDocument(admin, "高圧縮の資料（架空版）");
    const originalId = await uploadPdfOriginal(admin, doc.id, pdf);
    const created = await createVersion(admin, doc.id, originalId);
    await runJobs();
    const job = (await fx.rows("jobs", { id: created.job.id }))[0]!;
    expect(job.status).toBe("manual_review"); // ブリーフのassertion
    expect(job.error_code).toBe("unextractable_document"); // 展開上限超過は既存のshort code系
    expect(await chunkRows(created.version.id)).toEqual([]);
  });
});

/** 複数のバイト列の結合（展開上限試験のPDF組立て用） */
const concatBytes = (parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** 展開上限試験用の最小PDF（Catalog→Pages→Page→Contents=FlateDecode stream。%%EOF付きで検査jobを通る） */
const buildMinimalPdfWithFlateStream = (streamBytes: Uint8Array): Uint8Array => {
  const head = new TextEncoder().encode(
    "%PDF-1.4\n" +
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << >> >>\nendobj\n" +
      `4 0 obj\n<< /Length ${streamBytes.length} /Filter /FlateDecode >>\nstream\n`,
  );
  const tail = new TextEncoder().encode("\nendstream\nendobj\n%%EOF\n");
  return concatBytes([head, streamBytes, tail]);
};
