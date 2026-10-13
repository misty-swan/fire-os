-- 0002_jobs: 永続ジョブ（T006、docs/04 §3.4・docs/02 §5）
-- jobsを正本とし、Queuesは起動補助。lease(作業権)と dedupe_key で、再配送されても効果は一回にする。
-- docs/04からの追加: max_attempts / result_ref / requested_by（API-86の依頼者照会と結果参照のため）、stale状態（docs/11）。
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 100),
  source_type TEXT NOT NULL CHECK (length(source_type) BETWEEN 1 AND 100),
  source_id TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK (source_version >= 0),
  config_version TEXT NOT NULL CHECK (length(config_version) BETWEEN 1 AND 100),
  dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 1 AND 500),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'retry_wait', 'manual_review', 'cancelled', 'stale')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at) IS next_attempt_at),
  lease_token TEXT,
  lease_until TEXT CHECK (lease_until IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', lease_until) IS lease_until),
  -- 短いコードのみ。内部の例外本文・個人情報・Secretは保存しない
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 100),
  result_ref TEXT CHECK (result_ref IS NULL OR length(result_ref) BETWEEN 1 AND 500),
  -- 依頼者。システムが作ったjobはNULL（API-86では参照できない）
  requested_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  CHECK (attempts <= max_attempts),
  -- 実行中のときだけ作業権(token+期限)を持つ
  CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (status <> 'running' OR attempts >= 1)
);
CREATE INDEX idx_jobs_due ON jobs (status, next_attempt_at);
CREATE INDEX idx_jobs_unit ON jobs (unit_id);
CREATE INDEX idx_jobs_requested_by ON jobs (requested_by);
