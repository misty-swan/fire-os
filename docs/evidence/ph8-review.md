# PH8 T083 レビュー・修正サイクル（2026-10-18）

ph0〜ph7と同じ手順。対象はT083「実端末・アクセシビリティ・再訪操作の検証修正」。範囲は **f8f0c4d**（PH7レビュー完了）〜HEAD（レビュー開始時6c4ec4b。実装7bb8d08＋ph8.md）と関連docs。レビュー担当は**読み取りのみ**（ファイルの変更・git書き込み・試験の実行は禁止。ls/grep等の読み取りコマンドは可）。指摘は**メインのエージェントが一件ずつコード・試験で確かめ**、分類してから直す。報告書の副本はworkspace（.superpowers/sdd/16_実装タスク一覧/ph8-review-{A,B,C,D}.md）。実装直後のコントローラ検証（typecheck／check:contracts 102一致／vitest 65ファイル291件／build）は実装者の実行と重ねて実施済み。

## 第1回（4体並行）

### 依頼
独立したサブエージェント4体を並行で起動: **A=正確さ・セキュリティ**（R1契約変更〔MeData.unitId〕の参照整合と緩みの有無・axe/CDP計測の実質性・同期復旧判定の恒真性・403統一）／**B=docs/16完了条件と試験の妥当性**（実端末をモックで完了扱いにしない・局所完了の正直さ・赤の実質性・断言の実観測接続・D18開発案値の区別。実数は自分で確認）／**C=prototype準拠**（画面変更の全体把握・R3の見た目×prototype・新規specの断言语彙の捏造有無・共通UI規約の無変更）／**D=docsと実装の整合**（docs/05×DTO・docs/16状態欄×実施・docs/03追記×実コード・V07-ux×実装・matrix実行可能性の文単位照合）。各体に差分パッケージ（review-f8f0c4d..6c4ec4b.diff・約204KB）と報告形式（ファイル:行、問題、発生条件、重大度、根拠。推測は「要確認」）を渡した。

### 指摘と分類（件数は報告の項目数。合計: 高1 / 中5 / 低10 / 要確認7）

| 観点 | 指摘 | 重大度 | 分類 | 対応 |
|---|---|---|---|---|
| A高1 | 200%ズーム注入が直後の`goto()`で破棄され、**断言が実際は100%で走る**（accessibility.spec.ts:169-172・revisit-helpers.ts:447-452。V07-uxの「200%で押せる」行が測定として不成立） | 高 | 確認済み（コントローラ実検） | goto→主要要素出現待ち→注入→断言の順へ再構成。旧順序でzoomが`""`に破棄／新順序で`"2"`存続を実証（45ebc33）。V07-ux該当行を実測ベースへ差し替え |
| A中1 | `tabReaches`がblur直後の`body.textContent`（全ページテキスト）で初回恒真＝**Tab押下なしでtrue**（revisit-helpers.ts:405-419） | 中 | 確認済み（同） | Tab押下を判定の前に移動＋body/htmlをhit対象外へ。旧実装がTab 0回でhit／新実装はTab 2回で実フォーカス到達を実証（45ebc33） |
| A中2 | achromatopsia適用後の断言が`toBeVisible`（DOM可視性・描画非依存）のみで**適用が断言に実質無効**＋`session.detach()`即走で存続未確証（accessibility.spec.ts:152-166・revisit-helpers.ts:455-460） | 中 | 確認済み（同） | CDPセッション保持型へ作り直し（断言完了後に"none"送信→detach）。適用有効性は色つき要素のスクリーンショット差分（sha256比較・適用中不一致／解除で復帰）で実証。V07-ux §1.2を「描画効果そのものは機械断言していない（文字ラベルの存在確認）」へ正直差し替え（45ebc33） |
| B中1/D中1 | docs/16:177の「操作数2〜3」が実測（出欠2/点検6/異常2/引用2/同期3・最大6）と突合しない転記ミス | 中 | 確認済み（docs実検） | 実数どおりへ修正（45ebc33。V07-ux:47・matrix §1.1と突合一致） |
| B中2 | axe走査を4画面に限定した＝「全SCRの対応matrix」の**未達部分が局所の理由として明記されていない**（状態欄の局所の理由は実端末系のみ） | 中 | 確認済み | docs/16:177・V07-ux:23/61へ「4画面＋WCAG 2.1 A/AA限定＝全SCRの走査は未実施〔実行時間圧迫への対処〕」を局所の理由として明記（45ebc33） |
| B中3 | docs/03 §5「各5名程度の代表利用者による説明なし再訪計測」の残手順が**どの証跡文書にも無い**（RG-02の利用者試験） | 中 | 確認済み | device-test-matrix §2.4へ番号付き残手順として起票（対象者5名・手順書を渡さない・課題・合否の目安・記録形式）＋V07-uxへe2e自動測定の限界（「説明なしで分かるか」は測れない）を明記（45ebc33） |
| A低1 | axe走査がデータ取得前のDOMで走る可能性（`#main`可視のみ待つ） | 低 | 同梱修正 | 走査対象を`{label, path, ready}`構造化し、各画面の主要要素出現待ち（30秒timeout）を走査直前に追加（45ebc33） |
| A低2 | sync_recoverで自動同期が先に適用すると手動「もう一度送る」のクリックが握りつぶされる（手動再送経路のカバレッジが実行ごとに非決定的。成否判定自体はサーバー検証読みで正しい） | 低 | 方針で残す | Ruling下記1 |
| A要1 | CDP detachでエミュレーションが解除されるか未確証 | 要確認 | A中2と一体で解消 | セッション保持型＋スクリーンショット差分実証で適用の存続を確認（45ebc33） |
| A要2 | serious以下の違反件数が証跡に見えない（添付のみ・断言対象外） | 要確認 | 同梱修正 | `[axe]`stdout出力を追加しV07-ux:61へ実件数を転記（phone-360 7件／tablet-768 7件／desktop-1280 23件・主にコントラスト系・**critical 0件**）（45ebc33） |
| B低1 | revisit-flows.specを「ブリーフ外の追加」と表現（Filesに元々含まれる） | 低 | 同梱修正 | ph8.md:14の表現を修正（45ebc33と同時期のdocs修正。round 1で解消） |
| B低4 | matrix:6「コミットはV07-ux.mdに併記」の参照先が実在しない | 低 | 同梱修正 | V07-ux:7へ実装コミットハッシュ（7bb8d08）を併記（45ebc33） |
| B低5 | matrix:37の「Tab実走査（出欠・点検・マップ・文書・同期）」が実装より広い（Tab実走査は出欠「参加」の1点のみ） | 低 | 同梱修正 | matrix §1.2・V07-ux:26の記述を実装どおりへ（45ebc33。F2修正と一体） |
| B低6 | ph8.md「既存87本＋6」の数え方が94とずれる | 低 | 同梱修正 | 「旧87 passed＋旧フレーキー1本が今回緑＋新規6本＝94」へ修正（45ebc33。87+1+6=94で算術成立） |
| B低7 | attachMatrixの`void testInfo.attach`でawaitしていない（添付喪失可能性・serious以下の事後照合不能） | 低 | 同梱修正 | async化＋await（呼び出し側2箇所も）（45ebc33） |
| C低1 | AccessPanel.tsx:377の非管理者ゲートが`Banner tone="warning" eyebrow="FORBIDDEN"`のまま（R3統一の対象外・diff外の既存差異） | 低 | 方針で残す→語彙規則の文書化で決着 | Ruling下記2（docs/03 §1.1-23への追記。表示の変更はしない） |
| C低2 | revisit-helpers.ts:2のimport連結・:336付近のtypo「クリングしない」 | 低 | 同梱修正 | 整形・訂正（45ebc33） |
| C要1 | 試験の再実行なし（7/7 PASSは実装者証跡による） | 要確認 | コントローラ最終検証で解消 | 本サイクル完了後にコントローラがフルe2e×2を再実行（下記最終状態） |
| C要2 | attachMatrixの`void`で添付未待ち | 要確認 | B低7と同一 | 同上 |
| D低1 | markerTextLabelsMissingのdocs表記が実装より広い（実装はマーカー2点計上・一覧行は計上せず） | 低 | 同梱修正（4箇所）→**ph8.mdの1文が残存** | V07-ux:27・specコメント・matrix §1.2・helper docstringを実装どおりへ（45ebc33）。**ph8.md:21のみ修正漏れ**→修正ラウンド2で解消（9dd61ad） |
| D低2 | matrix §1.1にphone-360の再訪行が無い＋Interfaces 7項目が列に現れない | 低 | 同梱修正 | phone-360行追加＋7項目の対応表を:17に明記（45ebc33） |
| D低3 | V07-uxの手順列挙にstepとopの混在 | 低 | 同梱修正 | 列を「画面操作（op。順どおり）」へ作り直し＋但し書き（45ebc33） |
| D要1 | docs/16:40のPH8要約文が未更新 | 要確認 | コントローラ作業で解消 | サイクル完了時に本文書と一緒に更新（下記最終状態） |
| D要2 | ph8-review.md（本書）が未作成 | 要確認 | サイクル完了で解消 | 本書の作成 |
| D要3 | axe4画面限定の理由と「全SCR」完了条件の関係をdocsに残すか | 要確認 | B中2と同一 | 同上 |

### 修正の実施（ラウンド1）
**45ebc33** `fix: address T083 review round 1`（8ファイル・docs＋試験の同一コミット）: F1（ズーム注入順序）／F2（Tab走査のbody判定）／F3（セッション保持型achromatopsia＋実証）／F4〜F6（docs/16実数・axe限定明記・5名計測の残手順）＋同梱低（A低1・A要2・B低4〜7・C低2・D低1〜3）。挙動を変える3修正はすべて旧コードの欠陥実再現→新コードで解消の実証つき〔F1: 旧順序でgoto後にzoom破棄→新順序で"2"存続／F2: 旧実装がTab 0回でhit（恒真の実再現）→新実装はTab 2回で実到達・存在しないラベルはfalse／F3: 適用中のスクリーンショットがsha256不一致・解除で復帰〕。

## 第2回（round 1修正 6c4ec4b..45ebc33 の再レビュー・スコープ付き）

新しいサブエージェント1体が指摘16件（F1〜F16）をdiffで判定: **15件ADDRESSED・新規破壊なし**。残存はF13の1文（ph8.md:21のmarkerTextLabelsMissing表記が実装と矛盾のまま）のみ。範囲外の観察2件（fix reportのzoomMethod説明が実装より強い表現／V07-ux:7の自己参照表現の読みにくさ）は下記「方針で残す」へ。

## 修正ラウンド2と再レビュー

**9dd61ad** `docs: fix T083 review round 2 (ph8.md marker label description)`: ph8.md:21の1文を実装どおりへ差し替え（docsのみ）。再レビュー（別の新しいサブエージェント）: **F13 ADDRESSED**（差し替え文が実装・他文書と相互一致。「別断言」の実体〔achromatopsia節・一覧代替フロー〕も確認）・新規破壊なし。

## ラウンド3・4（コントローラの最終検証で発覚した既知フレーキーの根因修正）

**経緯**: コントローラの最終検証でフルe2eに失敗が連発（documents.spec〔desktop〕4回連続＋未触specの散発）。調査の結果:

1. **documents.spec〔desktop〕「題名消失」**: エラースナップショット（「題名を入力してください」の検証エラー・分類は生存）＋webServerログ（desktopの作成POSTがサーバーに到達せず。他の6回の作成は全て201・約60ms）から、`fill(題名)`の入力がReact状態へ反映されずクライアント検証で送信中止になっていたと確定。**旧「既知フレーキー〔トースト断言〕」（ph5/ph6/ph7）の実体はこの題名消失だった可能性が高い**（旧断言は送信不発で5秒落ち）。E1実験（新規2spec→documents連結）は11 passed＝新規specとの相互作用なし。単独実行は常に緑
2. **inspection-templates.spec〔phone〕**: トースト直後の`body.textContent.includes("rev2")`1回きり評価（非ポーリング）が描画遅延でfalseになる（フル走行の約40%）
3. **reports / facility-location / notifications**〔各1回〕: 同じ時間依存・非ポーリング断言クラスの1回off

**修正**: **38922d4** `fix: harden T083 documents spec fill race (review round 3)`（documents.specのみ: 粘着fill〔fill→toHaveValue→再fill計3回〕＋`waitForResponse`への30秒明示タイムアウト＋根因コメント）／**3b8a56a** `fix: poll inspection-template version label (review round 4)`（inspection-templates.specのみ: ポーリング断言への置換＋カードスコープ化）。再レビュー2体とも**APPROVE**（round 3: アプリにtitleを空へ戻すコードパスが無いことを実検＝UI欠陥の隠蔽ではなく自動化の注入競合への対策・断言の実質性維持／round 4: rev2ラベルの実DOM照合・誤マッチ弱点の解消）。いずれも赤は負荷依存フレークのため取得不可＝実観測（エラースナップショット・サーバーログ・件数）を根拠に、修正後の単独実行で緑を確認

## ラウンド5〜9＋仕上げ波（ユーザーの実機確認から相次いだ実欠陥の修正。2026-10-19）

最終検証を**ユーザー自身のiPhone実機（Safari・LAN平文http）**で実施したところ、実欠陥が相次いで発見された。各ラウンドとも赤→緑（または実機実測データを根拠とした修正）＋スコープ付き再レビューAPPROVEで収束:

| ラウンド | コミット | 発見と修正 | 再レビュー |
|---|---|---|---|
| 5＋仕上げ波 | e6d1301・af0426d | 平文http（secure context外）で `crypto.randomUUID` が存在せず `deviceIdOf` がTypeError → `src/client/uuid.ts` 共有ヘルパー（getRandomValuesフォールバック）＋クライアント全9箇所置換 | APPROVE（122bitエントロピー維持・冪等キー契約維持を rg 実検） |
| 6→7 | 16be223 | 「予定・活動」の検索カードで全入力欄がカードからはみ出す（日付入力の固有幅約192pxがグリッド最小幅を引きずる。240pxで+53px） → `TextField`/`TextArea`へ `w-full min-w-0` ＋240/200px幅の回帰テスト | APPROVE（デスクトップ不変・既存断言で担保） |
| 8＋9 | 1d4d10d・06f8840 | iOS Safariのdate入力だけ残るはみ出し。実機のcomputed style実測で `box=content-box`（authorのborder-box無視）→ **WebKit Bug 301648**（公認P2・iOS 26.5でも未修正）と確定 → date/time系inputへ `appearance:none`＋`::-webkit-date-and-time-value` 高さ対策（datetime-local拡張は再レビューの指摘で追加） | APPROVE（docs/03 §1.1-24記録・副作用許容） |
| 仕上げ波2 | 89e3978 | 「活動分析」（SCR-26）の「単位：出来事…」チップ（406px）でページ横スクロール → `Chip`へ `max-w-full`（赤: scroll421>client360 → 緑: 360=360） | APPROVE（`scrollWidth <= clientWidth` 断言への変更はエミュレーションで innerWidth が膨らむ件への正当な対処） |

- **capの扱い（Ruling）**: ループ上限（5）を超えたが、いずれも**ユーザーの実機確認が発見した相異なる実欠陥**であり、各修正が確実に収束して次の発見に進む＝T083の本体業務（「検証修正」）として継続を裁定。各ラウンドでスコープ付き再レビューを省略していない
- **一次情報の確認**（ユーザーの指摘により実施）: iOS date入力の幅計算問題は **WebKit Bugzilla #301648**（公認P2・iOS 26.5でも未修正）として裏付け。`appearance:none` は nuxt/ui #4712・Ionic PR#28495・actualbudget PR#6145 など複数フレームワークの定番対処。あわせてBug #198959（appearance:none時の空値の高さ崩れ）の定番対処も適用
- **診断手法**: 実機のcomputed styleを画面表示する一時オーバーレイ（ ActivitiesPage・撤去済み）＋ローカル計測プローブ（.superpowers配下・非コミット）。修正確認は実機の再読み込みで実施（修正後の実測: `filter-from w=325 over=-14 appear=none box=border-box`）
- **ローカル環境の変更（Git管理外）**: 実機アクセスのため `.dev.vars` の `AUTH_BASE_URL` をPCのLAN IPへ上書き（authのtrustedOriginsがlocalhostのみのため実機のログイン系が403になるため）。staging/productionはHTTPS単一URLのため影響なし

## 方針で残す（Rulingつきの全リスト）

1. **A低2 sync_recoverの手動再送クリックが握りつぶされ得る**（低）— Ruling: 自動同期が先に適用するのは設計どおりの競合（起動時即時・30秒周期）で、成否判定はサーバー検証読み（version=2・二重適用は検出可能）で確定している。手動再送導線の単独カバレッジはoffline-sync.spec（T077）が担う。コスト: 手動再送経路のe2eカバレッジが実行ごとに揺れる。実行ごとの経路の非決定性はV07-uxに記録済み
2. **C低1 AccessPanel:377の非管理者ゲートがwarning FORBIDDENのまま**（低）— Ruling: サーバー403応答の表示はAuditPanel/OperationsPanelともBanner **error** FORBIDDEN（role=alert）へ統一済み。クライアント側の事前ゲート（サーバー403応答ではない案内）は**warningを維持**＝語彙規則としてdocs/03 §1.1-23に追記済み（T083レビューround 1・C低の決着）。コスト: FORBIDDEN eyebrowがtoneで分かれる（規則は文書化済み）
3. **再レビュー範囲外1 fix reportのzoomMethod説明が実装より強い**（報告書のみ・低）— Ruling: 実装は依然無条件で"css-zoom-injected"を返すが、goto後注入で破棄経路自体が消えておりF1の実質は解消済み。報告書はworkspace内のみで正本（V07-ux・本書）に影響なし
4. **再レビュー範囲外2 V07-ux:7の「SHAは本ファイルの直後のgit logで確認できる」の読みにくさ**（低）— Ruling: コミット自身のSHAをそのコミット内のファイルに書けない（自己参照問題）ための回避表現。次にV07-uxへ触る際に言い直し。コスト: なし（F9の要件＝実装コミット7bb8d08の併記は満たす）
5. **最終検証の受入基準と残存フレーク**（ラウンド4後のRuling）— Ruling: ①最終HEADでフルe2e2回連続緑、または②失敗が記録済み既知フレーククラス（documents題名消失〔稀・30秒で明確に落ちる・単独緑〕／reports・facility-location・notificationsの1回off）に限られる場合、PH7前例（87成功＋既知flap型1件の正直記録）どおり受入とする。結果は①＝**2回連続94 passed / 3 skipped / 0 failed**。documents題名消失の稀な再発（粘着fill導入後12回中3回）の引き金は未特定〔再マウント/再レンダリング競合と推定〕で、発火時は検証エラー画面が残るため切り分け易い。次にdocuments.specまたは当該画面へ触る際の調査継続を推奨。コスト: フル走行で稀な赤が残る（単独緑での切り分け手順はph8.md「既知フレーキー」節）
6. **未触specの1回off（reports・facility-location・notifications）はT083では修正しない**（低）— Ruling: T083の割当はdocuments.spec（ph7-review #9）であり、inspection-templatesは最多頻度（約40%）のため例外的に同時修正した。残り3specは発火1回ずつで、次に触る担当（T085の統合試験整備が妥当）へ記録。コスト: フル走行で約1回/7実行の1-offフレークが残る
7. **実機確認（LAN平文http）で見つかった欠陥の修正をループ上限を超えて継続**（ラウンド5〜9＋仕上げ波）— Ruling: いずれもユーザーの実機確認が発見した相異なる実欠陥（auth拒否・UUID クラッシュ・入力欄はみ出し×2・iOS日付入力）で、各修正が収束して次の発見に進む＝T083の本体業務（「検証修正」）。各ラウンドでスコープ付き再レビュー実施。コスト: 実機確認が続く限りラウンドが増え得る（収束は確認済み）
8. **iOS日付入力の`appearance:none`**（ラウンド8・ユーザー承認済み）— iOS Safariのネイティブ描画がauthorのbox-sizingを無効にするWebKit Bug 301648（未修正）のため、date/time系inputをアプリ共通のフィールド様式で描画。docs/03 §1.1-24に記録。コスト: iOSでのネイティブ装飾（シェブロン等）が消える（タップ時のピッカーは従来どおり）
9. **検証用の `.dev.vars` 上書きと.ufw許可**（ローカル限定・Git管理外）— 実機確認のためAUTH_BASE_URLを実機アクセスURLへ上書き（authはtrustedOriginsで単一オリジンのみ信頼する設計のため）。コスト: ネットワーク構成が変わるたびにIP更新＋サーバー再起動が必要
10. **e2eのwebServerに `--var AUTH_BASE_URL` を固定**（ラウンド7）— ユーザーの.dev.vars（LAN IP）がe2eのsame-origin検査を壊すため、ローカルe2e限定でlocalhostへ固定（--var > .dev.vars > wrangler.jsonc）。コスト: なし（e2eの再現性はむしろ向上）

## 誤り・対象外
A担当のR1検証（principal.ts:112の`unitId: row.unit_id`・purgeのuserId単位・scope切替3箇所の網羅・authorization allowlistの目的不変）は**誤りなし**で合格。C報告はprototype本体の実grepで「管理パネルの403表現・費用語彙は無し」を再確認（docs/03 §1.1-23の記録と一字違わず）・新規specの断言语彙を全量照合（捏造なし）。D報告はdocs/05 API-01×DTO・docs/03 §1.1-22/23×実コードを文単位で一致判定、docs/12は対応表のみでT083記載済み＝更新不要と根拠つき判定。

## 最終状態

- 確認済みの高・中の未解消: **0件**（修正ラウンド9＋仕上げ波2・再レビュー9回。うちラウンド5〜9＋波はユーザー実機確認で発見した実欠陥の修正）
- 指摘総数: 高1 / 中5 / 低10 / 要確認7＝**修正したのは高1＋中5＋低10＋要確認4**（残りは方針で残すまたはサイクル完了で解消）＋**最終検証で発覚した既知フレーキーの根因修正2件**（documents.spec題名消失〔ラウンド3〕・inspection-templates非ポーリング断言〔ラウンド4〕）＋**実機確認で発見した実欠陥修正6件**（UUID〔ラウンド5＋波〕・狹幅はみ出し〔ラウンド7〕・iOS日付入力〔ラウンド8＋9〕・活動分析チップ〔仕上げ波2〕）
- 産出物: docs/evidence/ph8-review.md（本書。サイクル正本）＋docs/16:40のPH8要約文確定＋docs/16:177 T083状態欄（実数・局所の理由）＋docs/03 §1.1-24（iOS date入力の逸脱記録）。コミット **45ebc33**・**9dd61ad**・**38922d4**・**3b8a56a**・**e6d1301**・**af0426d**・**16be223**・**1d4d10d**・**06f8840**・**89e3978**
- 最終全検証（コントローラ実行・89e3978時点）: `npm run typecheck` 成功／`npm run check:contracts` **102 API / docs/05 102行 / OpenAPI一致**／`npx vitest --run` **65ファイル294件成功**／`npm run build` 成功（precache 9 entries）／`npm run test:e2e` **最終HEADでフル2回連続 103 passed / 3 skipped / 0 failed**（約12分/回。94→103はラウンド5〜仕上げ波2で追加した回帰試験の分）。`npm run test:load`・`npm run check:coverage`はT085/T086の範囲のため未実施（ユーザー指示）
- 局所完了の残手順（実端末〔VoiceOver/TalkBack・実PWA install〔HTTPS要〕・quota・実回線〕・全SCRのaxe走査・人による5名再訪計測）は **ops/device-test-matrix.md §2**の番号付き手順。docs/16:177に局所の理由として明記済み。NFR-01/02/09の実機部分・RG-02/RG-07を実機部分を含め合格とは扱わない。なお**実機確認（LAN平文http・iPhone Safari）は実施済み**で実欠陥6件を修正（上記ラウンド5〜9＋波。ph8.md「実機確認」節参照）
