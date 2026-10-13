-- 0004_auth: 認証ライブラリ(Better Auth 1.7.7 固定、V01)の表。docs/04 §3.1「auth_*」。
-- 列は better-auth の公式スキーマ(getAuthTables)に、config.ts の modelName/fields で snake_case を当てたもの。
-- 認証identity(auth_users)と業務利用者(users)は別。users.auth_id が auth_users.id を指す（FKにしないのは、認証側の表が
-- ライブラリの管理下にあり、業務の移行で作り直せるようにするため。招待の消費batchで存在を検査する）。
-- 時刻はライブラリが書くISO8601文字列（ミリ秒Z）。業務表のような厳密CHECKは付けない（ライブラリの書式に従う）。

CREATE TABLE auth_users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  two_factor_enabled INTEGER DEFAULT 0
);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions (user_id);

CREATE TABLE auth_accounts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TEXT,
  refresh_token_expires_at TEXT,
  scope TEXT,
  password TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_auth_accounts_user ON auth_accounts (user_id);

CREATE TABLE auth_verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_auth_verifications_identifier ON auth_verifications (identifier);

CREATE TABLE auth_two_factors (
  id TEXT PRIMARY KEY,
  secret TEXT NOT NULL,
  backup_codes TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES auth_users (id) ON DELETE CASCADE,
  verified INTEGER DEFAULT 1,
  failed_verification_count INTEGER DEFAULT 0,
  locked_until TEXT
);
CREATE INDEX idx_auth_two_factors_user ON auth_two_factors (user_id);
CREATE INDEX idx_auth_two_factors_secret ON auth_two_factors (secret);

-- 認証経路の回数制限（IP単位。Workersは複数isolateなのでメモリでなくD1に数える）
CREATE TABLE auth_rate_limits (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  count INTEGER NOT NULL,
  last_request INTEGER NOT NULL
);
