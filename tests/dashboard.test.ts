import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createFixture, type TestClient, type TestFixture } from "./helpers/fixture";
import { rowCounts, withFailingInsert } from "./helpers/fail-insert";

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

    // 点検期限はseedしない（この試験では0件。接続済みの値と一覧の一致は下のitで確認する）

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

    // 接続済みの指標。通知（T052で接続）は自分宛・未読の件数、自分のタスクは担当の活動中タスク。
    // hrefはタスク・通知画面（SCR-21）のタブで、それぞれAPI-67（unread=true）・API-102と同じ条件で数えているため
    // 一覧の件数と必ず一致する（下のitで実データで確認する）。このitではseedが無いので0件
    expect(data.inspectionDue).toMatchObject({ count: 0, href: "/app/assets?due=overdue", connected: true });
    expect(data.notifications).toMatchObject({ count: 0, href: "/app/tasks-notifications?tab=notifications&unread=true", connected: true });
    expect(data.myTasks).toMatchObject({ count: 0, href: "/app/tasks-notifications?tab=tasks", connected: true });

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

  it("inspection_due_metric_matches_overdue_asset_lists (T048)", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 車両・資機材・期限の設定（PER-03）
    const member = a.people.member; // ダッシュボードと一覧の主体（PER-01）
    const b = fx.units.b;

    // 今日のJST暦日（試験側で独立に計算。docs/14 D06の業務日）
    const todayJst = new Intl.DateTimeFormat("en-ca", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const shift = (n: number) => new Date(new Date(`${todayJst}T00:00:00.000Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
    const mkVehicle = async (code: string) => {
      const res = await fx.client(admin).request("POST", "/api/v1/vehicles", { assetCode: code, name: `架空車両 ${code}`, status: "運用" }, idem());
      expect(res.status).toBe(201);
      return ((await json(res)).data! as { id: string }).id;
    };
    const putSchedule = async (type: "vehicle" | "equipment", id: string, nextDueDate: string, client: TestClient = fx.client(admin)) => {
      const res = await client.request("PUT", `/api/v1/assets/${type}/${id}/inspection-schedule`, {
        version: 0, nextDueDate, timezone: "Asia/Tokyo",
      }, idem());
      expect(res.status).toBe(201);
    };

    // seed: 超過車両／期限当日（未超過）／超過した廃止車両（対象外）／超過資機材／期限なし資機材／別分団の超過車両
    const overdueVehicle = await mkVehicle("DASH-DUE-V1");
    const dueTodayVehicle = await mkVehicle("DASH-DUE-V2");
    const retiredVehicle = await mkVehicle("DASH-DUE-V3");
    const equipmentRes = await fx.client(admin).request("POST", "/api/v1/equipment", { assetCode: "DASH-DUE-E1", name: "架空機材 DASH-DUE-E1", quantity: 1, quantityUnit: "本", storage: { note: "詰所" } }, idem());
    const overdueEquipment = ((await json(equipmentRes)).data! as { id: string }).id;
    const plainEquipmentRes = await fx.client(admin).request("POST", "/api/v1/equipment", { assetCode: "DASH-DUE-E2", name: "架空機材 DASH-DUE-E2", quantity: 1, quantityUnit: "本", storage: { note: "詰所" } }, idem());
    const plainEquipment = ((await json(plainEquipmentRes)).data! as { id: string }).id;
    await putSchedule("vehicle", overdueVehicle, shift(-3));
    await putSchedule("vehicle", dueTodayVehicle, todayJst); // 期限当日23:59までは未超過（docs/14 D06）
    await putSchedule("vehicle", retiredVehicle, shift(-5));
    await putSchedule("equipment", overdueEquipment, shift(-1));
    const bVehicle = await (async () => {
      const res = await fx.client(b.people.admin).request("POST", "/api/v1/vehicles", { assetCode: "DASH-DUE-B1", name: "別分団の車両", status: "運用" }, idem());
      expect(res.status).toBe(201);
      return ((await json(res)).data! as { id: string }).id;
    })();
    await putSchedule("vehicle", bVehicle, shift(-2), fx.client(b.people.admin));
    const retire = await fx.client(admin).request("PATCH", `/api/v1/vehicles/${retiredVehicle}`, { version: 1, status: "廃止" }, idem());
    expect(retire.status).toBe(200);

    // ホームの点検期限＝超過資産（車両＋資機材）の件数。hrefはその一覧（/app/assets?due=overdue）
    const res = await fx.client(member).request("GET", "/api/v1/dashboard");
    expect(res.status).toBe(200);
    const data = (await json(res)).data! as unknown as DashboardData;
    expect(data.inspectionDue.connected).toBe(true);
    expect(data.inspectionDue.href).toBe("/app/assets?due=overdue");

    // ドリルダウン先（API-18/19のdue=overdue）の件数の和と一致する（同じ条件関数で数えている）
    const vs = await fx.client(member).request("GET", "/api/v1/vehicles?due=overdue&limit=200");
    const es = await fx.client(member).request("GET", "/api/v1/equipment?due=overdue&limit=200");
    expect(vs.status).toBe(200);
    expect(es.status).toBe(200);
    const ids = [
      ...(((await json(vs)).data ?? []) as unknown as { id: string }[]),
      ...(((await json(es)).data ?? []) as unknown as { id: string }[]),
    ].map((r) => r.id);
    expect(data.inspectionDue.count).toBe(ids.length);
    // 超過は「超過車両＋超過資機材」の2件だけ（一覧は車両→資機材の順）
    expect(ids).toEqual([overdueVehicle, overdueEquipment]);
    // 期限当日は未超過、廃止・別分団・期限なしは入らない
    expect(ids).not.toContain(dueTodayVehicle);
    expect(ids).not.toContain(retiredVehicle);
    expect(ids).not.toContain(plainEquipment);
  });

  it("dashboard_task_and_notification_metrics_match_their_lists (T052)", async () => {
    const a = fx.units.a;
    const b = fx.units.b;
    const admin = a.people.admin; // 分団長（PER-04/12。タスクの作成と通知の承認）
    const member = a.people.member; // ダッシュボードの主体（PER-01）
    const officer = a.people.officer; // 通知の対象者（自分は既読にする）

    // --- seed: タスク。memberの担当は「open（活動中）」と「done（完了済み）」の2件。officerの担当も1件。
    // 別分団（unit b）にも1件（memberには見えない。PER-01＝自unit） ---
    const mkTask = async (title: string, assignee: string | undefined) => {
      const res = await fx.client(admin).request("POST", "/api/v1/tasks", {
        title, dueDate: "2026-12-01", ...(assignee ? { assigneeMemberId: assignee } : {}),
      }, idem());
      expect(res.status).toBe(201);
      return ((await json(res)).data! as { id: string; version: number });
    };
    const openTask = await mkTask("消火栓の表示板交換（T052）", member.memberId!);
    const doneTask = await mkTask("資機材の注文（T052・完了）", member.memberId!);
    await mkTask("訓練の備品確認（T052・幹部担当）", officer.memberId!);
    const bTaskRes = await fx.client(b.people.admin).request("POST", "/api/v1/tasks", {
      title: "別分団のタスク（T052）", assigneeMemberId: b.people.member.memberId!, dueDate: "2026-12-02",
    }, idem());
    expect(bTaskRes.status).toBe(201);
    const bTaskId = ((await json(bTaskRes)).data! as { id: string }).id;
    // doneTaskを完了まで進める（open→in_progress→done。openTaskは活動中のまま残す）
    await fx.client(admin).request("PATCH", `/api/v1/tasks/${doneTask.id}`, { version: 1, status: "in_progress", reason: "試験の進行" }, idem());
    const doneRes = await fx.client(admin).request("PATCH", `/api/v1/tasks/${doneTask.id}`, { version: 2, status: "done", reason: "試験の進行" }, idem());
    expect(doneRes.status).toBe(200);

    // --- seed: 通知。活動の未回答抽出（対象=memberとofficer）でdraft→承認（API-63/64） ---
    const actRes = await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "通知指標の源（T052）", kind: "訓練", plannedStartsAt: days(7), locationText: "架空市中央公園",
      ownerMemberId: officer.memberId!, audienceMemberIds: [member.memberId!, officer.memberId!],
    }, idem());
    expect(actRes.status).toBe(201);
    const actId = ((await json(actRes)).data! as { id: string }).id;
    const draftRes = await fx.client(admin).request("POST", "/api/v1/notifications/drafts", {
      source: { type: "activity", id: actId }, channels: ["inapp"],
    }, idem());
    expect(draftRes.status).toBe(201);
    const draft = (await json(draftRes)).data! as { id: string; version: number; bodyHash: string; audienceHash: string };
    const approveRes = await fx.client(admin).request("POST", `/api/v1/notifications/${draft.id}/approval`, {
      version: draft.version, bodyHash: draft.bodyHash, audienceHash: draft.audienceHash, decision: "approve",
    }, idem());
    expect(approveRes.status).toBe(202);
    // 承認で版が進む。officerは自分の分を既読にする（memberは未読のまま＝unread指標の検証対象）
    const officerView = (await json(await fx.client(officer).request("GET", `/api/v1/notifications/${draft.id}`))).data! as { version: number };
    const readRes = await fx.client(officer).request("PUT", `/api/v1/notifications/${draft.id}/read`, {
      notificationVersion: officerView.version,
    }, idem());
    expect(readRes.status).toBe(200);

    // --- ホーム（member）: 通知=自分宛・未読の1件、自分のタスク=担当の活動中（open）1件 ---
    const res = await fx.client(member).request("GET", "/api/v1/dashboard");
    expect(res.status).toBe(200);
    const data = (await json(res)).data! as unknown as DashboardData;
    expect(data.notifications.connected).toBe(true);
    expect(data.myTasks.connected).toBe(true);
    expect(data.notifications.href).toBe("/app/tasks-notifications?tab=notifications&unread=true");
    expect(data.myTasks.href).toBe("/app/tasks-notifications?tab=tasks");

    // 指標とhref先の一覧（同じ条件のAPI-67 unread=true／API-102）の件数が一致する（docs/05 API-28）
    const unreadList = ((await json(await fx.client(member).request("GET", "/api/v1/notifications/me?unread=true&limit=200")))
      .data ?? []) as unknown as { id: string; myReadAt: string | null }[];
    expect(data.notifications.count).toBe(unreadList.length);
    expect(unreadList.map((r) => r.id)).toEqual([draft.id]);
    expect(unreadList.every((r) => r.myReadAt === null)).toBe(true);
    const taskList = ((await json(await fx.client(member).request("GET", "/api/v1/tasks/me?limit=200")))
      .data ?? []) as unknown as { id: string; status: string }[];
    expect(data.myTasks.count).toBe(taskList.length);
    expect(taskList.map((r) => r.id)).toEqual([openTask.id]);
    expect(taskList.every((r) => ["open", "assigned", "in_progress"].includes(r.status))).toBe(true);

    // --- officer（自分は既読・担当タスク1件）と別分団（タスクは漏れない） ---
    const officerData = (await json(await fx.client(officer).request("GET", "/api/v1/dashboard"))).data! as unknown as DashboardData;
    expect(officerData.notifications.count).toBe(0); // 自分の分は既読済み
    expect(officerData.myTasks.count).toBe(1);
    // memberから別分団のタスクは件数にも一覧にも現れない（PER-01＝自unit）
    const bMemberList = ((await json(await fx.client(b.people.member).request("GET", "/api/v1/tasks/me?limit=200"))).data ?? []) as unknown as { id: string }[];
    expect(bMemberList.map((r) => r.id)).toEqual([bTaskId]);
    expect(taskList.some((r) => r.id === bTaskId)).toBe(false);

    // --- 完了済みは既定の一覧から外れるが、status=doneで確認できる（再開の導線。docs/11 業務タスク） ---
    const doneList = ((await json(await fx.client(member).request("GET", "/api/v1/tasks/me?status=done&limit=200")))
      .data ?? []) as unknown as { id: string }[];
    expect(doneList.map((r) => r.id)).toEqual([doneTask.id]);
  });
  // --- T085レビューB-I3（AT-DASH-01×CT-05の読取境界）: 数値の源のmutationが途中で失敗したとき、ホームの数値は変わらない
  //     （半端に書かれた出欠行で「未回答」が減ったりしない）。成功すれば同じ条件で1件減る ---
  it("home_numbers_do_not_change_when_a_source_mutation_fails_midway (T085 CT-05)", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const member = a.people.member;
    const startsAt = new Date(Date.now() + 5 * 864e5).toISOString();
    const act = (await json(await fx.client(admin).request("POST", "/api/v1/activities", {
      title: "読取境界の確認（架空）", kind: "訓練", plannedStartsAt: startsAt, locationText: "架空市", ownerMemberId: admin.memberId!, audienceMemberIds: [member.memberId!],
    }, { "idempotency-key": crypto.randomUUID() }))).data! as { id: string };
    const pub = await fx.client(admin).request("PATCH", `/api/v1/activities/${act.id}`, { version: 1, status: "scheduled", reason: "公開" }, { "idempotency-key": crypto.randomUUID() });
    expect(pub.status, JSON.stringify(await pub.clone().json())).toBe(200);
    const home = async () => ((await json(await fx.client(member).request("GET", "/api/v1/dashboard"))).data! as unknown as DashboardData).myUnanswered.count;
    const before = await home();
    const countsBefore = await rowCounts(["activity_attendance", "attendance_events", "audit_logs", "domain_events"]);
    const answer = () => fx.client(member).request("PUT", `/api/v1/activities/${act.id}/attendance/me`, { version: 0, response: "attending" }, { "idempotency-key": crypto.randomUUID() });
    // 出欠行の後、出欠の履歴の文で失敗
    const failed = await withFailingInsert("attendance_events", answer);
    expect(failed.status, JSON.stringify(await failed.clone().json())).toBeGreaterThanOrEqual(500);
    expect(await rowCounts(["activity_attendance", "attendance_events", "audit_logs", "domain_events"])).toEqual(countsBefore);
    expect(await home()).toBe(before);
    expect((await answer()).status).toBe(201);
    expect(await home()).toBe(before - 1);
  });
});
