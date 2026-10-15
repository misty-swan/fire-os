import { Dashboard, DashboardMetric, DashboardNextActivity } from "../../shared/contracts/operations";
import { activityConditions, queryActivities } from "../activities/query";
import { resolvePrincipal } from "../auth/principal";
import { BUSINESS_TIMEZONE, businessDateIn, overdueAssetCondition } from "../jobs/handlers/inspection-due";
import { HttpError, defineRoute, ok, parseApiRequest, type ApiApp, type ApiContext } from "../http";
import { requirePermission } from "./invitations";
import { attendanceResponses } from "../../shared/states";

/**
 * ホームの指標（T047、docs/05 API-28、DASH-01、AT-DASH-01、docs/10 PER-01）。
 * 全指標をこの要求の本人の所属unit（PER-01＝自unit。他unitの存在件数を漏らさない）で集計し、
 * 各数値に**同じ条件**の一覧へのfilterリンク（href）を付ける。数値と一覧件数の不一致を作らないため、
 * 活動は活動一覧（API-05）と同じ src/server/activities/query.ts の activityConditions／queryActivities で数え、
 * 異常は異常一覧（API-15）と同じ「unit_id＋status」の条件で数える（tests/dashboard.test.tsが両者の一致を確認する）。
 *
 * 指標と条件（docs/03 SCR-02「次回予定/本人未回答、確認待ち異常、点検期限、通知/自分タスク」）:
 * - 次回予定: status=scheduled かつ planned_starts_at >= 現在（from包含の半開区間。API-05のfromと同じ）。
 *   countはこの一覧の件数、id以降は最接近の1件（安定順 planned_starts_at,id の先頭。API-05と同じ）
 * - 本人未回答: 上の条件に「自分が対象snapshot（activity_audience）に含まれ、出欠の回答
 *   （activity_attendance.response != 'unanswered'。取り下げ行は未回答扱い。docs/11「未定と未回答は区別」）が無い」
 *   を加えたもの（T036の方式）。hrefは API-05 ?unanswered=true&from=&status=scheduled
 * - 確認待ち異常: issues.status='reported'（docs/03 SCR-07「未確認（確認待ち）」の語彙。確認中/対応中/対応実施は含めない）
 * - 点検期限（T048で接続）: 期限超過の資産点検scheduleの件数（JST暦日で next_due_date < 今日。docs/14 D06）。
 *   facilityはAPI-56の対象外（/assets配下はvehicle/equipmentのみ）のためcount対象外。廃止資産は除外
 *   （docs/14 D24の両建て）。hrefはAPI-18/19に`due=overdue`を付けた一覧（/app/assets?due=overdue）で、
 *   **件数は一覧（API-18＋API-19）と同じoverdueAssetConditionで数える**ため必ず一致する
 * - 通知・自分のタスク: API-67/API-68 は PH4 のため**未接続**（connected=false。docs/16 T047「0件と未実装を混同しない」）
 *
 * period は DASH-02（API-52、PH4）の期間集計用の予約で、T047では語彙が定まらないため値を受けない（指定は400）。
 */
export function registerDashboardRoutes(app: ApiApp): void {
  defineRoute(app, "API-28", async (c) => {
    const p = await resolvePrincipal(c);
    const { query } = await parseApiRequest(c, "API-28");
    requirePermission(p, "PER-01", { unitId: p.unitId, type: "activity" });
    if (query.period) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "query.period", reason: "unsupported_period" }]);
    }

    const me = p.memberId;
    // 現在時刻。時刻はInstant正規形（ミリ秒3桁Z）でactivitiesの列と文字列比較できる（docs/05 §1）
    const now = new Date().toISOString();

    // 次回予定の最接近1件は活動一覧（API-05）と同じ関数・同じ順で取る（ドリルダウン先の一覧と先頭が必ず一致する）
    const first = (await queryActivities(c, { query: { from: now, status: "scheduled", limit: 1 } })).items[0] ?? null;

    // これからの予定の件数と本人未回答の件数。API-05と同じactivityConditionsでWHEREを組み立てる
    const upcomingCount = await countActivities(c, p.unitId, { from: now, status: "scheduled" });
    const myUnansweredCount = await countActivities(c, p.unitId, { from: now, status: "scheduled", unanswered: true }, me);

    // 最接近の1件の回答内訳（対象snapshot基準。未回答＝対象−回答あり。docs/11 出欠行）と本人の回答
    let breakdown: { attending: number; undecided: number; absent: number; unanswered: number; myResponse: (typeof attendanceResponses)[number] | null; inAudience: boolean } =
      { attending: 0, undecided: 0, absent: 0, unanswered: 0, myResponse: null, inAudience: false };
    if (first) {
      const row = await c.env.DB.prepare(
        "SELECT " +
          "(SELECT COUNT(*) FROM activity_audience au WHERE au.activity_id = a.id) AS audience, " +
          "(SELECT COUNT(*) FROM activity_audience au WHERE au.activity_id = a.id AND EXISTS (" +
          "SELECT 1 FROM activity_attendance aa WHERE aa.activity_id = au.activity_id AND aa.member_id = au.member_id AND aa.response = 'attending')) AS attending, " +
          "(SELECT COUNT(*) FROM activity_audience au WHERE au.activity_id = a.id AND EXISTS (" +
          "SELECT 1 FROM activity_attendance aa WHERE aa.activity_id = au.activity_id AND aa.member_id = au.member_id AND aa.response = 'undecided')) AS undecided, " +
          "(SELECT COUNT(*) FROM activity_audience au WHERE au.activity_id = a.id AND EXISTS (" +
          "SELECT 1 FROM activity_attendance aa WHERE aa.activity_id = au.activity_id AND aa.member_id = au.member_id AND aa.response = 'absent')) AS absent, " +
          "EXISTS (SELECT 1 FROM activity_audience au3 WHERE au3.activity_id = a.id AND au3.member_id = ?) AS in_audience, " +
          "(SELECT aa.response FROM activity_attendance aa WHERE aa.activity_id = a.id AND aa.member_id = ?) AS my_response " +
          "FROM activities a WHERE a.id = ?",
      ).bind(me ?? "", me ?? "", first.id).first<{
        audience: number; attending: number; undecided: number; absent: number; in_audience: number; my_response: string | null;
      }>();
      if (row) {
        breakdown = {
          attending: row.attending, undecided: row.undecided, absent: row.absent,
          unanswered: Math.max(0, row.audience - row.attending - row.undecided - row.absent),
          // responseはDBのCHECKで出欠の列挙に制約される（docs/04）。念のため妥当値以外はnull（未回答表示）に落とす
          myResponse: (attendanceResponses as readonly string[]).includes(row.my_response ?? "")
            ? row.my_response as (typeof attendanceResponses)[number]
            : null,
          inAudience: row.in_audience === 1,
        };
      }
    }

    // 確認待ちの異常（issues.status='reported'。API-15のunit_id＋statusと同じ条件）
    const openIssueCount = (
      await c.env.DB.prepare("SELECT COUNT(*) AS n FROM issues WHERE unit_id = ? AND status = 'reported'").bind(p.unitId)
        .first<{ n: number }>()
    )?.n ?? 0;

    // 点検期限（T048）: 期限超過の資産点検scheduleの件数（JST暦日基準。docs/14 D06）。
    // 車両と資機材の2つの資産一覧の和（対象は1資産に1つなので二重計上はない）。
    // facilityはAPI-56の対象外のため含めない。API-18/19のdue=overdueと同じoverdueAssetCondition
    const todayJst = businessDateIn(BUSINESS_TIMEZONE, now);
    const inspectionDueCount =
      (await countOverdueAssets(c, p.unitId, "vehicles", todayJst)) +
      (await countOverdueAssets(c, p.unitId, "equipment", todayJst));

    // hrefは一覧画面がそのまま受けるfilterクエリ（T039の活動一覧・T034の点検管理と同じURL）
    const nextActivity = DashboardNextActivity.parse({
      count: upcomingCount, href: `/app/activities?status=scheduled&from=${encodeURIComponent(now)}`, connected: true,
      id: first?.id ?? null, title: first?.title ?? null, kind: first?.kind ?? null,
      plannedStartsAt: first?.plannedStartsAt ?? null, responseDueAt: first?.responseDueAt ?? null,
      ...breakdown,
    });
    const data = Dashboard.parse({
      nextActivity,
      myUnanswered: {
        count: myUnansweredCount, connected: true,
        href: `/app/activities?status=scheduled&from=${encodeURIComponent(now)}&unanswered=true${me ? `&memberId=${me}` : ""}`,
      },
      openIssues: DashboardMetric.parse({ count: openIssueCount, href: "/app/issues?status=reported", connected: true }),
      // 点検期限（T048で接続）。超過資産の一覧（/app/assets。API-18/19のdue=overdueをURLで受ける）
      inspectionDue: DashboardMetric.parse({
        count: inspectionDueCount, href: "/app/assets?due=overdue", connected: true,
      }),
      notifications: DashboardMetric.parse({ count: 0, href: null, connected: false }),
      myTasks: DashboardMetric.parse({ count: 0, href: null, connected: false }),
    });
    return ok(c, data);
  });
}

/** API-05と同じ条件（activityConditions）での件数。viewerMemberIdは本人未回答の「自分」 */
async function countActivities(
  c: ApiContext, unitId: string,
  filter: Parameters<typeof activityConditions>[0], viewerMemberId?: string | null,
): Promise<number> {
  const { where, binds } = activityConditions(filter, viewerMemberId ?? null);
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM activities a WHERE a.unit_id = ?${where.length ? " AND " + where.join(" AND ") : ""}`,
  ).bind(unitId, ...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * 期限超過の現役資産の件数（T048）。一覧（API-18/19のdue=overdue）と**同じ関数**（overdueAssetCondition）で
 * 数えるため、inspectionDueの件数とドリルダウン先一覧の件数が必ず一致する（T047の数値＝一覧件数と同じ方式）
 */
async function countOverdueAssets(c: ApiContext, unitId: string, table: "vehicles" | "equipment", todayJst: string): Promise<number> {
  const { where, binds } = overdueAssetCondition(table, todayJst);
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE unit_id = ? AND ${where}`,
  ).bind(unitId, ...binds).first<{ n: number }>();
  return row?.n ?? 0;
}
