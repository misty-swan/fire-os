# 実端末・アクセシビリティ測定マトリクス（T083）

Interfaces（docs/16 T083）どおり `flowId / steps / duration / success / errors / device / version` で測定結果を保存する。
**この環境にはiOS/Androidの実端末・実スクリーンリーダー・PWA install環境が無い。** 自動実行できた行（chromiumのエミュレーション）と、実端末での未実施行を**厳格に区別**して記録する。未実施行は下の番号付き手順で、実端末を借りられる人がそのまま実施できる形にしてある。

- version: アプリは `fire-os 0.0.0`（package.json。コミットはdocs/evidence/V07-ux.mdに併記）
- 測定日: 2026-10-18
- 自動実行の詳細（測定条件・手法・断言の根拠）は docs/evidence/V07-ux.md

## 1. 自動実行の結果（chromiumエミュレーション。実端末ではない）

### 1.1 再訪フロー（coreTaskSuccessRate の対象5フロー＋地図代替）

- flows: `attendance_answer`（出欠回答）／`inspection_photo_save`（写真つき点検の保存）／`issue_confirm`（異常の確認）／`citation_original_open`（引用〔原本〕の閲覧）／`sync_recover`（通信断→下書き→同期復旧）／`map_failure_list_alternative`（地図を使わず一覧だけで点検の導線まで）
- steps: 各フローの手順は e2eの添付（`ux-matrix.json` / `revisit-matrix.json`。steps配列に日本語の手順と操作数が残る）
- thresholds: 成功率0.9と操作数の上限は**docs/14 D18の開発案値（承認済み合格値ではない）**

| flowId | device | success | operations（実測） | duration（実測） | errors |
| --- | --- | --- | --- | --- | --- |
| attendance_answer | chromium-emulated-360 | 成功 | 2 | 878ms | なし |
| inspection_photo_save | chromium-emulated-360 | 成功 | 6 | 3,683ms | なし |
| issue_confirm | chromium-emulated-360 | 成功 | 2 | 545ms | なし |
| citation_original_open | chromium-emulated-360 | 成功 | 2 | 641ms | なし |
| sync_recover | chromium-emulated-360 | 成功 | 3 | 10,929ms | なし |
| map_failure_list_alternative | chromium-emulated-360 | 成功 | 2 | 215ms | なし |
| 5フロー一式（再ログイン後） | chromium-emulated-768 | 成功（1.0=5/5） | 2/6/2/2/3 | 計≈16.8秒 | なし |
| 5フロー一式（再ログイン後） | chromium-emulated-1280 | 成功（1.0=5/5） | 2/6/2/2/3 | 計≈16.7秒 | なし |

※操作数・時間の実測は 2026-10-18 の `npm run test:e2e`（accessibility.spec / revisit-flows.spec の `[flow]` 記録と添付matrix）。成功の判定は**サーバー検証読み**（出欠の版・点検の記録・異常の状態・原本の取得・同期の反映）。

### 1.2 アクセシビリティ測定

| 測定 | device | 結果 | 手法 |
| --- | --- | --- | --- |
| criticalAccessibilityViolations（axe critical違反） | chromium-emulated-360 / 768 / 1280 | **0件**（3幅とも） | axe-core 4.14（@axe-core/playwright）。WCAG 2.1 A/AA規則セットでホーム/マップ/点検登録/同期の状況を走査 |
| markerTextLabelsMissing（地図マーカー/一覧のテキストラベル欠落） | 〃 | **0**（3幅とも） | マーカーのaccessible name＋面上のテキスト（管理番号）、一覧の行テキストを機械断言 |
| unreachableCoreControls（keyboardで到達できないコア操作） | 〃 | **0件**（3幅とも） | ネイティブfocusable/tabindexの構造確認＋実際のTab走査（上限80ステップ。出欠・点検・マップ・文書・同期の主要操作） |
| 200%文字拡大で出欠が隠れず押せる | 〃 | **押せた**（3幅とも） | CDPのPage.setTextZoomFactorは本Chromiumに未実装のため rootへのCSS zoom注入で代替（文字だけでなくレイアウト全体が拡大＝文字ズームより厳しめ） |
| 色除去（achromatopsia）で文字が読める | 〃 | **読めた**（3幅とも） | CDP Emulation.setEmulatedVisionDeficiency('achromatopsia')。種別チップと一覧の状態文字で確認 |
| 読み上げ（アクセシブルネーム/role） | 〃 | **機械断言で代替**（axe name/role＋getByRole。全フローがnameで操作できた） | 実スクリーンリーダーの確認は§2の残手順 |

## 2. 実端末の未実施行（番号付き残手順）

**すべて未実施。** 実端末（iPhone/Android/PC＋スクリーンリーダー）を借りられる人が、この順に実施して結果をこの表に追記する（success/errors の欄を埋め、分からなければ「不明」と正直に書く）。所要は全工程で約40分。

### 共通の準備

1. 本アプリの実環境URL（staging等。ローカルLANの場合はPCと同じWi-Fi）を端末のブラウザーで開く
2. テスト用の招待（架空団員）を受領してログインする（二要素は任意。実データは入れない。名前は「試験（架空）」等と分かる形にする）
3. 結果の記入方法: 各手順の末尾の【期待】と違ったら、画面の写真（スクリーンショット）と操作の説明を errors に記録する

### 2.1 iPhone（Safari / VoiceOver）— viewport実測は390幅相当

1. ホームを開き、VoiceOverを起動（設定→アクセシビリティ→VoiceOver、または.sideボタン3回押し〔ショートカット設定済みの場合〕）
2. ホームの「次回の予定」ダイヤルをVoiceOverで読み上げさせる（1本指スワイプで要素を移動）【期待】日付・種別・題が**文字として**読み上げられる（画像化されていない）
3. 予定の詳細を開き、出欠の「参加」ボタンへ移動して低い音でダブルタップ（=タップ）【期待】「選択中」「押された」等の状態変化が読み上げられ、「あなたの回答」が参加に変わる
4. マップを開き、マーカーを1本指でなぞる【期待】各マーカーが「消火栓 〇〇」等の**名前として**読み上げられる（色だけに依存していない。NFR-09）
5. 200%文字拡大: 設定→ Safari → ページズーム 200% をこのサイトに設定し、ホーム→予定の詳細→「参加」まで同じ操作ができるか【期待】操作が隠れず、横スクロールしなくても読める
6. 通信断→復旧: 機内モードにして出欠を変更（「結果を確認できません」の表示を確認）→機内モードを解除→「同期の状況」を開く【期待】「未同期 1件」から始まる同期が自動で走り「反映 1件」と出る（SCR-27）
7. PWA: Safariの共有ボタン→「ホーム画面に追加」→ホーム画面のアイコンから起動【期待】起動する（インストール可能性の実端末確認。T074の残手順でもある）
8. resultsの記録: flowId=revisit-real-ios / steps=上記1〜7 / duration（実測分）/ success（完出来た手順数/7）/ errors

### 2.2 Android（Chrome / TalkBack）— 360dp相当の端末ならなお良い

1. TalkBackを起動（設定→ユーザー補助→TalkBack）
2. ホーム→「やること」の指標タイルを読み上げる【期待】数値と行き先が文字として読める
3. 点検登録を開き（マップ→マーカー→点検する、または施設一覧から）、様式→結果→**端末カメラで実際に1枚撮影**→保存【期待】写真の検査（準備完了）が実回線で進み、保存できる（端末カメラ・実回線での点検。e2eはファイル添付の代替）
4. 写真の読み上げ: 添付した写真の要素をTalkBackで読ませる【期待】「点検写真」等の名前がある（無名のボタンとして読まれない）
5. 200%文字拡大: Chromeの設定→アクセシビリティ→テキストサイズを最大にし、出欠の回答まで進める【期待】操作が隠れない
6. 通信断→復旧（2.1の6と同じ。Wi-Fiを切る/機内モード）【期待】「反映 1件」
7. PWA: Chromeメニュー→「アプリをインストール」→インストール→ホームから起動【期待】起動する
8. resultsの記録: flowId=revisit-real-android / 同様の形式

### 2.3 PC（Windows+NVDA または macOS+VoiceOver）— 1280幅

1. スクリーンリーダーを起動し、キーボードだけで「メインコンテンツへ移動」→Tabで予定の詳細まで進む【期待】フォーカス順が読み上げ順と一致し、#mainへフォーカスが移る（shell.specと同じ挙動）
2. 出欠の「参加」をEnterで押す【期待】ボタンの状態（aria-pressed）の変化が読み上げられる
3. 文書の詳細→「原本を開く」をEnterで開く【期待】PDFがダウンロードされ、リンクの名前が「原本を開く」として読まれる
4. 200%: ブラウザーのズーム（Ctrl/Cmd + +）を200%にして、ホーム→予定→出欠まで進む【期待】操作が隠れない
5. 同期の状況を開き「もう一度送る」をキーボードで操作できる【期待】Enterで実行できる
6. resultsの記録: flowId=revisit-real-pc / 同様の形式

### 2.4 結果の取扱い

- 実施したら、この表の該当行に success/errors/device/version（iOS/AndroidのOSバージョン・ブラウザー名）を追記し、docs/evidence/V07-ux.mdの「未実施」セクションを実施済みへ更新する
- 【期待】と違う結果が出たら、それを**合格に見せない**（docs/13の判定は実測値で行う）。fixは通常のタスクとして起票する
