# PH5 レビュー・修正サイクル（2026-10-16〜17）

ph0〜ph4と同じ手順。範囲はPH4最終commit **5d8688b**〜HEAD（レビュー開始時 1f9d59d。T062〜T071の実装11コミット〔0024のsupersede修正を含む〕＋docs統合）と関連docs。レビュー担当は**読み取りのみ**（ファイルの変更・git書き込み操作・試験の実行は禁止）。指摘は**メインのエージェントが一件ずつコード・試験で確かめ**、分類してから直す。

## 第1回

### 依頼
独立したサブエージェント4体を並行で起動：**A=正確さ・セキュリティ**（ACL前置と取得時再検査・引用原文一致・失効文書の遮断・承認前書込禁止・jobのlease/dedupe/stale・冪等と再送〔鍵先読み。T041流儀〕・PII）／**B=docs/16完了条件と試験の妥当性**（UIから操作できない完了操作を作らない。実外部を要するもの（実Cloudflare・実AI・実検索基盤）をモックで完了扱いにしない）／**C=prototype準拠**（360/1280px・寸法・文言・押下領域44px・トースト位置対応表）／**D=docsと実装の整合**（DDL×docs/04のNULL可否・docs/05×契約・docs/11×states.ts）。各体に観点ごとの差分パッケージ（A=src/server+src/shared+tests+openapi、B=docs/16+docs/evidence/ph5.md+tests、C=src/client+tests/e2e+prototype、D=docs+openapi）と報告形式（ファイル:行、問題、発生条件、重大度、根拠。推測は「要確認」）を渡した。

### 指摘と分類（件数は報告の項目数。合計: 高0 / 中9 / 低20）

| 観点 | 指摘 | 重大度 | 分類 | 対応 |
|---|---|---|---|---|
| A中1 | API-30がassistant候補の`readResults`（文書chunk本文の先頭2,000字・異常本文）を文書ACLと無関係に全PER-10保持者へ返す（`output_json`を無过滤で返す。撤回・ACL失効後も読める。承認の効果面は`assistantReferenceConditions`の409で防げているが内容面が検査外） | 中 | 確認済み | API-30のassistant行投影時に要求者が現在可視でない参照の要約を**masked化**（{type,id,masked:true}のみ。文書は`authorizedDocumentVersions`系で判定）。赤試験＋変異DETECTED |
| A中2 | API-76の`documentIds` 81〜100件（契約max100×port上限80）がplain `Error`→500 | 中 | 確認済み | **契約を80件へ揃える**（D1のbind上限100配慮。docs/05 API-76行・openapi・contracts.testの3点更新）＋portの検査をHttpError化。赤試験（81件が400）＋変異DETECTED |
| B中1 | docs/16の局所完了5タスク（T064〜T068）が全`[x]`＝PH4のB低5裁定（局所完了は`[ ]`維持）と不整合。同じ文書内で基準が割れる | 中 | 確認済み（docs） | T064〜T068を`[ ]`へ戻し（T051/T053/T057/T058/T061と統一）＋docs/evidence/ph5.mdに基準（`[x]`=完全完了、`[ ]`=局所完了）を明記 |
| B中2 | T069完了条件「処理中/**抽出不能**/失効を明示」のうち抽出不能表示をe2eが1件も断言しない（表示分岐の回帰が検知されない） | 中 | 確認済み | documents.specに「画像のみPDF→『抽出不能』＋理由表示」のe2e追加（実経路＝画像PDF fixture→抽出jobのmanual_review→版パネル表示。変異で赤→復元→緑） |
| C中1 | AssistantPageの「記録を添える」チップが約34px（`max-lg:min-h-11`無し。PH4レビューC中1の再発） | 中 | 確認済み | `max-lg:min-h-11`付与（ReportDraftPage流儀）＋押下領域e2e追加（実測高さ断言。旧コードでFAIL） |
| C中2 | 送信ボタン`size-10`（40px）＝docs/03 §1.1-19⑩の44px記録と衝突（prototypeは40px） | 中 | 確認済み | **Ruling: 記録済みの44px規約を優先**し`size-11 lg:size-10`（モバイル44px・PCはprototypeどおり40px。巡回の上下移動と同じ流儀）＋押下領域e2e＋docs/03に記録 |
| C中3 | AiReviewDetailの「確認・承認の画面（SCR-28）は後続のタスク（T070）で追加予定」文言が、同梱で実装済みのT070と矛盾 | 中 | 確認済み | 「提案の確認・承認はAIアシスタント画面で行います」＋`/app/assistant`リンクへ更新（docs/16 T068・docs/03 §2にも反映） |
| D中1 | API-76の権限docs/05行「PER-11/09」×実装はPER-11のみ（PER-09不検査。前例API-29/32の読み方と揺れ、docsに裁定が無い） | 中 | 確認済み | **Ruling: 「PER-11/09」はAPI-29/32と同じ「PER-09（AI送信許可）＋PER-11（読取）の併用検査」の意**。PER-11検査の前に`requirePermission(p,"PER-09")`を追加＋赤試験（PER-09無し403）＋docs/05行に併用検査の補足を同一コミットで明記 |
| D中2 | RAG回答status（answered/abstained/withheld）が正本docs/11とstates.tsに未収載（DDL・docs/04・画面語彙にはある） | 中 | 確認済み | states.tsに`ragAnswerStates`を追加（contracts経由で正本化）＋docs/11 §2にrag_answersの状態行（answered→withheld＝出力前再検査での失効）を追加 |
| A低1〜7 | roles空配列での`IN ()`防御／撤回済み文書への版作成422化／inflate展開上限32MB／再送時の実在しないjobIdをQueueへ送る（実害無し）／superseded旧版のFTS行残留／chunks0件でindex succeeded／chunk.ts重複行 | 低 | 低1・2・5・7は同梱修正（roles空は常に非可視・撤回後422・上限超はmanual_review・重複行除去。すべて赤先行＋変異）。低3・4・6は下記「方針で残す」 |
| B低3〜5 | 「50問評価」のローカル機械実行が無い（4ケース外挿）／e2e件数「75+2」にsetup projectが含まれる表記／「report-approval.test.ts新規」は既存ファイルへの追加 | 低 | 低3は同梱修正（**固定dataset55問全件をfake RAGで流す回帰を追加**: 引用一致100%・漏えい0・根拠なし全問abstainedを断言）。低4・5はdocs修正 |
| C低1〜4 | AIアシスタントのeyebrow書式不一致／思考ステップの単純化が未記録／文内リンクの44px扱い／巡回画面の施設名表記ゆれ | 低 | 低1（eyebrow削除・prototype準拠）・2（docs記録）・4（facilityName統一。DTO不変）は同梱修正。低3は「方針で残す」 |
| D低3〜8 | DTOコメントの陳腐化／result_ref書式の語（片数→chunk数）／docs/04:157行頭の旧記述／§1列挙にcontent_version_events.reason無し／patrolPlanStatesの二重定義／残存x-provisional（PH2〜PH4領域） | 低 | 低3〜7は同梱修正（コメント・語彙・行頭・列挙・import寄せ）。低8は**対象外**（PH5差分外。各機能の厳格化タスクで） |

### 誤り・対象外
なし（B報告は「実外部をモックで完了扱いにしない」観点で問題なしと判定：指定試験13本の名前・assertion・UI主経路・局所完了T064〜T068の正直な記録・migration/試験件数の実数が実リポジトリと一致。D報告はDDL×docs/04（0027〜0030のNULL可否・UNIQUE/FK/CHECK・索引）・docs/05×契約12API・docs/11×states.ts・openapi再生成（PH5厳格化DTOのx-provisional残存なし）を「PH3/PH4型の乖離なく整合」と評価）。

### 修正の実施
2体の実装サブエージェントに分割（①サーバー+shared+workers試験: A中1/A中2/D中1/D中2/A低1/A低2/A低5/A低7/D低3/D低7/B低3 ②クライアント+e2e+docs: C中1/C中2/C中3/B中1/B中2/C低1/C低2/C低4/B低4/B低5/D低4/D低5/D低6）。挙動を変える修正はすべて**先に失敗する試験を追加して旧コードでFAILを確認**（workers新規7件・e2e新規2本〔押下領域×1・抽出不能表示×1〕）。

### 変異による確認
readResultsのマスク除去→遮断試験落ち **DETECTED**／documentIds契約・PER-09検査・roles空ガード・撤回422・inflate上限の各防御除去→対応試験落ち **DETECTED**（計6件・サーバー担当）／押下領域のmin-h-11除去・抽出不能表示の壊し→e2e落ち **DETECTED**（計2件・クライアント担当）。全て復元を目視確認。

### 再実行（修正commit前）
`npm run typecheck` 成功／`npm run check:contracts` 102 API一致／`npx vitest --run` 52ファイル**248件成功**／`npm run build` 成功／`npm run test:e2e` 78件成功＋3件スキップ（phone-360/desktop-1280＋setup。押下領域の1件はモバイル規則のためdesktop側を意図的skip）→ commit **4c8c0c9** `fix: address PH5 review round 1 (server)` ＋ **f3395d1** `fix: address PH5 review round 1 (client/docs)`。

## 第2回（第1回修正 4c8c0c9+f3395d1 の再レビュー）

### 依頼
新しいサブエージェント2体を並行で起動：①サーバー側（修正差分 1f9d59d..f3395d1のsrc/server+src/shared+tests+openapi）②クライアント・docs側（同diffのsrc/client+tests/e2e+docs）。読み取り専用。試験は実行しない（合否は全検証記録に依拠し、判定はコード読解）。

### 解消判定
| 対象 | 判定 |
|---|---|
| サーバー系11件（A中1・A中2・D中1・D中2・A低1・A低2・A低5・A低7・D低3・D低7・B低3） | **すべてADDRESSED**（PARTIAL/NOT 0件）。A中1のマスクは撤回・ACL失効・別unitの全経路で正しく、masked行形状が契約・openapi・試験の三点一致。A中2は契約・openapi・docs/05行・port・試験の五点一致。D中1はAPI-29/77前例と同一経路＋団員403の赤試験あり |
| クライアント・docs系13件（C中1〜3・B中1・B中2・C低1・2・4・B低4・5・D低4〜6） | **すべてADDRESSED**（13/13）。押下領域は実測高さ断言の新e2eで旧コードがFAILする構造。docs/16のT064〜T068は全`[ ]`になりPH4局所完了5タスクと統一（実ファイル走査で確認） |
| diff内新規欠陥 | サーバー0件（観察3件: maskの文書参照N+1クエリ〔性能・将来課題〕・コメント連結表記・diffファイルへのe2e混在〔判定範囲の注記〕）。クライアント低1件（**PatrolPlansPageでAPI-10を重複取得。破損なし**）＋diff外の観察1件（documents.specの「SCR-28未実装」陳腐コメント〔次回掃除候補〕） |
| サーバー修正とクライアントの整合 | 問題なし（PER-09必須化は管理者seedに影響せず、documentIds上限・masked投影・撤回後422もクライアント呼び出しと不整合無し） |

### 判定
**2回のレビュー・修正サイクルを完了。確認済みの高・中の未解消は0件。** 第2回時点の全検証: `npm run typecheck` 成功／契約検査102一致／`npx vitest --run` 52ファイル**248件**／`npm run build` 成功／`npm run test:e2e` **78件成功＋3件スキップ**（phone-360/desktop-1280。1回目のフル実行でdocuments.spec desktopが1件のみフレーク〔作成直後のトースト断言。単独実行・2回目のフル実行は緑。ph4.md記録の既知flap型〕）／`npm run test:live` は実環境未設定のため8件fail継続（docs/evidence/ph5.mdに記録）。

## 方針で残す（Rulingつきの全リスト）

1. **A低3 superseded旧版のFTS行とindex_status='indexed'が回収されない**（低）— Ruling: 検索側の三重防御（`v.status='approved'`＋`index_status`＋hit後`authorizedDocumentVersions`）で遮断済み＝漏えい無し。FTS容量の衛生はPH7負荷検証（D16/V04）で確認。コスト: 索引容量が単調増加
2. **A低4 chunks0件でindex jobがsucceeded（indexed:0）**（低）— Ruling: 抽出不能の可視化はT069画面の抽出不能表示（B中2でe2e強化済み）と抽出jobのmanual_reviewが正本。index結果語彙の拡張は運用観測後に判断。コスト: index結果だけ見ると空索引が正常完了に見える
3. **A低6 同キー再送時に実在しないjobIdをQueueへ送る**（低）— Ruling: Queue消費者はメッセージ内容を使わずD1正本から実行するため実害無し（docs/05 §2の「起動の合図」設計どおり）。次にroutesへ触る際の統合掃除で整える。コスト: Queue合図のログに無効IDが現れ得る
4. **C低3 文内インラインリンクが44px規約の対象か未整理**（低）— Ruling: 文内リンクは既存前例（AnnouncementsPage等）と同じ扱い。承認後導線の行リンク化はUX改善タスクで判断。コスト: 360pxでのタップ精度が行リンク比で落ちる
5. **再レビュー低1 PatrolPlansPageでAPI-10を重複取得**（低）— Ruling: 機能破損なし（同一データの重複取得）。画面改善タスクで統合。コスト: 画面初期化の要求が1回増える
6. **D低8 残存x-provisional-response:true（PH2〜PH4領域・API-31）**（低）— **対象外**（PH5差分外。docs/05行への明記は各機能の厳格化タスク時）
7. **diff外観察 documents.specの「SCR-28未実装」陳腐コメント**（低）— Ruling: 挙動への影響なし。次回documents.specへ触る際に清掃

## 最終状態

- 確認済みの高・中の未解消: **0件**
- 指摘総数: 高0 / 中9 / 低20＝修正した確認済みは**中9件＋低15件**（残り低5件は方針で残す・対象外）
- 変異確認: **8件DETECTED**（サーバー6・クライアント2。全て復元目視確認）
- 最終全検証（f3395d1時点）: `npm run typecheck` 成功／`npm run check:contracts` 102 API一致／`npx vitest --run` 52ファイル**248件**／`npm run build` 成功／`npm run test:e2e` **78件成功＋3件スキップ**（phone-360/desktop-1280）／`npm run test:live` は実環境未設定のためfail継続（docs/evidence/ph5.mdに記録）
- 局所完了の残手順（V04-retrievalのOCR・Vectorize実測・実AI品質評価等）は docs/evidence/ph5.md に記録済み。レビューサイクルでは「実外部をモックで完了扱いにしない」観点でこれらの正直さを確認済み（B報告）
