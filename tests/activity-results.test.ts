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

/** ready状態の添付を直接作る（リンク経路の確認用。検査jobの一式はattachments.test.tsの担当） */
async function seedReadyAttachment(
  unitId: string, ownerUserId: string, ownerMemberId: string, classification: "basic" | "sensitive",
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO attachments (id, unit_id, owner_user_id, owner_member_id, intent_target_type, intent_target_id, ready_key, content_type, byte_size, sha256, status, expires_at, classification, upload_token_hash, created_at, updated_at, created_by, actor_kind) " +
      "VALUES (?, ?, ?, ?, 'activity', ?, ?, 'image/png', 100, ?, 'ready', ?, ?, ?, ?, ?, ?, 'human')",
  ).bind(
    id, unitId, ownerUserId, ownerMemberId, crypto.randomUUID(), `ready/${id}`, "a".repeat(64),
    now, classification, "b".repeat(64), now, now, ownerUserId,
  ).run();
  return id;
}

type Participant = { memberId: string; actualStatus: string; individualStartsAt: string | null; individualEndsAt: string | null };
type RevisionData = {
  id: string; resultId: string; revisionNo: number;
  actualStartsAt: string | null; actualEndsAt: string | null; content: string;
  supersedesId: string | null; correctionReason: string | null;
  participants: Participant[]; createdAt: string;
};
type ResultData = {
  id: string; activityId: string; version: number; currentRevisionId: string;
  currentRevision: RevisionData; createdAt: string; updatedAt: string;
};

describe("活動実績・実参加・訂正版 (T037)", () => {
  it("actual_participants_do_not_follow_planned_attendance", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 管理者（PER-04は所属内）
    const officer = a.people.officer; // 幹部（予定の担当。PER-04は所属内）
    const member = a.people.member; // 一般団員（PER-04は本人分のみ。実績の記録は不可）
    const operator = a.people.operator; // 担当者（scopeは施設のみ。活動実績は担当外）

    // --- 予定を作成して公開（API-06/39。実績は予定と関連付くが別物。docs/04 §3.2） ---
    const audienceIds = [officer.memberId!, member.memberId!, operator.memberId!];
    const createRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "秋季の水防訓練",
      kind: "訓練",
      plannedStartsAt: "2026-10-20T01:00:00.000Z",
      plannedEndsAt: "2026-10-20T04:00:00.000Z",
      locationText: "架空市堤防",
      ownerMemberId: officer.memberId!,
      audienceMemberIds: audienceIds,
    }, idem());
    expect(createRes.status).toBe(201);
    const activityId = ((await json(createRes)).data! as { id: string }).id;
    expect((await fx.client(admin).request("PATCH", `/api/v1/activities/${activityId}`, {
      version: 1, status: "scheduled", reason: "対象を確定して公開",
    }, idem())).status).toBe(200);

    // 実績に触る前の予定の状態（実績作成・訂正は予定を一切変えないことの比較用。docs/11 §3「原本点検・実績版…UPDATEで書換えない」＋AT-ACT-03「予定不変」）
    const detailBefore = (await json(await fx.client(admin).request("GET", `/api/v1/activities/${activityId}`))).data! as {
      plannedStartsAt: string; plannedEndsAt: string | null; version: number; status: string;
      attendance: { memberId: string; response: string; version: number }[];
    };
    const plannedTimesBefore = {
      plannedStartsAt: detailBefore.plannedStartsAt,
      plannedEndsAt: detailBefore.plannedEndsAt,
      version: detailBefore.version,
      status: detailBefore.status,
    };

    // --- 出欠（API-08）。実参加とは別物であり、コピーしない（docs/11 実参加行） ---
    // 幹部=参加予定、団員=欠席予定。実績ではこの逆を記録する
    expect((await fx.client(officer).request("PUT", `/api/v1/activities/${activityId}/attendance/me`, {
      version: 0, response: "attending",
    }, idem())).status).toBe(201);
    expect((await fx.client(member).request("PUT", `/api/v1/activities/${activityId}/attendance/me`, {
      version: 0, response: "absent",
    }, idem())).status).toBe(201);

    // 実績に触る直前の出欠の状態（実績が出欠に影響しないことの比較用）
    const attendanceBefore = (
      (await json(await fx.client(admin).request("GET", `/api/v1/activities/${activityId}`))).data! as {
        attendance: { memberId: string; response: string; version: number }[];
      }
    ).attendance;

    // --- 実績の作成（API-09。未作成のみ）。終了時刻は不明のまま（NULLで保留。捏造しない） ---
    const createActual = await fx.client(admin).request("POST", `/api/v1/activities/${activityId}/actual-results`, {
      activityVersion: 2,
      content: "堤防の点検と水防訓練を実施。冒頭で安全管理を再確認。",
      actualStartsAt: "2026-10-20T01:10:00.000Z",
      participants: [
        // 予定参加（幹部）だが実欠席
        { memberId: officer.memberId!, actualStatus: "absent" },
        // 予定欠席（団員）だが実参加。個人時間は全体時間と別列（docs/04:93、D05）
        {
          memberId: member.memberId!, actualStatus: "participated",
          individualStartsAt: "2026-10-20T01:20:00.000Z", individualEndsAt: "2026-10-20T03:00:00.000Z",
        },
        // 未確認のまま（unconfirmed。docs/11 実参加の初期値）
        { memberId: operator.memberId!, actualStatus: "unconfirmed" },
      ],
      attachmentIds: [],
    }, idem());
    expect(createActual.status).toBe(201);
    const created = (await json(createActual)).data! as unknown as ResultData;
    expect(created.activityId).toBe(activityId);
    expect(created.version).toBe(1);
    expect(created.currentRevision.revisionNo).toBe(1);
    expect(created.currentRevision.resultId).toBe(created.id);
    expect(created.currentRevision.supersedesId).toBeNull(); // 初版に訂正元は無い
    expect(created.currentRevision.correctionReason).toBeNull();

    // 実参加者は入力どおり。出欠（attending=幹部）を実参加へコピーしていないことの検収
    const actualIds = created.currentRevision.participants
      .filter((p) => p.actualStatus === "participated")
      .map((p) => p.memberId);
    const explicitActualIds = [member.memberId!];
    expect(actualIds).toEqual(explicitActualIds);

    // 不明な終了時刻はNULLのまま（予定終了時刻から推測しない。docs/04:92「未知はNULLで保留」）
    const unknownEndTime = created.currentRevision.actualEndsAt;
    expect(unknownEndTime).toBeNull();
    expect(created.currentRevision.actualStartsAt).toBe("2026-10-20T01:10:00.000Z");

    // 個人時間は全体時間と別列。入力した団員の個人時間だけが入り、他はNULL
    const byMember = new Map(created.currentRevision.participants.map((p) => [p.memberId, p]));
    expect(byMember.get(member.memberId!)).toMatchObject({
      actualStatus: "participated",
      individualStartsAt: "2026-10-20T01:20:00.000Z",
      individualEndsAt: "2026-10-20T03:00:00.000Z",
    });
    expect(byMember.get(officer.memberId!)!.individualStartsAt).toBeNull();
    expect(byMember.get(operator.memberId!)!.individualEndsAt).toBeNull();

    // 実参加の行は版（revision）に紐づく（docs/04:93「版/member FK」）
    expect(await fx.rows("activity_actual_participants", { result_revision_id: created.currentRevision.id })).toHaveLength(3);

    // --- 詳細（API-07）に現在実績が接続される（T035でnullだった箇所） ---
    const detailWithResult = (await json(await fx.client(admin).request("GET", `/api/v1/activities/${activityId}`))).data! as {
      result: ResultData | null;
    };
    expect(detailWithResult.result).not.toBeNull();
    expect(detailWithResult.result!.currentRevisionId).toBe(created.currentRevisionId);
    expect(detailWithResult.result!.currentRevision.revisionNo).toBe(1);

    // --- 初回の二重作成は409 DUPLICATE（docs/05 API-09「未作成のみ」。UNIQUE(unit,activity)） ---
    const duplicateCreate = await fx.client(admin).request("POST", `/api/v1/activities/${activityId}/actual-results`, {
      activityVersion: 2, content: "二度目の作成", participants: [], attachmentIds: [],
    }, idem());
    expect(duplicateCreate.status).toBe(409);
    expect((await json(duplicateCreate)).error?.code).toBe("DUPLICATE");

    // --- 権限（docs/10 PER-04「本人報告/担当実績」）: 担当でも本人でもない一般団員は403 ---
    expect((await fx.client(member).request("POST", `/api/v1/activities/${activityId}/actual-results`, {
      activityVersion: 2, content: "団員からの作成", participants: [], attachmentIds: [],
    }, idem())).status).toBe(403);

    // 対象snapshotに無い団員（別分団）の実参加は404（存在を明かさない）。実績がまだ無い別の予定で試す
    const secondRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "向け替え用の予定",
      kind: "訓練",
      plannedStartsAt: "2026-11-01T01:00:00.000Z",
      locationText: "架空市第二堤防",
      ownerMemberId: officer.memberId!,
      audienceMemberIds: [officer.memberId!],
    }, idem());
    expect(secondRes.status).toBe(201);
    const secondActivityId = ((await json(secondRes)).data! as { id: string }).id;
    const outsider = await fx.client(admin).request("POST", `/api/v1/activities/${secondActivityId}/actual-results`, {
      activityVersion: 1, content: "別分団の団員を含む作成",
      participants: [{ memberId: fx.units.b.people.member.memberId!, actualStatus: "participated" }],
      attachmentIds: [],
    }, idem());
    expect(outsider.status).toBe(404);

    // --- 別分団からは存在も明かさない404（docs/10 §3「対象外IDは404に統一」） ---
    const otherUnitCreate = await fx.client(fx.units.b.people.admin).request("POST", `/api/v1/activities/${activityId}/actual-results`, {
      activityVersion: 2, content: "別分団からの作成", participants: [], attachmentIds: [],
    }, idem());
    expect(otherUnitCreate.status).toBe(404);
    expect((await fx.client(fx.units.b.people.admin).request("GET", `/api/v1/activities/${activityId}/actual-results`)).status).toBe(404);

    // --- 逆時刻は400（docs/04:92「両時刻存在時ends>=starts」。全体・個人とも） ---
    const reversedWhole = await fx.client(admin).request("POST", `/api/v1/activities/${activityId}/actual-results/corrections`, {
      resultVersion: 1,
      content: "終了より前の開始", actualStartsAt: "2026-10-20T04:00:00.000Z", actualEndsAt: "2026-10-20T03:00:00.000Z",
      participants: [], attachmentIds: [], reason: "誤入力の訂正",
    }, idem());
    expect(reversedWhole.status).toBe(400);
    const reversedIndividual = await fx.client(admin).request("POST", `/api/v1/activities/${activityId}/actual-results/corrections`, {
      resultVersion: 1,
      content: "個人時間が逆", participants: [{
        memberId: member.memberId!, actualStatus: "participated",
        individualStartsAt: "2026-10-20T03:00:00.000Z", individualEndsAt: "2026-10-20T01:00:00.000Z",
      }], attachmentIds: [], reason: "誤入力の訂正",
    }, idem());
    expect(reversedIndividual.status).toBe(400);

    // 訂正理由は必須（docs/04:92「訂正は理由必須」→契約で400）
    const noReason = await fx.client(admin).request("POST", `/api/v1/activities/${activityId}/actual-results/corrections`, {
      resultVersion: 1, content: "理由の無い訂正", participants: [], attachmentIds: [],
    }, idem());
    expect(noReason.status).toBe(400);

    // --- 訂正（API-42）: 終了時刻を確定し、未確認だった担当者を実参加へ。元版（revision 1）は不変 ---
    const originalRevisionBefore = created.currentRevision;
    const correction = await fx.client(officer).request("POST", `/api/v1/activities/${activityId}/actual-results/corrections`, {
      resultVersion: 1,
      content: "堤防の点検と水防訓練を実施。終了時刻を確定（担当者の報告により追記）。",
      actualStartsAt: "2026-10-20T01:10:00.000Z",
      actualEndsAt: "2026-10-20T04:30:00.000Z",
      participants: [
        { memberId: officer.memberId!, actualStatus: "absent" },
        {
          memberId: member.memberId!, actualStatus: "participated",
          individualStartsAt: "2026-10-20T01:20:00.000Z", individualEndsAt: "2026-10-20T03:00:00.000Z",
        },
        { memberId: operator.memberId!, actualStatus: "participated" },
      ],
      attachmentIds: [],
      reason: "終了時刻と担当者の参加を確認できたため訂正",
    }, idem());
    expect(correction.status).toBe(201);
    const corrected = (await json(correction)).data! as unknown as ResultData;
    expect(corrected.id).toBe(created.id); // rootは同じ（訂正は新revision。docs/11 §3）
    expect(corrected.version).toBe(2);
    expect(corrected.currentRevisionId).not.toBe(created.currentRevisionId);
    expect(corrected.currentRevision.revisionNo).toBe(2);
    expect(corrected.currentRevision.supersedesId).toBe(created.currentRevision.id);
    expect(corrected.currentRevision.correctionReason).toBe("終了時刻と担当者の参加を確認できたため訂正");
    expect(corrected.currentRevision.actualEndsAt).toBe("2026-10-20T04:30:00.000Z");
    expect(
      corrected.currentRevision.participants
        .filter((p) => p.actualStatus === "participated")
        .map((p) => p.memberId)
        .sort(),
    ).toEqual([member.memberId!, operator.memberId!].sort());

    // --- 旧版も取得できる（API-43 revision指定。docs/05:96「旧版も認可」）。元版は訂正後も不変 ---
    const oldGet = await fx.client(admin).request("GET", `/api/v1/activities/${activityId}/actual-results?revision=1`);
    expect(oldGet.status).toBe(200);
    const originalRevisionAfter =
      (((await json(oldGet)).data! as { revisions: RevisionData[] }).revisions[0]!);
    expect(originalRevisionAfter).toEqual(originalRevisionBefore);

    // 現在（指定なし）は新旧両方をrevision_no順で。resultの版とポインタも進む
    const currentGet = await fx.client(admin).request("GET", `/api/v1/activities/${activityId}/actual-results`);
    expect(currentGet.status).toBe(200);
    const history = (await json(currentGet)).data! as { result: ResultData; revisions: RevisionData[] };
    expect(history.result.version).toBe(2);
    expect(history.result.currentRevisionId).toBe(corrected.currentRevisionId);
    expect(history.revisions.map((r) => r.revisionNo)).toEqual([1, 2]);
    // 存在しない版は404
    expect((await fx.client(admin).request("GET", `/api/v1/activities/${activityId}/actual-results?revision=9`)).status).toBe(404);

    // --- 並行訂正は片方だけ成功（docs/11 §3「現在版pointerの切替もversionガード」。T031と同じ系） ---
    const [first, second] = await Promise.allSettled([
      fx.client(admin).request("POST", `/api/v1/activities/${activityId}/actual-results/corrections`, {
        resultVersion: 2, content: "第1端末からの訂正", actualStartsAt: "2026-10-20T01:10:00.000Z",
        participants: [], attachmentIds: [], reason: "第1端末の訂正",
      }, idem()),
      fx.client(officer).request("POST", `/api/v1/activities/${activityId}/actual-results/corrections`, {
        resultVersion: 2, content: "第2端末からの訂正", actualStartsAt: "2026-10-20T01:10:00.000Z",
        participants: [], attachmentIds: [], reason: "第2端末の訂正",
      }, idem()),
    ]);
    const statuses = [first, second]
      .map((r) => (r.status === "fulfilled" ? r.value.status : 0))
      .sort((x, y) => x - y);
    expect(statuses).toEqual([201, 409]);

    // 勝者の訂正だけが残る（敗者の枝は消えている。revision_noは3まで）
    const afterRace = (await json(await fx.client(admin).request("GET", `/api/v1/activities/${activityId}/actual-results`))).data! as {
      result: ResultData; revisions: RevisionData[];
    };
    expect(afterRace.result.version).toBe(3);
    expect(afterRace.revisions.map((r) => r.revisionNo)).toEqual([1, 2, 3]);
    const supersededIds = afterRace.revisions.map((r) => r.supersedesId).filter((x): x is string => x !== null);
    expect(new Set(supersededIds).size).toBe(2); // 枝分かれ無し（r1→r2→r3の一本）

    // 旧版（resultVersion=1）を見ていた画面からの訂正は409（過去版からの枝分かれ拒否。docs/05 API-46と同じ系）
    expect((await fx.client(admin).request("POST", `/api/v1/activities/${activityId}/actual-results/corrections`, {
      resultVersion: 1, content: "旧版からの訂正", participants: [], attachmentIds: [], reason: "古い版から",
    }, idem())).status).toBe(409);

    // --- 添付はready検査済みのbasicだけ活動へリンク（docs/10 §3。sensitiveは点検・異常が対象） ---
    const basicPhoto = await seedReadyAttachment(a.id, admin.userId, admin.memberId!, "basic");
    const withPhoto = await fx.client(admin).request("POST", `/api/v1/activities/${activityId}/actual-results/corrections`, {
      resultVersion: 3, content: "訓練の写真を添付", actualStartsAt: "2026-10-20T01:10:00.000Z",
      participants: [], attachmentIds: [basicPhoto], reason: "訓練の様子を記録として添付",
    }, idem());
    expect(withPhoto.status).toBe(201);
    const basicLinks = await fx.rows("attachment_links", { attachment_id: basicPhoto });
    expect(basicLinks).toHaveLength(1);
    expect(basicLinks[0]).toMatchObject({ entity_type: "activity", entity_id: activityId, unlinked_at: null });

    // sensitive（現場写真等）はactivityへはリンクできない（422。docs/10 §3「機微情報を低権限対象へリンクする操作を禁止」）
    const secretPhoto = await seedReadyAttachment(a.id, admin.userId, admin.memberId!, "sensitive");
    const withSecret = await fx.client(admin).request("POST", `/api/v1/activities/${activityId}/actual-results/corrections`, {
      resultVersion: 4, content: "sensitiveの添付", participants: [], attachmentIds: [secretPhoto], reason: "sensitiveは添付できない",
    }, idem());
    expect(withSecret.status).toBe(422);
    expect((await json(withSecret)).error?.code).toBe("ATTACHMENT_NOT_READY");
    expect(await fx.rows("attachment_links", { attachment_id: secretPhoto })).toHaveLength(0);

    // --- 実績作成・訂正は予定を一切変えていないことの最終検収（AT-ACT-03「予定不変」） ---
    const detailAfter = (await json(await fx.client(admin).request("GET", `/api/v1/activities/${activityId}`))).data! as {
      plannedStartsAt: string; plannedEndsAt: string | null; version: number; status: string;
      attendance: { memberId: string; response: string; version: number }[];
    };
    const plannedTimesAfter = {
      plannedStartsAt: detailAfter.plannedStartsAt,
      plannedEndsAt: detailAfter.plannedEndsAt,
      version: detailAfter.version,
      status: detailAfter.status,
    };
    expect(plannedTimesAfter).toEqual(plannedTimesBefore);
    // 出欠も実績に影響されない（回答版が進んでいない）
    expect(detailAfter.attendance).toEqual(attendanceBefore);
  });
});
