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
| A-F1 状態不一致・業務UNIQUEが500→利用者に「再送可」と表示 | 中 | 確認済み | diagnoseに422 INVALID_TRANSITION / 409 DUPLICATE を追加。試験 `matching_version_but_wrong_state_is_invalid_transition_not_500` / `business_unique_violation_is_duplicate_not_500` |
| A-F2 conditionsの評価時点がbatch内と失敗判定で不一致 | 中 | 確認済み | 前提条件として業務書込の前に評価するよう移動。試験 `conditions_are_preconditions_evaluated_before_the_writes` |
| A-F3 INSERT OR REPLACEで追記専用表を上書きできる | 中 | 確認済み（D1でも再現） | drizzle/0003 で衝突するINSERTを拒否するトリガー。試験 `append_only_tables_cannot_be_overwritten_with_insert_or_replace` |
| A-F4 結果不明→401で鍵を捨て二重登録 | 中 | 確認済み | 確定拒否(400/403/404/409/422)まで鍵を保持。試験 `the_key_survives_401_after_an_unknown_result_so_a_retry_cannot_double_register` |
| A-F5 日時の文字列比較が精度差で逆転／DB形式と不一致 | 中 | 確認済み | Instantをミリ秒3桁Zへ正規化。試験 `instants_are_normalized_before_comparison_and_ids_must_be_lowercase` |
| A-F6 content-lengthなし本文を全量読み込み | 中 | 確認済み | 逐次読みで上限超過時に打ち切り。試験 `chunked_body_without_content_length_is_cut_at_the_limit` |
| A-F7 タイムアウト後もhandlerが動き外部効果が二重になり得る | 低 | 方針で残す | 外部効果の一回性はhandlerの責務と docs/02・docs/16・runner.ts に明記（Workersでは処理を中断できない） |
| A-F8 errorCode/resultRefがCHECK違反でループ停止・内部文の露出 | 低 | 確認済み | コード形式の検証と置換、確定失敗でもループ継続。試験 `handler_error_codes_are_sanitized_and_dedupe_does_not_cross_units` |
| A-F9 dedupeで他の依頼者/他unitのjobが返る | 低 | 一部確認済み | unitをまたぐ返却を禁止（同上の試験）。同unit内の別依頼者の照会権限はPH4（通知/AI）で判断＝対象外 |
| A-F10 `/api`（末尾スラッシュなし）がSPAに渡る | 低 | 確認済み（Bが実測） | `run_worker_first=["/api","/api/*"]`。e2e `api_paths_return_json_never_the_spa` |
| A-F11 契約に無いquery/本文を無視、Content-Type未検査 | 低 | 確認済み | 拒否に変更、本文はapplication/json必須。試験 `requests_without_body_contract_reject_query_and_body` ほか |
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
| B-F11 docs/05/11を独立に転記していない | 低 | 一部確認済み | method/path/成功statusは自動照合済み。状態辞書の自動照合は、11の書式が文章のため後続（T078のCI拡張）で検討 |
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
| D-F12 T005の試験ファイル名/Files/件数 | 中 | 確認済み | .tsx・Files追加・件数更新 |
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
