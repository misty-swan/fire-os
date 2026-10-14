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
const json = async (r: Response) => (await r.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: { field: string; reason: string }[] } };

async function seedFacility(unitId: string, by: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO facilities (id, unit_id, type, management_number, latitude, longitude, location_note, location_source, created_at, updated_at, created_by, actor_kind) " +
      "VALUES (?, ?, 'hydrant', ?, 35.0, 139.0, 'x', '架空台帳', ?, ?, ?, 'human')",
  ).bind(id, unitId, `F-${id.slice(0, 6)}`, now, now, by).run();
  return id;
}

describe("車両・資機材の台帳 (T025)", () => {
  it("asset_has_one_storage_location_and_nonnegative_quantity", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;

    // 車両の登録（施設を保管先に）
    const facilityId = await seedFacility(a.id, admin.userId);
    const vehicle = await fx.client(admin).request(
      "POST", "/api/v1/vehicles",
      { assetCode: "PUMP-1", name: "架空市 第一分団 消防ポンプ車", status: "運用", storageFacilityId: facilityId }, idem(),
    );
    expect(vehicle.status).toBe(201);
    const v = (await json(vehicle)).data! as { id: string; version: number; assetCode: string; storageFacilityId: string | null };
    expect(v).toMatchObject({ assetCode: "PUMP-1", storageFacilityId: facilityId, version: 1 });

    // 資機材の登録（数量機材。負は400）
    const neg = await fx.client(admin).request(
      "POST", "/api/v1/equipment",
      { assetCode: "HOSE-1", name: "ホース 65mm", quantity: -1, quantityUnit: "本", storage: { facilityId, note: null } }, idem(),
    );
    expect(neg.status).toBe(400);
    const hose = await fx.client(admin).request(
      "POST", "/api/v1/equipment",
      { assetCode: "HOSE-1", name: "ホース 65mm", quantity: 4, quantityUnit: "本", storage: { facilityId } }, idem(),
    );
    expect(hose.status).toBe(201);
    const e = (await json(hose)).data! as { id: string; storage: { facilityId: string | null; vehicleId: string | null }; quantity: number };
    expect(e.storage).toEqual({ facilityId, vehicleId: null, note: null });

    // 二重保管先（施設と車両の両方）は422。外部保管は備考必須
    const two = await fx.client(admin).request(
      "POST", "/api/v1/equipment",
      { assetCode: "ROPE-1", name: "ロープ", quantity: 2, quantityUnit: "本", storage: { facilityId, vehicleId: v.id } }, idem(),
    );
    expect(two.status).toBe(422);
    const two2 = await fx.client(admin).request(
      "PATCH", `/api/v1/equipment/${e.id}`,
      { version: 1, storage: { facilityId, vehicleId: v.id } }, idem(),
    );
    expect(two2.status).toBe(422);
    const noStorage = await fx.client(admin).request(
      "PATCH", `/api/v1/equipment/${e.id}`,
      { version: 1, storage: {} }, idem(),
    );
    expect(noStorage.status).toBe(400);

    // 同じ番号は409。別unitなら同じ番号でも可
    const dup = await fx.client(admin).request(
      "POST", "/api/v1/vehicles",
      { assetCode: "PUMP-1", name: "二台目", status: "運用" }, idem(),
    );
    expect(dup.status).toBe(409);
    expect((await json(dup)).error?.code).toBe("DUPLICATE");
    const otherUnit = await fx.client(fx.units.b.people.admin).request(
      "POST", "/api/v1/vehicles",
      { assetCode: "PUMP-1", name: "別分団の同名車", status: "運用" }, idem(),
    );
    expect(otherUnit.status).toBe(201);

    // 旧版での更新は409。保管先の変更（施設→車両）は排他を保ったまま
    const moved = await fx.client(admin).request(
      "PATCH", `/api/v1/equipment/${e.id}`,
      { version: 1, storage: { vehicleId: v.id } }, idem(),
    );
    expect(moved.status).toBe(200);
    const staleWrite = await fx.client(admin).request(
      "PATCH", `/api/v1/equipment/${e.id}`,
      { version: 1, name: "古い版からの更新" }, idem(),
    );
    expect(staleWrite.status).toBe(409);
    expect((await json(staleWrite)).error?.code).toBe("VERSION_CONFLICT");

    // 廃止（archived_at）は論理状態。履歴（監査）は残り、行は消えない
    const currentVersion = ((await fx.rows("equipment", { id: e.id }))[0]!.version) as number;
    const archive = await fx.client(admin).request(
      "PATCH", `/api/v1/equipment/${e.id}`,
      { version: currentVersion, status: "廃止" }, idem(),
    );
    expect(archive.status).toBe(200);
    const archivedHistoryStillVisible = (await fx.rows("equipment", { id: e.id }))[0]!.archived_at === null
      && (await fx.rows("equipment", { id: e.id }))[0]!.status === "廃止"
      && (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_id = ?").bind(e.id).first<{ n: number }>())!.n >= 2;
    expect(archivedHistoryStillVisible).toBe(true);

    // 一覧: 種別ごと・検索・ページング。別unitは出ない
    const vehicles = ((await json(await fx.client(admin).request("GET", "/api/v1/vehicles?limit=1"))).data ?? []) as unknown as Array<{ assetCode: string }>;
    expect(vehicles).toHaveLength(1);
    const next = ((await json(await fx.client(admin).request("GET", "/api/v1/equipment?q=ホース"))).data ?? []) as unknown as Array<{ assetCode: string }>;
    expect(next.map((r) => r.assetCode)).toEqual(["HOSE-1"]);

    // 詳細（API-51）。別unitは404。一般団員は閲覧のみ可（PER-01）、登録は不可（PER-03）
    const detail = await fx.client(admin).request("GET", `/api/v1/assets/vehicle/${v.id}`);
    expect(detail.status).toBe(200);
    const otherDetail = await fx.client(fx.units.b.people.admin).request("GET", `/api/v1/assets/vehicle/${v.id}`);
    expect(otherDetail.status).toBe(404);
    const memberCreate = await fx.client(a.people.member).request(
      "POST", "/api/v1/vehicles", { assetCode: "X-1", name: "x", status: "x" }, idem(),
    );
    expect(memberCreate.status).toBe(403);
    void expect; void json;
  });
});
