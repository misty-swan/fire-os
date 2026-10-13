# V01 認証のWorkers/D1適合性（T007）

固定版: **better-auth 1.7.7**（`package.json` は `--save-exact`、lockあり）。D1は組込みの kysely アダプタ（`database: env.DB`）。Drizzleアダプタは使わず、表は `drizzle/0004_auth.sql` に手で置き、列名は `config.ts` の `modelName/fields` でライブラリのスキーマに合わせた（`getAuthTables` の出力と照合）。

## 実施したこと（ローカルworkerd＋ローカルD1）

| 確認 | 結果 | 試験 |
|---|---|---|
| 招待なしの自由sign-upは拒否（403 `INVITATION_REQUIRED`）。招待tokenなし・別メール宛token・メールだけ一致は全て拒否 | 合格 | `auth_works_in_workers_without_public_signup` |
| 招待どおりの登録→Cookie（HttpOnly・SameSite=Lax）→ログイン→ログアウト→セッション無し | 合格 | 同上 |
| 他origin（`Origin: http://evil.example`）の変更要求は認証経路・業務APIとも403。Originが無く `sec-fetch-site: cross-site` も403 | 合格 | 同上／`only_contracted_auth_endpoints_are_reachable_and_cross_origin_writes_are_refused` |
| 契約外の認証経路（update-user / delete-user / social / change-email / GET reset-password）は届かない（JSON 404） | 合格 | 同上 |
| ログイン失敗の応答は「パスワード違い」と「未登録」で同一 | 合格 | `login_wrong_password_is_rejected_and_unknown_user_looks_the_same` |
| パスワード12文字未満は拒否、保存は平文でない | 合格 | `password_policy_and_hashed_storage` |
| 再設定: 登録の有無を応答に出さない／tokenはDBにhash／一回限り／成功で旧セッション失効／旧パスワードは使えない | 合格 | `password_reset_token_is_hashed_one_time_and_revokes_old_sessions` |
| TOTP: パスワード再確認で開始、検証前は未有効、ログインは第二要素まで未セッション、回復コードは暗号化保存・各一回限り | 合格 | `totp_second_factor_and_one_time_backup_codes` |
| 全セッション失効（`deleteUserSessions`） | 合格 | `revoke_all_deletes_every_session_of_the_identity` |
| IP単位の回数制限をD1に保存（6回目のログイン失敗が429） | 合格 | `sign_in_is_rate_limited_per_ip_in_d1` |
| 環境設定の不備を起動時に拒否（短い鍵・本番系の開発鍵・httpのbaseURL） | 合格 | `auth_env_misconfiguration_is_rejected_at_startup` |

壁時計の目安（ローカルworkerd、`--disableConsoleIntercept`で表示）: sign-up（パスワードhash含む）約80ms、ログイン約55ms。**これは実Workersの「CPU時間」ではない。**

## 判明したこと（設計への反映）

- Better Auth のD1アダプタはD1の対話型トランザクションを使えない（batch/個別文）。**認証側の書込と業務の招待消費は同一transactionにならない**。docs/07 の方針どおり、認証identityを先に作り、業務側の招待消費＋団員リンクは別のD1 batch（`executeMutation`）で原子的に行う。リンク前のidentityには業務アクセスを与えず（毎要求 `users` と `members` を引く）、期限を過ぎた孤児identityは回収する（T009）。
- パスワードhash（scrypt）が最も重いCPU処理。Workers Freeの10ms/要求に収まる保証はない。**実測は実Workersで行う（下記・未実施）**。収まらない場合はPaid（CPU 30秒上限）で運用するか、hash方式の変更（`emailAndPassword.password.hash/verify`の差し替え）を再検証する。
- 再設定tokenなどの識別子は `verification.storeIdentifier: "hashed"` でDBにhash保存できる。これにより「DBを読めても再設定できない」。引き換えに、試験では配送コールバックで捕捉する必要がある。
- IPが取れない場合、ライブラリは固定の代替IPで数えるため全利用者が同じ枠を共有する。Cloudflare上では `cf-connecting-ip` が必ず付くので `advanced.ipAddress.ipAddressHeaders` に指定。試験は要求ごとにIPを名乗る。
- 回復コード・再設定の配送手段（メール等）はD04（未決）。**配送は未実装で、`sendResetPassword` は何も送らない**（`AuthDeps.deliverReset` が差し込み口）。運用上は招待配送と同様に「開発用の手渡し/検証先」を使う（`ops/account-recovery.md`）。

## 未実施（検証済みとして扱わない）

**実Cloudflare（staging/demo）上のV01は未実施。** 理由: この環境の `wrangler` は未ログイン（`wrangler whoami` が "You are not authenticated"）で、アカウント・APIトークン・実D1がない。T007の完了条件のうち「モック以外のV01証跡」は、ローカルworkerd上の実行（モックではない実ライブラリ・実D1(SQLite)・実workerd）までを満たし、**実Workersでの実行は残る**。

残作業と手順（ユーザーの操作が必要）:
1. Cloudflareアカウントを用意し、`npx wrangler login`（または `CLOUDFLARE_API_TOKEN` に D1/Workers 編集権限のトークン）。
2. stagingの資源を作る: `npx wrangler d1 create fireos-staging`、`npx wrangler r2 bucket create fireos-staging-files`、`npx wrangler queues create fireos-staging-jobs`。出力された `database_id` を `wrangler.jsonc` の `env.staging` に設定。
3. Secret: `npx wrangler secret put BETTER_AUTH_SECRET --env staging`（32文字以上の乱数。`dev-only-` で始めない）。`AUTH_BASE_URL` を実際のhttps URLにする。
4. `npx wrangler d1 migrations apply DB --remote --env staging` → `npx wrangler deploy --env staging`（**`--env` なしの deploy は禁止**）。
5. `npm run bootstrap:admin -- --env staging --remote --unit-name 架空市消防団第一分団 --admin-name 架空管理者 --email <検証用メール>` で初期管理者の招待tokenを得る（ops/bootstrap-admin.md）。
6. `LIVE_BASE_URL=https://<staging> LIVE_BOOTSTRAP_EMAIL=<上と同じ> LIVE_BOOTSTRAP_TOKEN=<token> npm run test:live` を実行。壁時計を転記する。
7. CPU時間: Cloudflare ダッシュボードの Workers → Metrics（CPU time p50/p99）または `npx wrangler tail --env staging --format json` の `cpuTime`（sign-up/loginを数回）を記録し、Freeの10ms/Paidの上限に対する余裕を判定。
8. この文書の「未実施」を、実測値と判定に書き換える。

この手順を実行するまで、V01は **局所のみ検証済み・実環境は未検証**。RG-03/04/10 は引き続き阻止される。
