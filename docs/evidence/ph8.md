# PH8 実行証跡（2026-10-18〜。T083）

対象: **T083 実端末・アクセシビリティ・再訪操作の検証修正**（PH8の最初の1タスク。T084以降は未着手）。実行環境はローカル（Node v26 / workerd / wrangler 4.x / vitest / Playwright chromium）。**実Cloudflare・実staging・実端末（iOS/Android実機）・実スクリーンリーダー・実PWA install環境は使っていない**（PH0〜PH7から継続で未接続・実端末は本環境に存在しない）。データはすべて架空。実装はsubagent-driven（実装サブエージェント1体→コントローラ検証→4体並行レビュー〔docs/evidence/ph8-review.md〕）で遂行。実装コミットは **7bb8d08** `feat: complete T083 ux`（25ファイル・実装・試験・契約3点セット・docsを同一コミットに。BASE=f8f0c4d）。

## 実行結果

| 確認 | コマンド | 結果 |
|---|---|---|
| 型検査 | `npm run typecheck` | 成功（実装者・コントローラ両方で実行） |
| 契約検査 | `npm run check:contracts` | **102 API / docs/05 102行 / OpenAPI一致**（API-01 MeDataへ`unitId`追加の契約3点セット〔台帳・docs/05・OpenAPI再生成〕を同一コミットで実施） |
| 単体・結合試験 | `npx vitest --run` | **65ファイル291件成功**（PH7最終と同数＝新規jsdom試験は既存ファイル内追加。workers＝実workerd＋D1/Queues、client＝jsdom） |
| ブラウザ試験 | `npm run test:e2e` | **フル2回とも 94 passed / 3 skipped（モバイル限定試験のdesktopスキップ）/ 0 failed**（実装サブエージェント実行・約12分/回。既存87本に新規2spec×3プロジェクト分を追加。**R4修正後のフレーク再現なし**。既知フレーキーだったdocuments.spec desktopトースト断言は本実行で2回とも緑） |
| ビルド | `npm run build` | 成功（precache 9 entries） |
| 負荷試験 | `npm run test:load` | **触らない**（T085/T086の範囲。ユーザー指示） |
| カバレッジ | `npm run check:coverage` | **触らない**（T085/T086の範囲。ユーザー指示） |

## T083の指定試験

`returning_user_finishes_inspection_and_attendance_without_hidden_controls`（tests/e2e/accessibility.spec.ts新規）＋ `revisit_core_flows_complete_in_few_operations_after_relogin`（tests/e2e/revisit-flows.spec.ts新規。ブリーフ外の追加だがInterfacesの測定〔成功率/操作数/時間〕を独立回帰ガード化するもの）— 新規2spec×3プロジェクト（phone-360 / desktop-1280 / **tablet-768新設・本2spec限定**）で全PASS。

- **4断言**（ブリーフ指定どおり）: `criticalAccessibilityViolations`（axe critical違反=0。@axe-core/playwright 4.14.0・WCAG 2.1 A/AA・ホーム/マップ/点検登録/同期の状況の4画面。serious以下は記録のみ）／`coreTaskSuccessRate`（再訪5フローの成功率1.0≥0.9。**閾値はdocs/14 D18の開発案値であって承認済み合格値ではない**〔V07-ux.md・docs/16・試験コメントの3箇所に明記〕）／`markerTextLabelsMissing`（マーカーのaccessible name＋面上テキスト＋一覧行=0件欠落）／`unreachableCoreControls`（ネイティブfocusable構造＋Tab実走査=空）
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

## prototype準拠

画面（prototype語彙・導線）への変更はR3の403表示1箇所のみ（prototypeに管理パネルの403表現が無いことをgrepで確認済み＝docs/03 §1.1-23に記録）。新規は試験・docsのみで画面追加なし。44px押下領域・トースト位置・文言語彙の既存規約は無変更。axe走査の対象4画面は既存画面の確認であり変更ではない。
