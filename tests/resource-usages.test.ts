import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createFixture, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) =>
  (await r.json()) as {
    data?: Record<string, unknown>;
    meta?: { requestId?: string; nextCursor?: string };
    error?: { code: string; details?: { field: string; reason: string }[] };
  };

interface UsageData {
  id: string; version: number; operationId: string;
  target: { type: "vehicle" | "equipment"; id: string };
  quantity: number; usedFrom: string | null; usedTo: string | null;
  recordedByMemberId: string; status: string;
}

interface UsageEventRow {
  usage_id: string; action: string; before_json: string; after_json: string; reason: string | null;
}

describe("車両/機材の使用履歴と訂正 (T042)", () => {
  it("usage_replacement_cancels_missing_rows_without_reducing_stock", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 管理者（PER-04: 所属内の全行。docs/10「○報告」の実務上の主体）
    const member = a.people.member; // 一般団員（PER-04は本人分のみ→全集合PUTは不可）
    const operator = a.people.operator; // 担当者（scopeは施設のみ→operationの全行編集権は無い）
    const otherUnit = fx.units.b.people.admin;

    // --- 資産の登録（API-47/49。架空データ。数量機材の在庫は台帳側の値で、使用で動かさない=D15） ---
    const mkVehicle = async (assetCode: string, name: string) => {
      const res = await fx.client(admin).request("POST", "/api/v1/vehicles", { assetCode, name, status: "運用" }, idem());
      expect(res.status).toBe(201);
      return ((await json(res)).data! as { id: string }).id;
    };
    const pump = await mkVehicle("PUMP-T042", "架空市 第一分団 消防ポンプ車");
    const water = await mkVehicle("WATER-T042", "架空市 第一分団 給水車");
    const hoseRes = await fx.client(admin).request("POST", "/api/v1/equipment",
      { assetCode: "HOSE-T042", name: "ホース 65mm", quantity: 4, quantityUnit: "本", storage: { note: "詰所" } }, idem());
    expect(hoseRes.status).toBe(201);
    const hose = (await json(hoseRes)).data! as { id: string; quantity: number };
    const assetQuantityBefore = hose.quantity;
    expect(assetQuantityBefore).toBe(4);

    // --- 出動の登録と同時の使用履歴（API-22。T042で共通関数buildResourceUsageMutation経由に接続。
    // 出来事root/出動/使用履歴/履歴初行を同一batchで確定する。docs/05 API-22行） ---
    const createRes = await fx.client(admin).request("POST", "/api/v1/incidents", {
      kind: "training", occurredAt: "2026-10-12T02:00:00.000Z", summary: "架橋地区での水防訓練（架空）",
      resourceUsages: [
        { target: { type: "vehicle", id: pump }, quantity: 2, from: "2026-10-12T02:00:00.000Z", to: "2026-10-12T04:00:00.000Z" },
        { target: { type: "equipment", id: hose.id }, quantity: 1 },
      ],
    }, idem());
    expect(createRes.status).toBe(201);
    const incident = (await json(createRes)).data! as { id: string; version: number; operationId: string };

    // 使用履歴は出動の詳細（API-70）から読める（docs/05 API-70「使用履歴」。T040で空だった箇所）
    const detail = (await json(await fx.client(admin).request("GET", `/api/v1/incidents/${incident.id}`))).data! as {
      resourceUsages: UsageData[];
    };
    expect(detail.resourceUsages).toHaveLength(2);
    const pumpRow = detail.resourceUsages.find((u) => u.target.id === pump)!;
    const hoseRow = detail.resourceUsages.find((u) => u.target.id === hose.id)!;
    expect(pumpRow).toMatchObject({ status: "active", quantity: 2, recordedByMemberId: admin.memberId, operationId: incident.operationId });
    expect(hoseRow).toMatchObject({ status: "active", quantity: 1 });

    // 使用履歴を含む作成も一mutation一event（docs/02。incident.createdだけで、使用履歴の別eventは出さない）
    const createEvents = (await env.DB.prepare(
      "SELECT event_type FROM domain_events WHERE entity_id = ? AND entity_type = 'incident'",
    ).bind(incident.id).all<{ event_type: string }>()).results;
    expect(createEvents.map((e) => e.event_type)).toEqual(["incident.created"]);

    // --- 全有効集合PUT（API-57。docs/05 §1「operation版をガードし全有効集合を更新、抜けた既存行はcancelled」） ---
    const putUrl = `/api/v1/operations/${incident.operationId}/resource-usages`;
    const rowsBefore = await fx.rows("resource_usages", { operation_id: incident.operationId });
    expect(rowsBefore).toHaveLength(2);

    const replaceRes = await fx.client(admin).request("PUT", putUrl, {
      version: 1, // operation（出来事root）の現行版
      reason: "ホースの使用数量と時間の訂正、給水車の追加（架空）",
      usages: [
        // id付き=既存行の更新（数量・時間の訂正）
        { id: pumpRow.id, target: { type: "vehicle", id: pump }, quantity: 3, from: "2026-10-12T01:30:00.000Z", to: "2026-10-12T04:30:00.000Z" },
        // id無し=新規行
        { target: { type: "vehicle", id: water }, quantity: 1, from: "2026-10-12T02:10:00.000Z" },
      ],
      // ホースの行を来させない → cancelled
    }, idem());
    expect(replaceRes.status).toBe(200);
    const replaced = (await json(replaceRes)).data! as { usages: UsageData[]; operationVersion: number };

    // operation版は成功時に増分（docs/04:100「operation版も増分」）
    expect(replaced.operationVersion).toBe(2);
    expect(replaced.usages).toHaveLength(3);

    // 検収（ブリーフのassertion）: 一行を除いた全件PUTで、来なかった既存行はcancelledで残る
    const removedUsage = replaced.usages.find((u) => u.target.id === hose.id)!;
    expect(removedUsage.status).toBe("cancelled");

    // 検収（ブリーフのassertion）: 在庫の自動減算はしない（docs/04:100・D15。台帳の数量は不変）
    const assetQuantityAfter = ((await fx.rows("equipment", { id: hose.id }))[0]!.quantity) as number;
    expect(assetQuantityAfter).toBe(assetQuantityBefore);

    // 検収（ブリーフのassertion）: 物理削除は0（2行＋新規1行の3行が残る。docs/04「物理削除しない」）
    const rowsAfter = await fx.rows("resource_usages", { operation_id: incident.operationId });
    const physicalUsageDeleteCount = Math.max(0, rowsBefore.length + 1 - rowsAfter.length);
    expect(physicalUsageDeleteCount).toBe(0);

    // 更新・取消・新規の前後がresource_usage_eventsへ追記される（docs/04:100「変更前後を追記」）
    const events = (await env.DB.prepare(
      "SELECT usage_id, action, before_json, after_json, reason FROM resource_usage_events WHERE unit_id = ? ORDER BY rowid",
    ).bind(a.id).all<UsageEventRow>()).results;
    const lastEventOf = (usageId: string) => events.filter((e) => e.usage_id === usageId).at(-1)!;
    const pumpEvent = lastEventOf(pumpRow.id);
    expect(pumpEvent.action).toBe("update");
    expect(JSON.parse(pumpEvent.before_json)).toMatchObject({ quantity: 2, status: "active" });
    expect(JSON.parse(pumpEvent.after_json)).toMatchObject({ quantity: 3, usedFrom: "2026-10-12T01:30:00.000Z", status: "active" });
    const hoseEvent = lastEventOf(hoseRow.id);
    expect(hoseEvent.action).toBe("cancel");
    expect(JSON.parse(hoseEvent.before_json)).toMatchObject({ status: "active" });
    expect(JSON.parse(hoseEvent.after_json)).toMatchObject({ status: "cancelled" });
    expect(hoseEvent.reason).toBe("ホースの使用数量と時間の訂正、給水車の追加（架空）");
    // 新規行にも初行（作成の前後JSON。incident_eventsのcreateと同じ流儀）
    const waterRow = replaced.usages.find((u) => u.target.id === water)!;
    const waterEvent = lastEventOf(waterRow.id);
    expect(waterEvent.action).toBe("create");
    expect(JSON.parse(waterEvent.before_json)).toEqual({});

    // 旧版のPUTは409（docs/05 §1「ResourceUsageListのPUTはoperation版をガード」）
    const stale = await fx.client(admin).request("PUT", putUrl, {
      version: 1, reason: "古い版からの変更（架空）",
      usages: [{ target: { type: "vehicle", id: pump }, quantity: 9 }],
    }, idem());
    expect(stale.status).toBe(409);
    expect((await json(stale)).error?.code).toBe("VERSION_CONFLICT");

    // --- 同version並行更新は一方だけ成功（もう一方は409。負け側の変更・履歴・監査は残らない） ---
    const win = await fx.client(admin).request("PUT", putUrl, {
      version: 2, reason: "A案の数量（架空）",
      usages: [{ id: pumpRow.id, target: { type: "vehicle", id: pump }, quantity: 5 }],
    }, idem());
    expect(win.status).toBe(200);
    const winData = (await json(win)).data! as { usages: UsageData[]; operationVersion: number };
    expect(winData.operationVersion).toBe(3);
    const lose = await fx.client(admin).request("PUT", putUrl, {
      version: 2, reason: "B案の数量（架空）",
      usages: [{ id: pumpRow.id, target: { type: "vehicle", id: pump }, quantity: 6 }],
    }, idem());
    expect(lose.status).toBe(409);
    // 負け側の変更は反映されない（A案の5のまま。docs/05 §2「競合では履歴/監査を残さない」）
    const afterConcurrent = ((await fx.rows("resource_usages", { id: pumpRow.id }))[0]!.quantity) as number;
    expect(afterConcurrent).toBe(5);

    // --- 担当外の既存行が混ざる全集合PUTは403で全体を拒否（docs/05 API-57「全対象編集権」。
    // 既存行の記録者と関係なく、この操作のPER-04を検査する。一般団員は本人分しか編集できない） ---
    const partialEditPermission = await fx.client(member).request("PUT", putUrl, {
      version: 3, reason: "本人分のつもりの編集（架空）",
      usages: [{ target: { type: "vehicle", id: pump }, quantity: 1 }],
    }, idem());
    // 検収（ブリーフのassertion）
    expect(partialEditPermission.status).toBe(403);
    // 担当(scope)がoperationに無い担当者も不可。部分更新もしない（版・行とも不変）
    const operatorEdit = await fx.client(operator).request("PUT", putUrl, {
      version: 3, reason: "担当外の編集（架空）",
      usages: [{ target: { type: "vehicle", id: pump }, quantity: 1 }],
    }, idem());
    expect(operatorEdit.status).toBe(403);
    expect(((await fx.rows("operations", { id: incident.operationId }))[0]!.version) as number).toBe(3);
    expect(((await fx.rows("resource_usages", { id: pumpRow.id }))[0]!.quantity) as number).toBe(5);

    // --- 入力の検査（docs/04:100「対象ちょうど一つ、quantity>0、時間順序」） ---
    const zeroQty = await fx.client(admin).request("PUT", putUrl, {
      version: 3, reason: "数量0（架空）", usages: [{ target: { type: "vehicle", id: pump }, quantity: 0 }],
    }, idem());
    expect(zeroQty.status).toBe(400);
    const badOrder = await fx.client(admin).request("PUT", putUrl, {
      version: 3, reason: "時間順序違反（架空）",
      usages: [{ target: { type: "vehicle", id: pump }, quantity: 1, from: "2026-10-12T05:00:00.000Z", to: "2026-10-12T04:00:00.000Z" }],
    }, idem());
    expect(badOrder.status).toBe(400);
    // 対象はvehicle/equipmentのちょうど一つ（Target契約どおり。施設は使用履歴の対象にならない）
    const facilityTarget = await fx.client(admin).request("PUT", putUrl, {
      version: 3, reason: "施設は対象外（架空）", usages: [{ target: { type: "facility", id: a.scopeIn.entityId }, quantity: 1 }],
    }, idem());
    expect(facilityTarget.status).toBe(400);
    // 存在しない/別unitの資産は404（docs/05 §1「存在を明かさない」）
    const unknownAsset = await fx.client(admin).request("PUT", putUrl, {
      version: 3, reason: "存在しない車両（架空）", usages: [{ target: { type: "vehicle", id: crypto.randomUUID() }, quantity: 1 }],
    }, idem());
    expect(unknownAsset.status).toBe(404);
    const otherUnitAsset = await fx.client(admin).request("PUT", putUrl, {
      version: 3, reason: "別分団の車両（架空）", usages: [{ target: { type: "vehicle", id: fx.units.b.scopeIn.entityId }, quantity: 1 }],
    }, idem());
    expect(otherUnitAsset.status).toBe(404);

    // 廃止した資産は使えない（docs/04「廃止は論理状態」。T025の流儀: status=廃止。物理削除はしない）
    const waterVersion = ((await fx.rows("vehicles", { id: water }))[0]!.version) as number;
    const retire = await fx.client(admin).request("PATCH", `/api/v1/vehicles/${water}`, { version: waterVersion, status: "廃止" }, idem());
    expect(retire.status).toBe(200);
    const retiredAsset = await fx.client(admin).request("PUT", putUrl, {
      version: 3, reason: "廃止車両の使用（架空）", usages: [{ target: { type: "vehicle", id: water }, quantity: 1 }],
    }, idem());
    expect(retiredAsset.status).toBe(404);

    // cancelledは終端: 取消済み行のidを渡した更新は422（docs/04「active/cancelled」。履歴の復活はさせない）
    const resurrect = await fx.client(admin).request("PUT", putUrl, {
      version: 3, reason: "取消行の再編集（架空）",
      usages: [{ id: hoseRow.id, target: { type: "equipment", id: hose.id }, quantity: 2 }],
    }, idem());
    expect(resurrect.status).toBe(422);

    // --- 同じ鍵の再送は保存済み応答（docs/05 §2。版を増やさない。id付きの本文でも旧版にならない） ---
    const replayKey = { "idempotency-key": crypto.randomUUID() };
    const first = await fx.client(admin).request("PUT", putUrl, {
      version: 3, reason: "冪等の確認（架空）",
      usages: [{ id: pumpRow.id, target: { type: "vehicle", id: pump }, quantity: 5, from: "2026-10-12T01:30:00.000Z" }],
    }, replayKey);
    expect(first.status).toBe(200);
    const versionAfterFirst = ((await fx.rows("operations", { id: incident.operationId }))[0]!.version) as number;
    const second = await fx.client(admin).request("PUT", putUrl, {
      version: 3, reason: "冪等の確認（架空）",
      usages: [{ id: pumpRow.id, target: { type: "vehicle", id: pump }, quantity: 5, from: "2026-10-12T01:30:00.000Z" }],
    }, replayKey);
    expect(second.status).toBe(200);
    expect((await json(second)).data).toEqual((await json(first)).data);
    expect(((await fx.rows("operations", { id: incident.operationId }))[0]!.version) as number).toBe(versionAfterFirst);

    // 別分団のoperationは404（存在を明かさない。別unitのactivityIdと同じ扱い）
    const otherUnitPut = await fx.client(otherUnit).request("PUT", putUrl, {
      version: 1, reason: "別分団の出来事（架空）", usages: [],
    }, idem());
    expect(otherUnitPut.status).toBe(404);
  });

  it("usage_history_is_reachable_from_assets_and_shared_with_activities", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;

    // 活動（予定）のoperationにも同じAPIで使用履歴を書ける（docs/04「operationを共有する活動と出動」）
    const activityRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "秋季の水防訓練（架空）", kind: "訓練", plannedStartsAt: "2026-10-14T01:00:00.000Z",
      locationText: "架空市架橋地区", ownerMemberId: admin.memberId, audienceMemberIds: [a.people.member.memberId!],
    }, idem());
    expect(activityRes.status).toBe(201);
    const activity = (await json(activityRes)).data! as { id: string; operationId: string };

    const vehicleRes = await fx.client(admin).request("POST", "/api/v1/vehicles",
      { assetCode: "PUMP-T042B", name: "架空市 第一分団 II型ポンプ車", status: "運用" }, idem());
    const vehicle = ((await json(vehicleRes)).data! as { id: string }).id;

    const putUrl = `/api/v1/operations/${activity.operationId}/resource-usages`;
    const putRes = await fx.client(admin).request("PUT", putUrl, {
      version: 1, reason: "訓練でII型ポンプ車を使用（架空）",
      usages: [{ target: { type: "vehicle", id: vehicle }, quantity: 1, from: "2026-10-14T01:00:00.000Z", to: "2026-10-14T03:00:00.000Z" }],
    }, idem());
    expect(putRes.status).toBe(200);
    const putData = (await json(putRes)).data! as { usages: UsageData[]; operationVersion: number };
    expect(putData.operationVersion).toBe(2);
    expect(putData.usages).toHaveLength(1);
    expect(putData.usages[0]).toMatchObject({ status: "active", operationId: activity.operationId });

    // 資産の詳細（API-51）から使用履歴の子Pageへ。operationIdで元の活動/出動を辿れる（docs/05 API-51）
    const detailRes = await fx.client(admin).request("GET", `/api/v1/assets/vehicle/${vehicle}`);
    expect(detailRes.status).toBe(200);
    const detail = (await json(detailRes)).data! as {
      asset: { id: string; assetCode: string };
      usages: UsageData[];
    };
    expect(detail.asset).toMatchObject({ id: vehicle, assetCode: "PUMP-T042B" });
    expect(detail.usages).toHaveLength(1);
    expect(detail.usages[0]!.operationId).toBe(activity.operationId); // 元出来事（活動）へ辿れる

    // 子Pageのcursor（docs/05 §1「Detailは親＋認可された子PageとnextCursor。件数を黙って切り捨てない」）。
    // id無しの新規行を足す（旧行はcancelledで残る）ことで2行になり、limit=1の2頁で全件辿れることを確かめる
    const second = await fx.client(admin).request("PUT", putUrl, {
      version: 2, reason: "II型ポンプ車を再度使用（架空）",
      usages: [{ target: { type: "vehicle", id: vehicle }, quantity: 2, from: "2026-10-15T01:00:00.000Z" }],
    }, idem());
    expect(second.status).toBe(200);
    const page1 = await fx.client(admin).request("GET", `/api/v1/assets/vehicle/${vehicle}?limit=1`);
    const page1Json = await json(page1);
    const page1Data = page1Json.data! as { usages: UsageData[] };
    expect(page1Data.usages).toHaveLength(1);
    const nextCursor = page1Json.meta?.nextCursor;
    expect(nextCursor).toBeTruthy();
    const page2 = await fx.client(admin).request("GET", `/api/v1/assets/vehicle/${vehicle}?limit=1&cursor=${encodeURIComponent(nextCursor!)}`);
    const page2Data = (await json(page2)).data! as { usages: UsageData[] };
    expect(page2Data.usages).toHaveLength(1);
    // cancelledも行として残る（docs/04:100「物理削除しない」。docs/11 §3「集計は無効なoperationを除く」の使用履歴版）
    expect([...page1Data.usages, ...page2Data.usages].map((u) => u.status).sort()).toEqual(["active", "cancelled"]);
  });
});
