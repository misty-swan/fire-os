-- 0025_report_llm: LLM下書きの生成証跡列（docs/04:147、docs/06 §4、docs/14 D16、T057）。
-- ai_evaluations（0023）へは保存しない: report評価を入れるにはsource_type語彙のCHECK拡張＝表の作り直しが要る一方、
-- 生成証跡は承認対象の「版」に付く方が一貫する（docs/11 報告書/文書版。承認の対象はreport_versions。
-- review_decisions.report_version_id＝T053が用意済み）。版側の列追加（ALTER TABLE ADD COLUMN。
-- 既存行はNULLでCHECKを満たす）で usage/prompt版/最小化input hash を記録する。
-- 手動下書き（T056のAPI-62/59）はmodel_idと同じく全てNULL（生成のみで使う列）。
-- この方式変更（docs/06 §3の「ai_evaluationsへ保存」から版側への変更）はdocs/06・docs/04・docs/16に記録する。

ALTER TABLE report_versions ADD COLUMN prompt_version TEXT CHECK (prompt_version IS NULL OR length(prompt_version) BETWEEN 1 AND 100);
ALTER TABLE report_versions ADD COLUMN input_hash TEXT CHECK (input_hash IS NULL OR length(input_hash) = 64);
ALTER TABLE report_versions ADD COLUMN usage_json TEXT CHECK (usage_json IS NULL OR (json_valid(usage_json) AND json_type(usage_json) = 'object'));

-- 内容不変のトリガーを新3列も守る形で置き直す（0024のトリガーは列比較に新列が含まれないため。
-- 生成証跡も内容の一部であり、保存後に書換えられてはdocs/06 §3「生出力は書換ない」の趣旨を満たさない）
DROP TRIGGER report_versions_content_immutable;
CREATE TRIGGER report_versions_content_immutable BEFORE UPDATE ON report_versions
WHEN NEW.report_id IS NOT OLD.report_id
  OR NEW.template_version IS NOT OLD.template_version
  OR NEW.revision_no IS NOT OLD.revision_no
  OR NEW.text IS NOT OLD.text
  OR NEW.missing_fields IS NOT OLD.missing_fields
  OR NEW.source_versions IS NOT OLD.source_versions
  OR NEW.model_id IS NOT OLD.model_id
  OR NEW.prompt_version IS NOT OLD.prompt_version
  OR NEW.input_hash IS NOT OLD.input_hash
  OR NEW.usage_json IS NOT OLD.usage_json
BEGIN SELECT RAISE(ABORT, 'report_versions: version content is immutable'); END;
