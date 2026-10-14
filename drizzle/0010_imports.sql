-- 0010_imports: 施設CSV取込みのバッチと行（T023/T024、docs/04 §3.5）
-- プレビュー（jobで解析）で業務台帳は変更しない。確定はbatch版で一回、行ごとに結果（有効/エラー/確定先）を残す。

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  attachment_id TEXT NOT NULL,
  template_version TEXT NOT NULL CHECK (template_version IN ('csv-facilities-v1')),
  -- pending=未解析 / parsing=解析中 / ready=プレビュー完了 / failed=解析不能 / committing=確定中 / committed=確定済
  status TEXT NOT NULL CHECK (status IN ('pending', 'parsing', 'ready', 'failed', 'committing', 'committed')),
  input_hash TEXT CHECK (input_hash IS NULL OR length(input_hash) = 64),
  preview_hash TEXT CHECK (preview_hash IS NULL OR length(preview_hash) = 64),
  total_rows INTEGER CHECK (total_rows IS NULL OR total_rows >= 0),
  valid_rows INTEGER CHECK (valid_rows IS NULL OR valid_rows >= 0),
  error_rows INTEGER CHECK (error_rows IS NULL OR error_rows >= 0),
  base_dataset_revision INTEGER CHECK (base_dataset_revision IS NULL OR base_dataset_revision >= 1),
  committed_rows INTEGER CHECK (committed_rows IS NULL OR committed_rows >= 0),
  commit_version INTEGER CHECK (commit_version IS NULL OR commit_version >= 1),
  -- 解析不能の理由（短いコードのみ。CSVの本文は保存しない）
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 100),
  conflict_resolution TEXT CHECK (conflict_resolution IS NULL OR conflict_resolution IN ('skip', 'overwrite')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  UNIQUE (unit_id, id)
);
CREATE INDEX idx_import_batches_unit ON import_batches (unit_id, status);

CREATE TABLE import_rows (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  batch_id TEXT NOT NULL,
  row_no INTEGER NOT NULL CHECK (row_no >= 1),
  -- 有効な行の正規化結果。エラー行はNULL
  normalized_json TEXT CHECK (normalized_json IS NULL OR json_valid(normalized_json)),
  -- NULL=有効。それ以外は短い理由コード（列名などID・コード形式のみ）
  error TEXT CHECK (error IS NULL OR length(error) BETWEEN 1 AND 100),
  -- 確定で作成/更新した施設。チャンク再開の再開位置にも使う
  committed_facility_id TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK ((error IS NULL) = (normalized_json IS NOT NULL)),
  UNIQUE (batch_id, row_no),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, batch_id) REFERENCES import_batches (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_import_rows_batch ON import_rows (batch_id, row_no);
