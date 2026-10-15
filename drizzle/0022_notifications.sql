-- 0022_notifications: 通知（docs/04 §3.4 139-142行の4表、docs/11 通知承認・配送、T050）。
-- ブリーフ表記の0020は0020=inspection_schedulesで使用済みのため、実在最大0021（T049）の次を
-- 連番で採番した（docs/14 D23の採番規則。docs/16 T050に記録）。T051にmigrationが無いため
-- 通知ブロックの4表（notifications／notification_recipients／notification_deliveries／notification_events）
-- をこのmigrationで全部作る（PH3「新ドメインのDDLは最初の保存タスクで作る」と同じ裁定）。
-- 承認（API-64）は①承認固定（bodyHash/audienceHash/version一致。不一致は409）②draft→approved
-- ③配送jobを1本だけ同batch登録（dedupe_key=`${unitId}|notification.deliver|<通知ID>|<承認時の版>`）まで。
-- deliveries行の生成・provider呼出し・approved→dispatching遷移はT051の配送handlerが行う（docs/16 T050裁定）。
-- T051（2026-10-15）: delivery_key=`${通知ID}|${recipientId}|${channel}`の固定キー・attempt_count=1で行を生成。
-- 配送statusのCHECKにcancelled（未送分取消。docs/11 pending→cancelledのみ）を追加（T050で作成したCHECKを
-- リリース前に拡張。0014への後追い追加と同じ流儀。docs/16 T051に記録）。

-- 通知承認root（docs/04:139。root可変表＝docs/04 §1の共通列付き）
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  -- 通知の源（docs/05 API-63「source」）: 未回答者抽出=activity（T036/T047の対象snapshot−回答あり）、
  -- お知らせ=announcement（T045のrevisionから引用）、点検期限=inspection_due（T048の検出ログ）。
  -- source_idは多形参照のためFKを置かない（audit_logs.entity_idと同じ）。実在はdraft作成時に
  -- サービス層で検査し、読めない源は400（docs/16 T050裁定）
  source_type TEXT NOT NULL CHECK (source_type IN ('activity', 'announcement', 'inspection_due')),
  source_id TEXT NOT NULL,
  -- 承認した本文（docs/04「body_revision:J」。{"body": テキスト}のJSON）。
  -- 本文/対象の変更は新draftを作るためUPDATEしない（docs/04「承認した本文と対象を固定、変更時新draft」）
  body_revision TEXT NOT NULL CHECK (json_valid(body_revision) AND json_type(body_revision) = 'object'),
  -- 対象の固定hash（対象memberId整列配列の正規化JSONのSHA-256。API-64の承認が一致を要求＝409に使う。
  -- 対象の実体はnotification_recipientsの明示snapshot）
  audience_hash TEXT NOT NULL CHECK (length(audience_hash) = 64),
  -- docs/11 通知承認: draft→approved/cancelled、approved→dispatching→finished/failed。
  -- approved→cancelledは配送単位の取消のためT050では許可しない（docs/16 T050裁定。遷移表は
  -- src/shared/states.ts notificationApprovalTransitions）
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'cancelled', 'dispatching', 'finished', 'failed')),
  approved_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  approved_at TEXT CHECK (approved_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', approved_at) IS approved_at),
  -- 期限（T051の配送が期限切れ対象を配信直前に除外する材料。docs/07 §5）
  expires_at TEXT CHECK (expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_mutation_token TEXT,
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at),
  created_by TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  CHECK (actor_kind = 'system' OR created_by IS NOT NULL),
  -- 承認は承認者と承認時刻を対で残す（draft/cancelledは両方NULL）
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  UNIQUE (unit_id, id)
);
-- 源からの逆引き（点検期限の再通知など。源は多形のためFKなし）
CREATE INDEX idx_notifications_source ON notifications (source_type, source_id);
-- 送信者の一覧・状態絞り込み
CREATE INDEX idx_notifications_status ON notifications (unit_id, status, id);

-- 対象者（docs/04:140「notification_id, member_id, channel, address_ref, read_at。親/member/channel UNIQUE、
-- 既読は本人recipient、連絡先生値をジョブへ複製しない」。中間表＝docs/04 §1の共通列付き）
CREATE TABLE notification_recipients (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  notification_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  -- docs/14 D13: チャネルは未承認。開発は推奨案の「アプリ内」一経路（inapp）を検証設定として使い、
  -- 実チャネル（Web Push/email）の拡張はD13了承後（docs/16 T050。遷移でなく列挙はstates.ts notificationChannels）
  channel TEXT NOT NULL CHECK (channel IN ('inapp')),
  -- 連絡先の「参照」だけを保存し、生値（電話番号・氏名）を複製しない（docs/04「連絡先生値をジョブへ複製しない」）。
  -- inappは本人の受信箱＝ member:<memberId>#inbox 形式（T051の配送が参照を解決して実値を読む）
  address_ref TEXT NOT NULL CHECK (length(address_ref) BETWEEN 1 AND 200),
  -- 既読は本人（API-100）だけが付けられる。配送（deliveries）と分離（docs/04「既読と配送を分離」）
  read_at TEXT CHECK (read_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', read_at) IS read_at),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  CHECK (actor_kind = 'human' OR actor_user_id IS NULL),
  UNIQUE (notification_id, member_id, channel),
  -- notification_deliveriesの複合FK（unit_id, recipient_id）の参照先（docs/04 §1「親のUNIQUE(unit_id,id)」）
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, notification_id) REFERENCES notifications (unit_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (unit_id, member_id) REFERENCES members (unit_id, id) ON DELETE RESTRICT
);
-- member側（API-67「本人がrecipientの通知の一覧」）と親側（API-65の対象一覧）
CREATE INDEX idx_notification_recipients_member ON notification_recipients (member_id, notification_id);
CREATE INDEX idx_notification_recipients_notification ON notification_recipients (notification_id);

-- 配送（docs/04:141。行の生成・更新はT051の配送handler。docs/11 配送:
-- pending→sending→provider_accepted/failed/unknown、failed/unknown→retry_wait→sending）
CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  recipient_id TEXT NOT NULL,
  -- 再試行で固定の配信キー（docs/05 §2「notification delivery key…API冪等キーと役割が異なる」）
  delivery_key TEXT NOT NULL,
  -- 行は最初の送信試行で作り、current行のattempt_countを増分する（docs/04「current行のattempt_count増分」）。
  -- 各試行はnotification_eventsへ追記する（T051）
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
  -- docs/11 配送（T051でcancelledを追加）: pending→sending→provider_accepted/failed/unknown、
  -- failed/unknown→retry_wait→sending、pending→cancelled（未送分取消のみ。送信済みを未送へ戻さない。
  -- 遷移表はsrc/shared/states.ts deliveryTransitions）
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'provider_accepted', 'failed', 'unknown', 'retry_wait', 'cancelled')),
  provider_id TEXT CHECK (provider_id IS NULL OR length(provider_id) BETWEEN 1 AND 200),
  -- 短いコードのみ（内部の例外文・宛先を載せない。jobs.error_codeと同じ方針）
  last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 100),
  next_attempt_at TEXT CHECK (next_attempt_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at) IS next_attempt_at),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'system' OR actor_user_id IS NOT NULL),
  CHECK (actor_kind = 'human' OR actor_user_id IS NULL),
  UNIQUE (delivery_key),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, recipient_id) REFERENCES notification_recipients (unit_id, id) ON DELETE RESTRICT
);
-- 再試行の走査（docs/04 §4 索引契約「配送(status,next_attempt_at)」）
CREATE INDEX idx_notification_deliveries_status ON notification_deliveries (status, next_attempt_at);
CREATE INDEX idx_notification_deliveries_recipient ON notification_deliveries (recipient_id);

-- 承認/取消/期限/配送全体の履歴（docs/04:142。追記型）
CREATE TABLE notification_events (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  notification_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  details TEXT NOT NULL CHECK (json_valid(details) AND json_type(details) = 'object'),
  actor_user_id TEXT REFERENCES users (id) ON DELETE RESTRICT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'system')),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  CHECK (actor_kind = 'human' OR actor_user_id IS NULL),
  UNIQUE (unit_id, id),
  FOREIGN KEY (unit_id, notification_id) REFERENCES notifications (unit_id, id) ON DELETE RESTRICT
);
CREATE INDEX idx_notification_events_notification ON notification_events (notification_id, created_at);

-- 追記専用の保護（0003/0020と同じ方式。履歴のINSERT OR REPLACEによる書換えを拒否する）
CREATE TRIGGER notification_events_no_replace BEFORE INSERT ON notification_events
WHEN EXISTS (SELECT 1 FROM notification_events WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'notification_events is append-only'); END;
