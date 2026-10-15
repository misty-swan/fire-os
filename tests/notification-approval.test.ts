import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../src/server/mutations/hash";
import { buildNotificationDraft } from "../src/server/routes/notifications";
import type { ApiContext } from "../src/server/http";
import { createFixture, type TestFixture } from "./helpers/fixture";

/**
 * 通知本文・対象snapshotと明示承認API（T050、docs/05 API-63/64/65/67/100、docs/04 §3.4 139-142行、
 * docs/11 通知承認・配送、docs/10 PER-12、docs/14 D13、docs/07 §5）。
 * - 承認（API-64）はbodyHash/audienceHash/versionを固定する。対象や本文が変わった（＝別draftの）hashでの
 *   承認は409、旧版は409、draft以外の状態からの遷移は422。承認1回につき配送jobは1本だけ
 *   （dedupe_key=`${unitId}|notification.deliver|<通知ID>|<承認時の版>`。handlerはT051）。
 * - 本文/対象の変更は新draft（通知のUPDATEは無い）。取消はdraft→cancelledのみ。
 * - 宛先はaddress_ref（参照）だけを保存し、連絡先生値・氏名を複製しない（docs/04「連絡先生値をジョブへ複製しない」）。
 * - 投影（API-65）: 送信者（PER-12）は対象一覧・承認状態・配送job状態、対象者は本文・自分のreadAt・
 *   自分の配送状態まで。第三者は404。既読（API-100）は本人recipientのみ、旧版409、再読は初回readAt。
 * - 承認だけで読了/到達と表示しない（docs/07 §5「端末到達・既読…の保証をしない」）: T050では配送行が
 *   無いため myDelivery はnullのまま（配送jobの実行はT051）。
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

const deliverJobCount = async (unitId: string, notificationId?: string) =>
  (
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM jobs WHERE unit_id = ? AND kind = 'notification.deliver'" +
        (notificationId ? " AND source_id = ?" : ""),
    ).bind(...(notificationId ? [unitId, notificationId] : [unitId])).first<{ n: number }>()
  )!.n;

/** 活動1件（対象snapshot付き）を作る（API-06。admin=PER-03） */
async function createActivity(audienceMemberIds: string[]) {
  const admin = fx.units.a.people.admin;
  const res = await fx.client(admin).request("POST", "/api/v1/activities", {
    title: "秋季訓練（架空）",
    kind: "training",
    plannedStartsAt: "2026-11-01T01:00:00.000Z",
    locationText: "架空市中央公園",
    ownerMemberId: fx.units.a.people.officer.memberId!,
    audienceMemberIds,
  }, idem());
  expect(res.status).toBe(201);
  return ((await json(res)).data! as { id: string }).id;
}

describe("通知の明示承認・本人既読 (T050)", () => {
  it("notification_cannot_dispatch_unapproved_or_changed_audience", async () => {
    const a = fx.units.a;
    const admin = a.people.admin; // 分団長（PER-12は所属内＝送信者）
    const officer = a.people.officer; // 幹部（PER-12。対象者・回答済みにする）
    const member = a.people.member; // 一般団員（対象者・未回答）
    const operator = a.people.operator; // 担当者（scopeは施設のみ＝通知の管理権なし。対象者）

    // --- 準備: 活動の対象snapshotから未回答者を抽出する（T036/T047方式: 対象−回答あり） ---
    const activityId = await createActivity([member.memberId!, officer.memberId!]);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO activity_attendance (id, unit_id, activity_id, member_id, response, responded_at, created_at, updated_at, created_by, actor_kind) " +
        "VALUES (?, ?, ?, ?, 'attending', ?, ?, ?, ?, 'human')",
    ).bind(crypto.randomUUID(), a.id, activityId, officer.memberId!, now, now, now, admin.userId).run();

    // --- draft作成（API-63。本文/対象は源からの提案に任せる） ---
    const beforeApprovalDeliveryJobs = await deliverJobCount(a.id);
    const createRes = await fx.client(admin).request("POST", "/api/v1/notifications/drafts", {
      source: { type: "activity", id: activityId },
      channels: ["inapp"],
    }, idem());
    expect(createRes.status).toBe(201);
    const draft1 = (await json(createRes)).data! as {
      id: string; version: number; status: string; sourceType: string; sourceId: string;
      body: string; bodyHash: string; audienceHash: string; audienceMemberIds: string[];
      channels: string[]; recipients: { memberId: string; channel: string; addressRef: string; readAt: string | null }[];
      deliveryJob: unknown;
    };
    expect(draft1.status).toBe("draft");
    expect(draft1.version).toBe(1);
    expect(draft1.sourceType).toBe("activity");
    expect(draft1.sourceId).toBe(activityId);
    expect(draft1.body).toContain("秋季訓練"); // 既定文は活動名から組み立てる
    // 未回答者だけが対象（回答済みのofficerは入らない。対象snapshot基準）
    expect(draft1.audienceMemberIds).toEqual([member.memberId!]);
    expect(draft1.channels).toEqual(["inapp"]);
    expect(draft1.deliveryJob ?? null).toBeNull(); // draftには配送jobが無い
    // 宛先は参照（address_ref）だけ。氏名・連絡先生値は複製しない（docs/04）
    const recipientRows = await fx.rows("notification_recipients", { notification_id: draft1.id });
    expect(recipientRows).toHaveLength(1);
    expect(recipientRows[0]!.address_ref).toBe(`member:${member.memberId}#inbox`);
    expect(recipientRows[0]!.channel).toBe("inapp");
    expect(recipientRows[0]!.read_at).toBeNull();
    // draftの作成では配送jobを作らない
    expect(await deliverJobCount(a.id)).toBe(beforeApprovalDeliveryJobs);

    // --- 対象変更→新draft（docs/11「変更時新draft」。通知のUPDATEは無い） ---
    const create2Res = await fx.client(admin).request("POST", "/api/v1/notifications/drafts", {
      source: { type: "activity", id: activityId },
      body: "集合時刻が変わりました。予定ページを確認してください。",
      audienceMemberIds: [member.memberId!, operator.memberId!],
      channels: ["inapp"],
    }, idem());
    expect(create2Res.status).toBe(201);
    const draft2 = (await json(create2Res)).data! as typeof draft1;
    expect(draft2.id).not.toBe(draft1.id);
    expect(draft2.audienceMemberIds.sort()).toEqual([member.memberId!, operator.memberId!].sort());

    // --- 旧hash（別draftの対象）での承認は409（docs/05 API-64「送信明示承認」。承認は見たものを固定） ---
    const staleAudienceApproval = await fx.client(admin).request("POST", `/api/v1/notifications/${draft2.id}/approval`, {
      version: 1, bodyHash: draft2.bodyHash, audienceHash: draft1.audienceHash, decision: "approve",
    }, idem());
    expect(staleAudienceApproval.status).toBe(409);
    // 本文のhashが違っても409
    const staleBodyApproval = await fx.client(admin).request("POST", `/api/v1/notifications/${draft2.id}/approval`, {
      version: 1, bodyHash: draft1.bodyHash, audienceHash: draft2.audienceHash, decision: "approve",
    }, idem());
    expect(staleBodyApproval.status).toBe(409);
    // 旧版での承認も409（docs/05 §2「旧版409」）
    const staleVersionApproval = await fx.client(admin).request("POST", `/api/v1/notifications/${draft2.id}/approval`, {
      version: 9, bodyHash: draft2.bodyHash, audienceHash: draft2.audienceHash, decision: "approve",
    }, idem());
    expect(staleVersionApproval.status).toBe(409);
    // どの承認試行でも配送jobは増えない
    expect(await deliverJobCount(a.id)).toBe(beforeApprovalDeliveryJobs);

    // --- draftに対する本人既読は出来ない（未承認の通知は対象者に見せない） ---
    const draftRead = await fx.client(member).request("PUT", `/api/v1/notifications/${draft2.id}/read`, { notificationVersion: 1 }, idem());
    expect(draftRead.status).toBe(404);

    // --- 正しい版・hashでの承認（API-64。202=永続job受付。docs/05「Notification＋Job(202)」） ---
    const approveRes = await fx.client(admin).request("POST", `/api/v1/notifications/${draft2.id}/approval`, {
      version: 1, bodyHash: draft2.bodyHash, audienceHash: draft2.audienceHash, decision: "approve",
    }, idem());
    expect(approveRes.status).toBe(202);
    const approved = (await json(approveRes)).data! as { status: string; version: number; deliveryJob: { jobId: string; status: string } | null };
    expect(approved.status).toBe("approved");
    expect(approved.version).toBe(2);
    expect(approved.deliveryJob?.status).toBe("queued");
    // 承認1回につき配送jobは1本だけ（dedupe_key=`${unitId}|notification.deliver|<通知ID>|<承認時の版>`）
    const deliveryJobsPerApproval = await deliverJobCount(a.id, draft2.id);
    expect(deliveryJobsPerApproval).toBe(1);
    const jobRow = (await fx.rows("jobs", { dedupe_key: `${a.id}|notification.deliver|${draft2.id}|1` }));
    expect(jobRow).toHaveLength(1);
    expect(jobRow[0]!.status).toBe("queued");
    expect(jobRow[0]!.source_version).toBe(1);

    // --- 二重承認は拒否（旧版=409、現版でも状態前提で422。approved→dispatchingはT051の配送処理） ---
    const doubleApprove = await fx.client(admin).request("POST", `/api/v1/notifications/${draft2.id}/approval`, {
      version: 1, bodyHash: draft2.bodyHash, audienceHash: draft2.audienceHash, decision: "approve",
    }, idem());
    expect(doubleApprove.status).toBe(409);
    const approveAgain = await fx.client(admin).request("POST", `/api/v1/notifications/${draft2.id}/approval`, {
      version: 2, bodyHash: draft2.bodyHash, audienceHash: draft2.audienceHash, decision: "approve",
    }, idem());
    expect(approveAgain.status).toBe(422);
    expect(await deliverJobCount(a.id, draft2.id)).toBe(1);

    // --- 取消はdraft→cancelled（未送分の承認全体の取消。docs/16 T050裁定） ---
    const cancelRes = await fx.client(admin).request("POST", `/api/v1/notifications/${draft1.id}/approval`, {
      version: 1, bodyHash: draft1.bodyHash, audienceHash: draft1.audienceHash, decision: "cancel",
    }, idem());
    expect(cancelRes.status).toBe(200);
    expect(((await json(cancelRes)).data! as { status: string }).status).toBe("cancelled");
    expect(await deliverJobCount(a.id, draft1.id)).toBe(0);
    // 承認済みの取消は出来ない（配送後の未送分取消はT051のdeliveries単位。docs/11 通知承認行）
    const cancelApproved = await fx.client(admin).request("POST", `/api/v1/notifications/${draft2.id}/approval`, {
      version: 2, bodyHash: draft2.bodyHash, audienceHash: draft2.audienceHash, decision: "cancel",
    }, idem());
    expect(cancelApproved.status).toBe(422);

    // --- 本人既読（API-100。本人recipientのみ・版付き。docs/04「既読は本人recipient」） ---
    const memberReadRes = await fx.client(member).request("PUT", `/api/v1/notifications/${draft2.id}/read`, { notificationVersion: 2 }, idem());
    expect(memberReadRes.status).toBe(200);
    const receipt = (await json(memberReadRes)).data! as { readAt: string; notificationVersion: number };
    expect(receipt.notificationVersion).toBe(2);
    // 再読は初回readAtの同じ応答（行を増やさない。現行版を指定）
    const rereadRes = await fx.client(member).request("PUT", `/api/v1/notifications/${draft2.id}/read`, { notificationVersion: 3 }, idem());
    expect(rereadRes.status).toBe(200);
    expect(((await json(rereadRes)).data! as { readAt: string }).readAt).toBe(receipt.readAt);
    const memberRows = await fx.rows("notification_recipients", { notification_id: draft2.id, member_id: member.memberId! });
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]!.read_at).toBe(receipt.readAt);
    // 旧版（既読で進んだ後の旧notificationVersion）は409
    const staleVersionRead = await fx.client(operator).request("PUT", `/api/v1/notifications/${draft2.id}/read`, { notificationVersion: 2 }, idem());
    expect(staleVersionRead.status).toBe(409);
    // 対象者でない管理者による代理既読は403（既読は本人のみ。docs/10 PER-12「既読は本人のみ」）
    const otherRecipientRead = await fx.client(officer).request("PUT", `/api/v1/notifications/${draft2.id}/read`, { notificationVersion: 3 }, idem());
    expect(otherRecipientRead.status).toBe(403);
    // 別分団は404（存在を明かさない）
    const crossUnitRead = await fx.client(fx.units.b.people.member).request("PUT", `/api/v1/notifications/${draft2.id}/read`, { notificationVersion: 3 }, idem());
    expect(crossUnitRead.status).toBe(404);
    // 取消済み（未送信）の通知は対象者にも見えない
    const cancelledRead = await fx.client(member).request("PUT", `/api/v1/notifications/${draft1.id}/read`, { notificationVersion: 1 }, idem());
    expect(cancelledRead.status).toBe(404);

    // --- 投影（API-65）: 送信者は全体、対象者は自分の分だけ ---
    const senderView = (await json(await fx.client(admin).request("GET", `/api/v1/notifications/${draft2.id}`))).data! as Record<string, unknown>;
    expect(senderView.status).toBe("approved");
    expect((senderView.recipients as { memberId: string; readAt: string | null }[]).map((r) => r.memberId).sort())
      .toEqual([member.memberId!, operator.memberId!].sort());
    expect((senderView.recipients as { memberId: string; readAt: string | null }[]).find((r) => r.memberId === member.memberId!)!.readAt)
      .toBe(receipt.readAt);
    expect((senderView.deliveryJob as { status: string } | null)?.status).toBe("queued");
    expect(typeof senderView.bodyHash).toBe("string");
    const recipientView = (await json(await fx.client(member).request("GET", `/api/v1/notifications/${draft2.id}`))).data! as Record<string, unknown>;
    expect(recipientView.body).toBe(draft2.body);
    expect(recipientView.myReadAt).toBe(receipt.readAt);
    // 承認だけでは到達しない（docs/07 §5）。T050では配送行が無いため自分の配送状態はnull
    expect(recipientView.myDelivery ?? null).toBeNull();
    // 対象者には他者の宛先・対象一覧・承認hash・配送jobを見せない
    expect("recipients" in recipientView).toBe(false);
    expect("audienceMemberIds" in recipientView).toBe(false);
    expect("bodyHash" in recipientView).toBe(false);
    expect("deliveryJob" in recipientView).toBe(false);
    const operatorView = (await json(await fx.client(operator).request("GET", `/api/v1/notifications/${draft2.id}`))).data! as Record<string, unknown>;
    expect(operatorView.myReadAt ?? null).toBeNull();
    // 対象者でも取消済みは見えない／第三者（別分団）は404
    const cancelledView = await fx.client(member).request("GET", `/api/v1/notifications/${draft1.id}`);
    expect(cancelledView.status).toBe(404);
    const strangerView = await fx.client(fx.units.b.people.admin).request("GET", `/api/v1/notifications/${draft2.id}`);
    expect(strangerView.status).toBe(404);

    // --- 本人の一覧（API-67。対象者にだけ現れる。取消済みは載らない） ---
    const myList = ((await json(await fx.client(member).request("GET", "/api/v1/notifications/me"))).data! as unknown) as { id: string; myReadAt: string | null; status: string }[];
    expect(myList.some((row) => row.id === draft2.id && row.myReadAt === receipt.readAt)).toBe(true);
    expect(myList.some((row) => row.id === draft1.id)).toBe(false);
    // 送信者（PER-12）でもrecipientでなければ一覧に現れない（API-67は「本人のみ」）
    const adminList = ((await json(await fx.client(admin).request("GET", "/api/v1/notifications/me"))).data! as unknown) as { id: string }[];
    expect(adminList.some((row) => row.id === draft2.id)).toBe(false);
    // status条件
    const approvedOnly = ((await json(await fx.client(member).request("GET", "/api/v1/notifications/me?status=approved"))).data! as unknown) as { id: string; status: string }[];
    expect(approvedOnly.every((row) => row.status === "approved")).toBe(true);
  });

  it("notification_draft_proposals_from_announcement_and_inspection_due", async () => {
    const a = fx.units.a;
    const admin = a.people.admin;
    const member = a.people.member;

    // --- お知らせ（T045のrevision）からの引用提案 ---
    const annRes = await fx.client(admin).request("POST", "/api/v1/announcements", {
      title: "資機材の点検のお願い",
      body: "架空車両の点検期限が近づいています。",
      audienceMemberIds: [member.memberId!, a.people.operator.memberId!],
    }, idem());
    expect(annRes.status).toBe(201);
    const announcementId = ((await json(annRes)).data! as { id: string }).id;
    const annDraftRes = await fx.client(admin).request("POST", "/api/v1/notifications/drafts", {
      source: { type: "announcement", id: announcementId },
      channels: ["inapp"],
    }, idem());
    expect(annDraftRes.status).toBe(201);
    const annDraft = (await json(annDraftRes)).data! as { body: string; audienceMemberIds: string[] };
    expect(annDraft.body).toContain("資機材の点検のお願い"); // お知らせの本文を引用
    expect([...annDraft.audienceMemberIds].sort()).toEqual([member.memberId!, a.people.operator.memberId!].sort());

    // --- 点検期限（T048の検出ログ）からの既定文提案。対象は源から決められないため入力必須 ---
    const vehicleRes = await fx.client(admin).request("POST", "/api/v1/vehicles", {
      assetCode: "NTF-DUE-V", name: "架空ポンプ車", status: "運用",
    }, idem());
    expect(vehicleRes.status).toBe(201);
    const vehicleId = ((await json(vehicleRes)).data! as { id: string }).id;
    const dueDate = "2026-10-01";
    const scheduleRes = await fx.client(admin).request("PUT", `/api/v1/assets/vehicle/${vehicleId}/inspection-schedule`, {
      version: 0, nextDueDate: dueDate, timezone: "Asia/Tokyo",
    }, idem());
    expect(scheduleRes.status).toBe(201);
    const schedule = (await json(scheduleRes)).data! as { id: string; version: number };
    // 検出ログの行（T048のCronが書く。試験では直接INSERTして源にする）
    const detectionId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO inspection_due_detections (id, unit_id, target_type, target_id, schedule_id, schedule_version, due_date, detected_at, actor_kind, created_at) " +
        "VALUES (?, ?, 'vehicle', ?, ?, ?, ?, ?, 'system', ?)",
    ).bind(detectionId, a.id, vehicleId, schedule.id, schedule.version, dueDate, new Date().toISOString(), new Date().toISOString()).run();

    // 対象が無い提案は400（源から対象を決められない）
    const noAudience = await fx.client(admin).request("POST", "/api/v1/notifications/drafts", {
      source: { type: "inspection_due", id: detectionId },
      channels: ["inapp"],
    }, idem());
    expect(noAudience.status).toBe(400);
    expect(((await json(noAudience)).error?.details ?? [])[0]?.reason).toBe("audience_required_for_source");

    // buildNotificationDraftは本文/対象の提案組み立てまで（docs/16 T050のInterface）
    const proposal = await buildNotificationDraft(
      { env } as unknown as ApiContext,
      {
        unitId: a.id,
        source: { type: "inspection_due", id: detectionId },
        audienceMemberIds: [member.memberId!],
        channels: ["inapp"],
      },
    );
    expect(proposal.body).toContain("架空ポンプ車"); // 検出行の対象資産名
    expect(proposal.body).toContain(dueDate); // 期限日（業務日）
    expect(proposal.audienceMemberIds).toEqual([member.memberId!]);
    expect(proposal.sourceType).toBe("inspection_due");

    // 読めない源は400（存在しない検出行。docs/16 T050裁定「読めない源は400」）
    const unreadable = await fx.client(admin).request("POST", "/api/v1/notifications/drafts", {
      source: { type: "inspection_due", id: crypto.randomUUID() },
      audienceMemberIds: [member.memberId!],
      channels: ["inapp"],
    }, idem());
    expect(unreadable.status).toBe(400);
    // 契約に無い源の種別は400（未知の列挙値）
    const unknownSource = await fx.client(admin).request("POST", "/api/v1/notifications/drafts", {
      source: { type: "issue", id: crypto.randomUUID() },
      audienceMemberIds: [member.memberId!],
      channels: ["inapp"],
    }, idem());
    expect(unknownSource.status).toBe(400);

    // 全員が回答済みの活動からは未回答0人＝提案できない（422。空の対象の通知を作らない）
    const answeredActivity = await createActivity([officerOf(a)]);
    await env.DB.prepare(
      "INSERT INTO activity_attendance (id, unit_id, activity_id, member_id, response, responded_at, created_at, updated_at, created_by, actor_kind) " +
        "VALUES (?, ?, ?, ?, 'attending', ?, ?, ?, ?, 'human')",
    ).bind(crypto.randomUUID(), a.id, answeredActivity, officerOf(a), new Date().toISOString(), new Date().toISOString(), new Date().toISOString(), admin.userId).run();
    const emptyProposal = await fx.client(admin).request("POST", "/api/v1/notifications/drafts", {
      source: { type: "activity", id: answeredActivity },
      channels: ["inapp"],
    }, idem());
    expect(emptyProposal.status).toBe(422);
    expect(((await json(emptyProposal)).error?.details ?? [])[0]?.reason).toBe("empty_audience");

    // audienceHashは対象memberId整列配列の正規化JSONのSHA-256（docs/05 API-64の固定に使う値と同じ作り）
    const hash = await sha256Hex(canonicalJson([member.memberId!]));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

/** テスト内で幹部（officer）のmemberIdを取るヘルパー */
function officerOf(a: TestFixture["units"]["a"]): string {
  return a.people.officer.memberId!;
}
