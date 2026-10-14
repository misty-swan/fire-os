# PH2 実行証跡（2026-10-14）

対象: T015〜T034（添付・施設GIS・CSV・資産・点検様式・点検・異常）。実行環境はローカル（Node v26 / workerd / wrangler 4.x / vitest 4.1.11 / Playwright chromium）。**実Cloudflareアカウント・実D1・実R2・実Workers・実Google Mapsは使っていない（wrangler未ログイン）。** D1はwranglerのローカルシミュレータ、R2はローカルのR2シミュレータ。migrationは0008〜0013（attachments/facilities/imports/assets/inspection_templates/inspections_issues）を空DBから適用。

## 実行結果
| 確認 | コマンド | 結果 |
|---|---|---|
| 型検査 | `npm run typecheck` | 成功 |
| 契約検査 | `npm run check:contracts` | 101 API / docs/05 101行 / OpenAPI一致 |
| 単体・結合試験 | `npx vitest --run` | 22ファイル146件成功（workers＝実workerd＋D1/R2/Queues、client＝jsdom。試験強化コミット 65b38f1 の後） |
| ブラウザ試験 | `npx playwright test` | 44件成功＋1件スキップ（スマホ専用試験をPC幅で除外）。setup（管理者招待→MFAで作成）＋shell/auth/member-admin/audit/attachments/map/facility-location/csv/assets/inspection-templates/inspection/issues を 360px と 1280px の両プロジェクトで実行 |
| ビルド | `npm run build` | 成功 |
| 実環境の試験 | `npm run test:live` | **未実施（環境未設定のため失敗＝未実施の記録）** |

## タスク別の指定試験
T015 `ready_object_cannot_be_overwritten_by_late_upload`＋token/所有者/形式の検査（計2件）/ T016 `forged_mime_or_scanner_failure_never_becomes_ready` / T017 `unlink_and_permission_revocation_block_new_downloads` / T018 `checking_file_is_not_submitted_as_ready`（実ブラウザ×2幅）/ T019 `coordinate_edit_invalidates_only_location_confirmation` / T020 `query_returns_all_201_facilities_and_detects_snapshot_change` / T021 `old_map_response_cannot_replace_new_viewport`＋`map_selection_sheet_matches_prototype_and_opens_detail`（実ブラウザ2件×2幅）/ T022 `gps_denial_allows_manual_entry_without_tracking`（実ブラウザ×2幅）/ T023 `preview_changes_no_facility_even_with_valid_rows` / T024 `import_commit_detects_master_change_and_escapes_formula`＋`csv_import_preview_then_commit_updates_master`（実ブラウザ×2幅）/ T025 `asset_has_one_storage_location_and_nonnegative_quantity` / T026 `asset_detail_displays_quantity_unit_and_storage`（実ブラウザ×2幅）/ T027 `approved_template_is_immutable_and_required_items_enforced` / T028 `template_edit_creates_new_draft_version`（実ブラウザ×2幅）/ T029 `inspection_issue_and_photo_link_commit_together` / T030 `asset_inspection_accepts_exactly_one_matching_target` / T031 `two_corrections_cannot_fork_same_original` / T032 `issue_close_and_reopen_require_current_version_and_reason`（T029〜T032はtests/inspections-issues.test.tsに集約）/ T033 `inspection_form_preserves_values_after_failed_submission`（実ブラウザ×2幅）/ T034 `issue_state_does_not_appear_as_location_verified`（実ブラウザ×2幅）— すべて成功。

## 赤→緑の扱い（正直な記録）
- T015〜T017は計画どおり試験先行の記録がdocs/16の状態欄にある。**T018〜T034の実装コミット（1745156〜0495556）は実装と試験を同じコミットに含む**ため、「試験を先に書いて失敗することを確認した」記録が残っていない。代わりに、**全15件の主要な防御について防御を外す変異を実行し、試験が失敗すること（または等価な防御が同じ働きをすること）を事後確認した**（下表）。
- T025の保管先排他は、最初Zod契約で同時指定を拒否していたのを**サーバーの422業務規則へ移し、契約試験を「形だけ検査」に更新した**（コミット c3bff31。docs/14 D22）。
- 変異確認の過程で、**変異しても試験が通ってしまう（検査として効いていない）箇所を4件見つけ、先に試験を強化してから変異で検出を確認した**（下表と次節）。

## 試験が検出した（または発覚した）欠陥と弱さ（修正済み）
- **マップの旧応答混入試験が実質何も検査していなかった**: 旧応答に混ぜる施設が「消火栓」（絞り込みで隠れる種別）で、さらに表示assertionが`getByText`（マーカーはaria-label描画で常に空振り）だった。混入物を絞り込み後も見える「防火水槽」に変え、role＋件数でassertするよう強化（65b38f1）。
- **点検訂正の異常再開のassertionが空**（`const resolvedIssueAutomaticallyReopened = false` を期待するだけ）: 訂正で起点異常を作り解決済みまで進めてから再訂正し、行と履歴が変わらないことをassertする形に置換。あわせて計画にあった「理由なし」「過去版からの枝分かれ（VERSION_CONFLICTコードまで）」「再訂正」のケースを追加（65b38f1）。
- **T024の台帳変更検出が版ガードにマスク**: 試験がプレビュー後の古いbatch版（1）を送っていたため、台帳版検査を外しても版ガードが409を返し検出されなかった。現行版を送るように修正（65b38f1）。
- **T029の必須項目検査が契約に隠れて通らない**: 空配列はZod契約（min 1）で400になるため、validateItemsの「必須項目の欠落」検査に届かなかった。様式に任意項目を追加し、必須が欠けた非空の明細を拒否するケースを追加（65b38f1）。
- e2eの既知の癖: ChromiumのAndroidエミュレーションはfile入力でレイアウトビューポートが広がったまま戻ることがある（以降の操作が当たらない）。attachments.spec と facility-location.spec は `isMobile: false` で回避済み（360px幅の確認は維持）。

## 変異による確認（防御を外して試験が失敗することを確認。`scripts/mutate.sh` / `mutate-e2e.sh`）
| タスク | 外した防御 | 結果 |
|---|---|---|
| T015 | completionの「選択済み」事前ガード | **未検出（等価）**: batch内のroots.allowedStates(pending_upload)＋conditions（選択が空のこと）＋UPDATE文のWHERE status='pending_upload'が同じ働きをする |
| T016 | PNG magic検査（偽物を通す） | 検出 |
| T017 | 取得時のACL再検査（リンクごとのauthorize） | **未検出（等価）**: unlinkの拒否はlinks SQLの`unlinked_at IS NULL`で担保。PER-01は現状unitWide: ALLのため同unit利用者を拒否する経路が無く、リンクごとの再検査は将来の対象種別のための先行防御（docs/07 §3.6の契約自体は残す） |
| T019 | 座標変更で旧位置確認を失効させない | 検出 |
| T020 | cursorのsnapshotRevision不一致の409 | 検出 |
| T021(e2e) | 旧世代応答の破棄 | **未検出（等価）**: 世代変更時、effect cleanupのAbortControllerが進行中の要求そのものを中断するため、後から届く古い応答が存在しない。世代番号は「解決済みだが未処理の応答」への二重防御で、e2eではこの競合を作れない。試験自体は空振りassertionを排除して強化済み |
| T024 | 確定時の台帳版（dataset_revision）一致検査 | 検出（試験強化後。初回は版ガードにマスクされ未検出） |
| T025 | 保管先の施設/車両排他（422） | 検出 |
| T027 | 承認済み様式版の不変トリガー（migration SQL） | 検出 |
| T029 | 様式の必須項目欠落検査（validateItems） | 検出（試験強化後。初回は空配列が契約400で止まり未検出） |
| T030 | 様式と対象の種別一致検査 | 検出 |
| T031 | 訂正の現在版ポインタ検査 | 検出（試験強化後。初回は並行分がseries版ガードで、過去版分がsupersedes_id UNIQUE（duplicateOn→DUPLICATE 409）に覆われ未検出。VERSION_CONFLICTコードまでassertして区別） |
| T032 | 状態遷移（reported→closedを許す） | 検出 |
| T018(e2e) | readyだけを親へ渡す絞り込み | **未検出（等価）**: 施設の親作成はattachmentDraftId渡しで、未検査添付の紐付け拒否はサーバーのリンク計画（422 ATTACHMENT_NOT_READY、workers試験で担保）が行う。点検フォームのattachmentIds渡しも保存時に同じサーバー検査を受ける。クライアントの絞り込みは表示用の補助 |

## 未実施・未接続（検証済みとして扱わない）
- **V02（実R2・実Workers）**: 検査・EXIF除去・不変ready・ACL・回収はローカルのR2/workerdシミュレータでのみ確認。実R2・実Workersでの動作、pixel完全デコード、PDFのマルウェア検査は未実施＝docs/evidence/V02-files.md の手順が残る。T016は「局所完了・実環境未完了」。
- **V05（実Google Maps）**: APIキー未取得のため、Google Maps JS APIの実表示・帰属・SKU/規約確認は未実施。**地図面はprototypeと同じプレースホルダー＋自台帳のマーカー/一覧で縮退運転**（@vis.gl/react-google-maps未導入。docs/14 D22）。全件検索（bbox・201件cursor・SNAPSHOT_CHANGED）は局所D1で確認済み（T020）。
- **T033の残作業**: 資産点検の入力画面（SCR-23）はプレースホルダーのまま（API-20はT030で完成、資産詳細に導線のみ）、点検訂正（API-46）の入力UIも未実装（APIはT031で完成）。docs/16 T033に残作業として記録。
- **AI分類候補**: 点検登録の紫の枠のみ。依頼・分類の接続はPH4（T053/T054）。
- 実端末（iOS/Android）・スクリーンリーダー・200%拡大は未確認（T083）。
- GitHub Actions、実Cloudflare D1/R2/Queues/Cronは未接続（PH0から継続）。`npm run test:live` も未実施。

## prototype準拠
マップ（`map_selection_sheet_matches_prototype_and_opens_detail` を360/1280pxで実行）: PCは右パネル420px（prototype Desktopの`grid-template-columns:minmax(0,1fr) 420px`と一致）＋「座標（外部マップへ送る値）」＋「この施設を点検する」＋「一覧に戻る」、スマホは選択シート（種別・番号・位置確認の状態・点検する/詳細/Googleマップで経路を開く/閉じる）。検索欄と切替ボタンは50px、現在地ボタン50px。マーカーは消火栓=赤#E8432A円・防火水槽=青#2F7FE0丸角四角・格納箱=橙#F08A24ひし形。点検登録は3ステップ（チェック→写真・メモ→確認）・下部ナビなし・AI候補欄は紫。トークン（背景#08101C・Ember#FF5A2E等）はDesign Systemどおり。実端末・スクリーンリーダーはT083で未確認。prototypeから意図して変えた点（現在地ボタンが動かない、検索が自台帳部分一致、オフライン自動送信の未実装、状態3行表示など）は docs/03 §1 に記録。
