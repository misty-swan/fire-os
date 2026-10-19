# 受入試験の結果（T085。開発版＝架空データ・ローカル）

> **生成物**: `npm run collect:evidence` が証跡index（docs/evidence/acceptance-index.json）と受入manifest（tests/acceptance/manifest.json）から作る。手で編集しない（`npx tsx scripts/collect-evidence.ts --report-only` で作り直す）。
>
> **この表の「合格（局所）」は、架空データ・ローカル（workerd＋ローカルD1・Playwright chromium・fake AI）で参照先の実テストが今のコードで全部合格したという意味**で、docs/13 RG-03（正式リリースの受入合格）ではない。実外部・実端末・人の手順は「未実施」の列に残し、合格に数えない（コントローラ裁定R3）。test:live は Secret 未設定のため未実施（R4）。

## 実行環境と版

| 項目 | 値 |
|---|---|
| 収集日時 | 2026-10-19T11:26:53.564Z |
| commit | ceea8b545e9787820a941624e825895999b3534e（未コミットのコード変更 32件を含む作業木で実行。内容はcodeHashで固定） |
| codeHash | 70dceb2c3aa47138fc1b41924a59f37ba84333678b5e582ad02d17578f48d501 |
| 設計版 | 08:v0.3 / 2026-10-13 12:v0.3 / 2026-10-15 |
| 実行環境 | node v26.8.2 / linux-x64 / Playwright 1.64.0 / vitest/4.1.11 linux-x64 node-v26.8.2 / wrangler 4.150.0 |
| ゲート判定 | **緑**（開発版の範囲） |

## スイート

| スイート | 結果 | passed | failed | skipped | 開始 | 終了 | コマンド |
|---|---|---|---|---|---|---|---|
| vitest | passed | 306 | 0 | 0 | 2026-10-19T10:56:42.222Z | 2026-10-19T10:57:30.354Z | `npx vitest --run --reporter=default --reporter=json --outputFile.json=test-results/acceptance/2026-10-19T10-56-41-664Z/vitest.json` |
| load | passed | 3 | 0 | 0 | 2026-10-19T10:57:30.354Z | 2026-10-19T10:58:01.461Z | `npx vitest --run --config vitest.load.config.ts --reporter=default --reporter=json --outputFile.json=test-results/acceptance/2026-10-19T10-56-41-664Z/load.json` |
| e2e | passed | 117 | 0 | 3 | 2026-10-19T11:12:15.072Z | 2026-10-19T11:26:53.533Z | `npx playwright test --project=setup --project=phone-360 --project=desktop-1280 --project=tablet-768 --reporter=list,json` |
| live | **未実施**（未実施: 実Cloudflare(staging)のSecret未設定（LIVE_BASE_URL, LIVE_BOOTSTRAP_TOKEN, LIVE_BOOTSTRAP_EMAIL）。合格に数えない（コントローラ裁定R4）） | 0 | 0 | 0 | 2026-10-19T11:26:53.533Z | 2026-10-19T11:26:53.533Z | `npm run test:live` |

差し替えた過去の実行（同じコードでスイート全体を再実行した。フレーキーの記録として残す）:

- e2e 2026-10-19T10:58:01.461Z: failed（passed 116 / failed 1 / skipped 3）

skipされた試験 3件（いずれも証拠に使わない。manifest.knownSkips の分類）:

- tests/e2e/assistant.spec.ts › assistant_input_controls_meet_touch_target_on_mobile（desktop-1280）: 押下領域44pxの規則はモバイル。PCはprototypeのコンパクト寸法が正。証拠は phone-360 の合格
- tests/e2e/member-admin.spec.ts › ai_evaluation_buttons_meet_touch_target_on_mobile（desktop-1280）: 押下領域44pxの規則はモバイル。PCはprototypeのコンパクト寸法が正。証拠は phone-360 の合格
- tests/e2e/shell.spec.ts › mobile_menu_tab_shows_profile_and_tiles（desktop-1280）: メニュータブはスマホ幅のみの画面（test.skip(!isPhone)）。証拠は phone-360 の合格

## 件数（正本から機械抽出）

要件54 / AT54 / CT17（AT×CTの組220、うち notApplicable 1） / 継続TC18 / API102 / SCR28 / 横断journey4 / 実外部の残手順29。参照している実テスト 255件。

## 受入（AT）

| AT | 要件 | 開発版の判定 | シナリオの実テスト | CT（組数／notApplicable） | 未実施（実外部・実端末・人） |
|---|---|---|---|---|---|
| AT-AUTH-01 | AUTH-01 | 合格（局所） | 5 | 4 | X-V01（実Cloudflare（staging）での認証・CPU時間・Secure Cookie の実測（test:live auth-workers）・T086） |
| AT-AUTH-02 | AUTH-02 | 合格（局所） | 4 | 4 | - |
| AT-AUTH-03 | AUTH-03 | 合格（局所） | 5 | 3 | - |
| AT-AUTH-04 | AUTH-04 | 合格（局所） | 4 | 4 | - |
| AT-AUTH-05 | AUTH-05 | 合格（局所） | 4 | 4 | X-V01（実Cloudflare（staging）での認証・CPU時間・Secure Cookie の実測（test:live auth-workers）・T086）<br>X-DEV-2（VoiceOver／TalkBack／NVDA の実スクリーンリーダー確認・T086）<br>X-OUT-4（実在の正副担当の交代（ops/admin-handover.md §3）・T088） |
| AT-ACT-01 | ACT-01 | 合格（局所） | 2 | 4 | - |
| AT-ACT-02 | ACT-02 | 合格（局所） | 3 | 5 | - |
| AT-ACT-03 | ACT-03 | 合格（局所） | 2 | 5 | - |
| AT-ACT-04 | ACT-04 | 合格（局所） | 2 | 3 | - |
| AT-ACT-05 | ACT-05 | 合格（局所） | 3 | 5 | X-V06-DELIVERY（実チャネル（Web Push/email。D13）での到達・不明・再送・T088） |
| AT-ACT-06 | ACT-06 | 合格（局所） | 5 | 4 | X-V07-RENDER（PDF/CSVの実ビューア・実Excelでの表示確認（test:live report-render）・T086） |
| AT-MAP-01 | MAP-01 | 合格（局所） | 3 | 3 | X-V05（実Google Maps JavaScript APIの接続・キー制限・帰属表示の実地確認（地図面は現在プレースホルダー）・T086） |
| AT-MAP-02 | MAP-02 | 合格（局所） | 2 | 2 | X-V05（実Google Maps JavaScript APIの接続・キー制限・帰属表示の実地確認（地図面は現在プレースホルダー）・T086） |
| AT-MAP-03 | MAP-03 | 合格（局所） | 2 | 5 | - |
| AT-MAP-04 | MAP-04 | 合格（局所） | 3 | 4 | X-V07-PERF（実staging・実D1 rows_read・実回線での通常API p95（D18承認材料）・T086） |
| AT-MAP-05 | MAP-05 | 合格（局所） | 3 | 4 | - |
| AT-MAP-06 | MAP-06 | 合格（局所） | 5 | 5 | - |
| AT-MAP-07 | MAP-07 | 合格（局所） | 3 | 4 | - |
| AT-MAP-08 | MAP-08 | 合格（局所） | 3 | 6 | - |
| AT-MAP-09 | MAP-09 | 合格（局所） | 2 | 3 | X-DEV-MAPS（実端末でのMapsアプリ起動（外部経路）・T086） |
| AT-MAP-10 | MAP-10 | 合格（局所） | 3 | 5 | - |
| AT-AST-01 | AST-01 | 合格（局所） | 2 | 4 | - |
| AT-AST-02 | AST-02 | 合格（局所） | 3 | 5 | - |
| AT-AST-03 | AST-03 | 合格（局所） | 2 | 5 | - |
| AT-AST-04 | AST-04 | 合格（局所） | 3 | 4 | - |
| AT-AST-05 | AST-05 | 合格（局所） | 4 | 5 | - |
| AT-DSP-01 | DSP-01 | 合格（局所） | 2 | 4 | - |
| AT-DSP-02 | DSP-02 | 合格（局所） | 2 | 5 | X-OUT-10（代理の参集記録の担当を付ける画面（D08）・T088） |
| AT-DSP-03 | DSP-03 | 合格（局所） | 5 | 4 | - |
| AT-DSP-04 | DSP-04 | 合格（局所） | 3 | 4 | X-V06-RT（実30端末・実回線での更新反映遅延（test:live realtime-load）・T086） |
| AT-DSP-05 | DSP-05 | 合格（局所） | 3 | 6 | X-DEV-1（iOS Safari／Android Chrome／PCの実機での主要動線・PWA install・quota・実回線・T086） |
| AT-COM-01 | COM-01 | 合格（局所） | 3 | 4 | - |
| AT-COM-02 | COM-02 | 合格（局所） | 5 | 5 | X-V06-DELIVERY（実チャネル（Web Push/email。D13）での到達・不明・再送・T088）<br>X-OUT-3（実providerの到達不明（D13の了承後）・T088） |
| AT-DOC-01 | DOC-01 | 合格（局所） | 3 | 6 | X-V02（実R2での検査・EXIF除去・ready不変（test:live file-inspection）・T086）<br>X-V07-RESTORE（実D1/R2での復元演習（別担当による実行を含む）・T087/T088） |
| AT-DOC-02 | DOC-02 | 合格（局所） | 4 | 6 | X-V07-RENDER（PDF/CSVの実ビューア・実Excelでの表示確認（test:live report-render）・T086）<br>X-V04-LLM（実生成モデルの比較・固定・捏造検出精度（D12/D16）・T086/T088） |
| AT-DASH-01 | DASH-01 | 合格（局所） | 4 | 4／CT-05 | - |
| AT-DASH-02 | DASH-02 | 合格（局所） | 3 | 3 | - |
| AT-AI-01 | AI-01 | 合格（局所） | 4 | 4 | X-V04-JEV（実Workers AI（typesafe/jev）の実応答・モデル版固定・usage・日本語品質（D12）・T086/T088） |
| AT-AI-02 | AI-02 | 合格（局所） | 2 | 4 | X-V04-JEV（実Workers AI（typesafe/jev）の実応答・モデル版固定・usage・日本語品質（D12）・T086/T088） |
| AT-AI-03 | AI-03 | 合格（局所） | 2 | 4 | X-V04-LLM（実生成モデルの比較・固定・捏造検出精度（D12/D16）・T086/T088） |
| AT-AI-04 | AI-04 | 合格（局所） | 5 | 7 | - |
| AT-AI-05 | AI-05 | 合格（局所） | 3 | 2 | X-AIEVAL（実モデルでの固定holdout評価（記録済み出力ではなく実呼出し）・T086/T088） |
| AT-AI-06 | AI-06 | 合格（局所） | 6 | 5 | X-V04-RET（OCR・実PDF集合の抽出率・Vectorize実測比較・実AIでのRAG/横断の品質評価・T086/T088） |
| AT-AI-07 | AI-07 | 合格（局所） | 3 | 6 | X-V04-RET（OCR・実PDF集合の抽出率・Vectorize実測比較・実AIでのRAG/横断の品質評価・T086/T088） |
| AT-NFR-01 | NFR-01 | 合格（局所） | 6 | 3 | X-DEV-1（iOS Safari／Android Chrome／PCの実機での主要動線・PWA install・quota・実回線・T086）<br>X-DEV-2（VoiceOver／TalkBack／NVDA の実スクリーンリーダー確認・T086）<br>X-DEV-3（axe走査は4画面＋WCAG 2.1 A/AA に限定（全SCRの走査は未実施）・T086） |
| AT-NFR-02 | NFR-02 | 合格（局所） | 3 | 1 | X-DEV-4（代表利用者（5名程度）による説明なし再訪の計測（D18の承認材料）・T087/T088） |
| AT-NFR-03 | NFR-03 | 合格（局所） | 3 | 2 | X-V07-PERF（実staging・実D1 rows_read・実回線での通常API p95（D18承認材料）・T086） |
| AT-NFR-04 | NFR-04 | 合格（局所） | 3 | 4 | X-OUT-1（staging演習（6 scenarioを実Workers/D1/Queuesで）・T086）<br>X-OUT-2（実Googleキーの停止で一覧代替を確認・T086）<br>X-OUT-3（実providerの到達不明（D13の了承後）・T088）<br>X-OUT-4（実在の正副担当の交代（ops/admin-handover.md §3）・T088）<br>X-OUT-5（別担当（人）によるrunbookの再現・T088）<br>X-OUT-6（紙/既存電話への切替と復帰照合の実地演習・T088）<br>X-OUT-7（遮断・鍵rotationの演習（ops/security-response.md §7）・T086）<br>X-OUT-8（Queue送信失敗の実環境観測・T086）<br>X-OUT-9（管理者全員回復不能時のCloudflare側復旧手順の整備・T086）<br>X-V07-RESTORE（実D1/R2での復元演習（別担当による実行を含む）・T087/T088） |
| AT-NFR-05 | NFR-05 | 合格（局所） | 6 | 5 | - |
| AT-NFR-06 | NFR-06 | 合格（局所） | 2 | 2 | X-V07-RESTORE（実D1/R2での復元演習（別担当による実行を含む）・T087/T088） |
| AT-NFR-07 | NFR-07 | 合格（局所） | 3 | 4 | - |
| AT-NFR-08 | NFR-08 | 合格（局所） | 3 | 3 | X-COST（実使用量・実請求との照合、実環境の停止・復帰演習（D11）・T086/T088） |
| AT-NFR-09 | NFR-09 | 合格（局所） | 3 | 2 | X-DEV-1（iOS Safari／Android Chrome／PCの実機での主要動線・PWA install・quota・実回線・T086）<br>X-DEV-2（VoiceOver／TalkBack／NVDA の実スクリーンリーダー確認・T086）<br>X-DEV-3（axe走査は4画面＋WCAG 2.1 A/AA に限定（全SCRの走査は未実施）・T086） |
| AT-NFR-10 | NFR-10 | 合格（局所） | 4 | 2 | X-AIEVAL（実モデルでの固定holdout評価（記録済み出力ではなく実呼出し）・T086/T088）<br>X-V04-JEV（実Workers AI（typesafe/jev）の実応答・モデル版固定・usage・日本語品質（D12）・T086/T088）<br>X-V04-LLM（実生成モデルの比較・固定・捏造検出精度（D12/D16）・T086/T088）<br>X-V04-RET（OCR・実PDF集合の抽出率・Vectorize実測比較・実AIでのRAG/横断の品質評価・T086/T088） |

## 継続シナリオ（TC-01〜18）

| TC | 対応要件 | 開発版の判定 | 実テスト |
|---|---|---|---|
| TC-01 | AUTH-01 | 合格（局所） | tests/security/authorization-matrix.test.ts::T081 全APIの権限・入力・濫用matrix > every_business_route_rejects_cross_unit_and_stale_permissions<br>tests/authorization.test.ts::認可 (T008) > unlinked_identity_and_forged_test_header_never_get_business_access<br>tests/e2e/auth.spec.ts::unauthenticated_visit_goes_to_login_and_returns_after_login |
| TC-02 | AUTH-02 | 合格（局所） | tests/revocation.test.ts::権限変更・利用停止・失効 (T012) > role_replacement_bumps_authz_version_and_rejects_unsafe_changes<br>tests/members.test.ts::名簿 (T011) > who_may_change_what_is_enforced_by_the_server |
| TC-03 | ACT-01,ACT-02 | 合格（局所） | tests/attendance.test.ts::本人・許可代理の出欠 (T036) > old_attendance_retry_cannot_undo_later_answer<br>tests/e2e/activities.spec.ts::planned_answer_and_actual_presence_have_separate_labels |
| TC-04 | ACT-03 | 合格（局所） | tests/activity-results.test.ts::活動実績・実参加・訂正版 (T037) > actual_participants_do_not_follow_planned_attendance<br>tests/e2e/activities.spec.ts::planned_answer_and_actual_presence_have_separate_labels |
| TC-05 | MAP-01,MAP-02 | 合格（局所） | tests/e2e/map.spec.ts::map_selection_sheet_matches_prototype_and_opens_detail<br>tests/e2e/accessibility.spec.ts::returning_user_finishes_inspection_and_attendance_without_hidden_controls |
| TC-06 | MAP-03 | 合格（局所） | tests/facilities.test.ts::施設の台帳と位置確認 (T019) > coordinate_edit_invalidates_only_location_confirmation<br>tests/e2e/facility-location.spec.ts::gps_denial_allows_manual_entry_without_tracking |
| TC-07 | MAP-03 | 合格（局所） | tests/facilities.test.ts::施設の台帳と位置確認 (T019) > coordinate_edit_invalidates_only_location_confirmation<br>tests/gis-query.test.ts::施設の全件取得 (T020) > invalid_list_conditions_are_rejected_without_partial_results (T085) |
| TC-08 | MAP-04 | 合格（局所） | tests/gis-query.test.ts::施設の全件取得 (T020) > filters_by_latest_inspection_result_and_open_issues<br>tests/e2e/map.spec.ts::old_map_response_cannot_replace_new_viewport |
| TC-09 | MAP-05,MAP-06 | 合格（局所） | tests/inspections-issues.test.ts::点検と異常 (T029〜T032) > inspection_links_ready_attachments_and_rejects_uninspected_ones<br>tests/inspections-issues.test.ts::点検と異常 (T029〜T032) > facility_inspection_history_pages_every_version_once_and_keeps_the_original (T085)<br>tests/e2e/inspection.spec.ts::inspection_form_preserves_values_after_failed_submission |
| TC-10 | MAP-07 | 合格（局所） | tests/e2e/issues.spec.ts::issue_state_does_not_appear_as_location_verified<br>tests/facilities.test.ts::施設の台帳と位置確認 (T019) > coordinate_edit_invalidates_only_location_confirmation |
| TC-11 | AST-01,AST-02 | 合格（局所） | tests/assets.test.ts::車両・資機材の台帳 (T025) > asset_has_one_storage_location_and_nonnegative_quantity<br>tests/inspections-issues.test.ts::点検と異常 (T029〜T032) > asset_inspection_accepts_exactly_one_matching_target<br>tests/e2e/asset-inspection.spec.ts::asset_inspection_records_photo_and_corrects_from_history_without_overwriting |
| TC-12 | DSP-01,DSP-02 | 合格（局所） | tests/incidents.test.ts::模擬・訓練・実出動記録と状態API (T040) > incident_kind_is_separate_from_status_and_never_dispatches<br>tests/incident-participants.test.ts::参集・到着・帰還の本人/代理記録 (T041) > returned_status_preserves_unknown_arrival_time<br>tests/e2e/incidents.spec.ts::incident_detail_traces_activity_vehicle_and_equipment |
| TC-13 | DOC-01 | 合格（局所） | tests/attachments.test.ts::添付のリンク・取得・削除 (T017) > unlink_and_permission_revocation_block_new_downloads<br>tests/upload.test.ts::添付の予約とアップロード (T015) > ready_object_cannot_be_overwritten_by_late_upload |
| TC-14 | NFR-07 | 合格（局所） | tests/audit.test.ts::監査 (T014) > audit_is_append_only_and_scope_filtered<br>tests/e2e/audit.spec.ts::audit_panel_shows_who_changed_what_without_bodies |
| TC-15 | NFR-05 | 合格（局所） | tests/mutation.test.ts::executeMutation (T004) > same_key_concurrent_requests_apply_the_effect_once<br>tests/client-shell.test.tsx::client shell (T005) > double_tap_while_saving_sends_one_request<br>tests/e2e/asset-inspection.spec.ts::inspection_retry_after_lost_response_registers_once_and_correction_keeps_the_original |
| TC-16 | NFR-05 | 合格（局所） | tests/facilities.test.ts::施設の台帳と位置確認 (T019) > same_key_resend_has_one_effect_and_two_devices_never_silently_overwrite (T085)<br>tests/e2e/member-admin.spec.ts::unsaved_input_is_confirmed_before_closing_and_conflicts_and_revocations_are_shown |
| TC-17 | NFR-04 | 合格（局所） | tests/e2e/dependency-outages.spec.ts::outage_never_claims_dispatch_or_saved_success<br>tests/e2e/accessibility.spec.ts::returning_user_finishes_inspection_and_attendance_without_hidden_controls |
| TC-18 | RG-09 | 合格（局所） | tests/deploy-config.test.ts::deploy-config (T078) > demo_binding_or_incompatible_schema_blocks_deploy<br>tests/schema.test.ts::core schema (T003) > fixture_has_two_units_four_roles_suspended_and_scopes_with_fictional_names |

## 横断journey

| id | 動線 | 判定 | 試験 |
|---|---|---|---|
| J1 | 点検→異常→AI→task→通知 | 合格（局所） | tests/e2e/journeys.spec.ts::journey_inspection_anomaly_ai_task_notification |
| J2 | 活動/出動→使用→集計→帳票 | 合格（局所） | tests/e2e/journeys.spec.ts::journey_activity_incident_usage_analytics_report |
| J3 | 文書→引用→失効 | 合格（局所） | tests/e2e/journeys.spec.ts::journey_document_citation_withdrawal |
| J4 | offline→競合→復旧（点検の訂正） | 合格（局所） | tests/e2e/journeys.spec.ts::journey_offline_correction_conflict_recovery |

## notApplicable（docs/08 §2: 読取専用・純表示に不要なmutation試験を実施したことにしない）

- AT-DASH-01×CT-05: docs/08 §2「read-onlyや純粋な表示要件に不要なmutation試験を実施したことにしない」: ホーム（API-28）はGETだけの集計表示で、途中失敗させる書込が無い。数値の源（予定・出欠・異常・点検期限・タスク・通知）の原子性は各要件のCT-05（AT-ACT-01/02・AT-MAP-06・AT-AST-03/04・AT-AI-04）で検証する

## 実外部・実端末・人の残手順（未実施。合格に数えない）

| id | 根拠 | 内容 | 担当 |
|---|---|---|---|
| X-V01 | docs/evidence/V01-auth.md「未実施」1〜8 | 実Cloudflare（staging）での認証・CPU時間・Secure Cookie の実測（test:live auth-workers） | T086 |
| X-V02 | docs/evidence/V02-files.md「未実施」1〜6 | 実R2での検査・EXIF除去・ready不変（test:live file-inspection） | T086 |
| X-V04-JEV | docs/evidence/V04-jev.md「未実施」 | 実Workers AI（typesafe/jev）の実応答・モデル版固定・usage・日本語品質（D12） | T086/T088 |
| X-V04-LLM | docs/evidence/V04-llm.md「未実施」 | 実生成モデルの比較・固定・捏造検出精度（D12/D16） | T086/T088 |
| X-V04-RET | docs/evidence/V04-retrieval.md「未実施」「T066 限界・残手順」 | OCR・実PDF集合の抽出率・Vectorize実測比較・実AIでのRAG/横断の品質評価 | T086/T088 |
| X-AIEVAL | docs/evidence/ai-evaluation.md・docs/16 T061状態欄 | 実モデルでの固定holdout評価（記録済み出力ではなく実呼出し） | T086/T088 |
| X-V05 | docs/16 T021状態欄・docs/14 D22（V05） | 実Google Maps JavaScript APIの接続・キー制限・帰属表示の実地確認（地図面は現在プレースホルダー） | T086 |
| X-DEV-MAPS | ops/device-test-matrix.md §2.1/§2.2 | 実端末でのMapsアプリ起動（外部経路） | T086 |
| X-V06-DELIVERY | docs/evidence/V06-delivery.md「未実施」 | 実チャネル（Web Push/email。D13）での到達・不明・再送 | T088 |
| X-V06-RT | docs/evidence/V06-realtime.md「未実施」1〜4 | 実30端末・実回線での更新反映遅延（test:live realtime-load） | T086 |
| X-V07-PERF | docs/evidence/V07-performance.md「未実施」1〜4 | 実staging・実D1 rows_read・実回線での通常API p95（D18承認材料） | T086 |
| X-V07-RESTORE | docs/evidence/V07-restore.md「未実施」1〜4 | 実D1/R2での復元演習（別担当による実行を含む） | T087/T088 |
| X-V07-RENDER | docs/evidence/V07-report-render.md「未実施」1〜8 | PDF/CSVの実ビューア・実Excelでの表示確認（test:live report-render） | T086 |
| X-COST | docs/evidence/cost-estimate.md「正直な限界」・ops/cost-alerts.md §4/§5 | 実使用量・実請求との照合、実環境の停止・復帰演習（D11） | T086/T088 |
| X-DEV-1 | ops/device-test-matrix.md §2.1〜2.3 | iOS Safari／Android Chrome／PCの実機での主要動線・PWA install・quota・実回線 | T086 |
| X-DEV-2 | ops/device-test-matrix.md §2.1〜2.3 | VoiceOver／TalkBack／NVDA の実スクリーンリーダー確認 | T086 |
| X-DEV-3 | docs/evidence/ph8.md「未実施・未接続」 | axe走査は4画面＋WCAG 2.1 A/AA に限定（全SCRの走査は未実施） | T086 |
| X-DEV-4 | ops/device-test-matrix.md §2.4 | 代表利用者（5名程度）による説明なし再訪の計測（D18の承認材料） | T087/T088 |
| X-DEMO | docs/16 T086 | 公開デモ（分離した実環境）の構築と本番データとの完全分離の実地確認（RG-09） | T086 |
| X-OUT-1 | docs/evidence/V07-outage.md「未実施」1 | staging演習（6 scenarioを実Workers/D1/Queuesで） | T086 |
| X-OUT-2 | docs/evidence/V07-outage.md「未実施」2 | 実Googleキーの停止で一覧代替を確認 | T086 |
| X-OUT-3 | docs/evidence/V07-outage.md「未実施」3 | 実providerの到達不明（D13の了承後） | T088 |
| X-OUT-4 | docs/evidence/V07-outage.md「未実施」4 | 実在の正副担当の交代（ops/admin-handover.md §3） | T088 |
| X-OUT-5 | docs/evidence/V07-outage.md「未実施」5 | 別担当（人）によるrunbookの再現 | T088 |
| X-OUT-6 | docs/evidence/V07-outage.md「未実施」6 | 紙/既存電話への切替と復帰照合の実地演習 | T088 |
| X-OUT-7 | docs/evidence/V07-outage.md「未実施」7 | 遮断・鍵rotationの演習（ops/security-response.md §7） | T086 |
| X-OUT-8 | docs/evidence/V07-outage.md「未実施」8 | Queue送信失敗の実環境観測 | T086 |
| X-OUT-9 | docs/evidence/V07-outage.md「未実施」9 | 管理者全員回復不能時のCloudflare側復旧手順の整備 | T086 |
| X-OUT-10 | docs/evidence/V07-outage.md「未実施」10 | 代理の参集記録の担当を付ける画面（D08） | T088 |

## 課題台帳（criticalOrHighUnresolvedIssues の出典。コントローラ裁定R7）

| id | 重大度 | 状態 | 内容 | 出典 | 重大度の根拠 | 担当 |
|---|---|---|---|---|---|---|
| T085-D1 | high | resolved | 施設の点検履歴（API-44）の続き取得が新しい順なのに cursor条件が > で、2頁目以降が欠落していた | T085のAPI-44網羅試験（tests/inspections-issues.test.ts T085） | 履歴の欠落（AT-MAP-05/06「過去版を開く」）。limit=1の全cursor完走で4件中1件しか返らない赤を確認→ < へ修正し緑 | T029 |
| T085-D2 | high | resolved | 点検保存の応答が失われた後、画面の案内どおり送り直すと二重登録になっていた（実施日時を送信ごとに作り直し、送信鍵が変わる） | T085のe2e（tests/e2e/asset-inspection.spec.ts） | NFR-05/TC-15の二重登録。修正前の実行で同一点検2件（inspectedAt差130ms）の赤を確認→最初の送信で固定して緑 | T033 |
| T085-D3 | medium | resolved | SCR-23（資産点検）と点検訂正の画面が未実装、施設詳細の点検結果が現在版でなく最新日時の行 | docs/16 T033状態欄・ph2-review 第3回「点検結果表示が現在版でない」 | T033の残作業（画面の欠落）。T085でSCR-23・訂正モード・API-51点検履歴・API-44 isCurrentを接続しe2eで確認 | T033/T030 |
| FLAKE-1 | medium | open | fill値の消失で文書作成のPOSTが送られず30秒で落ちる（稀。引き金未特定） | docs/evidence/ph8.md「既知フレーキー」documents.spec desktop「題名消失」 | 試験の不安定さ。製品の再レンダリング競合の可能性は残る（データ破壊なし・単独実行は緑）。ph8.md T084最終検証で3回中1回 | T085b |
| FLAKE-2 | low | open | reports.spec desktop／facility-location.spec desktop／notifications.spec phone の1回off | docs/evidence/ph8.md「既知フレーキー」継続観察 | フル走行15回で各1回。単独実行は常に緑 | T085b |
| FLAKE-3 | low | resolved | 完了確定済みの添付を背景のQueue consumerがreadyへ進め、「未検査は422」の断言が201で落ちた（試験側の競合） | T085の全スイート実行（tests/inspections-issues.test.ts manual_issue_links_ready_attachments_and_rejects_uninspected_ones） | collect-evidence 1回目でvitest 1件failed。完了確定前の添付（makeNotYetCompleted）へ変更し同型の2箇所も修正 | T029/T032（試験） |
| T085-D4 | medium | resolved | 予定・出動の検索カードが単一のauto列のgridで、参加者selectの最長の団員名より狭くなれず200px幅で横スクロールが出た（データ量で再現） | T085の全スイート実行（accessibility.spec desktop inputs_stay_inside_the_search_card_at_narrow_widths） | フル走行の共有D1で団員が増えると発火（scrollWidth 269/202）。grid-cols-1＋min-w-0で同じデータで200に収まることを実測 | T039/T044（T083の狭幅修正の系） |
| T085-D5 | medium | resolved | AIアシスタントの「記録を添える」チップが確認待ちの異常を古い順に5件だけ出し、新しい異常を添えられなかった | T085の全スイート実行（assistant.spec desktop） | 確認待ちが5件を超えると再現（実行時14件）。全件を読み新しい順に5件へ修正し、同じデータでチップが出ることを確認 | T070 |
| PH1-A1 | medium | open | 管理者がAPI-03で他人の許可列に初期値を書ける／担当付与で連絡先を読む迂回 | docs/evidence/ph1-review.md A（中・方針で残す） | ph1-review表の重大度「中」。設計（docs/10）。D03承認待ち・担当付与は監査とMFAで抑止 | T088（D03） |
| PH1-A2 | medium | open | 認証イベントが監査に残らない／アカウント単位の回数制限が無い | docs/evidence/ph1-review.md A（低〜中・方針で残す） | ph1-review表の重大度「低〜中」。D18計測前の案 | T086 |
| PH1-B1 | medium | open | 実装先行タスクの赤の証跡・変異の再現手順が無い | docs/evidence/ph1-review.md B（中〜低・方針で残す） | ph1-review表の重大度「中〜低」。scripts/mutate*.shを追加済みで記録のまま | - |
| PH0-BF07 | medium | open | 試験名「効果が二重にならない」とhandler副作用の不一致（確定の一回性のみ保証） | docs/evidence/ph0-review.md B-F07（中・方針で残す） | ph0-review表の重大度「中」。外部効果はhandlerの責務と明記 | - |
| PH2-B12 | medium | open | PH2のコミット境界が1タスク1コミットに従わない | docs/evidence/ph2-review.md B12（中・方針で残す） | ph2-review表の重大度「中」。履歴の書換えはしない（docs/16 §1に記録） | - |
| PH2-C15 | medium | open | 地図の種別チップのトグルで全件再取得し一覧が点滅する | docs/evidence/ph2-review.md C15（中・方針で残す） | ph2-review表の重大度「中」。件数を最新にする意図（docs/03 SCR-03） | T086 |
| PH4-B2 | medium | open | 承認待ち通知draftが送信者の一覧に現れない（送信者一覧APIが契約に無い） | docs/evidence/ph4-review.md B2（中・方針で残す） | ph4-review表の重大度「中」。未送信・対象者非表示に害が限定 | 未割当（画面改善） |
| PH4-B3 | medium | open | 点検源のAI候補は原文表示・版比較・再生成がUIから不可（点検の単一件GET契約が無い） | docs/evidence/ph4-review.md B3（中・方針で残す） | ph4-review表の重大度「中」。stale検知と承認409は機能中。T085で点検履歴（API-44 isCurrent・API-51）は接続したが単一件GETは未提供 | T033/T055 |
| PH0-AF7 | low | open | タイムアウト後もhandlerが動き外部効果が二重になり得る | docs/evidence/ph0-review.md A-F7 | ph0-review表「低・方針で残す」 | - |
| PH0-L | low | open | allowedStates二重管理ほか軽微5件 | docs/evidence/ph0-review.md L-2/L-3/L-5/L-7/L-8 | ph0-review表「方針で残す」（低） | - |
| PH1-A3 | low | open | 冪等再送が認可版の増分後は403／停止済み再停止が409 | docs/evidence/ph1-review.md A | ph1-review表「低・方針で残す」 | - |
| PH1-C | low | open | フォーカス循環の細部・寸法の微差 | docs/evidence/ph1-review.md C | ph1-review表「低・方針で残す」 | T086 |
| PH2-A12 | low | open | API-27が状態で422/404を区別／import解析中の固定・staging孤児 | docs/evidence/ph2-review.md A12 | ph2-review表「低・方針で残す」 | T087 |
| PH2-C19 | low | open | 選択シートのEsc・フォーカス、語彙の微差 | docs/evidence/ph2-review.md C19〜C21 | ph2-review表「低・方針で残す」 | T086 |
| PH2-R1 | low | open | 系列一意409のAPI試験なし・分類変更イベントなし・表示の軽微差（CSV成功表示等） | docs/evidence/ph2-review.md 第2回①② | ph2-review表「低・方針で残す」 | - |
| PH2-R3 | low | open | job自動リンクの監査・再リンク防止の明示試験なし | docs/evidence/ph2-review.md 第3回 | ph2-review表「低・方針で残す」 | - |
| PH3-A4 | low | open | API-22×使用履歴同時指定の版増分二重積み・狭い条件で再送404 | docs/evidence/ph3-review.md A4/新規1 | ph3-review表「低・方針で残す」 | - |
| PH3-A5 | low | open | 出欠の対象外が404/403に揺れる | docs/evidence/ph3-review.md A5 | ph3-review表「低・方針で残す」 | - |
| PH3-C8 | low | open | 小見出し形式・複数LeaveConfirm・canManage出し分け・ID開示 | docs/evidence/ph3-review.md C8・N2・N4・参考 | ph3-review表「低・方針で残す」 | T086 |
| PH3-T | low | open | activities.specの死に変数・先取り断言・wrangler d1 executeのseed | docs/evidence/ph3-review.md 第3回 | ph3-review表「低・方針で残す」 | T085b |
| PH4-L | low | open | 再開理由のtrim無しほか低（A低/B低/C低の一部） | docs/evidence/ph4-review.md「方針で残す」 | ph4-review「方針で残す」（低） | - |
| PH5-L | low | open | superseded旧版FTS行・空索引succeeded・無効jobId・文内リンク44px・重複取得ほか | docs/evidence/ph5-review.md「方針で残す」1〜7 | ph5-review「方針で残す」（低） | - |
| PH6-L | low | open | 部分filter cursor・同unit cursor再利用・resync札の点色 | docs/evidence/ph6-review.md A低1/要確認1/要確認2 | ph6-review表「低/要確認・方針で残す」 | - |
| PH7-L | low | open | ai.calls計上位置・Retry-After固定・理由コード不統一・ラベル語彙ほか | docs/evidence/ph7-review.md「方針で残す」1〜9 | ph7-review「方針で残す」（低） | T086 |
| PH8-L | low | open | sync_recoverの手動再送の非決定性・FORBIDDEN語彙・注記の文体差・Google Fonts停止時のアイコン表示ほか | docs/evidence/ph8-review.md「方針で残す」（T083・T084） | ph8-review「方針で残す」（低・軽微） | - |
| T085-O1 | low | open | API-51の異常の子Pageは未接続（APIはT032で完了） | T085で観察 | docs/05 API-51行に残作業として記録 | 未割当 |
