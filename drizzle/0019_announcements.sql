-- 0019_announcements: お知らせ（docs/04 §3.4 132-135行、T045）。
-- 公開対象は announcement_audience の明示snapshot（名簿変更で対象を変えない）。
-- 内容と対象の変更は新revision（announcement_revisions。親/版UNIQUE。変更原本＝追記のみで不変）で、
-- 既読（announcement_reads）は版(revision_no)に束縛され、改版後は取り直す（docs/11 お知らせ行）。
-- 通知（API-63〜65/100）はPH4のため、作成/公開/改版で通知ジョブを自動起動しない
-- （docs/11「対象変更は新通知承認」。docs/16 T045「編集/対象変更で通知を自動承認/再送しない」）。

-- お知らせroot（docs/04:132「title, body, revision_no, status, published_at。公開対象は下表、日時/状態整合」）
CREATE TABLE announcements (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  -- 現在版（1始まり。title/body/対象の変更で増分。既読はこの版に束縛される）
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  -- docs/11 お知らせ: draft→published/archived、published→archived、archivedは終端
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  -- 公開日時。draftでも作成時に指定された公開予定時刻(publishAt)を保持し、公開操作時に確定値として使う
  -- （自動公開jobは作らない。公開への遷移はAPI-72の明示操作。docs/16 T045）
  published_at TEXT CHECK (published_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', published_at) IS published_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- 公開状態なら公開日時が確定している（draft→archivedの非公開廃止は published_at NULL のまま許す）
  CHECK (status != 'published' OR published_at IS NOT NULL),
  UNIQUE (unit_id, id)
);

-- 版（docs/04:133「親/版UNIQUE、変更原本保持」。対象snapshotを同梱する。追記のみでUPDATE/DELETEしない）
CREATE TABLE announcement_revisions (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  announcement_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  -- 対象の明示snapshot（member_id配列のJSON。版の時点の対象を保持し、名簿変更で内容を変えない）
  audience_snapshot TEXT NOT NULL CHECK (json_valid(audience_snapshot) AND json_type(audience_snapshot) = 'array'),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  UNIQUE (announcement_id, revision_no),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, announcement_id) REFERENCES announcements (unit_id, id) ON DELETE RESTRICT
);

-- 対象（docs/04:134「組合せUNIQUE、対象を明示snapshot」。現在の対象。対象変更で全置換する）
CREATE TABLE announcement_audience (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  announcement_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  UNIQUE (announcement_id, member_id),
  FOREIGN KEY (unit_id, announcement_id) REFERENCES announcements (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT
);
-- 索引契約（docs/04 §4「全FK子列」。member側からの既読母数・可視判定用）
CREATE INDEX idx_announcement_audience_member ON announcement_audience (member_id, announcement_id);

-- 既読（docs/04:135「三つ組UNIQUE、本人のみ、既読と配送を分離」。版に束縛。追記のみで更新/削除しない）
CREATE TABLE announcement_reads (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  announcement_id TEXT NOT NULL,
  -- 既読を付けた版（docs/11「既読は版に束縛」。改版後は別の行として取り直す）
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  member_id TEXT NOT NULL,
  read_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', read_at) IS read_at),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  UNIQUE (announcement_id, revision_no, member_id),
  FOREIGN KEY (unit_id, announcement_id) REFERENCES announcements (unit_id, id) ON DELETE RESTRICT,
  -- 既読の版は同じお知らせの実在する版だけ（変更原本と版番号の対応を保つ）
  FOREIGN KEY (announcement_id, revision_no) REFERENCES announcement_revisions (announcement_id, revision_no) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT
);
-- 索引契約（docs/04 §4「全FK子列」。member側からの既読参照（ホーム/一覧の未読判定）用。版側はUNIQUEで茂る）
CREATE INDEX idx_announcement_reads_member ON announcement_reads (member_id, announcement_id);
