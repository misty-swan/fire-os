# PH8 実行証跡（2026-10-18〜。T083・T084）

対象: **T083 実端末・アクセシビリティ・再訪操作の検証修正**（PH8の最初の1タスク）と **T084 外部障害・通信断・管理者不在の代替運用**（「T084」節）と **T085 全54受入・17共通・18継続シナリオの統合**（末尾の「T085」節。T085b以降は未着手）。実行環境はローカル（Node v26 / workerd / wrangler 4.x / vitest / Playwright chromium）。**実Cloudflare・実staging・実端末（iOS/Android実機）・実スクリーンリーダー・実PWA install環境は使っていない**（PH0〜PH7から継続で未接続・実端末は本環境に存在しない）。データはすべて架空。実装はsubagent-driven（実装サブエージェント1体→コントローラ検証→4体並行レビュー〔docs/evidence/ph8-review.md〕）で遂行。実装コミットは **7bb8d08** `feat: complete T083 ux`（25ファイル・実装・試験・契約3点セット・docsを同一コミットに。BASE=f8f0c4d）。

## 実行結果

| 確認 | コマンド | 結果 |
|---|---|---|
| 型検査 | `npm run typecheck` | 成功（実装者・コントローラ両方で実行） |
| 契約検査 | `npm run check:contracts` | **102 API / docs/05 102行 / OpenAPI一致**（API-01 MeDataへ`unitId`追加の契約3点セット〔台帳・docs/05・OpenAPI再生成〕を同一コミットで実施） |
| 単体・結合試験 | `npx vitest --run` | **65ファイル294件成功**（PH7最終291件＋実機確認の修正で+3〔UUIDフォールバック2件・共有ヘルパー1件〕。workers＝実workerd＋D1/Queues、client＝jsdom） |
| ブラウザ試験 | `npm run test:e2e` | **最終HEAD（89e3978）でフル2回連続 103 passed / 3 skipped（モバイル限定試験のdesktopスキップ）/ 0 failed**（コントローラ実行・約12分/回。94→103は追加した回帰試験〔狭幅はみ出し240/200px・iOS date appearance・活動分析チップ〕の分。実機確認で発見した不具合の修正すべて込み。途中の検証経過は下記「実機確認」とph8-review.mdに記録） |
| ビルド | `npm run build` | 成功（precache 9 entries） |
| 負荷試験 | `npm run test:load` | **触らない**（T085/T086の範囲。ユーザー指示） |
| カバレッジ | `npm run check:coverage` | **触らない**（T085/T086の範囲。ユーザー指示） |

## T083の指定試験

`returning_user_finishes_inspection_and_attendance_without_hidden_controls`（tests/e2e/accessibility.spec.ts新規）＋ `revisit_core_flows_complete_in_few_operations_after_relogin`（tests/e2e/revisit-flows.spec.ts新規。ブリーフ外の追加だがInterfacesの測定〔成功率/操作数/時間〕を独立回帰ガード化するもの）— 新規2spec×3プロジェクト（phone-360 / desktop-1280 / **tablet-768新設・本2spec限定**）で全PASS。

- **4断言**（ブリーフ指定どおり）: `criticalAccessibilityViolations`（axe critical違反=0。@axe-core/playwright 4.14.0・WCAG 2.1 A/AA・ホーム/マップ/点検登録/同期の状況の4画面。serious以下は記録のみ）／`coreTaskSuccessRate`（再訪5フローの成功率1.0≥0.9。**閾値はdocs/14 D18の開発案値であって承認済み合格値ではない**〔V07-ux.md・docs/16・試験コメントの3箇所に明記〕）／`markerTextLabelsMissing`（地図マーカーのaccessible name＋面上テキストの2点計上=0件欠落。一覧の行ラベルはachromatopsia節と地図フローの別断言が担う）／`unreachableCoreControls`（ネイティブfocusable構造＋Tab実走査=空）
- **測定の添付**: flowId/steps/duration/success/errors/device/version（Interfacesどおり。`timedFlow`がstdoutへ`[flow] {...}`を出力＝測定の証跡）
- **地図障害の一覧代替**: 地図を見ずに「一覧」だけで施設→詳細→点検まで進む導線を試験（本アプリの地図面はプレースホルダーで実タイル依存が無いための再現方式。V07-ux.mdに記録）
- **色除去**: CDP `Emulation.setEmulatedVisionDeficiency("achromatopsia")`。種別チップ・一覧の状態が文字で読めることを断言
- **200%文字拡大**: CDP `Page.setTextZoomFactor` が本Chromium（Playwright 1.64同梱）に存在しないことを事前プローブで確認（`Protocol error ... wasn't found`）→ **rootへのCSS zoom注入で代替**（レイアウト全体拡大＝文字ズームより厳しめ。文字ズームのみとの差は実端末手順で確認＝V07-ux.mdに記録）

## 赤→緑の扱い（正直な記録）

- **正当な赤3本**: ①R1（jsdom）＝scopeにunitIdを期待→旧実装は表示名を積むため `expected [] to deeply equal [ 'op-self' ]`〔表示名を識別子に使うと改名後に下書きが消える実欠陥〕②R3（jsdom）＝403表示のFORBIDDEN Banner先行断言→旧Noticeのまま落ちる ③R4（e2e）＝POST応答を6秒遅延させる一時route注入で旧トースト断言（2.6秒自動消失への固定時間依存）が**保存成功でも5秒で落ちる**＝フレークの実再現。緑は同じ6秒遅延を残したまま新断言でPASSを確認してから遅延を除去（コミットに遅延は含まない）
- **赤にならなかった断言**: axe critical 0・ラベル欠落0・keyboard到達不可0・achromatopsia・200%拡大は**既存画面が優秀なため初回から合格**（T081 matrix probe前例）。画面修正を偽って赤を作ってはいない
- **初回e2e FAILの実体**: seedの並び（役割付与を受領前に実行→422）とseed専用文脈の不備（Pixel 5エミュレーションのpage fixtureはisMobile=trueでsetInputFilesが固まる＝documents.spec冒頭の既存経験則）で、**実欠陥のシグナルではない**ため赤の根拠に使わず修正して再実行

## 接続した既存の残作業4件の決着（コントローラ裁定R1〜R4）

1. **R1 draft scopeの分団識別子**（ph6-review A低3）: `MeData`へ`unitId`（units.id）を追加（契約3点セット）。下書きscope 3箇所（capture.ts / me.tsxのstartAutoSync / SyncPage.tsx）を表示名`unitName`→`unitId`へ切替。分団異動時に下書きが消えて見える欠陥を解消。IDBにunitNameスコープで保存済みのdraftは一覧対象外になるが正式リリース前で実データ無し
2. **R2 resync札の点色**（ph6-review 要確認2）: **コード変更なし**。ドット=通信状態・テキスト=同期状態の現設計を維持（NFR-09の色非依存はテキストが担う）。判断と根拠をdocs/03 §1.1-22とV07-ux.mdに記録
3. **R3 403表示統一**（ph7-review C低4）: prototype本体をgrepし管理パネルの403表現が無いことを確認→OperationsPanelの403（Notice warning）をAuditPanel前例の`Banner tone="error" eyebrow="FORBIDDEN" role="alert"`へ統一（jsdom赤→緑）。二要素未設定案内は403ではないため維持。docs/03 §1.1-23⑥更新
4. **R4 documents.specトースト断言の作り直し**（ph7-review #9）: documents.spec:67/124を`waitForResponse`（POST /documents 201・PATCH access-policy 200）＋role=statusスコープ付き断言へ作り直し。フルe2e 2回でフレーク再現なし

## 未実施・未接続（検証済みとして扱わない）

- **実端末の残手順（本タスクの核心的な未確認）**: iOS Safari／Android Chrome実機・VoiceOver/TalkBack/NVDA実スクリーンリーダー・実PWA install・quota・実端末GPS/カメラ・実回線は**未実施**。**ops/device-test-matrix.md §2に番号付き残手順**（共通準備3＋iPhone 8＋Android 8＋PC 6＋記録形式。利用者が自身の端末で実施できる手順書の形）
- **docs/16 T083状態欄は局所完了**（T073/T079/T082前例どおり）。NFR-01/02/09の実機部分を合格とは扱わない。docs/13のRG-02/RG-07は未達のまま（D18承認条件での実環境実測が別途必要）
- エミュレーション証跡（chromium実ブラウザ・3viewport・keyboard・200%代替・色除去・地図障害代替）と実端末証跡はV07-ux.md内で厳格に区別

## 実機確認（2026-10-19・ユーザーのiPhone＋Safari。LAN平文httpで実施）

実Cloudflareではなくローカルサーバー（`wrangler dev --ip 0.0.0.0`＋`.wrangler/demo`の架空データ）をLAN公開し、ユーザーのiPhone実機（Safari・393幅・ズーム100%）で確認。**実機確認は6件の実欠陥を発見し、すべて同サイクルで修正済み**（各ラウンドともスコープ付き再レビューAPPROVE。詳細はph8-review.md「ラウンド5〜9＋実機確認の追加修正」）:

1. **LAN URLからのログイン系が拒否される**: authの信頼オリジンがlocalhost固定のため（エラー「処理に失敗しました」の実体）。`.dev.vars`（Git管理外・ローカル限定）でAUTH_BASE_URLを実機アクセス用URLへ上書きして解消。staging/productionはHTTPS単一URLのため影響なし
2. **平文httpでアプリが落ちる**: `crypto.randomUUID`はsecure context外に存在せず、端末ID生成（`deviceIdOf`）がTypeError → `src/client/uuid.ts`共有ヘルパー（`getRandomValues`フォールバック）＋クライアント全9箇所を置換（e6d1301＋af0426d。赤→緑・冪等キー契約の維持を実検）
3. **狭幅で入力欄がカードからはみ出す**: 日付入力の固有幅（約192px）がグリッド最小幅を引きずる。`TextField`/`TextArea`へ`w-full min-w-0`＋240px/200px幅の回帰テスト（16be223。赤+53px→緑）
4. **iOS Safariの日付入力だけさらに治らない**: 実機のcomputed style実測で `box=content-box`（authorのborder-box無視）→ **WebKit Bug 301648**（公認P2・iOS 26.5でも未修正）と確定 → date/time系inputへ`appearance:none`＋空値の高さ対策（1d4d10d＋06f8840〔datetime-local拡張〕。赤→緑）。iOSでの見た目変更（ネイティブ装飾の消失・値の左寄せ）はdocs/03 §1.1-24に記録
5. **活動分析（SCR-26）の「単位」チップで横スクロール**: 406pxのchipが縮まないため → `Chip`へ`max-w-full`（89e3978。赤〔scroll421>client360〕→緑）
6. **点検様式の編集で新しい版の表示断言が1回きり評価**: ポーリング断言へ置換（3b8a56a。フル走行の約40%で失敗していた既知フレーキー）

- 検証方法: 実機のcomputed styleを画面に表示する診断オーバーレイ（一時実装・撤去済み）で実測→修正→実機の再読み込みで確認（修正後の実測: `filter-from w=325 over=-14 appear=none box=border-box`）
- **残る実機未確認**（ops/device-test-matrix.md §2のまま）: VoiceOver/TalkBackでの読み上げ・PWA install（LAN平文では不可＝HTTPS要でstaging後）・quota・実回線・代表利用者5名の説明なし再訪計測（提案時）
- LAN公開の運用上の注意（ローカル限定・Git管理外）: 実機確認には都度①`.dev.vars`のAUTH_BASE_URLをその時のPC IPへ更新②`--ip 0.0.0.0`で起動③ufwのsubnet許可、の3点が必要

## prototype準拠

画面（prototype語彙・導線）への変更はR3の403表示1箇所のみ（prototypeに管理パネルの403表現が無いことをgrepで確認済み＝docs/03 §1.1-23に記録）。新規は試験・docsのみで画面追加なし。44px押下領域・トースト位置・文言語彙の既存規約は無変更。axe走査の対象4画面は既存画面の確認であり変更ではない。

## 既知フレーキー（コントローラの最終検証で判明・対応済みと継続観察）

- **documents.spec desktop「題名消失」— 根因ごと修正〔ラウンド3〕**: コントローラの最終検証でフル走行4回連続失敗。エラースナップショット（「題名を入力してください」の検証エラー・分類は生存）＋サーバーログ（desktopの作成POSTが到達せず）から、`fill(題名)`の入力がReact状態へ反映されずクライアント検証で送信中止になっていたことを特定。**旧来の「既知フレーキー〔トースト断言〕」（ph5/ph6/ph7）の実体はこの題名消失だった可能性が高い**。対応: 粘着fill（fill→toHaveValue→再fill計3回）＋2つの`waitForResponse`に30秒の明示タイムアウト（サーバー実測約60ms。根因再発時も300秒でなく30秒で明確に落ちる）＝**38922d4**。粘着fill導入後のフル走行12回中3回発火〔導入直後の2回＋ラウンド4後の1回〕で、最終4回連続は緑。発火時は検証エラーの画面が残るため切り分けは容易
- **inspection-templates.spec phone — 根因ごと修正〔ラウンド4〕**: トースト直後に`body.textContent.includes("rev2")`を1回だけ評価する非ポーリング断言が、rev2ラベルの描画遅延でfalseになる（フル走行15回中5回）。`expect(card.getByText("rev2")).toBeVisible()`のポーリング断言へ置換（カードスコープ化で旧body全文検索の誤マッチ弱点も解消）＝**3b8a56a**。修正後のフル走行4回で未発火
- **継続観察（1回off・いずれも単独実行は常に緑。次に触る際の作り直し候補）**: reports.spec desktop〔承認トースト直後の即時GET断言。1/15回〕／facility-location.spec desktop〔`page.evaluate`のnull参照。1/15回〕／notifications.spec phone〔1/15回。未調査〕。フル走行15回の観測ベース
- **T084最終検証での再発記録（2026-10-19）**: documents.spec desktop `withdrawn_document_disappears_from_search_and_citation` が114a32cのフル走行3回中1回、作成POSTの`waitForResponse` 30秒タイムアウトで失敗（=「題名消失」の稀な再発。30秒で明確に落ちる設計どおり）。T084の差分とは無関係・残り2回は緑。引き金は引き続き未特定＝T085（統合試験整備）の作り直し候補
- 診断の副次情報: 正常系ではDocumentEditorのMOUNT→fill値反映→遷移→UNMOUNTが清楚（アプリ側一時ログで確認。診断コードは全てrevert済み・非コミット）。documents「題名消失」の稀な再発メカニズム（fill値確認後の消失＝再マウント/再レンダリング競合と推定）の引き金は未特定

## T084 外部障害・通信断・管理者不在の代替運用（2026-10-19。局所完了）

実装コミット **a9b0d47** `feat: complete T084 failure`、レビュー第1ラウンドの修正は **9a03544** `fix: address T084 review round 1`、第2ラウンドの文書修正は **114a32c** `docs: address T084 review round 2`（docs/16のチェック位置の誤り〔T048に付いていた〕の訂正ほか）。実行環境はT083と同じローカル（workerd＋ローカルD1＋Playwright chromium）。実Cloudflare・staging・実Google・実provider・実在の人は使っていない。データはすべて架空。migration無し・新規endpoint無し・試験専用APIの本番登録無し。詳細は docs/evidence/V07-outage.md。

| 確認 | コマンド | 結果 |
|---|---|---|
| 型検査 | `npm run typecheck` | 成功 |
| 契約検査 | `npm run check:contracts` | 102 API / docs/05 102行 / OpenAPI一致（契約の変更なし） |
| 単体・結合試験 | `npx vitest --run` | 65ファイル294件成功（件数はT083最終と同じ。T084はworkers試験を追加していない） |
| Queue送信失敗の観測 | `npx vitest --run tests/jobs.test.ts -t queue_send_failure_does_not_lose_the_job_and_cron_recovers_it` | 1 passed（既存試験） |
| 指定試験 | `npm run test:e2e -- tests/e2e/dependency-outages.spec.ts --grep outage_never_claims_dispatch_or_saved_success` | 3 passed（setup＋phone-360＋desktop-1280） |
| ブラウザ試験（フル） | `npm run test:e2e` | 2回目（cleanup修正後）**104 passed / 3 skipped / 1 failed**（12.3分。基準609d67eの103件＋新規1spec×2サイズ。失敗1件は既知フレーキーの reports.spec desktop〔承認トースト直後の即時GET断言＝「既知フレーキー」節の継続観察〕で、同specの単独再実行は **5 passed**。T084の差分〔通知の注記・新規spec〕とは無関係の箇所）。1回目は下記②の71件失敗 |
| ビルド | `npm run build` | 成功（precache 9 entries） |

- **赤→緑**: 通知の修正をstashした状態で、両サイズとも `applicationAsOnlyDispatchChannel` が true で失敗（通知の承認前確認・配送結果・タスク・通知の3画面に「正式な連絡は既存の系統・補助」の注記なし。出動の2画面にはあり）。他の3断言は最初から合格（偽って赤にはしていない）。注記を追加して緑。
- **実欠陥1件（修正済み）**: 通知画面に正式連絡の注記が無い → `FormalContactNotice`（docs/03 意図変更25）。
- **試験の不安定さ（試験側の問題を修正）**: ①スマホの一覧代替の観測が待たない`isVisible()`で一度だけ揺れた → 待つ断言の成否で判定するよう変更。②**1回目のフルe2eで71件失敗**: scenario 6で作った架空の管理者2名が共有のD1に残り、member-admin.specの「最後の管理者は停止できない」の前提が崩れて初期管理者が実際に停止された → 以降の試験が連鎖して失敗。演習の管理者を `finally` で一般の団員へ戻すように修正し、dependency-outages＋map＋member-adminの3specを続けて実行して 16 passed / 1 skipped を確認してからフルを再実行した。
- **未実施（局所の理由）**: V07-outage.md「未実施」1〜10。実Cloudflare/staging/実キーが要るもの（1 staging演習・2 実Googleキー停止・7 ops/security-response.md §7の遮断/rotation演習・8 実Queues・9 管理者全員喪失時の復旧手順）はT086、消防団の人・了承・D13が要るもの（3 実provider・4 実在の正副担当の交代・5 別担当〔人〕による再現・6 紙/電話の実地演習・10 代理参集の担当付与画面）はT088が引き受ける。docs/evidence/security.md の予約欄も事実に合わせて訂正した。

### T084 レビュー第1ラウンドの修正（2026-10-19。9a03544）

- **陽性対照（B-I1）**: 誤成功の検出器が窓の外で「保存しました」（手動帳票の保存）を拾えたことを断言。さらに配送結果の修正をstashした状態で、窓の中の緑の「配送の処理を終えました」を誤成功1件として検出し赤になることを実証（Received: 1）。
- **配送結果の終端表示（R10）**: 到達不明・失敗があるときは attention＋「要確認」の併記（docs/03 意図変更26）。jsdom試験 `tests/notification-delivery-label.test.tsx` で赤（2 failed / 1 passed）→緑（3 passed）。
- **演習の管理者の後始末（A-M2）**: afterEach＋自前のrequest contextで全員分を試行してまとめて報告。dependency-outages＋member-adminを同じ実行で 12 passed / 1 skipped。
- **runbookの訂正**: `--yes-i-know` はwranglerのフラグではない（`npm run migrate` 専用のガード）→ ops/outage-runbook.md・ops/security-response.md §7・ops/cost-alerts.md・docs/evidence/V07-performance.md から wrangler の行の分を削除。手順が無い箇所は「手順未整備（未実施・担当T086/T088）」と明記（管理者全員喪失・代理参集の担当付与・Googleキー・Cloudflareアカウント回復）。復帰照合は前提（出動記録の登録・実績の入力）と必要な役割を書き足し、点検の訂正はUI未実装（T033残作業）のため管理者へ申告に。
- **docs/16**: 手順3を未チェックに戻した（切替・復帰照合の架空演習は机上の表だけ）。残作業①〜⑩に担当（T086/T088）を付け、T086節・T088節に引き受けた残手順を1行ずつ追記。

### T084 最終検証（コントローラ実行・114a32c時点。2026-10-19）

| 確認 | コマンド | 結果 |
|---|---|---|
| 型検査 | `npm run typecheck` | 成功 |
| 契約検査 | `npm run check:contracts` | 102 API / docs/05 102行 / OpenAPI一致 |
| 単体・結合試験 | `npx vitest --run` | **66ファイル297件成功**（T084のR10で `tests/notification-delivery-label.test.tsx` 3件を追加） |
| ビルド | `npm run build` | 成功（precache 9 entries） |
| ブラウザ試験（フル×3） | `npm run test:e2e` | 1回目 104 passed / 3 skipped / 1 failed（既知フレーキーのdocuments.spec desktop「題名消失」の再発＝上の「既知フレーキー」節）→ **2回目・3回目は連続で 105 passed / 3 skipped / 0 failed**（12.9〜13.7分/回。105＝基準103＋T084新規spec×2サイズ） |

- 受入基準: T083と同じ「最終HEADでフル2回連続緑」を満たす（2・3回目）。test:load・check:coverageはT085/T086の範囲で未実施
- レビューサイクル: docs/evidence/ph8-review.md「T084」節（4体並行→修正2ラウンド→再レビュー3回。確認済みの高・中の未解消0件）

## T085 全54受入・17共通・18継続シナリオの統合（2026-10-19。局所完了）

実行環境はT083/T084と同じローカル（workerd＋ローカルD1＋Playwright chromium＋試験専用fake AI）。実Cloudflare・staging・実Google・実provider・実端末・実在の人は使っていない。データはすべて架空。新規endpoint無し・migration無し（API-51の応答拡張とAPI-44の行へのisCurrent追加は既存APIの契約変更。契約3点セットで実施）。試験専用APIの本番登録無し。

### 作ったもの

| 部品 | 内容 |
|---|---|
| `tests/acceptance/manifest.json` | 正本から機械抽出したID（docs/08のAT54・CT17・AT×CTの組220・TC18、docs/12の要件54、契約台帳のAPI102、画面台帳のSCR28）ごとに、それを実際に試している実テスト（vitest/load/e2e の file＋完全title。e2eは必要ならproject指定）を対応付ける。notApplicableは1組（AT-DASH-01×CT-05＝API-28は読取専用。docs/08 §2の根拠つき）。横断journey4本、実外部・実端末・人の残手順29件（external。V文書・ops/device-test-matrix §2・V07-outage「未実施」1〜10の番号つき）、課題台帳（issues。各ph*-reviewの「方針で残す」・既知フレーキー・T085で見つけた欠陥。重大度は出典の行が根拠）、既知skip3件の分類 |
| `scripts/acceptance-lib.ts`・`scripts/check-coverage.ts` | 静的検査（`npm run check:coverage`。CIに追加）: ID集合の欠落/余剰、参照先テストの宣言の実在とskip/only/todo/fixme、本文に条件付きskipを持つe2eはproject指定必須、**API参照先ファイルがそのroute（method＋path）を叩く記述を持つこと**、**画面参照先（e2e）がその画面のパスへ行く記述を持つこと** |
| `scripts/collect-evidence.ts` | `npm run collect:evidence`: vitest（workers＋client）→`test:load`→業務e2e（受入ゲート自身は除く）をJSON reporterで実行し、証跡index `docs/evidence/acceptance-index.json`（testId/reqIds/commit/codeHash/設計版/fixture/model/question/browser/network/日時/結果/証跡）と `docs/evidence/acceptance-results.md` を生成。`test:live` はSecret未設定のため「未実施」と記録（合格に数えない）。`--only=<suite>` はスイート全体を同じコードで再実行し、旧実行は `discardedRuns` に残す |
| `tests/acceptance/all-requirements.spec.ts` | 指定試験 `acceptance_gate_fails_on_skip_missing_route_or_unexecuted_case`（5断言）＋各AT・各TCの独立タイトル（72件）＋陽性対照 `gate_detects_injected_skip_missing_title_routeless_api_stale_index_and_open_high_issue`。Playwrightのproject `acceptance`（ブラウザ不使用） |

- **「未実行」の判定（裁定R2の実装）**: indexにはcollect時の作業木の内容ハッシュ（codeHash: src/tests/drizzle/scripts/public/config/.github/openapi/docs/03・設定ファイル。gate自身のmanifest・lib・spec・2scriptは除外）を保存し、ゲートは現在のハッシュと比較する。commit同士のdiffでなく内容ハッシュにしたのは、未コミットの変更も「未実行」として検出するため（R2より厳しい側）。docs/03とworkflowを含めたのはclient-shell・deploy-configの試験がそれらを読むため。
- **CI**: ci.yml・deploy-*.yml に `npm run check:coverage` を追加し、e2eは業務のprojectだけを明示（受入ゲートは結果照合のためCIで流さない＝R10）。deploy-config.test.tsの断言を同時に更新。

### 赤→緑

- **赤（手順2）**: 空のmanifestで `npm run test:e2e -- tests/acceptance/all-requirements.spec.ts --grep acceptance_gate_fails_on_skip_missing_route_or_unexecuted_case` → `expect(missingRequirementIds).toEqual([])` が**76件**（AT54＋TC18＋journey4の「manifestに無い」）でFAIL（初版の記録の「78」はdiff表示の行数＝配列の括弧2行を含めた数の読み違い。T085レビューB-m4で訂正）。runnerの故障・構文エラーではない。
- **静的検査の途中の赤**: check:coverageが「API-58の参照ファイルがGET /reports/:idを叩かない」「J1がSCR-18のパスへ行く記述が無い」を検出 → 参照を差し替え／J1にURL断言を追加。
- **緑**: 下の「最終検証」。

### 網羅で見つけた欠落と埋め方（R5）

| 欠落 | 埋め方 |
|---|---|
| SCR-23（資産点検）・点検の訂正画面が未実装（T033残作業） | 実装（下の欠陥表D3・docs/03 §1.1-27）。e2e `asset-inspection.spec.ts` 2件 |
| API-44の機能試験が無い（負荷とe2eの読み出しだけ） | `facility_inspection_history_pages_every_version_once_and_keeps_the_original (T085)`（→欠陥D1を発見） |
| 施設・資産・異常・帳票の同キー再送（CT-04）の機能別試験が無い | facilities/assets/inspections-issues/reports に各1件（`… (T085)`） |
| 一覧の入力拒否（CT-02）: 施設一覧・活動履歴・お知らせ | gis-query/activity-history/announcements に各1件 |
| 施設の2端末更新（TC-16）が位置確認の版競合だけ | `same_key_resend_has_one_effect_and_two_devices_never_silently_overwrite (T085)` |
| 横断journey 4本 | `tests/e2e/journeys.spec.ts`（J1 点検→異常→AI→task→通知／J2 活動・出動→使用→集計→帳票／J3 文書→引用→失効／J4 offline→競合→復旧〔点検の訂正〕）。phone-360・desktop-1280 |

### 見つけて直した欠陥（所有タスクの状態欄にも記録）

| id | 所有 | 内容 | 赤→緑 |
|---|---|---|---|
| D1 | T029 | API-44の続き取得が新しい順なのにcursor条件が「>」で2頁目以降が欠落 | limit=1完走で4件中1件→「<」で4件 |
| D2 | T033 | 保存の応答が失われた後、画面の案内どおり送り直すと二重登録（実施日時を送信ごとに作り直し送信鍵が変わる） | 同一点検2件→最初の送信で固定して1件 |
| D3 | T033/T030 | SCR-23・訂正画面・資産の点検履歴（API-51）が未接続、施設詳細の点検結果が現在版でない | e2eで記録→訂正→元の記録不変・現在版表示 |
| D4 | T039/T044 | 予定・出動の検索カードが参加者selectの最長の団員名より狭くなれず200px幅で横スクロール（団員が増えると再現） | 1回目のフル走行で scrollWidth 202/200 → 同じデータで269→200 |
| D5 | T070 | AIアシスタントの「記録を添える」チップが確認待ちの異常を古い順に5件だけ出す（新しい異常を添えられない） | 1回目のフル走行でassistant.spec desktopが失敗（確認待ち14件）→ 新しい順5件 |
| 試験 | T029/T032 | 「未検査は422」の2試験が背景のQueue consumerとの競合で落ち得た（1回目のフル走行でvitest 1件failed） | 完了確定前の添付へ変更 |

### 既知フレーキーの扱い（R8）

documents.spec desktop「題名消失」（`題名を入力してください` の検証エラー＝fillの値が消えて作成POSTが出ない）が collect の1・2回目で各1回発火。署名はph8.md既存の記録と同じで、試験の構造は変えていない（作り直しはT085b）。e2eスイート全体を `--only=e2e` で再実行し、失敗した実行は証跡indexの `discardedRuns` と acceptance-results.md に残した。

### T085bへの申し送り（高速化材料）

- フルe2eは **120件（117実行＋skip3）で約14〜20分/回**（T084時点105件・約13分）。collect-evidenceはこれにvitest約1分・load約1分が加わる。コード変更のたびに再収集が要る（R2のコスト）。
- 受入ゲートのspecは project `acceptance`（ブラウザ不使用）だが、Playwrightの仕様でwebServer（D1再作成＋build）が毎回起動する。ゲート単独の実行も約1分かかる＝ゲートをPlaywright外（tsx/vitest）で回す選択肢がある（T085本文がPlaywrightのコマンドを指定しているため今回は変えていない）。
- 共有D1にデータが溜まるほど結果が変わる試験があった（D4・D5は製品側の欠陥として修正済み）。試験ごとのデータ分離（T085bの候補③）で、データ量依存の欠陥を「たまたま緑」にしないこと（D4/D5は分離すると再現しなくなる）＝狭幅・一覧の上限は意図して多件データで試す試験を別に持つのが望ましい。
- workers試験は背景のQueue consumerが走るため、「まだreadyでない添付」は完了確定前の状態で作ること（T085で2試験を修正）。
- 既知フレーキー: documents.spec desktop「題名消失」はT085のcollect:evidenceのe2eフル走行**3回中2回**で発火（T084最終検証は3回中1回。以前より高頻度の可能性）。単独実行は緑。

### T085 レビュー第1ラウンドの修正（2026-10-20）

4体並行レビュー（a855bc3）の Important 11・Minor 19 を全件修正（コントローラ裁定R12〜R16）。主なもの:

- **既存の権限欠陥（T031。A-I3）**: API-46の訂正の権限判定がクライアントの送る実施者で行われ、一般団員が他人の点検を訂正し実施者を差し替えられた → 元の原本の実施者と新しい実施者の両方で判定（修正前201＝赤→403）。
- **訂正画面の誤り（T033。A-I1/A-I2/A-m1/A-m2）**: 「訂正済み」を「現在版でない」で判定していた（新しい点検があるだけで訂正済み表示）→ supersededById（API-44/51に追加）で判定。異常ありの記録の訂正で異常を二重起票 → 良好→異常ありのときだけ起票。訂正は現在版だけ・元の様式版が承認版でなければ訂正させない・元の実施者を引き継ぐ。施設の点検結果はAPI-44 current=true（契約3点）で読み、履歴は20件ずつ続きを表示。日付は日本時間（C3）。いずれもe2eで旧ロジックに戻すと落ちることを確認（異常2件／訂正済み2件）。
- **D4/D5の回帰試験（A-I4・R13）**: API-15に order=newest（契約3点。cursorは並びに束縛）を足し、アシスタントは新しい順の5件を1回で取る（クライアントの逐次取得は撤去）。サーバー試験（7件で新しい順・続きの重複欠落なし・並び違いcursorは400）とjsdom試験。狭幅はaccessibility.specで長い名前の団員を作って決定的に再現（旧画面で743px>240＝赤）。
- **ゲート（B-I1/B-I2/B-m1/B-m2）**: 失敗したスイートは合格の根拠に数えない（最新の実行がpassed・failed=0必須）、@project無しのe2e参照はphone-360とdesktop-1280の両方の合格記録が必須、正本の抽出が0件や継続TCの欠番を構成エラーに、routeの実値パラメータはUUIDと:typeの列挙値だけ（/facilities/:idが/facilities/importsに当たらない）。陽性対照を追加。
- **CT-05の空洞（B-I3/B-I4・R15）**: 試験用のトリガーで各機能の実routeのbatchを途中の文で失敗させ、原本・履歴・監査・outbox・冪等記録が1行も残らないことを断言（予定の作成・中止／実績の作成・訂正／お知らせの作成・改版／使用履歴／出動と活動の関連付け／AI提案の承認）。AT-DASH-01×CT-05のnotApplicableを外し、出欠の途中失敗でホームの数値が変わらない読取境界の試験に置換。これで**欠陥D6**（未作成の行を作るPUTの途中失敗が404「対象が見つかりません」に誤分類。T004/T036）を発見・修正（前提条件を満たさない場合の404は従来どおり）。**DOC-01**: R2へ書いた後にD1が失敗したstaging実体（孤児）の回収処理が無かった＝**欠陥D7（T017）**→ `sweepOrphanStagingObjects` を追加し試験で回収を確認。
- **地図（B-I5）**: 格納箱を含む3種をseedし、マーカー/行のaccessible name・種別チップの文字で識別できることを断言（map.spec）。
- **TC-14（B-m3）**: 承認の監査（report.approve。行為者・対象・日時・本文非複製）を断言する試験を参照に追加。**A-m3**: 「完了確定済み・検査前」の添付の422を決定的に作る試験を追加。
- **再収集で見つけた欠陥D10（T013ほか）**: 1回目のフル走行で、長い名前の団員（上のD4試験のseed）により管理画面の「団員を選ぶ」が725pxに広がり、member-admin・audit・dependency-outagesのスマホ試験が連鎖して失敗 → 列をlg:だけで定義したgrid 9箇所に grid-cols-1。同じDBで745→360を実測、accessibility.specに360pxの管理画面の確認を追加（旧gridで747＝赤）。モバイルのエミュレーションではinnerWidthが内容に合わせて広がるため、幅の比較は設定した画面幅で行うよう同試験を修正。
- 記録の訂正: 赤の件数は76件（初版の78は表示行数の読み違い。B-m4）。FLAKE-1の根拠と頻度（3回中2回）を更新（B-m5・D-m3）。

### T085 最終検証（2026-10-20。レビュー第1ラウンドの修正後）

| 確認 | コマンド | 結果 |
|---|---|---|
| 型検査 | `npm run typecheck` | 成功 |
| 契約検査 | `npm run check:contracts` | 102 API / docs/05 102行 / OpenAPI一致（API-15 order・API-44 current・API-51 inspections〔supersededById〕） |
| 網羅（静的） | `npm run check:coverage` | 成功。要件54 / AT54 / AT×CT220（notApplicable 0） / TC18 / API102 / SCR28 / journey4 / 実外部の残手順29 / 参照テスト268件 |
| ビルド | `npm run build` | 成功 |
| 証跡の収集 | `npm run collect:evidence` | vitest **67ファイル318件** passed／test:load **3件** passed／e2e **119 passed・3 skipped（スマホ専用試験のdesktop）・0 failed**（13.3分）／test:live **未実施**（Secret未設定）。修正後の1回目の収集は e2e 7 failed（上のD10の連鎖5件・地図のseed座標・documents題名消失）→修正して再収集＝失敗0 |
| ゲート | `npm run test:e2e -- tests/acceptance/all-requirements.spec.ts --grep acceptance_gate_fails_on_skip_missing_route_or_unexecuted_case` | 1 passed（受入spec全体 74 passed） |

### T085 未実施（局所の理由）— これは RG-03（正式な受入合格）ではない

ゲートの緑は「架空データ・ローカル（workerd＋ローカルD1・Playwright chromium・fake AI）で、参照先の実テストが今のコードで全部合格した」ことだけを意味する。docs/13 RG-03 の合格ではない。次の29件（acceptance-results.md「実外部・実端末・人の残手順」）はこの環境で行えず未実施で、合格に数えていない:

- 実Cloudflare/R2/Queues/AI/Maps: V01（認証）・V02（実R2）・V04-jev/llm/retrieval・AI評価の実モデル・V05（実Google Maps）・V06（実配送・実30端末）・V07（性能・復元・帳票の実表示）・費用の実測照合・公開デモの実環境（X-DEMO）。担当T086/T087/T088。
- 実端末・人: ops/device-test-matrix.md §2（iOS/Android/PCの実機・実スクリーンリーダー・PWA install・代表利用者の再訪計測）、V07-outage「未実施」1〜10（staging演習・実キー停止・実provider・実在の正副担当・別担当の再現・紙/電話の実地演習ほか）。担当T086/T088。
- `npm run test:live`（Secret未設定）。
