import type { AppEnv, JobMessage } from "../env";
import { expireIdempotencyRecords } from "../mutations/execute";
import { runDueJobs } from "./runner";

/** Cron(毎分,UTC)：待機明け/期限切れ/Queueへ送れなかったjobを回収して実行する。Queueが止まっていても進む。 */
export async function handleScheduled(env: AppEnv): Promise<void> {
  // 期限切れの冪等レコードから応答本文を消す（鍵とhashは残る）
  await expireIdempotencyRecords(env, new Date().toISOString());
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
