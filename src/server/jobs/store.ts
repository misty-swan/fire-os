import type { AppEnv } from "../env";
import { recordMetricSafe } from "../observability/metrics";
import type { jobStates } from "../../shared/states";

export type JobStatus = (typeof jobStates)[number];

/** 永続ジョブの運用パラメータ（docs/02 §5。D16/V03の実測で確定する案） */
export const JOB_LIMITS = {
  /** 初回＋再試行2回 */
  maxAttempts: 3,
  /** n回目の失敗後の待機。3回目の失敗は手動確認へ */
  retryDelaysSeconds: [60, 300],
  leaseSeconds: 120,
  handlerTimeoutMs: 30_000,
} as const;

export interface JobInput {
  unitId: string;
  kind: string;
  sourceType: string;
  sourceId: string;
  sourceVersion: number;
  configVersion: string;
  /** 依頼者(user)。システム起動はnull */
  requestedBy: string | null;
  /**
   * 省略時は unit|kind|source|版|config から作る。同じ値の再登録は1件にまとまる。
   * 独自に指定する場合は必ず `${unitId}|` で始める（別unitと衝突して登録が黙って抜けるのを防ぐ。満たさなければ例外）
   */
  dedupeKey?: string;
}

/** DB行をcamelCaseにした内部表現（API応答のJob DTOとは別。応答は status/attempts/errorCode/resultRef のみ） */
export interface JobRecord {
  id: string;
  unitId: string;
  kind: string;
  sourceType: string;
  sourceId: string;
  sourceVersion: number;
  configVersion: string;
  dedupeKey: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  errorCode: string | null;
  resultRef: string | null;
  requestedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeasedJob extends JobRecord {
  leaseToken: string;
  leaseUntil: string;
}

export type JobOutcome =
  | { kind: "succeeded"; resultRef?: string }
  | { kind: "retryable"; errorCode: string }
  | { kind: "manual_review"; errorCode: string }
  | { kind: "stale"; errorCode?: string };

type JobEnv = Pick<AppEnv, "DB" | "JOBS_QUEUE">;

const DELAYS = JOB_LIMITS.retryDelaysSeconds;
/** n回目の失敗後の待機秒（attempts=失敗した回数）。上限を超えたら最後の値 */
const DELAY_SQL = `CASE attempts ${DELAYS.map((d, i) => `WHEN ${i + 1} THEN ${d}`).join(" ")} ELSE ${DELAYS[DELAYS.length - 1]} END`;
const NEXT_AT_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', ?1, '+' || (${DELAY_SQL}) || ' seconds')`;

interface JobRow {
  id: string; unit_id: string; kind: string; source_type: string; source_id: string; source_version: number;
  config_version: string; dedupe_key: string; status: JobStatus; attempts: number; max_attempts: number;
  next_attempt_at: string; lease_token: string | null; lease_until: string | null; error_code: string | null;
  result_ref: string | null; requested_by: string | null; created_at: string; updated_at: string;
}

function toRecord(r: JobRow): JobRecord {
  return {
    id: r.id, unitId: r.unit_id, kind: r.kind, sourceType: r.source_type, sourceId: r.source_id,
    sourceVersion: r.source_version, configVersion: r.config_version, dedupeKey: r.dedupe_key, status: r.status,
    attempts: r.attempts, maxAttempts: r.max_attempts, nextAttemptAt: r.next_attempt_at, errorCode: r.error_code,
    resultRef: r.result_ref, requestedBy: r.requested_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export const defaultDedupeKey = (i: JobInput) =>
  [i.unitId, i.kind, i.sourceType, i.sourceId, i.sourceVersion, i.configVersion].join("|");

/**
 * jobのINSERT文（同じdedupe_keyなら何もしない）。業務更新と同じD1 batchに入れて、
 * 「業務の確定とjob登録」を一緒に成功/失敗させるために使う（executeMutationのstatements内）。
 */
export function enqueueJobStatement(env: Pick<AppEnv, "DB">, input: JobInput, now: Date = new Date()) {
  const nowIso = now.toISOString();
  const dedupeKey = input.dedupeKey ?? defaultDedupeKey(input);
  if (!dedupeKey.startsWith(`${input.unitId}|`)) throw new Error("dedupeKey は `${unitId}|` で始めてください（別unitとの衝突防止）");
  const id = crypto.randomUUID();
  const statement = env.DB.prepare(
    "INSERT INTO jobs (id, unit_id, kind, source_type, source_id, source_version, config_version, dedupe_key, status, attempts, max_attempts, next_attempt_at, requested_by, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?) ON CONFLICT (dedupe_key) DO NOTHING",
  ).bind(
    id, input.unitId, input.kind, input.sourceType, input.sourceId, input.sourceVersion, input.configVersion, dedupeKey,
    JOB_LIMITS.maxAttempts, nowIso, input.requestedBy, nowIso, nowIso,
  );
  return { statement, id, dedupeKey };
}

/**
 * jobをD1へ登録し（同じdedupeなら既存を返す）、新規ならQueueへ起動の合図を送る。
 * Queueの送信失敗は握りつぶす：正本はD1で、Cronが回収するため。合図にはjob IDだけを載せる。
 */
export async function enqueueJob(env: JobEnv, input: JobInput, now: Date = new Date()): Promise<JobRecord> {
  const { statement, dedupeKey } = enqueueJobStatement(env, input, now);
  const inserted = await statement.run();
  // 別unitの同じキーのjobを返さない（独自キーにunitが含まれていない場合の保険）
  const row = await env.DB.prepare("SELECT * FROM jobs WHERE dedupe_key = ? AND unit_id = ?").bind(dedupeKey, input.unitId).first<JobRow>();
  if (!row) throw new Error("enqueueJob: 登録したjobが見つかりません（同じdedupe_keyが別unitで使われています）");
  if ((inserted.meta.changes ?? 0) === 1) {
    try {
      await env.JOBS_QUEUE.send({ jobId: row.id });
    } catch (err) {
      console.error(JSON.stringify({ event: "job_queue_send_failed", jobId: row.id, error: String(err) }));
    }
  }
  return toRecord(row);
}

/** 作業権の期限が切れたrunningを、retry_wait(待機付き)または手動確認へ戻す。 */
export async function reapExpiredLeases(env: Pick<AppEnv, "DB">, nowIso: string): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE jobs SET
       status = CASE WHEN attempts >= max_attempts THEN 'manual_review' ELSE 'retry_wait' END,
       next_attempt_at = CASE WHEN attempts >= max_attempts THEN next_attempt_at ELSE ${NEXT_AT_SQL} END,
       lease_token = NULL, lease_until = NULL, error_code = 'lease_expired', updated_at = ?1
     WHERE status = 'running' AND lease_until <= ?1`,
  ).bind(nowIso).run();
  const expired = res.meta.changes ?? 0;
  // 使用量の計上（T080 review round 1）: job滞留の兆候（lease失効。監視のみ。docs/07 §8「lease滞留」）。
  // 観測は業務を止めない。0件のときは行を作らない
  if (expired > 0) {
    await recordMetricSafe(env, { service: "d1", metric: "jobs.lease_expired", unit: "count", amount: expired, source: "cron:lease" });
  }
  return expired;
}

/**
 * 実行すべきjobを1件、作業権付きで取る。取れなければnull。
 * 選択と更新は1文のSQL(UPDATE ... RETURNING)なので、同時に呼ばれても作業権を得るのは1つだけ。
 */
export async function leaseJob(env: Pick<AppEnv, "DB">, nowIso: string): Promise<LeasedJob | null> {
  await reapExpiredLeases(env, nowIso);
  const token = crypto.randomUUID();
  const res = await env.DB.prepare(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_token = ?1,
       lease_until = strftime('%Y-%m-%dT%H:%M:%fZ', ?2, '+${JOB_LIMITS.leaseSeconds} seconds'),
       error_code = NULL, updated_at = ?2
     WHERE id = (
       SELECT id FROM jobs WHERE status IN ('queued', 'retry_wait') AND next_attempt_at <= ?2 AND attempts < max_attempts
       ORDER BY next_attempt_at, id LIMIT 1
     ) AND status IN ('queued', 'retry_wait')
     RETURNING *`,
  ).bind(token, nowIso).all<JobRow>();
  const row = res.results[0];
  if (!row) return null;
  return { ...toRecord(row), leaseToken: row.lease_token!, leaseUntil: row.lease_until! };
}

/**
 * 結果を確定する。作業権が自分のもので期限内のときだけ成功(true)。
 * 期限切れ・別runnerに交代済み・既に確定済みの場合は何も変えずfalse。
 */
/** error_code は短いコードだけ（内部の例外文・個人情報をAPI-86へ出さない）。形が不正なら置き換える */
const ERROR_CODE = /^[a-z0-9_]{1,100}$/;
const safeCode = (code: string | undefined, fallback: string) => (code && ERROR_CODE.test(code) ? code : fallback);

export async function completeJob(
  env: Pick<AppEnv, "DB">,
  job: LeasedJob,
  rawOutcome: JobOutcome,
  nowIso: string,
): Promise<boolean> {
  let outcome = rawOutcome;
  if (outcome.kind === "succeeded" && outcome.resultRef !== undefined && (outcome.resultRef.length < 1 || outcome.resultRef.length > 500)) {
    outcome = { kind: "manual_review", errorCode: "invalid_result_ref" };
  }
  if (outcome.kind === "retryable" || outcome.kind === "manual_review") outcome = { ...outcome, errorCode: safeCode(outcome.errorCode, "invalid_error_code") };
  if (outcome.kind === "stale") outcome = { ...outcome, errorCode: safeCode(outcome.errorCode, "source_changed") };
  const guard = "WHERE id = ?2 AND status = 'running' AND lease_token = ?3 AND lease_until > ?1";
  const clear = "lease_token = NULL, lease_until = NULL, updated_at = ?1";
  let sql: string;
  let extra: unknown[] = [];
  switch (outcome.kind) {
    case "succeeded":
      sql = `UPDATE jobs SET status = 'succeeded', result_ref = ?4, error_code = NULL, ${clear} ${guard}`;
      extra = [outcome.resultRef ?? null];
      break;
    case "retryable":
      sql = `UPDATE jobs SET
          status = CASE WHEN attempts >= max_attempts THEN 'manual_review' ELSE 'retry_wait' END,
          next_attempt_at = CASE WHEN attempts >= max_attempts THEN next_attempt_at ELSE ${NEXT_AT_SQL} END,
          error_code = ?4, ${clear} ${guard}`;
      extra = [outcome.errorCode];
      break;
    case "manual_review":
      sql = `UPDATE jobs SET status = 'manual_review', error_code = ?4, ${clear} ${guard}`;
      extra = [outcome.errorCode];
      break;
    case "stale":
      sql = `UPDATE jobs SET status = 'stale', error_code = ?4, ${clear} ${guard}`;
      extra = [outcome.errorCode ?? "source_changed"];
      break;
  }
  const res = await env.DB.prepare(sql).bind(nowIso, job.id, job.leaseToken, ...extra).run();
  return (res.meta.changes ?? 0) === 1;
}

export async function findJob(env: Pick<AppEnv, "DB">, id: string): Promise<JobRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  return row ? toRecord(row) : null;
}

/** API-86用。依頼者本人のjobだけ。他人・他unit・システムjobは「存在しない」と同じ扱い。 */
export async function findJobForRequester(
  env: Pick<AppEnv, "DB">,
  id: string,
  unitId: string,
  userId: string,
): Promise<JobRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND unit_id = ? AND requested_by = ?")
    .bind(id, unitId, userId)
    .first<JobRow>();
  return row ? toRecord(row) : null;
}
