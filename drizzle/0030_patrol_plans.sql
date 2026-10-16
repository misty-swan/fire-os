-- 0030_patrol_plans: 地域の点検巡回計画（docs/04:157「patrol_plans/patrol_plan_stops」、T071）。
-- ブリーフ表記の0024は陳腐（実在0029の次。連番必須のため0030を採番。docs/16 T071に記録）。
-- docs/04:157「順序一意、計画確定は人」。
-- 改版の解釈（docs/16 T071の裁定）: 確定（confirmed）と取消（cancelled）は**終端**。変更は新しい案として
-- 作り直す（docs/11「confirmedの変更は新revision」＝確認済み計画の行は書換えない。planにrevision列は持たず、
-- 作り直しはAPI-78の新規作成になる）。確定後の自動書換・自動派生（出動/タスク/通知/点検）は無い。

-- 巡回計画の案（root可変表。docs/04 §1の共通列付き。版は決定操作の競合ガードに使う）
CREATE TABLE patrol_plans (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  -- 巡回の業務日（YYYY-MM-DD。瞬間値と混同しない。docs/04 §1）
  plan_date TEXT NOT NULL CHECK (strftime('%Y-%m-%d', plan_date) IS plan_date),
  -- 目的（docs/05 API-78のobjective。ShortText 1..200。API入力で400にするため共通上限に揃える）
  objective TEXT NOT NULL CHECK (length(objective) BETWEEN 1 AND 200),
  -- docs/11 巡回計画: draft→confirmed/cancelled。決定は人の操作だけ（AI案の自動確定は無い）
  status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'cancelled')),
  -- 決定（確定/取消）の時刻と実行者。draftではNULL（下のCHECKで対にする）
  decided_at TEXT CHECK (decided_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', decided_at) IS decided_at),
  decided_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- 決定済み（confirmed/cancelled）のときだけ決定者と時刻を持つ（draftはNULL）
  CHECK ((status = 'draft') = (decided_at IS NULL AND decided_by IS NULL)),
  -- 子（stops）の複合FKの受け口
  UNIQUE (unit_id, id)
);
-- 一覧（自分の分団の計画を日付降順で見る。docs/03 SCR-25）とplan側参照
CREATE INDEX idx_patrol_plans_unit_date ON patrol_plans (unit_id, plan_date);

-- 巡回の立ち寄り順（docs/04:157「stop側plan_id/facility_id/position。順序一意」）。
-- 案作成時にサーバーが施設座標から最近傍順（nearest-neighbor。決定的ルール。docs/14 D01の外部最適化は使わない）
-- を提案して保存し、確定（API-79 decision=confirm）のときに人が送った順序で**同じbatch内で作り直す**。
-- SQLiteの一意制約は即時のため位置の入替えを直接UPDATEできず、DELETE+INSERTで確定する（docs/16 T071に記録）。
CREATE TABLE patrol_plan_stops (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL,
  facility_id TEXT NOT NULL,
  -- 1始まりの立ち寄り順
  position INTEGER NOT NULL CHECK (position >= 1),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  -- plan内でposition一意（順序一意。docs/04:157。positionはNOT NULLのため一意索引で担保）
  UNIQUE (unit_id, plan_id, position),
  -- 同じ施設を同じ案に2回入れない（決定時の「重複なし」のDB側の防線。docs/16 T071）
  UNIQUE (unit_id, plan_id, facility_id),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, plan_id) REFERENCES patrol_plans (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, facility_id) REFERENCES facilities (unit_id, id) ON DELETE RESTRICT
);
-- 施設側からの参照（docs/04 §4「全FK子列」）とplanの読み出し（position順）
CREATE INDEX idx_patrol_plan_stops_facility ON patrol_plan_stops (facility_id);
CREATE INDEX idx_patrol_plan_stops_plan ON patrol_plan_stops (plan_id, position);
