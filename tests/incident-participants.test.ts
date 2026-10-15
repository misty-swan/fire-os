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
const json = async (r: Response) =>
  (await r.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: { field: string; reason: string }[] } };

type ParticipantData = {
  id: string; version: number; memberId: string; attendanceStatus: string;
  mobilizedAt: string | null; arrivedAt: string | null; returnedAt: string | null;
};

describe("参集・到着・帰還の本人/代理記録 (T041)", () => {
  it("returned_status_preserves_unknown_arrival_time", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 管理者（PER-04: 幹部・管理者は所属内。ただし代理入力にはmember×PER-04のscopeが要る）
    const member = a.people.member; // 一般団員（PER-04は本人分のみ→自分の参集を記録できる）
    const officer = a.people.officer; // 幹部（事後入力の対象団員。到着時刻が不明のまま帰還を記録）
    const operator = a.people.operator; // 担当者（scopeは施設のみ）
    const otherUnit = fx.units.b.people.admin; // 別分団（存在も明かさない）

    // --- 出動を1件登録（API-22、T040） ---
    const createRes = await fx.client(admin).request("POST", "/api/v1/incidents", {
      kind: "training", occurredAt: "2026-10-10T22:00:00.000Z", summary: "架橋地区での墜落警報訓練（参集記録の試験用・架空）",
    }, idem());
    expect(createRes.status).toBe(201);
    const incidentId = ((await json(createRes)).data! as { id: string }).id;

    const put = (who: Identity, targetMemberId: string, body: Record<string, unknown>, headers = idem()) =>
      fx.client(who).request("PUT", `/api/v1/incidents/${incidentId}/participants/${targetMemberId}`, body, headers);

    // --- 本人の参集（初回はversion=0でINSERT。docs/05 §2「未作成PUTは0を指定してINSERT UNIQUEをガード」） ---
    const firstKey = crypto.randomUUID();
    const mobilizedRes = await put(member, member.memberId!, {
      version: 0, attendanceStatus: "mobilizing", times: { mobilizedAt: "2026-10-10T22:10:00.000Z" },
    }, { "idempotency-key": firstKey });
    expect(mobilizedRes.status).toBe(201);
    const mobilizedData = (await json(mobilizedRes)).data! as unknown as ParticipantData;
    expect(mobilizedData).toMatchObject({ memberId: member.memberId, attendanceStatus: "mobilizing", version: 1 });

    // --- 到着（mobilizing→arrived。timesに無い既知の時刻は残す。docs/11「事後入力では欠落時刻を捏造しない」） ---
    const arrivedRes = await put(member, member.memberId!, {
      version: 1, attendanceStatus: "arrived", times: { arrivedAt: "2026-10-10T22:25:00.000Z" },
    });
    expect(arrivedRes.status).toBe(200);
    expect((await json(arrivedRes)).data).toMatchObject({
      attendanceStatus: "arrived", version: 2,
      mobilizedAt: "2026-10-10T22:10:00.000Z", arrivedAt: "2026-10-10T22:25:00.000Z",
    });

    // --- 帰還（arrived→returned。既知時刻はすべて残る） ---
    const returnedRes = await put(member, member.memberId!, {
      version: 2, attendanceStatus: "returned", times: { returnedAt: "2026-10-10T23:30:00.000Z" },
    });
    expect(returnedRes.status).toBe(200);
    const returned = (await json(returnedRes)).data! as unknown as ParticipantData;
    // 検収（ブリーフのassertion）: 帰還は帰還記録で、出欠のabsentや実参加のabsentとは別（docs/11 参集/帰還行）
    expect(returned.attendanceStatus).toBe("returned");
    expect(returned).toMatchObject({
      version: 3,
      mobilizedAt: "2026-10-10T22:10:00.000Z", arrivedAt: "2026-10-10T22:25:00.000Z", returnedAt: "2026-10-10T23:30:00.000Z",
    });

    // --- 変更点がない送信は400（API-69と同じ扱い） ---
    const noChange = await put(member, member.memberId!, { version: 3, attendanceStatus: "returned" });
    expect(noChange.status).toBe(400);
    expect((await json(noChange)).error?.code).toBe("VALIDATION_ERROR");

    // --- 代理scopeなしの他人記録は403（docs/10 PER-04「代理入力・他人の時刻はD05/D08」。
    // 幹部・管理者の役割だけでは開かない。attendance T036と同じ流儀） ---
    const adminNoScope = await put(admin, officer.memberId!, {
      version: 0, attendanceStatus: "returned", times: { returnedAt: "2026-10-10T23:40:00.000Z" }, reason: "代理の試験",
    });
    expect(adminNoScope.status).toBe(403);
    expect((await json(adminNoScope)).error?.details).toMatchObject([{ field: "permission", reason: "scope_required" }]);
    const memberNoScope = await put(member, officer.memberId!, { version: 0, attendanceStatus: "returned" });
    expect(memberNoScope.status).toBe(403);

    // --- D08の代理scope（entity_type='member'×PER-04）を管理者へ付与 → 事後の帰還だけを記録 ---
    await env.DB.prepare(
      "INSERT INTO scope_assignments (id, unit_id, member_id, entity_type, entity_id, permissions, created_at, updated_at, created_by, actor_kind) " +
        "VALUES (?, ?, ?, 'member', ?, ?, ?, ?, ?, 'human')",
    ).bind(
      crypto.randomUUID(), a.id, admin.memberId, officer.memberId, JSON.stringify(["PER-04"]),
      new Date().toISOString(), new Date().toISOString(), admin.userId,
    ).run();
    // 到着時刻は不明のまま（NULLで保持。捏造しない）。unconfirmed→returnedはdocs/11の許可辺
    const postReturned = await put(admin, officer.memberId!, {
      version: 0, attendanceStatus: "returned", times: { returnedAt: "2026-10-10T23:40:00.000Z" }, reason: "後日の聞き取りで代理入力",
    });
    expect(postReturned.status).toBe(201);
    const unknownArrival = (await json(postReturned)).data! as unknown as ParticipantData;
    // 検収（ブリーフのassertion）: 事後入力でも到着時刻はNULLのまま
    expect(unknownArrival.arrivedAt).toBeNull();
    expect(unknownArrival.mobilizedAt).toBeNull();
    expect(unknownArrival).toMatchObject({ memberId: officer.memberId, attendanceStatus: "returned", version: 1 });

    // --- 逆順の時刻は400（docs/04:96「既知時刻の順序」。両方既知の組だけ検査）。
    // 到着23:50は既記録の帰還23:40より後になるため不可 ---
    const reverseTime = await put(admin, officer.memberId!, {
      version: 1, attendanceStatus: "returned", times: { arrivedAt: "2026-10-10T23:50:00.000Z" }, reason: "到着時刻の事後入力",
    });
    // 検収（ブリーフのassertion）
    expect(reverseTime.status).toBe(400);
    expect((await json(reverseTime)).error?.code).toBe("VALIDATION_ERROR");

    // 理由なしの代理訂正は契約どおり任意で通る（D08未決のため実装側で追加制限しない）
    const noReason = await put(admin, officer.memberId!, {
      version: 1, attendanceStatus: "returned", times: { returnedAt: "2026-10-10T23:42:00.000Z" },
    });
    expect(noReason.status).toBe(200);
    expect((await json(noReason)).data).toMatchObject({ attendanceStatus: "returned", version: 2, arrivedAt: null });

    // --- 同じversionの並行: 一方だけ成功し、他方は409。負け側はイベントも増やさない（CT-03/04） ---
    const winRes = await put(member, member.memberId!, {
      version: 3, attendanceStatus: "returned", times: { returnedAt: "2026-10-10T23:35:00.000Z" }, reason: "帰還時刻の訂正",
    });
    expect(winRes.status).toBe(200);
    expect((await json(winRes)).data).toMatchObject({ version: 4, returnedAt: "2026-10-10T23:35:00.000Z" });

    const memberRow = (await fx.rows("incident_participants", { incident_id: incidentId, member_id: member.memberId! }))[0]!;
    const countEvents = async () =>
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM incident_participant_events WHERE participant_id = ?").bind(memberRow.id)
        .first<{ n: number }>())!.n;
    const eventsBeforeConflict = await countEvents();
    const losing = await put(member, member.memberId!, {
      version: 3, attendanceStatus: "returned", times: { returnedAt: "2026-10-10T23:45:00.000Z" }, reason: "並行送信の負け側",
    });
    expect(losing.status).toBe(409);
    expect((await json(losing)).error?.code).toBe("VERSION_CONFLICT");
    // 検収（ブリーフのassertion）: 競合で負けた側の変更・履歴は残らない（docs/05 §2）
    const eventsAfterConflict = await countEvents();
    expect(eventsAfterConflict).toBe(eventsBeforeConflict);

    // --- 旧再送: 最初のPUT（mobilizing, version=0）を同じキーで遅延再送。元の応答を返し現在状態を戻さない（docs/05 §2） ---
    const replay = await put(member, member.memberId!, {
      version: 0, attendanceStatus: "mobilizing", times: { mobilizedAt: "2026-10-10T22:10:00.000Z" },
    }, { "idempotency-key": firstKey });
    expect(replay.status).toBe(201);
    expect((await json(replay)).data).toEqual(mobilizedData as unknown as Record<string, unknown>);
    const afterReplay = (await fx.rows("incident_participants", { incident_id: incidentId, member_id: member.memberId! }))[0]!;
    expect(afterReplay.version).toBe(4); // 帰還＋訂正のまま（再送で状態は動かない）
    expect(afterReplay.attendance_status).toBe("returned");
    expect(await countEvents()).toBe(eventsAfterConflict); // 再送・競合でイベントは増えない

    // --- 行ありにversion=0は旧版の409（docs/05 §2「既存rowはversion必須」） ---
    const staleZero = await put(member, member.memberId!, { version: 0, attendanceStatus: "returned" });
    expect(staleZero.status).toBe(409);

    // --- returnedは終端（docs/11「arrived→returned、returnedは終端」） ---
    const fromReturned = await put(member, member.memberId!, { version: 4, attendanceStatus: "arrived" });
    expect(fromReturned.status).toBe(422);
    expect((await json(fromReturned)).error?.code).toBe("INVALID_TRANSITION");

    // --- unconfirmedは行が無いことで表現する初期値。docs/11の辺に書く辺が無いため作れない ---
    await env.DB.prepare(
      "INSERT INTO scope_assignments (id, unit_id, member_id, entity_type, entity_id, permissions, created_at, updated_at, created_by, actor_kind) " +
        "VALUES (?, ?, ?, 'member', ?, ?, ?, ?, ?, 'human')",
    ).bind(
      crypto.randomUUID(), a.id, admin.memberId, operator.memberId, JSON.stringify(["PER-04"]),
      new Date().toISOString(), new Date().toISOString(), admin.userId,
    ).run();
    const asUnconfirmed = await put(admin, operator.memberId!, {
      version: 0, attendanceStatus: "unconfirmed", reason: "未確認のまま行は作らない",
    });
    expect(asUnconfirmed.status).toBe(422);
    expect((await json(asUnconfirmed)).error?.code).toBe("INVALID_TRANSITION");

    // --- 存在しない/別分団の団員と、別分団から見た出動は同じ404（存在を明かさない） ---
    const ghost = await put(admin, crypto.randomUUID(), { version: 0, attendanceStatus: "mobilizing" });
    expect(ghost.status).toBe(404);
    const otherUnitMember = await put(admin, fx.units.b.people.member.memberId!, { version: 0, attendanceStatus: "mobilizing" });
    expect(otherUnitMember.status).toBe(404);
    const fromOtherUnit = await fx.client(otherUnit).request(
      "PUT", `/api/v1/incidents/${incidentId}/participants/${fx.units.b.people.member.memberId}`,
      { version: 0, attendanceStatus: "mobilizing" }, idem(),
    );
    expect(fromOtherUnit.status).toBe(404);

    // --- 履歴（incident_participant_events。docs/04:97「代理入力者/訂正保持」。失敗した変更は残らない） ---
    const officerRow = (await fx.rows("incident_participants", { incident_id: incidentId, member_id: officer.memberId! }))[0]!;
    const officerEvents = (
      await env.DB.prepare(
        "SELECT before_json, after_json, reason, actor_user_id FROM incident_participant_events WHERE participant_id = ? ORDER BY rowid",
      ).bind(officerRow.id).all<Record<string, unknown>>()
    ).results;
    expect(officerEvents).toHaveLength(2); // 事後帰還＋理由なし訂正（403/400/422の試行は残らない）
    expect(officerEvents[0]).toMatchObject({ reason: "後日の聞き取りで代理入力", actor_user_id: admin.userId });
    expect(JSON.parse(String(officerEvents[0]!.before_json))).toEqual({
      attendanceStatus: "unconfirmed", mobilizedAt: null, arrivedAt: null, returnedAt: null,
    });
    expect(JSON.parse(String(officerEvents[0]!.after_json))).toMatchObject({
      attendanceStatus: "returned", returnedAt: "2026-10-10T23:40:00.000Z", proxyFor: officer.memberId,
    });
    expect(officerEvents[1]).toMatchObject({ reason: null, actor_user_id: admin.userId }); // 代理の理由は任意

    const memberEvents = (
      await env.DB.prepare(
        "SELECT after_json, reason FROM incident_participant_events WHERE participant_id = ? ORDER BY rowid",
      ).bind(memberRow.id).all<{ after_json: string; reason: string | null }>()
    ).results;
    expect(memberEvents.map((e) => JSON.parse(e.after_json).attendanceStatus)).toEqual([
      "mobilizing", "arrived", "returned", "returned", // 参集→到着→帰還→帰還時刻の訂正
    ]);
    expect(memberEvents.map((e) => JSON.parse(e.after_json).proxyFor)).toEqual([null, null, null, null]); // 本人記録
    expect(memberEvents[3]!.reason).toBe("帰還時刻の訂正");
    expect(await fx.rows("audit_logs", { entity_type: "incident_participant", entity_id: memberRow.id as string })).toHaveLength(4);
    expect(await fx.rows("domain_events", { entity_type: "incident_participant", entity_id: memberRow.id as string })).toHaveLength(4);

    // --- 詳細（API-70）の参集一覧に実データが載る（T040で構造だけ用意だった箇所） ---
    const detail = (await json(await fx.client(admin).request("GET", `/api/v1/incidents/${incidentId}`))).data! as {
      participants: ParticipantData[];
    };
    expect(detail.participants).toHaveLength(2);
    expect(detail.participants.map((r) => r.memberId).sort()).toEqual([member.memberId!, officer.memberId!].sort());
    const memberInDetail = detail.participants.find((r) => r.memberId === member.memberId)!;
    expect(memberInDetail).toMatchObject({
      version: 4, attendanceStatus: "returned",
      mobilizedAt: "2026-10-10T22:10:00.000Z", arrivedAt: "2026-10-10T22:25:00.000Z", returnedAt: "2026-10-10T23:35:00.000Z",
    });
    const officerInDetail = detail.participants.find((r) => r.memberId === officer.memberId)!;
    expect(officerInDetail).toMatchObject({
      version: 2, attendanceStatus: "returned", mobilizedAt: null, arrivedAt: null, returnedAt: "2026-10-10T23:42:00.000Z",
    });
  });
});
