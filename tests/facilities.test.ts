import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
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
});
