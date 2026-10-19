import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createFixture, type TestFixture } from "./helpers/fixture";
import { COMMON_EFFECT_TABLES, rowCounts, withFailingInsert } from "./helpers/fail-insert";

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

interface ActivityData {
  id: string; version: number; operationId: string;
}
interface IncidentData {
  id: string; version: number; operationId: string; activityId: string | null;
}
interface UsageData {
  id: string; version: number; operationId: string; status: string;
  target: { type: string; id: string };
}
interface LinkEventData {
  action: string; before: Record<string, unknown>; after: Record<string, unknown>; reason: string | null;
}

describe("出動と活動を一つの出来事へ関連付け (T043)", () => {
  it("link_locks_both_roots_and_preserves_all_resource_usages", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 管理者（PER-04: 所属内の出動・使用履歴の編集）
    const member = a.people.member; // 一般団員（PER-04は本人分のみ→リンクは不可）
    const officer = a.people.officer; // 幹部（活動の担当になる団員）
    const otherUnit = fx.units.b.people.admin; // 別分団（存在も明かさない）

    // --- 資産の登録（API-47/49。架空データ。docs/04:100の使用履歴対象） ---
    const mkVehicle = async (assetCode: string, name: string) => {
      const res = await fx.client(admin).request("POST", "/api/v1/vehicles", { assetCode, name, status: "運用" }, idem());
      expect(res.status).toBe(201);
      return ((await json(res)).data! as { id: string }).id;
    };
    const pump = await mkVehicle("PUMP-T043", "架空市 第一分団 II型ポンプ車");
    const hoseRes = await fx.client(admin).request("POST", "/api/v1/equipment",
      { assetCode: "HOSE-T043", name: "ホース 65mm", quantity: 6, quantityUnit: "本", storage: { note: "詰所" } }, idem());
    expect(hoseRes.status).toBe(201);
    const hose = ((await json(hoseRes)).data! as { id: string }).id;

    // --- 別々に作成した活動と出動（activities/incidentsのoperation_idは別採番。T035/T040の作成経路） ---
    const activityRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "秋季の水防訓練（架空）", kind: "訓練", plannedStartsAt: "2026-10-16T01:00:00.000Z",
      locationText: "架空市架橋地区", ownerMemberId: officer.memberId!, audienceMemberIds: [member.memberId!],
    }, idem());
    expect(activityRes.status).toBe(201);
    const activityA = (await json(activityRes)).data! as unknown as ActivityData;
    const opA = activityA.operationId;

    // 活動側の使用履歴（API-57。活動operationの版1→2）
    const actUsageRes = await fx.client(admin).request("PUT", `/api/v1/operations/${opA}/resource-usages`, {
      version: 1, reason: "訓練でポンプ車を使用（架空）",
      usages: [{ target: { type: "vehicle", id: pump }, quantity: 1, from: "2026-10-16T01:00:00.000Z", to: "2026-10-16T03:00:00.000Z" }],
    }, idem());
    expect(actUsageRes.status).toBe(200);
    const usageOnActivity = (((await json(actUsageRes)).data! as { usages: UsageData[] }).usages).find((u) => u.status === "active")!;

    // 出動側（API-22。出動operationと使用履歴を同batchで作る）
    const incidentRes = await fx.client(admin).request("POST", "/api/v1/incidents", {
      kind: "training", occurredAt: "2026-10-16T02:00:00.000Z", summary: "秋季の水防訓練の出動記録（架空）",
      resourceUsages: [{ target: { type: "equipment", id: hose }, quantity: 2 }],
    }, idem());
    expect(incidentRes.status).toBe(201);
    const incident1 = (await json(incidentRes)).data! as unknown as IncidentData;
    const opI = incident1.operationId;
    expect(opI).not.toBe(opA); // リンク前は別のoperation
    const incidentUsageRows = await fx.rows("resource_usages", { unit_id: a.id, operation_id: opI });
    expect(incidentUsageRows).toHaveLength(1);
    const usageOnIncident = String(incidentUsageRows[0]!.id);
    const originalUsageIds = [usageOnActivity.id, usageOnIncident].sort();

    // --- リンク（API-71。docs/04:103「両rootのversion・関連利用行をガードし、incidentと使用履歴を
    // 活動側operationへ付替、旧operationを非計数化」） ---
    const linkRes = await fx.client(admin).request("PUT", `/api/v1/incidents/${incident1.id}/activity`, {
      version: incident1.version, activityId: activityA.id, activityVersion: activityA.version,
      operationVersions: { [opA]: 2, [opI]: 1 },
      reason: "訓練の予定と出動記録を一つの出来事へ統合（架空）",
    }, idem());
    expect(linkRes.status).toBe(200);
    const linked = (await json(linkRes)).data! as {
      incident: IncidentData;
      link: { incidentId: string; activityId: string; operationId: string; retiredOperationId: string; operationVersion: number; retainedUsageIds: string[] };
    };
    expect(linked.incident).toMatchObject({ id: incident1.id, version: 2, activityId: activityA.id, operationId: opA });
    expect(linked.link).toMatchObject({
      incidentId: incident1.id, activityId: activityA.id, operationId: opA,
      retiredOperationId: opI, operationVersion: 3,
    });
    // 検収（ブリーフのassertion）: 使用履歴は1行も失われない（両側の行が生存operationへ付替。物理削除しない）
    expect([...linked.link.retainedUsageIds].sort()).toEqual(originalUsageIds);

    // 双方向の導線（T044の「既存活動link→使用機材→資産履歴→元出動に戻る」。docs/05 API-70/07）
    const incidentDetail = ((await json(await fx.client(admin).request("GET", `/api/v1/incidents/${incident1.id}`))).data!) as {
      operationId: string; activityId: string; activity: { id: string } | null;
      resourceUsages: UsageData[]; events: LinkEventData[];
    };
    const activityDetail = ((await json(await fx.client(admin).request("GET", `/api/v1/activities/${activityA.id}`))).data!) as unknown as ActivityData;
    // 検収（ブリーフのassertion）: 両rootが同一operationへ統合される
    expect(activityDetail.operationId).toBe(incidentDetail.operationId);
    expect(incidentDetail.activityId).toBe(activityA.id);
    expect(incidentDetail.activity).toMatchObject({ id: activityA.id });

    // 検収（ブリーフのassertion）: 双方の使用履歴が全部見え、有効operationは1つ
    const distinctCount = new Set(incidentDetail.resourceUsages.map((u) => u.operationId)).size;
    expect(distinctCount).toBe(1);
    expect(incidentDetail.resourceUsages.map((u) => u.id).sort()).toEqual(originalUsageIds);
    expect(incidentDetail.resourceUsages.every((u) => u.status === "active")).toBe(true);

    // 旧operation（出動側）は非計数化（docs/04:103「旧operationを非計数化」）だが行は残る
    const retiredOp = (await fx.rows("operations", { id: opI }))[0]!;
    expect(retiredOp.countable).toBe(0); // 集計から外れる（docs/11 §3「集計は無効なoperationを除く」）
    expect(retiredOp.status).toBe("recording"); // 出動側の状態は変わらない。履歴/監査参照は可能
    expect(((await fx.rows("operations", { id: opA }))[0]!).countable).toBe(1);
    // 付け替えられた行も物理削除は0（docs/04:100「物理削除しない」）
    expect(await fx.rows("resource_usages", { id: usageOnIncident })).toHaveLength(1);
    expect(String((await fx.rows("resource_usages", { id: usageOnIncident }))[0]!.operation_id)).toBe(opA);

    // 旧ID/理由はイベントへ残る（docs/04:103「旧ID/理由をイベントへ残す」）
    const linkEvent = incidentDetail.events.at(-1)!;
    expect(linkEvent.action).toBe("activity.link");
    expect(linkEvent.reason).toBe("訓練の予定と出動記録を一つの出来事へ統合（架空）");
    expect(linkEvent.before).toMatchObject({ operationId: opI, activityId: null });
    expect(linkEvent.after).toMatchObject({ operationId: opA, activityId: activityA.id, retiredOperationId: opI });

    // 活動側にも履歴（activity_events。状態は不変で前=後。docs/04 activity_events「取消も保持」と同じ追記）
    const actEvents = await fx.rows("activity_events", { activity_id: activityA.id });
    const lastActEvent = actEvents.at(-1)!;
    expect(lastActEvent.previous_status).toBe(lastActEvent.next_status);
    expect(lastActEvent.reason).toBe("訓練の予定と出動記録を一つの出来事へ統合（架空）");

    // 一mutation一event（docs/02。使用履歴の付替えで別eventは出さない）
    const incidentEvents = (await env.DB.prepare(
      "SELECT event_type FROM domain_events WHERE unit_id = ? AND entity_id = ?",
    ).bind(a.id, incident1.id).all<{ event_type: string }>()).results;
    expect(incidentEvents.filter((e) => e.event_type === "incident.activity.linked")).toHaveLength(1);
    const linkAudits = (await env.DB.prepare(
      "SELECT action FROM audit_logs WHERE unit_id = ? AND entity_id = ? AND action LIKE 'incident.activity%'",
    ).bind(a.id, incident1.id).all<{ action: string }>()).results;
    expect(linkAudits).toHaveLength(1);

    // --- リンク後も生存operationの使用履歴は編集できる（T044の「使用機材編集」導線。API-57） ---
    const editRes = await fx.client(admin).request("PUT", `/api/v1/operations/${opA}/resource-usages`, {
      version: 3, reason: "リンク後の数量訂正（架空）",
      usages: [
        { id: usageOnActivity.id, target: { type: "vehicle", id: pump }, quantity: 2 },
        { id: usageOnIncident, target: { type: "equipment", id: hose }, quantity: 3 },
      ],
    }, idem());
    expect(editRes.status).toBe(200);
    expect(((await json(editRes)).data! as { operationVersion: number }).operationVersion).toBe(4);

    // --- 失敗系1: 片側のoperation版が変わっている（活動側operationを他者が先に進めた状況）→
    // 409で全体を何も変えず拒否（docs/05 API-71「両rootロック」。片側だけ進む分断を作らない） ---
    const activityBRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "秋季の墜落警報訓練（架空）", kind: "訓練", plannedStartsAt: "2026-10-17T01:00:00.000Z",
      locationText: "架空市中央公園", ownerMemberId: officer.memberId!, audienceMemberIds: [member.memberId!],
    }, idem());
    expect(activityBRes.status).toBe(201);
    const activityB = (await json(activityBRes)).data! as unknown as ActivityData;
    const opB = activityB.operationId;

    const incident2Res = await fx.client(admin).request("POST", "/api/v1/incidents", {
      kind: "simulation", occurredAt: "2026-10-17T02:00:00.000Z", summary: "墜落警報訓練の出動記録（架空）",
      resourceUsages: [{ target: { type: "vehicle", id: pump }, quantity: 1 }],
    }, idem());
    expect(incident2Res.status).toBe(201);
    const incident2 = (await json(incident2Res)).data! as unknown as IncidentData;
    const opI2 = incident2.operationId;

    // リンク試行の前に活動側operationの版だけ進める（opB: 1→2。片側版変更）
    const bumpB = await fx.client(admin).request("PUT", `/api/v1/operations/${opB}/resource-usages`, {
      version: 1, reason: "訓練でポンプ車を追加使用（架空）",
      usages: [{ target: { type: "vehicle", id: pump }, quantity: 1 }],
    }, idem());
    expect(bumpB.status).toBe(200);

    const snapshotOf = async () => ({
      incidents: (await fx.rows("incidents", { unit_id: a.id })).map((r) => [r.id, r.operation_id, r.activity_id, r.version]),
      activities: (await fx.rows("activities", { unit_id: a.id })).map((r) => [r.id, r.version]),
      operations: (await fx.rows("operations", { unit_id: a.id }))
        .filter((r) => [opA, opI, opB, opI2].includes(String(r.id)))
        .map((r) => [r.id, r.version, r.countable, r.status]),
      usages: (await fx.rows("resource_usages", { unit_id: a.id })).map((r) => [r.id, r.operation_id, r.status, r.version]),
      audits: (await fx.rows("audit_logs", { unit_id: a.id })).length,
      events: (await fx.rows("domain_events", { unit_id: a.id })).length,
    });
    const beforeLinkState = await snapshotOf();

    const staleLink = await fx.client(admin).request("PUT", `/api/v1/incidents/${incident2.id}/activity`, {
      version: incident2.version, activityId: activityB.id, activityVersion: activityB.version,
      operationVersions: { [opB]: 1, [opI2]: 1 }, // opBの現行版は2。旧版での送信
      reason: "旧版からのリンク（架空）",
    }, idem());
    expect(staleLink.status).toBe(409);
    expect((await json(staleLink)).error?.code).toBe("VERSION_CONFLICT");
    // 検収（ブリーフのassertion）: 途中の文も含めて全て取り消され、部分適用されない
    const failedLinkState = await snapshotOf();
    expect(failedLinkState).toEqual(beforeLinkState);

    // operationVersionsのキー不足は400（両rootのロックに必要な版が揃っていない）
    const missingKey = await fx.client(admin).request("PUT", `/api/v1/incidents/${incident2.id}/activity`, {
      version: incident2.version, activityId: activityB.id, activityVersion: activityB.version,
      operationVersions: { [opB]: 2 }, // 出動側のoperation版が無い
      reason: "版が足りないリンク（架空）",
    }, idem());
    expect(missingKey.status).toBe(400);
    expect((await json(missingKey)).error?.code).toBe("VALIDATION_ERROR");

    // --- 正しい版でのリンクは成功する（失敗が後続を妨げない。opB版2・opI2版1） ---
    const link2Res = await fx.client(admin).request("PUT", `/api/v1/incidents/${incident2.id}/activity`, {
      version: incident2.version, activityId: activityB.id, activityVersion: activityB.version,
      operationVersions: { [opB]: 2, [opI2]: 1 },
      reason: "訓練の予定と出動記録を統合（架空）",
    }, idem());
    expect(link2Res.status).toBe(200);

    // --- 失敗系2: 既にリンク済みの活動への別出動は409（docs/04:103「既存の別リンクがある場合は409」。
    // incidents.activity_id UNIQUE＋明示検査。上書きしない） ---
    const incident3Res = await fx.client(admin).request("POST", "/api/v1/incidents", {
      kind: "training", occurredAt: "2026-10-17T03:00:00.000Z", summary: "同じ訓練への二重登録（架空）",
    }, idem());
    expect(incident3Res.status).toBe(201);
    const incident3 = (await json(incident3Res)).data! as unknown as IncidentData;
    const dupLink = await fx.client(admin).request("PUT", `/api/v1/incidents/${incident3.id}/activity`, {
      version: incident3.version, activityId: activityB.id, activityVersion: activityB.version + 1,
      operationVersions: { [opB]: 3, [incident3.operationId]: 1 },
      reason: "二重リンク（架空）",
    }, idem());
    expect(dupLink.status).toBe(409);
    expect((await json(dupLink)).error?.code).toBe("DUPLICATE");
    // 拒否された出動は未リンクのまま（行・operationとも不変）
    expect((await fx.rows("incidents", { id: incident3.id }))[0]!.activity_id).toBeNull();

    // --- 失敗系3: リンク済み出動の付け替えは422（docs/05・docs/11に付け替えの根拠が無いため非対応） ---
    const relink = await fx.client(admin).request("PUT", `/api/v1/incidents/${incident2.id}/activity`, {
      version: 2, activityId: activityA.id, activityVersion: activityA.version,
      operationVersions: { [opA]: 4, [opB]: 3 }, reason: "付け替え（架空）",
    }, idem());
    expect(relink.status).toBe(422);
    expect((await json(relink)).error?.code).toBe("INVALID_TRANSITION");

    // --- 失敗系4: voided出動へのリンクは422（docs/11「voidedは閲覧のみ」） ---
    const incident4Res = await fx.client(admin).request("POST", "/api/v1/incidents", {
      kind: "actual_record", occurredAt: "2026-10-17T04:00:00.000Z", summary: "誤って二重登録した記録（架空）",
    }, idem());
    expect(incident4Res.status).toBe(201);
    const incident4 = (await json(incident4Res)).data! as unknown as IncidentData;
    const voidRes = await fx.client(admin).request("PATCH", `/api/v1/incidents/${incident4.id}`, {
      version: incident4.version, status: "voided", reason: "誤登録のため無効化（架空）",
    }, idem());
    expect(voidRes.status).toBe(200);
    const voidedLink = await fx.client(admin).request("PUT", `/api/v1/incidents/${incident4.id}/activity`, {
      version: incident4.version + 1, activityId: activityA.id, activityVersion: activityA.version,
      operationVersions: { [opA]: 4, [incident4.operationId]: 2 }, reason: "voidedへのリンク（架空）",
    }, idem());
    expect(voidedLink.status).toBe(422);
    expect((await json(voidedLink)).error?.code).toBe("INVALID_TRANSITION");

    // --- 権限: 一般団員は403（PER-04。リンクは本人分ではない）、別分団は404（存在を明かさない） ---
    const memberLink = await fx.client(member).request("PUT", `/api/v1/incidents/${incident3.id}/activity`, {
      version: incident3.version, activityId: activityA.id, activityVersion: activityA.version,
      operationVersions: { [opA]: 4, [incident3.operationId]: 1 }, reason: "本人分のつもり（架空）",
    }, idem());
    expect(memberLink.status).toBe(403);
    const otherLink = await fx.client(otherUnit).request("PUT", `/api/v1/incidents/${incident3.id}/activity`, {
      version: incident3.version, activityId: activityA.id, activityVersion: activityA.version,
      operationVersions: { [opA]: 4, [incident3.operationId]: 1 }, reason: "別分団から（架空）",
    }, idem());
    expect(otherLink.status).toBe(404);

    // --- API-22の作成時リンクも共通処理（docs/04:94「リンク時operation一致」。生まれたときから
    // 活動のoperationに属し、使用履歴も同じoperationに作る） ---
    const activityCRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "秋季の情報伝達訓練（架空）", kind: "訓練", plannedStartsAt: "2026-10-18T01:00:00.000Z",
      locationText: "架空市詰所", ownerMemberId: officer.memberId!, audienceMemberIds: [member.memberId!],
    }, idem());
    expect(activityCRes.status).toBe(201);
    const activityC = (await json(activityCRes)).data! as unknown as ActivityData;
    const opC = activityC.operationId;
    const createLinkedRes = await fx.client(admin).request("POST", "/api/v1/incidents", {
      kind: "training", occurredAt: "2026-10-18T02:00:00.000Z", summary: "情報伝達訓練の記録（架空）",
      activityId: activityC.id,
      resourceUsages: [{ target: { type: "vehicle", id: pump }, quantity: 1 }],
    }, idem());
    expect(createLinkedRes.status).toBe(201);
    const createdLinked = (await json(createLinkedRes)).data! as unknown as IncidentData;
    expect(createdLinked.operationId).toBe(opC); // 別operationを作らず活動側へ一致
    expect(createdLinked.activityId).toBe(activityC.id);
    // 使用履歴も生存operationに作られる
    expect((await fx.rows("resource_usages", { unit_id: a.id, operation_id: opC }))).toHaveLength(1);
    // リンクで生存operationの版を増分する（docs/04:100「operation版も増分」と同じ。1→2）
    expect(((await fx.rows("operations", { id: opC }))[0]!.version) as number).toBe(2);
    // 同じ活動への2件目の作成時リンクは409（一活動一出動）
    const dupCreate = await fx.client(admin).request("POST", "/api/v1/incidents", {
      kind: "training", occurredAt: "2026-10-18T03:00:00.000Z", summary: "同じ活動への二重リンク（架空）",
      activityId: activityC.id,
    }, idem());
    expect(dupCreate.status).toBe(409);
    expect((await json(dupCreate)).error?.code).toBe("DUPLICATE");
    // 作成時リンクされた出動の詳細にも活動が載る（docs/05 API-70「活動」）
    const createdDetail = ((await json(await fx.client(admin).request("GET", `/api/v1/incidents/${createdLinked.id}`))).data!) as {
      activity: { id: string } | null;
    };
    expect(createdDetail.activity).toMatchObject({ id: activityC.id });
  });
  // --- T085レビューB-I4（CT-05）: 関連付けを途中で失敗させても、出動・活動・出来事・使用履歴・履歴・監査・outboxは変わらない ---
  it("link_leaves_nothing_when_a_statement_fails_midway (T085 CT-05)", async () => {
    const admin = fx.units.a.people.admin;
    const act = (await json(await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "関連付けの途中失敗（架空）", kind: "訓練", plannedStartsAt: "2026-10-22T01:00:00.000Z", locationText: "架空市", ownerMemberId: admin.memberId!, audienceMemberIds: [admin.memberId!],
    }, idem()))).data! as { id: string; version: number; operationId: string };
    const inc = (await json(await fx.client(admin).request("POST", "/api/v1/incidents", { kind: "training", occurredAt: "2026-10-22T01:30:00.000Z", summary: "関連付けの途中失敗（架空）" }, idem()))).data! as { id: string; version: number; operationId: string };
    const tables = ["incidents", "activities", "operations", "resource_usages", "incident_events", "activity_events", ...COMMON_EFFECT_TABLES];
    const snapshot = async () => ({
      counts: await rowCounts(tables),
      inc: (await fx.rows("incidents", { id: inc.id }))[0]!,
      opA: (await fx.rows("operations", { id: act.operationId }))[0]!,
      opI: (await fx.rows("operations", { id: inc.operationId }))[0]!,
    });
    const before = await snapshot();
    const link = () => fx.client(admin).request("PUT", `/api/v1/incidents/${inc.id}/activity`, {
      version: inc.version, activityId: act.id, activityVersion: act.version,
      operationVersions: { [act.operationId]: before.opA.version as number, [inc.operationId]: before.opI.version as number },
      reason: "途中失敗の確認（架空）",
    }, idem());
    // 出動・出来事の付替えの後、活動側の履歴の文で失敗
    const failed = await withFailingInsert("activity_events", link);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await snapshot()).toEqual(before);
    expect((await link()).status).toBe(200);
  });
});
