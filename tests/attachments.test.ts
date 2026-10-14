import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import "../src/server/jobs/handlers/attachment"; // 検査jobの登録
import "../src/server/jobs/handlers/attachment-cleanup"; // 削除・回収jobの登録
import { runDueJobs } from "../src/server/jobs/runner";
import { planAttachmentLinks, type LinkPlan } from "../src/server/attachments/link";
import { executeMutation, type Principal } from "../src/server/mutations/execute";
import { canonicalRequestHash } from "../src/server/mutations/hash";
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
const json = async (r: Response) => (await r.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: { field: string; reason: string }[] } };
const pngBytes = () => {
  // 検査を通る最小のPNG（eXIf等なし）
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

/** 施設を1件直接作る（API-11はT019。リンク先の親として使う） */
async function seedFacility(unitId: string, number: string, by: string) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO facilities (id, unit_id, type, management_number, latitude, longitude, location_note, location_source, created_at, updated_at, created_by, actor_kind) " +
      "VALUES (?, ?, 'hydrant', ?, 35.0, 139.0, '架空市1丁目', '架空台帳', ?, ?, ?, 'human')",
  ).bind(id, unitId, number, now, now, by).run();
  return id;
}
const facilityVersionOf = async (facilityId: string) =>
  (await env.DB.prepare("SELECT version AS v FROM facilities WHERE id = ?").bind(facilityId).first<{ v: number }>())!.v;

/** 完了まで進めるが検査jobはまだ走らせない（uploadedの状態を作る）。runDueJobs後にreadyになる */
async function makeUploaded(who: Identity): Promise<{ id: string; draftId: string }> {
  const dRes = await fx.client(who).request("POST", "/api/v1/attachment-drafts", { intendedEntityType: "facility" }, idem());
  const draft = (await json(dRes)).data! as { id: string };
  const iRes = await fx.client(who).request(
    "POST", "/api/v1/attachments/upload-intents",
    { target: { type: "attachment_draft", id: draft.id }, contentType: "image/png", byteSize: 100 }, idem(),
  );
  const intent = (await json(iRes)).data! as { id: string; uploadToken: string };
  const bytes = pngBytes();
  const up = await fx.raw(who)(new Request(`http://example.com/api/v1/attachments/${intent.id}/upload`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "x-upload-token": intent.uploadToken },
    body: bytes as BufferSource,
  }));
  const attempt = (await json(up)).data! as { id: string; sha256: string };
  await fx.client(who).request("POST", `/api/v1/attachments/${intent.id}/completion`, { version: 1, uploadAttemptId: attempt.id, sha256: attempt.sha256 }, idem());
  return { id: intent.id, draftId: draft.id };
}

/** 既存の業務対象を直targetにしたintent（編集画面のuploaderと同じ経路）。転送と完了まで進める */
async function makeUploadedTo(who: Identity, target: { type: "facility"; id: string }): Promise<string> {
  const iRes = await fx.client(who).request(
    "POST", "/api/v1/attachments/upload-intents",
    { target, contentType: "image/png", byteSize: 100 }, idem(),
  );
  const intent = (await json(iRes)).data! as { id: string; uploadToken: string };
  const bytes = pngBytes();
  const up = await fx.raw(who)(new Request(`http://example.com/api/v1/attachments/${intent.id}/upload`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "x-upload-token": intent.uploadToken },
    body: bytes as BufferSource,
  }));
  const attempt = (await json(up)).data! as { id: string; sha256: string };
  await fx.client(who).request("POST", `/api/v1/attachments/${intent.id}/completion`, { version: 1, uploadAttemptId: attempt.id, sha256: attempt.sha256 }, idem());
  return intent.id;
}

/** 検査jobをもう一度走らせる（checkingへ戻して専用のdedupe keyで再登録。docs/07 §3.4の再入経路） */
async function rerunInspectJob(unitId: string, attachmentId: string) {
  const version = (await fx.rows("attachments", { id: attachmentId }))[0]!.version as number;
  await env.DB.prepare("UPDATE attachments SET status = 'checking' WHERE id = ?").bind(attachmentId).run();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO jobs (id, unit_id, kind, source_type, source_id, source_version, config_version, dedupe_key, status, attempts, max_attempts, next_attempt_at, created_at, updated_at) " +
      "VALUES (?, ?, 'attachment.inspect', 'attachment', ?, ?, 'v1', ?, 'queued', 0, 3, ?, ?, ?)",
  ).bind(crypto.randomUUID(), unitId, attachmentId, version, `${unitId}|attachment.inspect|rerun-${attachmentId}`, now, now, now).run();
  await runDueJobs(env);
}

describe("添付のリンク・取得・削除 (T017)", () => {
  it("unlink_and_permission_revocation_block_new_downloads", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const principal: Principal = { userId: admin.userId, memberId: admin.memberId!, unitId: a.id, authzVersion: 1 };

    // 検査を通る前の取得は200にならない（ready前取得不可）
    const first = await makeUploaded(admin);
    const earlyGet = await fx.client(admin).request("GET", `/api/v1/attachments/${first.id}/content`);
    expect(earlyGet.status).not.toBe(200);
    expect((await json(earlyGet)).error?.code).toBe("ATTACHMENT_NOT_READY");
    await runDueJobs(env);
    expect((await fx.rows("attachments", { id: first.id }))[0]!.status).toBe("ready");

    // 親（施設）へリンクして取得できる
    const facilityId = await seedFacility(a.id, "T017-1", admin.userId);
    const runLink = async (plan: LinkPlan, opCode: string) => {
      const v = await facilityVersionOf(facilityId);
      return executeMutation(env, principal, {
        operationCode: opCode,
        key: idem()["idempotency-key"],
        requestHash: await canonicalRequestHash({ method: "POST", path: `/test/${opCode}`, baseVersion: v }),
        expectedAuthzVersion: principal.authzVersion,
        roots: [...(plan.root ? [plan.root] : []), { table: "facilities", id: facilityId, expectedVersion: v }],
        conditions: plan.conditions,
        statements: (ctx) => [
          // リンクは業務の変更と同時に確定する（試験では施設の版を1つ進める）
          env.DB.prepare("UPDATE facilities SET version = version + 1, last_mutation_token = ?, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ?")
            .bind(ctx.attempt, ctx.now, facilityId, a.id, v),
          ...plan.statements(ctx),
        ],
        duplicateOn: plan.duplicateOn,
        audit: { action: "test.link", entityType: "facility", entityId: facilityId },
        event: { entityType: "facility", entityId: facilityId, entityVersion: v + 1, eventType: "test.linked" },
        response: { status: 200, sql: "SELECT json_object('id', id, 'version', version) FROM facilities WHERE id = ?", binds: [facilityId], decode: (j) => j as { id: string } },
      });
    };

    const plan = await planAttachmentLinks(env, a.id, admin.userId, { target: { type: "facility", id: facilityId }, attachmentIds: [first.id] });
    await runLink(plan, "test.link.existing");
    const ok = await fx.client(admin).request("GET", `/api/v1/attachments/${first.id}/content`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("cache-control")).toContain("no-store");
    expect(await sha256(new Uint8Array(await ok.arrayBuffer()))).toBe(await sha256(pngBytes()));

    // 予約（draft）の二重消費は不可。2回目は計画の時点で422（消費済み）
    const second = await makeUploaded(admin);
    // 未検査（ready前）の予約添付はリンクできない（1つでも未検査があれば422。検査は書込前の条件で確かめる）
    await expect(
      runLink(await planAttachmentLinks(env, a.id, admin.userId, { target: { type: "facility", id: facilityId }, draftId: second.draftId }), "test.link.unready"),
    ).rejects.toMatchObject({ code: "ATTACHMENT_NOT_READY" });
    await runDueJobs(env); // 検査を通ってreadyになってからリンクする
    await runLink(await planAttachmentLinks(env, a.id, admin.userId, { target: { type: "facility", id: facilityId }, draftId: second.draftId }), "test.link.draft");
    await expect(
      planAttachmentLinks(env, a.id, admin.userId, { target: { type: "facility", id: facilityId }, draftId: second.draftId }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    const draftRows = await fx.rows("attachment_drafts", { id: second.draftId });
    expect(draftRows[0]!.status).toBe("consumed");
    expect(draftRows[0]!.consumed_entity_id).toBe(facilityId);

    // 他unitの添付はリンクできない（存在を明かさない404）
    const b = fx.units.b;
    const otherAtt = await makeUploaded(b.people.admin);
    await runDueJobs(env);
    const planOther = await planAttachmentLinks(env, a.id, admin.userId, { target: { type: "facility", id: facilityId }, attachmentIds: [otherAtt.id] });
    await expect(runLink(planOther, "test.link.other")).rejects.toMatchObject({ code: "NOT_FOUND" });

    // リンク中の削除は422。unlink（API-101）してからなら削除できる
    const linkRow = (await fx.rows("attachment_links", { attachment_id: first.id }))[0]!;
    const currentVersion = (await fx.rows("attachments", { id: first.id }))[0]!.version as number;
    const del = await fx.client(admin).request("DELETE", `/api/v1/attachments/${first.id}`, { version: currentVersion, reason: "誤登録のため削除" }, idem());
    expect(del.status).toBe(422);
    expect((await fx.rows("attachments", { id: first.id }))[0]!.status).toBe("ready"); // 削除されていない
    const unlink = await fx.client(admin).request(
      "DELETE", `/api/v1/attachments/${first.id}/links/${linkRow.id}`,
      { version: linkRow.version as number, reason: "誤登録のため解除" }, idem(),
    );
    expect(unlink.status).toBe(204);
    // unlink済みのリンクに現行版で再unlinkすると422（0行UPDATEを500にしない）
    const unlinkedCurrentVersion = (await fx.rows("attachment_links", { id: linkRow.id as string }))[0]!.version as number;
    const reUnlink = await fx.client(admin).request(
      "DELETE", `/api/v1/attachments/${first.id}/links/${linkRow.id}`,
      { version: unlinkedCurrentVersion, reason: "もう一度解除" }, idem(),
    );
    expect(reUnlink.status).toBe(422);
    expect(((await json(reUnlink)).error?.code)).toBe("INVALID_TRANSITION");
    const unlinkedRow = (await fx.rows("attachment_links", { attachment_id: first.id }))[0]!;
    expect(unlinkedRow.unlink_reason).toBe("誤登録のため解除");
    expect(unlinkedRow.unlinked_at).not.toBeNull();
    // unlink後の取得は拒否される（署名GETへのredirectもしない）
    const after = await fx.client(admin).request("GET", `/api/v1/attachments/${first.id}/content`);
    expect(after.status).toBe(404);
    expect(after.headers.get("location")).toBeNull();

    // unlink後の削除: tombstone→遅延jobで実体削除→取得不可
    const readyKey = (await fx.rows("attachments", { id: first.id }))[0]!.ready_key as string;
    const attRow = (await fx.rows("attachments", { id: first.id }))[0]!;
    const del2 = await fx.client(admin).request("DELETE", `/api/v1/attachments/${first.id}`, { version: attRow.version as number, reason: "誤登録のため削除" }, idem());
    expect(del2.status).toBe(204);
    await runDueJobs(env);
    expect((await fx.rows("attachments", { id: first.id }))[0]!.status).toBe("deleted");
    expect((await fx.rows("attachments", { id: first.id }))[0]!.ready_key).toBeNull();
    expect(await env.FILES.head(readyKey)).toBeFalsy(); // R2の実体も消えている
    const afterDelete = await fx.client(admin).request("GET", `/api/v1/attachments/${first.id}/content`);
    expect(afterDelete.status).toBe(404);

    // 一般団員（PER-03を持たない）はunlinkできない
    const member = a.people.member;
    const link2 = (await fx.rows("attachment_links", { attachment_id: second.id }))[0]!;
    const unlinkByMember = await fx.client(member).request(
      "DELETE", `/api/v1/attachments/${second.id}/links/${link2.id}`,
      { version: 1, reason: "解除したい" }, idem(),
    );
    expect(unlinkByMember.status).toBe(403);

    // 分類の引下げ: sensitiveな添付は基本の対象へリンクできない（分類は自動で下げない）
    await env.DB.prepare("UPDATE attachments SET classification = 'sensitive' WHERE id = ?").bind(second.id).run();
    const planS = await planAttachmentLinks(env, a.id, admin.userId, { target: { type: "facility", id: facilityId }, attachmentIds: [second.id] });
    await expect(runLink(planS, "test.link.sensitive")).rejects.toMatchObject({ code: "ATTACHMENT_NOT_READY" });
  });

  it("ready_upload_to_an_existing_facility_autolinks_once", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const facilityId = await seedFacility(a.id, "T017-2", admin.userId);

    // (a) 既存施設を直targetにしたintent（編集画面のuploaderと同じ経路）は、検査jobのready確定と同じbatchで初回リンクが作られる
    const attId = await makeUploadedTo(admin, { type: "facility", id: facilityId });
    expect(await fx.rows("attachment_links", { attachment_id: attId })).toHaveLength(0); // ready前はリンク無し
    await runDueJobs(env);
    expect((await fx.rows("attachments", { id: attId }))[0]!.status).toBe("ready");
    const links = await fx.rows("attachment_links", { attachment_id: attId });
    expect(links).toHaveLength(1);
    expect(links[0]!.entity_type).toBe("facility");
    expect(links[0]!.entity_id).toBe(facilityId);
    expect(links[0]!.linked_by).toBe(admin.userId); // リンクしたのは添付の所有者
    expect(links[0]!.unlinked_at).toBeNull();

    // (b) 二重の検査jobでもリンクは1本（checkingへ戻して再確定させる）
    await rerunInspectJob(a.id, attId);
    expect((await fx.rows("attachments", { id: attId }))[0]!.status).toBe("ready");
    expect(await fx.rows("attachment_links", { attachment_id: attId })).toHaveLength(1);

    // (c) sensitiveに分類された添付は基本の対象（施設）へは自動リンクしない（docs/10。引下げもしない）
    const sensitiveId = await makeUploadedTo(admin, { type: "facility", id: facilityId });
    await env.DB.prepare("UPDATE attachments SET classification = 'sensitive' WHERE id = ?").bind(sensitiveId).run();
    await runDueJobs(env);
    expect((await fx.rows("attachments", { id: sensitiveId }))[0]!.status).toBe("ready");
    expect(await fx.rows("attachment_links", { attachment_id: sensitiveId })).toHaveLength(0);
  });

  it("inspection_targeted_intent_is_not_autolinked_by_the_job", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const facilityId = await seedFacility(a.id, "T017-3", admin.userId);
    // 点検の行を直接作る（リンク先の親。点検へのリンクは業務mutationだけが条件と監査を付けて行う）
    const inspectionId = crypto.randomUUID();
    const seriesId = crypto.randomUUID();
    const templateId = crypto.randomUUID();
    const templateVersionId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO inspection_templates (id, unit_id, name, target_type, status, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, ?, 'facility', 'draft', ?, ?, ?, 'human')",
    ).bind(templateId, a.id, "自動試験の様式", now, now, admin.userId).run();
    await env.DB.prepare(
      "INSERT INTO inspection_template_versions (id, unit_id, template_id, revision_no, item_schema, status, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, ?, 1, '[]', 'draft', ?, ?, ?, 'human')",
    ).bind(templateVersionId, a.id, templateId, now, now, admin.userId).run();
    await env.DB.prepare(
      "INSERT INTO inspection_series (id, unit_id, facility_id, current_facility_inspection_id, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, ?, ?, ?, ?, ?, 'human')",
    ).bind(seriesId, a.id, facilityId, inspectionId, now, now, admin.userId).run();
    await env.DB.prepare(
      "INSERT INTO facility_inspections (id, unit_id, series_id, facility_id, template_version_id, inspector_member_id, inspected_at, result, note, location_version, created_at, updated_at, created_by, actor_kind) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', '自動試験の点検', 1, ?, ?, ?, 'human')",
    ).bind(inspectionId, a.id, seriesId, facilityId, templateVersionId, admin.memberId!, "2026-10-14T02:00:00.000Z", now, now, admin.userId).run();

    // 点検を直targetにしたintent＋basic分類の添付は、検査jobでも自動リンクしない（リンクは業務mutationの経路だけ）
    const attId = (await makeUploaded(admin)).id; // draft経由で作った後、直intentの状態を模擬する
    await env.DB.prepare("UPDATE attachments SET intent_target_type = 'inspection', intent_target_id = ?, classification = 'basic' WHERE id = ?")
      .bind(inspectionId, attId).run();
    await runDueJobs(env);
    expect((await fx.rows("attachments", { id: attId }))[0]!.status).toBe("ready");
    expect(await fx.rows("attachment_links", { attachment_id: attId })).toHaveLength(0);
  });
});
