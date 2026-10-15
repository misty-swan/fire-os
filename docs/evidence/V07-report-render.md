# V07 帳票の出力（PDF/CSV）の実表示検証（T058局所／実表示は未実施）

方式: **承認版のみを出す帳票出力**（docs/05 API-61、docs/14 D20、docs/16 T058）。実装は `src/server/reports/render.ts`（renderReport＝承認済み版→pdf/csvのReadableStream。依存ライブラリは追加していない）、`src/server/reports/decision.ts`（承認時に出力欄のサーバー計算値をreview_decisions.confirmed_payloadへ固定）、`src/server/routes/report-content.ts`（API-61の接続点）。

## 実施したこと（ローカルworkerd＋ローカルD1。実表示は未実施）

| 確認 | 結果 | 試験 |
|---|---|---|
| 出力は承認版だけ。承認済pointerが無い帳票はnot 200（404＝存在も明かさない。API-58と同じ区分） | 合格 | `submission_does_not_consume_final_decision_and_export_requires_approval`（unapprovedExport/not.toBe(200)） |
| 申請（request_review）は決定行を作らない＝最終決定を消費しない | 合格 | 同上（submissionFinalDecisions=0） |
| 最終決定（approve）は一版一回。二重approveは409 | 合格 | 同上（finalDecisionsPerVersion=1／doubleApprove=409） |
| 承認は元実績版を再検査（保存source_versions≠現行は409。入力だけ現行へ書き換えた承認も409） | 合格 | 同上（approveStale/approveRewritten=409） |
| 差戻し後・承認後の訂正は新draft版で、承認済pointer（current_approved_version_id）は失わない | 合格 | 同上（currentApprovedPointer=lastApprovedVersionId） |
| CSVはallowlist帳票のfieldSchemaに沿う列。参加人数・実施日時は**サーバー計算値**（本文の「90名」を使わない）、実施日時はJST | 合格 | 同上（participantCount="1"／actualPeriod="2026-10-21 10:10〜2026-10-21 12:40"） |
| CSV式注入のescape（=で始まるセルの無害化。施設書き出しAPI-55と同じcsvCell） | 合格 | 同上（activityTitle="'=セル注入試験の活動（架空）"） |
| CSVのBOM（EF BB BF）とCRLF、content-type text/csv | 合格 | 同上（先頭バイトで確認。text()のデコードはBOMを剥がすためバイトで検証） |
| PDFは妥当な先頭バイト（%PDF-）とcontent-type application/pdf | 合格 | 同上（pdfHead="%PDF-"） |
| PDFの構造（Catalog/Pages/Page/Contents/Font/xrefの整合。startxrefのオフセットが各オブジェクトの先頭に一致・/Length整合・長い本文で3頁に改ページ） | 合格（コミット前の局所検査。NodeでrenderReportのバイト列を直接解析。実ビューアでの描画は未検証＝下記） | 追加確認スクリプト（workers試験の外。リポジトリには保存しない） |

## 方式の決定（docs/16 T058のコントローラ裁定どおり）

1. **出力の原本は「承認時に確定した値」**: 数値（活動名・参加人数〔participated行数。行が無ければ「未記載」〕・実施日時〔JST。欠落は「未記載」〕）は**承認時にサーバーが計算してreview_decisions.confirmed_payloadへ固定**する。元実績が承認後に訂正されても、承認済みの出力は書変わらない（API-58/59のsource_versions検査と対。承認時の不一致は409）。
2. **PDFは依存を増やさない最小実装**: PDF 1.4・テキストのみ。フォントはPDF仕様Annex Dの標準CJKフォント（HeiseiMin-W3／UniJIS-UCS2-H、Adobe-Japan1-2）を**非埋め込みで参照**する。minitty系の実ライブラリやフォントファイル（埋め込みは数MB規模＋ライセンス確認が要る）は追加しない。改ページは固定行数（LINES_PER_PAGE=46行/頁）、長い行は全角=2/半角=1の近似表示幅で折り返す（文字幅の実測はしていない）。
3. **CSVはfieldSchemaの列順**（computed欄→input欄〔本文〕→承認者欄〔creator/approver/approvedAt〕→templateNote）。templateNoteに架空の検証設定である旨の注記を載せる（実団体の正式様式・承認と偽らない＝docs/14 D20）。式注入escapeは施設書き出しと同じcsvCell（=,+,-,@とタブで始まるセルに'を前置し、区切りを含む値は引用）。

## 未実施（検証済みとして扱わない）

**PDF/CSVの実表示は未実施。** 理由: ①この環境は実Cloudflare未接続（wrangler未ログイン）、②日本語フォントを埋め込んでいないため、実表示はビューアのフォント代替に依存する（Acrobatのアジア言語フォントパック、Chrome pdfium、macOS Preview等で挙動が違い得る）。局所の「%PDF-先頭バイト」合格を「実表示での合格」とは扱わない。

実施手順（`tests/live/report-render.test.ts`が環境変数（LIVE_BASE_URL/LIVE_BOOTSTRAP_EMAIL/LIVE_BOOTSTRAP_TOKEN）が無ければ必ず失敗して手順を示す。実施まで落ち続ける＝未実施をskipしない契約）:

1. D12のAI条件とD20の帳票条件の了承を得る（実データ投入の前に団体へ提案して記録。docs/14 D20の期限/工程）
2. 実環境（demo/staging）に配置し、管理者でログイン（実セッション。既存live試験と同じ）
3. 架空データの活動＋実績（参加人数・開始/終了時刻を含む。activityTitleを「=」で始める）を作り、手動帳票（API-62）で下書きを作る
4. API-60で request_review → approve（承認者欄に承認者の表示名が載ることを確認）
5. API-61 format=pdf を実端末の複数ビューアで開く: **①日本語の文字化け/欠落が無いこと**（非埋め込みCJKフォントの代替が働くこと。欠ける場合はrender.tsのフォント方針をこの文書へ記録して埋め込みへ再設計）②20,000字近い本文で改ページが効くこと ③長い行の折り返しが読めること
6. API-61 format=csv を実Excel/Numbersで開く: BOMにより日本語が正しく読めること、式が実行されないこと（「=」で始まるセルが「'」で無害化されていること）、templateNote列が表示されること
7. 未承認の帳票（承認版が無いもの）でAPI-61がnot 200であることを実環境でも確認する
8. 結果（ビューアと版、スクリーンショットの所在）をこの文書へ記録し、`tests/live/report-render.test.ts`のexpectを実測で確定する

## 関連の残事項

- フォント埋め込みに切り替える場合は、フォントのライセンス（原則：団体への再頒布の可否）とバンドルサイズ（数MB）をdocs/14 D20の了承材料に加える。
- 様式が正式承認（D20）されたら、config/report-templatesのartifact差し替えと一緒に、出力のレイアウト（承認者欄の配置・印字項目）を正式様式に合わせる（T056の登録点更新手順と同じ）。
