import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleJob, runDueJobs } from "../src/server/jobs/runner";
import "../src/server/jobs/handlers/notification"; // 配送job handlerの登録（file-inspection.test.tsと同じ流儀）
import { completeJob, leaseJob } from "../src/server/jobs/store";
import { cancelUnsentDeliveries, dispatchNotification } from "../src/server/notifications/dispatcher";
import {
  registerChannelProvider,
  type DeliveryResult,
  type NotificationProvider,
} from "../src/server/notifications/provider";
import { createFixture, type TestFixture } from "./helpers/fixture";

/**
 * 通知の実配送と再送安全性（T051、docs/11 配送、docs/04:141 notification_deliveries、docs/14 D13/D16、
 * docs/16 T051、docs/02 §5「外部効果の一回性はhandlerの責務」）。
 * - providerは試験用の記録型fake adapter（send呼出しとdeliveryKeyを記録）で差し替える。
 *   実チャネル（Web Push/email）は docs/evidence/V06-delivery.md に未実施の手順として記録（D13未了承）。
 * - delivery_keyは再試行で固定（`${通知ID}|${recipientId}|${channel}`。UNIQUEで二重作成防止）。
 * - unknown（受付不明）は無条件に再送しない（非冪等providerへの2回目のsendを起こさない）。
 * - 受付（provider_accepted）は既読を作らない（受付≠到達≠既読。docs/07 §5）。
 * - 未送分の取消はdeliveries単位（pending→cancelledのみ。docs/11）。
 * - 期限切れ（expires_at経過）・退団（retired）宛先は送らない。
 */
let fx: TestFixture;
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

// --- 試験用の記録型provider（fake adapter。宛先ごとに挙動を注入できる） ---
interface FakeCall {
  deliveryKey: string;
  addressRef: string;
  body: string;
}
const fake = {
  calls: [] as FakeCall[],
  behaviors: new Map<string, (call: FakeCall, nth: number) => DeliveryResult | Promise<DeliveryResult>>(),
  on(addressRef: string, behave: (call: FakeCall, nth: number) => DeliveryResult | Promise<DeliveryResult>) {
    this.behaviors.set(addressRef, behave);
  },
  reset() {
    this.calls = [];
    this.behaviors.clear();
  },
};
const fakeProvider: NotificationProvider = {
  channel: "inapp",
  id: "fake-inapp",
  async send(input) {
    fake.calls.push(input);
    const nth = fake.calls.filter((c) => c.addressRef === input.addressRef).length;
    const behave = fake.behaviors.get(input.addressRef);
    return behave ? behave(input, nth) : { kind: "provider_accepted", providerId: "fake-inapp" };
  },
};
registerChannelProvider(fakeProvider);

beforeEach(async () => {
  // 他のit・他テストのjobを拾わない（lease欄も戻す。jobs.test.tsと同じ流儀）
  await env.DB.prepare(
    "UPDATE jobs SET status = 'cancelled', lease_token = NULL, lease_until = NULL WHERE status IN ('queued', 'running', 'retry_wait')",
  ).run();
  fake.reset();
});

const idem = () => ({ "idempotency-key": crypto.randomUUID() });
const json = async (r: Response) => (await r.json()) as { data?: Record<string, unknown> };

/** 活動1件（対象snapshot付き）を作る（API-06。T050と同じ流儀） */
async function createActivity(audienceMemberIds: string[]): Promise<string> {
  const a = fx.units.a;
  const res = await fx.client(a.people.admin).request("POST", "/api/v1/activities", {
    title: "配送試験用の訓練（架空）",
    kind: "training",
    plannedStartsAt: "2026-11-02T01:00:00.000Z",
    locationText: "架空市中央公園",
    ownerMemberId: a.people.officer.memberId!,
    audienceMemberIds,
  }, idem());
  expect(res.status).toBe(201);
  return ((await json(res)).data! as { id: string }).id;
}

interface NotificationDraft {
  id: string;
  version: number;
  bodyHash: string;
  audienceHash: string;
  audienceMemberIds: string[];
}

/** 通知draftを作る（API-63。源=活動の未回答抽出。全員未回答なら対象は引数どおり） */
async function createNotificationDraft(memberIds: string[], opts: { expiresAt?: string } = {}): Promise<NotificationDraft> {
  const activityId = await createActivity(memberIds);
  const res = await fx.client(fx.units.a.people.admin).request("POST", "/api/v1/notifications/drafts", {
    source: { type: "activity", id: activityId },
    channels: ["inapp"],
    ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
  }, idem());
  expect(res.status).toBe(201);
  return (await json(res)).data! as unknown as NotificationDraft;
}

/** 承認（API-64 approve＝配送job受付の202）してjob行を返す */
async function approveAndJob(draft: NotificationDraft) {
  const a = fx.units.a;
  const res = await fx.client(a.people.admin).request("POST", `/api/v1/notifications/${draft.id}/approval`, {
    version: draft.version, bodyHash: draft.bodyHash, audienceHash: draft.audienceHash, decision: "approve",
  }, idem());
  expect(res.status).toBe(202);
  const rows = await fx.rows("jobs", { dedupe_key: `${a.id}|notification.deliver|${draft.id}|${draft.version}` });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("queued");
  return rows[0]! as unknown as { id: string; status: string };
}

/** jobを即座に実行可能にする（runDueJobsは実時刻基準。再試行の60秒待ちを実時間待たない） */
const makeJobRunnable = async (jobId: unknown) => {
  await env.DB.prepare("UPDATE jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(jobId).run();
};

/** 通知の宛先1人のrecipient行 */
async function recipientOf(notificationId: string, memberId: string): Promise<Record<string, unknown>> {
  const rows = await fx.rows("notification_recipients", { notification_id: notificationId, member_id: memberId });
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** 通知宛先のdeliveries行（recipient_idでJOIN。it間でDBが共有のため通知単位で確認する） */
async function deliveriesOf(notificationId: string): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare(
    "SELECT d.* FROM notification_deliveries d JOIN notification_recipients r ON r.id = d.recipient_id AND r.unit_id = d.unit_id " +
      "WHERE r.notification_id = ? ORDER BY d.created_at",
  ).bind(notificationId).all()).results as Record<string, unknown>[];
}

async function eventsOf(notificationId: string): Promise<Record<string, unknown>[]> {
  return await fx.rows("notification_events", { notification_id: notificationId });
}

describe("通知の実配送と再送安全性 (T051)", () => {
  it("unknown_delivery_is_not_blindly_retried", async () => {
    const a = fx.units.a;
    const memberA = a.people.member.memberId!;
    const memberB = a.people.officer.memberId!;
    const memberC = a.people.operator.memberId!;
    const refA = `member:${memberA}#inbox`;
    const refB = `member:${memberB}#inbox`;
    // 挙動: A=1回目は拒否（→再送で受付）、B=受付不明（unknown）、C=常時受付
    fake.on(refA, (_call, nth) => (nth === 1 ? { kind: "failed", errorCode: "provider_rejected" } : { kind: "provider_accepted", providerId: "fake-inapp-2nd" }));
    fake.on(refB, () => ({ kind: "unknown" }));

    const draft = await createNotificationDraft([memberA, memberB, memberC]);
    const job = await approveAndJob(draft);
    await makeJobRunnable(job.id);
    const recA = await recipientOf(draft.id, memberA);
    const recB = await recipientOf(draft.id, memberB);
    const recC = await recipientOf(draft.id, memberC);

    // --- 1回目の実行: Aは拒否（再送待ち）、Bは受付不明、Cは受付 ---
    expect((await runDueJobs(env)).committed).toBe(1);
    const afterFirst = await deliveriesOf(draft.id);
    expect(afterFirst).toHaveLength(3); // 3宛先とも行は1本ずつ（delivery_key UNIQUE）
    const rowOf = (recipientId: unknown) => afterFirst.find((d) => d.recipient_id === recipientId)!;
    expect(rowOf(recA.id).status).toBe("retry_wait"); // 拒否→retry_wait（docs/11 failed→retry_wait→sending）
    expect(rowOf(recB.id).status).toBe("unknown"); // 受付不明＝盲目的に再送しない
    expect(rowOf(recC.id).status).toBe("provider_accepted");
    expect(rowOf(recA.id).last_error_code).toBe("provider_rejected");
    // 承認（root）は配送中へ（docs/11 approved→dispatching）
    expect(((await fx.rows("notifications", { id: draft.id }))[0]!.status)).toBe("dispatching");
    // 受付が既読を作らない（受付≠到達≠既読。docs/07 §5）
    expect(recC.read_at).toBeNull();

    // --- 2回目の実行（再試行）: Aだけ再送。B（unknown）への2回目のsendは起きない ---
    await makeJobRunnable(job.id);
    expect((await runDueJobs(env)).committed).toBe(1);
    expect(((await fx.rows("notifications", { id: draft.id }))[0]!.status)).toBe("finished");
    expect(((await fx.rows("jobs", { id: job.id }))[0]!.status)).toBe("succeeded");

    // delivery_keyは再試行でも同じ（deliveries行は1本・固定キー。attemptは2）
    const fixedKey = `${draft.id}|${recA.id}|inapp`;
    expect(rowOf(recA.id).delivery_key).toBe(fixedKey);
    const rowA2 = (await deliveriesOf(draft.id)).find((d) => d.recipient_id === recA.id)!;
    expect(rowA2.attempt_count).toBe(2);
    expect(rowA2.status).toBe("provider_accepted");
    const deliveryKeysAcrossRetries = fake.calls.filter((c) => c.addressRef === refA).map((c) => c.deliveryKey);
    expect(deliveryKeysAcrossRetries).toEqual([fixedKey, fixedKey]);
    // unknownへの非冪等な2回目のsendは発生しない（受付後不明の宛先は照会/人確認に回す）
    const unknownNonIdempotentSendCount = fake.calls.filter((c) => c.addressRef === refB).length;
    expect(unknownNonIdempotentSendCount).toBe(1);
    // 受付（provider_accepted）は既読を作らない
    const acceptedMarkedRead = (await recipientOf(draft.id, memberC)).read_at !== null;
    expect(acceptedMarkedRead).toBe(false);
    // providerIdがdeliveriesへ記録される（C宛の1回目のsendのproviderId）
    expect(rowOf(recC.id).provider_id).toBe("fake-inapp");
    // 試行履歴がnotification_eventsへ追記される（docs/04:142「各試行はnotification_eventsへ追記」）
    const actions = (await eventsOf(draft.id)).map((e) => e.action);
    expect(actions.filter((x) => x === "delivery.accepted")).toHaveLength(2); // A再送＋C受付
    expect(actions.filter((x) => x === "delivery.failed")).toHaveLength(1); // A初回
    expect(actions.filter((x) => x === "delivery.unknown")).toHaveLength(1); // B
    expect(actions).toContain("dispatch.finished");

    // --- 取消（docs/11「未送分取消はdeliveries単位」）: job実行前の未送分を全てcancelledへ ---
    const memberD = a.people.unlinked.memberId!; // 未登録団員もmembersはactive（宛先になり得る）
    const draft2 = await createNotificationDraft([memberD]);
    const job2 = await approveAndJob(draft2);
    const recD = await recipientOf(draft2.id, memberD);
    const sentBefore = fake.calls.length;
    const cancellation = await cancelUnsentDeliveries(env, a.id, draft2.id, { reason: "manual_cancel" });
    expect(cancellation.cancelled).toBe(1);
    expect(cancellation.ensured).toBe(1);
    // 取消後に未送分が残らない（pendingのdeliveriesがcancelledへ。docs/11 pending→cancelled）
    const afterCancellationUnsentCount =
      ((await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM notification_deliveries d JOIN notification_recipients r ON r.id = d.recipient_id AND r.unit_id = d.unit_id " +
          "WHERE r.notification_id = ? AND d.status = 'pending'",
      ).bind(draft2.id).first<{ n: number }>())!).n;
    expect(afterCancellationUnsentCount).toBe(0);
    // 取消済みの通知のjobが走っても送らない（新規pendingも作らない＝行は確保済み）
    await makeJobRunnable(job2.id);
    expect((await runDueJobs(env)).committed).toBe(1);
    expect(fake.calls.length).toBe(sentBefore);
    const rowD = (await deliveriesOf(draft2.id)).find((d) => d.recipient_id === recD.id)!;
    expect(rowD.status).toBe("cancelled");
    // 全件取消（受付0・拒否0）の通知はfinished（個別状態はcancelledが正本）
    expect(((await fx.rows("notifications", { id: draft2.id }))[0]!.status)).toBe("finished");
    // 取消の履歴
    expect((await eventsOf(draft2.id)).map((e) => e.action)).toContain("dispatch.cancelled");
  });

  it("delivery_skips_expired_notifications_and_inactive_recipients", async () => {
    const a = fx.units.a;
    const member = a.people.member.memberId!;
    const operator = a.people.operator.memberId!;
    const refMember = `member:${member}#inbox`;
    const refOperator = `member:${operator}#inbox`;

    // --- 期限切れ（expires_at経過）の通知は送らない ---
    const expiredDraft = await createNotificationDraft([member], { expiresAt: "2000-01-01T00:00:00.000Z" });
    const expiredJob = await approveAndJob(expiredDraft);

    // --- 退団（retired）宛先は送らず行も作らない（配送直前の除外。T050からの繰越） ---
    const draft = await createNotificationDraft([member, operator]);
    const job = await approveAndJob(draft);
    // 承認後（承認時はactiveが要求される＝422 recipient_not_active）に退団した宛先
    await env.DB.prepare("UPDATE members SET status = 'retired', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), operator).run();

    await makeJobRunnable(expiredJob.id);
    await makeJobRunnable(job.id);
    expect((await runDueJobs(env)).committed).toBe(2);

    // 期限切れ通知: deliveries行を作らずsendも呼ばない。履歴に期限切れを残す
    expect(await deliveriesOf(expiredDraft.id)).toHaveLength(0);
    // 通常通知（draft）のmember宛1回だけがsendされた（期限切れ通知でも送っていれば2回になる）
    expect(fake.calls.filter((c) => c.addressRef === refMember)).toHaveLength(1);
    expect((await eventsOf(expiredDraft.id)).map((e) => e.action)).toContain("dispatch.expired");
    expect(((await fx.rows("jobs", { id: expiredJob.id }))[0]!.status)).toBe("succeeded");

    // 退団宛先（operator）: sendなし・deliveries行なし・delivery.skipped履歴
    expect(fake.calls.filter((c) => c.addressRef === refOperator)).toHaveLength(0);
    const recMember = await recipientOf(draft.id, member);
    const draftDeliveries = await deliveriesOf(draft.id);
    expect(draftDeliveries).toHaveLength(1); // operator宛の行は無い（送らない宛先は行を作らない）
    const memberRow = draftDeliveries.find((d) => d.recipient_id === recMember.id)!;
    expect(memberRow.status).toBe("provider_accepted");
    const skipEvents = (await eventsOf(draft.id)).filter((e) => e.action === "delivery.skipped");
    expect(skipEvents).toHaveLength(1);
    expect(JSON.parse(skipEvents[0]!.details as string)).toMatchObject({ reason: "member_not_active" });
    // 受付1件でfinished
    expect(((await fx.rows("notifications", { id: draft.id }))[0]!.status)).toBe("finished");

    // 後続のitに退団状態を残さない
    await env.DB.prepare("UPDATE members SET status = 'active', updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), operator).run();
  });

  it("delivery_retry_exhaustion_marks_notification_failed", async () => {
    const a = fx.units.a;
    const member = a.people.member.memberId!;
    fake.on(`member:${member}#inbox`, () => ({ kind: "failed", errorCode: "provider_rejected" }));

    const draft = await createNotificationDraft([member]);
    const job = await approveAndJob(draft);
    for (let i = 0; i < 3; i++) {
      await makeJobRunnable(job.id);
      expect((await runDueJobs(env)).committed).toBe(1);
    }
    // 3回とも拒否（試行上限）: 行は1本・attempt_count=3・固定delivery_key・拒否コード
    const rows = await deliveriesOf(draft.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempt_count).toBe(3);
    expect(rows[0]!.status).toBe("retry_wait");
    expect(rows[0]!.last_error_code).toBe("provider_rejected");
    // jobは手動確認。通知はfailed（受付0件・拒否で再試行が尽きた）
    expect(((await fx.rows("jobs", { id: job.id }))[0]!.status)).toBe("manual_review");
    expect(((await fx.rows("notifications", { id: draft.id }))[0]!.status)).toBe("failed");
    // 試行履歴（docs/04:142「各試行はnotification_eventsへ追記」）
    const events = await eventsOf(draft.id);
    expect(events.filter((e) => e.action === "delivery.failed")).toHaveLength(3);
    expect(events.map((e) => e.action)).toContain("dispatch.failed");
    // 4回目は実行されない（上限に達したjobは再実行されない。sendも増えない）
    await makeJobRunnable(job.id);
    expect((await runDueJobs(env)).leased).toBe(0);
    expect(fake.calls).toHaveLength(3);
  });

  it("duplicate_and_timed_out_runs_never_send_twice", async () => {
    const a = fx.units.a;
    const member = a.people.member.memberId!;

    // --- 二重実行: 確定済みの通知jobを再実行してもsendしない ---
    const draft1 = await createNotificationDraft([member]);
    const job1 = await approveAndJob(draft1);
    const leased = (await leaseJob(env, new Date().toISOString()))!;
    expect(leased.id).toBe(job1.id);
    const outcome = await handleJob(leased, env);
    expect(await completeJob(env, leased, outcome, new Date().toISOString())).toBe(true);
    const sendsAfterFirst = fake.calls.length;
    expect(sendsAfterFirst).toBe(1);
    // jobは終端（succeeded）なので再実行されない（二重実行＝leaseが取れない。docs/02 §5）
    expect((await runDueJobs(env)).leased).toBe(0);
    expect(fake.calls.length).toBe(sendsAfterFirst);

    // --- 受付後タイムアウト: sendingで取り残された配送は再実行でもsendせずunknownへ ---
    const operator = a.people.operator.memberId!;
    fake.on(`member:${operator}#inbox`, () => new Promise<DeliveryResult>(() => {})); // 受付後、応答しない
    const draft2 = await createNotificationDraft([member, operator]);
    const job2 = await approveAndJob(draft2);
    await makeJobRunnable(job2.id);
    expect((await runDueJobs(env, { timeoutMs: 50 })).committed).toBe(1); // タイムアウト＝再試行扱い（runner）
    const stuck = await deliveriesOf(draft2.id);
    expect(stuck).toHaveLength(2);
    expect(stuck.every((d) => d.status === "sending")).toBe(true);
    const afterTimeout = fake.calls.length;
    expect(afterTimeout).toBe(sendsAfterFirst + 2); // 両宛先に1回だけsendされた（応答待ちで打ち切られた）
    // 再実行では送り直さない（非冪等providerへの2回目のsendを起こさない）
    await makeJobRunnable(job2.id);
    expect((await runDueJobs(env)).committed).toBe(1);
    expect(fake.calls.length).toBe(afterTimeout);
    const recovered = await deliveriesOf(draft2.id);
    expect(recovered.every((d) => d.status === "unknown")).toBe(true); // 結果不明＝照会/人確認
    // 受付0件・拒否0件（全件unknown）は「受付の無い完了」。個別状態unknownが正本
    expect(((await fx.rows("notifications", { id: draft2.id }))[0]!.status)).toBe("finished");
  });

  /**
   * 配送jobとcancel_unsentの競合（PH4レビューA中2）: dispatcherがdeliveriesを読み込んだ後、
   * settle（status→sendingの状態ガード付きUPDATE）をcommittedさせる前にAPI-64 cancel_unsent相当の
   * 取消がcommittedしたとき、その行はsettleのガードで0行しか変わらないためprovider.sendへ回さない
   * （docs/11「取消後のjob実行は送らない」の並行版。現行実装は反映行数＝meta.changesを見ずに
   * 読込時の全行へsendするためFAILする）。DB状態はcancelledのまま通知だけが届く事故を防ぐ。
   * 競合の窗口（読込〜settle確定の間）はenv.DB.batchを差し替えて再現する:
   * settleのbatch（この実行では1文のUPDATE）を検出したら、委譲の前に取消を確定させる。
   */
  it("cancelled_pending_deliveries_are_not_sent_when_cancellation_commits_during_dispatch", async () => {
    const a = fx.units.a;
    const member = a.people.member.memberId!;
    const draft = await createNotificationDraft([member]);
    const job = await approveAndJob(draft);
    const recipient = await recipientOf(draft.id, member);
    const ref = `member:${member}#inbox`;

    const originalBatch = env.DB.batch.bind(env.DB);
    let injecting = false;
    let settleIntercepted = false;
    (env.DB as { batch: typeof env.DB.batch }).batch = (statements: D1PreparedStatement[]) => {
      if (!injecting && !settleIntercepted && statements.length === 1) {
        settleIntercepted = true;
        injecting = true;
        return (async () => {
          try {
            // pendingの行がこの時点でcancelledへ確定する（SELECT後・settle前のcommitと同じ）
            const cancellation = await cancelUnsentDeliveries(env, a.id, draft.id, { reason: "manual_cancel" });
            expect(cancellation.cancelled).toBe(1);
          } finally {
            injecting = false;
          }
          return originalBatch(statements);
        })();
      }
      return originalBatch(statements);
    };
    try {
      const jobRow = (await fx.rows("jobs", { id: job.id }))[0]!;
      const leased = {
        id: String(job.id), unitId: a.id, kind: "notification.deliver", sourceType: "notification",
        sourceId: draft.id, sourceVersion: Number(jobRow.source_version), configVersion: String(jobRow.config_version),
        dedupeKey: String(jobRow.dedupe_key), status: "running", attempts: 1, maxAttempts: 3,
        nextAttemptAt: new Date().toISOString(), errorCode: null, resultRef: null, requestedBy: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        leaseToken: "concurrency-test", leaseUntil: new Date(Date.now() + 60_000).toISOString(),
      } as unknown as Parameters<typeof dispatchNotification>[1];
      await dispatchNotification(env, leased);
    } finally {
      env.DB.batch = originalBatch;
    }

    // 取消済みの行へsendが呼ばれないこと
    expect(fake.calls.filter((c) => c.addressRef === ref)).toHaveLength(0);
    // 行はcancelledのまま（結果の確定UPDATEもsending前提のガードで効かない）
    const row = (await deliveriesOf(draft.id)).find((d) => d.recipient_id === recipient.id)!;
    expect(row.status).toBe("cancelled");
  });
});
