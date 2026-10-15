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
  (await r.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: { field: string; reason: string }[] } };

type AttendanceData = { id: string; version: number; memberId: string; response: string; respondedAt: string | null };

describe("本人・許可代理の出欠 (T036)", () => {
  it("old_attendance_retry_cannot_undo_later_answer", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 管理者（PER-03。対象snapshotには含めない）
    const officer = a.people.officer; // 幹部（対象者。後に代理scopeを受け取る）
    const member = a.people.member; // 一般団員（対象者。本人回答）
    const operator = a.people.operator; // 担当者（scopeは施設のみ。出欠の代理scopeは無い）
    const otherUnitMember = fx.units.b.people.member;

    // --- 対象者付きの予定を作成して公開（API-06/39。docs/11 出欠は「受付中のみ」） ---
    const audienceIds = [officer.memberId!, member.memberId!, operator.memberId!];
    const createRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "秋季の水防訓練",
      kind: "訓練",
      plannedStartsAt: "2099-10-20T01:00:00.000Z",
      locationText: "架空市堤防",
      ownerMemberId: officer.memberId!,
      audienceMemberIds: audienceIds,
      responseDueAt: "2098-01-01T00:00:00.000Z",
    }, idem());
    expect(createRes.status).toBe(201);
    const activityId = ((await json(createRes)).data! as { id: string }).id;
    expect((await fx.client(admin).request("PATCH", `/api/v1/activities/${activityId}`, {
      version: 1, status: "scheduled", reason: "対象を確定して公開",
    }, idem())).status).toBe(200);

    const me = (version: number, response: string) => ({ version, response });

    // --- 本人の初回回答: 未回答→参加（未作成PUTはversion=0でINSERT。docs/05 §2） ---
    const firstKey = crypto.randomUUID();
    const firstPut = await fx.client(member).request("PUT", `/api/v1/activities/${activityId}/attendance/me`, me(0, "attending"), { "idempotency-key": firstKey });
    expect(firstPut.status).toBe(201);
    const firstData = (await json(firstPut)).data! as AttendanceData;
    expect(firstData).toMatchObject({ memberId: member.memberId, response: "attending", version: 1 });
    expect(firstData.respondedAt).not.toBeNull();

    // 幹部も自分の行へ回答する（他の対象者の行はまだ無い）
    expect((await fx.client(officer).request("PUT", `/api/v1/activities/${activityId}/attendance/me`, me(0, "attending"), idem())).status).toBe(201);

    // --- 参加→未定への変更（version一致。未定は未回答と別） ---
    const secondPut = await fx.client(member).request("PUT", `/api/v1/activities/${activityId}/attendance/me`, me(1, "undecided"), idem());
    expect(secondPut.status).toBe(200);
    expect(((await json(secondPut)).data! as AttendanceData).version).toBe(2);

    // --- 未回答=audience差分（回答レコードが無い対象者。docs/11 出欠行。DB参照と詳細APIの両方で観測） ---
    const detail = (await json(await fx.client(admin).request("GET", `/api/v1/activities/${activityId}`))).data! as {
      audience: string[]; attendance: { memberId: string; response: string }[];
    };
    const rowsSoFar = await fx.rows("activity_attendance", { activity_id: activityId });
    const unansweredIds = audienceIds
      .filter((id) => !rowsSoFar.some((r) => r.member_id === id && r.response !== "unanswered"))
      .sort();
    const respondedFromApi = detail.attendance.filter((r) => r.response !== "unanswered").map((r) => r.memberId);
    const audienceMinusResponded = detail.audience.filter((id) => !respondedFromApi.includes(id)).sort();
    expect(unansweredIds).toEqual(audienceMinusResponded);
    expect(unansweredIds).toEqual([operator.memberId!]);

    // --- 最初のPUT（参加, version=0）を遅延再送: 元の応答を返すが現在状態を戻さない（docs/05 §2） ---
    const beforeReplay = (await fx.rows("activity_attendance", { activity_id: activityId, member_id: member.memberId! }))[0]!;
    const replay = await fx.client(member).request("PUT", `/api/v1/activities/${activityId}/attendance/me`, me(0, "attending"), { "idempotency-key": firstKey });
    expect(replay.status).toBe(201); // 元の応答（参加, version 1）
    expect((await json(replay)).data).toEqual(firstData as unknown as Record<string, unknown>);
    const afterReplay = (await fx.rows("activity_attendance", { activity_id: activityId, member_id: member.memberId! }))[0]!;
    const currentResponse = afterReplay.response as string;
    expect(currentResponse).toBe("undecided"); // 未定の回答が残る
    const oldReplayChangedCurrent =
      beforeReplay.version !== afterReplay.version ||
      beforeReplay.response !== afterReplay.response ||
      beforeReplay.updated_at !== afterReplay.updated_at;
    expect(oldReplayChangedCurrent).toBe(false);

    // --- 同じversionの2端末: 一方だけ成功し、他方は409 VERSION_CONFLICT（docs/05 §2・CT-03） ---
    expect((await fx.client(member).request("PUT", `/api/v1/activities/${activityId}/attendance/me`, me(2, "attending"), idem())).status).toBe(200);
    const losingDevice = await fx.client(member).request("PUT", `/api/v1/activities/${activityId}/attendance/me`, me(2, "absent"), idem());
    expect(losingDevice.status).toBe(409);
    expect((await json(losingDevice)).error?.code).toBe("VERSION_CONFLICT");

    // --- 対象者以外: 対象snapshotに無い同分団の団員と、別分団（存在も明かさない404） ---
    const notAudience = await fx.client(admin).request("PUT", `/api/v1/activities/${activityId}/attendance/me`, me(0, "attending"), idem());
    expect(notAudience.status).toBe(404);
    const fromOtherUnit = await fx.client(otherUnitMember).request("PUT", `/api/v1/activities/${activityId}/attendance/me`, me(0, "attending"), idem());
    expect(fromOtherUnit.status).toBe(404);

    // --- 代理: 代理scopeが無い本人以外の操作は403（docs/10 PER-02「代理はD05で別付与」） ---
    const unauthorizedProxy = await fx.client(operator).request("PUT", `/api/v1/activities/${activityId}/attendance/${member.memberId}`, {
      version: 3, response: "absent", reason: "代理の理由",
    }, idem());
    expect(unauthorizedProxy.status).toBe(403);

    // 代理の理由なしは入力検査（契約のreason必須）で400
    const noReasonProxy = await fx.client(officer).request("PUT", `/api/v1/activities/${activityId}/attendance/${member.memberId}`, {
      version: 3, response: "absent",
    }, idem());
    expect(noReasonProxy.status).toBe(400);

    // --- D05の代理scope（entity_type='member'×PER-02）を幹部へ付与 → 理由付きの代理は成功 ---
    await env.DB.prepare(
      "INSERT INTO scope_assignments (id, unit_id, member_id, entity_type, entity_id, permissions, created_at, updated_at, created_by, actor_kind) " +
        "VALUES (?, ?, ?, 'member', ?, ?, ?, ?, ?, 'human')",
    ).bind(
      crypto.randomUUID(), a.id, officer.memberId, member.memberId, JSON.stringify(["PER-02"]),
      new Date().toISOString(), new Date().toISOString(), admin.userId,
    ).run();
    const proxy = await fx.client(officer).request("PUT", `/api/v1/activities/${activityId}/attendance/${member.memberId}`, {
      version: 3, response: "absent", reason: "出張のため幹部が代理入力",
    }, idem());
    expect(proxy.status).toBe(200);
    expect((await json(proxy)).data).toMatchObject({ memberId: member.memberId, response: "absent", version: 4 });

    // --- 回答の取り下げ: response=unanswered（docs/05 §1「unansweredも受け付ける」。未定とは別） ---
    const withdraw = await fx.client(member).request("PUT", `/api/v1/activities/${activityId}/attendance/me`, me(4, "unanswered"), idem());
    expect(withdraw.status).toBe(200);
    expect((await json(withdraw)).data).toMatchObject({ memberId: member.memberId, response: "unanswered", version: 5 });

    // --- 締切後の変更は422。ただし同キー再送は元結果のまま（現在状態を戻さない） ---
    expect((await fx.client(admin).request("PATCH", `/api/v1/activities/${activityId}`, {
      version: 2, responseDueAt: "2000-01-01T00:00:00.000Z", reason: "回答締切を前倒し",
    }, idem())).status).toBe(200);
    const afterDue = await fx.client(member).request("PUT", `/api/v1/activities/${activityId}/attendance/me`, me(5, "attending"), idem());
    expect(afterDue.status).toBe(422);
    expect((await json(afterDue)).error?.code).toBe("INVALID_TRANSITION");
    const replayAfterDue = await fx.client(member).request("PUT", `/api/v1/activities/${activityId}/attendance/me`, me(0, "attending"), { "idempotency-key": firstKey });
    expect(replayAfterDue.status).toBe(201); // 元の応答のまま
    const finalRow = (await fx.rows("activity_attendance", { activity_id: activityId, member_id: member.memberId! }))[0]!;
    expect(finalRow.version).toBe(5); // 再送で状態は動いていない
    expect(finalRow.response).toBe("unanswered");

    // --- 履歴と記録: attendance_eventsに本人/代理の区別と代理理由。監査・outboxは成功ごとに1件 ---
    const memberRow = (await fx.rows("activity_attendance", { activity_id: activityId, member_id: member.memberId! }))[0]!;
    const memberEvents = (
      await env.DB.prepare("SELECT response, proxy_for_member_id, reason FROM attendance_events WHERE attendance_id = ? ORDER BY rowid")
        .bind(memberRow.id).all<Record<string, unknown>>()
    ).results;
    expect(memberEvents.map((e) => e.response)).toEqual(["attending", "undecided", "attending", "absent", "unanswered"]);
    expect(memberEvents[3]).toMatchObject({ proxy_for_member_id: member.memberId, reason: "出張のため幹部が代理入力" });
    expect(memberEvents.filter((e) => e.proxy_for_member_id === null)).toHaveLength(4); // 本人回答はNULL
    expect(await fx.rows("audit_logs", { entity_type: "activity_attendance", entity_id: memberRow.id as string })).toHaveLength(5);
    expect(await fx.rows("domain_events", { entity_type: "activity_attendance", entity_id: memberRow.id as string })).toHaveLength(5);
  });

  it("proxy_reason_is_capped_at_2000_chars (docs/05 §1)", async () => {
    // 代理回答（API-41）の理由はattendance_events.reason（DBのCHECK 1〜2000）に揃える。
    // 共通上限のまま通すとDBのCHECKで500になるため、超過は入力で400にする
    const a = fx.units.a;
    const admin = a.people.admin;
    const officer = a.people.officer;
    const member = a.people.member;

    const createRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "理由上限試験用の予定",
      kind: "訓練",
      plannedStartsAt: "2099-11-05T01:00:00.000Z",
      locationText: "架空市第五集会所",
      ownerMemberId: admin.memberId!,
      audienceMemberIds: [member.memberId!, officer.memberId!],
    }, idem());
    expect(createRes.status).toBe(201);
    const activityId = ((await json(createRes)).data! as { id: string }).id;
    // 出欠の受付は公開済（scheduled）のみ（docs/11 出欠）
    expect((await fx.client(admin).request("PATCH", `/api/v1/activities/${activityId}`, {
      version: 1, status: "scheduled", reason: "対象を確定して公開",
    }, idem())).status).toBe(200);

    // D05の代理scope（entity_type='member'×PER-02）を幹部へ付与（attendance T036と同じ流儀。
    // 同じテーブルを他の試験も使うため、既に付与済みのときは無視する）
    await env.DB.prepare(
      "INSERT OR IGNORE INTO scope_assignments (id, unit_id, member_id, entity_type, entity_id, permissions, created_at, updated_at, created_by, actor_kind) " +
        "VALUES (?, ?, ?, 'member', ?, ?, ?, ?, ?, 'human')",
    ).bind(
      crypto.randomUUID(), a.id, officer.memberId, member.memberId, JSON.stringify(["PER-02"]),
      new Date().toISOString(), new Date().toISOString(), admin.userId,
    ).run();

    // 2,001字の理由は400 VALIDATION_ERROR（DBの500経路に通さない）
    const tooLong = await fx.client(officer).request("PUT", `/api/v1/activities/${activityId}/attendance/${member.memberId}`, {
      version: 0, response: "attending", reason: "あ".repeat(2001),
    }, idem());
    expect(tooLong.status).toBe(400);
    expect((await json(tooLong)).error?.code).toBe("VALIDATION_ERROR");

    // 2,000字ちょうどは検査を通る（未作成→参加の201）
    const ok2000 = await fx.client(officer).request("PUT", `/api/v1/activities/${activityId}/attendance/${member.memberId}`, {
      version: 0, response: "attending", reason: "い".repeat(2000),
    }, idem());
    expect(ok2000.status).toBe(201);
  });
});
