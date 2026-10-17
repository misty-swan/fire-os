# デプロイ・migration・rollbackの手順（T078）

目的: stagingへの再現可能な配置、CI失敗・環境誤接続・互換外migrationでの自動停止、schemaを含むrollback手順を定める。productionは**正式リリース判定（docs/13の全ゲート合格、管理主体＋開発責任者の承認）後のみ**操作する。実リポジトリでのGitHub Actions実行はまだ未実施（T078時点。workflowの内容は tests/deploy-config.test.ts が検査している）。

## 0. 前提（wrangler.jsoncの規律・docs/02 §2）

| 環境 | Worker名 | APP_ENV | D1 / R2 / queue | AI | 用途 |
|---|---|---|---|---|---|
| local | fireos-local | local | fireos-local（仮id …001） | **無し** | wrangler dev・試験 |
| demo | fireos-demo | demo | fireos-demo（…002） | 有 | 公開デモ（架空データのみ） |
| staging | fireos-staging | staging | fireos-staging（…003） | 有 | 配置・migration・実Cloudflare検証 |
| production | fireos-production | production | fireos-production（…004） | 有 | 正式判定後にのみ操作 |

- wranglerの `env.*` はbindingを**継承しない**。環境の追加・変更時はその環境に全bindingを書く（書き漏れは `npm run check:environment` が必須bindingの欠落として止める）。
- `database_id` 等は仮値。実環境の作成時に実値へ置き換える（Secretはここへ書かない）。
- **Secretの管理**: `BETTER_AUTH_SECRET` はlocalのみ `.dev.vars`（`npm run dev:vars` で生成、Git管理外）。demo/staging/productionは `npx wrangler secret put BETTER_AUTH_SECRET --env <環境>` で設定する（32バイト以上の乱数。チャット・メール本文・Gitに貼らない）。CIのtokenも環境別に分け、権限はその環境の資源のみに狭す（GitHub Environment secrets: `CLOUDFLARE_API_TOKEN_STAGING` / `CLOUDFLARE_ACCOUNT_ID_STAGING`、productionは `..._PRODUCTION`）。
- `TEST_AUTH` / `TEST_MIGRATIONS` は試験専用binding。wrangler設定のdemo/staging/productionには書かない（`check:environment` が拒否する）。

## 1. 必須ゲート（1つでも失敗したら配置しない）

CI（`.github/workflows/ci.yml`）と配置workflowの `verify` ジョブは、次をこの順で実行する。`deploy` ジョブは `needs: verify` なので、verifyが失敗すれば配置は実行されない。

1. `npm run typecheck` — 型検査（tsc --noEmit。lint/formatterの代わりの主ゲート）
2. `npm run check:contracts` — API台帳×docs/05×OpenAPIの一致（古い生成物の検出）
3. `npm run check:migrations` — 連番（欠番・重番の拒否。migrate.tsと同じ規律）、適用済み履歴の書き換え検出（git HEAD比較）、破壊的変更の段階化（次節のマーカー）
4. `npm run build` — vite build → dist/client
5. `npm run check:environment` — **Secret検査を含む**: 4環境の必須binding・資源分離（demo→production参照の拒否、RG-09/CT-15）、/apiをSPA fallbackへ流さない設定、varsとdist/にSecret名が現れないこと
6. `npx vitest --run` — workers（実workerd＋D1/Queues）とclient（jsdom）の両方
7. `npm run test:e2e` — Playwright（phone-360 / desktop-1280の両プロジェクト）

`check:environment` / `check:migrations` は試験（tests/deploy-config.test.ts）と同じ純関数を実ファイルに対して実行する。試験は注入した誤設定を、CLIは実リポジトリを検査する。

## 2. stagingへの配置（再現可能手順）

初回のみSecretを設定する:
```
npx wrangler secret put BETTER_AUTH_SECRET --env staging
```
以降はGitHubの `deploy-staging` workflow（workflow_dispatch。verify全ゲート→migration→deploy）か、同等の手順:
```
npm ci && npm run typecheck && npm run check:contracts && npm run check:migrations && npm run build && npm run check:environment && npx vitest --run
npm run migrate -- --env staging --remote --yes-i-know   # 先にexpand（追加のみ）を適用する（§4.2）
npx wrangler deploy --env staging
npx wrangler deployments list --env staging              # 稼働versionを運用記録へ
```
- migrationは `--env` と `--yes-i-know` 無しでは実環境へ適用不可（scripts/migrate.tsのガード）。
- 配置後の確認: 未定義API routeがJSON 404を返す、アプリ画面が読める、監査に記録が残る。稼働version・commit・日時・実施者を運用記録に残す。

## 3. productionへの配置（正式判定後のみ）

- **docs/13の全ゲート（RG-01〜RG-10）合格と、リリース版/日/対象/環境/復旧点/runbookの承認がある版のみ**配置する。判定前の動作確認はstagingで行う。
- workflowは `deploy-production`。workflow_dispatchの `confirm` 入力が正確に `production` で、mainからの起動のときだけ動く（それ以外は何もしない）。GitHub側でEnvironment "production" に承認者レビュー（保護ルール）を設定し、二重に誤起動を防ぐ。
- 実施前にD1 exportとR2のmanifestを取り、復元点として保管する（docs/07 §7、docs/14 D10、T079のbackup手順と組み合わせる）。手順自体はstagingと同じ（`--env production`）。

## 4. rollback

### 4.1 Workerコードのrollback

```
npx wrangler deployments list --env <環境>     # 前のversionを特定
npx wrangler rollback --env <環境>             # 対話で対象versionを選ぶ
```
- コードだけを戻す。**D1 schemaは戻さない**（次節）。旧workerは新schema（expand済みの追加列・表）でも稼働するようにmigrationを段階化してある。
- 戻した版・理由・影響を運用記録とissueへ残す（監査はアプリ内の証跡であり、運用判断の記録はここには残らない）。

### 4.2 schema rollback — コードを戻すだけでは解決しない

方針は**forward-fix（前に進めて直す）**。`DROP COLUMN` 等を適用した後で旧コードへ戻しても、削除された列は復元されない。schemaを「戻す」必要が生じたら、次の順で考える。

1. **適用済みmigrationは書き換えない・削除しない。** 履歴が適用済みDBと一致しなくなると、以後のmigration適用が拒否され、どの時点から再開できるかも分からなくなる。履歴の書き換えは `check:migrations`（git HEAD比較）が検出して停止する。
2. **破壊的変更は必ず段階化する（expand → backfill → contract）。**
   - expand: 列・表の**追加のみ**（旧workerでも稼働可）。最初に適用する。
   - backfill: データ退避（UPDATE等。schemaの破壊ではない）。
   - contract: 旧列・旧表の削除。**新workerを配置した後**に別のmigrationとして行う。ファイルには `-- deploy: contract` と `-- requires: <expandのNNNN>` を書く（無いと `check:migrations` が失敗させる。マーカーはファイルに残るので、適用済みcontractも検査を通る）。
   - contractを適用した環境へ旧workerを戻すことは**できない**。contractの適用は「この版以降へしか戻さない」という決定とセットで行う。
3. **誤適用・データ破壊などで過去時点へ戻す場合は、コードrollbackではなく復元になる。**
   - D1: Time Travel（Free 7日 / Paid 30日）または日次exportからの復元。RTO/RPOはD10（24時間案、未承認）。R2本体はTime Travelで復元できないため、manifestと重要原本の別複製を使う。
   - 復旧runbookはdocs/07 §7の順（影響把握→新規mutation/配送停止→復元点選定→stagingで復元→欠落/孤児/重複/ACL照合→sessions失効・authz_version更新→旧job/effect照合（**外部送信を再実行しない**）→管理主体承認→再開）。**R2を先に削除してDBだけ戻す手順は禁止。**
   - 実データ投入前に復元演習を1回、正式リリース前に全機能込みで再演習する（docs/07 §7）。
4. **`compatibility_date` を戻す・変えるときは** docs/02 §2 の記録と tests/runtime.test.ts を再確認し、workerd挙動の差分を実測してからにする。

## 5. 失敗・中断の規律

- CI / verifyジョブが失敗 → deployジョブは実行されない。手動でも続行しない。
- `check:environment` が環境誤接続（demo→production参照等）やSecret混入を検出 → 停止し、wrangler.jsoncを直して再実行する（実装の省略で緩めない）。
- migration適用の失敗 → `wrangler d1 migrations apply` の原子性はSQL単位。適用状況は `npx wrangler d1 migrations list DB --env <環境> --remote` で確認し、未適用分のみ再適用する。部分的に壊れた状態での強行はしない（§4.2の3.の復元へ）。
- 環境を跨ぐ操作（demoのtokenでproductionへ、等）をしていないことを、実施前に `check:environment` と手順の `--env` 表示で確認する。
