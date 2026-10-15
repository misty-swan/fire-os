import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createFixture, type Identity, type TestClient, type TestFixture } from "./helpers/fixture";

/**
 * 月次・年度・団員別集計（T060、docs/05 API-52/§5集計契約、docs/04 §3.2末尾、docs/03 SCR-26、
 * AT-ACT-06/DASH-02）。集計の正本は**operations単位**:
 * - 同一operationの活動＋出動は一つの出来事として1回だけ数える（docs/04「operationを共有する活動と出動は
 *   一つの出来事として数える」）。団員の延べ参加もoperation×member単位で重複除去する
 * - 取消（cancelled活動・voided出動）と非countable operationは集計外（docs/04「集計は無効なoperationを除く」）
 * - 時間はdocs/14 D05案（実活動全体時間と実参加を基準。個人時間は別欄で合算しない）。
 *   **不明時間は0時間と表示せず「未入力」**（unknownHoursDisplayedAsZero=false）
 * - 期間はfrom包含/to排他。年度はD05の検証設定（開始月4月・JST業務日。了承済みとは扱わない）
 * - sourceIds（応答の元データid集合）は同じ条件で開いた一覧（API-05/API-21）のid集合（drilldownIds）と一致。
 *   出動一覧（API-21）はvoidedも閲覧可能（docs/05 API-21）のため、drilldownIds側はvoidedを除いた集合
 *   ＝「集計は無効なoperationを除く」の一覧側への写像（docs/04 §3.2末尾）
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

/** FY2026（検証設定: 開始月4月・JST）＝ 2026-03-31T15:00Z（4/1 JST 0時）〜2027-03-31T15:00Z */
const fy2026 = { from: "2026-03-31T15:00:00.000Z", to: "2027-03-31T15:00:00.000Z" };

interface Analytics {
  period: { from: string | null; to: string | null };
  fiscalYear: number | null;
  kind: string | null;
  memberId: string | null;
  unitId: string;
  settings: { fiscalYearStartMonth: number; approved: boolean };
  totals: { operationCount: number; memberCount: number; knownDurationMinutes: number };
  unknownOperationIds: string[];
  monthly: { month: string; operationCount: number; memberCount: number; unknownOperationCount: number }[];
  members: { memberId: string; displayName: string; operationCount: number; knownDurationMinutes: number; unknownOperationCount: number }[];
  sources: {
    distinctOperationIds: string[];
    activities: { id: string; operationId: string; title: string; kind: string; plannedStartsAt: string }[];
    incidents: { id: string; operationId: string; summary: string; kind: string; occurredAt: string }[];
    filters: { activitiesHref: string; incidentsHref: string };
  };
}

const getAnalytics = async (who: Identity, query: string): Promise<{ status: number; data?: Analytics; error?: { code: string } }> => {
  const res = await fx.client(who).request("GET", `/api/v1/analytics${query}`);
  const body = (await json(res)) as { data?: Analytics; error?: { code: string } };
  return { status: res.status, data: body.data, error: body.error };
};

/** published活動（API-06→API-39）を作る。戻り値はidとoperationId（公開後のversionは2） */
const createPublishedActivity = async (who: Identity, title: string, plannedStartsAt: string, audience: string[]) => {
  const res = await fx.client(who).request("POST", "/api/v1/activities", {
    title, kind: "訓練", plannedStartsAt, locationText: "架空市中央公園",
    ownerMemberId: audience[0]!, audienceMemberIds: audience,
  }, idem());
  expect(res.status).toBe(201);
  const made = (await json(res)).data! as unknown as { id: string; operationId: string };
  expect((await fx.client(who).request("PATCH", `/api/v1/activities/${made.id}`, {
    version: 1, status: "scheduled", reason: "対象を確定して公開",
  }, idem())).status).toBe(200);
  return made;
};

/** 実績（API-09。activityVersionは公開後の2） */
const createResult = async (
  who: Identity, activityId: string,
  times: { actualStartsAt?: string; actualEndsAt?: string } | null,
  participants: { memberId: string; actualStatus: "participated" | "absent" }[],
) => {
  const res = await fx.client(who).request("POST", `/api/v1/activities/${activityId}/actual-results`, {
    activityVersion: 2,
    content: "集計試験の実績（架空）",
    ...(times ?? {}),
    participants, attachmentIds: [],
  }, idem());
  expect(res.status).toBe(201);
};

/** 出動（API-22。activityIdで活動と同じoperationへ作成時リンク＝T043） */
const createIncident = async (who: Identity, summary: string, occurredAt: string, activityId?: string) => {
  const res = await fx.client(who).request("POST", "/api/v1/incidents", {
    kind: "training", occurredAt, summary, ...(activityId ? { activityId } : {}),
  }, idem());
  expect(res.status).toBe(201);
  return (await json(res)).data! as unknown as { id: string; version: number; operationId: string };
};

/** 参集（API-23）。本人以外の記録はD08の代理scopeが必要（T041）のため、**本人のクライアント**で記録する。
 *  実参加＝mobilizing/arrived/returned（docs/11の語彙） */
const addOwnParticipant = async (who: Identity, incidentId: string, attendanceStatus = "mobilizing") => {
  const res = await fx.client(who).request("PUT", `/api/v1/incidents/${incidentId}/participants/${who.memberId}`, {
    version: 0, attendanceStatus,
  }, idem());
  expect([200, 201]).toContain(res.status);
};

/** 一覧API（cursorのkeyset）を最後のページまで読み、id/operationIdの配列を返す（件数を切り捨てない） */
async function walkList(client: TestClient, path: string, query: Record<string, string>): Promise<{ id: string; operationId: string }[]> {
  const rows: { id: string; operationId: string }[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams(query);
    params.set("limit", "200");
    if (cursor) params.set("cursor", cursor);
    const res = await client.request("GET", `${path}?${params.toString()}`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as { data?: { id: string; operationId: string }[]; meta?: { nextCursor?: string } };
    rows.push(...(body.data ?? []).map((r) => ({ id: r.id, operationId: r.operationId })));
    cursor = body.meta?.nextCursor ?? null;
    if (!cursor) return rows;
  }
  throw new Error("一覧の読み切りが50ページで終わりません");
}

/** href（/app/activities?... の形）からクエリを取り出してRecordへ */
const queryOf = (href: string) => Object.fromEntries(new URLSearchParams(href.slice(href.indexOf("?") + 1)));
const sorted = (ids: string[]) => [...ids].sort();

describe("月次・年度・団員別集計 (T060)", () => {
  it("linked_incident_and_activity_are_counted_once", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 管理者（PER-01閲覧・PER-04記録）。集計の主体にもなる
    const officer = a.people.officer;
    const member = a.people.member;
    const operator = a.people.operator;
    const b = fx.units.b;

    // --- seed（FY2026の期間内。docs/16 T060「同operationの活動/出動＋別operation、取消、未知時間、年度境界、個人の重複参加」） ---
    // 1) 同一operationの活動＋出動（T043の作成時リンク）。団員memberは活動と出動の両方に現れる（operation×memberで重複除去の対象）
    const actLink = await createPublishedActivity(admin, "集計試験のリンク活動（架空）", "2026-05-10T01:00:00.000Z", [officer.memberId!, member.memberId!]);
    await createResult(admin, actLink.id, { actualStartsAt: "2026-05-10T01:00:00.000Z", actualEndsAt: "2026-05-10T03:00:00.000Z" }, [
      { memberId: member.memberId!, actualStatus: "participated" },
      { memberId: officer.memberId!, actualStatus: "participated" },
    ]);
    const incLink = await createIncident(admin, "集計試験のリンク出動（架空）", "2026-05-10T02:00:00.000Z", actLink.id);
    expect(incLink.operationId).toBe(actLink.operationId); // T043: 出動は活動側のoperationへ属する
    await addOwnParticipant(member, incLink.id, "arrived"); // memberは同じoperationに二重に現れる（活動と出動の両方）
    await addOwnParticipant(officer, incLink.id, "arrived");

    // 2) 別operationの活動（時間あり）と出動（活動なし＝時間は未入力）
    const actSolo = await createPublishedActivity(admin, "集計試験の単独活動（架空）", "2026-06-20T01:00:00.000Z", [member.memberId!]);
    await createResult(admin, actSolo.id, { actualStartsAt: "2026-06-20T01:00:00.000Z", actualEndsAt: "2026-06-20T02:30:00.000Z" }, [
      { memberId: member.memberId!, actualStatus: "participated" },
    ]);
    const incSolo = await createIncident(admin, "集計試験の単独出動（架空）", "2026-07-05T00:00:00.000Z");
    await addOwnParticipant(member, incSolo.id, "mobilizing");

    // 3) 取消（集計外）: cancelled活動とvoided出動。operationはcountable=0になる（docs/04「無効時countable=0」）
    const actCancel = await createPublishedActivity(admin, "集計試験の中止活動（架空）", "2026-08-01T01:00:00.000Z", [member.memberId!]);
    expect((await fx.client(admin).request("POST", `/api/v1/activities/${actCancel.id}/cancellation`, {
      version: 2, reason: "台風のため中止",
    }, idem())).status).toBe(200);
    const incVoid = await createIncident(admin, "集計試験の無効出動（架空）", "2026-09-01T00:00:00.000Z");
    await addOwnParticipant(member, incVoid.id, "mobilizing"); // 無効でも参加行は残る（集計だけが外れる）
    expect((await fx.client(admin).request("PATCH", `/api/v1/incidents/${incVoid.id}`, {
      version: 1, status: "voided", reason: "誤登録のため無効化",
    }, idem())).status).toBe(200);

    // 4) 未知時間（実績に全体時間が無い＝「未入力」。0時間と表示しない）
    const actUnknown = await createPublishedActivity(admin, "集計試験の時間未入力活動（架空）", "2026-10-10T01:00:00.000Z", [member.memberId!]);
    await createResult(admin, actUnknown.id, null, [{ memberId: member.memberId!, actualStatus: "participated" }]);
    // 4b) 未知時間の2件目（団員operatorの行。既知時間0・未入力1の「未入力」行の根拠）
    const actUnknown2 = await createPublishedActivity(admin, "集計試験の時間未入力活動2（架空）", "2026-11-10T01:00:00.000Z", [operator.memberId!]);
    await createResult(admin, actUnknown2.id, null, [{ memberId: operator.memberId!, actualStatus: "participated" }]);

    // 5) 年度境界（FY2025の3月とFY2026の4月。検証設定: 4月始まり・JST）
    const actPrev = await createPublishedActivity(admin, "集計試験の昨年度活動（架空）", "2026-03-20T01:00:00.000Z", [officer.memberId!]);
    await createResult(admin, actPrev.id, { actualStartsAt: "2026-03-20T01:00:00.000Z", actualEndsAt: "2026-03-20T02:00:00.000Z" }, [
      { memberId: officer.memberId!, actualStatus: "participated" },
    ]);
    const actCurr = await createPublishedActivity(admin, "集計試験の今年度活動（架空）", "2026-04-02T01:00:00.000Z", [officer.memberId!]);
    await createResult(admin, actCurr.id, { actualStartsAt: "2026-04-02T01:00:00.000Z", actualEndsAt: "2026-04-02T03:00:00.000Z" }, [
      { memberId: officer.memberId!, actualStatus: "participated" },
    ]);

    // 6) 集計外の下書き（実績が無いためactual検索の対象外＝API-05 actual=trueと同じ集合）と別分団の記録（非漏えい）
    await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "集計試験の下書き（架空）", kind: "訓練", plannedStartsAt: "2026-06-01T01:00:00.000Z",
      locationText: "架空市中央公園", ownerMemberId: member.memberId!, audienceMemberIds: [member.memberId!],
    }, idem());
    const actB = await createPublishedActivity(b.people.admin, "別分団の活動（架空）", "2026-06-15T01:00:00.000Z", [b.people.member.memberId!]);
    await createResult(b.people.admin, actB.id, { actualStartsAt: "2026-06-15T01:00:00.000Z", actualEndsAt: "2026-06-15T02:00:00.000Z" }, [
      { memberId: b.people.member.memberId!, actualStatus: "participated" },
    ]);

    // --- 期待値（fixtureから算出） ---
    // operations単位: リンク対=1、actSolo=1、incSolo=1、時間未入力=2、actCurr=1（中止・無効・下書き・昨年度・別分団は外れる）
    const expectedDistinctOperations = 6;
    // operation×member: リンク対{member,officer}=2、actSolo{member}=1、incSolo{member}=1、未入力活動{member}=1、
    // 未入力活動2{operator}=1、actCurr{officer}=1
    const expectedDistinctOperationMembers = 7;
    // 既知の全体時間（分）: リンク対120＋actSolo90＋actCurr120。出動単独・時間未入力は合算しない
    const expectedKnownMinutes = 330;

    // --- 集計（FY2026） ---
    const { status, data } = await getAnalytics(admin, `?from=${fy2026.from}&to=${fy2026.to}`);
    expect(status).toBe(200);
    expect(data).toBeTruthy();
    const activityCount = data!.totals.operationCount;
    const personCount = data!.totals.memberCount;
    // 不明時間は0と合算されない: 未入力の出来事がunknownOperationIdsに載り、既知分だけが合計になる
    const unknownHoursDisplayedAsZero =
      !data!.unknownOperationIds.includes(incSolo.operationId) ||
      !data!.unknownOperationIds.includes(actUnknown.operationId) ||
      data!.totals.knownDurationMinutes !== expectedKnownMinutes;
    expect(activityCount).toBe(expectedDistinctOperations);
    expect(personCount).toBe(expectedDistinctOperationMembers);
    expect(unknownHoursDisplayedAsZero).toBe(false);

    // 中止・無効・下書き・別分団・期間外は集計外（数値と元データの両方で）
    const allSourceIds = sorted([
      ...data!.sources.activities.map((r) => r.id),
      ...data!.sources.incidents.map((r) => r.id),
    ]);
    expect(allSourceIds).not.toContain(actCancel.id);
    expect(allSourceIds).not.toContain(incVoid.id);
    expect(allSourceIds).not.toContain(actPrev.id);
    expect(allSourceIds).not.toContain(actB.id);
    expect(data!.unitId).toBe(a.id);

    // --- sourceIds（元データのid集合）は同じ条件の一覧（API-05/API-21）のid集合と一致 ---
    // 活動側はactual=trueを含む同じクエリで完全一致。出動側はAPI-21がvoidedも閲覧可能（docs/05）のため、
    // drilldownIdsは「voidedを除いたid集合」＝docs/04「集計は無効なoperationを除く」の一覧側への写像
    const actWalk = await walkList(fx.client(admin), "/api/v1/activities", queryOf(data!.sources.filters.activitiesHref));
    const incWalkAll = await walkList(fx.client(admin), "/api/v1/incidents", queryOf(data!.sources.filters.incidentsHref));
    const incRows = (
      await Promise.all(
        incWalkAll.map(async (r) => {
          const res = await fx.client(admin).request("GET", `/api/v1/incidents/${r.id}`);
          const body = (await json(res)).data! as unknown as { id: string; status: string };
          return body;
        }),
      )
    ).filter((r) => r.status !== "voided");
    const drilldownActivityIds = sorted(actWalk.map((r) => r.id));
    const drilldownIncidentIds = sorted(incRows.map((r) => r.id));
    const drilldownOperationIds = sorted(
      [...new Set([...actWalk.map((r) => r.operationId), ...incWalkAll.filter((r) => drilldownIncidentIds.includes(r.id)).map((r) => r.operationId)])],
    );
    const sourceIds = sorted([
      ...data!.sources.activities.map((r) => r.id),
      ...data!.sources.incidents.map((r) => r.id),
    ]);
    expect(sourceIds).toEqual(sorted([...drilldownActivityIds, ...drilldownIncidentIds]));
    expect(sorted(data!.sources.activities.map((r) => r.id))).toEqual(drilldownActivityIds);
    expect(sorted(data!.sources.incidents.map((r) => r.id))).toEqual(drilldownIncidentIds);
    expect(sorted(data!.sources.distinctOperationIds)).toEqual(drilldownOperationIds);

    // --- 月次（JST暦月。リンク対は2026-05に1回だけ） ---
    const byMonth = new Map(data!.monthly.map((m) => [m.month, m]));
    expect(byMonth.get("2026-05")).toMatchObject({ operationCount: 1, memberCount: 2, unknownOperationCount: 0 });
    expect(byMonth.get("2026-06")).toMatchObject({ operationCount: 1, memberCount: 1 });
    expect(byMonth.get("2026-07")).toMatchObject({ operationCount: 1, memberCount: 1, unknownOperationCount: 1 });
    expect(byMonth.get("2026-10")).toMatchObject({ operationCount: 1, memberCount: 1, unknownOperationCount: 1 });
    expect(byMonth.get("2026-11")).toMatchObject({ operationCount: 1, memberCount: 1, unknownOperationCount: 1 });
    expect(byMonth.get("2026-04")).toMatchObject({ operationCount: 1, memberCount: 1 });
    expect(byMonth.get("2026-03")).toBeUndefined(); // 昨年度の3月はFY2026に含まれない

    // --- 団員別（実参加の和集合。未入力の団員は0時間ではなくunknownOperationCountで示す） ---
    const byMember = new Map(data!.members.map((m) => [m.memberId, m]));
    expect(byMember.get(member.memberId!)).toMatchObject({ operationCount: 4, knownDurationMinutes: 210, unknownOperationCount: 2 });
    expect(byMember.get(officer.memberId!)).toMatchObject({ operationCount: 2, knownDurationMinutes: 240, unknownOperationCount: 0 });
    const operatorRow = byMember.get(operator.memberId!)!;
    expect(operatorRow).toMatchObject({ operationCount: 1, knownDurationMinutes: 0, unknownOperationCount: 1 }); // 画面はこの行を「未入力」と出す

    // --- fiscalYearパラメータはfrom/toと同じ期間を指す（検証設定の年度境界） ---
    const byFy = await getAnalytics(admin, "?fiscalYear=2026");
    expect(byFy.status).toBe(200);
    expect(byFy.data!.period).toEqual({ from: fy2026.from, to: fy2026.to });
    expect(byFy.data!.fiscalYear).toBe(2026);
    expect(byFy.data!.totals).toEqual(data!.totals);
    expect(byFy.data!.settings).toEqual({ fiscalYearStartMonth: 4, approved: false }); // 承認済みとは表示しない

    // fiscalYear=2025は3月の活動だけ（年度境界のもう一方）
    const fy2025 = await getAnalytics(admin, "?fiscalYear=2025");
    expect(fy2025.data!.period).toEqual({ from: "2025-03-31T15:00:00.000Z", to: "2026-03-31T15:00:00.000Z" });
    expect(fy2025.data!.totals.operationCount).toBe(1);
    expect(sorted(fy2025.data!.sources.activities.map((r) => r.id))).toEqual([actPrev.id]);

    // 同時指定の整合検査（fiscalYearと食い違うfrom/toは400）
    const mismatch = await fx.client(admin).request("GET", `/api/v1/analytics?fiscalYear=2026&from=${fy2026.from}&to=2027-01-01T00:00:00.000Z`);
    expect(mismatch.status).toBe(400);
    expect(((await json(mismatch)).error?.details ?? [])[0]?.reason).toBe("fiscal_year_range_mismatch");

    // --- kind指定は活動の種別（activities.kind。出動のkindは語彙が別のため含めない。docs/05 API-52） ---
    const byKind = await getAnalytics(admin, `?from=${fy2026.from}&to=${fy2026.to}&kind=水防`);
    expect(byKind.data!.totals.operationCount).toBe(0);

    // --- memberId別（実参加した出来事だけ。他分団の団員は404＝存在も明かさない） ---
    const byMemberQuery = await getAnalytics(admin, `?fiscalYear=2026&memberId=${member.memberId}`);
    expect(byMemberQuery.data!.totals.operationCount).toBe(4); // リンク対・actSolo・incSolo・時間未入力
    expect(byMemberQuery.data!.totals.memberCount).toBe(4);
    expect(byMemberQuery.data!.members).toHaveLength(1);
    const foreign = await getAnalytics(admin, `?fiscalYear=2026&memberId=${b.people.member.memberId}`);
    expect(foreign.status).toBe(404);

    // --- PER-01（業務閲覧/集計）: 一般団員も同じ自unit集計を読める。他分団の件数は混ざらない ---
    const byGeneral = await getAnalytics(member, "?fiscalYear=2026");
    expect(byGeneral.status).toBe(200);
    expect(byGeneral.data!.totals).toEqual(data!.totals);
    const otherUnit = await getAnalytics(b.people.member, "?fiscalYear=2026");
    expect(otherUnit.data!.totals.operationCount).toBe(1); // 別分団のseedだけ
    expect(sorted(otherUnit.data!.sources.activities.map((r) => r.id))).toEqual([actB.id]);
  });
});
