# e2e高速化の計測と採否（T085b・2026-10-20）

対象: **T085b e2e試験の高速化と試験間の分離**のうち高速化（候補①〜⑤）の計測・採否と実装。分離（手順1・2）は完了済み（69279d7）。実行環境はローカル（Node v26 / workerd / wrangler 4.150 / Playwright 1.64 chromium）。**計測中、利用者の別プロジェクト（latch-worktrees）が `wrangler dev --port 8797` を稼働させていた**ため、本タスクの検証走行は `FIREOS_E2E_PORT=8798`（inspector 9240）で実施した（ポートの正本は scripts/e2e-port.ts の環境変数）。並行負荷の影響は後述の「負荷の係数」で補正して読むこと。

## 目標と基準（結果を見てから変えない）

基準計測（M0・手順1）の後に決定し、固定:

- **目標: フルe2e（`npm run test:e2e`・全プロジェクト）の中央値 ≤ 6.0分**（M0基準14.8分から≥59%削減）

| 計測 | コード | 条件 | 所要時間 | 结果 |
|---|---|---|---|---|
| M0 基準 | 0d21ca3 | workers=1・全プロジェクト | 15.5 / 14.8 / 14.8 分 → **中央値 14.8分** | 業務 193p/3s＋既知フレーキー1件/回 |
| M1 赤 | 0d21ca3 | --workers=2 | 8.6分 | 業務 119p/**2f**/3s＝試験間干渉（M1赤の一覧は下記） |
| M2 分離後 | 69279d7 | --workers=2 | 9.3 / 9.1 / 9.3 分 → **中央値 9.3分** | 業務 **121p/3s/0f を3回とも**（フレーキー0） |
| M3 絞り込み後 | 本コミット | workers=2（設定既定） | **(M3計測中)** | **(M3計測中)** |

- M1赤の干渉一覧（手順2で解消済み）: ①出動詳細の状態が他試験の同名操作と混線（realtime）②page.routeの遮断が並行負荷でPOSTの_fetch_を取り逃し保存成功する干渉（inspection）＝検出器の取り逃がし。いずれも69279d7で試験側のみ解消（業務コード無変更）。
- 補足: M0〜M2には受入ゲート（project acceptance）が約73失敗（証跡indexのcodeHash不一致＝設計どおり）を含む。acceptance自体の実行は約14秒で所要への寄与は小さい。

## 負荷の係数（本タスクの検証走行の読み方）

検証走行時、同一マシンで利用者の別プロジェクトのwrangler dev＋試験が稼働していた。M2証跡（docs/evidence/acceptance-index.json）の各試験時間と本タスク検証走行の同じ試験を比較すると**中央値で1.10倍**（最大2.04倍・n=66）。本ページの実測値は静かな環境では約0.9倍に縮む。

## 候補①〜⑤の計測と採否

| 候補 | 計測値 | 採否 |
|---|---|---|
| ①smokeセット | `npm run test:e2e:smoke`（setup＋auth4＋journeys4＋shell3＝12試験・desktop-1280）: **65秒 / 53秒 / 52秒 → 中央値53秒・3回とも緑** | **採用**。開発中の反復用。フルe2eの代わりにしない（AGENTS.mdに明記） |
| ②幅の絞り込み | 業務の実行数 122件（121p+3s）→ **73件（73p/0s）**（−49件・−40%）。M2証跡の試験別時間からの業務合計は 875秒→572秒（−35%） | **採用**（仕分け表は下記。マーカー`// 幅:`が正本で、scripts/e2e-width-triage.ts が設定へ反映。マーカーと宣言数が崩れると設定の読み込みが落ちる） |
| ③workers≥2 | M1赤（干渉2件）→ 分離後にM2で3回緑。前提: 試験ごとの架空データ分離（69279d7）・共有D1前提の監査・直接seedのSQLITE_BUSYを限定再試行で吸収 | **採用**（`workers: 2` を設定に既定化。setup依存は維持＝検証走行で全試験が管理者セッションを使用） |
| ④tablet-768の統合 | 単独実行（webServer起動込み）**78秒**（6試験）。フル走行内の実時間 **61.9秒→59.5秒**（絞り込み後）。T083実機matrix由来の5試験のうち3試験は768幅で意味を持たない（下記） | **維持＋絞り込み**（統合・廃止せず）。`@tablet-768` のmanifest参照が指す2試験（returning_user / revisit_core_flows）だけ768で実行。accessibility残り3試験は除外: inputs_stay は試験自身が240/200pxへ幅を変える（768の起点幅は無関係）・date_inputs は幅非依存のCSS断言・analytics_conditions はチップ幅406px未満でしか起きない回帰（768では恒真） |
| ⑤起動時ビルドの省略 | `npm run build` 3回: **0.88秒 / 約1秒 / 約1秒**（vite 8・313モジュール）。`scripts/e2e-prepare.ts`（D1再作成+migration）: **12.5秒** | **不採用**。削減効果が約1秒で存在せず、古い成果物を試験する危険と 新規判定ロジック（mtime比較）の複雑さだけが残る。prepareの12.5秒（約2%）も、毎回のD1再作成が試験間分離の基礎（状態の持ち越しを構造的に断つ）のため維持 |

## 絞り込み後の内訳と検証走行（負荷あり・ポート8798）

| 走行 | コマンド | 所要 | 結果 |
|---|---|---|---|
| 全プロジェクト | `npm run test:e2e -- --workers=2` | **403秒（6.7分）** | 業務 **73p/0f/0s**＋acceptance 2p/73f（codeHash不一致＝設計どおり） |
| 業務のみ（CIと同じ4プロジェクト指定） | `npm run test:e2e -- --project=setup --project=phone-360 --project=desktop-1280 --project=tablet-768 --workers=2` | **343秒（5.7分）** | **73 passed / 0 failed / 0 skipped** |
| smoke ×3 | `npm run test:e2e:smoke` | 65 / 53 / 52秒 | 12 passed ×3 |

- プロジェクト別の試験数: setup 1 / phone-360 **17**（両幅12＋phone限定5）/ desktop-1280 **53**（両幅12＋desktop限定41）/ tablet-768 **2** / acceptance 75。
- skip件数は **3→0**（旧・本文内 `test.skip(!isPhone)` 3件〔shell mobile_menu・member-admin ai_evaluation・assistant touch targets〕を設定側の phone限定仕分けへ移行。断言の意味は不変。manifestの該当knownSkips 3件を刈り取り）。
- M3（絞り込み後のフル×3・中央値）は上の表のとおり**(計測中)**。M2証跡時間からの予測では業務合計572秒→2 worker理想286秒＋起動約35秒＋不均衡≈**5.3〜6.1分**（負荷係数0.9〜1.1で読み替え）。

## 実装の要点（Playwrightのgrep仕様）

プロジェクトごとの除外は `grepInvert` で行う。**Playwrightのgrepは「プロジェクト名＋試験タイトル（＋タグ）」を空白結合した文字列にmatchさせる**ため、`^タイトル$` の全面アンカーは前方のプロジェクト名に当たって除外が効かない（本タスクで実測・確認済み）。`scripts/e2e-width-triage.ts` は `(?:^|\s)タイトル(?:\s|$)` の境界つき並びを生成する。新規試験を追加するときは `// 幅:` マーカーを必ず付ける（無いと設定の読み込みが例外で落ちる＝静かな全幅復帰を防ぐ）。

## manifestへの反映（check:coverage緑・2026-10-20）

- 絞り込みで実行プロジェクトが減った全参照に `@プロジェクト` を付与: **@desktop-1280 154件・@phone-360 3件**（R14: 参照は実際に走るプロジェクトで合格を要求する）。
- 既存のプロジェクト指定参照はすべて維持: `ai_evaluation_buttons_meet_touch_target_on_mobile@phone-360` / `returning_user_finishes_inspection_and_attendance_without_hidden_controls@tablet-768` / `revisit_core_flows_complete_in_few_operations_after_relogin@tablet-768`。
- knownSkips 3件 → 0件（本文内skipの廃止に伴う）。
- `npm run check:coverage` 緑（参照テスト272件）。

## 幅の仕分け表（全58試験・マーカーと1対1）

判定の基準: 幅で変わる断言（isPhone分岐・押下領域44px・ボトムナビ/サイドバー構成・scrollWidth/はみ出し・viewport固有の可視性・prototypeの寸法）がある試験は**両方**（または幅固有なら**phone限定**）。純粋な流れ・API-through-UI・データ断言の試験は**desktop限定**。データ量に依存する試験の絞り込みは行っていない（accessibilityの狭幅回帰は長い名前の団員を自前でseed・assistantのnewest-5系は対象外のため影響なし）。
| spec | 試験 | 判定 | 根拠 |
|---|---|---|---|
| accessibility.spec.ts | `returning_user_finishes_inspection_and_attendance_without_hidden_controls` | 両方 | 地図障害の一覧代替がスマホ/PCで導線違い（T083端末matrix。tablet-768でも実行） |
| audit.spec.ts | `audit_panel_shows_who_changed_what_without_bodies` | 両方 | 監査ログが360pxで横にはみ出さない確認 |
| auth.spec.ts | `login_screen_matches_the_prototype_and_offers_no_public_signup` | 両方 | prototypeの寸法断言＋360pxではみ出さない確認 |
| dependency-outages.spec.ts | `outage_never_claims_dispatch_or_saved_success` | 両方 | scenario1のGoogle全断時の代替経路がスマホ/PCで導線違い |
| map.spec.ts | `old_map_response_cannot_replace_new_viewport` | 両方 | マーカー(スマホ)/一覧行(PC)の表示が分岐 |
| map.spec.ts | `map_selection_sheet_matches_prototype_and_opens_detail` | 両方 | スマホ=選択シート/PC=右パネルと導線が分岐 |
| map.spec.ts | `three_facility_types_are_identified_by_text_not_color_only` | 両方 | 一覧切替(スマホ)の分岐があり狭幅の代替を読む |
| member-admin.spec.ts | `members_screen_matches_the_prototype_structure` | 両方 | 検索欄320×42・ドロワー440px(PC)/360px(スマホ)の寸法断言 |
| reports.spec.ts | `report_forms_warn_on_unsaved_leave_and_links_meet_touch_target` | 両方 | モバイル44pxの押下領域断言を含む |
| revisit-flows.spec.ts | `revisit_core_flows_complete_in_few_operations_after_relogin` | 両方 | T083端末matrixの中核（360/768/1280で測定） |
| shell.spec.ts | `shell_layout_matches_the_viewport` | 両方 | ボトムナビ84px・サイドバー248pxなど、幅で変わる構成そのもの |
| shell.spec.ts | `keyboard_navigation_changes_screens_and_moves_focus_to_main` | 両方 | 操作対象がボトムナビ(スマホ)/サイドバー(PC)で分岐 |
| accessibility.spec.ts | `inputs_stay_inside_the_search_card_at_narrow_widths` | phone限定 | 試験自身が240/200pxへ幅を変える（実行幅は問わず意味は同じためphone-360だけ） |
| accessibility.spec.ts | `analytics_conditions_stay_inside_the_screen_at_phone_width` | phone限定 | チップのはみ出しは約406px未満でしか起きない（768/1280では恒真） |
| assistant.spec.ts | `assistant_input_controls_meet_touch_target_on_mobile` | phone限定 | 押下領域44pxの規則はモバイルのみ。PCはprototypeのコンパクト寸法が正＝T085b設定側の仕分け |
| member-admin.spec.ts | `ai_evaluation_buttons_meet_touch_target_on_mobile` | phone限定 | 押下領域44pxの規則はモバイルのみ。PCはコンパクト寸法が正＝T085b設定側の仕分け |
| shell.spec.ts | `mobile_menu_tab_shows_profile_and_tiles` | phone限定 | メニュータブはスマホ幅のみの画面。desktopでは実行しない＝T085b設定側の仕分け |
| accessibility.spec.ts | `date_inputs_render_with_the_app_field_style_on_ios_browsers` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| activities.spec.ts | `planned_answer_and_actual_presence_have_separate_labels` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| activities.spec.ts | `proxy_answer_form_resets_after_save_and_leaves_without_warning` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| ai-review.spec.ts | `stale_proposal_requires_regeneration_not_forced_approval` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| analytics.spec.ts | `analytics_shows_conditions_and_traces_sources` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| announcements.spec.ts | `edited_announcement_requires_new_read` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| asset-inspection.spec.ts | `inspection_retry_after_lost_response_registers_once_and_correction_keeps_the_original` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| asset-inspection.spec.ts | `asset_inspection_records_photo_and_corrects_from_history_without_overwriting` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| assets.spec.ts | `asset_detail_displays_quantity_unit_and_storage` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| assistant.spec.ts | `assistant_proposal_requires_explicit_review_of_effects` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| attachments.spec.ts | `checking_file_is_not_submitted_as_ready` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| auth.spec.ts | `mfa_recovery_code_cannot_be_reused` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| auth.spec.ts | `unauthenticated_visit_goes_to_login_and_returns_after_login` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| auth.spec.ts | `invitation_that_cannot_be_used_explains_why_without_leaking_state` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| csv.spec.ts | `csv_import_preview_then_commit_updates_master` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| dashboard.spec.ts | `home_metrics_drill_down_to_matching_lists` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| documents.spec.ts | `withdrawn_document_disappears_from_search_and_citation` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| documents.spec.ts | `image_only_pdf_version_shows_unextractable_reason` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| facility-location.spec.ts | `gps_denial_allows_manual_entry_without_tracking` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| incidents.spec.ts | `incident_detail_traces_activity_vehicle_and_equipment` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| incidents.spec.ts | `incident_new_draft_usage_rows_are_guarded_by_leave_confirm` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| inspection-templates.spec.ts | `template_edit_creates_new_draft_version` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| inspection.spec.ts | `inspection_form_preserves_values_after_failed_submission` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| issues.spec.ts | `issue_state_does_not_appear_as_location_verified` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| journeys.spec.ts | `journey_inspection_anomaly_ai_task_notification` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| journeys.spec.ts | `journey_activity_incident_usage_analytics_report` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| journeys.spec.ts | `journey_document_citation_withdrawal` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| journeys.spec.ts | `journey_offline_correction_conflict_recovery` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| member-admin.spec.ts | `stop_requires_reason_and_preserves_member_history` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| member-admin.spec.ts | `keyboard_only_can_filter_open_and_close_the_member_drawer` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| member-admin.spec.ts | `unsaved_input_is_confirmed_before_closing_and_conflicts_and_revocations_are_shown` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| notifications.spec.ts | `notification_ui_distinguishes_accepted_unknown_and_read` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| notifications.spec.ts | `notification_approval_shows_conflict_when_already_approved_elsewhere` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| offline-account-switch.spec.ts | `account_switch_never_leaves_or_shows_another_users_offline_draft` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| offline-sync.spec.ts | `offline_conflict_never_uses_last_write_wins` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| patrol-plans.spec.ts | `patrol_ui_completes_draft_order_and_human_confirm_without_auto_dispatch` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| pwa-cache.spec.ts | `offline_cache_contains_no_api_response_or_google_tiles` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| pwa-cache.spec.ts | `sw_update_notifies_and_does_not_destroy_unsaved_input` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| realtime.spec.ts | `incident_detail_receives_remote_updates_and_resyncs_after_role_change` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| reports.spec.ts | `report_ui_shows_missing_fields_and_only_exports_approved_version` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| shell.spec.ts | `api_paths_return_json_never_the_spa` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |

## 正直な記録

- 初回の検証走行（1回目）は `grepInvert` の正規表現を `^タイトル$` で全面アンカーしたため**除外が一切効かず**、phone 55件・desktop 53件が走ってphone限定3試験がdesktopで失敗した（skip撤去済みのため実行されて赤）。上記のgrep仕様の確認後に境界つき正規表現へ修正し、再走行で業務73件緑・skip 0を確認した。失敗走行のログは破棄していない（/tmp/opencode/e2e-verify.log）。
- 検証走行は負荷あり（負荷の係数参照）。静かな環境でのM3が目標6.0分を下回るかは境界付近（予測5.3〜6.1分）で、**この時点では達成を主張しない**。M3の中央値で判定する。
- tablet-768の残り2試験（returning_user・revisit_core_flows）はmanifestの@tablet-768参照が要求する768幅の証拠であり、削除すれば更に約30秒（wall）稼げるが**T083実機matrixの768証拠を失う**ため維持した（採否表④）。
