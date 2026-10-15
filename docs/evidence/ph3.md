# PH3 実行証跡（2026-10-15）

対象: T035〜T047（活動・出欠・実績・履歴検索・活動画面・出動・参集・使用履歴・operation統合・出動画面・お知らせ・お知らせ画面・ホーム）。実行環境はローカル（Node v26 / workerd / wrangler 4.x / vitest / Playwright chromium）。**実Cloudflareアカウント・実D1・実R2・実Google Mapsは使っていない（wrangler未ログイン）。** D1はwranglerのローカルシミュレータ。migrationは0015〜0019（activities/activity_actual_participants/incidents/resource_usages/announcements。docs/14 D23）を空DBから適用（各試験実行時に自動）。データはすべて架空。

## 実行結果
| 確認 | コマンド | 結果 |
|---|---|---|
| 型検査 | `npm run typecheck` | 成功 |
| 契約検査 | `npm run check:contracts` | 101 API / docs/05 101行 / OpenAPI一致 |
| 単体・結合試験 | `npx vitest --run` | 32ファイル178件成功（workers＝実workerd＋D1/R2/Queues、client＝jsdom） |
| ブラウザ試験 | `npx playwright test` | 52件成功＋1件スキップ（メニュータブはスマホ幅のみ＝shell.specのPC幅除外。PH2と同じ）。phone-360 / desktop-1280 の両プロジェクトで実行 |
| ビルド | `npm run build` | 成功 |
| 実環境の試験 | `npm run test:live` | **未実施（環境未設定。PH2と同じ扱い）** |

## タスク別の指定試験
T035 `activity_cancellation_preserves_answers_and_audience` / T036 `old_attendance_retry_cannot_undo_later_answer` / T037 `actual_participants_do_not_follow_planned_attendance` / T038 `history_filters_actual_participants_and_half_open_time_range` / T039 `planned_answer_and_actual_presence_have_separate_labels`（実ブラウザ×2幅）/ T040 `incident_kind_is_separate_from_status_and_never_dispatches` / T041 `returned_status_preserves_unknown_arrival_time` / T042 `usage_replacement_cancels_missing_rows_without_reducing_stock`＋`usage_history_is_reachable_from_assets_and_shared_with_activities` / T043 `link_locks_both_roots_and_preserves_all_resource_usages` / T044 `incident_detail_traces_activity_vehicle_and_equipment`（実ブラウザ×2幅）/ T045 `read_receipt_is_bound_to_member_and_revision` / T046 `edited_announcement_requires_new_read`（実ブラウザ×2幅）＋`announcement_response_carries_author_my_read_state_and_linked_attachments`（T046の契約追加分。workers）/ T047 `dashboard_counts_match_authorized_drilldown_lists`（workers）＋`home_metrics_drill_down_to_matching_lists`（実ブラウザ×2幅）— すべて成功。

## 赤→緑の扱い（正直な記録）
- **13タスクの全報告書（.superpowers/sdd/16_実装タスク一覧/task-35〜47-report.md）に、実装前に指定試験を実行してFAILすることを確認した記録が残っている。** 赤の根拠はすべて「対象機能の未実装」で、runner故障や構文エラーではない: T035/T037/T038/T040/T043/T045/T047（workers）は未接続routeのJSON 404（`expected 404 to be 201/200`）、T036/T041は未接続routeの404、T042はAPI-22がresourceUsages入力を破棄することに起因する空配列assertion、T039/T044/T046/T047（e2e）は未実装プレースホルダー（入口・対象要素が見つからないFAIL。T044/T047は両プロジェクト）。試験バグによるFAILを赤と誤認したケースは1件あり（T047。1回目の赤は試験側のAPI-16呼び出しが400になっただけ。報告書に「赤の根拠にしない」と記録）、修正後の赤を取り直している。
- **PH2のような体系だった変異確認（防御を外して試験が失敗することの確認）はタスク毎には実施していない。** 実施済みなのはT037のみ（報告書に「ガード弱体化の変異で試験が落ちることを確認」と記録）。**変異確認は、レビューサイクルで確認済み指摘の修正に対して実施する予定**（PH2と同じく、修正を戻せば指摘の発生条件をそのまま試験にしたものが失敗する形で確認する）。
- versionガード・冪等再送・原子性（batch途中失敗で部分成功0）は、各タスクの試験が同版並行（一方だけ成功・他方409）、同キー再送（保存済み応答の返却）、失敗注入（T043はbatch内失敗で全取消をsnapshot一致で検証）のケースを実装の中で持っており、赤→緑の指定試験とあわせて実行されている。

## 試験が検出した（または発覚した）欠陥と弱さ
- **実装側の欠陥が試験で検出・修正された記録は報告書に無い**（上記のとおり赤は未実装機能の確認で、実装後のFAIL→修正の往復は無い）。
- **試験側の問題を緑に至る過程で修正した記録**: T039は①URL正規表現が遷移前の`new`にも一致（`(?!new)`に厳密化）②完了表示の文面がトーストとstrict衝突（UI文面を変更）③スマホでフォーム下端の保存ボタンが固定ナビに半分隠れ座標クリックが不安定（focus+Enterのキーボード保存に変更。docs/03 §1に記録）。T046は「お知らせ」リンクのstrict violationを`#main`スコープで解消。T047は期待値をAPI-28の事前読み取りで取る形にした（他試験が同じunitにseedしても成立する形）。
- **既存の弱さ（PH3で新規に発覚したが対応しない）**: ①inspection-templates.specのタイミング試験が中間のフル実行でphone-360のみ1回落ちた（トースト表示直後の`textContent`評価のレース。クリーン木と最終フル実行ではPASS。T047報告書。本タスクで触っていない画面のため未対応＝必要なら別タスクで整備）②IssuesPageの状態チップ件数は1ページ目（既定limit50）から数えるT034の既存設計で、dashboardの件数（全件COUNT）と50件超のunitで下回り得る（T047報告書。試験のunitは上限以下）。

## 未実施・未接続（検証済みとして扱わない）
- **V01/V02/V05の実環境検証はPH2から継続で未実施**: 実Cloudflare・実Workers・実R2・実Google Maps（APIキー未取得。地図面はprototypeと同じプレースホルダー縮退。docs/14 D22）。`npm run test:live`も未実施。GitHub Actions・実Cloudflare D1/R2/Queues/CronはPH0から継続で未接続。
- **実端末（iOS/Android）・スクリーンリーダー・200%拡大は未確認（T083）**。
- **ホームの未接続指標**: 点検期限はinspection_schedulesが未実装のため**T048でデータ接続**、通知・自分タスク（API-67/68）は**PH4**。3指標とも`connected=false`＋画面は「未接続」表示で0件と区別（docs/16 T047）。
- **お知らせの単一件GETは無い**: 詳細はAPI-24一覧のページ送りで探索し20ページ（200件/ページ）で打切り。それを超える一覧では対象者が自分の既読対象を開けない（T046報告書の懸念。GET /announcements/:idの追加は契約変更として未実施）。
- **publishedのお知らせは対象者だけが一覧に現れる**: 対象外のPER-03保持者は**自分が作った公開済を一覧から開けない**（単一件GETも無い）。作成者が自分を対象に入れる運用で回避（T045/T046報告書の懸念。管理視点の一覧取得のquery追加は未実施。docs/03 §1.1の11・docs/14 D23）。
- **相互導線の`/app/incidents?activity=`はクライアント絞り込み**: API-21にactivityId絞り込みが無いため全ページ読み切り（上限40ページで打ち切り表示）。母数が大きくなるとAPI側の絞り込み追加が望ましい（T044報告書の懸念。docs/03 §1.1の10）。
- **資産→元記録の戻りは`?from=`依存**: operationIdから元の活動/出動を逆引きするAPIが無く、直接URLで資産詳細を開いた場合は戻りリンクが出ない（T044報告書の懸念。壊れないだけ）。
- **担当scope保持者の操作ボタンが出ない可能性**: 代理回答・実績入力・予定編集等のボタン出し分けはroles（幹部/管理者）基準で、担当(scope)のみの保持者はボタン非表示の可能性がある（操作自体はサーバーが認可し、403の案内は出る。T039報告書の懸念。scopeの取得手段ができた時点で見直し）。
- **冪等再送と状態前提の検査順の残る課疑（報告書の懸念。未修正）**: ①API-69（T040）は状態前提をroute内で先に検査するため、遷移済み後の同キー再送がdocs/05 §2どおりの保存済み応答でなく422になり得る（T041報告書）②API-22でactivityId付きリクエストの同キー再送は、T040のactivityId検査（リンク済み409）が再送解決より先に走り409になり得る潜在（T042報告書。resourceUsages経路は解消済み）。いずれも再現試験は無し（要確認）。
- **voided出動への参集書込は検査していない**: docs/11に出動statusと参集書込の関係の規定が無く、API-23は出動statusを見ていない（閉じた出動への事後入力を許す判断。D08で方針が決まれば見直し。T041報告書）。
- **同時リンク競合の409の種別は分かれ得る**: 先行リンクがactivities行の版を進めた場合、diagnoseのroot判定が先に競合を検出すると409 DUPLICATEでなく409 VERSION_CONFLICTになる（どちらもdocs/05 §1の409。順次実行の競合リンクは必ずDUPLICATE。T043報告書）。
- お知らせの通知依頼（outbox/監査の通知起因行）は作らない＝PH4で接続（T045。implicitBroadcastCount=0を試験で確認）。出動命令の自動発行も無し（T040。docs/11・D08）。

## prototype準拠
実ブラウザ試験が通った画面: 活動（SCR-08週ストリップ＋「これから/終了した活動」グループ・SCR-09情報カード＋出欠3択（選択時の塗り＋1.5px枠）・SCR-10/実績フォームは共通部品構成）、出動（SCR-11/22/12。prototypeに出動モードのデモとメニュータイルしか無いため共通部品で構成し、赤テーマの語彙と「現場の指揮は団長・消防署の指示に従ってください」の注記を全画面で常時表示）、お知らせ（SCR-16。prototypeは予告ページのため共通部品構成。語彙と行の見た目はprototypeホームのお知らせ欄から採用）、ホーム（SCR-02。ダイヤル（参加=橙・未定=黄・未回答=灰の円グラフ）・出欠枠・やることカード・お知らせ欄・AIバーの構成とトークン）。トークン（背景#08101C・Ember#FF5A2E等）と44px押下領域は既存共通UIどおり。実端末・スクリーンリーダーはT083で未確認。prototypeから意図して変えた点はdocs/03 §1.1の9〜12に理由つきで記録（活動: 一覧の出欠ピルを開催状態ピルで代用、PC併置を遷移方式に、参加者チップに回答語を併記、持ち物行なし、状態操作を詳細に追加、AI報告書CTA非表示。出動: 種別と状態を別文字で区分、参集・帰還は固定語彙「参集中/参集済/帰還記録/出動不可」、時刻3つとも任意で未知を捏造しない、相互導線はクライアント絞り込み、API-07/70の応答拡張。お知らせ: 応答Announcementへの3列追加、publishedは対象者だけ、旧版本文・既読履歴・既読件数は非表示、添付は詳細画面から、通知依頼は無効表示、SCR-16を単一画面の別入口に。ホーム: ダイヤルの押下先を「これからの予定」の一覧に、クイック回答をSCR-09への誘導に、未接続指標は「未接続」表示、PCのKPIの未接続部分を出さない、h2「ホーム」見出しを残す）。
