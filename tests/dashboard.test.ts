import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createFixture, type TestClient, type TestFixture } from "./helpers/fixture";

let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) =>
  (await r.json()) as { data?: Record<string, unknown>; error?: { code: string; details?: { field: string; reason: string }[] } };

interface Metric {
  count: number;
  href: string | null;
  connected: boolean;
}
interface DashboardData {
  nextActivity: Metric & {
    id: string | null; title: string | null; kind: string | null; plannedStartsAt: string | null;
    attending: number; undecided: number; absent: number; unanswered: number; myResponse: string | null; inAudience: boolean;
  };
  myUnanswered: Metric;
  openIssues: Metric;
  inspectionDue: Metric;
  notifications: Metric;
  myTasks: Metric;
}

const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

/** href（/app/activities?...）と同じ条件の一覧をAPIで最後のページまで読み、idの配列を返す（件数を切り捨てない） */
async function walkActivities(client: TestClient, href: string): Promise<{ id: string; plannedStartsAt: string }[]> {
  const query = new URLSearchParams(href.slice(href.indexOf("?") + 1));
  const ids: { id: string; plannedStartsAt: string }[] = [];
  for (let page = 0; page < 50; page++) {
    query.set("limit", "200");
    const res = await client.request("GET", `/api/v1/activities?${query.toString()}`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as { data?: { id: string; plannedStartsAt: string }[]; meta?: { nextCursor?: string } };
    ids.push(...(body.data ?? []));
    const cursor = body.meta?.nextCursor;
    if (!cursor) return ids;
    query.set("cursor", cursor);
  }
  throw new Error("一覧の読み切りが50ページで終わりません");
}

describe("ホームの指標と同じ条件の一覧への遷移 (T047)", () => {
  it("dashboard_counts_match_authorized_drilldown_lists", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 管理者（分団長）。予定・施設・異常のseed（公開済みの予定のみ作る）
    const member = a.people.member; // 一般団員（ダッシュボードの主体）
    const officer = a.people.officer; // 幹部（対象者として未回答を残す）
    const operator = a.people.operator; // 担当者（対象者）
    const b = fx.units.b;

    // --- seed: 予定（本人対象/対象外/過去/下書き。docs/11 開催はdraftで始まり公開でscheduled） ---
    const createActivity = async (title: string, startsAt: string, audience: string[], publish: boolean) => {
      const res = await fx.client(admin).request("POST", "/api/v1/activities", {
        title, kind: "訓練", plannedStartsAt: startsAt, locationText: "架空市中央公園",
        ownerMemberId: officer.memberId!, audienceMemberIds: audience,
      }, idem());
      expect(res.status).toBe(201);
      const id = ((await json(res)).data! as { id: string }).id;
      if (publish) {
        expect((await fx.client(admin).request("PATCH", `/api/v1/activities/${id}`, {
          version: 1, status: "scheduled", reason: "対象を確定して公開",
        }, idem())).status).toBe(200);
      }
      return id;
    };

    const a1 = await createActivity("近い方の訓練", days(2), [member.memberId!, officer.memberId!], true);
    const a2 = await createActivity("遠い方の訓練", days(5), [member.memberId!, operator.memberId!], true);
    const a3 = await createActivity("本人対象外の訓練", days(5), [officer.memberId!], true); // memberは対象外
    await createActivity("もう過ぎた訓練", days(-3), [member.memberId!], true); // a4: 開始済みで集計外
    await createActivity("まだ下書きの訓練", days(1), [member.memberId!], false); // a5: draftは集計外
    const b1 = await fx.client(b.people.admin).request("POST", "/api/v1/activities", {
      title: "別分団の訓練", kind: "訓練", plannedStartsAt: days(3), locationText: "架空市第二分団詰所",
      ownerMemberId: b.people.officer.memberId!, audienceMemberIds: [b.people.member.memberId!],
    }, idem());
    expect(b1.status).toBe(201);
    const b1Id = ((await json(b1)).data! as { id: string }).id;
    expect((await fx.client(b.people.admin).request("PATCH", `/api/v1/activities/${b1Id}`, {
      version: 1, status: "scheduled", reason: "対象を確定して公開",
    }, idem())).status).toBe(200);

    // 本人はa1に「未定」と回答済み（未回答の母数から外れる。docs/11「未定と未回答は区別」）
    expect((await fx.client(member).request("PUT", `/api/v1/activities/${a1}/attendance/me`, {
      version: 0, response: "undecided",
    }, idem())).status).toBe(201);

    // --- seed: 異常（確認待ちreported／確認中under_review／確認終了closed。docs/03 SCR-07の語彙） ---
    const mkFacility = async (unit: TestFixture["units"]["a"], number: string) => {
      const res = await fx.client(unit.people.admin).request("POST", "/api/v1/facilities", {
        type: "hydrant", latitude: 35.72, longitude: 139.72, locationSource: "架空市台帳",
        locationNote: "ダッシュボード試験の施設", managementNumber: number,
      }, idem());
      expect(res.status).toBe(201);
      return ((await json(res)).data! as { id: string }).id;
    };
    const fa = await mkFacility(a, "K-47-A");
    const fb = await mkFacility(b, "K-47-B");
    const mkIssue = async (unit: TestFixture["units"]["a"], facilityId: string, title: string) => {
      const res = await fx.client(unit.people.admin).request("POST", "/api/v1/issues", {
        target: { type: "facility", id: facilityId }, title, description: "ダッシュボード試験の異常", attachmentIds: [],
      }, idem());
      expect(res.status).toBe(201);
      return ((await json(res)).data! as { id: string; version: number }).id;
    };
    const i1 = await mkIssue(a, fa, "開閉不良（確認待ちのまま）"); // reported
    const i2 = await mkIssue(a, fa, "ホース不足（確認終了）");
    const i3 = await mkIssue(a, fa, "表示板破損（確認中）");
    const bi1 = await mkIssue(b, fb, "別分団の異常");
    const transition = async (issueId: string, version: number, status: string) => {
      expect((await fx.client(admin).request("PATCH", `/api/v1/issues/${issueId}`, { version, status, reason: "試験の進行" }, idem())).status).toBe(200);
    };
    await transition(i2, 1, "under_review");
    await transition(i2, 2, "closed");
    await transition(i3, 1, "under_review");

    // --- 点検期限はseedしない（裁定1: inspection_schedulesはT048。未接続と0件を区別する） ---

    // --- ダッシュボード（API-28。本人=memberのscopeで集計） ---
    const res = await fx.client(member).request("GET", "/api/v1/dashboard");
    expect(res.status).toBe(200);
    const data = (await json(res)).data! as unknown as DashboardData;

    // 本人未回答 = 対象snapshot（これからの予定）− 回答あり行（T036の方式。DBから独立に数える）
    const nowIso = new Date().toISOString();
    const acts = await fx.rows("activities", { unit_id: a.id });
    const audience = await fx.rows("activity_audience");
    const attendance = await fx.rows("activity_attendance");
    const audienceMinusRespondedCount = acts.filter((act) => {
      if (act.status !== "scheduled" || String(act.planned_starts_at) < nowIso) return false;
      if (!audience.some((x) => x.activity_id === act.id && x.member_id === member.memberId)) return false;
      return !attendance.some((x) => x.activity_id === act.id && x.member_id === member.memberId && x.response !== "unanswered");
    }).length;
    const unansweredCount = data.myUnanswered.count;
    expect(unansweredCount).toBe(audienceMinusRespondedCount); // a2だけ（a1は未定回答済み、a3は対象外、a4は過去、a5はdraft）
    expect(unansweredCount).toBe(1);

    // ドリルダウン（hrefの条件そのまま）で一覧を開くと同じ1件
    const unansweredIds = (await walkActivities(fx.client(member), data.myUnanswered.href!)).map((r) => r.id);
    expect(unansweredIds).toEqual([a2]);

    // 次回予定: 最接近はa1。件数は「これからの予定（scheduled・開始>=現在）」＝hrefの一覧件数
    expect(data.nextActivity.id).toBe(a1);
    expect(data.nextActivity.connected).toBe(true);
    const upcoming = await walkActivities(fx.client(member), data.nextActivity.href!);
    expect(upcoming.map((r) => r.id)).toEqual([a1, a2, a3]); // 開始順（a4は過去、a5はdraft、b1は別分団）
    expect(data.nextActivity.count).toBe(upcoming.length);
    // ダイヤルの回答内訳（a1: 対象2名、未定1・未回答1）
    expect(data.nextActivity.attending).toBe(0);
    expect(data.nextActivity.undecided).toBe(1);
    expect(data.nextActivity.unanswered).toBe(1);
    expect(data.nextActivity.myResponse).toBe("undecided");
    expect(data.nextActivity.inAudience).toBe(true);

    // 確認待ち異常: reportedだけ（under_review/closedは別状態。docs/03 SCR-07「未確認（確認待ち）」）
    const visibleIssueCount = data.openIssues.count;
    const issueRes = await fx.client(member).request("GET", `/api/v1/issues?status=reported&limit=200`);
    expect(issueRes.status).toBe(200);
    const drilldownIssueIds = (((await json(issueRes)).data ?? []) as { id: string }[]).map((r) => r.id);
    expect(visibleIssueCount).toBe(drilldownIssueIds.length);
    expect(drilldownIssueIds).toEqual([i1]);

    // scope（PER-01=自unit）: 別分団の予定・異常は件数にも一覧にも現れない
    const drilldownJoined = [...unansweredIds, ...upcoming.map((r) => r.id), ...drilldownIssueIds].join(",");
    const hiddenDataContributed = [b1Id, bi1].some((id) => drilldownJoined.includes(id));
    expect(hiddenDataContributed).toBe(false);

    // 未接続の指標（点検期限=T048、通知/自分タスク=PH4）。0件ではなく未接続として返る
    for (const m of [data.inspectionDue, data.notifications, data.myTasks]) {
      expect(m.connected).toBe(false);
      expect(m.href).toBeNull();
    }

    // 幹部の視点: officerはa1・a3の対象で未回答 → 2件
    const officerRes = await fx.client(officer).request("GET", "/api/v1/dashboard");
    expect(officerRes.status).toBe(200);
    const officerData = (await json(officerRes)).data! as unknown as DashboardData;
    expect(officerData.myUnanswered.count).toBe(2);
    expect(officerData.nextActivity.myResponse).toBeNull(); // 対象だが未回答
    expect(officerData.openIssues.count).toBe(1); // 異常はunit単位で同じ

    // periodはDASH-02（PH4）の期間集計用で、T047では語彙が定まらないため未対応（黙って無視しない）
    const withPeriod = await fx.client(member).request("GET", "/api/v1/dashboard?period=week");
    expect(withPeriod.status).toBe(400);
    expect((await json(withPeriod)).error?.code).toBe("VALIDATION_ERROR");

    // 停止された利用者は主体を引けない（401。scope以前の認可前置）
    expect((await fx.client(a.people.suspended).request("GET", "/api/v1/dashboard")).status).toBe(401);
  });
});
