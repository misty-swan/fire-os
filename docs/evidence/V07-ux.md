# V07 実端末・アクセシビリティ・再訪操作の検証（T083局所／実端末・実スクリーンリーダー・実PWA install環境は未実施）

目的: NFR-01（対応端末）/NFR-02（少数操作で完了）/NFR-09（色に依存しない・地図のラベルと一覧代替）を、月1〜2回しか使わない団員の**再訪操作**（出欠回答・写真点検・異常確認・引用閲覧・同期復旧）で検証し、検出した欠陥を修正する（docs/08 AT-NFR-01/02/09、docs/14 D18、docs/13 RG-02/CT-14）。

**この文書の数字はchromiumのエミュレーション（360/768/1280）での実測であり、iOS/Androidの実端末・実スクリーンリーダー・実PWA install環境での測定は未実施**（ops/device-test-matrix.md §2の番号付き手順で実施するまで、実端末に関する合格判定には使わない。偽の完了記録は書かない）。

**coreTaskSuccessRateの閾値0.9はdocs/14 D18の開発案値（操作成功率90%以上案）であって、承認済みの合格値ではない**（D18は「値未決で合格にしない」〔docs/14 D18〕。操作数の上限も現在の導線の実測に余裕を持たせた回帰ガードであり、承認値ではない）。

## 方式

- runner: `npm run test:e2e`（playwright。webServerはD1再作成→migration→初期管理者→`wrangler dev`の実経路。projectsはphone-360〔Pixel 5・360x740〕/desktop-1280/`tablet-768`〔T083で新設・768x1024・本タスクの新規2spec限定〕）。
- 試験: `tests/e2e/accessibility.spec.ts`（`returning_user_finishes_inspection_and_attendance_without_hidden_controls`。ブリーフの4断言を含む）と `tests/e2e/revisit-flows.spec.ts`（`revisit_core_flows_complete_in_few_operations_after_relogin`。再ログイン後の5フロー＋操作数）。共通部品は`tests/e2e/revisit-helpers.ts`（flowId/steps/operations/durationMs/success/errorsの記録つきフロー）。
- 再訪フローの測定対象: `attendance_answer`（出欠回答・API-08）/`inspection_photo_save`（写真つき点検の保存・API-14）/`issue_confirm`（異常の確認・API-17の定型操作）/`citation_original_open`（引用〔原本〕の閲覧・API-27）/`sync_recover`（通信断→下書き→同期復旧・SCR-27）。成功の判定は**画面表示ではなくサーバー検証読み**（API-07/44/15/出欠の版）で行う。
- 通信断の注入: offline-sync.specと同じ方式（ブラウザをofflineにせず、本人出欠のPUTだけを`route.abort`。保存失敗→同じIdempotency-Keyで下書き→回復後の同期で1回だけ適用）。
- 測定結果の保存: 各試験が`ux-matrix.json`/`revisit-matrix.json`を添付（InterfacesどおりflowId/steps/duration/success/errors/device/version）。この文書の表はその転記。

## 計測手法（エミュレーションの正直な記録）

| 測定 | 手法 | 限界（正直な記録） |
| --- | --- | --- |
| criticalAccessibilityViolations | axe-core 4.14（`@axe-core/playwright`・T083でdevDependencyへ追加）。WCAG 2.1 A/AAの規則セット（`withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"])`）でホーム/マップ/点検登録/同期の状況の4画面を走査し、`impact==="critical"`のみを断言対象にする（serious以下も件数は記録） | 実スクリーンリーダーの読み上げそのものではない。代替としてアクセシブルネーム/roleの機械断言（axe＋getByRole）を行い、実機確認は残手順 |
| 200%文字拡大 | **CDPの`Page.setTextZoomFactor`は本実行のChromium（playwright 1.64同梱）に存在しないことを確認済み**（2026-10-18・`Protocol error ... wasn't found`）。代替としてrootへCSS zoom（`document.documentElement.style.zoom = "2"`）を注入 | CSS zoomは文字だけでなくレイアウト全体を2倍にするため、文字ズームのみの拡大より**厳しめの条件**。ブラウザー本来の文字ズームとの差は実端末手順（ops/device-test-matrix.md §2.3の4）で確認する |
| 色除去 | CDP `Emulation.setEmulatedVisionDeficiency("achromatopsia")`（全色を無彩色化）。種別チップの文字・一覧の状態文字が読めることを断言 | 色覚の多様性（1型/2型/3型）のうち全色覚欠損のみ。軽度の色覚特性は対象外 |
| keyboard到達 | 構造確認（button/a/input/select/textarea/summaryのネイティブ要素またはtabindex≥0）＋**実際のTab走査**（blur→Tab連打で目的の操作へフォーカスが移るか・上限80ステップ） | フォーカスリングの視認性・スクリーンリーダーの仮想カーソルは未確認（実機手順） |
| markerTextLabelsMissing | マーカーのaccessible name（種別＋管理番号）と面上のテキスト（管理番号）、一覧の行テキストを機械断言 | 「地図障害」の再現は、本アプリの地図面が実地図タイルに依存しないプレースホルダー（docs/14 V05で未接続）のため、**「地図を見ずに一覧だけで点検の導線まで進む」形**で実施した。実地図タイル障害（タイル取得失敗時に操作できるか）は実端末手順 |
| 読み上げ | axe（name/role）＋getByRole断言で代替 | VoiceOver/TalkBackでの実際の読み上げは未実施（実機手順 §2.1/§2.2） |

## 実測（chromiumエミュレーション。実端末ではない）

### 再訪フロー（成功・操作数・時間）

- **phone-360（Pixel 5エミュレーション）の実測**（accessibility.spec〔初回フロー〕。2026-10-18・ローカルwrangler dev＋D1）:

| flowId | success | 操作数 | duration | 主な手順 |
| --- | --- | --- | --- | --- |
| attendance_answer | 成功 | 2 | 878ms | 一覧→行→「参加」（サーバー反映を検証読みで確認） |
| inspection_photo_save | 成功 | 6 | 3,683ms | 様式→良好→写真（検査待ち含む）→確認→保存→詳細へ戻る |
| issue_confirm | 成功 | 2 | 545ms | 異常の行→「確認する」（理由入力なしの定型操作） |
| citation_original_open | 成功 | 2 | 641ms | 文書の行→「原本を開く」（PDFのdownloadイベント） |
| sync_recover | 成功 | 3 | 10,929ms | 未定→「結果を確認できません」→回復→同期の状況→反映（サーバーで版=2を確認。二重適用なし） |
| map_failure_list_alternative | 成功 | 2 | 215ms | 「一覧」ボタン→行→詳細→点検の導線まで |

- **coreTaskSuccessRate = 1.0（5/5）**。他の2幅も同様（tablet-768: 983/3,665/674/568/10,891ms・desktop-1280: 985/3,684/566/652/10,884ms。いずれも成功率1.0）。`revisit-flows.spec`（**再ログイン後**の5フロー）も3幅すべて成功率1.0（phone-360: 1,006/3,696/523/683/10,906ms。実行間の揺らぎは数十ms程度）。
- 操作数の実測は出欠2/点検6/異常2/引用2/同期3。回帰ガードの上限（実測＋余裕・承認値ではない）は出欠4/点検10/異常4/引用3/同期5で、revisit-flows.specが毎回断言する。

### アクセシビリティ測定

| 測定 | phone-360 | tablet-768 | desktop-1280 |
| --- | --- | --- | --- |
| criticalAccessibilityViolations | **0件** | **0件** | **0件** |
| markerTextLabelsMissing | **0** | 0 | 0 |
| unreachableCoreControls | **0件** | 0件 | 0件 |
| 200%拡大で出欠が押せる | 押せた（aria-pressed断言つき） | 押せた | 押せた |
| achromatopsiaで文字が読める | 読めた（チップ・状態文字） | 読めた | 読めた |

- 走査画面はホーム/マップ/点検登録/同期の状況の4画面（WCAG 2.1 A/AA規則セット）。serious以下の違反は**断言対象外**で、件数は試験実行の添付（`ux-matrix.json`）に記録される（本タスクのゲートはcritical 0件のみ）。
- 「一覧代替」は3幅とも成功（phone 215ms/tablet 197ms/desktop 110ms。PCは右パネルの一覧が常設のため切替操作0）。

## 検出・修正した欠陥（赤→緑の証跡）

### R1 offline下書きのscope識別子（ph6-review A低3の決着）

- **欠陥**: 下書きのscope.unitIdに**分団の表示名（`MeData.unitName`）**を使っていた（src/client/offline/capture.ts・me.tsx・SyncPage.tsx）。表示名は分団の改名で変わるため、**改名の後に保存済みの下書きが一覧（SCR-27）から消え、同期されない**。識別子は不変の`units.id`であるべき。
- **修正（契約3点セット）**: `Me` DTOへ`unitId: Id`を追加（src/shared/contracts/auth.ts）→ `src/server/routes/me.ts`が`p.unitId`（毎要求D1引き直し済みのPrincipalの列）を返す → `openapi/fireos.json`再生成（`npm run generate:contracts`）→ docs/05 API-01行に追記 → クライアント3箇所（capture.ts/me.tsx/SyncPage.tsx）のscopeを`me.unitId`へ切替。
- **赤の証跡**: `npx vitest --run tests/offline-store.test.ts` → `proxy_mobilization_is_never_captured_as_a_draft_but_self_mobilization_is` が `AssertionError: expected [] to deeply equal [ 'op-self' ]`（テストはscopeにunitId〔units.id〕を期待し、meには表示名とidの両方を渡した。旧実装は表示名をscopeに積むため、unitIdでのlistに下書きが現れない＝実欠陥のシグナル）。**緑**: 同テストが通る（他3ファイルclient-shell/authorization/operations-panelも含め40件PASS）。
- **データ移行**: IDBにunitNameスコープで保存済みのdraftは、切替後のscopeでは一覧対象外になる。**正式リリース前で実データが無いこと**を確認済み（Git・公開物は架空データのみ）のため移行コードは書かず、ここに記録するだけとする。
- **型ゲートの捕獲**: MeDataへのunitId追加により tests/client-shell.test.tsx のMeData fixture 4箇所が型エラーになり修正（unitId追加）。tests/authorization.test.tsの「API-01が返す列は契約どおり」の allowlist もunitIdを追加（内部列の漏えい検査の目的は不変）。

### R2 出動詳細の同期の札（ph6-review 要確認2の決着）

- **判断**: IncidentPageの同期の札（ドット＋テキスト）は**現設計を維持**。ドット（`aria-hidden`・緑/黄）は**通信状態**（オンライン/オフライン）を、テキスト（SYNC_LABEL: 「オンライン・この記録を同期中」「通信を確認して同期をやり直しています」「オフライン（回復したら同期します）」）は**同期の状態**を担い、NFR-09の色非依存はテキスト側が満たす（`role="status"`＋`aria-label="同期の状態"`）。realtime.specがテキストの変化を既に断言している。
- **コード変更は無し**（判断と根拠の記録だけ）。docs/03 §1.1-22にT083判断として追記済み。

### R3 運用パネルの403表示の統一（ph7-review C低4の決着）

- **prototype本体のgrep結果**: 管理パネルの403表現は**prototypeに存在しない**（`管理者`を含む文言はログイン画面の案内とDesktopのtoast「団員の追加・削除は管理者権限が必要です」のみ。403/権限不足のパネル表現は無し）。そこで**監査ログ（AuditPanel）の前例**（`Banner tone="error" eyebrow="FORBIDDEN" role="alert"`）へ統一した。二要素認証の未設定案内（403ではない）はNotice warningのまま。
- **修正**: OperationsPanel.tsxの403（旧: Notice warning「この情報は管理者だけが表示できます。」）→ `Banner tone="error" eyebrow="FORBIDDEN" role="alert" title="運用（費用と障害）を表示できません"`＋「この操作は許可されていません。」（role="alert"で読み上げにも出る）。docs/03 §1.1-23⑥に記録。
- **赤の証跡**: `npx vitest --run tests/operations-panel.test.tsx` → `shows_admin_only_on_403_and_avoids_calls_until_mfa_ready` がFAIL（新断言: `getByRole("alert")`のFORBIDDEN Banner＋旧文言の不使用。旧実装はNotice warningのまま＝実表示の差）。**緑**: 同テストPASS。

### R4 documents.specのトースト断言の作り直し（ph7-review #9の決着）

- **欠陥**: 「保存しました」断言（文書作成・ACL変更）がトースト（2.6秒で自動消失・MutationStatus）への**固定時間依存**で、保存の応答が5秒を超えると**保存成功でも断言が落ちる**（フレーク）。
- **赤の証跡（フレークの再現）**: documents.specへ一時ミューテーション（POST /api/v1/documentsの応答を6秒遅らせるroute）を入れて旧断言のまま実行 → `expect(locator).toBeVisible() failed ... Timeout: 5000ms ... 保存しました`（応答は後に成功しており、断言だけが落ちた＝時間依存の実再現。runner故障ではない）。**緑（同じミューテーション下）**: 断言を「`waitForResponse`で保存の応答（201）を待ってから、`role=status`へスコープしたトースト断言」へ作り直したうえで同じ6秒遅延を注入した実行でPASS（応答がどれだけ遅くても断言は時間に依存しない）。**その後ミューテーションを除去**（コミット済みのコードに遅延は残さない）。断言の意味（保存成功の可視フィードバック）は保持。

### e2e本体の赤（ブリーフstep 1-2）

- `npm run test:e2e -- tests/e2e/accessibility.spec.ts --grep returning_user_finishes_inspection_and_attendance_without_hidden_controls` の初回実行は **FAIL**（seedの並びの不備〔役割付与を受領前に実行し422〕で到達できず、2回目はseed専用文脈の不備〔Pixel 5エミュレーションのpage fixtureでsetInputFilesが固まる＝documents.spec冒頭に既存の経験則〕でseed内の版作成が進まずtest timeout）。これらは**実欠陥ではなくrunner/seedの欠陥**なので赤の根拠には使わず、修正のうえ再実行した。
- 実欠陥として赤になったのは上記R1（jsdom）・R3（jsdom）・R4（遅延ミューテーション下のdocuments.spec）。**axe/ラベル/keyboardの各断言は既存画面が優秀なため初期合格だった**（赤にならなかったことの正直な記録。偽装せずここに明記する）。

## 未実施（番号付き残手順）

- **実端末（iOS/Android）・実スクリーンリーダー（VoiceOver/TalkBack）・実PWA install環境での確認は未実施。** 手順は **ops/device-test-matrix.md §2** に番号付きで記録した（利用者が自身の端末で実施できる手順書の形。flowId/steps/duration/success/errors/device/versionの記録形式つき）。
- 実端末での確認が済むまで、NFR-01/02/09の**実機に関する部分**を合格とは扱わない（RG-02・D18承認条件の実測と同じ扱い）。
