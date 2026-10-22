# 公開営業デモの実URL確認記録（Task 7・demo-live-check）

判定時点: 2026-10-22 / URL: **https://fireos-demo.hiromu1018ks.workers.dev** / Worker: fireos-demo（Version `50ad31ac-91f8-4ce2-a97d-6aa8c72b3e41`） / APP_ENV=demo

## 確認結果（2026-10-22 実施）

| # | 確認（ops/demo-deploy.md §5.1 ステップ8） | 結果 | 根拠 |
|---|---|---|---|
| 1 | 初期管理者の招待受諾・二要素設定 | ✅ | auth_users の owner@miyanoura.example.test が two_factor_enabled=1（D1実査。招待は72時間token・標準出力一度きり） |
| 2 | 主要動線（実機） | ✅（部分） | 利用者が自分のスマホで体験アカウント（demo-member）でログインし**地図（宮之浦の実地図+架空マーカー）の表示を確認**。点検登録〜AIまでの全19動線の実機全数は未実施（営業前の推奨チェックとする） |
| 3 | 未定義APIがJSON 404 | ✅ | `GET /api/v1/nonexistent` → `{"error":{"code":"NOT_FOUND"...}}` + HTTP 404（curl） |
| 4 | 監査に記録が残る | ✅ | audit_logs 7件（seed分。D1実査） |
| 5 | DEMO_SECURITY_POLICY の実効（429） | ✅ | 誤ログイン7連打: 5×401 → 2×**429**（同一IP。curl） |
| 6 | CSP（HTML応答・実URL） | ✅ | content-security-policy 応答ヘッダー確認（maps/fonts/gstatic許可・frame-ancestors 'none'）。**地図が実機で描けた=maps系の許可は実効**。`worker-src blob:` のコンソール確認は実機コンソール未開のため継続監視（違反が出たら cspHeaderValue の1行修正→再配置。ops/demo-deploy.md §5.1-8⑥） |
| 7 | 配信物にMaps実装とキー | ✅ | 配信JS（index-DNmvVA6N.js）に maps/api/js ローダー同梱。キー値は`src/client/.env.local`（Git管理外）からビルド時に埋め込み |
| 8 | データ（架空のみ） | ✅ | D1実査: units=2（宮之浦分団+第二分団）/ members=19（団員16+owner+体験3）/ facilities=13（全てDEMO_BBOX内の架空点）/ 体験3本 two_factor=0 |
| 9 | R2の架空実体 | ✅ | demo/facility-photo-01.png（268B）・demo/document-01/original.pdf（607B）がリモートバケットに存在（--remoteで確認） |
| 10 | Mapsキーの参照元制限（手順書ステップ19） | 🔄 | 利用者がGoogleコンソールで設定済みの旨。制限の実効（Referer無し要求の拒否）は反映確認が残る→下記「追加確認」へ |

## 追加確認（ステップ19・2026-10-22確定）

- **Mapsキーの参照元制限は有効**: 利用者がGoogleコンソールで「アプリケーションの制限=ウェブサイト」に `https://fireos-demo.hiromu1018ks.workers.dev` を設定済み。プロジェクト内のキーは1本のみ（設定対象の取り違えなし）。
- **検証方法の記録（再発防止）**: Maps JavaScript APIのローダー（`/maps/api/js`）は制限の有無にかかわらず全参照元へ配布され、**制限の判定はブラウザ実行時の内部認証呼び出しで行われる**（公式: developers.google.com/maps/api-security-best-practices「確認はブラウザのデバッグコンソール」2026-10-22確認）。curlでローダーURLを取得して判定しようとすると「制限が無い」と誤判する（実際に誤判した）。許可側は実機で地図が表示済み＝実証。
- **拒否側の実証（2026-10-22）**: 同キーでWeb API（ジオコーディング）をRefererなしで直接呼ぶと `REQUEST_DENIED: "API keys with referer restrictions cannot be used with this API."` ——**サーバー経由の利用は拒否されることをCLIから実証**（＝参照元制限が有効であることの外部証拠）。他サイトへの埋め込みが弾かれることは上記ブラウザ実行時認証の仕組みによる。

## 環境の分離（X-DEMO・RG-09の実地確認）

- demo環境は専用のD1（fireos-demo: `5f08f3de-b642-48a7-8420-6523f1cdfa3d`）・R2バケット（fireos-demo-files）・Queue（fireos-demo-jobs）へ接続。**staging/production環境はまだ存在しないため、実データとの混在は構造的に起こり得ない**。データは全て架空（AGENTS.md・demo-isolation試験のとおり）。
- 既知の限界（記録どおり）: 独自ドメイン（zone）が無いため**WAF/Rate Limitingのカスタムルールは未設定**（ops/demo-deploy.md §5.3-1）。防御はアプリ内DEMO_SECURITY_POLICY（上記5のとおり実効）とCloudflareの自動DDoS保護のみ。

## デプロイ中に見つけて直したこと

- `wrangler d1 execute --remote` はSQLの `BEGIN TRANSACTION` を拒否する（D1の仕様）。seed/wipeのSQLから明示的トランザクションを除去（**e7cba90**・正の対照つき）。ローカルでは許容されるため従来の試験では発見できなかった。`scripts/seed-load.ts`（local専用）は未変更。
- R2はアカウントで初回のみダッシュボードでの有効化（checkout）が必要（code 10042）。 ops/demo-provisioning.md §1へ補足追記済み。
- Mapsキーはビルドルート（`src/client`）の `.env.local` から読まれる（リポジト直下ではない）。opsの該当箇所を修正済み。

## T090 デモ欠陥修正の反映（2026-10-22・GitHub issues #1〜#7）

- **修正内容**: seed計画の様式3種（施設・車両・資機材）を実項目付き承認版+現行版ポインタ設定で作り直し、体験アカウント3本とownerを出欠・お知らせの対象へ加え（増幅SQL=`buildDemoAccountAugmentation`。体験宛の通知1通〔1通だけ既読〕と体験団員の担当タスク1件を含む）、AIレビュー候補1件（pending）と期限超過の車両点検schedule、手動起票異常のreported（未確認）を初期データに追加。プライバシー走査はunit名解決へ、seedの管理者解決は作成順（bootstrap由来優先）で決定的に（D1〜D7）。詳細はdocs/16 T090・課題台帳（tests/acceptance/manifest.json）の各basis。
- **ローカル実証**: `demo:reset` 相当（persist作り直し→migration→bootstrap-admin→seed CLI）で実DBを確認 — 様式3種とも current_version_id 設定・item_schema 4項目 / 体験3本+ownerとも activity_audience 3行（出欠回答0行=未回答1以上）/ 通知 recipients=4（既読1）/ 進行中タスク2（体験団員の担当を含む）/ reported異常1 / schedule 1（2026-10-19で超過）/ ai_evaluations pending=1。
- **実環境（fireos-demo）への反映**: 承認済み様式版は不変トリガーでUPDATEできないため、反映は**全表DROPからのseed再構築**で行う（`demo:reset:remote --wipe` または `demo:wipe:remote`＋手順）。**2026-10-22の実施**: T090のpush後、demo-reset workflowをdispatchして完全反映した（run 39727264080・成功）。wipe無しの `demo:seed:remote` は緊急回避策で、増幅SQL（対象の拡充・体験宛通知/タスク・様式の追い版+ポインタ付け替え）で①様式選択・②出欠403・③通知/タスクの導線は回復するが、**plan適用をスキップするため初期データの追加分（AIレビュー候補・reported異常・期限超過schedule）は入らない**点に注意。
- **事故と復旧（2026-10-22）**: 上記のdispatchで**実管理者（owner@miyanoura.example.test・二要素必須）がwipeで消え、ログインできなくなった**（週次リセットが毎回ownerを消す設計だった）。ops/demo-deploy.md §3.1の復旧手順（wipe-only→bootstrap-admin→seed）でownerを作り直した（招待tokenは72時間有効）。これを受けて**週次workflowをwipe無しの再投入（demo-refresh）へ変更**した——owner・体験アカウント・営業中の入力（出欠回答等）は毎週残る。全消去が欲しいときだけ手動wipe（ownerの作り直しは§3.1）。
- **週次リセット後の初回確認（営業前チェックリストへ）**: 体験アカウントで①ホームの数字タイルが0でない ②点検登録の様式選択に3様式が出て項目が入力できる ③予定の出欠回答が403にならない ④通知タブとAIレビュー一覧が空でない。
