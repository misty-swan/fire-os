-- 0024_reports: 報告書・文書版の元（docs/04 §3.4 146-148行のreports/report_versions/content_version_events、
-- docs/11 報告書/文書版、docs/14 D20、T056）。
-- ブリーフ表記の0022は0022=notificationsで使用済みのため、実在最大0023（T053）の次を連番で採番した
-- （docs/14 D23の採番規則。docs/16 T056に記録）。T058にmigrationが無いため3表ともこのmigrationで
-- 全部作る（0022が通知ブロック4表を作ったのと同じ裁定「新ドメインのDDLは最初の保存タスクで作る」）。
-- 版の状態（docs/11 報告書/文書版）: draft→in_review→approved/changes_requested、approved→superseded/withdrawn。
-- 申請（request_review）はcontent_version_eventsへの追記だけで決定行（review_decisions）は作らない（T058以降が書く）。

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  -- 帳票の源（docs/04 ER「ACTIVITIES ||--o{ REPORTS」。1活動に複数帳票可のためUNIQUEは置かない）
  activity_id TEXT NOT NULL,
  -- 種別（T056は人の手動下書きのみ。AI下書き（T057）は種別追加と一緒にCHECKを拡張する）
  kind TEXT NOT NULL CHECK (kind IN ('manual')),
  -- docs/11「承認版とdraftの別pointer」「承認済pointerは次版承認まで保持」
  current_draft_version_id TEXT,
  current_approved_version_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, activity_id) REFERENCES activities (unit_id, id) ON DELETE RESTRICT,
  -- 循環参照（versions側からもreportsへFK）のためDMLの順序は「root(NULL付きINSERT)→版→pointer切替」
  FOREIGN KEY (unit_id, current_draft_version_id) REFERENCES report_versions (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, current_approved_version_id) REFERENCES report_versions (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_reports_unit_activity ON reports (unit_id, activity_id, id);

CREATE TABLE report_versions (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  report_id TEXT NOT NULL,
  -- 使用した帳票様式の版（allowlistの設定artifact。docs/04 §3.5末尾「report_versions.template_versionと
  -- source_versionsに使用版/hashを保存」。hashの照合はconfig/report-templates/manifest.jsonで行う）
  template_version TEXT NOT NULL CHECK (length(template_version) BETWEEN 1 AND 100),
  revision_no INTEGER NOT NULL CHECK (revision_no >= 1),
  -- 人の入力本文（docs/04 §1のBody上限と同じ20,000。共通上限を超える入力は契約で400）
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 20000),
  -- 様式の必須欄で未記入のもの（サーバー計算。docs/05 missingFields）
  missing_fields TEXT NOT NULL CHECK (json_valid(missing_fields) AND json_type(missing_fields) = 'array'),
  -- 参照源の版（サーバーが実績から計算: {activityVersion, resultVersion, resultRevisionNo}。
  -- templateVersionはtemplate_version列。元実績の更新は「保存した版と現行版の不一致」で検出できる）
  source_versions TEXT NOT NULL CHECK (json_valid(source_versions) AND json_type(source_versions) = 'object'),
  -- AI生成時のモデル（カタログ名。手動下書きはNULL。T057以降）
  model_id TEXT CHECK (model_id IS NULL OR length(model_id) BETWEEN 1 AND 200),
  -- docs/11 報告書/文書版（states.ts contentVersionStatesと同じ語彙）
  status TEXT NOT NULL CHECK (status IN ('draft', 'in_review', 'approved', 'changes_requested', 'superseded', 'withdrawn')),
  approved_by TEXT,
  approved_at TEXT CHECK (approved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', approved_at) IS approved_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- 承認記録（approved_by/approved_at）は、承認されたことがある版（approved。superseded/withdrawnへ
  -- 遷んだ後も保持）だけが持つ（0012の点検様式と同じ流儀）。作成時の「approvedだけ」の語のままだと、
  -- 旧承認版のapproved→superseded遷移（docs/11。承認列は不変のままstatusだけ遷める。API-60の
  -- 2回目の承認＝承認後訂正版の承認）がこのCHECKで失敗し、docs/11の状態機械と両立しないため
  -- 0027のdocument_versions（T063）と同型へ拡張（未リリース連番のin-place編集。docs/14 D21と同じ前例）
  CHECK (status IN ('approved', 'superseded', 'withdrawn') = (approved_by IS NOT NULL)),
  CHECK (status IN ('approved', 'superseded', 'withdrawn') = (approved_at IS NOT NULL)),
  -- 「report/版UNIQUE」（docs/04:147）。unit一致を含める（docs/04 §1の複合原則）
  UNIQUE (unit_id, report_id, revision_no),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, report_id) REFERENCES reports (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_report_versions_report ON report_versions (report_id, revision_no);

-- 版の内容は常に不変（docs/04:147「編集/承認版不変」＝編集は常に新draft版を作り、旧版の本文等は
-- 決して書換えない。docs/11「差戻し後/承認後訂正は新draft版、旧版不変」）。承認操作（T058）が更新できるのは
-- status/approved列と共通列（version/last_mutation_token/updated_at）だけ
CREATE TRIGGER report_versions_content_immutable BEFORE UPDATE ON report_versions
WHEN NEW.report_id IS NOT OLD.report_id
  OR NEW.template_version IS NOT OLD.template_version
  OR NEW.revision_no IS NOT OLD.revision_no
  OR NEW.text IS NOT OLD.text
  OR NEW.missing_fields IS NOT OLD.missing_fields
  OR NEW.source_versions IS NOT OLD.source_versions
  OR NEW.model_id IS NOT OLD.model_id
BEGIN SELECT RAISE(ABORT, 'report_versions: version content is immutable'); END;

-- 承認済み（approved以降）の版は承認記録ごと不変（0012の承認済み点検様式と同じ流儀。docs/11
-- approved→superseded/withdrawnのstatus遷移だけが後続操作で許される）
CREATE TRIGGER report_versions_approved_immutable_upd BEFORE UPDATE ON report_versions
WHEN OLD.status IN ('approved', 'superseded', 'withdrawn') AND (
  NEW.approved_by IS NOT OLD.approved_by OR NEW.approved_at IS NOT OLD.approved_at
)
BEGIN SELECT RAISE(ABORT, 'report_versions: approved version is immutable'); END;

-- 版は削除しない（docs/04 §4「履歴/承認/原本をCASCADEで消さない」。撤回はstatus=withdrawnで表現）
CREATE TRIGGER report_versions_no_delete BEFORE DELETE ON report_versions
BEGIN SELECT RAISE(ABORT, 'report_versions: version is append-only'); END;

-- 報告書/文書版の申請・決定履歴（docs/04:148「対象一つ、申請/差戻し/承認/撤回履歴、
-- request_reviewで決定行は作らない」。T058以降が書く。T056では作成のみ）
CREATE TABLE content_version_events (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  report_version_id TEXT,
  document_version_id TEXT,
  -- docs/04:148「申請/差戻し/承認/撤回履歴」＋docs/11 approved→superseded（旧承認版の記録）の語彙
  action TEXT NOT NULL CHECK (action IN ('request_review', 'changes_requested', 'approved', 'superseded', 'withdrawn')),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  CHECK (actor_kind = 'human' OR actor_user_id IS NULL),
  -- 対象はちょうど一つ（docs/04:148「対象一つ」）
  CHECK (((report_version_id IS NOT NULL) + (document_version_id IS NOT NULL)) = 1),
  UNIQUE (unit_id, id)
);
CREATE INDEX idx_content_version_events_report ON content_version_events (report_version_id, created_at);
CREATE INDEX idx_content_version_events_document ON content_version_events (document_version_id, created_at);

-- 追記専用の保護（0003/0020/0022と同じ方式。履歴のINSERT OR REPLACEによる書換えを拒否する）
CREATE TRIGGER content_version_events_no_replace BEFORE INSERT ON content_version_events
WHEN EXISTS (SELECT 1 FROM content_version_events WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'content_version_events is append-only'); END;
