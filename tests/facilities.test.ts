import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import "../src/server/jobs/handlers/attachment"; // 検査jobの登録（ready添付を作るため）
import { runDueJobs } from "../src/server/jobs/runner";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const NOW = "2026-10-13T00:00:00.000Z";

interface FacilityDto {
  id: string; version: number; type: string; managementNumber: string | null; identifyingName: string | null;
  latitude: number; longitude: number; locationSource: string; locationNote: string;
  locationVersion: number; verificationStatus: string; lastVerifiedAt: string | null; archivedAt: string | null;
  metadata: Record<string, unknown>;
}
interface FacErr { code: string; details?: { field: string; reason: string }[] }
const json = async (r: Response): Promise<{ data?: unknown; error?: FacErr; meta?: { nextCursor?: string } }> => (await r.json()) as never;

async function create(who: Identity, body: Record<string, unknown>) {
  const r = await fx.client(who).request("POST", "/api/v1/facilities", body, idem());
  return { status: r.status, body: await json(r) };
}
const get = (who: Identity, id: string) => fx.client(who).request("GET", `/api/v1/facilities/${id}`);
const patch = (who: Identity, id: string, body: Record<string, unknown>) => fx.client(who).request("PATCH", `/api/v1/facilities/${id}`, body, idem());
const review = (who: Identity, id: string, body: Record<string, unknown>) => fx.client(who).request("POST", `/api/v1/facilities/${id}/location-reviews`, body, idem());
const ver = async (id: string) => (await fx.rows("facilities", { id }))[0]!.version as number;

/** 検査を通る最小のPNG（eXIf等なし。内容の検査そのものはT016） */
const pngBytes = () => {
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

/** 添付を予約→転送→完了まで進める。runDueJobs後にreadyになる（予約は消費しない個別リンクの試験に使う） */
async function makeUploaded(who: Identity): Promise<string> {
  const dRes = await fx.client(who).request("POST", "/api/v1/attachment-drafts", { intendedEntityType: "facility" }, idem());
  const draft = (await json(dRes)).data! as { id: string };
  const bytes = pngBytes();
  const iRes = await fx.client(who).request(
    "POST", "/api/v1/attachments/upload-intents",
    { target: { type: "attachment_draft", id: draft.id }, contentType: "image/png", byteSize: bytes.byteLength }, idem(),
  );
  const intent = (await json(iRes)).data! as { id: string; uploadToken: string };
  const up = await fx.raw(who)(new Request(`http://example.com/api/v1/attachments/${intent.id}/upload`, {
    method: "PUT", headers: { "content-type": "application/octet-stream", "x-upload-token": intent.uploadToken }, body: bytes as BufferSource,
  }));
  const attempt = (await json(up)).data! as { id: string; sha256: string };
  await fx.client(who).request("POST", `/api/v1/attachments/${intent.id}/completion`, { version: 1, uploadAttemptId: attempt.id, sha256: attempt.sha256 }, idem());
  return intent.id;
}

describe("施設の台帳と位置確認 (T019)", () => {
  it("coordinate_edit_invalidates_only_location_confirmation", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;

    // 登録（座標・出典・番号）。作成時は未確認・位置版1
    const made = await create(admin, {
      type: "hydrant", latitude: 35.0001, longitude: 139.0001,
      locationSource: "架空市台帳", locationNote: "1丁目交差点北西",
      managementNumber: "A-0001",
    });
    expect(made.status).toBe(201);
    const f = made.body.data as FacilityDto;
    expect(f).toMatchObject({ type: "hydrant", managementNumber: "A-0001", locationVersion: 1, verificationStatus: "unverified", lastVerifiedAt: null, version: 1 });

    // 確認の流れ: request(pending) → verify(verified)
    const v1 = await review(admin, f.id, { version: 1, locationVersion: 1, decision: "request", reason: "現地確認をお願いします" });
    expect(v1.status).toBe(200);
    expect(((await json(await get(admin, f.id))).data as FacilityDto).verificationStatus).toBe("pending");
    const ok1 = await review(admin, f.id, { version: 2, locationVersion: 1, decision: "verify", reason: "現地で確認した" });
    expect(ok1.status).toBe(200);
    const verified = (await json(await get(admin, f.id))).data as FacilityDto;
    expect(verified.verificationStatus).toBe("verified");
    expect(verified.lastVerifiedAt).not.toBeNull();
    expect(verified.version).toBe(3);

    // 座標を変えると、位置確認だけが失効する（他の項目は無関係）
    const beforeEdit = verified;
    const edit = await patch(admin, f.id, {
      version: beforeEdit.version, latitude: 35.0009, longitude: 139.0009, locationSource: "現地測量", locationNote: "表示位置を修正",
    });
    expect(edit.status).toBe(200);
    const afterEdit = (await json(await get(admin, f.id))).data as FacilityDto;
    expect(afterEdit.verificationStatus).toBe("unverified");
    expect(afterEdit.locationVersion).toBe(beforeEdit.locationVersion + 1);
    expect(afterEdit.lastVerifiedAt).toBeNull();

    // 古いlocationVersionでの再確認は409（座標版が一致しない）
    const staleReviewRes = await review(admin, f.id, {
      version: afterEdit.version, locationVersion: beforeEdit.locationVersion, decision: "verify", reason: "古い版での確認",
    });
    expect(staleReviewRes.status).toBe(409);
    const staleReview = await json(staleReviewRes);
    expect(staleReview.error?.code).toBe("VERSION_CONFLICT");
    void staleReview;

    // 同じ座標版での確認はevent_noを増分して履歴に残る（失効後の再確認）
    const reverify = await review(admin, f.id, { version: afterEdit.version, locationVersion: afterEdit.locationVersion, decision: "verify", reason: "移動後の再確認" });
    expect(reverify.status).toBe(200);
    const history = (await json(await get(admin, f.id))).data as { locationHistory: unknown[] };
    void history;
    const revisions = await fx.rows("facility_location_revisions", { facility_id: f.id });
    // 作成(v1e1) → request(v1e2) → verify(v1e3) → 編集で新版(v2e1) → 再確認(v2e2)
    expect(revisions).toHaveLength(5);
    const locationHistoryCount = revisions.length;
    expect(locationHistoryCount).toBe(5);
    expect(revisions.filter((r) => r.location_version === 1).map((r) => r.event_no).sort()).toEqual([1, 2, 3]);
    expect(revisions.filter((r) => r.location_version === 2).map((r) => r.event_no).sort()).toEqual([1, 2]);

    // 入力の検証: 緯度91・有限でない値・番号も識別名も無し・同じ番号の重複
    const lat91 = await create(admin, { type: "hydrant", latitude: 91, longitude: 139, locationSource: "x", locationNote: "x", managementNumber: "A-9999" });
    expect(lat91.status).toBe(400);
    const nanLat = await create(admin, { type: "hydrant", latitude: "NaN", longitude: 139, locationSource: "x", locationNote: "x", managementNumber: "A-9998" });
    expect(nanLat.status).toBe(400);
    // DBのCHECK（facilities.location_source ≤100）を超える長さは契約で400（通ってから500にならない）
    const longSource = await create(admin, {
      type: "hydrant", latitude: 35, longitude: 139, locationSource: "超".repeat(101), locationNote: "x", managementNumber: "A-9997",
    });
    expect(longSource.status).toBe(400);
    // DBのCHECK（facilities.location_note 1..1000）に合わせ、空文字も契約で400（通ってから500にならない）
    const emptyNote = await create(admin, { type: "hydrant", latitude: 35, longitude: 139, locationSource: "x", locationNote: "", managementNumber: "A-9996" });
    expect(emptyNote.status).toBe(400);
    const noName = await create(admin, { type: "hydrant", latitude: 1, longitude: 1, locationSource: "x", locationNote: "x" });
    expect(noName.status).toBe(400);
    // 同じ番号の重複（作成と変更の両方で409 DUPLICATE。API-13にもduplicateOn宣言が必要）
    const dup = await create(admin, {
      type: "hydrant", latitude: 35.0002, longitude: 139.0002, locationSource: "x", locationNote: "x", managementNumber: "A-0001",
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.code).toBe("DUPLICATE");
    // 既存と同じ番号への変更も409（UNIQUE違反を500にしない）
    const rename = await patch(admin, f.id, { version: (await ver(f.id)), managementNumber: "A-0002" });
    expect(rename.status).toBe(200);
    const other = await create(admin, {
      type: "hydrant", latitude: 35.0005, longitude: 139.0005, locationSource: "x", locationNote: "x", managementNumber: "A-0003",
    });
    expect(other.status).toBe(201);
    const dupPatch = await patch(admin, (other.body.data as FacilityDto).id, { version: 1, managementNumber: "A-0002" });
    expect(dupPatch.status).toBe(409);
    expect((await json(dupPatch)).error?.code).toBe("DUPLICATE");
    // 種別が違えば同じ番号でも可（D19案: unit×type×番号の一意）
    const dupOtherType = await create(admin, {
      type: "cistern", latitude: 35.0003, longitude: 139.0003, locationSource: "x", locationNote: "x", managementNumber: "A-0001",
    });
    expect(dupOtherType.status).toBe(201);
    // 識別名だけでも可
    const byName = await create(admin, {
      type: "box", latitude: 35.0004, longitude: 139.0004, locationSource: "x", locationNote: "x", identifyingName: "架空商店街の格納箱",
    });
    expect(byName.status).toBe(201);

    // 権限: 一般団員は作れない（PER-03）。別unitの詳細は404
    const byMember = await create(a.people.member, {
      type: "hydrant", latitude: 1, longitude: 1, locationSource: "x", locationNote: "x", identifyingName: "x",
    });
    expect(byMember.status).toBe(403);
    const otherUnit = await get(fx.units.b.people.admin, f.id);
    expect(otherUnit.status).toBe(404);

    // 台帳の変更はdataset_revisionを進める（全件取得のsnapshot検知はT020）
    const rev1 = (await fx.rows("units", { id: a.id }))[0]!.dataset_revision as number;
    await patch(admin, f.id, { version: (await ver(f.id)), locationNote: "表示位置を再修正" });
    const rev2 = (await fx.rows("units", { id: a.id }))[0]!.dataset_revision as number;
    expect(rev2).toBeGreaterThan(rev1);

    // 監査とoutboxが残る
    const audits = await fx.rows("audit_logs", { entity_id: f.id });
    expect(audits.length).toBeGreaterThanOrEqual(3);
    void NOW;
  });

  it("create_links_ready_attachmentIds_and_patch_rejects_attachment_fields", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;

    // ready添付（予約経由で作り検査jobでreadyへ。attachmentIdsの個別リンクは予約を消費しない）
    const readyId = await makeUploaded(admin);
    await runDueJobs(env);
    expect((await fx.rows("attachments", { id: readyId }))[0]!.status).toBe("ready");
    expect(await fx.rows("attachment_links", { attachment_id: readyId })).toHaveLength(0);

    // 施設の作成と同じ確定でready添付をリンクする（docs/05 API-11 attachmentIds。draftIdと併用も可）
    const made = await create(admin, {
      type: "hydrant", latitude: 35.001, longitude: 139.001,
      locationSource: "架空市台帳", locationNote: "写真つきで登録",
      managementNumber: "A-1001", attachmentIds: [readyId],
    });
    expect(made.status).toBe(201);
    const facilityId = (made.body.data as { id: string }).id;
    const links = await fx.rows("attachment_links", { attachment_id: readyId });
    expect(links).toHaveLength(1);
    expect(links[0]!.entity_type).toBe("facility");
    expect(links[0]!.entity_id).toBe(facilityId);
    expect(links[0]!.unlinked_at).toBeNull();

    // 未検査（ready前）の添付は422で、施設も作られない（docs/07 §3.5「添付は業務と同時に確定」）
    const uninspectedId = await makeUploaded(admin);
    const failed = await create(admin, {
      type: "hydrant", latitude: 35.002, longitude: 139.002,
      locationSource: "x", locationNote: "x", managementNumber: "A-1002", attachmentIds: [uninspectedId],
    });
    expect(failed.status).toBe(422);
    expect(failed.body.error?.code).toBe("ATTACHMENT_NOT_READY");
    expect(await fx.rows("facilities", { management_number: "A-1002" })).toHaveLength(0);

    // 変更（API-13）はattachment列を受け付けない（編集画面のuploaderは検査完了時に直リンク。未処理列は未知列の400）
    const patchRes = await patch(admin, facilityId, { version: await ver(facilityId), locationNote: "表示位置を修正", attachmentIds: [readyId] });
    expect(patchRes.status).toBe(400);
    expect((await json(patchRes)).error?.code).toBe("VALIDATION_ERROR");
    const patchDraft = await patch(admin, facilityId, { version: await ver(facilityId), locationNote: "表示位置を修正", attachmentDraftId: crypto.randomUUID() });
    expect(patchDraft.status).toBe(400);
    expect((await json(patchDraft)).error?.code).toBe("VALIDATION_ERROR");
  });
  // --- T085の網羅で見つけた欠落（施設の再送・2端末更新。AT-MAP-03のCT-03/CT-04、TC-15/16） ---
  it("same_key_resend_has_one_effect_and_two_devices_never_silently_overwrite (T085)", async () => {
    const admin = fx.units.a.people.admin;
    const officer = fx.units.a.people.officer;
    const body = {
      type: "cistern", latitude: 35.0101, longitude: 139.0101,
      locationSource: "架空市台帳", locationNote: "公民館の裏", managementNumber: `T85-${crypto.randomUUID().slice(0, 6)}`,
    };
    const key = { "idempotency-key": crypto.randomUUID() };
    const r1 = await fx.client(admin).request("POST", "/api/v1/facilities", body, key);
    const r2 = await fx.client(admin).request("POST", "/api/v1/facilities", body, key);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    const f = (await json(r1)).data as FacilityDto;
    expect(((await json(r2)).data as FacilityDto).id).toBe(f.id);
    expect(await fx.rows("facilities", { management_number: body.managementNumber })).toHaveLength(1);
    // 同じ鍵で別の本文は409（IDEMPOTENCY_MISMATCH。2件目を作らない）
    const mismatch = await fx.client(admin).request("POST", "/api/v1/facilities", { ...body, locationNote: "別の本文" }, key);
    expect(mismatch.status).toBe(409);

    // 2端末（管理者と幹部）が同じ版を見て更新: 先の1件だけ成功し、後は409。後勝ちで黙って上書きしない
    const v = f.version;
    const deviceA = await fx.client(admin).request("PATCH", `/api/v1/facilities/${f.id}`, { version: v, locationNote: "端末Aの修正" }, idem());
    const deviceB = await fx.client(officer).request("PATCH", `/api/v1/facilities/${f.id}`, { version: v, locationNote: "端末Bの修正" }, idem());
    expect([deviceA.status, deviceB.status]).toEqual([200, 409]);
    expect((await json(deviceB)).error?.code).toBe("VERSION_CONFLICT");
    const row = (await fx.rows("facilities", { id: f.id }))[0]!;
    expect(row.location_note).toBe("端末Aの修正");
    expect(row.version).toBe(v + 1);
    // 競合した側の監査は残らない（成功した更新だけが記録される）
    const updates = (await fx.rows("audit_logs", { entity_id: f.id })).filter((x) => String(x.action).includes("update"));
    expect(updates).toHaveLength(1);
    // 成功した更新の同じ鍵の再送は同じ応答で、版を進めない
    const patchKey = { "idempotency-key": crypto.randomUUID() };
    const p1 = await fx.client(admin).request("PATCH", `/api/v1/facilities/${f.id}`, { version: v + 1, locationNote: "再送の確認" }, patchKey);
    const p2 = await fx.client(admin).request("PATCH", `/api/v1/facilities/${f.id}`, { version: v + 1, locationNote: "再送の確認" }, patchKey);
    expect([p1.status, p2.status]).toEqual([200, 200]);
    expect((await fx.rows("facilities", { id: f.id }))[0]!.version).toBe(v + 2);
  });
});
