-- 0026_ai_evaluation_runs: AI評価の実行履歴（docs/04 §3.4 155行のai_evaluation_runs/ai_evaluation_cases、T061）。
-- 実在最大0025（T057）の次の連番（docs/14 D23の採番規則）。AI-05（AT-AI-05「精度/見逃し/保留/費用/p95/失敗例を
-- 再現でき、D12基準を事前固定」）の保存先。閾値・指標の定義は src/server/ai/evaluation.ts（docs/06 §6のB案を
-- 事前固定。評価後に変更しない）。**実モデルでの実行はV04の未実施手順**（docs/evidence/ai-evaluation.md）。

-- 評価実行（追記型。1 job=1 run。labels/outputs/metricsは統計のみで**個人本文は複製しない**
-- （docs/04:155「個人本文最小化」。失敗例はai_evaluation_casesがdataset行idで参照するだけ）。
-- gate_passed は成功した実行だけが 0/1 を持つ。未実施・失敗は NULL/failed で「合格」と表示しない）。
CREATE TABLE ai_evaluation_runs (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  -- 評価の種別（datasetと1:1。classification=分類holdout、report=報告書下書きholdout。RAGは後続タスクで拡張）
  kind TEXT NOT NULL CHECK (kind IN ('classification', 'report')),
  dataset_version TEXT NOT NULL CHECK (length(dataset_version) BETWEEN 1 AND 100),
  question_version TEXT NOT NULL CHECK (length(question_version) BETWEEN 1 AND 100),
  -- 評価対象のモデル（カタログ名）。記録済み出力が無いモデルは評価できず failed になる（黙って別モデルの記録を使わない）
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 200),
  -- datasetの出所（コミット済みfixtureのパス@版。本文は格納しない）
  dataset_ref TEXT NOT NULL CHECK (length(dataset_ref) BETWEEN 1 AND 200),
  -- 再現性の保証（同じsha256なら同じdataset。生成スクリプト: scripts/generate-ai-holdout.ts）
  dataset_sha256 TEXT NOT NULL CHECK (length(dataset_sha256) = 64),
  case_count INTEGER NOT NULL CHECK (case_count >= 0),
  -- 人手ラベルの統計（expectedLabels分布・expectedNeedsReview件数。docs/04:155「labels:J」）
  labels_json TEXT NOT NULL CHECK (json_valid(labels_json) AND json_type(labels_json) = 'object'),
  -- 記録済み予測の統計（predictedLabels分布・保留予測件数・usage既知/未知件数。docs/04:155「outputs:J」）
  outputs_json TEXT NOT NULL CHECK (json_valid(outputs_json) AND json_type(outputs_json) = 'object'),
  -- 指標とゲート判定（docs/04:155「metrics:J」。成功した実行だけが持つ）
  metrics_json TEXT CHECK (metrics_json IS NULL OR (json_valid(metrics_json) AND json_type(metrics_json) = 'object')),
  -- 品質ゲートの合否（docs/06 §6のB案。NULL=未判定。失敗した実行を合格と表示しない）
  gate_passed INTEGER CHECK (gate_passed IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 100),
  -- 受付job（API-89。dedupe_keyで1元版1jobのため1 run=1 job）
  job_id TEXT NOT NULL,
  run_by_user_id TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  executed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', executed_at) IS executed_at),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK ((status = 'succeeded') = (metrics_json IS NOT NULL AND gate_passed IS NOT NULL)),
  CHECK ((status = 'failed') = (error_code IS NOT NULL)),
  CHECK (actor_kind = 'human'),
  UNIQUE (unit_id, id),
  UNIQUE (unit_id, job_id),
  FOREIGN KEY (unit_id, job_id) REFERENCES jobs (unit_id, id) ON DELETE RESTRICT
);
-- API-88の一覧（新しい順の安定keyset。modelId/datasetVersionで絞る）
CREATE INDEX idx_ai_evaluation_runs_unit_created ON ai_evaluation_runs (unit_id, created_at, id);

-- 失敗例（docs/06 §6「失敗例を恣意的に除外しない」の保存先。成功例は行を作らない＝統計はruns側。
-- case_refはdataset行のidで、本文は複製しない＝docs/04:155「個人本文最小化」）
CREATE TABLE ai_evaluation_cases (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL,
  case_ref TEXT NOT NULL CHECK (length(case_ref) BETWEEN 1 AND 100),
  expected TEXT NOT NULL CHECK (length(expected) BETWEEN 1 AND 100),
  predicted TEXT CHECK (predicted IS NULL OR length(predicted) BETWEEN 1 AND 100),
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  -- 失敗の種類（false_safe / misclassified / fabricated_facts / completion_of_missing / missing_fields_mismatch）
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 100),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  UNIQUE (unit_id, run_id, case_ref),
  FOREIGN KEY (unit_id, run_id) REFERENCES ai_evaluation_runs (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_ai_evaluation_cases_run ON ai_evaluation_cases (unit_id, run_id, passed);
