import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createFixture, type Identity, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const json = async (r: Response) => (await r.json()) as { data?: Record<string, unknown>[]; error?: { code: string }; meta?: { nextCursor?: string; snapshotRevision?: number } };

async function seedFacility(unitId: string, by: string, opts: Partial<{ type: string; number: string; lat: number; lng: number; status: string }> = {}) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO facilities (id, unit_id, type, management_number, latitude, longitude, location_note, location_source, verification_status, created_at, updated_at, created_by, actor_kind) " +
      "VALUES (?, ?, ?, ?, ?, ?, 'x', '架空台帳', ?, ?, ?, ?, 'human')",
  ).bind(id, unitId, opts.type ?? "hydrant", opts.number ?? `N-${id.slice(0, 8)}`, opts.lat ?? 35.0, opts.lng ?? 139.0, opts.status ?? "unverified", now, now, by).run();
  return id;
}

describe("施設の全件取得 (T020)", () => {
  it("query_returns_all_201_facilities_and_detects_snapshot_change", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;

    // 201件を投入（範囲内193件＋bboxの境界上4件＋日付変更線跨ぎ2件＋絞り込み用2件）
    for (let i = 0; i < 193; i++) {
      await seedFacility(a.id, admin.userId, { lat: 35.0 + (i % 50) * 0.001, lng: 139.0 + (i % 50) * 0.001, number: `BULK-${String(i).padStart(4, "0")}` });
    }
    // bboxの境界上（南西・北東の角と、南北の縁）は包含される
    const west = await seedFacility(a.id, admin.userId, { lat: 35.0, lng: 139.0, number: "EDGE-WEST-SOUTH" });
    const east = await seedFacility(a.id, admin.userId, { lat: 35.05, lng: 139.05, number: "EDGE-EAST-NORTH" });
    const north = await seedFacility(a.id, admin.userId, { lat: 35.05, lng: 139.02, number: "EDGE-NORTH" });
    const south = await seedFacility(a.id, admin.userId, { lat: 35.0, lng: 139.02, number: "EDGE-SOUTH" });
    // 日付変更線を跨ぐbbox（west=179.5, east=-179.5）
    const dateline1 = await seedFacility(a.id, admin.userId, { lat: 35.0, lng: 179.8, number: "DATELINE-W" });
    const dateline2 = await seedFacility(a.id, admin.userId, { lat: 35.0, lng: -179.8, number: "DATELINE-E" });
    // 絞り込み用
    const cistern = await seedFacility(a.id, admin.userId, { type: "cistern", number: "FILTER-TYPE", lat: 35.01, lng: 139.01 });
    const verified = await seedFacility(a.id, admin.userId, { number: "FILTER-VERIFIED", lat: 35.02, lng: 139.02, status: "verified" });

    const list = async (who: Identity, query: string) => fx.client(who).request("GET", `/api/v1/facilities${query}`);

    // bboxで全件をlimit50のcursor完走。重複・漏れなし
    const q = "bbox=139.0,35.0,139.05,35.05&limit=50";
    const firstRes = await list(admin, `?${q}`);
    expect(firstRes.status).toBe(200);
    const first = await json(firstRes);
    expect(first.meta?.snapshotRevision).toBeGreaterThan(0);
    const seen: string[] = [];
    for (const row of first.data ?? []) seen.push(row.id as string);
    let cursor = first.meta?.nextCursor;
    const snapshot = first.meta?.snapshotRevision;
    let pages = 1;
    while (cursor) {
      const next = await list(admin, `?${q}&cursor=${encodeURIComponent(cursor)}`);
      expect(next.status).toBe(200);
      const body = await json(next);
      expect(body.meta?.snapshotRevision).toBe(snapshot); // 同一snapshotで続きを取る
      for (const row of body.data ?? []) seen.push(row.id as string);
      cursor = body.meta?.nextCursor;
      pages++;
    }
    expect(new Set(seen).size).toBe(seen.length); // 重複なし
    const uniqueFacilityIds = [...new Set(seen)];
    const boundaryIds = [west, east, north, south];
    // bbox内 = 一括193件＋境界上4件＋絞り込み用2件（cistern/verifiedは同じ範囲内に置いた）
    expect(uniqueFacilityIds).toHaveLength(199);
    expect(boundaryIds.every((id) => seen.includes(id))).toBe(true);
    const expectedBoundaryIds = boundaryIds;
    expect(expectedBoundaryIds.filter((id) => seen.includes(id))).toHaveLength(4);
    expect(pages).toBe(4); // 199件 ÷ limit50 = 4ページ

    // 日付変更線跨ぎ（west>east）
    const dl = await json(await list(admin, "?bbox=179.5,34.0,-179.5,36.0"));
    const dlIds = (dl.data ?? []).map((r) => r.id as string);
    expect(dlIds.sort()).toEqual([dateline1, dateline2].sort());

    // 絞り込み（種別・番号・位置確認）は別条件で効く
    const byType = await json(await list(admin, "?type=cistern"));
    expect((byType.data ?? []).map((r) => r.id)).toEqual([cistern]);
    const byQ = await json(await list(admin, "?q=FILTER-VERIFIED"));
    expect((byQ.data ?? []).map((r) => r.id)).toEqual([verified]);
    const byVerified = await json(await list(admin, "?verificationStatus=verified"));
    expect((byVerified.data ?? []).map((r) => r.id)).toEqual([verified]);

    // 2ページ目を取る前に台帳が変わったら、続きの取得は409 SNAPSHOT_CHANGED（混在snapshotを返さない）
    const p1 = await json(await list(admin, `?${q}`));
    await env.DB.prepare("UPDATE units SET dataset_revision = dataset_revision + 1 WHERE id = ?").bind(a.id).run();
    const stalePageRes = await list(admin, `?${q}&cursor=${encodeURIComponent(p1.meta!.nextCursor!)}`);
    expect(stalePageRes.status).toBe(409);
    const stalePage = await json(stalePageRes);
    expect(stalePage.error?.code).toBe("SNAPSHOT_CHANGED");

    // 他unitの施設は出ない
    const bList = await json(await fx.client(fx.units.b.people.admin).request("GET", "/api/v1/facilities?type=cistern"));
    expect((bList.data ?? []).map((r) => r.id as string)).not.toContain(cistern);
  });

  it("filters_by_latest_inspection_result_and_open_issues", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;

    // 点検・異常を直に用意する（系列は対象ごとに一つ。docs/04「対象一つ」）
    const seedInspection = async (facilityId: string, result: string) => {
      const now = new Date().toISOString();
      const tplId = crypto.randomUUID();
      const verId = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO inspection_templates (id, unit_id, name, target_type, status, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, ?, 'facility', 'active', ?, ?, ?, 'human')",
      ).bind(tplId, a.id, `様式${tplId.slice(0, 6)}`, now, now, admin.userId).run();
      await env.DB.prepare(
        "INSERT INTO inspection_template_versions (id, unit_id, template_id, revision_no, item_schema, status, approved_by_member_id, approved_at, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, ?, 1, '[]', 'approved', ?, ?, ?, ?, ?, 'human')",
      ).bind(verId, a.id, tplId, admin.memberId!, now, now, now, admin.userId).run();
      const seriesId = crypto.randomUUID();
      const inspId = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO inspection_series (id, unit_id, facility_id, current_facility_inspection_id, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, ?, ?, ?, ?, ?, 'human')",
      ).bind(seriesId, a.id, facilityId, inspId, now, now, admin.userId).run();
      await env.DB.prepare(
        "INSERT INTO facility_inspections (id, unit_id, series_id, facility_id, template_version_id, inspector_member_id, inspected_at, result, note, location_version, created_at, updated_at, created_by, actor_kind) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, '絞り込み試験の点検', 1, ?, ?, ?, 'human')",
      ).bind(inspId, a.id, seriesId, facilityId, verId, admin.memberId!, "2026-10-01T00:00:00.000Z", result, now, now, admin.userId).run();
      return inspId;
    };
    const seedIssue = async (facilityId: string, status: string) => {
      const now = new Date().toISOString();
      const issueId = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO issues (id, unit_id, facility_id, title, description, reported_by, status, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, ?, '絞り込み試験の異常', '開閉の不具合', ?, ?, ?, ?, ?, 'human')",
      ).bind(issueId, a.id, facilityId, admin.userId, status, now, now, admin.userId).run();
      return issueId;
    };

    const okFacility = await seedFacility(a.id, admin.userId, { number: "FILTER-INS-OK", lat: 35.03, lng: 139.03 });
    const reviewFacility = await seedFacility(a.id, admin.userId, { number: "FILTER-INS-REVIEW", lat: 35.04, lng: 139.04 });
    const openIssueFacility = await seedFacility(a.id, admin.userId, { number: "FILTER-ISSUE-OPEN", lat: 35.05, lng: 139.05 });
    const closedIssueFacility = await seedFacility(a.id, admin.userId, { number: "FILTER-ISSUE-CLOSED", lat: 35.06, lng: 139.06 });
    await seedInspection(okFacility, "ok");
    await seedInspection(reviewFacility, "needs_review");
    await seedIssue(openIssueFacility, "reported");
    await seedIssue(closedIssueFacility, "closed");

    const idsOf = async (query: string) => (await json(await fx.client(admin).request("GET", `/api/v1/facilities${query}`))).data?.map((r) => r.id as string) ?? [];

    // 点検結果のフィルタ: 最新有効（現在版）の点検の結果で絞る（T029/T032とのJOIN接続）
    expect(await idsOf("?inspectionResult=ok")).toEqual([okFacility]);
    expect(await idsOf("?inspectionResult=needs_review")).toEqual([reviewFacility]);
    // 点検が無い施設はどんな結果でも出ない
    const noInspection = await seedFacility(a.id, admin.userId, { number: "FILTER-INS-NONE", lat: 35.07, lng: 139.07 });
    expect(await idsOf("?inspectionResult=unknown")).toEqual([]);

    // 開いている異常のフィルタ: closedは含まれない
    expect(await idsOf("?hasOpenIssue=true")).toEqual([openIssueFacility]);
    // 異常が閉じたら同じ施設は出なくなる（状態は毎要求で引き直す）
    await env.DB.prepare("UPDATE issues SET status = 'closed' WHERE facility_id = ?").bind(openIssueFacility).run();
    expect(await idsOf("?hasOpenIssue=true")).toEqual([]);
    void noInspection;
  });
});
