# PH0 レビュー・修正サイクルの記録

対象: PH0（T001〜T006）の差分 `22403be..HEAD` と関連docs。レビューは独立したサブエージェント4体（読み取りのみ、ファイル変更なし）が並行して実施した。指摘はメインのエージェントがコード・試験・実行結果で検証してから修正した（指摘をそのまま適用しない）。

分類: **確認済み**（欠陥を再現または読解で確定）／**誤り**／**対象外**（後続タスクの範囲。理由と担当を記録）／**方針で残す**（設計上の限界を明記）。

## 第1回（2026-10-13）

依頼した観点と範囲:
- A 正確さ・セキュリティ（src/scripts/drizzle/tests/wrangler）… 14件
- B docs/16の完了条件と試験の妥当性 … 15件
- C prototype準拠（シェル・共通UIとprototype HTMLの数値比較）… 18件
- D docsと実装の整合 … 17件

### A 正確さ・セキュリティ

| ID | 重大度 | 分類 | 対応 |
|---|---|---|---|
| A-F1 状態不一致・業務UNIQUEが500→利用者に「再送可」と表示 | 中 | 確認済み | diagnoseに422 INVALID_TRANSITION / 409 DUPLICATE を追加（第2回でエラー文からの推測をやめ、操作の宣言 allowedStates / duplicateTables による判定に変更）。試験 `matching_version_but_wrong_state_is_invalid_transition_not_500` / `business_unique_violation_is_duplicate_not_500` |
| A-F2 conditionsの評価時点がbatch内と失敗判定で不一致 | 中 | 確認済み | 前提条件として業務書込の前に評価するよう移動。試験 `conditions_are_preconditions_evaluated_before_the_writes` |
| A-F3 INSERT OR REPLACEで追記専用表を上書きできる | 中 | 確認済み（D1でも再現） | drizzle/0003 で衝突するINSERTを拒否するトリガー。試験 `append_only_tables_cannot_be_overwritten_with_insert_or_replace` |
| A-F4 結果不明→401で鍵を捨て二重登録 | 中 | 確認済み | 確定拒否(400/403/404/409/422)まで鍵を保持。試験 `the_key_survives_401_after_an_unknown_result_so_a_retry_cannot_double_register` |
| A-F5 日時の文字列比較が精度差で逆転／DB形式と不一致 | 中 | 確認済み | Instantをミリ秒3桁Zへ正規化。試験 `instants_are_normalized_before_comparison_and_ids_must_be_lowercase` |
| A-F6 content-lengthなし本文を全量読み込み | 中 | 確認済み | 逐次読みで上限超過時に打ち切り。試験 `chunked_body_without_content_length_is_cut_at_the_limit` |
| A-F7 タイムアウト後もhandlerが動き外部効果が二重になり得る | 低 | 方針で残す | 外部効果の一回性はhandlerの責務と docs/02・docs/16・runner.ts に明記（Workersでは処理を中断できない） |
| A-F8 errorCode/resultRefがCHECK違反でループ停止・内部文の露出 | 低 | 確認済み | コード形式の検証と置換（試験 `handler_error_codes_are_sanitized_and_dedupe_does_not_cross_units`）、確定失敗でもループ継続（第2回で試験 `one_failing_completion_does_not_stop_the_rest_of_the_run` を追加） |
| A-F9 dedupeで他の依頼者/他unitのjobが返る | 低 | 一部確認済み | unitをまたぐ返却を禁止（同上の試験）。同unit内の別依頼者の照会権限はPH4（通知/AI）で判断＝対象外 |
| A-F10 `/api`（末尾スラッシュなし）がSPAに渡る | 低 | 確認済み（Bが実測） | `run_worker_first=["/api","/api/*"]`。e2e `api_paths_return_json_never_the_spa` |
| A-F11 契約に無いquery/本文を無視、Content-Type未検査 | 低 | 確認済み | 拒否に変更、本文はapplication/json必須（試験 `parseApiRequest_validates_params_body_and_headers`）。本文の契約が無いAPIはGETとバイナリだけで、GETはfetchの仕様上本文を持てないため、未知queryの拒否のみ試験（`requests_without_query_contract_reject_unknown_query`、第2回で名前を実態に合わせた） |
| A-F12 大文字UUIDを受理 | 低 | 確認済み | 小文字UUIDのみ（同上の試験） |
| A-F13 試験用なりすましの防御が環境変数のみ、unit停止を未確認 | 低 | 一部確認済み | 分団停止も拒否（`test_identity_injection_is_ignored_outside_local_test_mode`）。本物の認証はT007/T008で置換＝対象外。`--env`なしdeployをしない運用はT078で手順化 |
| A-F14 apiCallでAPI-83（x-upload-token）を送れない | 低 | 対象外 | 添付アップロードはT015で実装時に対応 |

### B 完了条件・試験

| ID | 重大度 | 分類 | 対応 |
|---|---|---|---|
| B-F01 契約検査が成功statusを照合しない | 中 | 確認済み | docs/05の成功欄の202/204と台帳を照合（`src/shared/contracts/doc-check.ts`）。試験 `doc_check_detects_success_status_drift_between_docs_and_registry` |
| B-F02 基盤側の文で障害注入していない | 中 | 確認済み | 監査/event/応答SQLの失敗を注入。試験 `failures_in_infrastructure_statements_also_roll_back_everything` |
| B-F03 PII防止が大きさ制限だけ | 中 | 一部確認済み | 文字列をID・コード形式に限定（氏名・本文を拒否）。値の意味までは判定できないため、項目設計の責務として残す |
| B-F04 CT-03/04の不足（実更新後の旧版再送、担当解除） | 中 | 一部確認済み | 実更新後の旧版再送を追加（`resending_an_old_base_version_with_a_new_key_after_a_real_update_conflicts`）。担当/役割解除の即時反映はT008（最新認可）＝対象外 |
| B-F05 変異確認のコマンド/出力が未記録 | 中 | 確認済み | 本書「変異による検出確認」に記録 |
| B-F06 `/api`・`/API/v1` がHTML | 中 | 一部確認済み | `/api`は修正（A-F10）。`/API/...`（大文字）はAPIの経路ではなく画面のURLとして扱う（大文字小文字を区別する）＝誤り |
| B-F07 試験名「効果が二重にならない」とhandler副作用の不一致 | 中 | 方針で残す | 確定の一回性のみを保証し、外部効果はhandlerの責務と明記（A-F7） |
| B-F08 jobCount/activeLeaseCountが常に成り立つ | 低〜中 | 確認済み | 取得した作業権のtokenがDBの値と一致することを追加で検査 |
| B-F09 指定試験に503/focusedFieldが無い | 低 | 確認済み | `accepted_job_and_conflict_are_not_saved_success` に追加 |
| B-F10 docs/16のT001欄と証跡の矛盾、e2eが証跡画像を上書き | 低 | 確認済み | 状態欄を修正、画像は `SAVE_EVIDENCE=1` の時だけ保存 |
| B-F11 docs/05/11を独立に転記していない | 低 | 一部確認済み | method/pathと、成功statusのうち202/204の有無（「202可」は200も）を自動照合（200と201の区別は照合しない）。状態辞書の自動照合は、11の書式が文章のため後続（T078のCI拡張）で検討 |
| B-F12 拒否理由を区別していない／索引の確認なし | 低 | 確認済み（**既存試験が別理由で通っていた**） | T003の指定試験の別unit挿入が実はUNIQUE違反で失敗していた。データを直しFK/UNIQUE/CHECKの理由まで検査。索引試験 `indexes_required_by_docs_04_exist` |
| B-F13 再送でMISMATCH/期限判定が認可より先 | 低 | 確認済み | 認可を最初に検査。試験 `replay_after_only_an_authz_version_bump_is_forbidden_before_revealing_mismatch` |
| B-F14 CIのNode版が未固定 | 低 | 確認済み | `.nvmrc`（26）とCIの`node-version-file`、CIにe2eを追加（CIは未実行のまま） |
| B-F15 dedupeに依頼者が入らない | 低 | 一部確認済み | A-F9と同じ |

### C prototype準拠

| ID | 重大度 | 分類 | 対応 |
|---|---|---|---|
| C-F01 実行中ボタンが灰色 | 中 | 確認済み | 主色のまま aria-disabled、gap10/15px |
| C-F02 副ボタン背景 | 中 | 確認済み | .08 / hover .12 |
| C-F03 無効ボタン | 中 | 確認済み | .08 / #7d889b / 15px |
| C-F04 状態チップの寸法 | 中 | 確認済み | 小（11px・4px 9px）と大（34px・13px・アイコン16px）、背景.14（異常.16、中立.08） |
| C-F05 Bannerの構造・配色 | 中 | 確認済み | Design Systemの状態ブロック（等幅小見出し→14px→12px/1.6、p20・角丸24） |
| C-F06 成功表示がトーストでない | 中 | 確認済み | `Toast`（明るい面、2.6秒、スマホ左右16px/PC下28px中央） |
| C-F07 全体の行間1.7 | 中 | 確認済み | body を normal、本文段落だけ個別に指定。見出しは1.3 |
| C-F08 PCの離脱確認モーダル | 中 | 確認済み | 560px・26px角丸・ぼかし幕・右寄せ46pxボタン・19px見出し |
| C-F09 スマホのシートに取っ手・光沢なし | 中 | 確認済み | 取っ手40×4、上端inset光沢、padding 12/20/34、gap 8 |
| C-F10 サイドバーのスクロール範囲 | 低 | 確認済み | prototypeどおりサイドバー全体をスクロール、下段は`mt-auto` |
| C-F11 PC本文の中央寄せ | 低 | 確認済み | `lg:mx-0`（左寄せ） |
| C-F12 スマホ本文の上余白 | 低 | 確認済み | 10px |
| C-F13 下部ナビのぼかし/終端色/重なり | 低 | 確認済み | blur16・.96・z50 |
| C-F14 未読の点/検索欄の枠 | 低 | 一部確認済み | 検索欄の枠.08。未読の点は件数データ接続時（docs/03に記載）＝対象外 |
| C-F15 docs/03の「橙14%」 | 低 | 確認済み | 18%に修正 |
| C-F16 サイドバーの件数バッジ | 低 | 対象外 | データ接続時に表示とdocs/03へ明記 |
| C-F17 ロゴの中心点/ログアウト文字 | 低 | 確認済み | 32pxで5px、ログアウト14px・.05 |
| C-F18 入力のエラーアイコン/TextArea | 低 | 確認済み | 塗りなし17px、TextAreaは14px/1.7・resize-none（入力欄は16pxのまま） |

### D docs整合

| ID | 重大度 | 分類 | 対応 |
|---|---|---|---|
| D-F01 冪等レコードの期限切れ処理が無い | 高 | 確認済み | `expireIdempotencyRecords` をCronで実行。試験 `expired_idempotency_records_lose_their_response_body_but_keep_rejecting_the_key` |
| D-F02 docs/16冒頭が「全タスク未着手」 | 高 | 確認済み | PH0完了を反映 |
| D-F03 各文書の版行が「未実装」 | 高 | 確認済み | README/00/02/03/04/05/09を「PH0実装済み・業務機能は未実装」に |
| D-F04 docs/12が「全タスク未着手」 | 中 | 確認済み | 修正、NFR-05にAPI-86を追記 |
| D-F05 jobsが共通列規約の例外と未記載 | 中 | 確認済み | docs/04に例外を明記 |
| D-F06 元版/config版の再検査をrunnerがしない | 中 | 確認済み | handlerの責務と docs/02・docs/16 に明記 |
| D-F07 createDbにjobsが無い | 中 | 確認済み | `src/server/db/client.ts` に追加 |
| D-F08 API-86の権限がdocs/10に無い | 中 | 確認済み | docs/10に行を追加 |
| D-F09 期限切れキーの応答が未記載 | 中 | 確認済み | docs/05 §1に追記 |
| D-F10 /app/menu・/app/help がdocs/03に無い | 中 | 確認済み | docs/03 §1.1に追記 |
| D-F11 T001状態欄とe2e実行の矛盾 | 中 | 確認済み | B-F10と同じ |
| D-F12 T005の試験ファイル名/Files/件数 | 中 | 確認済み | .tsx・Files追加。件数は第2回でT002〜T006すべてレビュー後の実数に更新 |
| D-F13 T001/T006のInterfacesのずれ | 低 | 確認済み | 実装に合わせて更新、principal.tsを記載 |
| D-F14 batch順序の記述がdocs間で違う | 低 | 確認済み | docs/02 §4を実装順に |
| D-F15 staleの追加タスク・期限切れ時の扱い | 低 | 確認済み | docs/11を「T006」「上限到達でmanual_review」に |
| D-F16 通知承認の「未送分取消」の遷移 | 低 | 確認済み | 配送単位の取消と明記、承認全体の取消はT050で検討 |
| D-F17 D21・docs/02の記録漏れ | 低 | 確認済み | D21に認可表/ジョブ登録/レビュー修正を追記、docs/02にQueue設定と上限を追記 |
| 補足 created_by索引 | 低 | 確認済み | docs/04 §4 に「監査用のcreated_by列は除く」と明記 |

### 変異による検出確認（修正を1つずつ元に戻して試験を実行）

| 変異 | 失敗した試験 |
|---|---|
| M1 drizzle/0003（REPLACE防止）を外す | `append_only_tables_cannot_be_overwritten_with_insert_or_replace` |
| M2 再送で認可を後に確認 | `replay_after_only_an_authz_version_bump_is_forbidden_before_revealing_mismatch` |
| M3 状態不一致の422分類を外す | `matching_version_but_wrong_state_is_invalid_transition_not_500` |
| M4 401で鍵を捨てる（旧挙動） | `the_key_survives_401_after_an_unknown_result_so_a_retry_cannot_double_register` |
| M5 本文を全量読みしてから判定 | `chunked_body_without_content_length_is_cut_at_the_limit` |

PH0本体の変異確認（記録の補完、B-F05）: strict解除→`contract_registry_is_complete_and_strict`失敗／API-101削除→同失敗／root検査除去→`losing_update...`ほか3件失敗／再送時の認可再検査除去→`replay_rechecks...`失敗／lease期限条件除去→`a_late_runner...`失敗／lease token条件除去→`lease_expiry...`失敗／試験用認証の環境限定除去→`test_identity_injection...`失敗／202を「保存しました」表示→`accepted_job...`失敗／誤り欄フォーカス除去→`server_validation_error...`失敗／useMutationの二重送信防止除去→`useMutation_ignores_a_second_run...`失敗。いずれも修正を戻した後に全件成功を確認。

### 第1回修正後の実行結果
- `npx tsc --noEmit`: 成功
- `npm run check:contracts`: 101 API / docs/05 101行（成功status照合を含む）/ OpenAPI一致
- `npx vitest --run`: 6ファイル 84件成功
- `npm run build`: 成功
- `npm run test:e2e`: 7件成功＋1件スキップ

## 第2回（2026-10-14）

範囲: 第1回の修正差分 `16c024f..17ce7dd`。新しいサブエージェント3体（修正の正確さ／UIのprototype準拠／記録とdocsの検証）。第1回の確認済み指摘は、記録どおり実装・試験されていることが確認された（UIの18件はすべてprototypeの値と一致）。新たな指摘と対応:

| ID | 重大度 | 分類 | 対応 |
|---|---|---|---|
| UI-R2-01 成功トーストが2.6秒ごとに出直し消えない | 高 | 確認済み | 保存結果ごとに一度だけ表示、計測は表示時から一度。試験 `the_saved_toast_shows_once_and_disappears_after_2_6_seconds` |
| UI-R2-02 スマホのトースト位置 | 中 | 確認済み | 既定110px、画面ごとに指定可（prototype toastBottom） |
| UI-R2-03 実行中ボタンの影・縮み | 低 | 確認済み | 実行中は影なし・縮みなし |
| UI-R2-04 PCモーダルの主ボタンの影 | 低 | 確認済み | 影なし、副ボタンのhover変化なし |
| UI-R2-05 シート/モーダルの登場アニメ・幕クリック | 低 | 確認済み | fo-in、幕を押すと「編集に戻る」 |
| CODE-R2-1 401→ログイン画面でフォームが消え鍵も消える（第1回A-F4が画面では効かない） | 中 | 確認済み | 鍵を部品の外（API＋内容ごと）に保持。試験 `the_key_survives_leaving_to_the_login_screen_and_coming_back`。401の文言も「同じ内容なら二重登録されない」に |
| CODE-R2-2 / DOC-R2-04 エラー文だけで422にし、実装の誤りを利用者の誤りに見せる | 中 | 確認済み | roots[].allowedStates の宣言で判定、宣言外は500。試験 `a_handler_bug_is_reported_as_500_not_disguised_as_a_user_error` |
| CODE-R2-3 UNIQUE違反を全部DUPLICATEにする | 中〜低 | 確認済み | duplicateTables で宣言した表だけ。宣言外は500（他unitの存在を推測させない）。重複時の巻き戻しも試験 |
| CODE-R2-4 batch内のjob登録でunitまたぎの衝突が黙って抜ける | 低 | 確認済み | 独自dedupeKeyは`${unitId}|`で始める決まりを強制（docs/02） |
| CODE-R2-5 本文の契約が無いバイナリAPIで本文を読んで拒否 | 低 | 確認済み | kind=binaryは本文を読まない（T015のAPI-83のため） |
| CODE-R2-6 冪等の期限切れ処理の失敗でジョブ回収が止まる | 低 | 確認済み | try/catchで継続 |
| CODE-R2-7 422が「入力欄を直して」と表示される | 低 | 確認済み | 状態`rejected`「この状態では実行できません」。試験 `422_is_shown_as_a_state_problem_not_as_field_errors` |
| CODE-R2-8 保留鍵が1つで別内容に上書きされる | 低 | 確認済み | 内容ごとに保持。試験 `a_different_intent_keeps_its_own_key_and_does_not_overwrite_the_pending_one` |
| CODE-R2-9 追加試験の検出力（本文拒否の名前、トリガー条件の個別確認、重複時の巻き戻し、期限切れの理由） | 低 | 確認済み | 試験名を実態に、条件ごとの検査、巻き戻しとkey_expiredの確認を追加 |
| DOC-R2-01 docs/16の試験件数が古い | 中 | 確認済み | レビュー後の実数に更新 |
| DOC-R2-02 ph0.mdの「最下部の固定」 | 中 | 確認済み | 修正 |
| DOC-R2-03 docs/12の版行 | 低〜中 | 確認済み | 修正 |
| DOC-R2-05〜09 記録の言い過ぎ（A-F8/A-F11/B-F11/429/key_expired） | 低 | 確認済み | 試験追加または記録を実態に修正（上表の第1回の行も訂正） |
| Content-Typeの前方一致 | 低 | 確認済み | `application/json`（;以降のみ許可）に厳密化 |

### 第2回の変異による検出確認
| 変異 | 失敗した試験 |
|---|---|
| M6 トーストを閉じた後に出し直す（旧ロジック） | `the_saved_toast_shows_once_and_disappears_after_2_6_seconds` |
| M7 エラー文だけで422にする（旧ロジック） | `a_handler_bug_is_reported_as_500_not_disguised_as_a_user_error` |
| M8 鍵を部品の中だけに持つ | `the_key_survives_leaving_to_the_login_screen_and_coming_back` |

### 第2回修正後の実行結果
- `npx tsc --noEmit`: 成功／`npm run check:contracts`: OK／`npx vitest --run`: 6ファイル90件成功／`npm run build`: 成功／`npm run test:e2e`: 7件成功＋1件スキップ（スマホ専用試験をPC幅で除外）
