import { systemClock, type Clock } from "../clock";
import type { AppEnv } from "../env";
import { JOB_LIMITS, completeJob, leaseJob, type JobOutcome, type LeasedJob } from "./store";

export type JobHandler = (job: LeasedJob, env: AppEnv) => Promise<JobOutcome>;

const handlers = new Map<string, JobHandler>();

/** kind ごとの処理を登録する。後続フェーズの各機能(通知配送/AI/検査等)がここへ登録する。 */
export function registerJobHandler(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler);
}
export function clearJobHandlers(): void {
  handlers.clear();
}

/**
 * 1件のjobを実行して結果(JobOutcome)にする。例外・タイムアウトは再試行扱い。
 * error_codeには短いコードだけを返し、例外の本文（内部情報を含み得る）は保存しない。
 * 処理を中断はできないので、タイムアウト後に遅れて終わった処理の結果はleaseで拒否される。
 */
export async function handleJob(job: LeasedJob, env: AppEnv, opts: { timeoutMs?: number } = {}): Promise<JobOutcome> {
  const handler = handlers.get(job.kind);
  if (!handler) return { kind: "manual_review", errorCode: "unknown_kind" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<JobOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "retryable", errorCode: "timeout" }), opts.timeoutMs ?? JOB_LIMITS.handlerTimeoutMs);
  });
  try {
    return await Promise.race([handler(job, env), timeout]);
  } catch {
    return { kind: "retryable", errorCode: "handler_error" };
  } finally {
    clearTimeout(timer);
  }
}

export interface RunSummary {
  /** 作業権を取った件数 */
  leased: number;
  /** 結果を確定できた件数 */
  committed: number;
  /** 作業権の期限切れ等で確定を拒否された件数 */
  rejected: number;
}

/** 実行可能なjobを順に処理する（CronとQueueの両方から呼ばれる。重い処理をHTTPやwaitUntilだけに依存させない）。 */
export async function runDueJobs(
  env: AppEnv,
  deps: { clock?: Clock; maxJobs?: number; timeoutMs?: number } = {},
): Promise<RunSummary> {
  const clock = deps.clock ?? systemClock;
  const summary: RunSummary = { leased: 0, committed: 0, rejected: 0 };
  for (let i = 0; i < (deps.maxJobs ?? 10); i++) {
    const job = await leaseJob(env, clock.now().toISOString());
    if (!job) break;
    summary.leased++;
    const outcome = await handleJob(job, env, { timeoutMs: deps.timeoutMs });
    const committed = await completeJob(env, job, outcome, clock.now().toISOString());
    if (committed) summary.committed++;
    else summary.rejected++;
  }
  return summary;
}
