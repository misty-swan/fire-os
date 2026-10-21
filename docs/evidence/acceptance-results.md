# 受入試験の結果（T085。開発版＝架空データ・ローカル）

> **生成物**: `npm run collect:evidence` が証跡index（docs/evidence/acceptance-index.json）と受入manifest（tests/acceptance/manifest.json）から作る。手で編集しない（`npx tsx scripts/collect-evidence.ts --report-only` で作り直す）。
>
> **この表の「合格（局所）」は、架空データ・ローカル（workerd＋ローカルD1・Playwright chromium・fake AI）で参照先の実テストが今のコードで全部合格したという意味**で、docs/13 RG-03（正式リリースの受入合格）ではない。実外部・実端末・人の手順は「未実施」の列に残し、合格に数えない（コントローラ裁定R3）。test:live は Secret 未設定のため未実施（R4）。

## 実行環境と版

| 項目 | 値 |
|---|---|
| 収集日時 | 2026-10-21T08:36:54.225Z |
| commit | 7badd9594179d7847e7650738924d607c8ac4d8a |
| codeHash | e8a0bbcdffa106e1d77b0d80cd5da472d4474b9a4d2fb41926500a6164de817f |
| 設計版 | 08:v0.3 / 2026-10-13 12:v0.3 / 2026-10-15 |
| 実行環境 | node v26.8.2 / linux-x64 / Playwright 1.64.0 / vitest/4.1.11 linux-x64 node-v26.8.2 / wrangler 4.150.0 |
| ゲート判定 | **緑**（開発版の範囲） |

## スイート

| スイート | 結果 | passed | failed | skipped | 開始 | 終了 | コマンド |
|---|---|---|---|---|---|---|---|
| vitest | passed | 337 | 0 | 0 | 2026-10-21T08:29:58.351Z | 2026-10-21T08:30:47.735Z | `npx vitest --run --reporter=default --reporter=json --outputFile.json=test-results/acceptance/2026-10-21T08-29-57-875Z/vitest.json` |
| load | passed | 3 | 0 | 0 | 2026-10-21T08:30:47.735Z | 2026-10-21T08:31:20.482Z | `npx vitest --run --config vitest.load.config.ts --reporter=default --reporter=json --outputFile.json=test-results/acceptance/2026-10-21T08-29-57-875Z/load.json` |
| e2e | passed | 75 | 0 | 0 | 2026-10-21T08:31:20.482Z | 2026-10-21T08:36:54.204Z | `npx playwright test --project=setup --project=phone-360 --project=desktop-1280 --project=tablet-768 --reporter=list,json` |
| live | **未実施**（未実施: 実Cloudflare(staging)のSecret未設定（LIVE_BASE_URL, LIVE_BOOTSTRAP_TOKEN, LIVE_BOOTSTRAP_EMAIL）。合格に数えない（コントローラ裁定R4）） | 0 | 0 | 0 | 2026-10-21T08:36:54.204Z | 2026-10-21T08:36:54.204Z | `npm run test:live` |

## 件数（正本から機械抽出）

要件54 / AT54 / CT17（AT×CTの組220、うち notApplicable 0） / 継続TC18 / API102 / SCR28 / 横断journey4 / 実外部の残手順29。参照している実テスト 272件。

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
| AT-MAP-02 | MAP-02 | 合格（局所） | 3 | 2 | X-V05（実Google Maps JavaScript APIの接続・キー制限・帰属表示の実地確認（地図面は現在プレースホルダー）・T086） |
| AT-MAP-03 | MAP-03 | 合格（局所） | 2 | 5 | - |
| AT-MAP-04 | MAP-04 | 合格（局所） | 3 | 4 | X-V07-PERF（実staging・実D1 rows_read・実回線での通常API p95（D18承認材料）・T086） |
| AT-MAP-05 | MAP-05 | 合格（局所） | 3 | 4 | - |
| AT-MAP-06 | MAP-06 | 合格（局所） | 8 | 5 | - |
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
| AT-DOC-01 | DOC-01 | 合格（局所） | 3 | 6 | X-V02（実R2での検査・EXIF除去・ready不変（test:live file-inspection）・T086）<br>X-V07-RESTORE（実D1/R2での復元演習（別担当による実行を含む）。T087の提案資料での棚卸しは実施済み（未実施の残手順として明記・実行には実環境/人が必要）・T088） |
| AT-DOC-02 | DOC-02 | 合格（局所） | 4 | 6 | X-V07-RENDER（PDF/CSVの実ビューア・実Excelでの表示確認（test:live report-render）・T086）<br>X-V04-LLM（実生成モデルの比較・固定・捏造検出精度（D12/D16）。T087分（提案資料での未実施明記）は完了。実行は未実施・T088（実環境）・T088） |
| AT-DASH-01 | DASH-01 | 合格（局所） | 4 | 4 | - |
| AT-DASH-02 | DASH-02 | 合格（局所） | 3 | 3 | - |
| AT-AI-01 | AI-01 | 合格（局所） | 4 | 4 | X-V04-JEV（実Workers AI（typesafe/jev）の実応答・モデル版固定・usage・日本語品質（D12）。T087分（提案資料での未実施明記）は完了。実行は未実施・T088（実環境）・T088） |
| AT-AI-02 | AI-02 | 合格（局所） | 2 | 4 | X-V04-JEV（実Workers AI（typesafe/jev）の実応答・モデル版固定・usage・日本語品質（D12）。T087分（提案資料での未実施明記）は完了。実行は未実施・T088（実環境）・T088） |
| AT-AI-03 | AI-03 | 合格（局所） | 2 | 4 | X-V04-LLM（実生成モデルの比較・固定・捏造検出精度（D12/D16）。T087分（提案資料での未実施明記）は完了。実行は未実施・T088（実環境）・T088） |
| AT-AI-04 | AI-04 | 合格（局所） | 5 | 7 | - |
| AT-AI-05 | AI-05 | 合格（局所） | 3 | 2 | X-AIEVAL（実モデルでの固定holdout評価（記録済み出力ではなく実呼出し）。T087分（提案資料での未実施明記）は完了。実行は未実施・T088（実環境）・T088） |
| AT-AI-06 | AI-06 | 合格（局所） | 6 | 5 | X-V04-RET（OCR・実PDF集合の抽出率・Vectorize実測比較・実AIでのRAG/横断の品質評価。T087分（提案資料での未実施明記）は完了。実行は未実施・T088（実環境）・T088） |
| AT-AI-07 | AI-07 | 合格（局所） | 4 | 6 | X-V04-RET（OCR・実PDF集合の抽出率・Vectorize実測比較・実AIでのRAG/横断の品質評価。T087分（提案資料での未実施明記）は完了。実行は未実施・T088（実環境）・T088） |
| AT-NFR-01 | NFR-01 | 合格（局所） | 6 | 3 | X-DEV-1（iOS Safari／Android Chrome／PCの実機での主要動線・PWA install・quota・実回線・T086）<br>X-DEV-2（VoiceOver／TalkBack／NVDA の実スクリーンリーダー確認・T086）<br>X-DEV-3（axe走査は4画面＋WCAG 2.1 A/AA に限定（全SCRの走査は未実施）・T086） |
| AT-NFR-02 | NFR-02 | 合格（局所） | 3 | 1 | X-DEV-4（代表利用者（5名程度）による説明なし再訪の計測（D18の承認材料）。T087の提案資料での棚卸しは実施済み（未実施の残手順として明記・実行には実環境/人が必要）・T088） |
| AT-NFR-03 | NFR-03 | 合格（局所） | 3 | 2 | X-V07-PERF（実staging・実D1 rows_read・実回線での通常API p95（D18承認材料）・T086） |
| AT-NFR-04 | NFR-04 | 合格（局所） | 3 | 4 | X-OUT-1（staging演習（6 scenarioを実Workers/D1/Queuesで）・T086）<br>X-OUT-2（実Googleキーの停止で一覧代替を確認・T086）<br>X-OUT-3（実providerの到達不明（D13の了承後）・T088）<br>X-OUT-4（実在の正副担当の交代（ops/admin-handover.md §3）・T088）<br>X-OUT-5（別担当（人）によるrunbookの再現・T088）<br>X-OUT-6（紙/既存電話への切替と復帰照合の実地演習・T088）<br>X-OUT-7（遮断・鍵rotationの演習（ops/security-response.md §7）・T086）<br>X-OUT-8（Queue送信失敗の実環境観測・T086）<br>X-OUT-9（管理者全員回復不能時のCloudflare側復旧手順の整備はT086で実施（ops/account-recovery.md §5）。stagingでの演習が残る（X-OUT-1と併せて実施）・T086）<br>X-V07-RESTORE（実D1/R2での復元演習（別担当による実行を含む）。T087の提案資料での棚卸しは実施済み（未実施の残手順として明記・実行には実環境/人が必要）・T088） |
| AT-NFR-05 | NFR-05 | 合格（局所） | 6 | 5 | - |
| AT-NFR-06 | NFR-06 | 合格（局所） | 2 | 2 | X-V07-RESTORE（実D1/R2での復元演習（別担当による実行を含む）。T087の提案資料での棚卸しは実施済み（未実施の残手順として明記・実行には実環境/人が必要）・T088） |
| AT-NFR-07 | NFR-07 | 合格（局所） | 3 | 4 | - |
| AT-NFR-08 | NFR-08 | 合格（局所） | 3 | 3 | X-COST（実使用量・実請求との照合、実環境の停止・復帰演習（D11）。T086分（デモへの費用上限適用とMaps割当手順の整備）は実施済み。実使用量・実請求との照合は未実施・T088・T088） |
| AT-NFR-09 | NFR-09 | 合格（局所） | 3 | 2 | X-DEV-1（iOS Safari／Android Chrome／PCの実機での主要動線・PWA install・quota・実回線・T086）<br>X-DEV-2（VoiceOver／TalkBack／NVDA の実スクリーンリーダー確認・T086）<br>X-DEV-3（axe走査は4画面＋WCAG 2.1 A/AA に限定（全SCRの走査は未実施）・T086） |
| AT-NFR-10 | NFR-10 | 合格（局所） | 4 | 2 | X-AIEVAL（実モデルでの固定holdout評価（記録済み出力ではなく実呼出し）。T087分（提案資料での未実施明記）は完了。実行は未実施・T088（実環境）・T088）<br>X-V04-JEV（実Workers AI（typesafe/jev）の実応答・モデル版固定・usage・日本語品質（D12）。T087分（提案資料での未実施明記）は完了。実行は未実施・T088（実環境）・T088）<br>X-V04-LLM（実生成モデルの比較・固定・捏造検出精度（D12/D16）。T087分（提案資料での未実施明記）は完了。実行は未実施・T088（実環境）・T088）<br>X-V04-RET（OCR・実PDF集合の抽出率・Vectorize実測比較・実AIでのRAG/横断の品質評価。T087分（提案資料での未実施明記）は完了。実行は未実施・T088（実環境）・T088） |

## 継続シナリオ（TC-01〜18）

| TC | 対応要件 | 開発版の判定 | 実テスト | 未実施（実外部・実端末・人） |
|---|---|---|---|---|
| TC-01 | AUTH-01 | 合格（局所） | tests/security/authorization-matrix.test.ts::T081 全APIの権限・入力・濫用matrix > every_business_route_rejects_cross_unit_and_stale_permissions<br>tests/authorization.test.ts::認可 (T008) > unlinked_identity_and_forged_test_header_never_get_business_access<br>tests/e2e/auth.spec.ts::unauthenticated_visit_goes_to_login_and_returns_after_login@desktop-1280 | - |
| TC-02 | AUTH-02 | 合格（局所） | tests/revocation.test.ts::権限変更・利用停止・失効 (T012) > role_replacement_bumps_authz_version_and_rejects_unsafe_changes<br>tests/members.test.ts::名簿 (T011) > who_may_change_what_is_enforced_by_the_server | - |
| TC-03 | ACT-01,ACT-02 | 合格（局所） | tests/attendance.test.ts::本人・許可代理の出欠 (T036) > old_attendance_retry_cannot_undo_later_answer<br>tests/e2e/activities.spec.ts::planned_answer_and_actual_presence_have_separate_labels@desktop-1280 | - |
| TC-04 | ACT-03 | 合格（局所） | tests/activity-results.test.ts::活動実績・実参加・訂正版 (T037) > actual_participants_do_not_follow_planned_attendance<br>tests/e2e/activities.spec.ts::planned_answer_and_actual_presence_have_separate_labels@desktop-1280 | - |
| TC-05 | MAP-01,MAP-02 | 合格（局所） | tests/e2e/map.spec.ts::three_facility_types_are_identified_by_text_not_color_only<br>tests/e2e/map.spec.ts::map_selection_sheet_matches_prototype_and_opens_detail<br>tests/e2e/accessibility.spec.ts::returning_user_finishes_inspection_and_attendance_without_hidden_controls | X-V05（実Google Maps JavaScript APIの接続・キー制限・帰属表示の実地確認（地図面は現在プレースホルダー）・T086） |
| TC-06 | MAP-03 | 合格（局所） | tests/facilities.test.ts::施設の台帳と位置確認 (T019) > coordinate_edit_invalidates_only_location_confirmation<br>tests/e2e/facility-location.spec.ts::gps_denial_allows_manual_entry_without_tracking@desktop-1280 | - |
| TC-07 | MAP-03 | 合格（局所） | tests/facilities.test.ts::施設の台帳と位置確認 (T019) > coordinate_edit_invalidates_only_location_confirmation<br>tests/gis-query.test.ts::施設の全件取得 (T020) > invalid_list_conditions_are_rejected_without_partial_results (T085) | - |
| TC-08 | MAP-04 | 合格（局所） | tests/gis-query.test.ts::施設の全件取得 (T020) > filters_by_latest_inspection_result_and_open_issues<br>tests/e2e/map.spec.ts::old_map_response_cannot_replace_new_viewport | - |
| TC-09 | MAP-05,MAP-06 | 合格（局所） | tests/inspections-issues.test.ts::点検と異常 (T029〜T032) > inspection_links_ready_attachments_and_rejects_uninspected_ones<br>tests/inspections-issues.test.ts::点検と異常 (T029〜T032) > facility_inspection_history_pages_every_version_once_and_keeps_the_original (T085)<br>tests/e2e/inspection.spec.ts::inspection_form_preserves_values_after_failed_submission@desktop-1280 | - |
| TC-10 | MAP-07 | 合格（局所） | tests/e2e/issues.spec.ts::issue_state_does_not_appear_as_location_verified@desktop-1280<br>tests/facilities.test.ts::施設の台帳と位置確認 (T019) > coordinate_edit_invalidates_only_location_confirmation | - |
| TC-11 | AST-01,AST-02 | 合格（局所） | tests/assets.test.ts::車両・資機材の台帳 (T025) > asset_has_one_storage_location_and_nonnegative_quantity<br>tests/inspections-issues.test.ts::点検と異常 (T029〜T032) > asset_inspection_accepts_exactly_one_matching_target<br>tests/e2e/asset-inspection.spec.ts::asset_inspection_records_photo_and_corrects_from_history_without_overwriting@desktop-1280 | - |
| TC-12 | DSP-01,DSP-02 | 合格（局所） | tests/incidents.test.ts::模擬・訓練・実出動記録と状態API (T040) > incident_kind_is_separate_from_status_and_never_dispatches<br>tests/incident-participants.test.ts::参集・到着・帰還の本人/代理記録 (T041) > returned_status_preserves_unknown_arrival_time<br>tests/e2e/incidents.spec.ts::incident_detail_traces_activity_vehicle_and_equipment@desktop-1280 | - |
| TC-13 | DOC-01 | 合格（局所） | tests/attachments.test.ts::添付のリンク・取得・削除 (T017) > unlink_and_permission_revocation_block_new_downloads<br>tests/upload.test.ts::添付の予約とアップロード (T015) > ready_object_cannot_be_overwritten_by_late_upload | - |
| TC-14 | NFR-07 | 合格（局所） | tests/audit.test.ts::監査 (T014) > audit_is_append_only_and_scope_filtered<br>tests/report-approval.test.ts::報告書の申請・承認・差戻し・承認版出力 (T058) > second_approval_supersedes_previous_approved_version<br>tests/e2e/audit.spec.ts::audit_panel_shows_who_changed_what_without_bodies | - |
| TC-15 | NFR-05 | 合格（局所） | tests/mutation.test.ts::executeMutation (T004) > same_key_concurrent_requests_apply_the_effect_once<br>tests/client-shell.test.tsx::client shell (T005) > double_tap_while_saving_sends_one_request<br>tests/e2e/asset-inspection.spec.ts::inspection_retry_after_lost_response_registers_once_and_correction_keeps_the_original@desktop-1280 | - |
| TC-16 | NFR-05 | 合格（局所） | tests/facilities.test.ts::施設の台帳と位置確認 (T019) > same_key_resend_has_one_effect_and_two_devices_never_silently_overwrite (T085)<br>tests/e2e/member-admin.spec.ts::unsaved_input_is_confirmed_before_closing_and_conflicts_and_revocations_are_shown@desktop-1280 | - |
| TC-17 | NFR-04 | 合格（局所） | tests/e2e/dependency-outages.spec.ts::outage_never_claims_dispatch_or_saved_success<br>tests/e2e/accessibility.spec.ts::returning_user_finishes_inspection_and_attendance_without_hidden_controls | - |
| TC-18 | RG-09 | 合格（局所） | tests/deploy-config.test.ts::deploy-config (T078) > demo_binding_or_incompatible_schema_blocks_deploy<br>tests/schema.test.ts::core schema (T003) > fixture_has_two_units_four_roles_suspended_and_scopes_with_fictional_names | X-DEMO（公開デモ（分離した実環境）の構築と本番データとの完全分離の実地確認（RG-09）・T086） |

## 横断journey

| id | 動線 | 判定 | 試験 |
|---|---|---|---|
| J1 | 点検→異常→AI→task→通知 | 合格（局所） | tests/e2e/journeys.spec.ts::journey_inspection_anomaly_ai_task_notification@desktop-1280 |
| J2 | 活動/出動→使用→集計→帳票 | 合格（局所） | tests/e2e/journeys.spec.ts::journey_activity_incident_usage_analytics_report@desktop-1280 |
| J3 | 文書→引用→失効 | 合格（局所） | tests/e2e/journeys.spec.ts::journey_document_citation_withdrawal@desktop-1280 |
| J4 | offline→競合→復旧（点検の訂正） | 合格（局所） | tests/e2e/journeys.spec.ts::journey_offline_correction_conflict_recovery@desktop-1280 |

## notApplicable（docs/08 §2: 読取専用・純表示に不要なmutation試験を実施したことにしない）

なし

## 実外部・実端末・人の残手順（未実施。合格に数えない）

| id | 根拠 | 内容 | 担当 |
|---|---|---|---|
| X-V01 | docs/evidence/V01-auth.md「未実施」1〜8 | 実Cloudflare（staging）での認証・CPU時間・Secure Cookie の実測（test:live auth-workers） | T086 |
| X-V02 | docs/evidence/V02-files.md「未実施」1〜6 | 実R2での検査・EXIF除去・ready不変（test:live file-inspection） | T086 |
| X-V04-JEV | docs/evidence/V04-jev.md「未実施」 | 実Workers AI（typesafe/jev）の実応答・モデル版固定・usage・日本語品質（D12）。T087分（提案資料での未実施明記）は完了。実行は未実施・T088（実環境） | T088 |
| X-V04-LLM | docs/evidence/V04-llm.md「未実施」 | 実生成モデルの比較・固定・捏造検出精度（D12/D16）。T087分（提案資料での未実施明記）は完了。実行は未実施・T088（実環境） | T088 |
| X-V04-RET | docs/evidence/V04-retrieval.md「未実施」「T066 限界・残手順」 | OCR・実PDF集合の抽出率・Vectorize実測比較・実AIでのRAG/横断の品質評価。T087分（提案資料での未実施明記）は完了。実行は未実施・T088（実環境） | T088 |
| X-AIEVAL | docs/evidence/ai-evaluation.md・docs/16 T061状態欄 | 実モデルでの固定holdout評価（記録済み出力ではなく実呼出し）。T087分（提案資料での未実施明記）は完了。実行は未実施・T088（実環境） | T088 |
| X-V05 | docs/16 T021状態欄・docs/14 D22（V05） | 実Google Maps JavaScript APIの接続・キー制限・帰属表示の実地確認（地図面は現在プレースホルダー） | T086 |
| X-DEV-MAPS | ops/device-test-matrix.md §2.1/§2.2 | 実端末でのMapsアプリ起動（外部経路） | T086 |
| X-V06-DELIVERY | docs/evidence/V06-delivery.md「未実施」 | 実チャネル（Web Push/email。D13）での到達・不明・再送 | T088 |
| X-V06-RT | docs/evidence/V06-realtime.md「未実施」1〜4 | 実30端末・実回線での更新反映遅延（test:live realtime-load） | T086 |
| X-V07-PERF | docs/evidence/V07-performance.md「未実施」1〜4 | 実staging・実D1 rows_read・実回線での通常API p95（D18承認材料） | T086 |
| X-V07-RESTORE | docs/evidence/V07-restore.md「未実施」1〜4 | 実D1/R2での復元演習（別担当による実行を含む）。T087の提案資料での棚卸しは実施済み（未実施の残手順として明記・実行には実環境/人が必要） | T088 |
| X-V07-RENDER | docs/evidence/V07-report-render.md「未実施」1〜8 | PDF/CSVの実ビューア・実Excelでの表示確認（test:live report-render） | T086 |
| X-COST | docs/evidence/cost-estimate.md「正直な限界」・ops/cost-alerts.md §4/§5 | 実使用量・実請求との照合、実環境の停止・復帰演習（D11）。T086分（デモへの費用上限適用とMaps割当手順の整備）は実施済み。実使用量・実請求との照合は未実施・T088 | T088 |
| X-DEV-1 | ops/device-test-matrix.md §2.1〜2.3 | iOS Safari／Android Chrome／PCの実機での主要動線・PWA install・quota・実回線 | T086 |
| X-DEV-2 | ops/device-test-matrix.md §2.1〜2.3 | VoiceOver／TalkBack／NVDA の実スクリーンリーダー確認 | T086 |
| X-DEV-3 | docs/evidence/ph8.md「未実施・未接続」 | axe走査は4画面＋WCAG 2.1 A/AA に限定（全SCRの走査は未実施） | T086 |
| X-DEV-4 | ops/device-test-matrix.md §2.4 | 代表利用者（5名程度）による説明なし再訪の計測（D18の承認材料）。T087の提案資料での棚卸しは実施済み（未実施の残手順として明記・実行には実環境/人が必要） | T088 |
| X-DEMO | docs/16 T086 | 公開デモ（分離した実環境）の構築と本番データとの完全分離の実地確認（RG-09） | T086 |
| X-OUT-1 | docs/evidence/V07-outage.md「未実施」1 | staging演習（6 scenarioを実Workers/D1/Queuesで） | T086 |
| X-OUT-2 | docs/evidence/V07-outage.md「未実施」2 | 実Googleキーの停止で一覧代替を確認 | T086 |
| X-OUT-3 | docs/evidence/V07-outage.md「未実施」3 | 実providerの到達不明（D13の了承後） | T088 |
| X-OUT-4 | docs/evidence/V07-outage.md「未実施」4 | 実在の正副担当の交代（ops/admin-handover.md §3） | T088 |
| X-OUT-5 | docs/evidence/V07-outage.md「未実施」5 | 別担当（人）によるrunbookの再現 | T088 |
| X-OUT-6 | docs/evidence/V07-outage.md「未実施」6 | 紙/既存電話への切替と復帰照合の実地演習 | T088 |
| X-OUT-7 | docs/evidence/V07-outage.md「未実施」7 | 遮断・鍵rotationの演習（ops/security-response.md §7） | T086 |
| X-OUT-8 | docs/evidence/V07-outage.md「未実施」8 | Queue送信失敗の実環境観測 | T086 |
| X-OUT-9 | docs/evidence/V07-outage.md「未実施」9 | 管理者全員回復不能時のCloudflare側復旧手順の整備はT086で実施（ops/account-recovery.md §5）。stagingでの演習が残る（X-OUT-1と併せて実施） | T086 |
| X-OUT-10 | docs/evidence/V07-outage.md「未実施」10 | 代理の参集記録の担当を付ける画面（D08） | T088 |

## 課題台帳（criticalOrHighUnresolvedIssues の出典。コントローラ裁定R7）

| id | 重大度 | 状態 | 内容 | 出典 | 重大度の根拠 | 担当 |
|---|---|---|---|---|---|---|
| T085-D1 | high | resolved | 施設の点検履歴（API-44）の続き取得が新しい順なのに cursor条件が > で、2頁目以降が欠落していた | T085のAPI-44網羅試験（tests/inspections-issues.test.ts T085） | 履歴の欠落（AT-MAP-05/06「過去版を開く」）。limit=1の全cursor完走で4件中1件しか返らない赤を確認→ < へ修正し緑 | T029 |
| T085-D2 | high | resolved | 点検保存の応答が失われた後、画面の案内どおり送り直すと二重登録になっていた（実施日時を送信ごとに作り直し、送信鍵が変わる） | T085のe2e（tests/e2e/asset-inspection.spec.ts） | NFR-05/TC-15の二重登録。修正前の実行で同一点検2件（inspectedAt差130ms）の赤を確認→最初の送信で固定して緑 | T033 |
| T085-D3 | medium | resolved | SCR-23（資産点検）と点検訂正の画面が未実装、施設詳細の点検結果が現在版でなく最新日時の行 | docs/16 T033状態欄・ph2-review 第3回「点検結果表示が現在版でない」 | T033の残作業（画面の欠落）。T085でSCR-23・訂正モード・API-51点検履歴・API-44 isCurrentを接続しe2eで確認 | T033/T030 |
| FLAKE-1 | medium | open | fill値の消失で文書作成のPOSTが送られず30秒で落ちる（稀。引き金未特定） | docs/evidence/ph8.md「既知フレーキー」documents.spec desktop「題名消失」 | 試験の不安定さ。R8の調査（ph8.md）: 検証エラー「題名を入力してください」が残る＝fillの値が背景の再レンダリングで消えて作成POSTが出ない（データ破壊なし・単独実行は緑・引き金は未特定）。T085のcollect:evidenceではe2eのフル走行3回中2回発火（T084は3回中1回）。T085b: 押下後POST不発なら検証エラー確認→再fill・再押下×3の回復ループ＋ACL追加の先出し＋ドロップ吸収ヘルパで抑止。**根因（再マウント/再レンダリング競合の引き金）は未特定**。M0基準3回中3回発火→M3'（4ad6883）以降は未発火 | T085b |
| FLAKE-2 | low | resolved | reports.spec desktop／facility-location.spec desktop／notifications.spec phone の1回off | docs/evidence/ph8.md「既知フレーキー」継続観察 | reports・journeysは根因を同定（ReportDraftPage.tsx:905の常時表示「承認済みの版が無いため…」への部分一致が先取りし確定前のGETが走る）→API-60のwaitForResponse＋exact一致へ。facility-locationはpopup URL直後読み〔review r0 Minorの実発火〕→要求イベント待ちへ。notificationsは待機化〔元失敗行は特定できず〕。M3'以降のフル走行で未発火 | T085b |
| T085b-W1 | low | open | wrangler 4.150のdevサーバーがProxyWorker→UserWorker接続を希に切断し〔kj keep-alive約5秒境界・「Network connection lost」。#14926/#15252〕、awaitedな書き込み要求の応答を失って試験が赤になり得る | T085b M3計測〔issues.spec desktopが実発火。同種ログはM0/M2にも〜1回/回〕 | GETは自動再試行・PATCH/POSTは非冪等のため再試行されず。対策は署名限定・有界3回・同一冪等鍵の再送ヘルパ〔issues 6書き込み＋documents作成に適用済み〕。他specのawaited書き込みには残存。docs/evidence/e2e-speed.md「残存クラス」。T086最終検証（2026-10-21）: collect:evidenceのe2e＋フルe2e 3回＝計4走行（75〜150件/回）で失敗0・ヘルパ適用外specでの赤は観測されず。上流（wrangler #14926/#15252）は未解決のため継続観察。発火時はclickUntilWriteArrivesヘルパ適用を検討。T088最終検証（2026-10-21）: フルe2e第1バッチ3走行で3回発火（incidents.spec incident_new_draft_usage_rows…が2回・ai-review.spec stale_proposal…が1回。いずれも単独実行は緑・src・tests/e2eはT087の3回連続緑から不変・ai-reviewは再生成POST落下の署名〔v2候補が90秒待っても出現せず〕）。ai-review.specの再生成クリックへclickUntilWriteArrivesを適用。incidents側はUI上のawaited書き込みが無く失敗行を捕捉できていないため適用せず継続観察。発火時ログは .superpowers/sdd/16_実装タスク一覧/t088-final-e2e-firings.log。同日の続くcollect:evidence再収集（abc64e7・ヘルパ適用後の初collect）のe2eフェーズでも2回発火（journeys.spec journey_activity_incident_usage_analytics_report〔活動登録POST落下と推定・「夜間の放水訓練」のlinkが15秒で出現せず〕・asset-inspection.spec〔FLAKE-4として起票〕。error-contextを .superpowers/sdd/16_実装タスク一覧/t088-journeys-error-context へ保存）。いずれも単独・再走行で緑に復帰。本日の発火頻度はM0/M2期の同種ログ観察（〜1回/回）と同水準。journeysへのヘルパ適用は次の安定的な発火署名捕捉時に検討 | - |
| FLAKE-3 | low | resolved | 完了確定済みの添付を背景のQueue consumerがreadyへ進め、「未検査は422」の断言が201で落ちた（試験側の競合） | T085の全スイート実行（tests/inspections-issues.test.ts manual_issue_links_ready_attachments_and_rejects_uninspected_ones） | collect-evidence 1回目でvitest 1件failed。完了確定前の添付（makeNotYetCompleted）へ変更し同型の2箇所も修正 | T029/T032（試験） |
| FLAKE-4 | low | resolved | asset-inspection.spec inspection_retry_after_lost_response_registers_once_and_correction_keeps_the_original〔desktop-1280〕が応答消失を注入する試験で稀に落ちる（今回の失敗=「結果を確認できません」が20秒で出現せず。T087時の失敗とは別の断言点） | docs/evidence/ph8.md「T087」最終検証（2026-10-21・1回）＋T088最終検証のcollect:evidence再収集（2026-10-21・再発） | T087最終検証で1回（発火ログ無し・根拠未特定としてph8.md「T087」に記録し、再発時の起票を次担当へ申送り）→T088最終検証のcollect:evidence（abc64e7）で再発したため本起票。error-contextを保存（.superpowers/sdd/16_実装タスク一覧/t088-asset-inspection-error-context。失敗断言=getByText(/結果を確認できません/)のtoBeVisible 20秒タイムアウト）。T087時と合わせ2回/約12走行。試験自身が応答消失を注入するため、注入のタイミングとT085b-W1（wranglerのProxyWorker接続切断）の重なりで挙動が変わるタイミング依存の可能性が高いが、src・本試験は両発火時点で不変・単独実行は両回とも緑・根因は未特定。データ破壊は無し（0件更新の検証読みが主体）。再発時は単独再実行で緑になるかの確認と、失敗が同一断言点かの記録を継続。T088で対策: 注入が稀に漏れて応答が画面へ届く（失敗時のpage snapshot=施設詳細画面に遷移済み・登録は正しく1件）競合のため、docs.specの回復ループ前例と同じく『漏れを検出したら別内容で同じシナリオをやり直す（最大3回・成功するまで本 flowは実施済みを保証）』構造へ。製品側は全観測で正常（登録1件・冪等有効） | - |
| T031-I3 | high | resolved | API-46の権限判定がクライアントの送るbody.inspectorMemberIdで行われ、一般団員が他人の点検を訂正し実施者を差し替えられた（T031の既存欠陥。T085の訂正画面で到達可能になった） | T085レビューA-I3（src/server/routes/inspection-corrections.ts） | 権限欠陥（Review Focus 1）。修正前は他人の点検の訂正が201（赤）→元の原本の実施者と新しい実施者の両方で判定して403（緑） | T031 |
| T085-D8 | medium | resolved | 点検の記録の「訂正済み」を系列の現在版でないこと（isCurrent=false）で判定しており、新しい点検があるだけの古い記録まで訂正済みと表示した | T085レビューA-I1 | 表示の誤り（記録の意味を取り違える）。supersededByIdで判定し、2件以上の資産でe2eの赤（訂正済み2件）→緑 | T033 |
| T085-D9 | medium | resolved | 異常ありの点検を訂正すると、異常が二重に起票された（訂正モードでcreateIssueを常に有効にしていた） | T085レビューA-I2 | docs/11 §3（既存異常と二重にしない）違反。良好→異常ありの訂正のときだけ起票に変更し、e2eの赤（異常2件）→緑 | T033 |
| T085-N3 | medium | resolved | 訂正のcreateIssueをサーバーが受け付け、API-46直接・同期API-81で同じ所見の異常を二重に起票できた（画面だけの防止だった） | T085再レビューN3（裁定R17→再々レビューで裁定R20） | docs/11 §3の二重起票防止。訂正元の系譜に異常あり・起票済みがあればcreateIssueを無視して起票しない（R17の422は画面・同期下書きの行き止まりになるためR20で変更）。実際の起票は応答のcreatedIssueIdで示す。系譜の照会はD1の束縛上限内に分割。試験はR17の422・束縛上限超えの500に対し赤→緑 | T031/T033 |
| T085-N1 | medium | resolved | staging孤児の回収が毎分先頭から最大1,000件だけを見て続きを保存せず、台帳のある実体が先頭に溜まると後ろの孤児に永遠に届かなかった（毎分のR2一覧費用も） | T085再レビューN1 | 続き位置をR2に保存して巡回・1回500件・15分ごと。試験（台帳のある1,010件の後ろの孤児）は続き位置を使わないと失敗 | T017 |
| T085-R18 | low | resolved | 訂正で元の実施者を保つと、その団員が休団・退団のとき管理者の訂正が422 inspector_not_activeで行き止まりになった | T085再レビュー（裁定R18） | 元の実施者を保つ訂正に限り通す（訂正した人は監査）。試験は修正前422（赤） | T031 |
| T085-D6 | low | resolved | 未作成の行を作るPUT（出欠の初回回答など）の途中の文が失敗すると、内部障害が「対象が見つかりません」の404に誤分類された | T085レビューB-I3の読取境界試験（tests/dashboard.test.ts） | 効果は0（全取消）だが理由の誤表示。前提条件を満たしているときは内部障害にする（前提を満たさない場合の404は従来どおり＝ph3-review A5の方針） | T004/T036 |
| T085-D7 | medium | resolved | R2へ書いた後にD1の台帳が失敗した転送の実体（staging孤児）を回収する処理が無かった | T085レビューB-I4（AT-DOC-01×CT-05） | docs/07 §3.2「孤児は回収対象」が未実装（ストレージの残留）。sweepOrphanStagingObjectsを追加し試験で回収を確認 | T017 |
| T085-D10 | medium | resolved | 管理画面の「団員を選ぶ」ほか、列をlg:だけで定義したgrid 9箇所がスマホで単一auto列になり、長い団員名で画面より広がった（725px） | T085レビュー第1ラウンドのcollect:evidence（audit/member-admin/dependency-outagesのスマホ試験） | D4と同型の狭幅欠陥。長い名前の団員がいると管理画面が横にはみ出し、操作が隠れた。grid-cols-1で同じデータで745→360を実測し、accessibility.specに360pxの管理画面の確認を追加（旧gridで747＝赤） | T013（ほかT039/T042/T044/T047の同型箇所） |
| T085-D4 | medium | resolved | 予定・出動の検索カードが単一のauto列のgridで、参加者selectの最長の団員名より狭くなれず200px幅で横スクロールが出た（データ量で再現） | T085の全スイート実行（accessibility.spec desktop inputs_stay_inside_the_search_card_at_narrow_widths） | フル走行の共有D1で団員が増えると発火（scrollWidth 269/202）。grid-cols-1＋min-w-0で同じデータで200に収まることを実測 | T039/T044（T083の狭幅修正の系） |
| T085-D5 | medium | resolved | AIアシスタントの「記録を添える」チップが確認待ちの異常を古い順に5件だけ出し、新しい異常を添えられなかった | T085の全スイート実行（assistant.spec desktop） | 確認待ちが5件を超えると再現（実行時14件）。全件を読み新しい順に5件へ修正し、同じデータでチップが出ることを確認 | T070 |
| PH1-A1 | medium | open | 管理者がAPI-03で他人の許可列に初期値を書ける／担当付与で連絡先を読む迂回 | docs/evidence/ph1-review.md A（中・方針で残す） | ph1-review表の重大度「中」。設計（docs/10）。D03承認待ち・担当付与は監査とMFAで抑止。T088（正式判定時点）に再確認: D03は未回答（config/production-policy.json回答欄空欄）のため決着不能。docs/evidence/release-decision.md §2 RG-04/§5 に回答待ちの阻害として明記。D03回答後に個別判定で決着（PH2-A12前例） | T088（D03） |
| PH1-A2 | medium | resolved | 認証イベントが監査に残らない／アカウント単位の回数制限が無い | docs/evidence/ph1-review.md A（低〜中・方針で残す） | 回数制限はT081以降に実装済み（ライブラリのD1計上5回/分/IP＋resolvePrincipal内のuser次元enforceUserRateLimit）。T086で欠けていた監査記録を実装: Better Authのhooks.after/onPasswordResetからサインイン成功・失敗・二要素設定変更（setup_started/enabled/backup_codes_regenerated）・パスワード再設定（要求・完了）をaudit_logsへ（src/server/auth/audit.ts）。旧実装でauthentication_events_are_recorded_in_audit_without_secrets（tests/audit.test.ts）が赤→実装で緑。秘密（パスワード・token・TOTP）不載・unit帰属できない試行は記録しない（IP制限が担当） | T086 |
| PH1-B1 | medium | resolved | 実装先行タスクの赤の証跡・変異の再現手順が無い | docs/evidence/ph1-review.md B（中〜低・方針で残す） | ph1-review表の重大度「中〜低」。scripts/mutate*.shを追加済みで記録のまま。T088（正式判定前）に再確認: scripts/mutate.sh・scripts/mutate-e2e.sh が存在し防御解除→赤→自動復元の手順として機能する（AGENTS.md検証コマンド節に記載）。初期タスクの赤証跡は過去の工程記録であり履歴の書換えをしない（PH2-B12と同判断・docs/16 §1）。製品欠陥ではなく工程記録であり、正式判定の阻害とはしない | T088 |
| PH0-BF07 | medium | resolved | 試験名「効果が二重にならない」とhandler副作用の不一致（確定の一回性のみ保証） | docs/evidence/ph0-review.md B-F07（中・方針で残す） | ph0-review表の重大度「中」。外部効果はhandlerの責務と明記。T088（正式判定前）に再確認: 試験名と保証範囲の不一致はph0-review時点の指摘で、外部効果（通知送信等）はhandlerの責務である旨はdocs/02共通更新の規定・各handler実装コメント・ops/outage-runbook.md（到達不明の正直表示）で明記済み。確定の一回性はexecuteMutationのbatch原子性で保証（tests/mutation.test.ts）。方針として維持を記録し決着 | T088 |
| PH2-B12 | medium | resolved | PH2のコミット境界が1タスク1コミットに従わない | docs/evidence/ph2-review.md B12（中・方針で残す） | ph2-review表の重大度「中」。履歴の書換えはしない（docs/16 §1に記録）。T088（正式判定前）に再確認: PH2期間のコミット境界は1タスク1コミットに従わない工程記録。履歴の書換えはしない（docs/16 §1・規定どおり）。T083以降は1タスク区切りコミットで運用し、本項は過去工程の記録として決着 | T088 |
| PH2-C15 | medium | resolved | 地図の種別チップのトグルで全件再取得し一覧が点滅する | docs/evidence/ph2-review.md C15（中・方針で残す） | useFacilitiesの再取得を非破壊化: 一覧を持っている間のreloadでは一覧を空にせず「loading」に戻さず、新世代が全cursor完走したときだけ差し替える（トグルは表示フィルタのまま件数再取得の意図=docs/03 SCR-03は保持）。旧実装でtests/map-facilities.test.tsxのreload系2件が赤（reload直後state=loading・items=[]、失敗時も空）→実装で緑。初回読込のpartial表示を据え置く回帰1件は旧実装で緑のまま。map.spec両幅7件緑 | T086 |
| PH4-B2 | medium | resolved | 承認待ち通知draftが送信者の一覧に現れない（送信者一覧APIが契約に無い） | docs/evidence/ph4-review.md B2（中・方針で残す） | 新規endpointは作らず既存API-67（GET /notifications/me）へ sent=true の要求拡張（契約3点セット: registry・docs/05・OpenAPI再生成。T085のAPI-44/51と同じ前例）。自分が作った通知（draft/cancelled含む全状態）を新しい順に返し、受信箱（sent無し）とAPI-28指標との一致は不変。sent×unread併用は400。画面は通知タブの「送信した通知」切替（?sent=true）で未承認draftを開き直し承認前確認（承認/取消）を再開（ResumeDraftStep）。旧実装で赤: サーバー試験sent_view_lists_senders_own_drafts…はsent未知queryの400（tests/notification-approval.test.ts）・e2e pending_draft_appears_in_sent_list_and_can_be_resumed_to_sendは「送信した通知」ボタン不在のタイムアウト（実装退避で確認）→両方緑 | T086 |
| PH4-B3 | medium | open | 点検源のAI候補は原文表示・版比較・再生成がUIから不可（点検の単一件GET契約が無い） | docs/evidence/ph4-review.md B3（中・方針で残す） | ph4-review表の重大度「中」。stale検知と承認409は機能中。T085で点検履歴（API-44 isCurrent・API-51）は接続したが単一件GETは未提供 | T033/T055 |
| PH0-AF7 | low | open | タイムアウト後もhandlerが動き外部効果が二重になり得る | docs/evidence/ph0-review.md A-F7 | ph0-review表「低・方針で残す」 | - |
| PH0-L | low | open | allowedStates二重管理ほか軽微5件 | docs/evidence/ph0-review.md L-2/L-3/L-5/L-7/L-8 | ph0-review表「方針で残す」（低） | - |
| PH1-A3 | low | open | 冪等再送が認可版の増分後は403／停止済み再停止が409 | docs/evidence/ph1-review.md A | ph1-review表「低・方針で残す」 | - |
| PH1-C | low | resolved | フォーカス循環の細部・寸法の微差 | docs/evidence/ph1-review.md C | T086（low対応）でバンドルを分解して個別判定。修正1: ログインのエラーとaria関連付け=フォーム全体の誤り（未入力・認証失敗・再設定失敗）のp（role="alert"）にidを付け、TextFieldへ追加したdescribedBy propで入力欄にaria-invalid/aria-describedbyで関連付け（docs/03 SCR-01の変え方④に記録。未入力送信で両入力欄の関連付けを断言するjsdom試験tests/login-aria.test.tsxを旧実装で赤→緑）。現状確認でコード不变2: ①無効ボタンの理由=「生体認証でログイン」はdisabled＋title="生体認証（パスキー）は後続で対応します"で理由が付き、他のdisabledボタン（再設定・認証コードの送信）は入力欄が空の間だけの無効で理由自明②フォーカス循環=Overlay.tsxのuseOverlayがEscスタック（最前面の面だけ処理）・Tabトラップ・閉じた後のフォーカス復帰を実装済み（PH1レビュー第2回の修正）で、T083のaccessibility.specがTab実走査・keyboard到達不可0で合格済み。記録で決着2: ①ボタン影・文字サイズの微差=docs/03 §1.1-5等の意図した差（prototype寸法優先。Buttonはprototype Design Systemどおり56/52px・影）として維持②aria-label等の細部=T083でaxe走査4画面（WCAG 2.1 A/AA）とマーカーのテキストラベル断言は合格済みで、全SCR走査・実スクリーンリーダーでの確認はops/device-test-matrix.md §2の番号付き残手順として追跡中 | T086 |
| PH2-A12 | low | resolved | API-27が状態で422/404を区別／import解析中の固定・staging孤児 | docs/evidence/ph2-review.md A12 | T087（low対応）で4項目を個別判定、コード不変。意図した設計で維持2: ①API-27の状態別応答=未完成（pending_upload/uploaded/checking）は422 ATTACHMENT_NOT_READY「未完成であることを返し」、拒否・削除済み・期限切れとリンク無し/閲覧不可は404「存在を明かさない／対象の存在と閲覧可否を分けない」（src/server/routes/attachments.ts:23-27・46にまさにそのコメント付き。docs/07 §3.6「検査済実体のみ配信」。試験tests/attachments.test.ts早期取得422・tests/inspections-issues.test.ts状態別断言が現行どおり）。「未完成を成果と見せない」意図（UUID総当たりは非現実的）で維持。②import解析中の固定=解析jobが版ガード付きUPDATEでpending→parsingへ（二重実行は1つだけ通る。src/server/jobs/handlers/import.ts:40-45）、解析は台帳revision（base_dataset_revision）を固定して版+状態ガードで確定（同:92-99）、確定API-54は台帳がプレビュー時と変わっていれば409 master_changed_after_previewで再プレビューを強制（src/server/routes/import-commit.ts:153-157。docs/03 SCR-20「同時変更時再プレビュー」）。再配送・並行変更はstaleで冪等（import.ts:17-20）。他タスクで解決済み2: ③staging孤児=T085-D7/N1で実装済み。sweepOrphanStagingObjectsがR2のstaging/一覧×台帳（upload_attempts/attachments）照合で参照されない実体を回収し、続き位置cursor（STAGING_SWEEP_CURSOR_KEY）・15分毎・1回500件の巡回で後ろの孤児に届く（src/server/jobs/handlers/attachment-cleanup.ts:75-83・92-131。試験tests/upload.test.ts「orphan_sweep_resumes_from_its_cursor_and_reaches_orphans_beyond_the_first_thousand_keys（T085 N1）」）。④0バイト等=申請API-26の契約がbyteSize min(1)（src/shared/contracts/assets.ts:276）、転送API-83は実測0バイトを400 empty_bodyでattemptを作らずDBもR2も汚さない（src/server/attachments/upload.ts:232-235）、上限超過は内容型別の実測検査（同:132-133・228-231。試験tests/upload.test.ts「0バイトの転送は400」）。なおAPI-85保持期間の猶予はdocs/05 API-85行に「D10未決のため未実装（tombstone後にjobで即時削除）」と記録済み | T087 |
| PH2-C19 | low | resolved | 選択シートのEsc・フォーカス、語彙の微差 | docs/evidence/ph2-review.md C19〜C21 | T086（low対応）で3項目を個別判定。修正（C19）: 選択シート（SelectionSheet）のEsc非対応・フォーカス移動なし=Overlay.tsxのuseOverlayをexportして選択シートでも使い、Escで閉じる（overlayStackで最前面の面だけ反応）・開いたら「閉じる」ボタンへフォーカス・閉じたら開いたマーカーへ戻す、を実装（ドロワー/モーダルと同じ挙動。地図は操作できるままの非モーダルのためtrapFocus=falseでTabトラップだけ持たせない）。docs/03 SCR-03⑥を更新。jsdom試験（tests/map-facilities.test.tsxに選択シートのdescribeを追加）は旧実装で赤（フォーカスが動かない・Escで閉じない）→緑。e2e map.specのphone幅へEscで閉じる断言を追加し両幅7件緑。記録で決着2: C20（ステップ進行の語彙）=docs/03 SCR-06変え方②に記録済みの意図した差（「写真・メモへ進む/確認へ進む」とprototypeの「次へ：」形式との微差）として維持・C21（写真追加ボタンの構成）=prototypeは写真トグル（1枚/なし）だが実装はAttachmentUploader（写真を追加＋転送/検査/拒否の別状態。docs/03 SCR-06「写真は検査済み(ready)だけ添付」）で実装上の必然として維持 | T086 |
| PH2-R1 | low | open | 系列一意409のAPI試験なし・分類変更イベントなし・表示の軽微差（CSV成功表示等） | docs/evidence/ph2-review.md 第2回①② | ph2-review表「低・方針で残す」 | - |
| PH2-R3 | low | open | job自動リンクの監査・再リンク防止の明示試験なし | docs/evidence/ph2-review.md 第3回 | ph2-review表「低・方針で残す」 | - |
| PH3-A4 | low | open | API-22×使用履歴同時指定の版増分二重積み・狭い条件で再送404 | docs/evidence/ph3-review.md A4/新規1 | ph3-review表「低・方針で残す」 | - |
| PH3-A5 | low | open | 出欠の対象外が404/403に揺れる | docs/evidence/ph3-review.md A5 | ph3-review表「低・方針で残す」 | - |
| PH3-C8 | low | open | 小見出し形式・複数LeaveConfirm・canManage出し分け・ID開示 | docs/evidence/ph3-review.md C8・N2・N4・参考 | T086（low対応）で現状確認。コード不变で記録: C8（等幅小見出し）=一覧系は「2026 · 画面名」（ActivitiesPage/AnnouncementsPageほか）または画面名（INCIDENTS/MAP等）の既存流儀。prototypeの「2026 · OCT」は単月ビューの予定・活動画面の表記で、実装の一覧は日付絞り込みで複数月にまたがるため単月を示す語彙の選定は設計判断（出動・お知らせはprototypeに画面が無く共通部品構成=docs/03 §1.1-10/11）。統一は画面改善タスクで（ph3-reviewのRulingどおり）。N2（同一ページの複数LeaveConfirm）=PatrolPlansPage・ReportDraftPage・IncidentPageに2個ずつあり、react-router複数blockerの挙動は実装依存のため両方が同時dirtyで重なった場合の振る舞い（確認ダイアログの重なり）は未検証。単一blockerへの再構成は18呼び出し点に触れる構造変更のため本対応の範囲外。実害の再現・設計判断が固まった時に再対応。N4（出動詳細のcanManage）=IncidentPage.tsx:94は役割（officer/admin）で出し分け、サーバーは毎要求PER-04担当scopeを検査して担当scope保持者の一般団員を拒否（画面は案内）。ActivityPage/AnnouncementsPageと同じ「役割で出し分け・判定はサーバー」流儀でdocs/03 §1.1-10/14に記録済みのため維持。参考2件=①活動詳細API-07が対象者ID一覧をPER-01全員に返す②scope担当のPER-03保持者が対象外の公開済みをお知らせ一覧で見られない——いずれも既存のD23/T045設計の範囲で、解消には契約変更（API/DTO）が必要なため本対応（low・API不変）の対象外。必要になった時に契約変更で整理 | - |
| PH3-T | low | resolved | activities.specの死に変数・先取り断言・wrangler d1 executeのseed | docs/evidence/ph3-review.md 第3回 | ph3-review表「低・方針で残す」。T085bで整理（死に変数削除・「不参加」断言をフォーム閉鎖確定→チップの順に強化・seedをSQLITE_BUSY有界再試行のseedProxyScopeへ）。4ad6883以降のフル走行で未発火 | T085b |
| PH4-L | low | open | 再開理由のtrim無しほか低（A低/B低/C低の一部） | docs/evidence/ph4-review.md「方針で残す」 | ph4-review「方針で残す」（低） | - |
| PH5-L | low | open | superseded旧版FTS行・空索引succeeded・無効jobId・文内リンク44px・重複取得ほか | docs/evidence/ph5-review.md「方針で残す」1〜7 | ph5-review「方針で残す」（低） | - |
| PH6-L | low | open | 部分filter cursor・同unit cursor再利用・resync札の点色 | docs/evidence/ph6-review.md A低1/要確認1/要確認2 | ph6-review表「低/要確認・方針で残す」 | - |
| PH7-L | low | resolved | ai.calls計上位置・Retry-After固定・理由コード不統一・ラベル語彙ほか | docs/evidence/ph7-review.md「方針で残す」1〜9 | T086（low対応）で9項目を個別判定。修正4: ①A低1 ai.calls計上位置=classification.ts・report.tsともenv.AI存在確認より前で計上していたのを呼び出し可能を確認した後へ移動（RAG・アシスタントと同じ位置。AI無し環境のmanual_reviewで枠の母数が汚れない。jev.test.ts/report-generation.test.tsのai_unavailable試験へ「ai.callsが増えない」断言を追加し旧実装で赤→緑）②A低2 user次元429のRetry-After=enforceUserRateLimitが窓計算値をHttpErrorの追加headersで渡し、共通onError→errorResponseに出す（IP次元と同じ計算値。abuse.test.ts user次元試験の窓を5秒にして「Retry-After≤5秒」断言を追加し旧実装の包括既定60秒で赤→緑）③再レビュー軽微1 budget_stoppedラベル=「AIの月次上限に達したため」を中立語彙「AIの呼び出しが上限により停止されているため」へ（serverは全停止理由〔日次枠・通知枠・429許容・費用試算・手動停止〕で同コードを返すため理由を断定しない。client-job-error-labels.test.tsxへ「月次上限を含まない」断言を追加し赤→緑）④再レビュー軽微3 limits.ts開発設定コメントの「負荷検証」をdocs/05 §1・docs/07 §2と同じ「公開設定時の検証」へ統一。他タスクで既に解消2: C低4（OperationsPanelの403=FORBIDDEN Banner統一）はT083 R3で解消、#9（documents.specトースト断言のフレーク）はT083 R4で応答待ち＋role=statusスコープ待ちへ作り直し済み（T085b以降フルe2e 3回連続緑で未再発）。記録で決着3: B低2（報告書のtest:load数え間違い）はリポジトリ外のため修正しない（証跡正本はph7.md）・C低3（OperationsPanel内の理由コード扱い）は評価実行の失敗=生コード提示がAiEvaluationPanel前例・監査の停止理由=BUDGET_REASON_CODES閉集合の日本語化で領域別の整理として現状維持・再レビュー軽微2（docs/16 T086節対応行へのNFR-08追記）はdocs/16が本対応の対象外のためT086本体のdocs更新時に残す→T086 docs担当が追記済み（2026-10-20） | T086 |
| PH8-L | low | open | sync_recoverの手動再送の非決定性・FORBIDDEN語彙・注記の文体差・Google Fonts停止時のアイコン表示ほか | docs/evidence/ph8-review.md「方針で残す」（T083・T084） | ph8-review「方針で残す」（低・軽微） | - |
| T085-O1 | low | open | API-51の異常の子Pageは未接続（APIはT032で完了） | T085で観察 | docs/05 API-51行に残作業として記録 | 未割当 |
