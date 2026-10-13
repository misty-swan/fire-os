# PH0 実行証跡（2026-10-13）

対象: T001〜T006。実行環境はローカル（Node v26 / workerd 1.20260815系 / wrangler 4.150.0 / vitest 4.1.11 / Playwright chromium）。**実Cloudflareアカウント・実D1/R2/Queues・GitHub Actionsは使っていない。**

## 実行結果
| 確認 | コマンド | 結果 |
|---|---|---|
| 型検査 | `npm run typecheck` | 成功 |
| 契約検査 | `npm run check:contracts` | 101 API / docs/05 101行 / OpenAPI一致 |
| 単体・結合試験 | `npx vitest --run` | 6ファイル 66件成功（workers: runtime/contracts/schema/mutation/jobs、client: client-shell） |
| ブラウザ試験 | `npm run test:e2e` | 7件成功＋1件スキップ（スマホ専用試験をPC幅で除外） |
| ビルド | `npm run build` | 成功（dist/client） |
| 手動確認 | `npx wrangler dev` | `/app/unknown`=HTML、`/api/v1/x`・`/api/auth/x`=JSON 404 |

## タスク別の指定試験
T001 `api_route_never_returns_spa` / T002 `contract_registry_is_complete_and_strict` / T003 `cross_unit_fk_and_zero_row_guard_are_enforced` / T004 `losing_update_leaves_no_child_audit_or_event` / T005 `accepted_job_and_conflict_are_not_saved_success` / T006 `lease_expiry_never_duplicates_effect` — すべて成功。

## 赤→緑の扱い（正直な記録）
T001・T003・T004・T006は先にテストを書き「未実装/表なし」で失敗することを確認してから実装した。**T002・T005は実装を先に書き、試験を後から作った**。代わりに、契約や実装を意図的に壊して試験が失敗することを確認した（strict解除、API削除、202を「保存しました」表示、誤り欄へのフォーカス除去、二重送信防止除去など）。T004・T006でも防御を外す変異で検出を確認した。

## 未実施・未接続（実装済み/検証済みとして扱わない）
- 実Cloudflare D1・R2・Queues・Cron、Workers AI、実環境への deploy/migration（`scripts/migrate.ts --remote`は実行していない）
- GitHub Actions（`.github/workflows/ci.yml`は作成のみ。未実行）
- 実端末・スクリーンリーダー・200%拡大・実回線（T083）。フォントはGoogle Fontsを使用（ネットワーク必須、未読込時はアイコン枠を固定して崩れを防ぐ）
- `x-test-identity`は試験専用の仮の認証。本物のセッション認証/最新認可はT007/T008
- 応答DTOの多くは`provisional`（各機能タスクで04/10に合わせて厳密化）
- API-80（events）の方式、API-36（認証ライブラリ）の固定版スキーマは未確定（D16/V01）
- OpenAPIは契約の生成物であり、業務処理の実装を意味しない（業務APIはAPI-86を除き未実装＝PH1以降）

## スクリーンショット
`docs/evidence/ph0/shell-phone-360.png`、`shell-desktop-1280.png`（prototypeの配色・形に合わせた共通shell。内容はプレースホルダー）。
