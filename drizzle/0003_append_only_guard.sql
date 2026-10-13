-- 0003_append_only_guard: 追記専用表を INSERT OR REPLACE でも書き換えられないようにする（PH0レビュー A-F3）
-- SQLiteの REPLACE は衝突した行を消してから挿入するが、recursive_triggers が無効だと DELETE トリガーが発火しない。
-- そこで、既存の行と衝突する INSERT 自体を拒否する。
CREATE TRIGGER audit_logs_no_replace BEFORE INSERT ON audit_logs
WHEN EXISTS (SELECT 1 FROM audit_logs WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

CREATE TRIGGER domain_events_no_replace BEFORE INSERT ON domain_events
WHEN EXISTS (
  SELECT 1 FROM domain_events
  WHERE id = NEW.id OR (unit_id = NEW.unit_id AND (sequence = NEW.sequence OR mutation_id = NEW.mutation_id))
)
BEGIN SELECT RAISE(ABORT, 'domain_events is append-only'); END;
