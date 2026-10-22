import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import "../src/server/jobs/handlers/attachment"; // 検査jobの登録（添付をreadyへ進め、直targetは自動リンクする）
import { runDueJobs } from "../src/server/jobs/runner";
import { ROLE_IDS } from "./fixtures/core";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

// T091-S2（セキュリティ監査 run-1）: 添付の再紐付けで文書ACLを迂回できない。
// 紐付けてよい元添付は、本人が上げた・文書原本でない・有効リンクが自動紐付けか今回の紐付け先だけのもの。
// 機微対象への移動で消すのはその自動紐付けだけ。draftIdは予約の作成者だけが使える（H5。API-26と同じ照合）。

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) =>
  (await r.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: { field: string; reason: string }[] } };

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

/** intentを作って転送・完了まで進める（検査jobは呼び出し側でrunDueJobs） */
async function uploadTo(who: Identity, target: { type: string; id: string }): Promise<string> {
  const iRes = await fx.client(who).request(
    "POST", "/api/v1/attachments/upload-intents", { target, contentType: "image/png", byteSize: 100 }, idem(),
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
    "POST", `/api/v1/attachments/${intent.id}/completion`, { version: 1, uploadAttemptId: attempt.id, sha256: attempt.sha256 }, idem(),
  );
  expect(comp.status).toBe(202);
  return intent.id;
}

/** 予約（API-98）を作り、その予約へ1枚上げて検査まで済ませる */
async function draftWithReadyUpload(who: Identity, intendedEntityType: string): Promise<{ draftId: string; attachmentId: string }> {
  const dRes = await fx.client(who).request("POST", "/api/v1/attachment-drafts", { intendedEntityType }, idem());
  expect(dRes.status).toBe(201);
  const draftId = ((await json(dRes)).data! as { id: string }).id;
  const attachmentId = await uploadTo(who, { type: "attachment_draft", id: draftId });
  await runDueJobs(env);
  return { draftId, attachmentId };
}

async function seedFacility(unitId: string, by: string) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO facilities (id, unit_id, type, management_number, latitude, longitude, location_note, location_source, created_at, updated_at, created_by, actor_kind) " +
      "VALUES (?, ?, 'hydrant', ?, 35.0, 139.0, '架空市1丁目', '架空台帳', ?, ?, ?, 'human')",
  ).bind(id, unitId, `S2-${id.slice(0, 8)}`, now, now, by).run();
  return id;
}

/**
 * ACLで「管理者role＋指定団員」だけに見える文書を作り、原本（readyの添付）で版を作る。
 * 手順は tests/documents.test.ts の createDocument / uploadOriginal と同じ（API-73→API-26→API-74）
 */
async function restrictedDocumentWithOriginal(admin: Identity, allowedMember: Identity) {
  const res = await fx.client(admin).request("POST", "/api/v1/documents", {
    title: "非公開の訓練資料（架空版）", classification: "訓練資料（限定）",
    acl: [
      { roleId: ROLE_IDS.admin, permission: "PER-11", effect: "allow" },
      { memberId: allowedMember.memberId!, permission: "PER-11", effect: "allow" },
    ],
  }, idem());
  expect(res.status).toBe(201);
  const doc = (await json(res)).data! as { id: string; version: number };
  const originalId = await uploadTo(admin, { type: "document", id: doc.id });
  await runDueJobs(env);
  const ver = await fx.client(admin).request("POST", `/api/v1/documents/${doc.id}/versions`, {
    version: doc.version, attachmentId: originalId, licenseRef: "架空・自団体作成 (2026)",
  }, idem());
  expect(ver.status).toBe(202);
  return { documentId: doc.id, originalId };
}

const contentStatus = async (who: Identity, attachmentId: string) =>
  (await fx.client(who).request("GET", `/api/v1/attachments/${attachmentId}/content`)).status;

const activeLinks = async (attachmentId: string) =>
  (await fx.rows("attachment_links", { attachment_id: attachmentId })).filter((l) => l.unlinked_at === null);

describe("添付の再紐付けの制限 (T091-S2)", () => {
  it("document_original_cannot_be_relinked_to_an_issue_by_an_acl_member", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const member = a.people.member; // ACLで文書を許された団員（再公開を試みる側）
    const operator = a.people.operator; // ACLの外の担当者（原本が見えてはならない側）
    const { documentId, originalId } = await restrictedDocumentWithOriginal(admin, member);

    // 団員はAPI-91で文書を見られ、原本の添付IDを知る
    const detail = await fx.client(member).request("GET", `/api/v1/documents/${documentId}`);
    expect(detail.status).toBe(200);
    const original = ((await json(detail)).data! as { original: { attachmentId: string } | null }).original;
    expect(original?.attachmentId).toBe(originalId);
    expect(await contentStatus(operator, originalId)).toBe(404);

    // 原本IDを付けた課題起票（API-16。機微対象＝移動の経路）は403で、課題も作られない
    const facilityId = await seedFacility(a.id, admin.userId);
    const issuesBefore = (await env.DB.prepare("SELECT COUNT(*) AS n FROM issues").first<{ n: number }>())!.n;
    const relink = await fx.client(member).request("POST", "/api/v1/issues", {
      target: { type: "facility", id: facilityId }, title: "原本の再公開", description: "文書原本を課題へ付ける", attachmentIds: [originalId],
    }, idem());
    expect(relink.status).toBe(403);
    expect((await json(relink)).error?.code).toBe("FORBIDDEN");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM issues").first<{ n: number }>())!.n).toBe(issuesBefore);

    // ACLの外の担当者は今も取得できず、文書リンクは残ったまま（物理削除されていない）・分類も変わらない
    expect(await contentStatus(operator, originalId)).toBe(404);
    const links = await activeLinks(originalId);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ entity_type: "document", entity_id: documentId, unlinked_at: null });
    expect((await fx.rows("attachments", { id: originalId }))[0]!.classification).toBe("basic");
  });

  it("revoked_member_cannot_relink_document_original_to_activity_results", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const member = a.people.member;
    const operator = a.people.operator;
    const { documentId, originalId } = await restrictedDocumentWithOriginal(admin, member);
    expect(await contentStatus(member, originalId)).toBe(200); // 取消前は団員に見える

    // API-99で団員をdenyへ（取消）。団員は原本IDを手元に残している
    const docVersion = (await fx.rows("documents", { id: documentId }))[0]!.version as number;
    const revoke = await fx.client(admin).request("PATCH", `/api/v1/documents/${documentId}/access-policy`, {
      version: docVersion, classification: "訓練資料（限定）",
      acl: [
        { roleId: ROLE_IDS.admin, permission: "PER-11", effect: "allow" },
        { memberId: member.memberId!, permission: "PER-11", effect: "deny" },
      ],
    }, idem());
    expect(revoke.status).toBe(200);
    expect(await contentStatus(member, originalId)).toBe(404);

    // 団員が担当する活動（本人報告で実績を記録できる）へ、原本IDを付けて実績を作る（API-09）→ 403
    const actRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "団員担当の訓練", kind: "訓練", plannedStartsAt: "2026-11-10T01:00:00.000Z", locationText: "架空市第三堤防",
      ownerMemberId: member.memberId!, audienceMemberIds: [member.memberId!],
    }, idem());
    expect(actRes.status).toBe(201);
    const activityId = ((await json(actRes)).data! as { id: string }).id;
    const relink = await fx.client(member).request("POST", `/api/v1/activities/${activityId}/actual-results`, {
      activityVersion: 1, content: "訓練を実施", participants: [], attachmentIds: [originalId],
    }, idem());
    expect(relink.status).toBe(403);
    expect(await fx.rows("activity_results", { activity_id: activityId })).toHaveLength(0);

    // 取消後の団員もACLの外の担当者も取得できないまま。リンクは文書の1本だけ
    expect(await contentStatus(member, originalId)).toBe(404);
    expect(await contentStatus(operator, originalId)).toBe(404);
    const links = await activeLinks(originalId);
    expect(links.map((l) => l.entity_type)).toEqual(["document"]);
  });

  it("someone_elses_unlinked_upload_cannot_be_linked", async () => {
    const a = fx.units.a;
    const officer = a.people.officer;
    const member = a.people.member;
    // 幹部が予約経由で上げた未紐付けの添付（ready）
    const { attachmentId } = await draftWithReadyUpload(officer, "issue");
    expect(await activeLinks(attachmentId)).toHaveLength(0);

    const facilityId = await seedFacility(a.id, officer.userId);
    const relink = await fx.client(member).request("POST", "/api/v1/issues", {
      target: { type: "facility", id: facilityId }, title: "他人の写真", description: "他人の添付を付ける", attachmentIds: [attachmentId],
    }, idem());
    expect(relink.status).toBe(403);
    expect(await activeLinks(attachmentId)).toHaveLength(0);
  });

  it("draft_id_of_another_user_is_forbidden", async () => {
    const a = fx.units.a;
    const officer = a.people.officer;
    const admin = a.people.admin;
    // 幹部の予約（施設向け）を、管理者が施設作成（API-11）で消費しようとする → 403（予約は作った人だけが使える）
    const { draftId, attachmentId } = await draftWithReadyUpload(officer, "facility");
    const res = await fx.client(admin).request("POST", "/api/v1/facilities", {
      type: "hydrant", latitude: 35.01, longitude: 139.01, locationSource: "架空台帳", locationNote: "架空市2丁目",
      managementNumber: `S2-D-${draftId.slice(0, 6)}`, attachmentDraftId: draftId,
    }, idem());
    expect(res.status).toBe(403);
    expect((await fx.rows("attachment_drafts", { id: draftId }))[0]!.status).toBe("prepared");
    expect(await activeLinks(attachmentId)).toHaveLength(0);

    // 予約の作成者本人は同じ予約で施設を作れる（対照）
    const own = await fx.client(officer).request("POST", "/api/v1/facilities", {
      type: "hydrant", latitude: 35.02, longitude: 139.02, locationSource: "架空台帳", locationNote: "架空市3丁目",
      managementNumber: `S2-O-${draftId.slice(0, 6)}`, attachmentDraftId: draftId,
    }, idem());
    expect(own.status).toBe(201);
    expect(await activeLinks(attachmentId)).toHaveLength(1);
  });

  it("own_autolinked_photo_still_moves_and_only_its_autolink_is_removed", async () => {
    const a = fx.units.a;
    const officer = a.people.officer; // 施設へ直接上げられる（PER-04所属内）
    const admin = a.people.admin;
    const facilityId = await seedFacility(a.id, admin.userId);

    // 施設へ直接上げた写真は、検査jobで施設へ自動紐付けされる
    const photoId = await uploadTo(officer, { type: "facility", id: facilityId });
    await runDueJobs(env);
    const auto = await activeLinks(photoId);
    expect(auto).toHaveLength(1);
    expect(auto[0]).toMatchObject({ entity_type: "facility", entity_id: facilityId });

    // 他人（管理者）はこの写真を課題へ移せない（施設リンクは残る）
    const stolen = await fx.client(admin).request("POST", "/api/v1/issues", {
      target: { type: "facility", id: facilityId }, title: "他人の写真の移動", description: "他人の自動紐付け写真", attachmentIds: [photoId],
    }, idem());
    expect(stolen.status).toBe(403);
    expect((await activeLinks(photoId)).map((l) => l.entity_type)).toEqual(["facility"]);

    // 上げた本人は課題へ移せる。施設の自動紐付けだけが外れ、有効リンクは課題の1本になる
    const moved = await fx.client(officer).request("POST", "/api/v1/issues", {
      target: { type: "facility", id: facilityId }, title: "蓋の破損", description: "写真を添えて報告", attachmentIds: [photoId],
    }, idem());
    expect(moved.status).toBe(201);
    const issueId = ((await json(moved)).data! as { id: string }).id;
    const after = await activeLinks(photoId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ entity_type: "issue", entity_id: issueId, unlinked_at: null });
    expect((await fx.rows("attachment_links", { attachment_id: photoId, entity_type: "facility" })).filter((l) => l.unlinked_at === null)).toHaveLength(0);
    expect((await fx.rows("attachments", { id: photoId }))[0]!.classification).toBe("sensitive");

    // 一度課題へ移した写真を、本人でも別の課題へもう一度付けることはできない（使用済み）
    const reuse = await fx.client(officer).request("POST", "/api/v1/issues", {
      target: { type: "facility", id: facilityId }, title: "別の課題", description: "同じ写真の再利用", attachmentIds: [photoId],
    }, idem());
    expect(reuse.status).toBe(403);
    expect((await activeLinks(photoId)).map((l) => l.entity_id)).toEqual([issueId]);
  });
});
