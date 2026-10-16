-- 0023_ai: AI評価と人の決定（docs/04 §3.4 143-145行のai_evaluations/review_decisions、docs/11 AI提案、T053）。
-- ブリーフ表記の0021は0021=tasksで使用済みのため、実在最大0022（T050/T051/T052）の次を連番で採番した
-- （docs/14 D23の採番規則。docs/16 T053に記録）。T054にmigrationが無いため2表をこのmigrationで
-- 全部作る（0022が通知ブロック4表を作ったのと同じ裁定「新ドメインのDDLは最初の保存タスクで作る」）。
-- tasks.source_evaluation_id/source_decision_idのFKは0021時点では置けなかった（参照先が無いため。
-- docs/16 T049裁定）が、表はこのmigrationで作るため**0021のtasks側のFKは追加入れない**
-- （既存行の検査コストとT049との差分を避ける。存在検査はサービス層のまま＝docs/04:137の注記どおり）。

-- jobsへ複合FKを張るための参照先（docs/04 §1「unit一致は親のUNIQUE(unit_id,id)と子の複合FKを原則」。
-- 0002のjobsはid PKとdedupe_key UNIQUEのみで(unit_id,id)のUNIQUEが無かった）
CREATE UNIQUE INDEX uq_jobs_unit_id ON jobs (unit_id, id);

-- AI評価（docs/04:143「job_id, source_type, source_id, source_version, input_hash, input_snapshot_ref,
-- question_version, model_id, actual_model_version, output_json, status, usage_json」。追記型＝
-- docs/04 §1の中間表共通列付き。jobが出す候補の保存でUPDATEしない。statusの遷移（docs/11 AI提案:
-- pending→approved/approved_with_edit/rejected、元版/権限更新→stale）はT054以降の承認処理が行う）
CREATE TABLE ai_evaluations (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  -- この評価を出したjob（docs/04 ER「JOBS ||--o{ AI_EVALUATIONS」。同じjobの再実行では2件作らない）
  job_id TEXT NOT NULL,
  -- 分類の源（API-29のsourceType）。点検はseries版、異常はissue版をsource_versionに持つ
  -- **T068実装（CHECK語彙のin-place追加。未リリース連番の前例＝0022/T051・0027/T064どおり）**:
  -- 'assistant'（業務横断AIの提案。API-77）を追加。assistant源のsource_idは `query:<質問本文のsha256>`、
  -- source_versionは提案自体の前提版=1（T054の「初回決定1固定」と同じ扱い。docs/16 T068）
  source_type TEXT NOT NULL CHECK (source_type IN ('facility_inspection', 'asset_inspection', 'issue', 'assistant')),
  -- 多形参照のためFKを置かない（audit_logs.entity_idと同じ。実在・同unitはjob handlerが再検査する）
  source_id TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  -- 最小化input（docs/14 D12「架空/許諾済・最小化本文」。氏名・連絡先を含めない）のSHA-256
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  -- 参照版への印（実体は源の表。本文の複製はしない。docs/06 §3「最小化inputのhashと参照版を記録」）
  input_snapshot_ref TEXT CHECK (input_snapshot_ref IS NULL OR length(input_snapshot_ref) BETWEEN 1 AND 200),
  question_version TEXT NOT NULL CHECK (length(question_version) BETWEEN 1 AND 100),
  -- 要求したモデル（カタログ名。docs/06 §2）と実モデル版（戻り値のmodel。未固定＝V04で実証）
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 200),
  actual_model_version TEXT CHECK (actual_model_version IS NULL OR length(actual_model_version) BETWEEN 1 AND 200),
  -- 候補本体（docs/06 §3「生出力JSONと別保存」の人の確定はreview_decisions側。ここには候補＋生出力answers）
  output_json TEXT NOT NULL CHECK (json_valid(output_json) AND json_type(output_json) = 'object'),
  -- docs/11 AI提案: pending→approved/approved_with_edit/rejected、元版/権限更新→stale（遷移表はstates.ts）
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'approved_with_edit', 'rejected', 'stale')),
  usage_json TEXT CHECK (usage_json IS NULL OR (json_valid(usage_json) AND json_type(usage_json) = 'object')),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  CHECK (actor_kind = 'human' OR actor_user_id IS NULL),
  -- 「job/出力種別 UNIQUE」（docs/04:143）: 出力種別はT053時点でclassificationのみ（種別列を持たない）ため
  -- unit×jobで1件に固定する。種別が増える（報告書draft等）ときは種別列の追加と一緒に拡張する（docs/16 T053）
  UNIQUE (unit_id, job_id),
  -- 子（review_decisions）の複合FKの参照先（docs/04 §1「親のUNIQUE(unit_id,id)」）
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, job_id) REFERENCES jobs (unit_id, id) ON DELETE RESTRICT
);
-- API-30の一覧（docs/04 §4のissuesと同じ形。状態・源種別で絞る）と源からの逆引き（T054のレビュー表示）
CREATE INDEX idx_ai_evaluations_unit_status ON ai_evaluations (unit_id, status, id);
CREATE INDEX idx_ai_evaluations_source ON ai_evaluations (source_type, source_id);

-- 人の決定（docs/04:145「evaluation_id, report_version_id, document_version_id, decision,
-- confirmed_payload, reviewer_member_id, reviewed_at, reason, effect_operation_id」。
-- root可変表＝docs/04 §1の共通列付き（API-31の版ガード用。T054が書く））
CREATE TABLE review_decisions (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  -- 対象はちょうど一つ（docs/04:145「対象ちょうど一つ」のCHECK）。AI評価はT053で作成済みのためFKを置ける
  evaluation_id TEXT,
  -- report_versions/document_versionsはPH4以降で作成のためFKを置けない（audit_logs.entity_idと同じ。
  -- 実在・同unitはサービス層で検査する。T054以降）
  report_version_id TEXT,
  document_version_id TEXT,
  -- docs/11 AI提案の語彙（T049のfindApprovedDecisionがapproved/approved_with_editで待つ。
  -- docs/05 API-31 ReviewInputのdecision=approve/approve_with_edit/rejectとは入出力で語彙が違う。
  -- 入力値→保存値の対応はT054が行う。docs/16 T053裁定）
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'approved_with_edit', 'rejected')),
  -- 承認（または却下）の確定内容（confirmedPayload。approved_with_editの変更内容を保存＝docs/04:145）
  confirmed_payload TEXT NOT NULL CHECK (json_valid(confirmed_payload) AND json_type(confirmed_payload) = 'object'),
  reviewer_member_id TEXT NOT NULL,
  reviewed_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', reviewed_at) IS reviewed_at),
  -- 却下・修正の理由（docs/05 §1の理由上限2,000に揃える）
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  -- 一意の効果操作ID（docs/04:145「effect操作ID UNIQUE」。T054が承認effectで設定する。
  -- 却下は効果を伴わないためNULL可＝部分一意。二重決定・二重効果の防止は各対象の部分UNIQUEと対で使う）
  effect_operation_id TEXT CHECK (effect_operation_id IS NULL OR length(effect_operation_id) BETWEEN 1 AND 200),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  CHECK (
    ((evaluation_id IS NOT NULL) + (report_version_id IS NOT NULL) + (document_version_id IS NOT NULL)) = 1
  ),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, evaluation_id) REFERENCES ai_evaluations (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, reviewer_member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT
);
-- 「各対象非NULL UNIQUE」（docs/04:145。一版一決定＝二重決定409。effectはT054が設定）
CREATE UNIQUE INDEX uq_review_decision_evaluation ON review_decisions (evaluation_id) WHERE evaluation_id IS NOT NULL;
CREATE UNIQUE INDEX uq_review_decision_report_version ON review_decisions (report_version_id) WHERE report_version_id IS NOT NULL;
CREATE UNIQUE INDEX uq_review_decision_document_version ON review_decisions (document_version_id) WHERE document_version_id IS NOT NULL;
-- 「effect操作ID UNIQUE」（docs/04:145。同effectの2回目は409＝二重効果0。tasksのuq_task_effect_operationと対）
CREATE UNIQUE INDEX uq_review_decision_effect ON review_decisions (effect_operation_id) WHERE effect_operation_id IS NOT NULL;
CREATE INDEX idx_review_decisions_reviewer ON review_decisions (unit_id, reviewer_member_id, id);
