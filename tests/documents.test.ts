import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import "../src/server/jobs/handlers/attachment"; // 添付検査jobの登録（原本をreadyへ進める）
import { runDueJobs } from "../src/server/jobs/runner";
import { ROLE_IDS } from "./fixtures/core";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

// 許諾文書の原本・版・閲覧API（T062、docs/04:149-152、docs/05 API-73/74/90/91、docs/06 §5、docs/10 §2/§4）。
// 承認・撤回・ACL変更（API-75/92/99）はT063。抽出job handlerはT064（jobはqueuedのまま滞在する）。

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

const pngBytes = () => {
  // 検査を通る最小のPNG（eXIf等なし。attachments.test.tsと同じもの）
  const magic = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let table: number[] = [];
  const crc32 = (bytes: Uint8Array) => {
    if (!table.length) {
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    }
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    new DataView(out.buffer).setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1);
  new DataView(ihdr.buffer).setUint32(4, 1);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [magic, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01])), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** 公開文書（全役割のallow）を作る。aclの許可判定はdeny優先＋行一致で行う（docs/04:151） */
async function createDocument(who: Identity, title: string, acl: unknown) {
  const res = await fx.client(who).request("POST", "/api/v1/documents", { title, classification: "訓練資料", acl }, idem());
  expect(res.status).toBe(201);
  return (await json(res)).data! as { id: string; version: number; status: string; policyVersion: number };
}

/**
 * 文書の原本添付（API-26のdirect target）。runInspect=falseのときは検査jobを走らせず
 * uploaded（未検査=未ready）のまま返す（422 ATTACHMENT_NOT_READYを作る）
 */
async function uploadOriginal(who: Identity, documentId: string, runInspect: boolean): Promise<string> {
  const iRes = await fx.client(who).request(
    "POST", "/api/v1/attachments/upload-intents",
    { target: { type: "document", id: documentId }, contentType: "image/png", byteSize: 100 }, idem(),
  );
  expect(iRes.status).toBe(201);
  const intent = (await json(iRes)).data! as { id: string; uploadToken: string };
  const up = await fx.raw(who)(new Request(`http://example.com/api/v1/attachments/${intent.id}/upload`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "x-upload-token": intent.uploadToken },
    body: pngBytes() as BufferSource,
  }));
  expect(up.status).toBe(200);
  const attempt = (await json(up)).data! as { id: string; sha256: string };
  const comp = await fx.client(who).request(
    "POST", `/api/v1/attachments/${intent.id}/completion`,
    { version: 1, uploadAttemptId: attempt.id, sha256: attempt.sha256 }, idem(),
  );
  expect(comp.status).toBe(202);
  if (runInspect) await runDueJobs(env);
  return intent.id;
}

describe("許諾文書の原本・版・閲覧API (T062)", () => {
  it("document_version_requires_ready_original_and_license", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // PER-11管理（幹部・管理者）
    const member = a.people.member; // 一般団員（PER-11は全役割だがACLで絞られる）

    // --- 準備: 公開文書（全役割allow。deny優先のACL判定で全員に見える） ---
    const doc = await createDocument(admin, "水防活動要領（架空版）", [
      { roleId: ROLE_IDS.member, permission: "PER-11", effect: "allow" },
      { roleId: ROLE_IDS.operator, permission: "PER-11", effect: "allow" },
      { roleId: ROLE_IDS.officer, permission: "PER-11", effect: "allow" },
      { roleId: ROLE_IDS.admin, permission: "PER-11", effect: "allow" },
    ]);
    expect(doc.status).toBe("draft");
    expect(doc.policyVersion).toBe(1);

    // --- 1) 未検査原本（ready前）への版作成は422 ATTACHMENT_NOT_READY ---
    const unreadyId = await uploadOriginal(admin, doc.id, false);
    const unreadyOriginal = await fx.client(admin).request("POST", `/api/v1/documents/${doc.id}/versions`, {
      version: doc.version, attachmentId: unreadyId, licenseRef: "架空・自団体作成 (2026)",
    }, idem());
    expect(unreadyOriginal.status).toBe(422);

    // --- 2) 許諾なし（licenseRef省略）は契約違反で400 ---
    const missingLicense = await fx.client(admin).request("POST", `/api/v1/documents/${doc.id}/versions`, {
      version: doc.version, attachmentId: unreadyId,
    }, idem());
    expect(missingLicense.status).toBe(400);

    // --- 3) 別unitの添付は存在を明かさない404 ---
    const docB = await createDocument(fx.units.b.people.admin, "別分団の資料（架空）", [
      { roleId: ROLE_IDS.admin, permission: "PER-11", effect: "allow" },
    ]);
    const bOriginalId = await uploadOriginal(fx.units.b.people.admin, docB.id, true);
    const crossUnit = await fx.client(admin).request("POST", `/api/v1/documents/${doc.id}/versions`, {
      version: doc.version, attachmentId: bOriginalId, licenseRef: "架空・自団体作成 (2026)",
    }, idem());
    expect(crossUnit.status).toBe(404);

    // --- 4) 検査を通した原本で初版を作る（202=抽出jobの受付。完了ではない） ---
    await runDueJobs(env); // 未検査だった原本をreadyへ進める
    const originalHashBefore = (await fx.rows("attachments", { id: unreadyId }))[0]!.sha256 as string;
    const created = await fx.client(admin).request("POST", `/api/v1/documents/${doc.id}/versions`, {
      version: doc.version, attachmentId: unreadyId, licenseRef: "架空・自団体作成 (2026)",
    }, idem());
    expect(created.status).toBe(202);
    const versioned = (await json(created)).data! as {
      version: { id: string; documentId: string; revisionNo: number; attachmentId: string; status: string; licenseRef: string; contentHash: string };
      job: { id: string; status: string };
    };
    expect(versioned.version.revisionNo).toBe(1);
    expect(versioned.version.documentId).toBe(doc.id);
    expect(versioned.version.attachmentId).toBe(unreadyId);
    expect(versioned.version.status).toBe("draft");
    expect(versioned.version.licenseRef).toBe("架空・自団体作成 (2026)");
    // content_hashは版作成時に添付のsha256へ固定される（原本不変の検証点）
    expect(versioned.version.contentHash).toBe(originalHashBefore);
    expect(versioned.job.status).toBe("queued");
    // 抽出jobはkind=document.extract。unit|kind|document|versionのdedupe_key（T064のhandlerは別タスク）
    const jobRow = (await fx.rows("jobs", { id: versioned.job.id }))[0]!;
    expect(jobRow.kind).toBe("document.extract");
    expect(jobRow.dedupe_key).toBe(`${a.id}|document.extract|${doc.id}|${versioned.version.id}`);
    expect(jobRow.status).toBe("queued");
    // current_draft_version_idは新規版へ切替、current_version_id（承認済pointer）は触らない（T063以降）
    const rootRow = (await fx.rows("documents", { id: doc.id }))[0]!;
    expect(rootRow.current_draft_version_id).toBe(versioned.version.id);
    expect(rootRow.current_version_id).toBeNull();

    // 原本のsha256は版作成の前後で変わらない（原本不変）
    const originalHashAfter = (await fx.rows("attachments", { id: unreadyId }))[0]!.sha256 as string;
    expect(originalHashAfter).toBe(originalHashBefore);

    // --- 5) 改版: revision_noは文書ごとに1から採番され、新draftで切替わる。旧版・旧原本は不変 ---
    const secondId = await uploadOriginal(admin, doc.id, true);
    const secondHash = (await fx.rows("attachments", { id: secondId }))[0]!.sha256 as string;
    const created2 = await fx.client(admin).request("POST", `/api/v1/documents/${doc.id}/versions`, {
      version: doc.version + 1, attachmentId: secondId, licenseRef: "架空・改版の許諾 (2026)",
    }, idem());
    expect(created2.status).toBe(202);
    const versioned2 = (await json(created2)).data! as { version: { id: string; revisionNo: number; contentHash: string } };
    expect(versioned2.version.revisionNo).toBe(2);
    expect(versioned2.version.contentHash).toBe(secondHash);
    const rootRow2 = (await fx.rows("documents", { id: doc.id }))[0]!;
    expect(rootRow2.current_draft_version_id).toBe(versioned2.version.id);
    // 旧版の原本hash・許諾は書換わらない
    expect((await fx.rows("document_versions", { id: versioned.version.id }))[0]!.content_hash).toBe(originalHashBefore);

    // --- 6) 一覧・詳細: 公開文書は一般団員にも見え、版と原本を辿れる ---
    const listForMember = await fx.client(member).request("GET", "/api/v1/documents");
    expect(listForMember.status).toBe(200);
    const memberRows = ((await json(listForMember)).data ?? []) as unknown as { id: string }[];
    expect(memberRows.some((r) => r.id === doc.id)).toBe(true);

    const detail = await fx.client(member).request("GET", `/api/v1/documents/${doc.id}`);
    expect(detail.status).toBe(200);
    const detailData = (await json(detail)).data! as {
      document: { id: string; currentDraftVersionId: string; currentVersionId: string | null };
      versions: { id: string; revisionNo: number; licenseRef: string; contentHash: string }[];
      original: { attachmentId: string; status: string; contentType: string };
    };
    // revision?省略は現在のdraft版。引用元版をrevisionで辿れる
    expect(detailData.document.currentDraftVersionId).toBe(versioned2.version.id);
    expect(detailData.document.currentVersionId).toBeNull();
    expect(detailData.versions.map((v) => v.revisionNo)).toEqual([1, 2]);
    expect(detailData.original.attachmentId).toBe(secondId);
    expect(detailData.original.status).toBe("ready");
    expect(detailData.original.contentType).toBe("image/png");
    // revision指定で旧版の原本・許諾を辿れる
    const detailV1 = await fx.client(member).request("GET", `/api/v1/documents/${doc.id}?revision=1`);
    expect(detailV1.status).toBe(200);
    const v1Data = (await json(detailV1)).data! as { original: { attachmentId: string }; versions: { revisionNo: number }[] };
    expect(v1Data.original.attachmentId).toBe(unreadyId);

    // --- 7) 非公開文書（幹部だけにallow）は一覧の行・件数にも現れず、詳細も404 ---
    const officer = a.people.officer;
    const privateDoc = await createDocument(admin, "非公開の運用資料（架空）", [
      { memberId: officer.memberId!, permission: "PER-11", effect: "allow" },
    ]);
    await uploadOriginal(admin, privateDoc.id, true);
    await fx.client(admin).request("POST", `/api/v1/documents/${privateDoc.id}/versions`, {
      version: privateDoc.version, attachmentId: (await fx.rows("attachments", { intent_target_id: privateDoc.id }))[0]!.id as string,
      licenseRef: "架空・非公開資料の許諾",
    }, idem());

    const listForMember2 = await fx.client(member).request("GET", "/api/v1/documents");
    expect(listForMember2.status).toBe(200);
    const rows2 = ((await json(listForMember2)).data ?? []) as unknown as { id: string }[];
    const hiddenDocumentRows = rows2.filter((r) => r.id === privateDoc.id);
    expect(hiddenDocumentRows).toEqual([]);
    // 件数でも漏らさない（公開文書だけが載る）
    expect(rows2.some((r) => r.id === doc.id)).toBe(true);
    // 詳細も存在を明かさない404
    const hiddenDetail = await fx.client(member).request("GET", `/api/v1/documents/${privateDoc.id}`);
    expect(hiddenDetail.status).toBe(404);
    // 幹部（allowの本人）は見える
    const officerList = ((await json(await fx.client(officer).request("GET", "/api/v1/documents"))).data ?? []) as unknown as { id: string }[];
    expect(officerList.some((r) => r.id === privateDoc.id)).toBe(true);
    expect((await fx.client(officer).request("GET", `/api/v1/documents/${privateDoc.id}`)).status).toBe(200);

    // --- 8) 管理操作はPER-11＋幹部・管理者（一般団員・担当の権限では作れない） ---
    const memberCreate = await fx.client(member).request("POST", "/api/v1/documents", {
      title: "団員が作ろうとした文書", classification: "訓練資料",
      acl: [{ roleId: ROLE_IDS.member, permission: "PER-11", effect: "allow" }],
    }, idem());
    expect(memberCreate.status).toBe(403);
    // 同unit外の文書は存在も明かさない（B分団の管理者からはA分団の非公開文書が見えない）
    const otherUnitDetail = await fx.client(fx.units.b.people.admin).request("GET", `/api/v1/documents/${privateDoc.id}`);
    expect(otherUnitDetail.status).toBe(404);
  });

  /**
   * 撤回済み（withdrawn）文書への新draft版作成は422 INVALID_TRANSITION（PH5レビューA低2）。
   * 撤回は終端（docs/11）。旧実装は撤回後も版作成→draft pointer切替→抽出job登録まで通った
   * （抽出handlerがstaleに落ちるため実害は無いが、終端への書込経路が残るdocs/11との不整合）。
   */
  it("withdrawn_document_rejects_new_version_with_422", async () => {
    const admin = fx.units.a.people.admin;
    const doc = await createDocument(admin, "撤回後の版作成（架空版）", [
      { roleId: ROLE_IDS.member, permission: "PER-11", effect: "allow" },
      { roleId: ROLE_IDS.operator, permission: "PER-11", effect: "allow" },
      { roleId: ROLE_IDS.officer, permission: "PER-11", effect: "allow" },
      { roleId: ROLE_IDS.admin, permission: "PER-11", effect: "allow" },
    ]);
    const originalId = await uploadOriginal(admin, doc.id, true);
    // 撤回（API-92。draft→withdrawnの終端）
    const wRes = await fx.client(admin).request("POST", `/api/v1/documents/${doc.id}/withdrawal`,
      { version: doc.version, reason: "許諾の期限切れ（架空）" }, idem());
    expect(wRes.status).toBe(200);
    // 撤回後の版作成は422 INVALID_TRANSITION（旧コードは202でFAIL）
    const res = await fx.client(admin).request("POST", `/api/v1/documents/${doc.id}/versions`,
      { version: (await fx.rows("documents", { id: doc.id }))[0]!.version as number, attachmentId: originalId, licenseRef: "架空・自団体作成 (2026)" }, idem());
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error?: { code: string } }).error?.code).toBe("INVALID_TRANSITION");
    // 版は増えない（終端への書込0）
    expect(await fx.rows("document_versions", { document_id: doc.id })).toHaveLength(0);
  });
});
