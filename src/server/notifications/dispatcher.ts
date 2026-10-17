import type { AppEnv } from "../env";
import { JOB_LIMITS, type JobOutcome, type LeasedJob } from "../jobs/store";
import { recordMetricSafe } from "../observability/metrics";
import { channelProvider, type DeliveryResult, type NotificationChannel, type NotificationProvider } from "./provider";

/**
 * 通知の実配送（T051、docs/11 配送、docs/04:141 notification_deliveries、docs/16 T051）。
 * T050の承認（API-64）が登録する notification.deliver job を受ける（docs/05 API-64）。
 *
 * 流れ（docs/16 T051のコントローラ裁定どおり）:
 *  ①notificationを読み approved/dispatching であることを再確認（draftはstale。cancelled/finished/failed
 *    は何もしない succeeded＝二重実行で送らない。jobのsourceVersionは承認時の版だが、承認・配送・既読で
 *    versionが進むため版の完全一致は要求しない）
 *  ②recipientごとにdeliveries行を作る（無ければ。delivery_key=`${通知ID}|${recipientId}|${channel}`の
 *    固定キー。UNIQUEで二重作成防止。attempt_count=1＝行は最初の送信試行で作る（docs/04:141））
 *  ③notificationをdispatchingへ（approvedのとき。0行＝既に配送中/確定済みなので続行）
 *  ④各recipientをprovider.sendへ（channel別。'inapp'は内部成立。providerIdを記録）
 *  ⑤結果をdeliveriesへ確定（provider_accepted/failed→retry_wait/unknown）＋notification_eventsへ試行追記
 *  ⑥全部終わり次第notificationをfinished/failedへ
 *
 * 再送の安全性（docs/02 §5「外部効果の一回性は各handlerの責務」）:
 * - delivery_keyは再試行で不変。deliveriesのUNIQUEが行の二重作成を防ぎ、送信対象は pending/retry_wait の行だけ。
 * - settle（status→sending）は状態ガード付きUPDATEにし、反映行数（meta.changes）が1の行だけを
 *   provider.sendへ回す。読込後〜確定の間にcancel_unsentがcommittedした行は0行で変わらないため送らない
 *   （＝「取消後のjob実行は送らない」の並行版。DBはcancelledのまま通知だけ届く事故を防ぐ）。
 * - unknownは無条件に再送しない（非冪等providerへの2回目のsendを起こさない）。受付後タイムアウトで
 *   runnerに打ち切られて sending に取り残された行も、次回実行では send せず unknown へ進める
 *   （＝同じdelivery_keyへの2回目のsendは発生しない）。
 * - failed（providerの明確な拒否）だけが retry_wait になり、jobの再試行（docs/02 §5の上限）で再送される。
 *   上限に達して未確定が残るjobは manual_review になり、その実行でnotificationをfailedへ確定する。
 * - 取消（未送分のdeliveries単位の取消）は cancelUnsentDeliveries（下）が担当する。APIは出さず
 *   T052の取消導線が使うサーバー関数（docs/16 T051裁定）。
 */

/** deliveries.last_error_codeは短いコードだけ（jobs.error_codeと同じ方針。providerの生の応答を入れない） */
const safeErrorCode = (code: string): string => (/^[a-z0-9_]{1,100}$/.test(code) ? code : "provider_error");

/** 配送の効果キー（再試行で固定。docs/16 T051裁定） */
const deliveryKeyFor = (notificationId: string, recipientId: string, channel: string): string =>
  `${notificationId}|${recipientId}|${channel}`;

interface NotificationRow {
  id: string; unit_id: string; status: string; body_revision: string; expires_at: string | null;
}

interface RecipientRow {
  id: string; member_id: string; channel: string; address_ref: string; member_status: string;
}

interface DeliveryRow {
  id: string; recipient_id: string; delivery_key: string; attempt_count: number; status: string;
  channel: string; address_ref: string;
}

/** notification_eventsへの追記（既定はsystem。API-64のhuman mutationから呼ぶ取消は'human'。ID・コード形式のみで本文を複製しない） */
const eventStatement = (
  db: D1Database, unitId: string, notificationId: string, action: string, details: Record<string, unknown>, now: string,
  actorKind: "human" | "system" = "system",
): D1PreparedStatement =>
  db.prepare(
    "INSERT INTO notification_events (id, unit_id, notification_id, action, details, actor_kind, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), unitId, notificationId, action, JSON.stringify(details), actorKind, now);

/**
 * dispatchNotification(env, job): Promise<JobOutcome>（docs/16 T051のInterface）。
 * 副作用: notification_deliveriesの生成/確定・notificationsのdispatching→finished/failed・
 * notification_eventsへの追記・provider.send。全て状態ガード付きUPDATE＋固定delivery_keyで再実行に強い。
 */
export async function dispatchNotification(env: AppEnv, job: LeasedJob): Promise<JobOutcome> {
  const now = new Date().toISOString();
  const notif = await env.DB.prepare(
    "SELECT id, unit_id, status, body_revision, expires_at FROM notifications WHERE id = ?",
  ).bind(job.sourceId).first<NotificationRow>();
  if (!notif || notif.unit_id !== job.unitId) return { kind: "stale", errorCode: "notification_missing" };
  // ①承認済みの再確認。draftは承認前のjob（通常起きない）＝このjobの結果を採用できない。
  // cancelled/finished/failedは終端なので何もしない（二重実行・取消後の残留jobで送らない）
  if (notif.status === "draft") return { kind: "stale", errorCode: "notification_not_approved" };
  if (notif.status !== "approved" && notif.status !== "dispatching") return { kind: "succeeded" };

  // 期限切れ（expires_at経過）は送らない（docs/07 §5。通知の承認状態は変えず、履歴で残す）
  if (notif.expires_at !== null && notif.expires_at <= now) {
    await env.DB.batch([
      eventStatement(env.DB, job.unitId, job.sourceId, "dispatch.expired", { expiresAt: notif.expires_at }, now),
    ]);
    return { kind: "succeeded", resultRef: `expired:${notif.expires_at}` };
  }

  // 宛先（membersのactive・同unitだけが配送対象。退団/休団は配信直前で除外する＝T050の承認時検査の後続）
  const recipientRows = (
    await env.DB.prepare(
      "SELECT r.id, r.member_id, r.channel, r.address_ref, m.status AS member_status " +
        "FROM notification_recipients r JOIN members m ON m.id = r.member_id AND m.unit_id = r.unit_id " +
        "WHERE r.notification_id = ? AND r.unit_id = ?",
    ).bind(job.sourceId, job.unitId).all<RecipientRow>()
  ).results;
  const deliverable = recipientRows.filter((r) => r.member_status === "active");
  const skipped = recipientRows.filter((r) => r.member_status !== "active");

  // ②deliveries行を作る（無ければ。固定delivery_keyのUNIQUEで二重作成しない）＋宛先除外の履歴
  const provisionStatements: D1PreparedStatement[] = skipped.map((r) =>
    eventStatement(env.DB, job.unitId, job.sourceId, "delivery.skipped", { memberId: r.member_id, reason: "member_not_active" }, now),
  );
  for (const r of deliverable) {
    provisionStatements.push(env.DB.prepare(
      "INSERT INTO notification_deliveries (id, unit_id, recipient_id, delivery_key, attempt_count, status, provider_id, actor_kind, created_at) " +
        "VALUES (?, ?, ?, ?, 1, 'pending', NULL, 'system', ?) ON CONFLICT (delivery_key) DO NOTHING",
    ).bind(crypto.randomUUID(), job.unitId, r.id, deliveryKeyFor(job.sourceId, r.id, r.channel), now));
  }
  // ③dispatchingへ（approvedのとき。0行＝既に配送中/確定済み）
  provisionStatements.push(env.DB.prepare(
    "UPDATE notifications SET status = 'dispatching', version = version + 1, updated_at = ? " +
      "WHERE id = ? AND unit_id = ? AND status = 'approved'",
  ).bind(now, job.sourceId, job.unitId));
  await env.DB.batch(provisionStatements);

  // 未確定のdelivery（送るべきものと、前回の実行でsendingに取り残されたもの）
  const deliveries = (
    await env.DB.prepare(
      "SELECT d.id, d.recipient_id, d.delivery_key, d.attempt_count, d.status, r.channel, r.address_ref " +
        "FROM notification_deliveries d JOIN notification_recipients r ON r.id = d.recipient_id AND r.unit_id = d.unit_id " +
        "WHERE d.unit_id = ? AND r.notification_id = ? AND d.status IN ('pending', 'retry_wait', 'sending')",
    ).bind(job.unitId, job.sourceId).all<DeliveryRow>()
  ).results;
  const body = (JSON.parse(notif.body_revision) as { body: string }).body;

  // 前回の実行でsendingに取り残された行は、providerへ届いたか分からない。
  // 非冪等providerに2回目を飛ばさないため、sendせずunknownへ進める（照会/人確認に回す）
  const stuck = deliveries.filter((d) => d.status === "sending");
  const toSend = deliveries.filter((d) => d.status !== "sending");

  const settleStatements: D1PreparedStatement[] = stuck.flatMap((d) => [
    env.DB.prepare(
      "UPDATE notification_deliveries SET status = 'unknown' WHERE id = ? AND unit_id = ? AND status = 'sending'",
    ).bind(d.id, job.unitId),
    eventStatement(env.DB, job.unitId, job.sourceId, "delivery.unknown",
      { deliveryKey: d.delivery_key, attempt: d.attempt_count, reason: "unresolved_sending" }, now),
  ]);

  // 送る行をsendingへ（初回は行作成時のattempt=1のまま、再送は+1）。settleのUPDATEは状態ガード付き
  // （WHERE status = 読込時の状態）なので、読込と確定の間にcancel_unsentがcommittedした行は0行しか
  // 変わらない。反映行数（meta.changes）を見て、変わった行だけをprovider.sendへ回す
  // （docs/11「取消後のjob実行は送らない」の並行版。env.DB.batchの結果は文の順序どおりに返るため、
  // settle文のインデックス（stuckの2文×行のあとに送信行のUPDATE）で対応させる）
  const sendCandidates: { d: DeliveryRow; provider: NotificationProvider }[] = [];
  for (const d of toSend) {
    const provider = channelProvider(d.channel as NotificationChannel);
    if (!provider) continue; // 未登録チャネルは送らずpendingのまま（再試行上限で手動確認へ）
    sendCandidates.push({ d, provider });
    settleStatements.push(env.DB.prepare(
      "UPDATE notification_deliveries SET status = 'sending', " +
        "attempt_count = CASE WHEN ?2 = 'retry_wait' THEN attempt_count + 1 ELSE attempt_count END " +
        "WHERE id = ?1 AND unit_id = ?3 AND status = ?2",
    ).bind(d.id, d.status, job.unitId));
  }
  const settled = settleStatements.length > 0 ? await env.DB.batch(settleStatements) : [];
  const sendables = sendCandidates.filter((_, i) => (settled[stuck.length * 2 + i]?.meta.changes ?? 0) > 0);

  // 使用量の計上（T080）: providerへの送信試行（送った行数。jobの再実行で重複計上され得る近似。
  //   観測は配送の成否に依存しない。docs/07 §8「通知を別計上」）
  if (sendables.length > 0) {
    await recordMetricSafe(env, {
      service: "notification", metric: "notification.deliveries", unit: "count", amount: sendables.length, source: "job:notification.deliver",
    });
  }

  // ④provider.send（channel別）。例外＝送信の成否が不明なのでunknown（盲目的に再送しない）
  const results = await Promise.all(
    sendables.map(async ({ d, provider }) => {
      let result: DeliveryResult;
      try {
        result = await provider.send({ deliveryKey: d.delivery_key, addressRef: d.address_ref, body });
      } catch {
        result = { kind: "unknown" };
      }
      return { d, provider, result };
    }),
  );

  // 配送不明の計上（T080 review round 1。監視のみ）: 送信前に取り残された行（stuck→unknown）と、
  // provider.sendの例外で成否不明になった行。docs/07 §8「通知不明」のアプリ内で見える分
  const unknownCount = stuck.length + results.filter((r) => r.result.kind === "unknown").length;
  if (unknownCount > 0) {
    await recordMetricSafe(env, {
      service: "notification", metric: "notification.delivery_unknown", unit: "count", amount: unknownCount, source: "job:notification.deliver",
    });
  }

  // ⑤結果をdeliveriesへ確定（状態ガード付き。lease切れの後発実行が既に確定済みの行を壊さない）
  const resultStatements: D1PreparedStatement[] = [];
  for (const { d, provider, result } of results) {
    const providerId = (result.kind === "provider_accepted" ? result.providerId : undefined) ?? provider.id;
    if (result.kind === "provider_accepted") {
      resultStatements.push(
        env.DB.prepare(
          "UPDATE notification_deliveries SET status = 'provider_accepted', provider_id = ?, next_attempt_at = NULL " +
            "WHERE id = ? AND unit_id = ? AND status = 'sending'",
        ).bind(providerId, d.id, job.unitId),
        eventStatement(env.DB, job.unitId, job.sourceId, "delivery.accepted",
          { deliveryKey: d.delivery_key, attempt: d.attempt_count, providerId }, now),
      );
    } else if (result.kind === "failed") {
      // 拒否は再送待ちへ（docs/11 failed→retry_wait→sending）。job側の再試行上限で打ち切る
      const nextAt = new Date(Date.now() + JOB_LIMITS.retryDelaysSeconds[0]! * 1000).toISOString();
      const errorCode = safeErrorCode(result.errorCode);
      resultStatements.push(
        env.DB.prepare(
          "UPDATE notification_deliveries SET status = 'retry_wait', provider_id = ?, last_error_code = ?, next_attempt_at = ? " +
            "WHERE id = ? AND unit_id = ? AND status = 'sending'",
        ).bind(providerId, errorCode, nextAt, d.id, job.unitId),
        eventStatement(env.DB, job.unitId, job.sourceId, "delivery.failed",
          { deliveryKey: d.delivery_key, attempt: d.attempt_count, errorCode, providerId }, now),
      );
    } else {
      // unknownは無条件に再送しない（次回以降もsendしない。照会/人確認）
      resultStatements.push(
        env.DB.prepare(
          "UPDATE notification_deliveries SET status = 'unknown', provider_id = ? " +
            "WHERE id = ? AND unit_id = ? AND status = 'sending'",
        ).bind(providerId, d.id, job.unitId),
        eventStatement(env.DB, job.unitId, job.sourceId, "delivery.unknown",
          { deliveryKey: d.delivery_key, attempt: d.attempt_count, reason: "provider_unknown", providerId }, now),
      );
    }
  }
  if (resultStatements.length > 0) await env.DB.batch(resultStatements);

  // ⑥集計して確定
  const counts = new Map<string, number>(
    (
      await env.DB.prepare(
        "SELECT status, COUNT(*) AS n FROM notification_deliveries WHERE unit_id = ? AND recipient_id IN " +
          "(SELECT id FROM notification_recipients WHERE notification_id = ? AND unit_id = ?) GROUP BY status",
      ).bind(job.unitId, job.sourceId, job.unitId).all<{ status: string; n: number }>()
    ).results.map((row) => [row.status, row.n]),
  );
  const n = (status: string) => counts.get(status) ?? 0;
  const unsettled = n("pending") + n("sending") + n("retry_wait");
  const accepted = n("provider_accepted");
  const total = [...counts.values()].reduce((sum, v) => sum + v, 0);
  // 未確定が残り、jobに再試行の余地があるなら、notificationの確定は次回に譲る
  if (unsettled > 0 && job.attempts < job.maxAttempts) {
    return { kind: "retryable", errorCode: "delivery_retrying" };
  }
  // 全件が終端、またはjobの再試行が尽きた → notificationを確定する。
  // 受付>=1でfinished。受付0件で拒否/未送の残はfailed（受付を1件も得られなかった配送処理）。
  // 全件unknown（届いたか不明）/全件取消/0件送信はfinished（個別状態が正本。docs/11「受付≠到達≠既読」）
  const finalStatus = accepted >= 1 || unsettled === 0 ? "finished" : "failed";
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE notifications SET status = ?1, version = version + 1, updated_at = ?2 " +
        "WHERE id = ?3 AND unit_id = ?4 AND status = 'dispatching'",
    ).bind(finalStatus, now, job.sourceId, job.unitId),
    eventStatement(env.DB, job.unitId, job.sourceId,
      finalStatus === "finished" ? "dispatch.finished" : "dispatch.failed",
      { accepted, unknown: n("unknown"), cancelled: n("cancelled"), pending: n("pending"), retryWait: n("retry_wait"), total }, now),
  ]);
  if (unsettled > 0) return { kind: "retryable", errorCode: "delivery_retrying" };
  return { kind: "succeeded", resultRef: `${finalStatus}:accepted=${accepted}/${total}` };
}

export interface DeliveryCancellation {
  /** pending→cancelled になった件数 */
  cancelled: number;
  /** 全宛先のうちdeliveries行を確保した件数（取消後にjobが新規pendingを作らないよう先に確保する） */
  ensured: number;
}

/**
 * 未送分取消の1batch分の文（API-64 decision=cancel_unsentがexecuteMutationのstatementsで使う。T052）。
 * cancelUnsentDeliveries（下）と同じ内容を「文の配列」として返すだけにし、APIは
 * 版の進行・監査・outboxと同じbatchに載せて確定させる（docs/04 §1「業務更新は1つのbatch」）。
 * recipientsは呼び出し側が読んで渡す（statementsは同期のため内部で読めない）。
 */
export function cancelUnsentDeliveryStatements(
  db: D1Database,
  unitId: string,
  notificationId: string,
  recipients: readonly { id: string; channel: string }[],
  now: string,
  reason: string,
  /** dispatch.cancelledのactor_kind。API-64のhuman mutationからは'human'（同一mutation内の他eventsと揃える） */
  actorKind: "human" | "system" = "system",
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = recipients.map((r) =>
    db.prepare(
      "INSERT INTO notification_deliveries (id, unit_id, recipient_id, delivery_key, attempt_count, status, provider_id, actor_kind, created_at) " +
        "VALUES (?, ?, ?, ?, 1, 'pending', NULL, 'system', ?) ON CONFLICT (delivery_key) DO NOTHING",
    ).bind(crypto.randomUUID(), unitId, r.id, deliveryKeyFor(notificationId, r.id, r.channel), now),
  );
  statements.push(db.prepare(
    // pendingだけ取消（docs/11 deliveryTransitions: pending→cancelledのみ）
    "UPDATE notification_deliveries SET status = 'cancelled' " +
      "WHERE unit_id = ?2 AND status = 'pending' AND recipient_id IN " +
      "(SELECT id FROM notification_recipients WHERE notification_id = ?3 AND unit_id = ?2)",
  ).bind(now, unitId, notificationId));
  statements.push(eventStatement(db, unitId, notificationId, "dispatch.cancelled",
    { ensured: recipients.length, reason }, now, actorKind));
  return statements;
}

/**
 * 未送分の取消（docs/11「未送分取消はdeliveries単位の取消」。T051）。
 * 承認後の通知（approved/dispatching）について、まだ送っていない配送（pending）だけをcancelledにする。
 * 送信済み（provider_accepted/unknown）と拒否後の再送待ち（retry_wait）は遷移に無いため戻さない
 * （docs/11「送信済みを未送へ戻さない」。遷移はstates.ts deliveryTransitions＝pending→cancelledのみ）。
 * jobがまだ走っていない宛先にも先に行を作って（INSERT OR IGNORE）から取消するため、取消後にjobが走っても
 * 新規pendingを作らず送らない。APIには出さずT052の取消導線が使うサーバー関数（docs/16 T051裁定）。
 */
export async function cancelUnsentDeliveries(
  env: Pick<AppEnv, "DB">,
  unitId: string,
  notificationId: string,
  opts: { reason?: string } = {},
): Promise<DeliveryCancellation> {
  const now = new Date().toISOString();
  const recipients = (
    await env.DB.prepare(
      "SELECT id, channel FROM notification_recipients WHERE notification_id = ? AND unit_id = ?",
    ).bind(notificationId, unitId).all<{ id: string; channel: string }>()
  ).results;
  if (recipients.length === 0) return { cancelled: 0, ensured: 0 };
  const results = await env.DB.batch(
    cancelUnsentDeliveryStatements(env.DB, unitId, notificationId, recipients, now, opts.reason ?? "manual_cancel"),
  );
  const cancelled = results[results.length - 2]?.meta.changes ?? 0;
  return { cancelled, ensured: recipients.length };
}
