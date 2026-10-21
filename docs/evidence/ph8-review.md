# PH8 レビュー・修正サイクル（T083: 2026-10-18〜19／T084: 2026-10-19。T084は末尾の節）

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

---

# T084 レビュー・修正サイクル（2026-10-19）

T083と同じ手順。対象はT084「外部障害・通信断・管理者不在の代替運用」。範囲は **609d67e**（T083完了）〜 **a9b0d47**（実装）と関連docs、修正は a9b0d47..114a32c。レビュー担当は読み取りのみ。指摘はメインのエージェントが実ファイルで確かめてから分類した（例: B-I2の誤適用はdocs/16の該当行を直接確認）。作業記録の副本はworkspace（.superpowers/sdd/16_実装タスク一覧/task-84-*.md）。

## 開始時の裁定（R1〜R7）

R1 mainで直接コミット（T001〜T083の前例）／R2 6scenarioはローカル架空データで演習し、実外部の演習は「未実施」として区別／R3「別担当の再現」は人による再現を提案時TODOとし、runbookを書いていない別エージェントの机上照合で代替（同等ではない）／R4 障害注入はpage.routeと既存の試験手段のみ（新規endpoint・本番登録の試験APIなし）／R5 ops/security-response.md §7はstaging必須のため未実施として転記／R6 測定値（誤成功表示件数・唯一の指令系統扱い）の定義／R7 演習で見つけた実欠陥はT084内で修正。

## 第1回（4体並行）

A=正確さ・セキュリティ／B=完了条件・試験の妥当性／C=prototype準拠／D=docs整合＋runbookの机上再現（R3）。合計: **重要7（A1・B2・D4）／軽微 約15**。Cは承認。

| 観点 | 指摘（重要） | 対応 |
|---|---|---|
| A-I1 | runbookの `npx wrangler d1 execute … --yes-i-know` はwranglerに無いフラグ（`npm run migrate` 専用のガード）＝復旧コマンドが書かれたとおりに動かない | 全runbook・証跡のwranglerの行から削除（cost-alerts・security-response §7・V07-performanceにも同じ誤り）。d1 executeは環境管理者の読み取りSELECTに限定（9a03544） |
| B-I1 | 誤成功の検出器に陽性対照が無い＝「0件」が恒真の可能性を排除できない | 窓外のヒットを別記録し、手動帳票の「保存しました」を拾えたことを断言。配送結果の修正を外すと窓内の緑表示を1件検出して赤になることを実証（9a03544） |
| B-I2 | docs/16 T084手順3が [x] だが「紙/既存電話への切替と復帰照合の架空演習」は机上の表のみ | 手順3を未チェック＋理由。**round 1で完了済みT048の手順3に誤適用**→round 2でT048を609d67eの状態へ復元しT084へ付け直し（114a32c） |
| D-I1 | security-response.md:83 が古い帰属のまま＋残作業に担当タスクが無い（ph7-review D中1の再発） | 裁定R8で残作業①〜⑩に担当を付与（T086=①②⑦⑧⑨、T088=③④⑤⑥⑩）。T086節・T088節に1行ずつ追記 |
| D-I2 | 「管理者が全員回復不能」が行き止まり参照（参照先に手順が無い） | admin-handover・account-recovery §2-5とも「手順未整備（担当T086・V07未実施9）」と明記 |
| D-I3 | 紙からの復帰照合が前提（出動記録の登録・実績入力）と役割を欠き実行不能、点検訂正UIは未実装 | 前提の段・必要な役割を追記、点検訂正は「未実装のため管理者へ申告（T033残作業）」、代理参集の担当付与画面が無いことを新たに発見し未実施10（T088）へ |
| D-I4 | 「施設詳細の点検履歴で1件」を確認する画面が無い | 環境管理者の読み取りSELECTで確認する手順へ |

軽微のうち、A-M5（到達不明・失敗があっても緑の「配送の処理を終えました」）は裁定R10で**修正**: attentionトーン＋「要確認」を併記（docs/03 意図変更26、jsdom試験で赤→緑）。演習用管理者の後始末の堅牢化（A-M2）、監視の取りこぼし対策（A-M3）、注記のrole="status"（C1）、文言・ラベル・番号の整合（B-M1〜M4・D-M1〜M6）もround 1で同梱して修正（裁定R9。T083前例）。

## 再レビュー

- round 1（9a03544）: コード系は全件ADDRESSED・新規破損なし。docs系は B-I2 NOT ADDRESSED（T048への誤適用＝新規破損）、D-I1/D-I2/D-M6 PARTIAL
- round 2（114a32c）: 残4件すべてADDRESSED。`git diff 609d67e -- docs/16` の差分はT084関連（:40・T084行・T084節・T086/T088節の各1行）のみでT048に差分なし

## 方針で残す（Rulingつき）

1. **C3 通知注記（説明調）と出動注記（断定調）の文体差**（軽微）— Ruling: 欠陥ではない。両注記とも同じNotice部品・丁寧語・語「補助」で一貫。prototype原典の確認時に揃える。コスト: 文体差に気づく利用者がいる程度
2. **ops/cost-alerts.md:76,78 は staging で d1 execute の UPDATE/INSERT を使う**（再レビュー範囲外・軽微）— Ruling: 既存の停止解除手順でT084の範囲外。outage-runbookの「d1 executeは読み取りに限る」はT084の照会手順についての注記。次にcost-alertsへ触る際に注記の対象範囲を明確化。コスト: 読み手が両者を矛盾と受け取る可能性
3. **R11 最終ブランチレビュー**— Ruling: 単一タスクのため第1回4体並行（ブランチ全差分が対象）＋再レビュー3回を最終レビューとして扱う。コスト: 修正差分全体を一度に見る視点が無い（各再レビューで部分的に担保）
4. **Google Fonts停止でアイコンが英単語表示**（実装者の記録）— Ruling: 操作名（accessible name）には影響せず、フォント自前配信は配信方式の判断を要するため記録のみ（V07-outage）。コスト: 障害時に見た目が崩れる

## 最終状態

- 確認済みの高・中の未解消: **0件**（修正2ラウンド・再レビュー3回）
- コミット: **a9b0d47**（実装）・**9a03544**（round 1）・**114a32c**（round 2）
- 最終全検証（コントローラ実行・114a32c時点）: typecheck成功／check:contracts 102一致／vitest **66ファイル297件**／build成功／フルe2e **2回連続 105 passed / 3 skipped / 0 failed**（その前の1回は既知フレーキーのdocuments.spec desktopで1 failed＝ph8.md「既知フレーキー」に再発記録）
- 局所完了の残作業: V07-outage.md「未実施」1〜10（担当T086/T088）。NFR-04を合格とは扱わない

# T085 レビュー・修正サイクル（2026-10-19〜20）

T083・T084と同じ手順。対象はT085「全54受入・17共通・18継続シナリオの統合」。範囲は **ceea8b5**（T085b追加）〜 **a855bc3**（実装）と関連docs、修正は a855bc3..52e9bf6（f4288f7＝e2eポート移動を含む）。レビュー担当は読み取りのみ。指摘はメインのエージェントが実ファイルで確かめてから分類した（A-I1〜I3・B-I1/I3/I5・D-I1/I2を直接確認）。作業記録の副本はworkspace（.superpowers/sdd/16_実装タスク一覧/task-85-*.md）。

## 開始時の裁定（R1〜R11）

R1 mainで直接コミット／R2 ゲート＝manifest（AT×CT・TC・API・SCR・journey・外部残手順）＋静的検査check:coverage＋実行結果のindex（collect:evidence）を codeHash でコードと結び、古いindexは全件「未実行」で赤／R3 実外部・実端末・人の部分は external に分離し合格に数えない（T085は局所完了・RG-03合格ではない）／R4 test:liveはSecret無しで「未実施」、test:loadは収集に含める／R5 欠落は実テストで埋め、発見した欠陥は所有タスクで修正し記録／R6 e2eの高速化・並列化・作り直しはT085b／R7 未解決の高・重大はissues台帳から判定／R8 documents.spec「題名消失」の作り直しはT085b／R9 ID集合は正本（docs/08・12・契約台帳・SCR一覧）から機械抽出し、APIは台帳の102件を正／R10 check:coverageをCIとAGENTS.mdへ／R11 4体並行レビュー。

## 第1回（4体並行）

A=正確さ・セキュリティ／B=ゲートの妥当性＋対応付けの空洞の標本監査（AT×CT 21組・TC 18件・API 10件・SCR 5件以上）／C=prototype準拠／D=docs整合・局所完了の書き方の正直さ。合計: **重要11（A4・B5・D2）／軽微19**。Cは承認。

| 観点 | 指摘（重要） | 対応 |
|---|---|---|
| A-I1 | 「訂正済み」を isCurrent=false で表示。seriesは対象ごと1本で新規点検でも現在版ポインタが移るため、訂正していない古い点検が全て「訂正済み」 | `supersededById` で判定（サーバー副問合せ・共通部品InspectionHistory）。2件以上の点検で断言。docs/05 API-44/51の文言訂正 |
| A-I2 | 異常ありの点検を訂正すると異常が二重起票（docs/11 §3違反） | 画面は異常の新規発生時だけ起票。サーバー側の防止は第2回N3→第3回R20 |
| A-I3 | API-46の権限判定がクライアントの `inspectorMemberId` だけ＝団員が他人の点検を訂正し実施者を自分に差替え可能（既存T031欠陥が新画面で到達可能に） | 保存済み原本の実施者でもPER-04を判定（同期API-81も同じ関数）。試験は旧コードで201＝赤。T031の行に記録 |
| A-I4 | D4/D5に回帰試験なし。D5はクライアントの逐次取得（2,000件超で再欠落） | API-15に `order=oldest\|newest`（cursorを並びに束縛。契約3点）＋逐次取得を撤去、jsdom/vitest。D4は長い団員名の決定的e2e |
| B-I1 | 失敗したスイートの index でもゲート緑（`!== "notRun"`） | 各スイートの最新実行が passed かつ failed=0 を必須。陽性対照 |
| B-I2 | @project無しのe2e参照が片方のプロジェクトの記録だけで緑 | phone-360・desktop-1280の両方の合格を必須（裁定R14）。陽性対照 |
| B-I3 | AT-DASH-01×CT-05 の notApplicable が docs/08 に反し根拠も誤り | 削除し、出欠の途中失敗でAPI-28の数値が不変の試験を追加（notApplicable 0） |
| B-I4 | CT-05の空洞（ACT-01/ACT-03/COM-01/AST-05/DSP-03は共通部品の試験の借用・DOC-01/AI-04は一部） | 各機能のrouteのbatchを途中の文で失敗させ、原本・履歴・監査・outbox・冪等記録が不変の試験を追加（裁定R15） |
| B-I5 | TC-05/AT-MAP-02で格納箱（box）が一度も描画・断言されない | 3種をseedし種別チップ・accessible name・一覧の文字を断言 |
| D-I1 | docs/16 T030/T033・§1・docs/12が「未実装/残作業」のまま | 見出しと本文を更新（旧文は「当時:」） |
| D-I2 | ph8.md T085節に参照先の「最終検証」と局所の理由が無い | 両小節を追加（RG-03合格ではないと明記） |

第1回の修正中に新たな欠陥3件を発見・修正: **D6**（初回PUTの途中失敗が404〔T004/T036〕）、**D7**（R2成功後DB失敗のstaging実体が残る→回収sweep〔T017〕）、**D10**（9つのグリッドで長い団員名がphone幅を725pxに広げる〔T013ほか〕）。軽微（文言のdocs/03記録・JST日付・TC抽出0件の検出・PARAM照合の厳密化・RED件数76への訂正ほか）も同梱（裁定R16）。

## 再レビューと修正ラウンド2・3

- round 1（b4f4271）: 重要11件のうち10件ADDRESSED、D-I1 PARTIAL。新規の重要: **N1** D7の孤児回収が毎分staging/の先頭1,000件だけを読み直し続き位置を保存しない（1,000件目以降の孤児に永久に届かない）／**N2** D6・D7・D10が所有タスクの行に未記録／**N3**（範囲外所見を昇格・裁定R17）訂正のcreateIssueをサーバーが制限しない
- round 2（f4288f7・e50c98d）: ユーザー指示でe2eサーバーを8797番へ移動（裁定R19。別プロジェクトと8787を共用していたため。demoは8787のまま）。N1は続き位置をR2に保存し15分ごと・上限つき、N2は各所有行へ記録、元の実施者が休団・退団でも訂正を通す（裁定R18）。新規の重要: N3の422が画面と判定範囲がずれて**行き止まり**（異常あり→良好→異常ありの訂正が画面からも同期下書きからも保存不能）
- round 3（52e9bf6）: 裁定R20＝系譜で既に起票済みなら `createIssue` を**無視して保存**し、保存応答の `createdIssueId` と画面の保存後表示で実際の結果を示す。系譜照合はD1のbind上限内（45件ずつ）、古い版の訂正は409が先。再レビューで全件ADDRESSED

## 方針で残す（Rulingつき）

1. **R21 docs/05 API-46とph8.mdの「createdIssueIdはAPI-44/51の点検記録にも付く」**（round 3再レビューの軽微）— Ruling: 事実誤り（両SQLは未変更）。コントローラが最終docsコミットで記述を訂正（docs/05・ph8.mdはcodeHashの対象外で再収集不要）。コスト: レビューを経ない1文の訂正
2. **保存後の起票結果の表示が location.state 由来で、再読込・戻る/進むで再表示される**（軽微）— Ruling: 誤った内容ではなく同じ結果の再表示。次に詳細画面へ触れる際に消去処理を入れる。コスト: 利用者が同じ通知を再び見る
3. **系譜の2チャンク目（46世代目以降）の異常検出と、無視経路の同鍵再送の試験が無い**（軽微）— Ruling: コード上は正しい（slice分割・requestHashは生の入力から計算し保存済み応答を返す）。コスト: 将来の回帰を試験で捕まえられない
4. **系譜の遡りは50世代で打切り・1世代ずつ最大50照会**（範囲外・以前からの仕様）— Ruling: 51回以上の訂正の連鎖は架空データでも現実的でない。コスト: 極端な連鎖での二重起票防止の欠落
5. **R22 最終ブランチレビュー**— Ruling: T084 R11と同じく、第1回4体並行（全差分）＋再レビュー3回を最終レビューとして扱う。コスト: 修正差分全体を一度に見る視点が無い
6. **documents.spec「題名消失」**— Ruling: 作り直しはT085b（R8）。T085の収集では3回中2回発火し、`--only=e2e` で同じコードを再実行して記録（旧実行はdiscardedRunsに保存）。コスト: フルe2eが不安定なまま

## 最終状態

- 確認済みの高・中の未解消: **0件**（修正3ラウンド・再レビュー3回）
- コミット: **a855bc3**（実装）・**b4f4271**（round 1）・**f4288f7**（e2eポート移動）・**e50c98d**（round 2）・**52e9bf6**（round 3）
- 最終全検証（コントローラ実行・52e9bf6時点）: typecheck成功／check:contracts 102一致／check:coverage 成功（参照テスト272件）／build成功／vitest **67ファイル322件**／フルe2e（業務119＋受入ゲート75）**2回連続 194 passed / 3 skipped / 0 failed**（14.8分・14.6分。e2eサーバーは8797番）。証跡index（collect:evidence・52e9bf6のコードと codeHash 一致）: vitest 322・load 3・業務e2e 119 passed / 3 skipped / 0 failed・test:live 未実施（Secret未設定）
- 局所完了の残作業: acceptance-results.md の external 29件（担当T086/T087/T088）。T085の開発版ゲートは緑だが **RG-03合格ではない**

# T085b レビュー・修正サイクル（2026-10-20）

T083〜T085と同じ手順。対象はT085b「e2e試験の高速化と試験間の分離」。範囲は **0d21ca3**（T085完了）〜 **a047569**（実装69279d7・68b5328・4ad6883・4c2f176・39fcef1＋コントローラdocs）と関連docs、修正ラウンドは **db8db32・b673d36・cd6b549**。レビュー担当は読み取りのみ。指摘はメインのエージェント（コントローラ）が実ファイル・実ログで確かめてから分類した。作業記録の副本はworkspace（.superpowers/sdd/16_実装タスク一覧/task-85b-*.md・t085b-*.log・ph8-review-t085b-{A,B,C,D}.md・task-85b-rereview-fix{1,2,3}.md）。

## 工程と実装者サブエージェントの役割分担

実装はサブエージェント2体（①分離＋既知フレーキー作り直し＝69279d7、②高速化〔候補①〜⑤〕＝68b5328）。コントローラが基準計測（M0）・workers=2赤観測（M1）・目標値決定（R5）・各計測（M2/M3/M3'）・最終検証を担当。タスクレビュー×2（各dispatch直後・Spec✅/品質承認）＋スコープ付き再レビュー3回（fix round 1〜3）＋最後に4体並行レビュー。

## 開始時の裁定（コントローラ。台帳から）

R1 mainで直接コミット・workspace継続／R2 幅絞り込みと「skip件数を増やさない」の両立〔test.skipを増やさずプロジェクトスコープ除外＋manifestの@project付与。skip 3→0は可〕／R3 多件データ試験の保持〔D4/D5回帰を分離で消さない〕／R4 T085b担当中の課題台帳3件〔FLAKE-1・FLAKE-2・PH3-T〕を範囲に含める／R5 目標値≤6.0分（基準14.8分比-59%以上。基準計測後に決めて固定）／R6 繰り延べMinor3件はM3記入と同時にfix round 2で処理／R7 M3の2失敗と停止滞留はT085b本体（試験基盤の安定化）として対応・計測やり直し（M3'）／R8 docs/16の「完了」前倒し撤回〔実装完了→最終検証後に完了確定〕／R9 issues台帳方針〔PH3-T/FLAKE-2=resolved・FLAKE-1=openのままbasis更新・T085b-W1（low）新設〕／R10 triageのバックティック題名対応／R11 補助計測の証跡保存（smoke×3・build×3を再計測）／R12 報告書の「指数バックオフ」誤記はworkspace訂正のみ。

## 第1回（4体並行。0d21ca3..a047569）

A=正確さ・セキュリティ／B=docs/16完了条件と試験の妥当性／C=prototype準拠／D=docsと実装の整合。合計: **Important 4（B1・D1〜D3）／Minor 11／要確認 2**。Cは承認。

| 観点 | 指摘（重要） | 対応 |
|---|---|---|
| B-1/D-1/D-2 | docs/16が最終検証（collect:evidence再実行＋最終HEADでフルe2e3回連続緑）前に「完了」記帳。ph8.mdの最終検証・レビュー節が空欄のままの完了宣言は様式不整合。ゲートcodeHash赤（collect:evidence未再実行）もdocs/16残作業に載っていない | 状態を「実装完了（最終検証とレビューサイクル確定後に完了確定）」へ訂正（cd6b549）。最終検証後に完了確定〔この節の最終状態〕 |
| D-3 | manifest issues台帳が本diffで無更新（PH3-Tがopenのまま・FLAKE-1/2のbasis陳腐）。R7「未解決はissues台帳から判定」でT088の判定を歪め得る | R9のとおり更新: PH3-T/FLAKE-2=resolved、FLAKE-1=openのままbasis更新（抑止・根因未特定）、T085b-W1（low・open・owner T086）新設。--report-onlyでacceptance-results.md作り直し（b673d36） |

Minor（全て修正または繰り延べ。修正はcd6b549・db8db32）: e2e-speed.mdの件数55/53→58/58（A-F1）・execute.ts行参照の訂正〔一件化は:220〕（A-F2）・ph8.md M0行に1f欠け（A-F3）・acceptance実行約14秒→9.4〜12.1秒（A-F5）・triageのバックティック題名非対応の理論穴（A-F7→db8db32）・docs/16 checkbox未整備（B-2）・t085b-m3.shのdrift（B-3。コントローラが復元）・④tablet除外の根拠が推論であることの注記（B-4）・ph8.mdの二重計上（D-4）・e2e-speed.mdへの残作業追記（D-5）・ph8.md T083節「根因ごと修正」の陳腐化注記（D-6）・補助数値の証跡注記（A-F4/R11）・pwa-cache phone見出し語彙の将来注意（C-1）。

## 方針で残す（Rulingつきの全リスト）

1. **FLAKE-1 documents「題名消失」の根因は未特定のまま**（medium・open）— Ruling: 回復ループ（検証エラー確認後のみ再fill・再押下×3）＋ACL先出し＋ドロップ吸収で抑止し、本物の作成失敗は赤のまま（無条件リトライではない）。M0基準3回中3回発火→M3'（4ad6883）以降は未発火。次にDocumentEditorへ触るタスクが調査を引き継ぐ（台帳owner=T085bのまま・basisに記録）。コスト: 根因不明の稀な赤の可能性が残る
2. **wrangler 4.150 ProxyWorkerドロップは一部specのみ吸収**（low・open=T085b-W1）— Ruling: 上流問題（#14926/#15252）でCLI調整不可。署名限定・有界3回・同一冪等鍵のヘルパをissues 6書き込み＋documents作成へ適用し、残存クラスの署名・切り分け手順をe2e-speed.mdに記録。他specのawaited書き込みで発火したら同ヘルパ適用を検討（T086がフル走行を回す）。Playwrightのretries設定は使わない（失敗の意味を変えるため）。コスト: 未適用specでの稀な赤
3. **webServer停止滞留（M3 run3のみ実経過38分）は経過観察**— Ruling: その後4走行で未再現・設定での決定的対処なし。壁時間とPlaywright報告値の差で検知する（所要時間の正はPlaywright報告値）。コスト: 稀に停止待ちで壁時間が膨らむ
4. **triageの宣言解析は静的解析**（low）— Ruling: 宣言直上の「幅:」マーカーを正本とし、マーカー無し・孤立・未消費は例外で落とす（fail-fast）。テンプレートリテラル内の動的題名は対象外（本リポジトリは静的題名のみ・db8db32でバックティック自体は対応）。コスト: 動的題名の試験を導入する場合は手動でマーカー管理
5. **pwa-cache の phone幅見出し語彙はdesktop限定化で断言先が無い**（low）— Ruling: 描画待ちの吸収は断言対象外という仕分け基準の範囲内。将来この語彙（マップ・団員名簿・お知らせ）を変えるときはphone幅の確認を別途入れる（e2e-speed.mdに注記済み）。コスト: 語彙回帰の自動検出なし
6. **④tablet除外のanalytics_conditions根拠は360実測＋幅の単調性からの推論**（low）— Ruling: 406px未満でしか起きない回帰の性質上、768では恒真。実測でなく推論であることをe2e-speed.mdに注記済み。コスト: なし

## 最終状態

- 確認済みの高・中の未解消: **0件**（4体並行レビュー→修正ラウンド→再レビュー全件ADDRESSED。タスクレビュー×2・スコープ付き再レビュー3回）
- コミット: **69279d7**（分離＋フレーキー作り直し）・**68b5328**（幅絞り込み・workers=2・smoke・manifest）・**4ad6883**（ドロップ吸収・popup待ち）・**4c2f176**（tripwire強化）・**39fcef1**（証跡docs確定）・**a047569**（コントローラdocs）・**db8db32**（triageバックティック）・**b673d36**（issues台帳）・**cd6b549**（レビュー対応docs）
- 最終全検証（コントローラ実行・最終HEAD時点）: typecheck成功／check:contracts「102 API / docs/05 102行 / OpenAPI一致」／check:coverage成功（参照テスト272件）／vitest **67ファイル322件**合格／build成功（precache 9 entries）／**M4フルe2e 3回連続緑（run1 148 passed / 0 skipped / 0 failed（6.0分）・run2 148 passed（5.8分）・run3 148 passed（5.7分）＝**3回連続緑**〔148＝業務73＋受入ゲート75。skip 0＝旧3件は幅仕分けへ移行〕）**
- 証跡index（docs/evidence/acceptance-index.json。codeHashは最終コードと一致＝ゲート緑）: vitest 322・test:load 3・e2e 73 passed / 0 failed / 0 skipped・test:live未実施（Secret未設定）。1回目の収集はvitest 1 failed〔auth-adapterのTOTP試験＝テスト環境でIP判定不可のauthレート制限バケット（sign-in 5回/60秒等）とファイル内連続auth呼び出しの競合。本日2回目の稀フレーキーでT085b差分とは無関係〕→ 裁定R13で`--only=vitest`によりスイート全体を同じコードで再実行（旧実行はdiscardedRunsに記録）＝緑。ゲート緑〔missingReq=0・skippedOrUnexecuted=0・criticalOrHigh=0〕
- T085bの成果: フルe2e中央値 **14.8分→5.7分（-61.5%・2.60倍）**・実行122→73件・skip 3→0・業務コードsrc/無変更・網羅（check:coverage 272件）不変

# T086 レビュー・修正サイクル（2026-10-20〜21）

T083〜T085bと同じ手順。対象はT086「架空データの完成版・公開デモ分離・操作説明」。範囲は **a859e3e**（T085b完了）〜 **da22779**（実装bde6533〔コア〕・8ec9f26・08b523d〔PH1-A2〕・198f792〔PH2-C15〕・0d2fed3〔PH4-B2〕・ead8421〔PH7-L〕・bcc7404〔PH1-C〕・1b0d76d〔PH2-C19〕・f0c4212〔PH3-C8〕・47fdb84・f703c13〔X-OUT-9〕・d891443・3ed5fc2〔docs/manifest〕・da22779〔使い方ガイド画面〕）と関連docs、修正ラウンド（fix wave 1）は **c374e4c・e233138**。レビュー担当は読み取りのみ。指摘はコントローラが実ファイル・実ログで確かめてから分類した。作業記録の副本はworkspace（.superpowers/sdd/16_実装タスク一覧/task-086-*.md・review-a859e3e..*.diff・ph8-review-t086-{A,B,C,D}.md）。

## 工程と実装者サブエージェントの役割分担

実装はサブエージェント5体（①コアTDD〔赤→seedDemo/verifyDemoIsolation→緑〕＝bde6533＋8ec9f26、②issues台帳medium 3件＝08b523d・198f792・0d2fed3、③issues台帳low 4件＝ead8421・bcc7404・1b0d76d・f0c4212〔利用制限で中断→同一セッション再開〕、④docs一式＝47fdb84〜3ed5fc2、⑤使い方ガイド画面＝da22779）。コントローラが要件の裁定（R14〜R25）・X-OUT-9とdocs 3点の担当割り・SHELL-HELP画面の範囲確定・最終検証を担当。タスクレビュー×4（各dispatch直後。D1のみfix round 1〔恒真断言〕＋再レビューADDRESSED）＋4体並行レビュー＋fix wave 1＋スコープ付き再レビュー。

## 開始時とルートの裁定（コントローラ。台帳から）

R14 PH4-B2は新規endpoint禁止〔T086対応欄〕のため既存APIの応答・要求拡張〔T085のAPI-44/51前例・契約3点セット〕で解消。不可能ならbasisに記して残す → 実装はAPI-67への`sent`要求拡張で解消〔check:contracts緑〕／R15 developmentIncompleteFeaturesは明示チェックリストの未達集計〔恒真禁止・T081前例〕／R16 D1レビューの「X-OUT-9・docs 3点未作成」はdispatch分割の帰属であってD1の欠陥ではない（文書系は専任dispatch。完了条件で検収）／R17 demoResetLeavesProductionUntouchedの恒真化はfix round 1で修正〔全件列挙断言へ・陽性対照実証済み〕／R18 SHELL-HELP（/app/help）はT086の範囲〔screens.ts:71のownerTask=T086・docs/03「内容はT086」〕＝D5で実装／R19 章順序はUSER_GUIDE〔内容の正〕優先（docs/16手順3の列挙は集合で順序指定ではない）／R20・R21 4体レビューのImportant 2系統＋Minor語彙・docs整合はfix wave 1へ繰り入れ（T085b R6前例・ユーザー指定フロー）／R22〜R25は下表。

## 第1回（4体並行。a859e3e..da22779）

A=正確さ／B=完了条件／C=prototype準拠〔承認〕／D=docs整合。合計: **Important 3系統〔F1証跡docsがda22779未反映＝B-I1/D-I1/D-I2/A-I1/A-M1/D-M1・F2 docs/03 §1.1のhelp記録欠落＝C-5〕／Minor 16〔統合後F3〜F16〕／要確認 6**。Critical 0。指摘統合と対応は workspace の task-086-findings-r0.md、修正はc374e4c＋e233138、再レビューで**F1〜F16・R23全てADDRESSED**。

| 観点 | 指摘（重要） | 対応 |
|---|---|---|
| F1（B-I1/D-I1/D-I2/A-I1/A-M1/D-M1） | 証跡docs（ph8.md T086節・docs/16実施記録・development-completion.md）が最終コミットda22779〔使い方ガイド画面〕を反映せず、docs/16のissues対応件数が「5件」（実際6件＝1b0d76d欠落）。検証表の「70ファイル332件」は旧時点値 | e233138: 3文書をda22779込みへ更新・件数訂正・数値は当日再実測値〔71ファイル334件〕を記載 |
| F2（C-5） | prototypeに個別デザインが無いヘルプ画面にdocs/03 §1.1の構成記録が無い（前例どおり記録すべき） | e233138: §1.1-28を新設〔共通部品構成・入口はスマホのみ＝prototype Desktop踏襲・語彙・試験〕 |

## 方針で残す（Rulingつきの全リスト）

1. **PC幅で不可視の選択シートがEscスタックに参加し、選択解除と右パネル詳細が閉じる**（low・C-3）— Ruling: コード変更はせず docs/03 SCR-03⑥へ意図化追記（e233138）。構造変更（可視時のみスタック参加）は実害薄・Esc規律の呼び出し点が広いため繰り延べ。コスト: PCのEscで詳細が閉じる挙動が残る
2. **「送信した通知」のcampaignアイコン**（要確認・C-6）— Ruling: 通知機能内の「下書き」チップの前例に従順でありprototypeのcampaign=お知らせ割当との競合は機能内で一貫。維持。コスト: prototype語彙との微差
3. **PCに使い方ガイドへの導線が無い**（要確認・C-7）— Ruling: prototype DesktopのnavGroupsに無く、URL直打ち・スマホメニューのみはprototype踏襲で意図的（docs/03 §1.1-28に記録済み）。コスト: PC利用者はユーザーガイド・管理者の案内に依存
4. **ead8421がPH7-Lの4項を1コミットに集約**（low・B-M4）— Ruling: 履歴の書換えはしない〔AGENTS.md・PH2-B12前例〕。理由記録はコミットと報告書にあり。parked。コスト: 1タスク1コミットの原則からのはみ出しの記録
5. **AuditPanel二要素ラベルがresult=failure行と読み分けられない**（low・D2 M5）— 繰り延べ（表示の磨き）
6. **InvitationPage/MfaPanelにログイン画面と同型の誤り関連付け未実装**（low・D3 M1）— 繰り延べ（LoginPageと同じ数行で揃えられる。次に触るタスクで）
7. **manifest PH1-A2 basisの散文語「サインイン」**（low・fix wave 1再レビュー）— Ruling: 画面ラベルは「ログイン」へ揃えた〔F8〕が、basisはサーバーイベントの記述で断言・利用者文面でないため直さない（直すならreport-only連鎖が要る）。コスト: なし
8. **useFacilitiesの「一覧無し/正しく空」区別・map-facilities試験のreload系計数・HelpPage章題の短縮表記・Notice文言・demo.ts初回判定の縁・demo.ts削除列挙が同期APIのみ・CLI内SQL補間**（low各件・D1〜D5の繰り延べMinor）— 各報告書と台帳に記録。次に触るタスクで処理候補
9. **T085b-W1（ProxyWorkerドロップ）はopenのまま継続観察**— Ruling: T086最終検証の4走行（collect:evidenceのe2e＋フル3回・75〜150件/回）で失敗0。上流（#14926/#15252）未解決のためstatus=open・ownerを外しbasisに記録。発火時はclickUntilWriteArrives適用。コスト: 稀な赤の可能性が残る
10. **T086の局所完了（実環境・実端末・実キー）**— Ruling: X-V01・X-V02・X-V05・X-DEV-MAPS・X-V06-RT・X-V07-PERF・X-V07-RENDER・X-DEMO・X-DEV-1/2/3・X-OUT-1/2/7/8とX-COST・X-V04-*/X-AIEVALのT086分は本環境では実施不能。番号付き残作業はacceptance-results「実外部」・ops/demo-deploy.md §5・development-completion.md §3が正。外部公開の実行は明示的な依頼がある時のみ。コスト: RG-09等の実地確認は未達のまま〔T087/T088へ〕

## 最終状態

- 確認済みの高・中の未解消: **0件**（タスクレビュー×4＋D1 fix round 1→ADDRESSED＋4体並行レビュー→fix wave 1→再レビュー全件ADDRESSED）
- コミット: **bde6533**（コア実装・指定試験）・**8ec9f26**（reset断言の恒真排除）・**08b523d・198f792・0d2fed3**（issues台帳medium 3件・API-67契約3点）・**ead8421・bcc7404・1b0d76d・f0c4212**（issues台帳low 4件）・**47fdb84・f703c13・d891443・3ed5fc2**（docs一式・X-OUT-9・manifest）・**da22779**（使い方ガイド画面）・**c374e4c・e233138**（fix wave 1）
- 最終全検証（コントローラ実行・2026-10-21）: typecheck成功／check:contracts「102 API / docs/05 102行 / OpenAPI一致」／check:coverage成功（参照テスト272件）／build成功（precache 9 entries）／collect:evidence〔vitest **71ファイル334件**・load 3・**e2e 75 passed / 0 failed / 0 skipped**・live未実施〕＋**受入ゲート 1 passed**／**フルe2e 3回連続緑〔150 passed ×3＝5.2/5.0/5.1分〕**
- T086は**局所完了**。issues台帳のT086担当8件を決着（resolved 6＋PH3-C8現状確認の記録〔N2はopen・owner未割当〕＋T085b-W1継続観察へ）。docs/16のT086状態欄・ph8.md「T086」・development-completion.mdに番号付き残作業

# T087 レビュー・修正サイクル（2026-10-21）

T083〜T086と同じ手順。対象はT087「完成後の消防団向け提案資料と確認差分表」。範囲は **85681e4**（T086完了）〜 **e6e13ce**（実装fd7bc72〔本体〕・99a05b8〔fix round 1〕・c54b58d〔fix round 2〕・a157696〔manifest台帳〕・57a77a4〔docs統合〕・e6e13ce〔fix wave 1〕）と関連docs。レビュー担当は読み取りのみ。指摘はコントローラが実ファイル・dry-runで確かめてから分類した。作業記録の副本はworkspace（.superpowers/sdd/16_実装タスク一覧/task-87-*.md・review-*.diff・ph8-review-t087-{A,B,C,D}.md・task-87-findings-r0.md）。

## 工程と実装者サブエージェントの役割分担

実装はサブエージェント3体（①コアTDD〔D1〕＝fd7bc72＋fix 2回〔検出器の語形網羅〕、②台帳決着〔D2〕＝a157696〔PH2-A12・external 7件〕、③docs統合〔D3〕＝57a77a4）。コントローラが裁定（R1〜R7）・4体並行レビューの実検証・fix wave 1の指摘統合・最終検証を担当。タスクレビュー×3（D1のみfix round 2回）＋4体並行レビュー＋fix wave 1＋スコープ付き再レビュー。

## 開始時の裁定（コントローラ。プリフライトスキャンより）

R1 exampleの鍵構造はD01〜D20過不足なく＋推奨案/代替案/回答記入欄/approved既定false（T088のDecisionRecordが参照できる形）／R2 PH2-A12は実コード確認の上でPH3-C8前例（現状確認の記録）またはresolvedで決着／R3 external項目のT087分は棚卸し＝提案資料で未実施と明記しmanifestのowner/basisを実態へ（実行はT088・実環境数値は捏造禁止）／R4 check:adoption-proposalスクリプトをpackage.jsonへ追加（T086 R14前例）／R5 新規試験はmanifestに登録しない（demo-isolation前例）／R6 引用数値は既存証跡の実測のみ＋出典＋「ローカル実測」「概算」の区別／R7 完成版URL＝ローカルdemo手順を実在する確認手段として示し実環境URLは未実施と明記

## 第1回（4体並行。85681e4..57a77a4）

A=正確さ・セキュリティ／B=完了条件・試験妥当性／C=prototype準拠／D=docs整合。合計: **高1 / 中7 / 低19 / 要確認2**（高・中はコントローラが全件実検証）。指摘統合と裁定は workspace の task-87-findings-r0.md、修正はe6e13ce、再レビューで**F1〜F8全てADDRESSED**。

| 指摘 | 内容（代表） | 対応（e6e13ce） |
|---|---|---|
| F1（D-高1） | チェックリスト・example.jsonのD01質問「地図の詳細表示（MAP-10）」が要件正本（docs/01:62「地域単位の点検巡回計画を支援する」）と矛盾。AI-06/07も不正確 | docs/01正本どおりの質問へ（両ファイル）＋JSON↔チェックリストの質問一致検査を新設（改変で落ちる対照つき） |
| F2・F3（A-中1/2） | 検出器が「未承認ではなく$5に本決まり」型（否定導入後に別承認語）と「承認を得ている」「了承が済んだ」「合意に至りました」等の自然文体を素通り（レビューAがdry-runで実証） | 断定語彙+否定導入後の語幹単独形検出+否定随伴語のラベル無効化／活用へを得ている・が済んだ・に至りました等14形を追加。陽性対照9・10で恒久化 |
| F4（A-中3） | example.jsonの型検査欠落（approvedが1や"false"、回答が数値/配列でも通る） | approvedはboolean false厳密一致・回答は空文字列のみ。対照12で改変検出を実証 |
| F5（C-中1） | 提案資料§3全機能動線に施設の点検登録（SCR-06）と予定の登録（SCR-10）が無い | 実装語彙どおり2動線を追加（screens.ts・InspectionFormの実ラベルと一致を再レビューが検証） |
| F6（D-中1） | manifest external のX-V04-JEV/LLM/RET・X-AIEVAL注記にX-COST用の「T086分（デモ費用上限等）…とも実施済み」が不当コピーされ手順本体の実施と誤読される | X-V04系/X-AIEVALは「T087分（提案資料での未実施明記）は完了。実行は未実施・T088」へ。X-COSTはT086分の実態（デモへの費用上限適用とMaps割当手順の整備）を正確に分離。--report-only再生成 |
| F7（D-中2・C-要確認1） | 提案資料「自動試験が全部通っています」が現HEADのreport（codeHash陳腐化でゲート赤）と瞬間不整合 | 「本資料作成時点〔2026-10-21〕の収集で全て合格。最新は acceptance-results.md」の時点限定+参照へ |
| F8（低8件同梱） | チェックリスト未知D行検出・英語承認語・局所完了但し書き・SSE/DO・RTO/RPO・p95平易化・影響列「照合用」明示・script出典節名（docs/09→docs/13 §5）・development-completion §4へPH2-A12解消記録・費用表記統一 | 全実施（いずれも小変更。対照11・13つき） |

## 方針で残す（Rulingつきの全リスト）

1. **A-低4 提案§2「ポート8797」の出典にその数値が無い** — Ruling: 出典はe2e環境の説明として正しく、ポート番号の正本（scripts/e2e-port.ts）への依存は文面で足りる。次に提案資料へ触る際に文面候補 — コスト: なし
2. **A-低5 AT表行末の「・T088」owner重複表示** — Ruling: --report-onlyの生成様式で「未実施。合格に数えない」表内であり誤解を生まない。繰り延べ — コスト: なし
3. **D-低 example.json各Dに「未承認」の語が無い** — Ruling: meta（版・日付・未承認明記）とapproved:false・チェックリスト側の明記で担保。繰り延べ — コスト: なし
4. **検出器の記録済み限界**（文単位ホワイトリストの同一文第2主張抑止=安全側・否定構文の正当文誤検出の可能性=安全側・未承認値トークン6種・D04/D05/D18の複合質問=docs/14踏襲・使役形/文末語幹単独/謙譲形/可能形） — Ruling: scriptヘッダーと報告書に文書化済み。文書を機械検査で完全に縛ることはせず、安全側（過検出）に倒している — コスト: 将来の文言変更で検出を抜ける余地が残る
5. **A-要確認1 X-V04-*/X-AIEVALの提案資料での提示は総称か** — Ruling: 提案資料は利用者向け文書でX-ID羅列は不向き。総称（§4費用・§5のD12・§6残手順）で足りる。ID単位の正はacceptance-results.md — コスト: なし

## 最終状態

- 確認済みの高・中の未解消: **0件**（タスクレビュー×3＋D1 fix round×2→ADDRESSED＋4体並行レビュー→fix wave 1→再レビューF1〜F8全ADDRESSED・新規Critical/Important無し）
- コミット: **fd7bc72**（本体・指定試験）・**99a05b8**（fix1: 検出器の包括文・変形・否定形）・**c54b58d**（fix2: 丁寧形・受動形・します形）・**a157696**（manifest: PH2-A12 resolved・external 7件）・**57a77a4**（docs/16・ph8.md・development-completion）・**e6e13ce**（fix wave 1）
- 最終全検証（コントローラ実行・2026-10-21）: typecheck成功／check:contracts「102 API / docs/05 102行 / OpenAPI一致」／check:coverage成功（参照テスト272件）／build成功（precache 9 entries）／check:adoption-proposal exit 0／collect:evidence〔vitest **72ファイル335件**・load 3・**e2e 75 passed / 0 failed / 0 skipped**・live未実施〕＋**受入ゲート 1 passed**／**フルe2e 3回連続緑〔150 passed ×3＝5.3/5.3/5.5分〕**（業務75＋受入75。計測過程でasset-inspection 1件の一過性失敗あり＝単独緑・以後4走行で未再発・ph8.md「T087」最終検証節に記録）
- T087は**完了**（資料作成タスクで実環境手順はT088/実環境帰属のため局所完了ではない）。提案資料2点とテンプレート・検査・指定試験が揃い、D01〜20を一項目一回答で確認できる。実団体への提出・回答記録・正式リリース判定（RG-08・RG-10）はT088

# T088 レビュー・修正サイクル（2026-10-21）

T083〜T087と同じ手順。対象はT088「導入回答の反映・再試験・正式リリース判定」。範囲は **a897ad2**（T087完了）〜 **925da08**（実装19c9430〔本体・指定試験〕・ee067c9〔判定文書・runbook・docs整合試験〕・b8df963〔manifest台帳決着〕・b72c290〔production-policy.json陳腐化修正〕・925da08〔docs統合〕）と関連docs。レビュー担当は読み取りのみ。指摘はコントローラが実ファイル・実コードで確かめてから分類した（A-3の否定形経路は実コード読みで本物と確認）。作業記録の副本はworkspace（.superpowers/sdd/16_実装タスク一覧/task-88-*.md・review-*.diff・ph8-review-t088-{A,B,C,D}.md・task-88-findings-r0.md）。

## 工程と実装者サブエージェントの役割分担

実装はサブエージェント3体（①コアTDD〔D1〕＝19c9430＋JSON陳腐化の再開修正b72c290、②判定文書と台帳〔D2〕＝ee067c9＋b8df963、③docs統合〔D3〕＝925da08）。コントローラが裁定（プリフライトスキャン9項目）・タスクレビュー×3の⚠️解決・4体並行レビューの実検証・fix wave 1の指摘統合（F1〜F9）・最終検証（フレーク2件の診断と対策dispatchを含む）を担当。

## 開始時の裁定（コントローラ。プリフライトスキャンより）

R1 実回答が存在しないため、指定試験は合成入力で恒久化し実ファイル（回答空欄+全ゲート不合格+decisions空）はallowed:falseを断言する正直アンカーとして追加／R2 production-policy.json新設はadoption検査（exampleのみ走査）と干渉なし。捏造防止は「D01〜D20がexampleと完全一致」を試験で機械強制／R3 X-OUT-10（代理の参集記録担当画面）はD08未決のため実装しない（無断採用の逆の仮実装を避ける）／R4 PH1-B1・PH0-BF07・PH2-B12は正式判定前の再確認としてresolved、PH1-A1はD03回答待ちでopen維持／R5 新規試験はmanifestに登録しない（T087 R5前例）／R6 判定時点のGit commitはrelease-decision.md側に記録しJSONの自己言及を避ける／R7 docs/13現状列（v0.3時点）とT088判定は別物。判定は現時点実態で行い「開発版で実施済みの範囲」と「実環境・回答待ち」を分けて記録／R8 validate.tsはworkerd環境で走るため純関数のみ・CLIはFilesに無いため作らない／R9 ADOPTION_PROPOSAL/CHECKLIST/exampleはT088では変更しない（fix waveのF8で初めて触る・検出器green維持を条件に）

## 第1回（4体並行。a897ad2..925da08）

A=正確さ／B=完了条件／C=prototype準拠／D=docs整合。合計: **高0 / 中1 / 低18 / 要確認3**（中1と要確認のうちA-3・A-9・B-4・D-6はコントローラが実コード・実行計画で確認）。指摘統合と裁定は workspace の task-88-findings-r0.md、修正はb81b122、再レビューで**F1〜F9全てADDRESSED**。

| 指摘 | 内容（代表） | 対応（b81b122） |
|---|---|---|
| F1（D-中1） | development-completion.md §3の局所完了列挙がT086止まり（タイトル・§1と文書内不整合） | T088の行を追加+導入段落の時点表記を更新 |
| F2（B/D-低） | docs/16 §1年表（:40）にT088の文が無い（T086/T087最終コミットの前例に反する） | 年表末尾へ1文追加（:78と矛盾なく・外科的） |
| F3（A-低1） | production-policy.json RG-03根拠「X-V01〜X-OUT-10の29件」はX-COSTが範囲外で28件に読める | 「X-V01〜X-OUT-10・X-COSTの29件」へ |
| F4（A-低3・コントローラ実証） | classifyAdoptionAnswer の採用語が広く「対象にしません」「含めたくない」等の列挙外否定形が採用側に倒く | 否定随伴語を含む文は採用と読まず暗黙対象外へ（fail-closed）。対照9で固定 |
| F5〜F7（A-低4・D2-Minor1/3・D-低4） | RG-08合格条件の言い換え注記が報告書側のみ／「この判定後」が文脈依存／config文言の引用が不正確 | 行内注記+RG-10限定句／「正式リリース判定（docs/13 §3 手順4の承認）後」へ／要約として正確化 |
| F8（D-要確認6・C-低2・A-低2/8・D-低5） | チェックリストにD01の1文1ID記入案内が無い／D01質問文がdocs/01正本の「地域単位の」を欠く／D07・D08意思決定者がdocs/14正本と微差／PROPOSAL §6の「回答の記録はT088」が実手順とずれる／明示排除時の一致確認が§5②に無い | 案内行追加+D01質問3点一致+D07/D08をdocs/14正本へ4点同期+§6を実手順参照へ+§5②へ文言追加。adoption検出器green維持（試験へ出典実在2ファイルを追加） |
| F9（A-低6・C-低3・D2-Minor2） | ゲート名が3箇所に重複し一致検査が無い／失敗メッセージの文書名ラベルが常に「提案資料」 | GATE_NAMESをexport+10ゲート名一致断言+ラベル改善 |

## 方針で残す（Rulingつきの全リスト）

1. **A-低7 manifest PH2-B12 basisの「docs/16 §1に記録」が実体より強い言い方** — Ruling: resolved済みの工程記録のbasis文言であり製品影響なし。次にmanifestを触る際に正確化 — コスト: なし
2. **A-低8の機械試験部分（D01明示排除時の対象版×ゲート根拠の整合試験）** — Ruling: 実回答が揃うまで検査対象が存在しない。release-decision.md §5②へ確認文言を追加した（F8）で十分。回答記録時に試験化を検討 — コスト: 回答記録時の作業
3. **F4の否定語彙の「外さない」型（除外の否定=採用寄り）が除外側に倒く** — Ruling: fail-closed方向（通しすぎない側）でD01回答は1文1ID記入案内（F8）で語彙を規定するため実害は限定的。次回wave候補 — コスト: 稀な語形で誤分類の可能性（安全側）
4. **Ruling W2 journeys.specへのヘルパ適用見送り** — Ruling: 発火1回・link不出現のみでどの書き込みが落ちたかの直接証拠が無く、適用点を確定できない。T085b-W1のbasisどおり継続観察（次の安定署名捕捉時に適用） — コスト: 次回発火時に検証やり直しが必要になり得る
5. **B-3 D3が割当外に修正したT085b-W1注記の書き換え** — Ruling: ph8.md「T086」の実績（4走行失敗0・basis更新済み）と一致する事実修正のため承認。遡及はしない — コスト: なし

## 最終検証（コントローラ実行・2026-10-21）

- 確認済みの高・中の未解消: **0件**（タスクレビュー×3＋4体並行レビュー→fix wave 1→再レビューF1〜F9全ADDRESSED・新規Critical/Important無し）
- コミット: **19c9430**（本体・指定試験・production-policy.json）・**ee067c9**（release-decision.md・production-start.md・docs整合試験）・**b8df963**（manifest: PH1-B1/PH0-BF07/PH2-B12 resolved・PH1-A1 open維持）・**b72c290**（production-policy.json陳腐化修正）・**925da08**（docs/16・ph8.md・development-completion）・**b81b122**（fix wave 1）・**abc64e7**（ai-review.specへドロップ吸収ヘルパ・T085b-W1 basis）・**7badd95**（FLAKE-4回復ループ・manifest resolved）
- 最終検証の過程で発火したフレーク: ①フルe2e第1バッチ3走行で各1件（incidents×2・ai-review×1＝T085b-W1残存クラス。ai-reviewへヘルパ適用） ②collect:evidence再収集で2件（journeys＝T085b-W1・asset-inspection＝**FLAKE-4起票**→保存page snapshotから根因特定〔注入の応答漏れ＝試験インフラの競合・製品は正常〕→回復ループ構造へ修正）。詳細はph8.md「T088」最終検証節
- 最終全検証（7badd95時点）: typecheck成功／check:contracts「102 API / docs/05 102行 / OpenAPI一致」／check:coverage成功（参照テスト272件）／build成功（precache 9 entries）／check:adoption-proposal exit 0／collect:evidence〔vitest **73ファイル337件**・load 3・**e2e 75 passed / 0 failed / 0 skipped**・live未実施〕＋**受入ゲート 1 passed**／**フルe2e 3回連続緑〔75 passed ×3＝5.4/5.2/5.2分〕**
- T088は**局所完了**。正式リリース判定の機構（validateProductionPolicy・production-policy.json・指定試験・release-decision.md・production-start.md）が完成し、現時点の正しい判定＝**正式リリース不可**（全ゲート不合格・D01〜D20未回答・暗黙対象外3機能）を機械強制する。実回答・実環境・人待ちの残作業は release-decision.md §5①〜⑦。**全89タスク（T001〜T088＋T085b）完了。PH8完了**
