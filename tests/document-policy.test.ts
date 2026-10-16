import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import "../src/server/jobs/handlers/attachment"; // 添付検査jobの登録（原本をreadyへ進める）
import { runDueJobs } from "../src/server/jobs/runner";
import type { RoleCode } from "../src/server/auth/authorize";
import type { AuthzPrincipal } from "../src/server/auth/principal";
import { ROLE_IDS } from "./fixtures/core";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

/**
 * 文書の承認・撤回・ACL変更と即時検索遮断（T063、docs/05 API-75/92/99、docs/06 §5、docs/10 §2/§4、docs/11 報告書/文書版）。
 *
 * - 申請（request_review）と最終決定（approve）の分離（T058のreports流儀）:
 *   request_review/changes_requestedはcontent_version_eventsへの追記だけで決定行（review_decisions）は作らない。
 *   approveだけがreview_decisionsのdocument_version_id非NULL UNIQUEで一版一回（二重approveは409 DUPLICATE）。
 *   approveは版をapprovedへ、旧承認版をsupersededへ、documents.current_version_idを次版へ切替え、
 *   document.index jobを永続化する（handlerはT066。T063はenqueueまで）。
 * - 撤回（API-92）は終端（二重撤回は422）。文書status→withdrawn＋events＋document.deindex job。
 *   撤回後は一覧・詳細・原文・版の全GETが404（存在も明かさない）。
 * - ACL変更（API-99）はACL全置換＋classification変更＋policy_version増分＋document.reindex job。
 *   可視範囲を緩和する方向の変更も、管理権限（PER-11＋幹部・管理者）のPATCH自体を承認とみなし、
 *   向きを監査に記録する（D03未承認の検証設定。docs/16 T063）。
 * - 即時遮断（docs/06 §5「ACL変更/撤回はD1側で即除外しdeindex jobを作る」）:
 *   撤回/ACL失効は索引削除を待たずD1の可視性判定で除外される。authorizedDocumentVersions
 *   （承認済み＋現ACL可視の版だけを返す共通の正本）が検索・引用・原文取得の全経路で使われるため、
 *   索引遅延（deindex/reindex jobがqueuedのまま）があっても旧引用・原文取得は遮断される。
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

const pngBytes = () => {
  // 検査を通る最小のPNG（documents.test.tsと同じもの）
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

/** 公開文書（全役割のallow。deny優先のACL判定で全員に見える） */
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
  return (await json(res)).data! as { id: string; version: number; status: string; policyVersion: number };
}

/** 文書の原本添付（API-26 direct target）を作り検査jobでreadyまで進める */
async function uploadOriginal(who: Identity, documentId: string): Promise<string> {
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
  await runDueJobs(env);
  return intent.id;
}

/** 版作成（API-74。202=抽出jobの受付） */
async function createVersion(who: Identity, documentId: string, attachmentId: string, licenseRef: string) {
  const root = (await fx.rows("documents", { id: documentId }))[0]!;
  const res = await fx.client(who).request("POST", `/api/v1/documents/${documentId}/versions`, {
    version: root.version as number, attachmentId, licenseRef,
  }, idem());
  expect(res.status).toBe(202);
  const data = (await json(res)).data! as { version: { id: string; revisionNo: number; status: string }; job: { id: string } };
  return data.version;
}

/** API-75の決定。versionは文書rootの現行版、documentVersionは対象版のrevision_no */
const decide = (documentId: string, body: Record<string, unknown>, who: Identity = fx.units.a.people.admin) =>
  fx.client(who).request("POST", `/api/v1/documents/${documentId}/decision`, body, idem());

const rootVersion = async (documentId: string) => (await fx.rows("documents", { id: documentId }))[0]!.version as number;
const versionRow = async (versionId: string) => (await fx.rows("document_versions", { id: versionId }))[0]!;
const documentRow = async (documentId: string) => (await fx.rows("documents", { id: documentId }))[0]!;

/** authorizedDocumentVersionsへ渡す主体（試験用の最小構成。rolesはfixturesの役割） */
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

describe("文書の承認・撤回・ACL変更と即時検索遮断 (T063)", () => {
  it("withdrawal_blocks_search_before_index_cleanup", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // PER-11管理（作成・ACL変更・撤回）＋PER-10（承認）
    const officer = a.people.officer;
    const member = a.people.member; // 一般団員（ACLで見えていた対象。失効で遮断される側）

    // === 文書A: 承認→ACL失効（API-99）で団員から即遮断 ===
    const docA = await createPublicDocument(admin, "水防訓練資料（架空版）");
    const originalA = await uploadOriginal(admin, docA.id);
    const verA = await createVersion(admin, docA.id, originalA, "架空・自団体作成 (2026)");
    expect(verA.revisionNo).toBe(1);

    // --- 1) 申請（request_review）: draft→in_review。決定行は作らない（docs/11の核心。T058流儀） ---
    expect((await decide(docA.id, {
      version: await rootVersion(docA.id), documentVersion: 1, decision: "request_review", reason: "原本の準備ができたため申請します",
    })).status).toBe(200);
    expect((await versionRow(verA.id)).status).toBe("in_review");
    expect(await fx.rows("content_version_events", { document_version_id: verA.id, action: "request_review" })).toHaveLength(1);
    expect(await fx.rows("review_decisions", { document_version_id: verA.id })).toHaveLength(0);
    // in_reviewからの二重申請は422
    const resubmit = await decide(docA.id, {
      version: await rootVersion(docA.id), documentVersion: 1, decision: "request_review", reason: "二重申請",
    });
    expect(resubmit.status).toBe(422);
    expect((await json(resubmit)).error?.code).toBe("INVALID_TRANSITION");
    // 承認はPER-10（一般団員は403。存在を問わず拒否）
    expect((await decide(docA.id, {
      version: await rootVersion(docA.id), documentVersion: 1, decision: "approve", reason: "承認します",
    }, member)).status).toBe(403);

    // --- 2) 承認（approve）: 一版一決定の決定行＋版をapproved＋承認済pointer切替＋document.index job ---
    const approveRes = await decide(docA.id, {
      version: await rootVersion(docA.id), documentVersion: 1, decision: "approve", reason: "内容と許諾を確認しました",
    });
    expect(approveRes.status).toBe(200);
    const approved = (await json(approveRes)).data! as {
      documentId: string; versionId: string; revisionNo: number; status: string;
      decision: string; reviewDecisionId: string | null; indexJobId: string | null;
    };
    expect(approved.documentId).toBe(docA.id);
    expect(approved.versionId).toBe(verA.id);
    expect(approved.revisionNo).toBe(1);
    expect(approved.status).toBe("approved");
    expect(approved.decision).toBe("approve");
    expect((await versionRow(verA.id)).status).toBe("approved");
    expect((await versionRow(verA.id)).approved_by).toBe(admin.memberId);
    expect((await documentRow(docA.id)).status).toBe("approved");
    expect((await documentRow(docA.id)).current_version_id).toBe(verA.id);
    // 一版一決定（document_version_id非NULL UNIQUE）。二重approveは409
    const doubleApprove = await decide(docA.id, {
      version: await rootVersion(docA.id), documentVersion: 1, decision: "approve", reason: "二重承認",
    });
    expect(doubleApprove.status).toBe(409);
    const finalDecisionsPerVersion = (await fx.rows("review_decisions", { document_version_id: verA.id })).length;
    expect(finalDecisionsPerVersion).toBe(1);
    // 承認のeventsとdocument.index job（handlerはT066。queuedで滞在）
    expect(await fx.rows("content_version_events", { document_version_id: verA.id, action: "approved" })).toHaveLength(1);
    const indexJobRow = (await fx.rows("jobs", { id: approved.indexJobId! }))[0]!;
    expect(indexJobRow.kind).toBe("document.index");
    expect(indexJobRow.dedupe_key).toBe(`${a.id}|document.index|${docA.id}|${verA.id}`);
    expect(indexJobRow.status).toBe("queued");

    // --- 3) 承認済み版は検索対象（authorizedDocumentVersions＝T066/T067の正本）に見える ---
    const { authorizedDocumentVersions } = await import("../src/server/documents/authorized");
    const eligibleVersionIdsBefore = (await authorizedDocumentVersions(env, principalOf(member), [verA.id])).map((v) => v.id);
    expect(eligibleVersionIdsBefore).toEqual([verA.id]);
    // 団員の一覧・詳細・原文にも見える
    const memberListBefore = ((await json(await fx.client(member).request("GET", "/api/v1/documents"))).data ?? []) as { id: string }[];
    expect(memberListBefore.some((r) => r.id === docA.id)).toBe(true);
    expect((await fx.client(member).request("GET", `/api/v1/documents/${docA.id}`)).status).toBe(200);
    // 原文（API-27の/content）も団員に見える
    expect((await fx.client(member).request("GET", `/api/v1/attachments/${originalA}/content`)).status).toBe(200);

    // --- 4) ACL変更（API-99）: 団員・担当のallowを外す（可視範囲の引上げ）。policy_version増分＋reindex job ---
    const policyRes = await fx.client(admin).request("PATCH", `/api/v1/documents/${docA.id}/access-policy`, {
      version: await rootVersion(docA.id), classification: "訓練資料（幹部限定）",
      acl: [
        { roleId: ROLE_IDS.officer, permission: "PER-11", effect: "allow" },
        { roleId: ROLE_IDS.admin, permission: "PER-11", effect: "allow" },
      ],
    }, idem());
    expect(policyRes.status).toBe(200);
    const policyData = (await json(policyRes)).data! as { document: { id: string; policyVersion: number }; reindexJob: { id: string } | null };
    expect(policyData.document.id).toBe(docA.id);
    expect(policyData.document.policyVersion).toBe(2);
    const reindexRow = (await fx.rows("jobs", { id: policyData.reindexJob!.id }))[0]!;
    expect(reindexRow.kind).toBe("document.reindex");
    expect(reindexRow.dedupe_key).toBe(`${a.id}|document.reindex|${docA.id}|${verA.id}`);
    // ACLの対象は実在まで検査（未知の団員は404）
    expect((await fx.client(admin).request("PATCH", `/api/v1/documents/${docA.id}/access-policy`, {
      version: await rootVersion(docA.id), classification: "訓練資料（幹部限定）",
      acl: [{ memberId: crypto.randomUUID(), permission: "PER-11", effect: "allow" }],
    }, idem())).status).toBe(404);

    // --- 5) 即時遮断: ACL失効は索引（reindex jobはqueuedのまま）を待たず団員から見えなくなる ---
    const eligibleVersionIdsAfter = (await authorizedDocumentVersions(env, principalOf(member), [verA.id])).map((v) => v.id);
    expect(eligibleVersionIdsAfter).toEqual([]);
    // 幹部は今も見える（文書全体が消えたのではなくACLで絞られた）
    expect((await authorizedDocumentVersions(env, principalOf(officer), [verA.id])).map((v) => v.id)).toEqual([verA.id]);
    const memberListAfter = ((await json(await fx.client(member).request("GET", "/api/v1/documents"))).data ?? []) as { id: string }[];
    expect(memberListAfter.filter((r) => r.id === docA.id)).toEqual([]);
    expect((await fx.client(member).request("GET", `/api/v1/documents/${docA.id}`)).status).toBe(404);
    // 旧引用経路（原文添付取得）も現ACLの再検査で遮断される（docs/06 §5「引用原文取得でも現ACLを検査」）
    const memberOriginalAfter = await fx.client(member).request("GET", `/api/v1/attachments/${originalA}/content`);
    expect(memberOriginalAfter.status).not.toBe(200);
    // 幹部の原文は今も読める
    expect((await fx.client(officer).request("GET", `/api/v1/attachments/${originalA}/content`)).status).toBe(200);
    // 引上げの向きが監査に記録される（docs/16 T063の裁定）
    const tightenAudit = (await fx.rows("audit_logs", { action: "document.access_policy.change" }))[0]!;
    expect(JSON.parse(tightenAudit.metadata_json as string)).toMatchObject({ direction: "tightened" });

    // --- 6) 緩和方向の変更（allow再付与）も管理PATCH自体を承認とみなし、jobはdedupeで1本・向きは監査へ ---
    const relaxRes = await fx.client(admin).request("PATCH", `/api/v1/documents/${docA.id}/access-policy`, {
      version: await rootVersion(docA.id), classification: "訓練資料",
      acl: [
        { roleId: ROLE_IDS.member, permission: "PER-11", effect: "allow" },
        { roleId: ROLE_IDS.operator, permission: "PER-11", effect: "allow" },
        { roleId: ROLE_IDS.officer, permission: "PER-11", effect: "allow" },
        { roleId: ROLE_IDS.admin, permission: "PER-11", effect: "allow" },
      ],
    }, idem());
    expect(relaxRes.status).toBe(200);
    expect(((await json(relaxRes)).data! as { document: { policyVersion: number } }).document.policyVersion).toBe(3);
    // 同じ版へのreindex jobはdedupe_keyで1本のまま
    expect(await fx.rows("jobs", { dedupe_key: `${a.id}|document.reindex|${docA.id}|${verA.id}` })).toHaveLength(1);
    expect((await authorizedDocumentVersions(env, principalOf(member), [verA.id])).map((v) => v.id)).toEqual([verA.id]);
    const relaxAudit = (await fx.rows("audit_logs", { action: "document.access_policy.change" }))[1]!;
    expect(JSON.parse(relaxAudit.metadata_json as string)).toMatchObject({ direction: "relaxed" });

    // === 文書B: 差戻し（changes_requested。決定行は作らない） ===
    const docC = await createPublicDocument(admin, "避難所運営要領（架空版）");
    const verC1 = await createVersion(admin, docC.id, await uploadOriginal(admin, docC.id), "架空・自団体作成 (2026)");
    expect((await decide(docC.id, {
      version: await rootVersion(docC.id), documentVersion: 1, decision: "request_review", reason: "申請",
    })).status).toBe(200);
    expect((await decide(docC.id, {
      version: await rootVersion(docC.id), documentVersion: 1, decision: "changes_requested", reason: "許諾の出典が不足しています",
    })).status).toBe(200);
    expect((await versionRow(verC1.id)).status).toBe("changes_requested");
    expect(await fx.rows("content_version_events", { document_version_id: verC1.id, action: "changes_requested" })).toHaveLength(1);
    expect(await fx.rows("review_decisions", { document_version_id: verC1.id })).toHaveLength(0);
    // changes_requestedは終端（docs/11 contentVersionTransitions）。再申請・承認は422
    expect((await decide(docC.id, {
      version: await rootVersion(docC.id), documentVersion: 1, decision: "request_review", reason: "再申請",
    })).status).toBe(422);
    expect((await decide(docC.id, {
      version: await rootVersion(docC.id), documentVersion: 1, decision: "approve", reason: "承認",
    })).status).toBe(422);
    expect(await fx.rows("review_decisions", { document_version_id: verC1.id })).toHaveLength(0);

    // === 文書D: v1承認→v2承認（v1はsuperseded）→撤回（API-92）で全員から即遮断 ===
    const docD = await createPublicDocument(admin, "給水拠点マニュアル（架空版）");
    const originalD1 = await uploadOriginal(admin, docD.id);
    const verD1 = await createVersion(admin, docD.id, originalD1, "架空・自団体作成 (2026)");

    // --- 7) v1を承認（初代の有効承認版）→ v2を作って承認 → 旧承認版v1はsupersededへ ---
    expect((await decide(docD.id, {
      version: await rootVersion(docD.id), documentVersion: 1, decision: "request_review", reason: "申請",
    })).status).toBe(200);
    expect((await decide(docD.id, {
      version: await rootVersion(docD.id), documentVersion: 1, decision: "approve", reason: "初版を承認します",
    })).status).toBe(200);
    expect((await versionRow(verD1.id)).status).toBe("approved");
    expect((await documentRow(docD.id)).current_version_id).toBe(verD1.id);

    const verD2 = await createVersion(admin, docD.id, await uploadOriginal(admin, docD.id), "架空・改版の許諾 (2026)");
    expect(verD2.revisionNo).toBe(2);
    // 新draft版の作成で承認済pointerを失わない（docs/11「承認済pointerは次版承認まで保持」）
    expect((await documentRow(docD.id)).current_version_id).toBe(verD1.id);
    expect((await decide(docD.id, {
      version: await rootVersion(docD.id), documentVersion: 2, decision: "request_review", reason: "改版を申請します",
    })).status).toBe(200);
    expect((await decide(docD.id, {
      version: await rootVersion(docD.id), documentVersion: 2, decision: "approve", reason: "改版を確認しました",
    })).status).toBe(200);
    expect((await versionRow(verD2.id)).status).toBe("approved");
    // 旧承認版はsupersededへ（status遷移だけで承認列は不変。docs/11 approved→superseded）
    expect((await versionRow(verD1.id)).status).toBe("superseded");
    expect((await versionRow(verD1.id)).approved_by).toBe(admin.memberId);
    expect(await fx.rows("content_version_events", { document_version_id: verD1.id, action: "superseded" })).toHaveLength(1);
    expect((await documentRow(docD.id)).status).toBe("approved");
    expect((await documentRow(docD.id)).current_version_id).toBe(verD2.id);

    // --- 8) 撤回（API-92）: 終端への辺。deindex jobを永続化して索引削除を遅延させる ---
    const withdrawal = await fx.client(admin).request("POST", `/api/v1/documents/${docD.id}/withdrawal`, {
      version: await rootVersion(docD.id), reason: "許諾の期限切れのため撤回します",
    }, idem());
    expect(withdrawal.status).toBe(200);
    const withdrawalData = (await json(withdrawal)).data! as {
      document: { id: string; status: string; currentVersionId: string | null };
      deindexJob: { id: string; status: string } | null;
    };
    expect(withdrawalData.document.id).toBe(docD.id);
    expect(withdrawalData.document.status).toBe("withdrawn");
    expect(await fx.rows("content_version_events", { document_version_id: verD2.id, action: "withdrawn" })).toHaveLength(1);
    // deindex job行の永続化（handlerはT066。queuedのまま＝索引削除はまだ）
    const deindexRow = (await fx.rows("jobs", { id: withdrawalData.deindexJob!.id }))[0]!;
    expect(deindexRow.kind).toBe("document.deindex");
    expect(deindexRow.dedupe_key).toBe(`${a.id}|document.deindex|${docD.id}|${verD2.id}`);
    const indexCleanupPending = deindexRow.status === "queued" || deindexRow.status === "retry_wait";
    expect(indexCleanupPending).toBe(true);
    // 撤回は終端。二重撤回は422
    expect((await fx.client(admin).request("POST", `/api/v1/documents/${docD.id}/withdrawal`, {
      version: await rootVersion(docD.id), reason: "二重撤回",
    }, idem())).status).toBe(422);

    // --- 9) 即時遮断: 撤回は索引削除を待たず、許可された役割（管理者）からも見えなくなる ---
    const eligibleVersionIdsWithdrawn = (await authorizedDocumentVersions(env, principalOf(admin), [verD2.id])).map((v) => v.id);
    expect(eligibleVersionIdsWithdrawn).toEqual([]);
    const adminList = ((await json(await fx.client(admin).request("GET", "/api/v1/documents"))).data ?? []) as { id: string }[];
    expect(adminList.filter((r) => r.id === docD.id)).toEqual([]);
    expect((await fx.client(admin).request("GET", `/api/v1/documents/${docD.id}`)).status).toBe(404);
    // 旧引用経路（原文添付取得）も撤回で遮断される
    const oldCitationContent = await fx.client(admin).request("GET", `/api/v1/attachments/${originalD1}/content`);
    expect(oldCitationContent.status).not.toBe(200);
    // 撤回済み文書のACL変更は422（終端）。承認は決定行不在検査が先で409（決定は1回のまま）
    expect((await fx.client(admin).request("PATCH", `/api/v1/documents/${docD.id}/access-policy`, {
      version: await rootVersion(docD.id), classification: "訓練資料",
      acl: [{ roleId: ROLE_IDS.admin, permission: "PER-11", effect: "allow" }],
    }, idem())).status).toBe(422);
    const lateApprove = await decide(docD.id, {
      version: await rootVersion(docD.id), documentVersion: 2, decision: "approve", reason: "撤回後の再承認",
    });
    expect(lateApprove.status).toBe(409);
    expect((await fx.rows("review_decisions", { document_version_id: verD2.id })).length).toBe(1);
  });
});
