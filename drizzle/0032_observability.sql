-- 0032_observability: 使用量メトリクスと課金上限の状態（docs/16 T080、docs/07 §8、docs/14 D11、NFR-08）。
-- 実在最大0031（T076）の次の連番（docs/14 D23の採番規則）。
-- Analytics Engine等の新bindingは追加しない（4環境へのbinding追加はT080の範囲外。コントローラ裁定）。
-- 使用量の記録はD1で行う。アラートの自動送信は作らない（通知は本文/対象の明示承認を要するため。
-- 監査ログへの記録＋管理画面の運用パネル＋ops/cost-alerts.mdの手順〔人が運用する〕がアラート経路）。

-- 使用量（アカウント全体の計上。unit_idを持たない=分団ごとに分裂させない）。
-- 個人の識別子・本文は載せない: metric/sourceはコード形式のみ（書込側src/server/observability/metrics.tsが
-- CODE_LIKEで検査する。DB側は長さだけ見る。docs/04「audit_logsと同じ扱い」）。
-- Workers/D1/R2/AI/Maps/通知を別計上（service列。docs/16 T080「UsageはWorkers/D1/R2/AI/Maps/通知を別計量」）。
-- **unknown（計測できない使用量）を0と偽装しない**: amount NULL=未知。CHECKで amount_known=1 ⇔ amount非NULL。
-- （WorkersのCPU/リクエスト・D1の読み取り行数・Mapsのロードはアプリ内では計測できず、実Cloudflareの
-- ダッシュボード/請求での確認になる。NULL行で「未計上であること」を記録する。docs/evidence/cost-estimate.md）
CREATE TABLE usage_metrics (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL CHECK (service IN ('workers', 'd1', 'r2', 'ai', 'maps', 'notification')),
  metric TEXT NOT NULL CHECK (length(metric) BETWEEN 1 AND 100),
  -- UTC暦日のバケット（YYYY-MM-DD。日次枠・急増判定の集計単位）
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  amount REAL CHECK (amount IS NULL OR (amount >= 0 AND amount <= 1e15)),
  amount_known INTEGER NOT NULL CHECK (amount_known IN (0, 1)),
  unit TEXT NOT NULL CHECK (unit IN ('count', 'bytes', 'tokens', 'ms')),
  source TEXT CHECK (source IS NULL OR length(source) BETWEEN 1 AND 100),
  recorded_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) IS recorded_at),
  CHECK ((amount_known = 1) = (amount IS NOT NULL))
);
CREATE INDEX idx_usage_metrics_day_service ON usage_metrics (day, service, metric);

-- 課金上限の状態（単一行。id='global'で1行に固定。履歴の正本は監査=audit_logsのentity_type='budget'行）。
-- statusは評価語彙、sourceは auto=評価経路（jobが高価な呼び出しの前に再評価する）/
-- manual=運用手順による停止（自動では解除しない。解除はops/cost-alerts.mdの手順）。
-- 閾値の正本はconfig/budget-development.json（開発設定・未承認。docs/14 D11）。
CREATE TABLE budget_state (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  status TEXT NOT NULL CHECK (status IN ('normal', 'warn', 'stopped')),
  source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
  reasons_json TEXT NOT NULL CHECK (json_valid(reasons_json) AND json_type(reasons_json) = 'array'),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 100),
  updated_by TEXT CHECK (updated_by IS NULL OR length(updated_by) BETWEEN 1 AND 100),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at)
);
