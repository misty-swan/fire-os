import { Analytics, type AnalyticsDto } from "../../shared/contracts/operations";
import type { ParsedRequest } from "../../shared/contracts/registry";
import { activityConditions } from "../activities/query";
import { businessDateIn, BUSINESS_TIMEZONE } from "../jobs/handlers/inspection-due";
import { HttpError, type ApiContext } from "../http";
import type { AuthzPrincipal } from "../auth/principal";

/**
 * 月次・年度・団員別集計（T060、docs/05 API-52/§5集計契約、docs/04 §3.2末尾、docs/03 SCR-26、
 * docs/10 PER-01、AT-ACT-06/DASH-02）。activities/query.ts の activityConditions を**そのまま共有**し、
 * 集計の数値とドリルダウン先一覧（API-05）の条件の食い違いを作らない（T047のdashboard.tsと同じ方式）。
 *
 * **単位（二重計上の排除。docs/04「operationを共有する活動と出動は一つの出来事として数える」）:**
 * - 出来事の件数はoperations単位。活動側は「現有効実績のある活動」（API-05 actual=trueと同じ条件＝
 *   countable=1のoperation＋現行revisionのparticipated行。取消はcountable=0で外れる）、出動側は
 *   occurred_atが期間内でoperations.countable=1（voidedで0になる）。両者の和集合をDISTINCT operationで数える
 * - 延べ参加はoperation×member単位。実参加は活動の現行実績のparticipated行と出動の
 *   参集中/参集済/帰還記録（mobilizing/arrived/returned。docs/11。出動不可・未確認は実参加でない）の和集合
 * - 時間はdocs/14 D05案の検証設定（実活動全体時間と実参加を基準。個人時間は別欄で合算しない）。
 *   活動の現行実績にactualStartsAt/actualEndsAtの両方が無い出来事・出動は時間「未入力」で、
 *   0として合算せずunknownOperationIds/members.unknownOperationCountで示す（0時間と表示しない）
 * - 期間はfrom包含/to排他。年度はdocs/14 D05案の**検証設定**（開始月4月・JST業務日。了承済みとは扱わない。
 *   docs/05 §9）。fiscalYearとfrom/toの同時指定は整合検査し、食い違いは400
 * - 応答のsourcesは数値の元データ（drilldownIds）。activitiesのid集合はAPI-05を同じクエリで開いたid集合と
 *   完全一致（同じactivityConditionsで数えるため）。incidentsのid集合はAPI-21の同じ条件から無効(voided)を
 *   除いた集合と一致する（API-21はvoidedも閲覧可能なため。docs/05 API-21）
 */

/** 年度の開始月（docs/14 D05案の検証設定。未承認のため応答のsettings.approvedは常にfalse） */
export const FISCAL_YEAR_START_MONTH = 4;

/** JSTの瞬間を暦月（YYYY-MM）へ。JSTは夏時間が無いため+9hの平行移動で正確（businessDateInと同じ根拠） */
const jstMonth = (iso: string): string => new Date(new Date(iso).getTime() + 9 * 3_600_000).toISOString().slice(0, 7);

/** fiscalYear年の年度開始の瞬間（検証設定: 開始月4日1日のJST 0時＝UTCでは前日の15時。JSTは夏時間が無い。docs/14 D06の業務日） */
export const fiscalYearStart = (fy: number): string => `${fy}-03-31T15:00:00.000Z`;
const fiscalYearEnd = (fy: number): string => fiscalYearStart(fy + 1);

/** 指定が無い場合の既定期間＝現在の年度（JSTの暦日で判定。docs/14 D06「日付期限は業務日」） */
export const currentFiscalYear = (nowIso: string): number => {
  const day = businessDateIn(BUSINESS_TIMEZONE, nowIso); // YYYY-MM-DD
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return month >= FISCAL_YEAR_START_MONTH ? year : year - 1;
};

interface ResolvedPeriod {
  from: string;
  to: string;
  fiscalYear: number | null;
}

/**
 * 要求の期間（from/to/fiscalYear）を実際に適用する半開区間へ解決する。
 * - fiscalYearだけ → その年度の起終（検証設定の境界）
 * - from/toだけ → そのまま（片側だけの指定も可。nullは開区間）
 * - 両方 → from/toが年度の起終と完全一致するときだけ可（食い違いは400。docs/05「fiscalYearパラメータと
 *   from/toの両対応（同時指定の整合検査）」）
 * - どちらも無い → 現在の年度
 * - from>=toは400（空の期間は条件の誤りとして受け付けない）
 */
export function resolvePeriod(query: ParsedRequest<"API-52">["query"], nowIso: string): ResolvedPeriod {
  const fy = query.fiscalYear ?? null;
  const hasRange = query.from !== undefined || query.to !== undefined;
  if (fy !== null && hasRange) {
    if (query.from !== fiscalYearStart(fy) || query.to !== fiscalYearEnd(fy)) {
      throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "query.fiscalYear", reason: "fiscal_year_range_mismatch" }]);
    }
  }
  if (query.from && query.to && query.from >= query.to) {
    throw new HttpError("VALIDATION_ERROR", undefined, [{ field: "query.to", reason: "to_must_be_after_from" }]);
  }
  if (hasRange) {
    return { from: query.from ?? "", to: query.to ?? "", fiscalYear: fy };
  }
  const resolved = fy ?? currentFiscalYear(nowIso);
  return { from: fiscalYearStart(resolved), to: fiscalYearEnd(resolved), fiscalYear: resolved };
}

interface ActivityRow {
  id: string; operation_id: string; title: string; kind: string;
  planned_starts_at: string; actual_starts_at: string | null; actual_ends_at: string | null;
}
interface IncidentRow {
  id: string; operation_id: string; kind: string; summary: string; occurred_at: string;
}
interface ParticipationRow { member_id: string; operation_id: string }

/** 出動の「実参加」（docs/11の語彙。参集中/参集済/帰還記録。出動不可・未確認は実参加でない） */
const MOBILIZED_STATUSES = "('mobilizing', 'arrived', 'returned')";

/**
 * API-52の集計。認可（PER-01＝自unitのみ）は呼び出し側（routes/analytics.ts）で済ませ、
 * ここではunitIdを前提に集計する。詳細の単位と条件はAnalytics契約の注記（contracts/operations.ts）どおり。
 */
export async function queryAnalytics(c: ApiContext, p: AuthzPrincipal, query: ParsedRequest<"API-52">["query"]): Promise<AnalyticsDto> {
  const now = new Date().toISOString();
  const { from, to, fiscalYear } = resolvePeriod(query, now);
  const memberId = query.memberId ?? null;
  const kind = query.kind ?? null;

  // memberIdは自unitの団員だけ（存在しない/別unitは同じ404。存在を明かさない。docs/10 §3）
  if (memberId) {
    const member = await c.env.DB.prepare("SELECT unit_id FROM members WHERE id = ?").bind(memberId)
      .first<{ unit_id: string }>();
    if (!member || member.unit_id !== p.unitId) throw new HttpError("NOT_FOUND");
  }

  // 活動側はAPI-05と同じactivityConditions（actual=true。memberId指定時はその団員の実参加）で集める。
  // viewerMemberIdは未回答検索用のため使わない（null）
  const { where: filterWhere, binds: filterBinds } = activityConditions(
    { from: from || undefined, to: to || undefined, kind: kind ?? undefined, actual: true, ...(memberId ? { memberId } : {}) },
    null,
  );

  // 集計対象の活動（現行実績の全体時間つき。actual=true条件が実績の存在を保証するためJOINで行は落ちない）
  const activityRows = (
    await c.env.DB.prepare(
      "SELECT a.id, a.operation_id, a.title, a.kind, a.planned_starts_at, v.actual_starts_at, v.actual_ends_at " +
        "FROM activities a " +
        "JOIN activity_results r ON r.unit_id = a.unit_id AND r.activity_id = a.id " +
        "JOIN activity_result_revisions v ON v.unit_id = r.unit_id AND v.result_id = r.id AND v.id = r.current_revision_id " +
        `WHERE a.unit_id = ?${filterWhere.length ? " AND " + filterWhere.join(" AND ") : ""}`,
    ).bind(p.unitId, ...filterBinds).all<ActivityRow>()
  ).results;

  // 活動の実参加（現行revisionのparticipated行。docs/11 実参加）
  const activityPartRows = activityRows.length
    ? (
      await c.env.DB.prepare(
        "SELECT ap.member_id, a.operation_id " +
          "FROM activities a " +
          "JOIN activity_results r ON r.unit_id = a.unit_id AND r.activity_id = a.id " +
          "JOIN activity_result_revisions v ON v.unit_id = r.unit_id AND v.result_id = r.id AND v.id = r.current_revision_id " +
          "JOIN activity_actual_participants ap ON ap.result_revision_id = v.id AND ap.actual_status = 'participated' " +
          `WHERE a.unit_id = ?${filterWhere.length ? " AND " + filterWhere.join(" AND ") : ""}`,
      ).bind(p.unitId, ...filterBinds).all<ParticipationRow>()
    ).results
    : [];

  // 出動側（kind指定時はactivities.kindの語彙で出動のkindと一致しないため含めない。docs/05 API-52）。
  // 有効な出動だけ（voidedでcountable=0。docs/04「無効時countable=0」）。memberId指定時はその団員の実参加だけ
  const incidentWhere = [
    "i.unit_id = ?",
    ...(from ? ["i.occurred_at >= ?"] : []),
    ...(to ? ["i.occurred_at < ?"] : []),
    "EXISTS (SELECT 1 FROM operations o WHERE o.unit_id = i.unit_id AND o.id = i.operation_id AND o.countable = 1)",
    ...(memberId
      ? [`EXISTS (SELECT 1 FROM incident_participants ipx WHERE ipx.incident_id = i.id AND ipx.member_id = ? AND ipx.attendance_status IN ${MOBILIZED_STATUSES})`]
      : []),
  ];
  const incidentBinds: unknown[] = [p.unitId, ...(from ? [from] : []), ...(to ? [to] : []), ...(memberId ? [memberId] : [])];
  const incidentRows = kind
    ? []
    : (
      await c.env.DB.prepare(
        `SELECT i.id, i.operation_id, i.kind, i.summary, i.occurred_at FROM incidents i WHERE ${incidentWhere.join(" AND ")}`,
      ).bind(...incidentBinds).all<IncidentRow>()
    ).results;

  const incidentPartRows = kind
    ? []
    : (
      await c.env.DB.prepare(
        "SELECT ip.member_id, i.operation_id FROM incidents i " +
          `JOIN incident_participants ip ON ip.incident_id = i.id AND ip.attendance_status IN ${MOBILIZED_STATUSES} ` +
          `WHERE ${incidentWhere.join(" AND ")}`,
      ).bind(...incidentBinds).all<ParticipationRow>()
    ).results;

  // --- 出来事（distinct operation）の組み立て。錨時刻は活動（planned_starts_at）を優先し、無い出動はoccurred_at ---
  interface OpEntry {
    anchorAt: string;
    durationMinutes: number | null; // null=時間未入力（活動に全体時間が無い／出動のみ）
    activity?: ActivityRow;
    incident?: IncidentRow;
  }
  const ops = new Map<string, OpEntry>();
  for (const r of activityRows) {
    const known = r.actual_starts_at !== null && r.actual_ends_at !== null;
    ops.set(r.operation_id, {
      anchorAt: r.planned_starts_at,
      durationMinutes: known ? Math.round((new Date(r.actual_ends_at!).getTime() - new Date(r.actual_starts_at!).getTime()) / 60_000) : null,
      activity: r,
    });
  }
  for (const r of incidentRows) {
    const existing = ops.get(r.operation_id);
    if (existing) existing.incident = r; // リンク対（同operation）。錨は活動側のまま維持
    else ops.set(r.operation_id, { anchorAt: r.occurred_at, durationMinutes: null, incident: r });
  }

  // --- 延べ参加（operation×memberで重複除去。実参加の和集合。docs/04「団員の延べ参加はoperation/member単位で重複除去」）。
  // memberId指定時は「その団員の集計」のため、当該団員の実参加対だけに絞る（他の参加者はmembersにも載せない） ---
  const participationRows = [...activityPartRows, ...incidentPartRows].filter((r) => !memberId || r.member_id === memberId);
  const pairs = new Set<string>();
  for (const row of participationRows) {
    if (ops.has(row.operation_id)) pairs.add(`${row.operation_id}\u0000${row.member_id}`);
  }

  // --- 月次・団員別・合計 ---
  const byMonth = new Map<string, { operationCount: number; memberPairs: Set<string>; unknown: number }>();
  const monthOf = (operationId: string) => jstMonth(ops.get(operationId)!.anchorAt);
  for (const [operationId, op] of ops) {
    const m = byMonth.get(monthOf(operationId)) ?? { operationCount: 0, memberPairs: new Set<string>(), unknown: 0 };
    m.operationCount += 1;
    if (op.durationMinutes === null) m.unknown += 1;
    byMonth.set(monthOf(operationId), m);
  }
  for (const pair of pairs) {
    const [operationId, member] = pair.split("\u0000");
    const m = byMonth.get(monthOf(operationId!));
    if (m) m.memberPairs.add(pair);
  }

  const memberIds = new Set([...pairs].map((pair) => pair.split("\u0000")[1]!));
  // 団員名は同unitの名簿から。IN句はD1のbind上限（100）を超えないよう分割する
  const nameRows: { id: string; display_name: string }[] = [];
  const idList = [...memberIds];
  for (let i = 0; i < idList.length; i += 90) {
    const chunk = idList.slice(i, i + 90);
    nameRows.push(
      ...(
        await c.env.DB.prepare(
          `SELECT id, display_name FROM members WHERE unit_id = ? AND id IN (${chunk.map(() => "?").join(",")})`,
        ).bind(p.unitId, ...chunk).all<{ id: string; display_name: string }>()
      ).results,
    );
  }
  const names = new Map(nameRows.map((r) => [r.id, r.display_name]));

  const memberRows = [...memberIds].map((memberId2) => {
    const memberOps = [...ops.keys()].filter((operationId) => pairs.has(`${operationId}\u0000${memberId2}`));
    const known = memberOps.reduce((sum, operationId) => sum + (ops.get(operationId)!.durationMinutes ?? 0), 0);
    const unknown = memberOps.filter((operationId) => ops.get(operationId)!.durationMinutes === null).length;
    return {
      memberId: memberId2,
      displayName: names.get(memberId2) ?? "",
      operationCount: memberOps.length,
      knownDurationMinutes: known,
      unknownOperationCount: unknown,
    };
  }).sort((x, y) =>
    y.operationCount - x.operationCount ||
    x.displayName.localeCompare(y.displayName, "ja") ||
    (x.memberId < y.memberId ? -1 : 1),
  );

  const unknownOperationIds = [...ops.entries()].filter(([, op]) => op.durationMinutes === null).map(([id]) => id);
  const anchorOrder = (a: string, b: string) => {
    const diff = ops.get(a)!.anchorAt.localeCompare(ops.get(b)!.anchorAt);
    return diff !== 0 ? diff : (a < b ? -1 : 1);
  };

  // 元データの一覧へのfilter（画面がそのまま受けるURL。activitiesはAPI-05 actual=trueと同じ条件＝id集合が一致）
  const listParams = new URLSearchParams();
  if (from) listParams.set("from", from);
  if (to) listParams.set("to", to);
  if (kind) listParams.set("kind", kind);
  listParams.set("actual", "true");
  if (memberId) listParams.set("memberId", memberId);
  const incidentsParams = new URLSearchParams();
  if (from) incidentsParams.set("from", from);
  if (to) incidentsParams.set("to", to);

  return Analytics.parse({
    period: { from: from || null, to: to || null },
    fiscalYear,
    kind,
    memberId,
    unitId: p.unitId,
    settings: { fiscalYearStartMonth: FISCAL_YEAR_START_MONTH, approved: false },
    totals: {
      operationCount: ops.size,
      memberCount: pairs.size,
      knownDurationMinutes: [...ops.values()].reduce((sum, op) => sum + (op.durationMinutes ?? 0), 0),
    },
    unknownOperationIds: unknownOperationIds.sort(anchorOrder),
    monthly: [...byMonth.entries()]
      .map(([month, m]) => ({ month, operationCount: m.operationCount, memberCount: m.memberPairs.size, unknownOperationCount: m.unknown }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    members: memberRows,
    sources: {
      distinctOperationIds: [...ops.keys()].sort(anchorOrder),
      activities: activityRows
        .map((r) => ({ id: r.id, operationId: r.operation_id, title: r.title, kind: r.kind, plannedStartsAt: r.planned_starts_at }))
        .sort((a, b) => a.plannedStartsAt.localeCompare(b.plannedStartsAt) || (a.id < b.id ? -1 : 1)),
      incidents: incidentRows
        .map((r) => ({ id: r.id, operationId: r.operation_id, summary: r.summary, kind: r.kind, occurredAt: r.occurred_at }))
        .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || (a.id < b.id ? -1 : 1)),
      filters: {
        activitiesHref: `/app/activities?${listParams.toString()}`,
        incidentsHref: `/app/incidents?${incidentsParams.toString()}`,
      },
    },
  });
}
