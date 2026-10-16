import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { PatrolPlan } from "../src/shared/contracts/ai";
import { createFixture, type TestFixture, type UnitFixture } from "./helpers/fixture";

/**
 * 地域の点検巡回計画（T071、docs/05 API-78/79、docs/04:157、docs/03 SCR-25、docs/10 PER-14、docs/14 D01）。
 *
 * - 計画は人の作成（API-78）で案（draft）として始まり、**人が確定（API-79 decision=confirm）するまでdraftのまま**。
 *   確定・取消（cancelled）は終端で、変更は新しい案として作り直す（docs/11「confirmedの変更は新revision」＝
 *   確認済み計画の行を書換えない解釈。docs/16 T071に記録）。
 * - 確定は人の操作だけ。**確定しても出動・タスク・通知・点検を1件も自動作成しない（autoDispatchCount=0）**
 *   ＝「計画確定を実災害の指令/設備安全判断にしない」のサーバー側の保証。
 * - 順序は案作成時にサーバーが施設座標から最近傍順（nearest-neighbor）を提案し、確定時に人が送った
 *   orderedFacilityIds（対象施設と完全一致・重複なし）で確定する。外部の経路最適化（Google Routes等）は使わない（docs/14 D01）。
 * - 旧版（version不一致）での確定は409。確定済み/取消済みへの再操作は422（現行版でも）。対象外施設
 *   （別分団・不在）の作成は404（存在を明かさない）、決定時の集合不一致・重複（二重順序）は400。
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

/** 架空の施設（巡回の候補。座標は有限値。番号は試験ごとに一意） */
async function mkFacility(unit: UnitFixture, number: string, lat: number, lng: number): Promise<string> {
  const res = await fx.client(unit.people.admin).request("POST", "/api/v1/facilities", {
    type: "hydrant", managementNumber: number, latitude: lat, longitude: lng,
    locationSource: "架空市台帳", locationNote: `巡回計画の試験用施設 ${number}`,
  }, idem());
  expect(res.status).toBe(201);
  return ((await json(res)).data! as { id: string }).id;
}

/** 案の作成（API-78） */
const createPlan = (admin: TestFixture["units"]["a"]["people"]["admin"], facilityIds: string[], objective: string, date = "2026-10-17") =>
  fx.client(admin).request("POST", "/api/v1/patrol-plans", { facilityIds, date, objective }, idem());

/** 決定（API-79） */
const decide = (
  admin: TestFixture["units"]["a"]["people"]["admin"],
  planId: string,
  body: { version: number; orderedFacilityIds: string[]; decision: "confirm" | "cancel"; reason: string },
) => fx.client(admin).request("POST", `/api/v1/patrol-plans/${planId}/decision`, body, idem());

/** 自動派生の数（確定が出動・タスク・通知・点検を作らないことの基準。試験側で独立に数える） */
async function effectCounts() {
  const one = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
  return {
    tasks: await one("tasks"),
    incidents: await one("incidents"),
    notifications: await one("notifications"),
    inspections: (await one("facility_inspections")) + (await one("asset_inspections")),
  };
}

describe("巡回計画の案・順序編集・人の確定 (T071)", () => {
  it("patrol_plan_stays_a_draft_until_human_confirms", async () => {
    const a = fx.units.a;
    const b = fx.units.b;
    const admin = a.people.admin;

    // --- seed: 架空の施設3件（南北の直線上に約220m間隔で並べ、最近傍順を決定的にする）＋別分団の施設 ---
    const fNorth = await mkFacility(a, "PAT-T71-N", 35.0, 139.0);
    const fMid = await mkFacility(a, "PAT-T71-M", 34.998, 139.0);
    const fSouth = await mkFacility(a, "PAT-T71-S", 34.996, 139.0);
    const otherUnitFacility = await mkFacility(b, "PAT-T71-X", 35.1, 139.1);

    // 効果の起点（確定の前後で増分0を断言するため作成前に数える）
    const before = await effectCounts();

    // --- 1) 案の作成（API-78。201。statusはdraft。順序は最近傍順の提案） ---
    const createRes = await createPlan(admin, [fNorth, fMid, fSouth], "水利の巡回（試験用の架空計画）");
    expect(createRes.status).toBe(201);
    const initialPlan = PatrolPlan.parse((await json(createRes)).data);
    expect(initialPlan.status).toBe("draft");
    expect(initialPlan.date).toBe("2026-10-17");
    expect(initialPlan.objective).toBe("水利の巡回（試験用の架空計画）");
    expect(initialPlan.decidedAt).toBeNull();
    // 候補順の提案: 南端（最も緯度が小さい施設）を起点に北へ。S→M→N（T071の決定的ルール）
    expect(initialPlan.stops.map((s) => s.facilityId)).toEqual([fSouth, fMid, fNorth]);
    expect(initialPlan.stops.map((s) => s.position)).toEqual([1, 2, 3]);

    // --- 2) 順序変更＋確定（API-79。人が並べ替えた順序をそのまま送る） ---
    const humanSelectedOrder = [fNorth, fSouth, fMid];
    const confirmRes = await decide(admin, initialPlan.id, {
      version: initialPlan.version, orderedFacilityIds: humanSelectedOrder, decision: "confirm",
      reason: "巡回順を道路に沿って決めた（試験用の架空理由）",
    });
    expect(confirmRes.status).toBe(200);
    const confirmed = PatrolPlan.parse((await json(confirmRes)).data);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.decidedAt).not.toBeNull();
    const confirmedOrder = [...confirmed.stops].sort((x, y) => x.position - y.position).map((s) => s.facilityId);
    expect(confirmedOrder).toEqual(humanSelectedOrder);
    expect(confirmed.stops.map((s) => s.position)).toEqual([1, 2, 3]);

    // --- 3) 自動派生0（確定しても出動・タスク・通知・点検を1件も作らない） ---
    const after = await effectCounts();
    const autoDispatchCount =
      (after.tasks - before.tasks) +
      (after.incidents - before.incidents) +
      (after.notifications - before.notifications) +
      (after.inspections - before.inspections);
    expect(autoDispatchCount).toBe(0);

    // --- 4) 旧版での確定は409（stale。版が進んだ後の旧版を送る） ---
    const staleConfirm = await decide(admin, initialPlan.id, {
      version: 1, orderedFacilityIds: humanSelectedOrder, decision: "confirm", reason: "古い版での確定（試験用）",
    });
    expect(staleConfirm.status).toBe(409);

    // --- 5) 確定済みへの再確定は422（現行版でも。confirmedは終端） ---
    const reConfirm = await decide(admin, initialPlan.id, {
      version: confirmed.version, orderedFacilityIds: humanSelectedOrder, decision: "confirm", reason: "終端への再確定（試験用）",
    });
    expect(reConfirm.status).toBe(422);

    // --- 6) 対象外施設: 別分団・存在しない施設は作成時404（存在を明かさない） ---
    const crossUnit = await createPlan(admin, [fNorth, otherUnitFacility], "別分団の施設を含める（試験用）", "2026-10-18");
    expect(crossUnit.status).toBe(404);
    const unknownFacility = await createPlan(admin, [fNorth, crypto.randomUUID()], "存在しない施設（試験用）", "2026-10-18");
    expect(unknownFacility.status).toBe(404);

    // 権限: PER-14は幹部・管理者（または担当scope）。一般団員は403
    const byMember = await createPlan(a.people.member, [fNorth], "一般団員の作成（試験用）", "2026-10-18");
    expect(byMember.status).toBe(403);

    // --- 7) 決定時の集合不一致・二重順序は400（対象との完全一致・重複なしが必須） ---
    const plan2 = PatrolPlan.parse((await json(await createPlan(admin, [fNorth, fMid], "集合不一致の試験（試験用）", "2026-10-19"))).data);
    // 対象外（この案に無い施設）を含む → 400
    const withExtra = await decide(admin, plan2.id, {
      version: plan2.version, orderedFacilityIds: [fNorth, fMid, fSouth], decision: "confirm", reason: "案に無い施設を含む（試験用）",
    });
    expect(withExtra.status).toBe(400);
    // 欠け → 400
    const withMissing = await decide(admin, plan2.id, {
      version: plan2.version, orderedFacilityIds: [fNorth], decision: "confirm", reason: "対象が欠けた順序（試験用）",
    });
    expect(withMissing.status).toBe(400);
    // 二重順序（同じ施設が2回） → 400
    const withDuplicate = await decide(admin, plan2.id, {
      version: plan2.version, orderedFacilityIds: [fNorth, fNorth, fMid], decision: "confirm", reason: "重複する順序（試験用）",
    });
    expect(withDuplicate.status).toBe(400);
    // 順序が違うだけで対象は一致 → 確認できる（案はまだdraftのまま）
    const reorder = await decide(admin, plan2.id, {
      version: plan2.version, orderedFacilityIds: [fMid, fNorth], decision: "confirm", reason: "順序だけ変えた確定（試験用）",
    });
    expect(reorder.status).toBe(200);

    // --- 8) 取消経路（draft→cancelled。終端。再操作は422） ---
    const plan3 = PatrolPlan.parse((await json(await createPlan(admin, [fNorth, fMid], "取消の試験（試験用）", "2026-10-20"))).data);
    const proposedOrder = plan3.stops.map((s) => s.facilityId);
    const cancelRes = await decide(admin, plan3.id, {
      version: plan3.version, orderedFacilityIds: proposedOrder, decision: "cancel", reason: "雨天順延のため取り消す（試験用）",
    });
    expect(cancelRes.status).toBe(200);
    const cancelled = PatrolPlan.parse((await json(cancelRes)).data);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.decidedAt).not.toBeNull();
    // 取消済みへの再取消（現行版）は422
    const reCancel = await decide(admin, plan3.id, {
      version: cancelled.version, orderedFacilityIds: proposedOrder, decision: "cancel", reason: "二重の取消（試験用）",
    });
    expect(reCancel.status).toBe(422);
    // 取消済みの確定も422（draftからしか遷移しない）
    const confirmCancelled = await decide(admin, plan3.id, {
      version: cancelled.version, orderedFacilityIds: proposedOrder, decision: "confirm", reason: "取消済みの確定（試験用）",
    });
    expect(confirmCancelled.status).toBe(422);
    // 旧版での取消も409
    const staleCancel = await decide(admin, plan3.id, {
      version: plan3.version, orderedFacilityIds: proposedOrder, decision: "cancel", reason: "旧版での取消（試験用）",
    });
    expect(staleCancel.status).toBe(409);
  });

  it("candidate_order_excludes_archived_facilities_and_keeps_positions_unique", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;

    // 停止（archived_at）の施設は候補から外す（巡回の対象でない。docs/16 T071の裁定）
    const active = await mkFacility(a, "PAT-T71-A1", 35.2, 139.2);
    const archived = await mkFacility(a, "PAT-T71-A2", 35.21, 139.2);
    await env.DB.prepare("UPDATE facilities SET archived_at = '2026-10-16T00:00:00.000Z' WHERE id = ?").bind(archived).run();

    const res = await createPlan(admin, [active, archived], "停止施設を含める（試験用）", "2026-10-21");
    expect(res.status).toBe(404); // 別分団と同じ「存在しない候補」（存在を明かさない）

    // positionはplan内で一意（1..N）。重複する候補IDは作成時点で400
    const duplicate = await fx.client(admin).request("POST", "/api/v1/patrol-plans", {
      facilityIds: [active, active], date: "2026-10-21", objective: "重複する候補（試験用）",
    }, idem());
    expect(duplicate.status).toBe(400);

    const ok = PatrolPlan.parse((await json(await createPlan(admin, [active], "単一候補（試験用）", "2026-10-21"))).data);
    expect(ok.stops.map((s) => s.position)).toEqual([1]);
    // stops表のpositionの一意（UNIQUE(unit, plan, position)）とfacilityの一重登録を直接確認
    const stops = await fx.rows("patrol_plan_stops", { plan_id: ok.id });
    expect(stops.map((s) => s.position).sort()).toEqual([1]);
  });
});
