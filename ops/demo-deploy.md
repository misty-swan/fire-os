# 公開デモの配信設定と運用手順（T086）

目的: 公開デモ（APP_ENV=demo）を**架空データだけ**で動かすための、①環境分離の考え方、②初回構築、③リセット、④レート/費用上限、⑤外部公開の手順を定める。対象は docs/13 RG-09（本番/デモ分離）・TC-18・docs/07 §1「公開デモは架空人物/地点/写真のみ、本番/staging/demoを別Worker/D1/R2/Google key/AI設定へ分離する」（運用境界・データ分類の節）。

**現状の正直な限界（2026-10-20時点）**: このリポジトリの検証はすべてローカル（`npm run demo`＝workerd＋ローカルD1/R2・ポート8787）で、実Cloudflareには未接続（wrangler未ログイン）。実Cloudflare上のdemo環境（`fireos-demo`）の構築・分離の実地確認（**X-DEMO＝RG-09の実地確認は未実施**）。下記の実環境手順は「実在の仕組みだけを書いた未実施の手順」であり、実施記録ではない。

## 1. 分離の考え方（docs/07 §1・RG-09・AGENTS.md）

- **実データ（実名簿・実出動・非公開水利・現場写真）は絶対に入れない。** デモに入れるのは `scripts/seed-demo.ts` が作る架空データ（氏名は「架空」、地名は「宮之浦の架空地名（デモ用の架空地点）」、メールは@example.test系、座標は宮之浦周辺の表示範囲DEMO_BBOX内の架空の点＝実在の消火栓位置を写さない）だけ。写真・文書の実体も決定的に生成した架空の8x8 PNGと1頁PDF（実在の画像・文書を模さない）。団体名だけは実名「宮之浦分団」（設計§8-2。架空である旨は画面のバッジと台本で併記）。
- 4環境（local/demo/staging/production）はWorker・D1・R2・Queuesを**共有しない**（wrangler.jsonc。wranglerのenvはbindingを継承しないため各環境に全bindingを書く）。demo環境の資源:

| 項目 | demo環境の値（wrangler.jsonc） | 備考 |
|---|---|---|
| Worker名 | `fireos-demo` | APP_ENV=demo |
| D1 | `fireos-demo`（database_id …0002。仮値） | 実作成時に実値へ置換 |
| R2 | `fireos-demo-files` | |
| Queues | `fireos-demo-jobs` | |
| AI | binding `AI`（demo/staging/productionのみ） | localはAI無し |
| AUTH_BASE_URL | `https://fireos-demo.example.invalid`（仮値） | 配置時に実URLへ（§5の4） |

- 分離は3層で検査されている（毎回の検証で自動的に確認される）:
  1. **配置ゲート** `npm run check:environment`（scripts/check-environment.ts。T078）: 4環境の必須binding・資源分離・demo→production参照の拒否・Secret混入の静的検査。CI（verifyジョブ）にも入っている。
  2. **分離の純関数** `verifyDemoIsolation(config)`（scripts/seed-demo.ts）: demo設定にproductionのD1/R2/queue/Worker名/Secret名が現れないこと・`demo:reset` の削除射程がdemoのpersistだけであることを実値（実wrangler.jsoncのパース結果）で検査する。
  3. **指定試験** `npx vitest --run tests/demo-isolation.test.ts`（`demo_cannot_reach_production_or_expose_real_personal_data`）: ①production binding/token差替えを注入すると必ず検出できること ②reset射程（demo.tsの削除系呼び出し全件が `DEMO_PERSIST_DIR` だけ） ③seedした全行（表ごとの行数をDEMO_PROFILEと照合）に実在風個人データが無いこと ④書き込み先がdemo自身のD1/R2だけ ⑤主要19動線（ホーム/名簿/施設一覧〔地図データ源〕/施設詳細/点検/異常/活動/出動/文書/通知/帳票/同期/お知らせ/タスク/車両/機材/点検様式/集計/写真実体）が全部動くこと ⑥公開デモpolicyでAI連打が429で防がれること。

## 2. ローカルの公開デモ（`npm run demo`）— 手元確認

実Cloudflareではなく手元のworkerdで動く。**ポート8787**・状態は `.wrangler/demo`（Git管理外）。初回は次を自動で行う（scripts/demo.ts）:

1. `npx tsx scripts/ensure-dev-vars.ts` — `.dev.vars`（BETTER_AUTH_SECRET等・Git管理外）が無ければ生成。
2. `npx wrangler d1 migrations apply DB --local --persist-to .wrangler/demo` — D1作成＋migration（起動のたび。適用済みは冪等）。
3. 初回だけ: `npx tsx scripts/bootstrap-admin.ts --env local --persist-to .wrangler/demo --unit-name "宮之浦分団" --admin-name "架空 岳志" --email admin@example.test` — 初期管理者の招待リンク（`http://localhost:8787/login#invite=<token>`。**一度しか表示されない**・72時間有効）。
4. 初回だけ: `npx tsx scripts/seed-demo.ts --persist-to .wrangler/demo` — 架空データの完成版＋**体験アカウント3本**（下の§2.1）を投入（下の構成）。投入済みなら「スキップ」（冪等）。
5. `npm run build` → `npx wrangler dev --port 8787 --persist-to .wrangler/demo`。ログインは `http://localhost:8787/login`（メール admin@example.test・パスワード12文字以上→二要素認証を設定。手元のログイン情報はGit管理外の `.env.demo-login` に控えてある）。

**seedが入れる架空データ**（`DEMO_PROFILE`。`seedDemo(env)` とCLIが同じ計画 `buildDemoSeedPlan` を使う）:

| 表 | 件数 | 内容 |
|---|---|---|
| units / users / members | 2 / 4 / 16 | 宮之浦分団と架空の姉妹分団「宮之浦 第二分団（デモ用）」、幹部・担当者・団員の4役割＋未登録団員10名 |
| facilities | 13 | 消火栓・防火水槽・資器材箱×4（管理番号 MY-0001〜・宮之浦の架空地点） |
| inspection_templates / facility_inspections | 1 / 6 | 承認済み様式、月次点検6件（2件は要確認） |
| issues | 2 | 点検起点1件＋手動起票1件 |
| vehicles / equipment | 1 / 2 | 架空の資機材運搬車・ホース・投光器 |
| activities / incidents | 3 / 1 | 予定1・完了2（実績・実参加つき）、出動訓練1（参集5名） |
| announcements / notifications | 1 / 1 | 公開済みお知らせ、承認済み通知（管理者の受信箱に1通） |
| reports / tasks | 1 / 2 | 承認済み版、管理者の担当タスク（進行中）と完了 |
| documents ＋ FTS索引 | 1 | 承認済み・索引済み（検索・RAGのデモが動く） |
| R2実体 | 2 | `demo/facility-photo-01.png`（架空PNG）・`demo/document-01/original.pdf`（架空PDF） |

注意: `npm run demo` はAPP_ENV=**local**（wrangler devに`--env demo`を付けない）で動くため、この起動では§4の公開デモ用policy（DEMO_SECURITY_POLICY）は**効かない**。公開デモ用のレート値を手元で確認するときは `npx wrangler dev --env demo`（varsだけdemo・資源はローカル。AI binding付き）で起動する。

### 2.1 体験アカウント3本（営業デモTask4・固定資格情報）

お客さまに手を動かしてもらうための、パスワードだけのログイン（**MFA設定なし**）アカウント。seedが3役割ぶんを作る（`src/server/auth/demo-accounts.ts`。文は純関数 `demoAccountStatements`、CLIとworkerd試験が同じ物を使う。認証identity＋業務users/名簿/役割＋監査`demo.account_created`）:

| メール | 氏名（架空） | 役割 | 権限の見え方 |
|---|---|---|---|
| `demo-admin@example.test` | 架空 体験管理者 | admin | 全員の閲覧・管理画面。ただし**二要素未設定のためPER-06/07/08の管理操作は`mfa_required`で拒否される**（認可規則は変えない。変更は体験アカウントの`/me`の二要素設定から可能） |
| `demo-officer@example.test` | 架空 体験幹部 | officer | 幹部の閲覧・承認系 |
| `demo-member@example.test` | 架空 体験団員 | member | 団員の閲覧と自分の操作 |

- **パスワードの値はこの文書にもGitにも書かない。** seed実行時（`npm run demo`の初回）に標準出力へ`demo-accounts`のJSONで**一度だけ**表示されるので、その場でGit管理外の `.env.demo-login`（`.gitignore`の`.env*`）等に控える。表示を閉じた後に失くしたら§3のリセットで作り直す。
- 生成されるパスワードは16文字以上の英数字（紛らわしい字を除く・実行ごとに新規）。**同じ資格情報を保って作り直したい**（リセット後も台紙を変えたくない）ときは `npx tsx scripts/seed-demo.ts --persist-to .wrangler/demo --demo-password <12文字以上の値>` を使う（3本ともその値になる。`npm run demo`の初回起動からではなく直接CLIで投入するときに使う。値を省いた`--demo-password`は黙ってランダム生成に落とさず使い方の誤りで拒否する）。実環境（`--remote`）では環境変数 `DEMO_ACCOUNT_PASSWORD` でも同じ（GitHub Actionsの週次リセットworkflowがSecretからこの環境変数で渡す。§3.1。フラグと環境変数の併用は拒否される）。
- `--demo-password <値>` はコマンドライン引数として渡るため、**シェルの履歴や`ps`の一覧に値が残り得る**。あくまでローカルの手元デモ専用の方法とし、共有端末・画面共有中は使わない。ふだんはseed標準出力の一度きりの表示を`.env.demo-login`へ控える方式（前項）を優先する（貼り付けは控え先のファイルから行う）。
- アカウントは架空データと独立に冪等で判定する（3本とも既に在ればスキップ・一部だけ在れば中止して教える）。既存の初期管理者（admin@example.test・二要素必須）の運用は変わらない。

## 3. リセット手順（`npm run demo:reset`）

1. `npm run demo:reset` を実行する（scripts/demo.ts --reset）。
2. 削除されるのは **`.wrangler/demo` だけ**（`demoResetRemovals()` が射程の正本）。他環境のローカル状態（`.wrangler/state`＝local開発・`.wrangler/e2e`＝e2e）も設定ファイルも触らない。productionの資源は実Cloudflare側にしか無く、ローカルのresetでは触れ得ない。
3. 改めて `npm run demo` — 初回構築（§2の1〜5）を最初からやり直す（新しい招待リンクが出る）。
4. 試験がこの射程を担保している: demo.tsの削除系呼び出し（rmSync等）を**全件列挙**して `["DEMO_PERSIST_DIR"]` だけであることを断言（他環境削除を1行足すと落ちる）。

### 3.1 実環境demoの週次リセット（GitHub Actions。Task5。実行確認はTask 7）

- workflow: `.github/workflows/demo-reset.yml`。毎週**月曜 01:00 JST**（cron `0 16 * * 0`＝日曜 16:00 UTC。GitHub ActionsのcronはUTCのみのためJST換算をworkflowのコメントに併記してある）に自動実行。Actionsの画面から手動でも起動できる（`workflow_dispatch`。失敗時の再実行もここから）。同時実行は `concurrency` で禁止している（cronと手動起動が重なると待機する）。
- 前提（初回だけ。手順の正本はops/demo-provisioning.md §5ステップ22〜25）: GitHubリポジトリSecretの **`CLOUDFLARE_API_TOKEN_DEMO`**（demo環境のD1/R2/Workersだけに権限を狭したtoken）と **`CLOUDFLARE_ACCOUNT_ID_DEMO`**、さらに体験アカウント3本の固定パスワード **`DEMO_ACCOUNT_PASSWORD`**（12文字以上。登録手順は同§5ステップ25）を登録しておく。
- **account-idの答え（Task 1で「要否はTask 5で確定」としていた論点）: 必要。** wrangler.jsoncにはaccount_idを書いていない（設定に実値を書かない方針。database_idと同じ）ため、wranglerの実環境操作はaccountの指定が要る。staging/productionの配置workflow（deploy-staging.yml / deploy-production.yml）と同じ形で、workflowはSecret `CLOUDFLARE_ACCOUNT_ID_DEMO` を環境変数 `CLOUDFLARE_ACCOUNT_ID` へ渡す。アカウントIDは秘密値ではないがGitには載せない（登録先はtokenと同じリポジトリSecretでよい）。
- workflowがやること（1コマンド。`npm run demo:reset:remote -- --confirm demo`）:
  1. demo D1（`fireos-demo`）の**全表をDROP**（wipe。sqlite内部表〔`sqlite_%`〕とCloudflare管理の表〔`_`始まり〕を除く。`d1_migrations`も消えるため、直後のmigration適用でschemaを全件作り直す）
  2. `wrangler d1 migrations apply DB --env demo --remote`
  3. 架空データのseed（`buildDemoSeedPlan`と同じ計画。wipe直後の空DBなのでunit・架空の幹部も含めて作る）
  4. R2バケット `fireos-demo-files` へ写真・文書の架空実体を上書きput（`--env demo --remote`。同じ2キーなので前週分は上書きされる）
  5. 体験アカウント3本を作る。パスワードはSecret `DEMO_ACCOUNT_PASSWORD` の固定値（workflowが**環境変数**でseedへ渡すためargv・Actionsのログに値は出ない。GitHubがログ中の値を自動マスクする。メール・役割はログに一度だけ表示される）
- 書込み規律: `--remote` は `--env demo --confirm demo` が無いと動かない（scripts/bootstrap-admin.tsと同じ確認規律）。staging/productionは `--confirm` を揃えても拒否される（scripts/seed-demo.ts）。local/remoteのコマンド列の正本は純関数 `buildSeedCommands` で、tests/demo-reset.test.ts が配列ごと固定している。
- 失敗時: GitHubの既定の失敗通知を受けたら、Actionsの画面からworkflowを手動起動（workflow_dispatch）して再実行する。データは架空なので最悪のケースは「デモが前週のまま／途中までの投入」で実害は無い。再実行は必ずwipeから始まるため冪等。
- 体験アカウントのパスワード: Secret **`DEMO_ACCOUNT_PASSWORD`** の固定値。workflowはその値を環境変数 `DEMO_ACCOUNT_PASSWORD` として `scripts/seed-demo.ts` へ渡す（argvに載せないためActionsのログや`ps`の一覧に出ない。3本ともこの値になる。週次リセット後も営業台紙の資格情報は変わらない）。手元端末から手動実行するときは同じ環境変数を渡すか `--demo-password <12文字以上の値>` を使える（フラグは§2.1と同じくシェル履歴・`ps`に残るため共有端末では使わない。フラグと環境変数の併用は拒否される）。
- R2の残格納: seedは同じ2キーを上書きするため通常は蓄積しない。wranglerのCLIにprefix一括削除もobject一覧も無いため、キーを増やす変更をした週に古いキーが残っても掃除はできない（**残ってよい運用**とする。どうしても消すときはCloudflareのダッシュボードから）。
- 実管理者（bootstrap・二要素必須）のアカウントもwipeで消える。週次リセット後のデモは**体験アカウント3本だけで運用する**（§2.1。二要素必須の管理操作〔PER-06/07/08〕を実管理者で行うときは下の復旧手順で作り直す）。
- **実管理者を作り直す復旧手順**（wranglerログイン済みの手元端末から。bootstrapはunitが一つでもあると `already_bootstrapped` で拒否されるため、最初にDBを空にする。`--wipe-only` はwipeとmigrationまで行い**seedはしない**復旧専用モード）:
  1. `npm run demo:wipe:remote -- --confirm demo` — 全表DROP → migration適用まで（D1は空のschemaで止まる。scripts/seed-demo.ts の `--wipe-only`。`--wipe`〔seedまで行う〕との併用は拒否される）
  2. `npm run bootstrap:admin -- --env demo --remote --confirm demo --unit-name "宮之浦分団" --admin-name "架空 岳志" --email <管理者のメール>` — 初期管理者の招待tokenを一度だけ表示（§5.1ステップ5と同じ。DBが空なので `already_bootstrapped` を通る）
  3. 管理者が `https://<デモのURL>/login#invite=<token>` で招待を受諾し、二要素認証を設定する
  4. `npm run demo:seed:remote -- --confirm demo` — 架空データと体験アカウント3本を再投入
- **この復旧順序が成立することの確認（2026-10-21・実装の確認）**: bootstrapはunit名「宮之浦分団」でunit（実在のUUID）と管理者団員を作る。seedは**unit名で既存の宮之浦分団を引き当てて**その実UUIDに架空データを付け足す（unitの新規作成はしない。新規作成〔固定IDのunit〕はunitが見つからなかったとき＝週次wipe直後の空DBだけの経路）。seed内の管理者の特定は「admin役割付き団員」で探し、招待受諾前で役割がまだ無いときは分団の任意団員での代替があるため、ステップ3より前にseedを実行しても失敗しない（ただし管理者の受信箱・担当タスクの宛先が代替団員になるため、**ステップ3を済ませてからステップ4**が正）。bootstrapが要求する「unitゼロ」はステップ1のwipeが担保するため、この順序以外では `already_bootstrapped` で止まる。初回構築〔§5.1ステップ5→6〕と同じ順序。

## 4. レート/費用上限の現設定と意図（いずれも**未承認の開発設定**）

### 4.1 レート上限（src/server/security/limits.ts）

demo（APP_ENV=demo）のアプリは `DEMO_SECURITY_POLICY` で動く（`securityPolicyForEnv`。policy注入が無いときの既定）。**未承認の開発設定**である（実環境の値は実Cloudflare接続後の検証とdocs/14 D11の承認で確定。docs/05 §1・docs/07 §2）:

| バケット（対象） | IP単位 | user単位 | 意図 |
|---|---|---|---|
| auth（/api/auth/*の後段） | 60回/分 | 60回/分 | 資格情報を受ける経路はライブラリ側が5回/分/IP（sign-in等・D1計上）で締める。ここは総当たりを遅らせる後段の防衛線 |
| ai（API-29/32/77/89） | 30回/分 | 30回/分 | 高価な系列。デモの少数試用で足りる幅に絞る |
| search（API-76） | 60回/分 | 60回/分 | 同上 |
| upload（API-83） | 30回/分 | 30回/分 | 同上 |
| default（通常API・同期poll） | 1,200回/分 | 600回/分 | デモ閲覧に十分な幅 |

- **アプリ内の計数はisolate内メモリ**（Workerの1実行体ごと）であり、複数isolateでは合計がこの値×isolate数に緩む。**厳密な全体上限はCloudflare側のWAF/Rate Limiting製品層で行う前提**（docs/evidence/security.md §6の限界節。実環境での設定・検証は未実施＝§5の残作業1）。
- 指定試験が実要求で観測している: AI系のcap（30回）までは429にせず、cap+2回の連打で429が出ること。

### 4.2 費用上限（T080のbudget機構・config/budget-development.json）

`BUDGET_POLICY`（src/shared/budget-policy.ts が正本を検査）: 月額上限 **$5**・AI呼出し **500回/日**・通知配送 **2,000通/日**・429許容10件/日。`approved: false`＝**未承認の開発用検証設定**（実請求との照合は未実施。docs/evidence/cost-estimate.md・ops/cost-alerts.md）。超過でAI分類・報告書生成・出典つき回答・横断アシスタントが停止（読取は止めない。jobはmanual_review budget_stopped）。急増・監視項目はwarnのみで**停止には使わない**（ops/cost-alerts.md §1）。この機構はデモに限らず全環境で同じ値で動く。

### 4.3 Google Maps「デモ2,000ロード/月」はGoogleコンソール側で確保する

docs/07 §8の試算（本番30人×10ロード＋デモ2,000＝2,300/月）のうちデモ分の2,000ロード/月は、**Maps JavaScript APIのロード数をアプリ内で計測できない**（APIを呼ぶのは端末のブラウザであり、サーバーに計測点が無い）ため、**Google Cloud Console側の割当（quota）で確保する**。手順（Maps JS APIの接続＝T021/V05の残手順。接続前にやっておく前提整備）:

1. デモ用のGoogle Cloudプロジェクト・browser keyを本番用とは**別に**作る（docs/07 §6「環境別key」）。keyはMaps JavaScript APIのみ許可し、referrer制限をデモのURLに限定する。
2. Google Cloud Consoleで Maps JavaScript API の割当（Quotas）画面を開き、1日あたりのリクエスト上限を設定する（月2,000ロードの水準を超えない値。日次上限で代用する）。**この割当がアプリ外の実効上限**になる。
3. 同じプロジェクトに予算（budget）と予算アラートを設定し、超過の予兆をメール等で受け取れるようにする（予算アラートは課金の停止ではない点に注意。docs/07 §6）。
4. 上限値・アラート先の変更はdocs/14 D11（費用の管理主体の了承）を経て行う。

## 5. 実Cloudflare上の公開デモ（未実施の手順。**外部公開の実行は明示的な依頼があるときだけ**）

**外部公開の実行は、利用者からの明示的な依頼があるときだけ行う。** 依頼が無いまま §5.2 の配置・公開を進めない。資源の作成・Secretの設定だけを先に済ませることは妨げない。

### 5.1 初回構築手順（番号付き）

1. 資源の作成: D1 `fireos-demo`・R2バケット `fireos-demo-files`・Queue `fireos-demo-jobs` をCloudflareに作成し、D1の実database_idをwrangler.jsoncのdemo環境へ反映する（仮値 …0002と置き換える。R2/Queuesは名前参照のため設定変更不要）。
2. Secret: `npx wrangler secret put BETTER_AUTH_SECRET --env demo`（32バイト以上の乱数。チャット・メール本文・Gitに貼らない。ops/deploy.md §0）。
3. migration: `npm run migrate -- --env demo --remote --yes-i-know`（`--env` と `--yes-i-know` が無いと実環境へ適用不可＝scripts/migrate.tsのガード）。
4. AUTH_BASE_URL: wrangler.jsoncのdemo環境の `AUTH_BASE_URL` を実URL（例: `https://<デモのドメイン>`）へ置き換える（仮値 `https://fireos-demo.example.invalid` のまま）。
5. 初期管理者: `npm run bootstrap:admin -- --env demo --remote --confirm demo --unit-name "宮之浦分団" --admin-name "架空 岳志" --email <管理者のメール>`。標準出力のJSONの `token` が招待token（一度だけ表示・72時間有効）。ops/bootstrap-admin.md参照。
6. 架空データの投入: `npm run demo:seed:remote -- --confirm demo`（Task 5で実装。wipe無しの `--remote` seed。ステップ5のbootstrapが作ったunit〔実在のUUID・実在の管理者〕に架空データと体験アカウント3本を付け、R2 `fireos-demo-files` へも架空実体を置く。冪等なので再実行で重複しない。**初回の実行・確認はTask 7**）。週次の作り直し（全表DROPからのやり直し）は§3.1の `demo:reset:remote` を使う。
7. 配置: ops/deploy.md §2と同じゲート（typecheck・check:contracts・check:migrations・build・check:environment・vitest・e2e）を通してから `npx wrangler deploy --env demo`。稼働versionを運用記録へ残す。
8. 確認: ①招待リンク（`https://<URL>/login#invite=<token>`）で初期管理者の登録・二要素設定ができる ②主要動線（§1の3の⑤と同じ19動線）が動く ③未定義APIがJSON 404を返す ④監査に記録が残る ⑤`DEMO_SECURITY_POLICY` が効いている（AI連打が429）。
9. Googleコンソール側の上限（§4.3）を設定する（Maps接続後でもよいが、公開前に済ませる）。

### 5.2 外部公開の実行（明示的な依頼があるときだけ）

1. 依頼の内容（対象URL・公開期間・窓口）を運用記録へ残す。
2. §5.1の8の確認が緑であること・§5.3の残作業1〜3（WAF・CSP・seed）の状態を依頼者へ伝えた上で了承を得る。
3. デモのURLを公開する（案内文はdocs/USER_GUIDE.mdを添える）。
4. 公開後はops/cost-alerts.mdの月次確認（費用・AI回数・ Maps割当の残り）を行う。

### 5.3 番号付き残作業（実Cloudflare接続後に確定するもの。局所完了の理由）

1. **WAF/Rate Limiting設定とレート上限値の実環境確定**（docs/05 §1・docs/07 §2・docs/evidence/security.md §6限界節）: アプリ内のisolate別計数は防衛線に過ぎないため、Cloudflareの製品層でIP/経路ごとの全体上限を設定し、実測で確定する。値はdocs/14 D11の承認材料にする。
2. **security headers/CSPの実CDN設定判断**（docs/evidence/security.md §6）: API応答のsecurity headersは実装済み（T081）だが、SPAのHTML（ASSETS経由）へのCSPは未設定。実CDN/ホスティングの構成が確定してから判断する。
3. **seed CLIの実環境（--remote）対応**（§5.1の6）: 実装済み（Task 5。`npm run demo:seed:remote`〔投入〕と `npm run demo:reset:remote`〔週次リセット＝全表DROPからのやり直し〕。コマンド列と拒否規律は試験が静的に固定〔tests/demo-reset.test.ts〕）。この環境に実Cloudflareが無いため実行実績は無く、初回の実行・確認はTask 7（X-DEMOの実地確認と合わせる）。
4. **X-DEMO（RG-09の実地確認）**: 公開デモ（分離した実環境）の構築と本番データとの完全分離の実地確認。未実施（acceptance-results.md「実外部の残手順」。この環境に実Cloudflareが無いため局所完了＝§1の3層の検査とローカル実測だけ実施）。

## 6. やってはいけないこと

- 実データ（実名簿・実出動・非公開水利・現場写真）をdemoへ入れること・Gitに載せること（AGENTS.md）
- 体験アカウント（§2.1）のパスワードをGit・文書・チャットに載せること（seed標準出力の一度きりの表示で受取り、`.env*`に控える）
- demoのtoken・Secret・招待リンクをチャット・メール本文・Gitに貼ること
- 依頼が無いまま外部公開すること・productionの資源をdemoから参照すること（check:environmentが拒否する）
- Google Mapsの課金上限を「予算アラートで担保した」として割当設定を省くこと（アラートは停止ではない）
