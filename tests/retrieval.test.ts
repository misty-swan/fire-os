import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { RoleCode } from "../src/server/auth/authorize";
import type { AuthzPrincipal } from "../src/server/auth/principal";
import { authorizedDocumentVersions } from "../src/server/documents/authorized";
import { extractDocumentVersion } from "../src/server/jobs/handlers/document-extract";
import { indexDocument } from "../src/server/jobs/handlers/document-index";
import type { JobHandler } from "../src/server/jobs/runner";
import { runDueJobs } from "../src/server/jobs/runner";
import type { LeasedJob } from "../src/server/jobs/store";
import { createRetrievalPort } from "../src/server/search/adapter";
import { parseSearchConfig, type AuthorizedChunk } from "../src/server/search/port";
import searchDevelopmentConfigJson from "../config/search-development.json";
import { ROLE_IDS } from "./fixtures/core";
import { SAMPLE_JA_PAGES } from "./fixtures/documents/sample-ja";
import { loadPdfFixtures } from "./fixtures/documents/pdf-bytes";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

/**
 * 選定した索引の投入・検索・失効回収（T066、docs/06 §5、docs/10 §4、docs/04:152、docs/14 D16、docs/16 T066）。
 *
 * - **本番経路**: T063がenqueue済みのdocument.index（承認時）/document.deindex（撤回時）/
 *   document.reindex（ACL変更時）jobのhandler（src/server/jobs/handlers/document-index.ts）と、
 *   T065が選定したd1_fts＋trigram（config/search-development.json・version=search-dev-v1）を接続した
 *   検索adapter（src/server/search/adapter.ts・createRetrievalPort）。FTS仮想表の恒久DDLは
 *   drizzle/0028_search_index.sql（T065の試験内DDLと同じ列構成）。
 * - **三重防御（docs/10 §4「検索前フィルター＋生成前再検査＋引用取得時再検査」の検索側2層）**:
 *   ①検索SQLの前提条件（unit一致＋v.status='approved'＋d.status<>'withdrawn'＋c.index_status='indexed'）
 *   ②hit後の再検査は必ずauthorizedDocumentVersions（src/server/documents/authorized.ts＝単一の正本）
 *   ③戻すのは承認済み・可視のchunkだけ。**索引（FTS行）が遅れてもD1の再検査で漏らさない**
 *   （docs/06 §5.5。撤回直後〜deindex job実行までの間も検索からは即落ちする）。
 * - **jobは現状態と突き合わせて冪等**: index/reindexは「全削除＋再投入」の1つのD1 batchで確定し、
 *   実行時に現状態（承認済み＋非withdrawn）と突き合わせる。失権中（superseded/withdrawn）のindex jobは
 *   索引化しない（staleIndexActivated=false）。jobの再実行・lease失効後の再実行でもFTS行の重複0。
 * - **chunksのindex_status（pending/indexed/removed）が現在状態の正本**（docs/16 T066のプリフライト裁定4）。
 *   検索はindex_status='indexed'かつ現ACL可視のみ。抽出jobの再実行でchunk行が作り直されても、
 *   古いFTS行（chunk_idが既に行から消えた孤児）は検索で返らない。
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
 * jobの受付時刻（next_attempt_at）は実時刻で記録されるため、runnerは実時刻+1時間を基準に回す
 * （tests/document-extract.test.tsと同じ流儀）。
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
  expect(attempt.sha256).toBe(await sha256Hex(bytes));
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

/** API-75の決定（申請→承認。document.index jobのidを返す） */
const decide = (documentId: string, body: Record<string, unknown>, who: Identity) =>
  fx.client(who).request("POST", `/api/v1/documents/${documentId}/decision`, body, idem());

async function approveVersion(documentId: string, revisionNo: number, who: Identity) {
  expect((await decide(documentId, {
    version: (await fx.rows("documents", { id: documentId }))[0]!.version as number,
    documentVersion: revisionNo, decision: "request_review", reason: "原本の準備ができたため申請します（架空）",
  }, who)).status).toBe(200);
  const res = await decide(documentId, {
    version: (await fx.rows("documents", { id: documentId }))[0]!.version as number,
    documentVersion: revisionNo, decision: "approve", reason: "内容と許諾を確認しました（架空）",
  }, who);
  expect(res.status).toBe(200);
  return (await json(res)).data! as { versionId: string; indexJobId: string | null };
}

/** API-92の撤回（document.deindex jobのidを返す。handler実行は呼び出し側で制御する） */
async function withdrawDocument(documentId: string, who: Identity) {
  const res = await fx.client(who).request("POST", `/api/v1/documents/${documentId}/withdrawal`,
    { version: (await fx.rows("documents", { id: documentId }))[0]!.version as number, reason: "許諾の期限切れ（架空）" }, idem());
  expect(res.status).toBe(200);
  return (await json(res)).data! as { deindexJob: { id: string } | null };
}

/** API-99のACL変更（document.reindex jobのidを返す） */
async function changeAcl(documentId: string, acl: { roleId: string; permission: string; effect: "allow" | "deny" }[], who: Identity) {
  const res = await fx.client(who).request("PATCH", `/api/v1/documents/${documentId}/access-policy`,
    {
      version: (await fx.rows("documents", { id: documentId }))[0]!.version as number,
      classification: "訓練資料", acl,
    }, idem());
  expect(res.status).toBe(200);
  return (await json(res)).data! as { reindexJob: { id: string } | null };
}

interface ChunkRow {
  id: string; chunk_no: number; page_no: number | null; section: string | null;
  text: string; index_status: string; index_key: string | null;
}

const chunkRows = async (versionId: string): Promise<ChunkRow[]> =>
  (await fx.rows("document_chunks", { version_id: versionId }))
    .map((r) => r as unknown as ChunkRow)
    .sort((a, b) => a.chunk_no - b.chunk_no);

const jobRowOf = async (jobId: string) => (await fx.rows("jobs", { id: jobId }))[0]!;

/** lease失効後の再実行を模倣してhandlerを直接呼ぶ（completeJobは別なのでjob行は触らない） */
const reRunHandler = async (handler: JobHandler, jobId: string): Promise<unknown> => {
  const row = await jobRowOf(jobId);
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
  return handler(job, env);
};

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

// --- FTS仮想表（drizzle/0028_search_index.sql。本番DDLそのもの）を直接読む補助 -------------------

/** 検索語をFTS5のMATCH式へ組み立てる（adapter内蔵の組立てと同じ。語ごとに引用符で括る） */
const ftsMatch = (query: string) =>
  query.trim().split(/\s+/).filter((t) => t.length > 0).map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");

/** 版のFTS行数（索引に入っているchunkの数。jobの効果と重複の計算に使う） */
const ftsCount = async (versionId: string): Promise<number> =>
  (await env.DB.prepare("SELECT count(*) AS n FROM document_chunks_fts WHERE version_id = ?").bind(versionId).first<{ n: number }>())!.n;

/**
 * 「古いbackend」（索引そのもの）のraw hit。unit前置のみでACL・承認状態の条件は無い
 * （＝生の索引の中身。ここから検索adapterが何を落とすかを数える）。
 */
const rawFtsHits = async (query: string, unitId: string) =>
  (
    await env.DB.prepare(
      "SELECT chunk_id, version_id FROM document_chunks_fts WHERE document_chunks_fts MATCH ? AND unit_id = ? ORDER BY rank",
    ).bind(ftsMatch(query), unitId).all<{ chunk_id: string; version_id: string }>()
  ).results;

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();
const versionIdsOf = (chunks: readonly AuthorizedChunk[]): string[] => sortedUnique(chunks.map((c) => c.versionId));

describe("選定した索引の投入・検索・失効回収 (T066)", () => {
  it("index_hit_is_filtered_by_current_d1_acl_and_version", { timeout: 300_000 }, async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // PER-11管理（作成・ACL変更・撤回）＋PER-10（承認）
    const member = a.people.member; // 一般団員（ACL失権で遮断される側）
    const fixtures = loadPdfFixtures();
    const sampleBytes = fixtures.sample;

    // T065が選定した固定config（d1_fts＋trigram・version=search-dev-v1）で検索portを作る
    const port = createRetrievalPort(env, parseSearchConfig(searchDevelopmentConfigJson));
    // trigramで一致する検索語（3字以上。sample-jaの1頁にある句）
    const QUERY = "防災対策本部の設置";
    expect(SAMPLE_JA_PAGES[0]).toContain(QUERY);

    // === ①承認版の索引投入（document.index job）→ 検索hit ==============================
    const docP = await createPublicDocument(admin, "水防活動要領（索引試験・架空版）");
    const attP = await uploadPdfOriginal(admin, docP.id, sampleBytes);
    const v1Created = await createVersion(admin, docP.id, attP);
    const v1 = v1Created.version.id;
    await runJobs(); // 抽出job（document.extract）→ chunks（index_status='pending'）
    expect((await jobRowOf(v1Created.job.id)).status).toBe("succeeded");
    const v1Chunks = await chunkRows(v1);
    expect(v1Chunks.length).toBeGreaterThan(0);
    expect(v1Chunks.every((r) => r.index_status === "pending" && r.index_key === null)).toBe(true);

    // 承認（API-75）→ document.index jobがenqueueされる（T063の経路。handlerは本タスク）
    const approvedP1 = await approveVersion(docP.id, 1, admin);
    expect(approvedP1.versionId).toBe(v1);
    const indexJobP1 = approvedP1.indexJobId!;
    expect((await jobRowOf(indexJobP1)).kind).toBe("document.index");
    expect((await jobRowOf(indexJobP1)).dedupe_key).toBe(`${a.id}|document.index|${docP.id}|${v1}`);
    await runJobs();
    const indexJobP1Row = await jobRowOf(indexJobP1);
    expect(indexJobP1Row.status).toBe("succeeded");
    expect(indexJobP1Row.result_ref).toBe(`indexed:${v1Chunks.length}`);
    // 索引化の確定: chunksはindexed＋index_key（FTS行との対応）が付き、FTS行が同じ数だけ入る
    const v1ChunksAfter = await chunkRows(v1);
    expect(v1ChunksAfter.every((r) => r.index_status === "indexed")).toBe(true);
    expect(v1ChunksAfter.every((r) => r.index_key === `d1_fts:v1/${r.id}`)).toBe(true);
    expect(await ftsCount(v1)).toBe(v1Chunks.length);
    // 検索hit（承認済み・索引済み。chunk本文はchunks側の正本から返る）
    const hitsP1 = await port.search(principalOf(admin), { query: QUERY, documentIds: [docP.id] });
    expect(hitsP1.length).toBeGreaterThan(0);
    expect(versionIdsOf(hitsP1)).toEqual([v1]);
    expect(hitsP1.every((c) => v1ChunksAfter.some((row) => row.id === c.chunkId && row.text === c.text))).toBe(true);

    // === ②版変更（v2の承認でv1はsuperseded。v1のFTS行は削除されずに残る＝古い行） ============
    const v2Created = await createVersion(admin, docP.id, attP);
    const v2 = v2Created.version.id;
    expect(v2Created.version.revisionNo).toBe(2);
    await runJobs(); // v2の抽出
    const approvedP2 = await approveVersion(docP.id, 2, admin);
    const v2IndexJobId = approvedP2.indexJobId!;
    await runJobs(); // v2の索引化（v1へのdeindex jobは無い＝索引の整理は意図的に遅延してよい）
    expect((await jobRowOf(v2IndexJobId)).status).toBe("succeeded");
    expect((await fx.rows("document_versions", { id: v1 }))[0]!.status).toBe("superseded");
    // 古いFTS行が残っていること（これが「古いbackend hit」の正体。後段の検索で落とせることを示す）
    expect(await ftsCount(v1)).toBe(v1Chunks.length);
    const v2Chunks = await chunkRows(v2);
    expect(await ftsCount(v2)).toBe(v2Chunks.length);

    // === ③文書Q: 承認→索引化→ACL失権（団員からdeny。索引には残ったまま） =================
    const docQ = await createPublicDocument(admin, "給水要領（索引試験・架空版）");
    const attQ = await uploadPdfOriginal(admin, docQ.id, sampleBytes);
    const vQ = (await createVersion(admin, docQ.id, attQ)).version.id;
    await runJobs();
    await approveVersion(docQ.id, 1, admin);
    await runJobs();
    // ACL失権前は団員にもhitする
    const qHitsBefore = await port.search(principalOf(member), { query: QUERY, documentIds: [docQ.id] });
    expect(versionIdsOf(qHitsBefore)).toEqual([vQ]);
    // ACL引上げ（団員をdeny）。API-99がdocument.reindex jobをenqueueする（handlerはまだ実行しない）
    const qAcl = await changeAcl(docQ.id, [
      { roleId: ROLE_IDS.admin, permission: "PER-11", effect: "allow" },
      { roleId: ROLE_IDS.officer, permission: "PER-11", effect: "allow" },
      { roleId: ROLE_IDS.member, permission: "PER-11", effect: "deny" },
    ], admin);
    const reindexJobQ = qAcl.reindexJob!.id;
    // **索引削除（reindex job）が遅れている状態でも、団員の検索からは即落ちする**（docs/06 §5.5）
    expect(await ftsCount(vQ)).toBeGreaterThan(0); // 索引にはまだ残っている
    const qHitsMember = await port.search(principalOf(member), { query: QUERY, documentIds: [docQ.id] });
    expect(qHitsMember).toEqual([]); // 検索前条件＋再検査で落ちる（ unauthorizedChunks=0の担保）
    const qHitsAdmin = await port.search(principalOf(admin), { query: QUERY, documentIds: [docQ.id] });
    expect(versionIdsOf(qHitsAdmin)).toEqual([vQ]); // 見える者には引き続きhitする
    // reindex jobの実行: 版は承認済み・非withdrawnのままなので索引は再構築（収束）される
    await runJobs();
    expect((await jobRowOf(reindexJobQ)).status).toBe("succeeded");
    expect(await ftsCount(vQ)).toBe((await chunkRows(vQ)).length); // 行数は変わらない（全削除+再投入）
    expect(await port.search(principalOf(member), { query: QUERY, documentIds: [docQ.id] })).toEqual([]);

    // === ④撤回: 索引削除（deindex job）が遅れても検索からは即落ち、job実行で回収 ==============
    const docR = await createPublicDocument(admin, "点検結果（索引試験・架空版）");
    const attR = await uploadPdfOriginal(admin, docR.id, sampleBytes);
    const vR = (await createVersion(admin, docR.id, attR)).version.id;
    await runJobs();
    await approveVersion(docR.id, 1, admin);
    await runJobs();
    expect(await port.search(principalOf(admin), { query: QUERY, documentIds: [docR.id] }).then(versionIdsOf)).toEqual([vR]);
    const withdrawnR = await withdrawDocument(docR.id, admin);
    const deindexJobR = withdrawnR.deindexJob!.id;
    // deindex jobはまだ実行しない（索引削除の遅延）。それでも検索からは即落ちする
    expect((await jobRowOf(deindexJobR)).status).toBe("queued");
    expect(await ftsCount(vR)).toBe((await chunkRows(vR)).length); // 索引には残ったまま
    expect(await port.search(principalOf(admin), { query: QUERY, documentIds: [docR.id] })).toEqual([]);
    // deindex jobの実行でFTS行が削除され、chunksはremoved（現在状態の正本）になる
    await runJobs();
    expect((await jobRowOf(deindexJobR)).status).toBe("succeeded");
    expect((await jobRowOf(deindexJobR)).result_ref).toBe(`removed:${(await chunkRows(vR)).length}`);
    expect(await ftsCount(vR)).toBe(0);
    expect((await chunkRows(vR)).every((r) => r.index_status === "removed" && r.index_key === null)).toBe(true);

    // === ⑤失権中のindex jobは索引化しない（staleIndexActivated=false） ===================
    // 承認（index job enqueue）→ 撤回（deindex job enqueue）→ ここで初めてjobを実行する。
    // index jobは実行時に現状態（withdrawn）と突き合わせて、索引化せずstaleになる
    const docS = await createPublicDocument(admin, "撤回される資料（索引試験・架空版）");
    const attS = await uploadPdfOriginal(admin, docS.id, sampleBytes);
    const vS = (await createVersion(admin, docS.id, attS)).version.id;
    await runJobs();
    const approvedS = await approveVersion(docS.id, 1, admin); // index jobはqueuedのまま
    const indexJobS = approvedS.indexJobId!;
    const withdrawnS = await withdrawDocument(docS.id, admin); // deindex jobもqueuedのまま
    const deindexJobS = withdrawnS.deindexJob!.id;
    await runJobs();
    expect((await jobRowOf(indexJobS)).status).toBe("stale");
    expect((await jobRowOf(indexJobS)).error_code).toBe("document_version_not_indexable");
    expect((await jobRowOf(deindexJobS)).status).toBe("succeeded");
    const staleIndexActivated = (await ftsCount(vS)) > 0;
    expect(staleIndexActivated).toBe(false); // ブリーフのassertion（失権版は索引化しない）
    expect((await chunkRows(vS)).every((r) => r.index_status === "removed")).toBe(true);
    expect(await port.search(principalOf(admin), { query: QUERY, documentIds: [docS.id] })).toEqual([]);

    // === ⑥同じjobの重複実行で効果0（全削除+再投入の冪等。lease失効後の再実行を模倣） ===========
    const ftsV2Before = await ftsCount(v2);
    expect(await reRunHandler(indexDocument, v2IndexJobId)).toMatchObject({ kind: "succeeded" });
    const ftsV2AfterFirst = await ftsCount(v2);
    expect(await reRunHandler(indexDocument, v2IndexJobId)).toMatchObject({ kind: "succeeded" });
    const ftsV2AfterSecond = await ftsCount(v2);
    expect(await reRunHandler(indexDocument, deindexJobR)).toMatchObject({ kind: "succeeded" });
    const ftsVRAfterDeindexRerun = await ftsCount(vR);
    const duplicateIndexEffects =
      ftsV2AfterSecond - ftsV2AfterFirst + (ftsVRAfterDeindexRerun - 0);
    expect(duplicateIndexEffects).toBe(0); // ブリーフのassertion（重複実行で索引行が増えない）
    expect(ftsV2AfterFirst).toBe(ftsV2Before); // 再投入でも行数は不変
    expect((await chunkRows(v2)).every((r) => r.index_status === "indexed")).toBe(true);

    // === ⑦抽出jobの再実行でchunk行が作り直された場合: 孤児FTS行は検索で返らず、reindexで回復 ======
    // （lease失効後の抽出job再実行。新chunk行（新id・pending）に付け替わるため、旧FTS行は孤児になる）
    expect(await reRunHandler(extractDocumentVersion, v2Created.job.id)).toMatchObject({ kind: "succeeded" });
    const v2ChunksReextracted = await chunkRows(v2);
    expect(v2ChunksReextracted.every((r) => r.index_status === "pending")).toBe(true);
    expect(v2ChunksReextracted.some((r) => v2Chunks.some((old) => old.id === r.id))).toBe(false); // chunk行は別物
    expect(await ftsCount(v2)).toBe(v2Chunks.length); // FTS行は旧chunk_idのまま残る（次のjobまで）
    // 検索はchunks側の正本（index_status='indexed'かつ実在行）に従い、孤児FTS行を返さない
    const orphanHits = await port.search(principalOf(admin), { query: QUERY, documentIds: [docP.id] });
    expect(orphanHits).toEqual([]);
    // reindex job（ACL変更と同じ本番経路）で索引が現chunksへ再構築され、検索が回復する
    await changeAcl(docP.id, [
      { roleId: ROLE_IDS.member, permission: "PER-11", effect: "allow" },
      { roleId: ROLE_IDS.operator, permission: "PER-11", effect: "allow" },
      { roleId: ROLE_IDS.officer, permission: "PER-11", effect: "allow" },
      { roleId: ROLE_IDS.admin, permission: "PER-11", effect: "allow" },
    ], admin);
    await runJobs();
    expect(await ftsCount(v2)).toBe(v2ChunksReextracted.length);
    const recovered = await port.search(principalOf(admin), { query: QUERY, documentIds: [docP.id] });
    expect(versionIdsOf(recovered)).toEqual([v2]);
    expect(recovered.every((c) => v2ChunksReextracted.some((row) => row.id === c.chunkId))).toBe(true);
    expect(recovered.every((c) => c.chunkNo >= 1 && c.text.length > 0)).toBe(true);

    // === ⑧古いbackend hit ＋ 現ACL/版の再検査（ブリーフのassertion①） ====================
    // 索引（FTS）には 旧版v1（superseded）の行も残っている。生の索引結果のうち、現時点で
    // 承認済み・可視の版だけが検索結果に現れる（returnedVersionIds === currentAuthorizedVersionIds）
    const rawHits = await rawFtsHits(QUERY, a.id);
    const rawHitVersionIds = sortedUnique(rawHits.map((r) => r.version_id));
    expect(rawHitVersionIds).toContain(v1); // 古い行が索引に残っていること（退避は意図的に遅延してよい）
    expect(rawHitVersionIds).not.toContain(vR); // 撤回分はdeindex jobで回収済み
    const adminAuthorized = await authorizedDocumentVersions(env, principalOf(admin), rawHitVersionIds);
    const currentAuthorizedVersionIds = sortedUnique(adminAuthorized.map((v) => v.id));
    expect(currentAuthorizedVersionIds).toEqual(sortedUnique([v2, vQ])); // 旧版と撤回分は正本に現れない
    const finalResult = await port.search(principalOf(admin), { query: QUERY, topK: 20 });
    const returnedVersionIds = versionIdsOf(finalResult);
    expect(returnedVersionIds).toEqual(currentAuthorizedVersionIds); // ブリーフのassertion
    // 団員の再検査: ACL失権した文書Qの分は落ち、残るのはv2だけ（②の再検査が実働している証拠）
    const memberAuthorized = sortedUnique(
      (await authorizedDocumentVersions(env, principalOf(member), rawHitVersionIds)).map((v) => v.id),
    );
    expect(memberAuthorized).toEqual([v2]);
    const memberResult = await port.search(principalOf(member), { query: QUERY, topK: 20 });
    expect(versionIdsOf(memberResult)).toEqual(memberAuthorized);
    // 再検査で落とされたchunk（文書Q・団員分）がraw hitに存在すること＝再検査が実働している
    const rawChunkIds = new Set(rawHits.map((r) => r.chunk_id));
    const memberReturnedChunkIds = new Set(memberResult.map((c) => c.chunkId));
    const droppedForMember = [...rawChunkIds].filter((id) => !memberReturnedChunkIds.has(id));
    expect(droppedForMember.length).toBeGreaterThan(0);
    // 戻すのは承認済み・可視のchunkだけ（unauthorizedChunks=0）
    const authorizedVersionSet = new Set(currentAuthorizedVersionIds);
    expect(finalResult.every((c) => authorizedVersionSet.has(c.versionId))).toBe(true);
  });
});
