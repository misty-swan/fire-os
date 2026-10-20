# e2e高速化の計測と採否（T085b・2026-10-20）

対象: **T085b e2e試験の高速化と試験間の分離**のうち高速化（候補①〜⑤）の計測・採否と実装。分離（手順1・2）は完了済み（69279d7）。実行環境はローカル（Node v26 / workerd / wrangler 4.150 / Playwright 1.64 chromium）。**計測中、利用者の別プロジェクト（latch-worktrees）が `wrangler dev --port 8797` を稼働させていた**ため、本タスクの検証走行は `FIREOS_E2E_PORT=8798`（inspector 9240）で実施した（ポートの正本は scripts/e2e-port.ts の環境変数）。並行負荷の影響は後述の「負荷の係数」で補正して読むこと。2026-10-20 fix round 2: M3/M3′の確定値を反映し、M1赤の一覧・件数の帰属・仕分け基準文を実ログと突き合わせて修正（task-85b-findings-r2.md D1〜D5）。

## 目標と基準（結果を見てから変えない）

基準計測（M0・手順1）の後に決定し、固定:

- **目標: フルe2e（`npm run test:e2e`・全プロジェクト）の中央値 ≤ 6.0分**（M0基準14.8分から≥59%削減）
- **結果: 達成。基準中央値14.8分 → 最終中央値（M3′）5.7分＝−61.5%（2.60倍）。skip件数3→0・業務の実行件数122→73**（docs/16 T085b状態欄が参照する数字）。
- **所要時間の正はPlaywright報告値**で測る（壁時間には試験後のwebServer停止滞留等の環境事象が混入し得る。M3 run3は報告6.2分に対し壁時間38分＝停止滞留。詳細は下記）。

| 計測 | コード | 条件 | 所要時間（Playwright報告値・3回） | 合算結果（フル合算＝業務＋acceptance） | 業務の内訳 |
|---|---|---|---|---|---|
| M0 基準 | 0d21ca3 | workers=1・全プロジェクト | 15.5 / 14.8 / 14.8 分 → **中央値 14.8分** | 193p/1f/3s（3回とも） | **118p/3s/1f**＝既知フレーキー1件/回（run1 documents〔FLAKE-1〕、run2・3 reports〔FLAKE-2a〕）。acceptance 75p |
| M1 赤 | 0d21ca3 | --workers=2 | 8.6分 | 192p/**2f**/3s | **117p/2f/3s**＝試験間干渉（一覧は下記）。acceptance 75p |
| M2 分離後 | 69279d7 | --workers=2 | 9.3 / 9.1 / 9.3 分 → **中央値 9.3分** | 121p/3s＋acceptance 73f（3回とも） | **119p/3s/0f**（フレーキー0）。acceptance 2p/73f＝codeHash赤（設計どおり・69279d7でtests/が変わったため） |
| M3 絞り込み後 | 68b5328 | workers=2（設定既定） | 6.2 / 6.1 / 6.2 分 → **中央値 6.2分** | 74p/74f・75p/73f・74p/74f | 業務はrun1・run3に1fずつ（下記「M3の失敗2件」）・run2は**73p/0f/0s**。acceptance 2p/73f。**目標超過** |
| **M3′ 安定化後（最終）** | 4ad6883 | workers=2（設定既定） | **5.7 / 5.8 / 5.6 分 → 中央値 5.7分** | **75p ×3（業務失敗0）** | **業務 73p/0f/0s ×3**。acceptance 2p/73f＝codeHash赤（設計どおり） |

- M3とM3′で試験構成は同一（業務73＋acceptance合格2）のため、両者の所要差（約0.4〜0.5分）は環境の揺らぎの範囲（fix round 1は赤の吸収が目的で、時間を短縮する機構を含まない）。

### M1赤の干渉一覧（実ログ t085b-workers2.log と1行ずつ突き合わせ。手順2で解消済み）

1. activities.spec `proxy_answer_form_resets_after_save_and_leaves_without_warning`（desktop）— D05承認フロー未実装のための `wrangler d1 execute` による直接seedが、稼働中のwrangler dev（workerd）と同じD1を取り合い **SQLITE_BUSY** で失敗（ログに `✘ [ERROR] database is locked: SQLITE_BUSY`）→ 69279d7で有界再試行ヘルパ（`seedProxyScope`）へ。
2. inspection.spec `inspection_form_preserves_values_after_failed_submission`（phone）— `page.route` の遮断が並行負荷で保存POSTのfetchを取り逃がし、遮断したはずの保存が201で通る（error-contextは遷移後の施設詳細）→ 69279d7で `context.setOffline` による文脈ごとの通信断へ構造化（Fetchの取り逃がしが構造的に起きない）。

いずれも69279d7で試験側のみ解消（業務コード無変更）。

### M3の失敗2件と安定化（fix round 1・4ad6883）

- **run1: issues.spec（desktop）** — wrangler 4.150 のProxyWorker→UserWorker接続のkj keep-alive約5秒境界で、awaited PATCH が "Network connection lost" で喪失（GET/HEADは即時+250ms再試行で吸収＝"recovered on attempt 2" の正体。PATCH/POSTは非冪等のため再試行されず当該要求だけ失敗。cloudflare/workers-sdk #14926 等。同種ログはbaseline/M2にも〜1回/回で既存）→ `tests/e2e/helpers.ts` に**署名限定**（4xx・無署名5xxは再送しない）・有界3回・**同一冪等鍵で再送**する `clickUntilWriteArrives` を新設し、issues.specの全書き込み6箇所とdocuments.specの作成押下へ適用（鍵の再利用は製品側 useMutation.ts:60-76・execute.ts:220 で同一内容1回だけ適用が担保される（状態錯誤は:236-237/:278で拒否））。
- **run3: facility-location.spec（desktop）** — `popup.url()` の直後読みが about:blank（遷移Commit前）で null になる実発火（review r0で繰り延べたMinor）→ popupの**最初の要求イベント**（送出時・Commit不要）を待って `isNavigationRequest` と要求URLのdestinationで断言する形へ置換。
- **run3の壁時間38分** — 試験後のwebServer停止滞留（Playwright 1.64はgracefulShutdown無指定時、子processのcloseを無制限に待つ。workerdの子孫がstdioパイプを掴むとcloseが来ない）。以後の4走行（焦点2・暫定spec・フル1）とM3′3走行では壁時間≈報告時間で**未再現＝経過観察**。
- **残存クラス（既知として記録）**: 上記2spec以外の待ち合わせた書き込み（通知承認POST・出欠回答・実績保存等）にも同型の落下が稀（〜1/3走行・大半はGET自動回復で無害）に起き得る。署名・頻度・切り分け手順は task-85b-report.md「fix round 1」のとおり。被害試験を `clickUntilWriteArrives` で包むのが常設対処。
- 補足: acceptance（受入ゲート）はM0・M1では75p（当時の証跡indexと一致＝緑）、69279d7でtests/が変わって以降（M2〜M3′）はcodeHash不一致で2p/73f＝赤（設計どおり・collect:evidence再実行待ち）。acceptance自体の実行は約9.4〜12.1秒（実ログ実測）で所要への寄与は小さい。

## 負荷の係数（本タスクの検証走行の読み方）

検証走行時、同一マシンで利用者の別プロジェクトのwrangler dev＋試験が稼働していた。M2証跡（docs/evidence/acceptance-index.json）の各試験時間と本タスク検証走行の同じ試験を比較すると**中央値で1.10倍**（最大2.04倍・n=66）。本ページの実測値は静かな環境では約0.9倍に縮む。

## 候補①〜⑤の計測と採否

| 候補 | 計測値 | 採否 |
|---|---|---|
| ①smokeセット | `npm run test:e2e:smoke`（setup＋auth4＋journeys4＋shell3＝12試験・desktop-1280）: **65秒 / 53秒 / 52秒 → 中央値53秒・3回とも緑** | **採用**。開発中の反復用。フルe2eの代わりにしない（AGENTS.mdに明記） |
| ②幅の絞り込み | 業務の実行数 122件（119p＋3s）→ **73件（73p/0s）**（−49件・−40%）。M2証跡の試験別時間からの業務合計は 875秒→572秒（−35%） | **採用**（仕分け表は下記。マーカー`// 幅:`が正本で、scripts/e2e-width-triage.ts が設定へ反映。マーカーと宣言数が崩れると設定の読み込みが落ちる） |
| ③workers≥2 | M1赤（干渉2件）→ 分離後にM2で3回緑。前提: 試験ごとの架空データ分離（69279d7）・共有D1前提の監査・直接seedのSQLITE_BUSYを限定再試行で吸収 | **採用**（`workers: 2` を設定に既定化。setup依存は維持＝検証走行で全試験が管理者セッションを使用） |
| ④tablet-768の統合 | 単独実行（webServer起動込み）**78秒**（6試験）。フル走行内の実時間 **61.9秒→59.5秒**（絞り込み後）。T083実機matrix由来の5試験のうち3試験は768幅で意味を持たない（下記） | **維持＋絞り込み**（統合・廃止せず）。`@tablet-768` のmanifest参照が指す2試験（returning_user / revisit_core_flows）だけ768で実行。accessibility残り3試験は除外: inputs_stay は試験自身が240/200pxへ幅を変える（768の起点幅は無関係）・date_inputs は幅非依存のCSS断言・analytics_conditions はチップ幅406px未満でしか起きない回帰（768では恒真。406px未満でしか起きない回帰の性質上、はみ出しは幅について単調。768実測でなく360実測と単調性からの推論） |
| ⑤起動時ビルドの省略 | `npm run build` 3回: **0.88秒 / 約1秒 / 約1秒**（vite 8・313モジュール。再計測×3では **0.78〜0.89秒**＝t085b-smoke-build-timing.log）。`scripts/e2e-prepare.ts`（D1再作成+migration）: **12.5秒** | **不採用**。削減効果が約1秒で存在せず、古い成果物を試験する危険と 新規判定ロジック（mtime比較）の複雑さだけが残る。prepareの12.5秒（約2%）も、毎回のD1再作成が試験間分離の基礎（状態の持ち越しを構造的に断つ）のため維持 |

## 絞り込み後の内訳と検証走行（負荷あり・ポート8798）

| 走行 | コマンド | 所要 | 結果 |
|---|---|---|---|
| 全プロジェクト | `npm run test:e2e -- --workers=2` | **403秒（6.7分）** | 業務 **73p/0f/0s**＋acceptance 2p/73f（codeHash不一致＝設計どおり） |
| 業務のみ（CIと同じ4プロジェクト指定） | `npm run test:e2e -- --project=setup --project=phone-360 --project=desktop-1280 --project=tablet-768 --workers=2` | **343秒（5.7分）** | **73 passed / 0 failed / 0 skipped** |
| smoke ×3 | `npm run test:e2e:smoke` | 65 / 53 / 52秒（負荷あり・実装者計測）。**静かな環境での再計測×3は 46.0〜47.3秒・12 passed×3**（t085b-smoke-run{1,2,3}.log） | 12 passed ×3（計6回） |

- プロジェクト別の試験数: setup 1 / phone-360 **17**（両幅12＋phone限定5）/ desktop-1280 **53**（両幅12＋desktop限定41）/ tablet-768 **2** / acceptance 75。（T086追記: PH4-B2のe2e 1件〔desktop限定〕を追加したため、現在は**全59試験・desktop-1280 54・業務の実行は74件**。上の仕分け表が正）（T086追記2: SHELL-HELP使い方ガイド画面の実装でe2e 1件〔desktop限定〕を追加したため、現在は**全60試験・desktop-1280 55・業務の実行は75件**。上の仕分け表が正）
- skip件数は **3→0**（旧・本文内 `test.skip(!isPhone)` 3件〔shell mobile_menu・member-admin ai_evaluation・assistant touch targets〕を設定側の phone限定仕分けへ移行。断言の意味は不変。manifestの該当knownSkips 3件を刈り取り）。
- M3（コントローラ計測・静かな環境）は中央値**6.2分**で目標超過、fix round 1（4ad6883）を挟んだM3′で中央値**5.7分**となり**目標≤6.0分を達成**（上の表・M3の失敗2件の節を参照）。実装時の予測は「5.3〜6.1分（負荷係数0.9〜1.1）」で、M3は予測上限を僅かに超え（+0.1分）、M3′は範囲内に収まった（予測値自体は結果を見て書き換えていない）。

## 実装の要点（Playwrightのgrep仕様）

プロジェクトごとの除外は `grepInvert` で行う。**Playwrightのgrepは「プロジェクト名＋試験タイトル（＋タグ）」を空白結合した文字列にmatchさせる**ため、`^タイトル$` の全面アンカーは前方のプロジェクト名に当たって除外が効かない（本タスクで実測・確認済み）。`scripts/e2e-width-triage.ts` は `(?:^|\s)タイトル(?:\s|$)` の境界つき並びを生成する。新規試験を追加するときは `// 幅:` マーカーを必ず付ける（無いと設定の読み込みが例外で落ちる＝静かな全幅復帰を防ぐ）。

## manifestへの反映（check:coverage緑・2026-10-20）

- 絞り込みで実行プロジェクトが減った全参照に `@プロジェクト` を付与: **@desktop-1280 154件・@phone-360 3件**（R14: 参照は実際に走るプロジェクトで合格を要求する）。
- 既存のプロジェクト指定参照はすべて維持: `ai_evaluation_buttons_meet_touch_target_on_mobile@phone-360` / `returning_user_finishes_inspection_and_attendance_without_hidden_controls@tablet-768` / `revisit_core_flows_complete_in_few_operations_after_relogin@tablet-768`。
- knownSkips 3件 → 0件（本文内skipの廃止に伴う）。
- `npm run check:coverage` 緑（参照テスト272件）。

## 幅の仕分け表（全60試験・マーカーと1対1。T086で2件追加）

判定の基準: **断言の対象になる**isPhone分岐・幅依存の断言（押下領域44px・ボトムナビ/サイドバーの構成・scrollWidth/はみ出し・viewport固有の可視性・prototypeの寸法）を持つ試験は**両方**（または幅固有なら**phone限定**）。描画待ちの見出しレベル・語彙の吸収など**断言の対象でない**isPhone分岐だけを持つ試験と、純粋な流れ・API-through-UI・データ断言の試験は**desktop限定**（シェル構成自体の幅差はshell.specが両幅で担保）。データ量に依存する試験の絞り込みは行っていない（accessibilityの狭幅回帰は長い名前の団員を自前でseed・assistantのnewest-5系は対象外のため影響なし）。
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
| journeys.spec.ts | `journey_offline_correction_conflict_recovery` | desktop限定 | 幅で変わる断言なし（流れ・データの断言）。isPhone分岐は描画待ちの見出しレベルの吸収のみで断言対象外 |
| member-admin.spec.ts | `stop_requires_reason_and_preserves_member_history` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| member-admin.spec.ts | `keyboard_only_can_filter_open_and_close_the_member_drawer` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| member-admin.spec.ts | `unsaved_input_is_confirmed_before_closing_and_conflicts_and_revocations_are_shown` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| notifications.spec.ts | `notification_ui_distinguishes_accepted_unknown_and_read` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| notifications.spec.ts | `notification_approval_shows_conflict_when_already_approved_elsewhere` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| notifications.spec.ts | `pending_draft_appears_in_sent_list_and_can_be_resumed_to_send` | desktop限定 | 幅で変わる断言なし（流れ・データの断言）。T086 PH4-B2（「送信した通知」切替と未承認draftの再開）で追加 |
| offline-account-switch.spec.ts | `account_switch_never_leaves_or_shows_another_users_offline_draft` | desktop限定 | 幅で変わる断言なし（流れ・データの断言）。isPhone分岐は描画待ちの見出しレベルの吸収のみで断言対象外 |
| offline-sync.spec.ts | `offline_conflict_never_uses_last_write_wins` | desktop限定 | 幅で変わる断言なし（流れ・データの断言）。isPhone分岐は描画待ちの見出しレベルの吸収のみで断言対象外 |
| patrol-plans.spec.ts | `patrol_ui_completes_draft_order_and_human_confirm_without_auto_dispatch` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| pwa-cache.spec.ts | `offline_cache_contains_no_api_response_or_google_tiles` | desktop限定 | 幅で変わる断言なし（流れ・データの断言）。isPhone分岐は描画待ちの見出しレベルの吸収のみで断言対象外。phone幅見出し語彙（マップ・団員名簿・お知らせ）はdesktop限定化で断言先が無い＝将来この語彙を変えるときは phone幅の確認を別途入れる |
| pwa-cache.spec.ts | `sw_update_notifies_and_does_not_destroy_unsaved_input` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| realtime.spec.ts | `incident_detail_receives_remote_updates_and_resyncs_after_role_change` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| reports.spec.ts | `report_ui_shows_missing_fields_and_only_exports_approved_version` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| shell.spec.ts | `api_paths_return_json_never_the_spa` | desktop限定 | 幅で変わる断言なし（流れ・データの断言） |
| shell.spec.ts | `help_screen_shows_concise_guide_chapters_without_placeholder` | desktop限定 | 幅で変わる断言なし（章見出し・プレースホルダー不在の内容断言）。T086 SHELL-HELP実装で追加 |

## 正直な記録

- 初回の検証走行（1回目）は `grepInvert` の正規表現を `^タイトル$` で全面アンカーしたため**除外が一切効かず**、phone 58件・desktop 58件が走ってphone限定3試験がdesktopで失敗した（skip撤去済みのため実行されて赤）。上記のgrep仕様の確認後に境界つき正規表現へ修正し、再走行で業務73件緑・skip 0を確認した。失敗走行のログは破棄していない（.superpowers/sdd/16_実装タスク一覧/e2e-verify.log に保全）。
- 補助数値の証跡: 検証走行（403秒/343秒・負荷係数1.10倍 n=66・初回grep失敗走行）は実装者の検証走行で、生ログは .superpowers/sdd/16_実装タスク一覧/e2e-verify.log に保存済み。smoke・buildの静かな環境での再計測の生ログは同フォルダの t085b-smoke-run{1,2,3}.log と t085b-smoke-build-timing.log。
- 残作業: documents「題名消失」の根因（引き金）は未特定（回復ループで抑止）。ProxyWorkerドロップの残存クラスとwebServer停止滞留の経過観察は「M3の失敗2件と安定化」節のとおり（manifest issues台帳のT085b-W1〔owner=T086〕も参照）。
- 実装時の予測は「静かな環境で5.3〜6.1分・境界付近」で**この時点では達成を主張しない**と記録した。実際、M3（コントローラ計測・静かな環境）は中央値**6.2分で目標超過**（失敗2件と停止滞留1回を含む）。fix round 1（4ad6883・安定化）を挟んだM3′で中央値**5.7分・3回とも業務0f**となり目標達成。予測を実測で確定させた（予測値の書き換えはしていない）。
- 検証走行（403秒/343秒）は並行負荷あり（負荷の係数参照）。コントローラ計測のM3・M3′（静かな環境・Playwright報告値）が正である。
- tablet-768の残り2試験（returning_user・revisit_core_flows）はmanifestの@tablet-768参照が要求する768幅の証拠であり、削除すれば更に約30秒（wall）稼げるが**T083実機matrixの768証拠を失う**ため維持した（採否表④）。
- fix round 2（本改訂）: M1赤の一覧を実ログ（t085b-workers2.log）と1行ずつ突き合わせて修正（旧記載の「realtimeの混線」は誤りだった）・件数の帰属をフル合算/業務で明示（M0の「193p」はフル合算、業務は118p/3s/1f）・仕分け基準文を「断言の対象になるisPhone分岐」に精密化しdesktop限定4件（offline-sync・offline-account-switch・journeysの見出し分岐・pwa-cacheの見出し分岐）に注記・triage scriptに孤立マーカーのtripwireを追加（file:line付き）。
