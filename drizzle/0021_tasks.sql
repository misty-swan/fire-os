-- 0021_tasks: 業務タスク（docs/04:136「tasks/task_events」、docs/11 業務タスク、T049）。
-- ブリーフ表記の0019は0019=announcementsで使用済みのため、実在最大0020（T048）の次を連番で採番した。
-- 手動作成（API-68。sourceDecisionId省略）と承認済みAI起点（承認effect。T054が同一batchで接続）を
-- 同じ表に分離保存し、AI提案そのもの（pending）はai_evaluations側で管理する
-- （docs/04「AIはpending提案へ直接確定できない」、docs/11「AI起点は承認effectから作成」）。

-- 業務タスク（docs/04:136。root可変表＝docs/04 §1の共通列付き）
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  -- 元AI評価（docs/04 source_evaluation_id）。参照先ai_evaluationsはT053（PH4）で作成されるため
  -- FKを置けない（SQLiteは親表が存在しないFKの列にNULLを入れるDMLも失敗させる）。実在はサービス層で
  -- 検査する（T054が承認effect経由でのみ非NULLにする。docs/16 T049に記録）
  source_evaluation_id TEXT,
  -- 元異常（docs/04 source_issue_id）
  source_issue_id TEXT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  assignee_member_id TEXT,
  -- docs/11 業務タスク: open→assigned/in_progress/cancelled、assigned→in_progress/cancelled、
  -- in_progress→done、done→in_progress（再開理由）、cancelledは終端（遷移表はsrc/shared/states.ts taskTransitions）
  status TEXT NOT NULL CHECK (status IN ('open', 'assigned', 'in_progress', 'done', 'cancelled')),
  -- 業務日（YYYY-MM-DD。docs/04 §1「日付期限は業務日TEXT YYYY-MM-DDと明示し瞬間値と混同しない」）
  due_date TEXT CHECK (due_date IS NULL OR strftime('%Y-%m-%d', due_date) IS due_date),
  -- 承認済み決定（docs/04 source_decision_id）。参照先review_decisionsはT053で作成のためFKを置けない
  -- （理由はsource_evaluation_idと同じ）。承認済みdecisionの存在はAPI-68のサービス層検査で要求する
  source_decision_id TEXT,
  -- 一意の効果操作ID（docs/04「effect_operation_id非NULL UNIQUE」。同effectの再実行は部分一意索引で拒否＝二重効果0）
  effect_operation_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- AI起点は承認effectから作る（docs/11）: decisionとeffectは対で必須、手動作成はどちらも持たない
  CHECK ((source_decision_id IS NOT NULL) = (effect_operation_id IS NOT NULL)),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, source_issue_id) REFERENCES issues (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, assignee_member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT
);
-- effect一意（docs/04「effect_operation_id非NULL UNIQUE」。手動作成はNULLのため対象外の部分索引）
CREATE UNIQUE INDEX uq_task_effect_operation ON tasks (effect_operation_id) WHERE effect_operation_id IS NOT NULL;
-- 一覧（docs/04 §4 索引契約のissuesと同じ形。状態・担当で絞る）とAI源の参照
CREATE INDEX idx_tasks_unit_status ON tasks (unit_id, status, assignee_member_id, id);
CREATE INDEX idx_tasks_source_issue ON tasks (source_issue_id);
CREATE INDEX idx_tasks_source_decision ON tasks (source_decision_id);

-- 状態履歴（docs/04:138「task_events」。追記型。状態変更と同commit）
CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  before_json TEXT NOT NULL CHECK (json_valid(before_json) AND json_type(before_json) = 'object'),
  after_json TEXT NOT NULL CHECK (json_valid(after_json) AND json_type(after_json) = 'object'),
  -- 再開・変更の理由（docs/05 §1の入力上限2,000に揃える。API-87のreasonは契約で必須）
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'human' OR actor_user_id IS NULL),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, task_id) REFERENCES tasks (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_task_events_task ON task_events (task_id, created_at);
