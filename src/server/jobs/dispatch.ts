import type { AppEnv, JobMessage } from "../env";
import { reapOrphanIdentities } from "../auth/orphans";
import { expireIdempotencyRecords } from "../mutations/execute";
import { sweepAttachments } from "./handlers/attachment-cleanup";
import { detectDueInspections } from "./handlers/inspection-due";
import { runDueJobs } from "./runner";

/** Cron(毎分,UTC)：待機明け/期限切れ/Queueへ送れなかったjobを回収して実行する。Queueが止まっていても進む。 */
export async function handleScheduled(env: AppEnv): Promise<void> {
  // 期限切れの冪等レコードから応答本文を消す（鍵とhashは残る）。失敗してもジョブの回収は止めない
  try {
    await expireIdempotencyRecords(env, new Date().toISOString());
  } catch (err) {
    console.error(JSON.stringify({ event: "idempotency_expire_failed", error: String(err) }));
  }
  // 招待で登録したが受領しなかった認証identity（業務アクセス無し）を回収する。失敗してもジョブの回収は止めない
  try {
    await reapOrphanIdentities(env, new Date().toISOString());
  } catch (err) {
    console.error(JSON.stringify({ event: "orphan_reap_failed", error: String(err) }));
  }
  // 添付の期限切れ・未選択試行の回収（docs/07 §3.7）。失敗してもジョブの回収は止めない
  try {
    await sweepAttachments(env, new Date().toISOString());
  } catch (err) {
    console.error(JSON.stringify({ event: "attachment_sweep_failed", error: String(err) }));
  }
  // 点検期限の検出（T048）。SELECT＋重複排除INSERTで安価・冪等で、AIは呼ばない。
  // 効果はinspection_due_detectionsへの追記まで（通知draftの作成はT050）。失敗してもジョブの回収は止めない
  try {
    const due = await detectDueInspections(env, new Date().toISOString());
    if (due.detected > 0) console.log(JSON.stringify({ event: "inspection_due_detected", ...due }));
  } catch (err) {
    console.error(JSON.stringify({ event: "inspection_due_detect_failed", error: String(err) }));
  }
  const summary = await runDueJobs(env);
  if (summary.leased > 0) console.log(JSON.stringify({ event: "jobs_run", via: "cron", ...summary }));
}

/**
 * Queueの消費：メッセージはjob IDだけの「起動の合図」。正本はD1なので、合図の内容でなく
 * 実行可能なjobをD1から取って処理する。再配送されても、実行済みなら何も起きない。
 */
export async function handleQueueBatch(batch: MessageBatch<JobMessage>, env: AppEnv): Promise<void> {
  try {
    await runDueJobs(env);
  } catch (err) {
    console.error(JSON.stringify({ event: "jobs_queue_failed", error: String(err) }));
    for (const message of batch.messages) message.retry();
    return;
  }
  for (const message of batch.messages) message.ack();
}
