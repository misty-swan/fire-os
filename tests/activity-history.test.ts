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
  (await r.json()) as { data?: Record<string, unknown>; error?: { code: string }; meta?: { nextCursor?: string } };
const jsonPage = async (r: Response) =>
  (await r.json()) as { data?: Record<string, unknown>[]; error?: { code: string }; meta?: { nextCursor?: string } };

/** 予定を作って公開する（API-06/39。docs/11 開催はdraft→scheduled）。idを返す */
async function createScheduledActivity(
  who: Identity,
  opts: { title: string; kind?: string; plannedStartsAt: string; audienceMemberIds: string[]; ownerMemberId: string },
): Promise<string> {
  const create = await fx.client(who).request("POST", "/api/v1/activities", {
    title: opts.title,
    kind: opts.kind ?? "訓練",
    plannedStartsAt: opts.plannedStartsAt,
    locationText: "架空市中央公園",
    ownerMemberId: opts.ownerMemberId,
    audienceMemberIds: opts.audienceMemberIds,
  }, idem());
  expect(create.status).toBe(201);
  const id = ((await json(create)).data! as { id: string }).id;
  const publish = await fx.client(who).request("PATCH", `/api/v1/activities/${id}`, {
    version: 1, status: "scheduled", reason: "対象を確定して公開",
  }, idem());
  expect(publish.status).toBe(200);
  return id;
}

/** 実績の初版を作る（API-09）。実参加は出欠と別物で、回答を実参加へコピーしない（docs/11 実参加行） */
async function createActual(
  who: Identity,
  activityId: string,
  activityVersion: number,
  participants: { memberId: string; actualStatus: string }[],
): Promise<void> {
  const res = await fx.client(who).request("POST", `/api/v1/activities/${activityId}/actual-results`, {
    activityVersion,
    content: "履歴検索試験用の実績記録",
    participants,
    attachmentIds: [],
  }, idem());
  expect(res.status).toBe(201);
}

/**
 * 全cursorを辿って活動idを集める（docs/05 §1「Detailは…子一覧の件数を黙って切り捨てない」のlist版）。
 * 見えた順（planned_starts_at,id）のid列、重複したid列、ページ数を返す。
 */
async function walkAll(who: Identity, query: string): Promise<{ ids: string[]; duplicateIds: string[]; pages: number }> {
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const url = `/api/v1/activities${query}${cursor ? `${query.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await fx.client(who).request("GET", url);
    expect(res.status).toBe(200);
    const body = await jsonPage(res);
    for (const row of body.data ?? []) seen.push(row.id as string);
    cursor = body.meta?.nextCursor;
    pages++;
  } while (cursor);
  const duplicateIds = seen.filter((v, i) => seen.indexOf(v) !== i);
  return { ids: [...new Set(seen)], duplicateIds, pages };
}

describe("活動履歴の検索 (T038)", () => {
  it("history_filters_actual_participants_and_half_open_time_range", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 管理者（PER-01は全役割。検索は所属内）
    const officer = a.people.officer; // 幹部（予定の担当）
    const member = a.people.member; // 一般団員
    const operator = a.people.operator; // 担当者
    const audience = [officer.memberId!, member.memberId!, operator.memberId!];
    const owner = officer.memberId!;

    // 検索期間は半開区間 [from, to)
    const from = "2026-10-10T00:00:00.000Z";
    const to = "2026-10-15T00:00:00.000Z";

    // --- fixture: 期間境界／同時刻複数id／予定のみ参加／訂正後欠席／取消 ---
    const beforeFrom = await createScheduledActivity(admin, {
      title: "範囲前の活動", plannedStartsAt: "2026-10-09T23:00:00.000Z", audienceMemberIds: audience, ownerMemberId: owner,
    });
    const atFrom = await createScheduledActivity(admin, {
      title: "from境界の活動", plannedStartsAt: from, audienceMemberIds: audience, ownerMemberId: owner,
    });
    const sameTime1 = await createScheduledActivity(admin, {
      title: "同時刻の活動1", kind: "点検", plannedStartsAt: "2026-10-12T09:00:00.000Z", audienceMemberIds: audience, ownerMemberId: owner,
    });
    const sameTime2 = await createScheduledActivity(admin, {
      title: "同時刻の活動2", plannedStartsAt: "2026-10-12T09:00:00.000Z", audienceMemberIds: audience, ownerMemberId: owner,
    });
    const atTo = await createScheduledActivity(admin, {
      title: "to境界の活動", plannedStartsAt: to, audienceMemberIds: audience, ownerMemberId: owner,
    });
    const plannedOnly = await createScheduledActivity(admin, {
      title: "回答だけの活動", plannedStartsAt: "2026-10-13T01:00:00.000Z", audienceMemberIds: audience, ownerMemberId: owner,
    });
    const corrected = await createScheduledActivity(admin, {
      title: "訂正で欠席になった活動", plannedStartsAt: "2026-10-14T01:00:00.000Z", audienceMemberIds: audience, ownerMemberId: owner,
    });
    const cancelled = await createScheduledActivity(admin, {
      title: "中止の活動", plannedStartsAt: "2026-10-14T05:00:00.000Z", audienceMemberIds: audience, ownerMemberId: owner,
    });

    // 実参加の記録（現行revisionにparticipatedがいる活動だけがactual=trueで出る）
    await createActual(admin, beforeFrom, 2, [{ memberId: owner, actualStatus: "participated" }]);
    await createActual(admin, atFrom, 2, [{ memberId: member.memberId!, actualStatus: "participated" }]);
    await createActual(admin, sameTime1, 2, [{ memberId: operator.memberId!, actualStatus: "participated" }]);
    await createActual(admin, sameTime2, 2, [{ memberId: owner, actualStatus: "participated" }]);
    await createActual(admin, atTo, 2, [{ memberId: member.memberId!, actualStatus: "participated" }]);

    // 予定のみ参加: 幹部は出欠でattendingだが、実参加はabsent（回答と実参加は別。docs/11 実参加行）
    const attending = await fx.client(officer).request("PUT", `/api/v1/activities/${plannedOnly}/attendance/me`, {
      version: 0, response: "attending",
    }, idem());
    expect(attending.status).toBe(201);
    await createActual(admin, plannedOnly, 2, [
      { memberId: owner, actualStatus: "absent" },
      { memberId: member.memberId!, actualStatus: "participated" },
    ]);

    // 訂正後欠席: 初版で幹部がparticipated → 訂正版でabsent（団員は訂正でunconfirmed→participated）
    await createActual(admin, corrected, 2, [
      { memberId: owner, actualStatus: "participated" },
      { memberId: member.memberId!, actualStatus: "unconfirmed" },
    ]);
    const correction = await fx.client(admin).request("POST", `/api/v1/activities/${corrected}/actual-results/corrections`, {
      resultVersion: 1,
      content: "参加状況を確認したため訂正",
      participants: [
        { memberId: owner, actualStatus: "absent" },
        { memberId: member.memberId!, actualStatus: "participated" },
      ],
      attachmentIds: [],
      reason: "初版の参加記録を確認で訂正",
    }, idem());
    expect(correction.status).toBe(201);

    // 取消: 実績は残るがoperationのcountable=0（現有効実績ではない。docs/11 §3、T035）
    await createActual(admin, cancelled, 2, [{ memberId: owner, actualStatus: "participated" }]);
    const cancel = await fx.client(admin).request("POST", `/api/v1/activities/${cancelled}/cancellation`, {
      version: 2, reason: "荒天のため中止",
    }, idem());
    expect(cancel.status).toBe(200);

    // 別分団の活動（同一期間。unit外は絶対に返さない。PER-01）
    const bAdmin = fx.units.b.people.admin;
    const otherUnit = await createScheduledActivity(bAdmin, {
      title: "別分団の活動", plannedStartsAt: "2026-10-12T00:00:00.000Z",
      audienceMemberIds: [bAdmin.memberId!], ownerMemberId: bAdmin.memberId!,
    });

    // --- 期待値はAPIではなくDB（現行revision＋現有効operation）から独立に組み立てる ---
    const expectedActualParticipantIds = (
      await env.DB.prepare(
        "SELECT a.id FROM activities a " +
          "JOIN operations o ON o.unit_id = a.unit_id AND o.id = a.operation_id AND o.countable = 1 " +
          "JOIN activity_results r ON r.unit_id = a.unit_id AND r.activity_id = a.id " +
          "JOIN activity_result_revisions v ON v.unit_id = r.unit_id AND v.result_id = r.id AND v.id = r.current_revision_id " +
          "JOIN activity_actual_participants p ON p.result_revision_id = v.id AND p.actual_status = 'participated' " +
          "WHERE a.unit_id = ? AND a.planned_starts_at >= ? AND a.planned_starts_at < ? " +
          "GROUP BY a.id ORDER BY a.planned_starts_at, a.id",
      ).bind(a.id, from, to).all<{ id: string }>()
    ).results.map((r) => r.id);
    // fixtureの検収: from境界・同時刻ペア・予定のみ参加・訂正後参加が効いている（範囲外・to境界・取消は入らない）
    expect([...expectedActualParticipantIds].sort()).toEqual(
      [atFrom, sameTime1, sameTime2, plannedOnly, corrected].sort(),
    );

    // --- 全cursor完走（limit=2。同時刻ペアがページ境界を跨ぐ） ---
    const walk = await walkAll(admin, `?actual=true&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=2`);
    const foundIds = walk.ids;
    expect(foundIds).toEqual(expectedActualParticipantIds); // 過不足なし・安定順（planned_starts_at,id）
    expect(foundIds).toContain(atFrom); // fromは包含
    const toBoundaryIncluded = foundIds.includes(atTo);
    expect(toBoundaryIncluded).toBe(false); // toは排他
    const duplicateIds = walk.duplicateIds;
    expect(duplicateIds).toEqual([]); // 全cursorで重複なし
    expect(walk.pages).toBe(3); // 5件÷limit2=3ページ。同時刻ペアの両方が別ページで取れる

    // 実参加検索を予定出欠から求めない: 幹部のactual=trueは実参加した活動だけ
    // （attendingの回答だけの活動・訂正で欠席になった活動・取消・範囲外は出ない）
    const officerActual = await walkAll(admin, `?actual=true&memberId=${owner}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(officerActual.ids).toEqual([sameTime2]);
    // 団員は訂正で参加になった活動も出る（現行revisionが正本）
    const memberActual = await walkAll(admin, `?actual=true&memberId=${member.memberId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(memberActual.ids).toEqual([atFrom, plannedOnly, corrected]);

    // actual無しのmemberIdは予定（対象snapshot）基準: 回答だけの活動も取消も出る
    const officerPlanned = await walkAll(admin, `?memberId=${owner}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(officerPlanned.ids.sort()).toEqual([atFrom, sameTime1, sameTime2, plannedOnly, corrected, cancelled].sort());
    // actual=falseの明示指定も同じ（実参加検索はactual=trueのときだけ）
    const officerPlannedExplicit = await walkAll(admin, `?memberId=${owner}&actual=false&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(officerPlannedExplicit.ids.sort()).toEqual(officerPlanned.ids.sort());

    // cancelledも列挙statusとして検索できる（取消も履歴）
    const onlyCancelled = await walkAll(admin, `?status=cancelled&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(onlyCancelled.ids).toEqual([cancelled]);

    // kind（種別）でも絞れる
    const byKind = await walkAll(admin, `?kind=${encodeURIComponent("点検")}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(byKind.ids).toEqual([sameTime1]);

    // unit外は絶対に返さない（認可前置。PER-01は自unitのみ）
    const bWalk = await walkAll(bAdmin, `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(bWalk.ids).toEqual([otherUnit]);
    const aWalk = await walkAll(admin, `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(aWalk.ids).not.toContain(otherUnit);

    // --- filterはcursorへ署名込みで束縛する（facility-list流儀）。条件を変えた続き取得は409 ---
    const page1 = await jsonPage(await fx.client(admin).request("GET",
      `/api/v1/activities?actual=true&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=2`));
    expect(page1.meta?.nextCursor).toBeTruthy();
    const changedFilter = await fx.client(admin).request("GET",
      `/api/v1/activities?actual=true&memberId=${member.memberId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=2` +
      `&cursor=${encodeURIComponent(page1.meta!.nextCursor!)}`);
    expect(changedFilter.status).toBe(409);
    expect((await json(changedFilter)).error?.code).toBe("SNAPSHOT_CHANGED");

    // 改変cursorも409（署名不一致は条件変更と同じ応答。gis/cursor.tsと同じ扱い）
    const cursor = page1.meta!.nextCursor!;
    const tampered = `${cursor.slice(0, -2)}${cursor.endsWith("AA") ? "BB" : "AA"}`;
    const tamperedRes = await fx.client(admin).request("GET",
      `/api/v1/activities?actual=true&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=2&cursor=${encodeURIComponent(tampered)}`);
    expect(tamperedRes.status).toBe(409);
    expect((await json(tamperedRes)).error?.code).toBe("SNAPSHOT_CHANGED");
  });
  // --- T085の網羅で見つけた欠落（履歴検索の入力拒否。AT-ACT-04のCT-02） ---
  it("invalid_history_conditions_are_rejected (T085)", async () => {
    const admin = fx.units.a.people.admin;
    for (const q of [
      "from=2026-10-01", // 日付だけ（UTC瞬間でない）
      "memberId=NOT-A-UUID",
      "status=unknown_status",
      "actual=maybe",
      "limit=0",
      "unknownParam=1",
    ]) {
      const res = await fx.client(admin).request("GET", `/api/v1/activities?${q}`);
      expect(res.status, q).toBe(400);
    }
    // 壊れたcursorは条件変更と同じ409（署名不一致。上のit「改変cursorも409」と同じ設計）
    expect((await fx.client(admin).request("GET", "/api/v1/activities?cursor=not-a-cursor")).status).toBe(409);
  });
});
