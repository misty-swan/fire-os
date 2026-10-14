-- 0012_inspection_templates: 点検様式の版と承認（T027、docs/04 §3.3、docs/11、D06）
-- 様式(root)に現在の承認版ポインタを持ち、版は追記型。承認済みの版は不変（DBがUPDATE/DELETEを拒否）。
-- 項目schemaは docs/05 の itemSchema（code/label/valueType/required/allowedResults）。架空の正式様式として扱わない（D06未承認）。

CREATE TABLE inspection_templates (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  target_type TEXT NOT NULL CHECK (target_type IN ('facility', 'vehicle', 'equipment')),
  current_version_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  UNIQUE (unit_id, id),
  UNIQUE (unit_id, id, name)
);
CREATE INDEX idx_inspection_templates_unit ON inspection_templates (unit_id, target_type, status);

CREATE TABLE inspection_template_versions (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  template_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  item_schema TEXT NOT NULL CHECK (json_valid(item_schema) AND json_type(item_schema) = 'array'),
  -- docs/11 の報告書/文書版と同じ流れ: draft→in_review→approved/changes_requested。承認済は不変
  status TEXT NOT NULL CHECK (status IN ('draft', 'in_review', 'approved', 'changes_requested', 'superseded')),
  approved_by_member_id TEXT,
  approved_at TEXT CHECK (approved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', approved_at) IS approved_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- 承認済みの版だけが承認者と承認時刻を持つ
  CHECK ((status = 'approved') = (approved_by_member_id IS NOT NULL)),
  CHECK ((status = 'approved') = (approved_at IS NOT NULL)),
  UNIQUE (template_id, revision_no),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, template_id) REFERENCES inspection_templates (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_inspection_template_versions_template ON inspection_template_versions (template_id, revision_no);

-- 承認済みの版は不変（docs/11「原本不変」）。status/approved列のUPDATEとDELETEを拒否する
CREATE TRIGGER inspection_template_versions_immutable_upd BEFORE UPDATE ON inspection_template_versions
WHEN OLD.status = 'approved' AND (
  NEW.item_schema IS NOT OLD.item_schema OR NEW.status <> OLD.status OR NEW.approved_by_member_id IS NOT OLD.approved_by_member_id OR NEW.approved_at IS NOT OLD.approved_at
)
BEGIN SELECT RAISE(ABORT, 'inspection_template_versions: approved version is immutable'); END;
CREATE TRIGGER inspection_template_versions_immutable_del BEFORE DELETE ON inspection_template_versions
WHEN OLD.status = 'approved'
BEGIN SELECT RAISE(ABORT, 'inspection_template_versions: approved version is immutable'); END;
