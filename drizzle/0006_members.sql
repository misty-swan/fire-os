-- 0006_members: 名簿の拡張（T011、docs/04 §3.1、D02の検証設定）
-- 班(squad)・資格(qualifications)は prototype（団員名簿の班/資格フィルタ）に合わせた基本項目。
-- member_private_profiles は個人情報（連絡先）。保存できる列は許可リスト（phone / emergencyContact）だけで、
-- 未承認の列はDBが拒否する（D02：未承認列は収集しない）。許可列を増やすときはこのトリガーと config を一緒に変更する。

ALTER TABLE members ADD COLUMN squad TEXT CHECK (squad IS NULL OR length(squad) BETWEEN 1 AND 100);
ALTER TABLE members ADD COLUMN qualifications TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(qualifications) AND json_type(qualifications) = 'array' AND json_array_length(qualifications) <= 10);
CREATE INDEX idx_members_unit_name ON members (unit_id, display_name, id);

CREATE TABLE member_private_profiles (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  member_id TEXT NOT NULL UNIQUE,
  -- 許可列の値（{"phone":"…","emergencyContact":"…"}）。列名が「許可項目」の意味
  allowed_fields TEXT NOT NULL CHECK (json_valid(allowed_fields) AND json_type(allowed_fields) = 'object'),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  FOREIGN KEY (unit_id, member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_member_private_unit ON member_private_profiles (unit_id);

-- 許可列以外のキー、文字列でない値、200文字超を拒否する（INSERT/UPDATEの両方）
CREATE TRIGGER member_private_profiles_allowlist_ins BEFORE INSERT ON member_private_profiles
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.allowed_fields)
  WHERE key NOT IN ('phone', 'emergencyContact') OR type <> 'text' OR length(value) NOT BETWEEN 1 AND 200
)
BEGIN SELECT RAISE(ABORT, 'member_private_profiles: field not allowed (D02 allowlist)'); END;
CREATE TRIGGER member_private_profiles_allowlist_upd BEFORE UPDATE OF allowed_fields ON member_private_profiles
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.allowed_fields)
  WHERE key NOT IN ('phone', 'emergencyContact') OR type <> 'text' OR length(value) NOT BETWEEN 1 AND 200
)
BEGIN SELECT RAISE(ABORT, 'member_private_profiles: field not allowed (D02 allowlist)'); END;
