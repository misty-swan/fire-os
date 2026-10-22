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

## 追加確認（ステップ19の反映確認・2026-10-22）

- Referer無しでの `maps.googleapis.com/maps/api/js?key=…` が拒否されること、Referer=デモURLで通ることをcurlで確認した結果: **（反映待ちの間は通ってしまった。設定反映後に再確認してここへ記録する）**

## 環境の分離（X-DEMO・RG-09の実地確認）

- demo環境は専用のD1（fireos-demo: `5f08f3de-b642-48a7-8420-6523f1cdfa3d`）・R2バケット（fireos-demo-files）・Queue（fireos-demo-jobs）へ接続。**staging/production環境はまだ存在しないため、実データとの混在は構造的に起こり得ない**。データは全て架空（AGENTS.md・demo-isolation試験のとおり）。
- 既知の限界（記録どおり）: 独自ドメイン（zone）が無いため**WAF/Rate Limitingのカスタムルールは未設定**（ops/demo-deploy.md §5.3-1）。防御はアプリ内DEMO_SECURITY_POLICY（上記5のとおり実効）とCloudflareの自動DDoS保護のみ。

## デプロイ中に見つけて直したこと

- `wrangler d1 execute --remote` はSQLの `BEGIN TRANSACTION` を拒否する（D1の仕様）。seed/wipeのSQLから明示的トランザクションを除去（**e7cba90**・正の対照つき）。ローカルでは許容されるため従来の試験では発見できなかった。`scripts/seed-load.ts`（local専用）は未変更。
- R2はアカウントで初回のみダッシュボードでの有効化（checkout）が必要（code 10042）。 ops/demo-provisioning.md §1へ補足追記済み。
- Mapsキーはビルドルート（`src/client`）の `.env.local` から読まれる（リポジト直下ではない）。opsの該当箇所を修正済み。
