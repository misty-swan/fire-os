# PH8 実行証跡（2026-10-18〜。T083・T084）

対象: **T083 実端末・アクセシビリティ・再訪操作の検証修正**（PH8の最初の1タスク）と **T084 外部障害・通信断・管理者不在の代替運用**（「T084」節）と **T085 全54受入・17共通・18継続シナリオの統合**（末尾の「T085」節）と **T085b e2e試験の高速化と試験間の分離**（末尾の「T085b」節）と **T086 架空データの完成版・公開デモ分離・操作説明**（末尾の「T086」節）。実行環境はローカル（Node v26 / workerd / wrangler 4.x / vitest / Playwright chromium）。**実Cloudflare・実staging・実端末（iOS/Android実機）・実スクリーンリーダー・実PWA install環境は使っていない**（PH0〜PH7から継続で未接続・実端末は本環境に存在しない）。データはすべて架空。実装はsubagent-driven（実装サブエージェント1体→コントローラ検証→4体並行レビュー〔docs/evidence/ph8-review.md〕）で遂行。実装コミットは **7bb8d08** `feat: complete T083 ux`（25ファイル・実装・試験・契約3点セット・docsを同一コミットに。BASE=f8f0c4d）。

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

- **documents.spec desktop「題名消失」— 根因ごと修正〔ラウンド3〕**: コントローラの最終検証でフル走行4回連続失敗。エラースナップショット（「題名を入力してください」の検証エラー・分類は生存）＋サーバーログ（desktopの作成POSTが到達せず）から、`fill(題名)`の入力がReact状態へ反映されずクライアント検証で送信中止になっていたことを特定。**旧来の「既知フレーキー〔トースト断言〕」（ph5/ph6/ph7）の実体はこの題名消失だった可能性が高い**。対応: 粘着fill（fill→toHaveValue→再fill計3回）＋2つの`waitForResponse`に30秒の明示タイムアウト（サーバー実測約60ms。根因再発時も300秒でなく30秒で明確に落ちる）＝**38922d4**。粘着fill導入後のフル走行12回中3回発火〔導入直後の2回＋ラウンド4後の1回〕で、最終4回連続は緑。発火時は検証エラーの画面が残るため切り分けは容易〔T085b追記: 粘着fillに加え回復ループ＋ドロップ吸収で抑止。根本の引き金は依然未特定。T085b節参照〕
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

### T085 レビュー第2ラウンドの修正（2026-10-20）

再レビュー（b4f4271）の Important 3・Minor 5 を修正（裁定R17〜R19）:

- **訂正での異常の二重起票をサーバーでも防ぐ（R17）**: 訂正元の系譜（訂正元とその前の原本）に異常ありの結果・明細か、そこから起票された異常があるとき、`createIssue=true` を422（createIssue/issue_already_raised）で拒否。API-46の直接呼出し・同期API-81も同じ組立て関数。修正前201（赤）→422。
- **休団・退団の元実施者のままの訂正（R18）**: 元の実施者を保つ訂正だけ通す（訂正した人は監査に記録）。修正前422（赤）→201。
- **staging孤児の回収の巡回（N1）**: 続き位置をR2に保存して巡回（最後で先頭へ・失効cursorは先頭から）、1回5頁×100件、15分ごと。台帳のある1,010件の後ろの孤児が回収され、台帳のある実体は残ることを試験（続き位置を読まない変異で失敗）。
- 画面: 確認画面の「保存すると異常の報告が作成されます」を実際の起票判定に従わせ、サーバーの拒否理由には専用の文言。施設の点検の記録の「さらに古い記録を表示」の失敗表示。
- ゲート: collect-evidenceの未コミットファイル名の先頭1文字が欠けていた（出力のtrim）→ `git status --porcelain -z` の解析関数と単体確認。
- 記録: 欠陥D6/D7/D10を所有タスク（T004/T036・T017・T039/T042/T047）の行に追記、T030/T033の旧文を「当時」と明示。
- **e2eのポート（R19）**: 利用者が別プロジェクトを8787番で並行して動かすため、e2eの待受を `scripts/e2e-port.ts`（既定8797・`FIREOS_E2E_PORT`。inspectorは9239固定）へ移した（別コミット f4288f7。demoは8787のまま）。第2ラウンドの最初の収集はe2eの直前で8787使用中のため止まっていた。

| 確認 | 結果 |
|---|---|
| typecheck／check:contracts／check:coverage／build | 成功／102一致／成功（参照271・notApplicable 0）／成功 |
| `npx vitest --run` | 67ファイル321件 passed |
| `npm run collect:evidence`（ポート8797） | vitest 321・load 3・**e2e 119 passed／3 skipped／0 failed（15.4分）**・live未実施 |
| ゲート | `npm run test:e2e -- tests/acceptance/all-requirements.spec.ts --grep acceptance_gate_fails_on_skip_missing_route_or_unexecuted_case` 1 passed（受入spec全体75 passed） |

### T085 レビュー第3ラウンドの修正（2026-10-20）

再々レビュー（e50c98d）の Important 1・Minor 4 を修正（裁定R20）:

- **訂正の行き止まりを解消（R20。N3の方式変更）**: R17の「系譜に起票済みなら `createIssue=true` を422」は、画面が直前の記録しか見ないため 異常あり→良好→異常あり（v3）の訂正や同期API-81の下書きが保存できない行き止まりになった。サーバーは系譜に既にあれば `createIssue` を**無視して保存**し（起票しない）、応答の `createdIssueId`（その記録から起票された異常のID・無ければnull。API-14・API-46の保存応答だけに付き、API-44/51の点検の記録には付かない＝最終レビューR21で訂正）で実際の結果を返す。監査のmetadataに `issue: created / already_raised / none`。画面は訂正の確認で条件つきの予告（「この記録の履歴でまだ異常の報告が作られていなければ…」）を出し、保存後の施設詳細・資産詳細に「異常の報告を作成しました。」または「…新しい異常の報告は作りませんでした。」を示す。REJECTEDの専用文言は廃止。docs/05 API-46・docs/03 §1.1-27を更新（docs/11は「既存異常と二重にしない」の規則のままで変更なし）。
  - 試験: `correction_ignores_create_issue_when_the_lineage_already_raised_it (T085 R20)`（v1→v2→v3をAPI-46で201・createdIssueId null・異常1件のまま、同期API-81の訂正も200で異常1件、系譜に無い施設では起票。R17の実装では422で赤）。e2e `inspection_retry_after_lost_response_registers_once_and_correction_keeps_the_original` に予告・保存後の結果表示と v3 の画面での訂正（異常あり→良好→異常あり）を追加（360/1280とも合格）。
- **系譜の照会の束縛数（Minor）**: 最大50世代×3でD1の束縛上限（100）を超えていた → 45件ずつに分割（`LINEAGE_CHUNK`）。試験 `long_correction_lineage_is_checked_in_chunks (T085 R20)`（40世代の後の訂正。分割前は500で赤）。
- **古い版の409が起票判定より先（Minor）**: 上のR20の試験で、古いseriesVersionの訂正にcreateIssueを付けて409を断言。
- **docs/16（Minor）**: D10の回帰を正確なテスト名 `inputs_stay_inside_the_search_card_at_narrow_widths` で引用。T030行の入れ子の太字を解消。

| 確認 | 結果 |
|---|---|
| typecheck／check:contracts／check:coverage／build | 成功／102一致／成功（参照272・notApplicable 0）／成功 |
| `npx vitest --run` | 67ファイル322件 passed |
| `npm run collect:evidence`（ポート8797） | vitest 322・load 3・**e2e 119 passed／3 skipped／0 failed（15.0分）**・live未実施（Secret未設定） |
| ゲート | `npm run test:e2e -- tests/acceptance/all-requirements.spec.ts --grep acceptance_gate_fails_on_skip_missing_route_or_unexecuted_case` 1 passed |

### T085 最終検証（コントローラ実行・52e9bf6時点。2026-10-20）

- typecheck成功／check:contracts「102 API / docs/05 102行 / OpenAPI一致」／check:coverage 成功（参照テスト272件）／build成功／vitest **67ファイル322件** 合格
- フルe2e（`npm run test:e2e`＝業務のphone-360/desktop-1280/tablet-768の119件＋受入ゲートのacceptance 75件）: **run1 194 passed / 3 skipped / 0 failed（14.8分）、run2 194 passed / 3 skipped / 0 failed（14.6分）＝2回連続緑**。e2eサーバーは8797番（裁定R19）。skip 3件はphone専用の除外で、manifestのknownSkipsに登録済み（合格の根拠には使わない）
- 証跡index（docs/evidence/acceptance-index.json。実装者のcollect:evidence。codeHashは52e9bf6のコードと一致＝ゲート緑）: vitest 322・load 3・業務e2e 119 passed / 3 skipped / 0 failed・test:live 未実施（Secret未設定）
- 文書の訂正（裁定R21）: docs/05 API-46と本書R20の項の「createdIssueIdはAPI-44/51の点検の記録にも付く」は誤り（両SQLは未変更）→「API-14・API-46の保存応答だけに付く」へ訂正。docs/05・本書はcodeHashの対象外のため再収集は不要

### T085bへの追加の申し送り（コントローラが作業中に観測）

- **所要時間**: フルe2e 約14.7分（194件）、collect:evidence 約17〜20分。コード変更のたびにcollect:evidenceが要るため、修正1ラウンドの検証で約35分（収集＋ゲート＋フルe2e）かかった
- **待ち方の不具合**: 実装担当が `until ! pgrep -f "collect-evidence"; do sleep 15; done` で待つと、自分自身のコマンド文に一致して永久に終わらない（最長11時間半残留→コントローラが停止）。待機はPIDで行う、または `pgrep -f "[c]ollect-evidence"` の形にする
- **wrangler devの取り残し**: 中断した実行の `wrangler dev` が親を失って2回残った（8787を占有はしていなかったがファイル変更で再起動していた）。webServerの後始末・`--only` 再実行時のサーバーの扱いを見直す材料
- **ポートの共用**: 利用者は別プロジェクトの開発サーバーを8787で動かす。e2eは `scripts/e2e-port.ts`（`FIREOS_E2E_PORT`・既定8797／inspector 9239）へ集約済み＝workers≥2のときプロセスごとのポート割当の土台に使える

## T085b e2e試験の高速化と試験間の分離（2026-10-20）

実行環境はT083〜T085と同じローカル（Node v26 / workerd / wrangler 4.150 / Playwright 1.64 chromium）。**業務機能・migration・契約の変更なし（src/は1行も変更していない）**。実装はsubagent-driven（実装サブエージェント2体〔分離＋フレーキー作り直し／高速化〕→コントローラが計測と裁定→fix round 2回→スコープ付き再レビュー2回→4体並行レビュー〔docs/evidence/ph8-review.md「T085b」〕）。コミットは **69279d7** `fix: harden T085b e2e isolation and rework known flakes`（7spec・テストのみ）→ **68b5328** `feat: add T085b e2e speedup`（39ファイル）→ **4ad6883** `fix: absorb wrangler dev proxy drops in T085b e2e writes` → **4c2f176** `fix: harden T085b width tripwire` → **39fcef1** `docs: finalize T085b e2e speed evidence`。計測・採否の正本は **docs/evidence/e2e-speed.md**。

### 目標と結果（目標は基準計測の後に決めて固定。R5）

- **基準（M0・0d21ca3・workers=1・フルe2e＝全プロジェクト×3回）: 中央値14.8分**（15.5/14.8/14.8。フル合算193p/1f/3s＝業務118p/3s/1f＋acceptance 75p。**3回とも既知フレーキーが1件発火**〔FLAKE-1 documents×1・FLAKE-2 reports×2〕）
- **目標: フルe2e中央値 ≤ 6.0分**（-59%以上）
- **結果（M3'・4ad6883・workers=2・フル×3）: 中央値5.7分（5.7/5.8/5.6）・3回とも業務73p/0f/0s＝目標達成・-61.5%（2.60倍）**。所要時間の正はPlaywright報告値（壁時間にはwebServer停止滞留等の環境事象が混入し得るため）
- 途中計測: M1（0d21ca3・workers=2の赤観測）8.6分で干渉2件が発火／M2（69279d7・分離後）中央値9.3分・0f×3＝③workersの効果と分離の効用を実証／M3（68b5328・絞り込み直後）中央値6.2分で新たな不安定さ2件が発火（下記）→ 4ad6883で解消してM3'

### 干渉の解消（M1赤の2件 → 69279d7）

1. **activities.spec**: D05承認フロー未実装のための `wrangler d1 execute` 直接seedが、稼働中のwrangler devとD1を取り合い **SQLITE_BUSY** → 有界再試行つきの `seedProxyScope` ヘルパへ（SQLは旧と等価）
2. **inspection.spec**: 通信断の注入を page.route abort から **context.setOffline** へ構造化（並行負荷でrouteのfetch取り逃がしが起き、遮断したはずの保存が通って「結果を確認できません」が出ない競合）。断言とdocs/03の契約は不変

### 既知フレーキーの作り直し（manifest issues の T085b 担当3件〔FLAKE-1・FLAKE-2・PH3-T〕）

- **FLAKE-1 documents「題名消失」**: 押下後に作成POST不発なら検証エラー確認→再fill・再押下×3の回復ループ＋ACL追加を先に済ませfill→押下の間を最小化。**根因（再マウント/再レンダリング競合の引き金）は未特定のまま**（M3'以降3回＋fix検証で未発火）。後続の4ad6883で作成押下はドロップ吸収ヘルパ経由に
- **FLAKE-2**: reports「承認トースト直後の即時GET」は**根因を同定**（承認前の常時表示「承認済みの版が無いため…」への部分一致が先取りし、確定前のGETが404/旧値を掴む）→ API-60のwaitForResponse＋承認記録のexact一致へ。facility-locationのpopup URL直後読みは要求イベント待ちへ（M3 run3で実発火した繰り延べMinor）。notificationsは待機化（元失敗行は特定できず）
- **PH3-T**: activities.specの死に変数・先取り断言の整理（「不参加」断言はフォーム閉鎖確定→チップの順へ）

### M3で判明した安定性の欠陥と修正（4ad6883）

- issues.spec の awaited PATCH が **wrangler 4.150 のProxyWorker→UserWorker接続ドロップ**（kj keep-alive約5秒境界・「Network connection lost」。GETは自動再試行・PATCH/POSTは非冪等のため再試行されず。wrangler #14926/#15252。CLIの調整 knobs 無し。ファイル監視説は再読み込み0行により棄却）で喪失。同種ログはM0/M2にも〜1回/回存在した無害ノイズ。→ **署名限定**（requestfailed または本文が `network connection lost` の5xxのみ。4xx・無署名5xxは再送しない＝本物の不具合は赤のまま）・**有界3回**・**同一冪等鍵**（useMutation.ts:60-76が結果不明の間鍵を保持し、execute.ts:220が一件化（状態錯誤は:236-237/:278で拒否））の再送ヘルパをissues 6書き込み＋documents作成へ適用。陽性対照（route.abort＋署名入り500の注入→再送1回・適用1回）つき。**他specのawaited書き込みには依然同じクラスが残る**＝残存クラス・署名・切り分け手順はe2e-speed.mdに記録（wrangler修正リリースで再検討）
- webServer停止滞留（M3 run3のみ実経過38分＝試験後のPlaywright→wrangler終了待ち。T085申し送り「取り残し」の同族だが通常完走での初観測）はその後4走行で未再現＝**経過観察**（再現時は壁時間と報告値の差で検知）

### 候補①〜⑤の採否（計測値と根拠は e2e-speed.md）

| 候補 | 採否 | 要約 |
|---|---|---|
| ①smokeセット | **採用** | `npm run test:e2e:smoke`（setup＋auth＋journeys＋shell・desktopのみ）。53秒×3緑。フルの代用にしない |
| ②幅の絞り込み | **採用** | 各試験宣言直上の `// 幅:` マーカーが正本（無いと設定読み込みが例外で落ちるtripwire。孤立・未消費マーカーも4c2f176で例外化）。両幅12・phone限定5・desktop限定41＝実行122→73件・skip 3→0。仕分け表58行（e2e-speed.md） |
| ③workers≥2 | **採用** | `workers: 2` 既定化。前提=試験ごとの架空データ分離（69279d7）＋直接seedのSQLITE_BUSY吸収 |
| ④tablet-768 | **維持＋絞り込み** | @tablet-768のmanifest参照が指す2試験だけ768で実行（残3試験は768で恒真/無関係）。統合・廃止はしない |
| ⑤起動時ビルド省略 | **不採用** | `npm run build` 実測0.8〜0.9秒×3（vite 8）のため効果なし。e2e-prepareの12.5秒（D1再作成）も分離の基礎のため維持 |

- manifest: 絞り込みで実行プロジェクトが減った参照に@project付与（@desktop-1280 154件ほか）・knownSkips 3→0。`npm run check:coverage` は緑のまま（参照テスト272件）＝**網羅を欠かない**
- AGENTS.md 検証コマンド節・CI（ci.yml）・collect:evidence はコマンド形状不変（設定の既定を継承）

### T085b 未解決・残作業

- documents「題名消失」の根因（引き金）は未特定（回復ループで実害を抑止。次にDocumentEditorへ触る際の調査継続）
- wrangler devのProxyWorkerドロップはwrangler側の既知問題のため吸収は一部specのみ（残存クラスをe2e-speed.mdに記録。T086/T088のフル走行で新規発火時は同ヘルパの適用を検討）
- webServer停止滞留は経過観察（未再現）

### 最終検証（コントローラ実行・cd6b549時点。2026-10-20）

- typecheck成功／check:contracts「102 API / docs/05 102行 / OpenAPI一致」／check:coverage成功（参照テスト272件）／vitest **67ファイル322件**合格／build成功（precache 9 entries）
- `npm run collect:evidence`: vitest 322・test:load 3・e2e **73 passed / 0 failed / 0 skipped**・test:live未実施（Secret未設定）。**1回目はvitest 1 failed**〔auth-adapter `verify_totp_only_revokes_other_sessions_when_it_actually_enables_mfa`＝テスト環境でIP判定不可のauthレート制限バケット〔sign-in 5回/60秒等・config.ts:124-139のdocs/14検証値〕とファイル内連続auth呼び出しの競合。本日2回目の稀フレーキーでT085b差分〔src/無変更〕と無関係〕→ 裁定R13で `--only=vitest` によりスイート全体を同じコードで再実行（失敗した旧実行はindexのdiscardedRunsとacceptance-results.mdに記録）＝緑
- 受入ゲート: `acceptance_gate_fails_on_skip_missing_route_or_unexecuted_case` **1 passed**（codeHash一致）
- **フルe2e（`npm run test:e2e`＝業務73＋受入ゲート75）3回連続緑: run1 148 passed / 0 skipped / 0 failed（6.0分）、run2 148 passed（5.8分）、run3 148 passed（5.7分）**。skip 0（3→0）。完了条件（最終HEADで3回連続緑・skip増加なし・網羅維持・typecheck/vitest/build緑）を満たす

### レビュー — docs/evidence/ph8-review.md「T085b」節（4体並行レビュー→修正ラウンド→再レビュー全件ADDRESSED。確認済みの高・中の未解消0件）

## T086 架空データの完成版・公開デモ分離・操作説明（2026-10-20。実装完了・最終検証待ち）

実行環境はT083〜T085bと同じローカル（Node v26 / workerd / vitest / Playwright chromium）。**実Cloudflare・実staging・実Google Maps・実端末・実在の団体は使っていない**（PH0〜PH8から継続で未接続＝局所完了。下記「未実施・未接続」）。データはすべて架空。実装は分担制（コア実装→issues台帳のmedium 3件〔D2〕→low 4件〔D3〕→docs 7点〔D4〕→使い方ガイド画面〔D5〕→4体並行レビュー→fix wave 1〔本節の更新・語彙修正〕→コントローラ最終検証）。migration無し。契約変更はAPI-67（GET /notifications/me）へ `sent=true` の要求拡張のみ（契約3点セット。T085のAPI-44/51と同じ前例）。

実装コミット: **bde6533** `feat: complete T086 demo`（seed-demo・demo-isolation試験・demo.ts・DEMO_SECURITY_POLICY）→ **8ec9f26** `fix: make T086 demo reset assertion detect other-environment removals`（fix round 1）→ issues台帳: **08b523d**（PH1-A2 認証イベントの監査）・**198f792**（PH2-C15 地図チップの一覧点滅）・**0d2fed3**（PH4-B2 送信した通知とdraft再開）・**ead8421**（PH7-L）・**bcc7404**（PH1-C）・**1b0d76d**（PH2-C19）・**f0c4212**（PH3-C8の判定記録）→ docs: **47fdb84**（demo-deploy・USER_GUIDE）・**f703c13**（X-OUT-9）・**d891443**（development-completion・本節・docs/16）・**3ed5fc2**（manifest・e2e-speed）→ **da22779** `feat: implement T086 help screen`（使い方ガイド画面SHELL-HELP・jsdom 2件・e2e 1件・§1.1-28）→ レビューwave 1（4体並行レビューの指摘F1〜F16・裁定R23〜R25に基づく記録更新・語彙修正）。

### 検証（fix wave 1時点で再実行。2026-10-21）

| 確認 | コマンド | 結果 |
|---|---|---|
| 型検査 | `npm run typecheck` | 成功 |
| 契約検査 | `npm run check:contracts` | 102 API / docs/05 102行 / OpenAPI一致（API-67 sent=trueを含む） |
| 単体・結合試験 | `npx vitest --run` | **71ファイル334件成功**（T085b最終322＋T086分12: demo-isolation 1・audit 1〔PH1-A2〕・map-facilities 4〔PH2-C15 3＋PH2-C19 1〕・通知sent 1〔PH4-B2〕・login-aria 2〔PH1-C〕・job-error-label 1〔PH7-L〕・help-page 2〔da22779〕） |
| 網羅（静的） | `npm run check:coverage` | 成功。要件54 / AT54 / CT17（組220・notApplicable 0） / TC18 / API102 / SCR28 / journey4 / 実外部の残手順29 / 参照テスト272件 |
| ビルド | `npm run build` | 成功（precache 9 entries） |
| 指定試験 | `npx vitest --run tests/demo-isolation.test.ts` | 1 passed（`demo_cannot_reach_production_or_expose_real_personal_data`） |
| 幅仕分け | `npx tsx scripts/e2e-width-triage.ts --check` | 成功。全60試験（両幅12・desktop限定43・phone限定5。T086で2件追加＝PH4-B2とヘルプ画面。業務の実行はsetup1＋phone17＋desktop55＋tablet2＝75件） |
| 焦点e2e | `npm run test:e2e -- tests/e2e/shell.spec.ts --project=desktop-1280 --project=phone-360` ほかaudit.spec | shell 8 passed（ヘルプ画面e2e込み）・audit 3 passed（監査ラベル語彙変更後） |

### 作ったもの

| 部品 | 内容 |
|---|---|
| `scripts/seed-demo.ts` | `seedDemo(env)`（workerd側。冪等）とCLI（`--persist-to`。SQL直列化＋`wrangler d1 execute --file`＋R2 object put）が同じ計画 `buildDemoSeedPlan`（純関数）を共有。架空団員16名（4役割＋未登録10名＋第二分団2名）・施設13・点検様式1（承認済み）＋点検6（要確認2）・異常2・車両1・機材2・活動3（実績・実参加つき）・出動1（参集5名）・お知らせ1・通知1・帳票1（承認済み版）・タスク2・文書1（FTS索引つき）・写真/文書実体2（決定的生成の架空PNG/PDF・`demo/` prefix）。outbox（domain_events）と`units.event_sequence`はseed自身が作る（seed-load.tsと同じ作法）。実デモではbootstrap-adminが作った「架空市 第一分団」とその管理者に解決（`resolveDemoTargets`）。`verifyDemoIsolation(config)`（demo設定にproduction資源値・production専用Secret名が現れないこと＋reset射程）・`demoResetRemovals()`（resetの射程の正本）・`collectDemoPrivacyRows`＋`detectRealPersonalData`（全行走査・実在風データの検出） |
| `tests/demo-isolation.test.ts` | 指定試験（ブリーフの4断言＋周辺の6検査）: ①productionのD1/Secret差替えを注入すると検出できる（恒久対照） ②reset射程＝demo.tsの削除系呼び出しの**全件列挙**が`["DEMO_PERSIST_DIR"]`だけ（fix round 1。他環境削除1行で落ちる） ③seed全行の走査（表ごと行数をDEMO_PROFILEと厳密照合＋合成行で検出器能力を常時検査） ④書き込み先がdemo自身のD1/R2だけ ⑤主要19動線（ホーム/名簿/施設一覧〔地図データ源〕/施設詳細/点検/異常/活動/出動/文書/通知/帳票/同期/お知らせ/タスク/車両/機材/点検様式/集計/写真実体）の到達チェックリスト ⑥`DEMO_SECURITY_POLICY`でAI 30回/分の連打が429（枠内は429にしない） |
| `scripts/demo.ts` | 初回判定をmigration適用の**前**へ（`migrations apply --persist-to`がpersistを作るため、旧位置だと初回でも「2回目以降」になりbootstrap-adminが一度も走らないバグの修正）＋初回にseed CLIを接続。resetの射程は`DEMO_PERSIST_DIR`のimportで正本を1つに |
| レート/費用上限 | `DEMO_SECURITY_POLICY`（auth 60/ai 30/search 60/upload 30/default 1,200 req/分・IP、user次元はdefault 600等。**未承認の開発設定**）と`securityPolicyForEnv`（demoだけ公開デモ用。他は従来どおり）。`createApp`のpolicy既定を環境選択へ。費用上限はT080のbudget機構（月$5・AI 500回/日等）がそのまま効くため追加実装なし。Maps 2,000ロード/月はアプリ内計測不能のため**Googleコンソール側の割当**としてops/demo-deploy.md §4.3に手順化 |
| docs 7点＋ヘルプ画面 | ①ops/demo-deploy.md（分離の考え方・初回構築・reset・レート/費用上限・外部公開手順〔明示的な依頼がある時のみ〕・X-DEMO未実施明記） ②docs/USER_GUIDE.md（導入/通常利用/点検/承認/通知/通信断/復旧/困ったとき。実装の実際の画面語彙で書いた） ③docs/evidence/development-completion.md（完成の範囲・局所完了・issues要約・既知の制限。最終検証節は空欄） ④X-OUT-9: ops/account-recovery.md §5（Cloudflare側復旧の番号付き手順。V07-outage「未実施」9の状態更新・admin-handover.md §3-6の参照更新・manifest summary更新） ⑤docs/16 T086節（対応行へNFR-08追記・手順1〜3・5チェック・実施記録） ⑥本節 ⑦e2e-speed.md ⑧使い方ガイド画面SHELL-HELP（da22779。src/client/features/help/HelpPage.tsx＋routes.tsxの登録点。prototypeに個別デザインが無ため共通部品で構成＝docs/03 §1.1-28。jsdom 2件・e2e 1件〔desktop限定〕。USER_GUIDEの要点を章ごとに示す） |
| issues台帳（manifest） | **resolved 6件**: PH1-A2（認証イベント〔サインイン成功/失敗・二要素設定・再設定要求/完了〕をaudit_logsへ。秘密は載せない・unit帰属できない試行はIP回数制限が担当）・PH2-C15（useFacilitiesの再取得を非破壞に。件数を最新にする意図は保持）・PH4-B2（API-67 `sent=true`で自分が作った通知〔draft含む〕を返す＋「送信した通知」切替とResumeDraftStep）・PH1-C（ログインの誤りpと入力欄のaria関連付け等）・PH2-C19（選択シートのEsc・フォーカス。OverlayのuseOverlayを共有）・PH7-L（ai.calls計上位置・user次元429のRetry-After窓計算値・budget_stopped中立語彙等9項目）。PH3-C8は現状確認の記録のみ（open・owner未割当）。T085b-W1は最終検証のフルe2eで状態確認（コントローラ） |

### 赤→緑の扱い（正当な赤の記録）

- **コア（手順2）**: 実装前に試験のみを実行し `Cannot find module '../scripts/seed-demo'`＝未実装moduleの解決失敗で赤（T064と同じ正統な赤。runner故障ではない）。実装後の最初の実行では同期API-80のenvelope読み違いで**断言ベースの赤**も観測（`['同期（API-80）: outboxから差分が取れない']`）→修正して緑。
- **一時実証（実施後に復元・コミットに不含）**: ①チェックリスト1項目の期待を反転（DF-0001→DF-9999）→`developmentIncompleteFeatures`が非空で赤 ②membersへ実在風「山田 太郎」を注入→`realPersonalDataFound`が非空で主断言が赤 ③demo.tsへ`rmSync(".wrangler/state")`を1行注入→削除呼び出し全件列挙の断言が赤（fix round 1の恒久化の根拠）。production差替えは本試験に恒久対照として組み込み。
- **issues各件（旧実装で赤→緑）**: PH1-A2=監査行が1行も無い／PH2-C15=reload直後に`state=loading`・`items=[]`になることと失敗時に空になること／PH4-B2=サーバーはsent未知queryの400・e2eは「送信した通知」ボタン不在のタイムアウト／PH7-L=ai.callsが増える（0期待に1）・Retry-Afterに60が返る／PH1-C=idもaria-describedbyも無い／PH2-C19=フォーカスが動かない・Escで閉じない。
- **ヘルプ画面（da22779）**: jsdom 2件は旧実装（プレースホルダー）に章見出しが1つも無い・「未実装」チップが実在、で赤→実装で緑（tests/help-page.test.tsx。レビューwave 1でUSER_GUIDE文言断言を「操作説明書」へ同期）。

### 未実施・未接続（局所完了。検証済みとして扱わない）

実Cloudflare・実キー・実端末が本環境に存在しないため。番号付き残作業（ops/demo-deploy.md §5.3とdocs/evidence/development-completion.md §3が正）:

1. 実Cloudflare上のdemo環境（fireos-demo）の構築とRG-09の実地確認（X-DEMO）
2. WAF/Rate Limiting設定とレート上限値の実環境確定（docs/05 §1・docs/07 §2。アプリ内のisolate別計数は防衛線）
3. security headers/CSPの実CDN設定判断（docs/evidence/security.md §6。HTMLのCSPは未設定）
4. seed CLIの`--remote`対応（実環境demoへの架空データ投入経路。現在は`--local`専用）
5. Googleコンソール側のMaps割当設定（Maps JS API接続＝X-V05/T021後の前提整備）
6. X-OUT-9のstaging演習（整備は実施。X-OUT-1と併せて）・T084残手順（X-V01/V02/V05/V06-RT/V07-PERF/V07-RENDER/X-OUT-1/2/7/8・X-DEV-1/2/3）は未実施のまま（担当表はacceptance-results.md）

### 最終検証とレビューサイクル（コントローラが後に追記）

> `npm run collect:evidence` 再実行・受入ゲート・最終HEADでのフルe2e 3回連続緑・レビューサイクル（ph8-review.md「T086」節）確定後に、コントローラが実測値を追記する。T085b-W1（ProxyWorkerドロップの残存クラス）の状態確認もここで行う。
