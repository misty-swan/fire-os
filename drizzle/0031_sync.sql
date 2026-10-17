-- 0031_sync: 通信断同期の冪等台帳（docs/04:167「sync_operations」、docs/05 §2、docs/07 端末保持、T076）。
-- ブリーフ表記の0025_syncは0025=report_llmで使用済みのため、実在最大0030（T071）の次を連番で採番した
-- （docs/14 D23の採番規則。0022_notificationsと同じ扱い）。
-- 役割: 下書き本文ではなく同期結果/冪等台帳。user_id/device_id/client_operation_idのUNIQUEは恒久保持し
-- （docs/05 §2「同期effectは別UNIQUEを恒久保持し期限後も二重効果を防ぐ」）、適用済みの同キー再送は
-- result_jsonに保存したSyncOperationを返す（docs/07「適用済operationの再送は同結果」）。
-- expires_atは冪等の保持期間と同じ7日（mutations/execute.tsのIDEMPOTENCY_TTL_MS）。期限後の同キー再送は
-- key_expiredの409になり、人は結果を確認して新しい操作を作る（docs/05 §2「下書きの自動再送は7日を上限」、D14）。
-- 書込みは元業務mutationと同一batch（mutations/execute.tsのMutationSpec.sideEffects、T076）だけ。
-- 行は一度書いたら更新・削除しない（result_jsonは業務本文の複製でなく{id,status}のみ）。

CREATE TABLE sync_operations (
  id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units (id) ON DELETE RESTRICT,
  -- 操作者。照会（API-82）は本人だけ（docs/05 API-82「PER-13本人」）。他人の操作は存在も明かさない
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  device_id TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 200),
  client_operation_id TEXT NOT NULL CHECK (length(client_operation_id) BETWEEN 1 AND 128),
  -- 元操作のoperation code（T076のallowlist: 点検保存/訂正・本人出欠・参集。上限100は監査の語彙と同じ）
  operation_code TEXT NOT NULL CHECK (length(operation_code) BETWEEN 1 AND 100),
  -- 元対象（facility/activity/incident/点検原本。操作ごとに型が違うため多形参照＝FKを置かない。audit_logs.entity_idと同じ）
  target_id TEXT NOT NULL,
  -- 元対象の版（新規作成は0。docs/05 SyncCommand「VersionOrZero」。docs/04はI?（任意）なのでNULLも許す）
  base_version INTEGER CHECK (base_version IS NULL OR base_version >= 0),
  -- 同期コマンドの正規化hash（operationCode/targetId/baseVersion/payloadのSHA-256）。
  -- 同キー別本文の検出に使い、台帳の解決を元操作の組み立て無しで行える（docs/05 §1「同キー別本文は409」）。
  -- 元APIのrequestHashはidempotency_records.canonical_request_hash側に保存される（許可元APIと同hash）
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  -- docs/11の同期操作状態のうちサーバーが確定させる終端だけ（local_draft/pending/sendingは端末側の状態）。
  -- 現在書込むのはappliedだけ。失敗は台帳に行を作らず、業務効果ゼロのまま再送で同じ失敗を再導出する
  status TEXT NOT NULL CHECK (status IN ('applied', 'conflict', 'rejected')),
  -- 保存した応答（SyncOperation={id,status}のJSON。業務本文・個人情報は複製しない）
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  created_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS created_at),
  expires_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', expires_at) IS expires_at),
  UNIQUE (user_id, device_id, client_operation_id)
);
-- 照会はid（PK）、鍵の解決はUNIQUE索引で足りる。一覧APIは無く（docs/05はAPI-81/82のみ）、
-- 恒久保持の行を絞る索引も作らない（未使用の索引を増やさない。docs/04 §4の索引契約にない）
