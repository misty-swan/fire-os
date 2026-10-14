-- 0007_revocation: 権限変更・利用停止の理由を保存する列（T012）。
-- 理由は自由文のため監査/outboxには複製せず（docs/04 §1）、変更された行そのものに持つ。
ALTER TABLE users ADD COLUMN disabled_reason TEXT CHECK (disabled_reason IS NULL OR length(disabled_reason) BETWEEN 1 AND 20000);
-- この時刻以前に作られたセッションは業務側で拒否する（認証ライブラリの失効が失敗していても遮断するため。API-38）
ALTER TABLE users ADD COLUMN session_revoked_before TEXT CHECK (session_revoked_before IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', session_revoked_before) IS session_revoked_before);
ALTER TABLE members ADD COLUMN status_reason TEXT CHECK (status_reason IS NULL OR length(status_reason) BETWEEN 1 AND 20000);
ALTER TABLE member_roles ADD COLUMN change_reason TEXT CHECK (change_reason IS NULL OR length(change_reason) BETWEEN 1 AND 20000);
ALTER TABLE scope_assignments ADD COLUMN change_reason TEXT CHECK (change_reason IS NULL OR length(change_reason) BETWEEN 1 AND 20000);
