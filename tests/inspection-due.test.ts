import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { detectDueInspections, isOverdue } from "../src/server/jobs/handlers/inspection-due";
import { createFixture, type TestFixture } from "./helpers/fixture";

/**
 * 点検期限（T048、docs/04:119、docs/05 API-56/51/18/19/28、docs/14 D06）。
 * - 期限は業務日（JST暦日）。超過は「タイムゾーンの暦日で next_due_date < 今日」＝期限当日23:59は未超過、
 *   翌日00:00で超過（docs/11/05期限・D06。時刻や夏時間と業務日を混同しない）。
 * - 検出（detectDueInspections）はCron（毎分）から呼ばれ、超過を専用の追記型表
 *   inspection_due_detections（UNIQUE(unit,対象,予定版,期限日)）へ INSERT ... ON CONFLICT DO NOTHING
 *   で記録する。通知はT050（notifications表）がこの表を源にしてdraftを作るため、T048では作らない。
 *   再実行（同Cron2回）で検出候補を重複作成しない。AIは呼ばない（aiCalls=0）。
 * - 停止資産（archived_at IS NOT NULL または status='廃止'。docs/14 D24の両建て）は検出対象から外す。
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

// 今日のJST暦日（試験側で独立に計算する。実装のbusinessDateInに依存しない）
const todayJst = new Intl.DateTimeFormat("en-ca", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
/** YYYY-MM-DDの日数ずらし（UTC深夜基準。JSTの暦日計算には影響しない） */
const shiftDays = (date: string, days: number) => new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

/** 検出ログの行（対象で絞り、予定版の順に並べる） */
const detectionRows = async (targetId: string) =>
  (await fx.rows("inspection_due_detections", { target_id: targetId })).sort((x, y) => String(x.schedule_version).localeCompare(String(y.schedule_version)));

describe("点検期限のJST日付判定と重複検出防止 (T048)", () => {
  it("due_detection_uses_japan_date_and_is_idempotent", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;

    // --- seed: 車両2台・資機材2台（架空データ） ---
    const mkVehicle = async (code: string) => {
      const res = await fx.client(admin).request("POST", "/api/v1/vehicles", { assetCode: code, name: `架空車両 ${code}`, status: "運用" }, idem());
      expect(res.status).toBe(201);
      return ((await json(res)).data! as { id: string }).id;
    };
    const mkEquipment = async (code: string) => {
      const res = await fx.client(admin).request("POST", "/api/v1/equipment", { assetCode: code, name: `架空機材 ${code}`, quantity: 1, quantityUnit: "本", storage: { note: "詰所" } }, idem());
      expect(res.status).toBe(201);
      return ((await json(res)).data! as { id: string }).id;
    };
    const vehicle = await mkVehicle("SCH-DUE-V"); // 期限は「今日（JST）」当日
    const overdueEquipment = await mkEquipment("SCH-DUE-E"); // 3日前で既に超過
    const retiredVehicle = await mkVehicle("SCH-DUE-W"); // 廃止（status='廃止'）
    const archivedEquipment = await mkEquipment("SCH-DUE-E2"); // 停止（archived_at）

    // --- 期限の設定（API-56。version=0で未作成行のINSERT。docs/05 §2） ---
    const D = todayJst;
    const putSchedule = async (type: "vehicle" | "equipment", id: string, version: number, nextDueDate: string, intervalDays?: number) => {
      const res = await fx.client(admin).request("PUT", `/api/v1/assets/${type}/${id}/inspection-schedule`, {
        version, nextDueDate, timezone: "Asia/Tokyo", ...(intervalDays ? { intervalDays } : {}),
      }, idem());
      return { res, body: (await json(res)).data as { id: string; version: number; target: { type: string; id: string }; nextDueDate: string; intervalDays: number | null; timezone: string } | undefined };
    };
    const v1 = await putSchedule("vehicle", vehicle, 0, D, 365);
    expect(v1.res.status).toBe(201);
    expect(v1.body).toMatchObject({ version: 1, target: { type: "vehicle", id: vehicle }, nextDueDate: D, intervalDays: 365, timezone: "Asia/Tokyo" });
    expect((await putSchedule("equipment", overdueEquipment, 0, shiftDays(D, -3), 30)).res.status).toBe(201);
    expect((await putSchedule("vehicle", retiredVehicle, 0, shiftDays(D, -5), 30)).res.status).toBe(201);
    expect((await putSchedule("equipment", archivedEquipment, 0, shiftDays(D, -5))).res.status).toBe(201);

    // 停止資産を先に作っておく（1台はAPIの廃止＝status側、1台はarchived_at側。docs/14 D24の両建て）
    const retire = await fx.client(admin).request("PATCH", `/api/v1/vehicles/${retiredVehicle}`, { version: 1, status: "廃止" }, idem());
    expect(retire.status).toBe(200);
    await env.DB.prepare("UPDATE equipment SET archived_at = ? WHERE id = ?").bind(`${D}T00:00:00.000Z`, archivedEquipment).run();

    // --- JST暦日の境界（D06。期限当日23:59は未超過、翌日00:00で超過） ---
    // JST=D日23:59 は UTC=D日14:59、JST=D+1日00:00 は UTC=D日15:00
    const onDueIso = `${D}T14:59:00.000Z`;
    const onNextIso = `${D}T15:00:00.000Z`;
    const onDueDate = isOverdue(D, onDueIso, "Asia/Tokyo");
    const onNextDate = isOverdue(D, onNextIso, "Asia/Tokyo");
    expect(onDueDate).toBe(false);
    expect(onNextDate).toBe(true);

    // 検出レベルでも同じ: 期限当日の検出では当日期限の行は記録されない（既に超過の1件だけ）
    const jobsBefore = ((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>())!.n);
    const r1 = await detectDueInspections(env, onDueIso);
    expect(r1.detected).toBe(1); // 既超過のEだけ（Vは当日未超過、W/E2は停止でskip）
    expect(r1.recorded).toBe(1);
    expect(await detectionRows(vehicle)).toHaveLength(0);

    // 翌日00:00（JST）の検出で当日期限だったVが超過になる
    const r2 = await detectDueInspections(env, onNextIso);
    expect(r2.detected).toBe(2); // V（当日→翌日で超過）とE
    const vRows = await detectionRows(vehicle);
    expect(vRows).toHaveLength(1);
    expect(vRows[0]).toMatchObject({ schedule_version: 1, due_date: D, target_type: "vehicle", actor_kind: "system" });

    // --- 同Cron2回: 再実行で重複作成しない（UNIQUE(対象,予定版,期限)＋ON CONFLICT DO NOTHING） ---
    const r3 = await detectDueInspections(env, onNextIso);
    expect(r3.recorded).toBe(0);
    expect(await detectionRows(vehicle)).toHaveLength(1);
    expect(await detectionRows(overdueEquipment)).toHaveLength(1);

    // --- 周期変更: 予定版が変われば新しい鍵として記録される（旧版の行は残す。追記型） ---
    const v2 = await putSchedule("vehicle", vehicle, 1, D, 180);
    expect(v2.res.status).toBe(200);
    expect(v2.body!.version).toBe(2);
    const r4 = await detectDueInspections(env, onNextIso);
    expect(r4.detected).toBe(2); // V（新版v2）とE
    const vRowsAfterChange = await detectionRows(vehicle);
    // 対象×予定版×期限日ごとに必ず1行（detectionEffectsPerTargetAndDate=1）
    const detectionKeys = vRowsAfterChange.map((r) => `${r.schedule_version}:${r.due_date}`);
    expect(detectionKeys).toEqual(["1:" + D, "2:" + D]);
    expect(new Set(detectionKeys).size).toBe(detectionKeys.length);

    // 停止資産はどの検出でも記録されない（status='廃止'／archived_at の両経路）
    expect(await detectionRows(retiredVehicle)).toHaveLength(0);
    expect(await detectionRows(archivedEquipment)).toHaveLength(0);

    // --- AIは呼ばない（検出はSELECT＋重複排除INSERTのみ。jobs/評価表に何も作らない） ---
    const jobsAfter = ((await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>())!.n);
    const aiCalls = jobsAfter - jobsBefore;
    expect(aiCalls).toBe(0);
  });

  it("schedule_put_validates_input_and_detail_and_lists_show_due", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const member = a.people.member; // PER-01のみ（点検期限の設定はPER-03）
    const D = todayJst;

    const mkVehicle = async (code: string) => {
      const res = await fx.client(admin).request("POST", "/api/v1/vehicles", { assetCode: code, name: `架空車両 ${code}`, status: "運用" }, idem());
      expect(res.status).toBe(201);
      return ((await json(res)).data! as { id: string }).id;
    };
    const vehicle = await mkVehicle("SCH-API-V");
    const putUrl = `/api/v1/assets/vehicle/${vehicle}/inspection-schedule`;

    // 権限: PER-03が必要（一般団員は403）
    const byMember = await fx.client(member).request("PUT", putUrl, { version: 0, nextDueDate: D, timezone: "Asia/Tokyo" }, idem());
    expect(byMember.status).toBe(403);

    // 別unit/存在しない対象は404（存在を明かさない）
    const otherUnit = await fx.client(fx.units.b.people.admin).request("PUT", putUrl, { version: 0, nextDueDate: D, timezone: "Asia/Tokyo" }, idem());
    expect(otherUnit.status).toBe(404);
    const unknown = await fx.client(admin).request("PUT", `/api/v1/assets/vehicle/${crypto.randomUUID()}/inspection-schedule`, { version: 0, nextDueDate: D, timezone: "Asia/Tokyo" }, idem());
    expect(unknown.status).toBe(404);

    // 未作成なのにversion=1は409（docs/05 §2「未作成PUTは0を指定」）
    const staleCreate = await fx.client(admin).request("PUT", putUrl, { version: 1, nextDueDate: D, timezone: "Asia/Tokyo" }, idem());
    expect(staleCreate.status).toBe(409);
    expect((await json(staleCreate)).error?.code).toBe("VERSION_CONFLICT");

    // 業務日のタイムゾーンはAsia/Tokyo固定（D06。他は400）
    const badTz = await fx.client(admin).request("PUT", putUrl, { version: 0, nextDueDate: D, timezone: "UTC" }, idem());
    expect(badTz.status).toBe(400);
    expect((await json(badTz)).error?.code).toBe("VALIDATION_ERROR");

    // 作成（201）と同じ鍵の再送（docs/05 §2。保存済み応答）
    const replayKey = { "idempotency-key": crypto.randomUUID() };
    const first = await fx.client(admin).request("PUT", putUrl, { version: 0, nextDueDate: shiftDays(D, 30), intervalDays: 90, timezone: "Asia/Tokyo" }, replayKey);
    expect(first.status).toBe(201);
    const firstBody = (await json(first)).data as Record<string, unknown>;
    expect(firstBody).toMatchObject({ version: 1, target: { type: "vehicle", id: vehicle }, nextDueDate: shiftDays(D, 30), intervalDays: 90, timezone: "Asia/Tokyo" });
    const replay = await fx.client(admin).request("PUT", putUrl, { version: 0, nextDueDate: shiftDays(D, 30), intervalDays: 90, timezone: "Asia/Tokyo" }, replayKey);
    expect(replay.status).toBe(201);
    expect((await json(replay)).data).toEqual(firstBody);

    // 更新（200）と旧版409
    const update = await fx.client(admin).request("PUT", putUrl, { version: 1, nextDueDate: shiftDays(D, 60), timezone: "Asia/Tokyo" }, idem());
    expect(update.status).toBe(200);
    expect(((await json(update)).data as { version: number }).version).toBe(2);
    const oldVersion = await fx.client(admin).request("PUT", putUrl, { version: 1, nextDueDate: shiftDays(D, 90), timezone: "Asia/Tokyo" }, idem());
    expect(oldVersion.status).toBe(409);
    expect((await json(oldVersion)).error?.code).toBe("VERSION_CONFLICT");

    // 資産詳細（API-51）に点検期限が載る（現在値＋超過判定。docs/05 API-51）
    const detail = await fx.client(admin).request("GET", `/api/v1/assets/vehicle/${vehicle}`);
    expect(detail.status).toBe(200);
    expect(((await json(detail)).data as { inspectionDue: { nextDueDate: string | null; overdue: boolean } }).inspectionDue)
      .toEqual({ nextDueDate: shiftDays(D, 60), overdue: false });

    // 期限を過ぎていれば超過（JST暦日で比較。当日は未超過）
    const overduePut = await fx.client(admin).request("PUT", putUrl, { version: 2, nextDueDate: shiftDays(D, -1), timezone: "Asia/Tokyo" }, idem());
    expect(overduePut.status).toBe(200);
    const overdueDetail = await fx.client(admin).request("GET", `/api/v1/assets/vehicle/${vehicle}`);
    expect(((await json(overdueDetail)).data as { inspectionDue: { nextDueDate: string | null; overdue: boolean } }).inspectionDue)
      .toEqual({ nextDueDate: shiftDays(D, -1), overdue: true });

    // schedule未設定の資産は null/false（0件と未設定を混同しない）
    const equipment = await (async () => {
      const res = await fx.client(admin).request("POST", "/api/v1/equipment", { assetCode: "SCH-API-E", name: "架空機材 SCH-API-E", quantity: 2, quantityUnit: "本", storage: { note: "詰所" } }, idem());
      expect(res.status).toBe(201);
      return ((await json(res)).data! as { id: string }).id;
    })();
    const noSchedule = await fx.client(admin).request("GET", `/api/v1/assets/equipment/${equipment}`);
    expect(((await json(noSchedule)).data as { inspectionDue: { nextDueDate: string | null; overdue: boolean } }).inspectionDue)
      .toEqual({ nextDueDate: null, overdue: false });

    // 一覧のdue=overdue（API-18/19。廃止資産は外れる。docs/05 API-18/19行）
    const retired = await mkVehicle("SCH-API-W");
    await fx.client(admin).request("PUT", `/api/v1/assets/vehicle/${retired}/inspection-schedule`, { version: 0, nextDueDate: shiftDays(D, -2), timezone: "Asia/Tokyo" }, idem());
    await fx.client(admin).request("PATCH", `/api/v1/vehicles/${retired}`, { version: 1, status: "廃止" }, idem());
    const listRes = await fx.client(admin).request("GET", "/api/v1/vehicles?due=overdue&limit=200");
    expect(listRes.status).toBe(200);
    const overdueIds = (((await json(listRes)).data ?? []) as unknown as { id: string }[]).map((r) => r.id);
    expect(overdueIds).toContain(vehicle);
    expect(overdueIds).not.toContain(retired);
  });
});
