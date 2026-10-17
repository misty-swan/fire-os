# V07 復元の整合と外部効果の照合（T079局所／実D1・実R2への復元演習は未実施）

方式: **manifest＋論理ダンプによる別環境復元＋復元後の自動照合**（docs/07 §7、docs/08 CT-08、docs/13 RG-05、docs/14 D10）。実装は `src/server/backup/manifest.ts`（`buildBackupManifest(env)`。manifest＝D1復元点/R2 key+hash/参照/論理削除時刻/既送delivery/未確定job/session失効基準）、`src/server/backup/restore.ts`（`readDump`/`applyRestore`/`verifyRestore(env, manifest)`。FK/hash/ACL/job/索引/外部配送差分/失効基準の照合）、CLIラッパ `scripts/backup-manifest.ts` / `scripts/restore-verify.ts`、手順書 `ops/backup-restore.md`。

## 実施したこと（ローカルworkerd＋ローカルD1/R2。実Cloudflareは含まない）

`tests/restore-consistency.test.ts`（workers試験。実worker＋実D1エンジン＋実R2(miniflare)上で実行、2ケースとも合格）:

| 確認 | 結果 | 条件 |
|---|---|---|
| `restore_does_not_resend_notifications_or_revive_old_sessions` の4断言 | **foreignKeyErrors=[] / missingReadyObjects=[] / resentAlreadyAcceptedDeliveries=0 / oldSessionAccepted=false** | seed: 承認済み通知（1人既送・1人拒否で再送待ち）＋ready実体2件（1件はtombstone＝削除猶予）＋実ログインsession。復元先は試験用の2つ目のD1（DB_FRESH。実環境でいう「別環境へ復元」相当） |
| 既送の再送が起きないことの動的観測 | 復元後に配送jobを実際に回し、provider.sendは**既送のdeliveryKeyに0回**、未送分（retry_wait）は1回（配送の継続） | deliveryKey＝通知ID＋recipient＋channelの固定キー（docs/07 §5）。「バックアップがある」ことではなく「復元後に再送が起きない」ことを観測 |
| 旧sessionが業務に入れないこと | 復元後sessions失効（`users.session_revoked_before`＝復元点。API-38と同じ機構）で `resolvePrincipal` が401 `session_revoked` | 実ログイン（better-auth）のCookieを使い、認証ライブラリのsession行が復元で復活した状態でも業務側が拒否する経路を観測 |
| 孤児（参照しないready実体）の照合 | `verifyRestore` がR2 list（ready/前置き）とD1の参照を突き合わせ、孤児を `orphanReadyObjects` に報告する（回収はしない。docs/07 §3.7） | CLI（wrangler）にはR2一覧が無いため、この照合はWorkers試験経路のみ。実環境ではR2インベントリ等で別途確立（未実施） |
| 追記専用表の復元契約 | audit_logs/domain_events等（8表）はトリガーがDELETE・上書きINSERTを拒否するため、**復元先が空でないと `applyRestore` が拒否する** | 復元は「新規にschemaを作った別環境」のみ。監査・履歴を復元で書き換えられない（docs/07 §1と一致） |
| `verify_restore_detects_missing_object_lost_deliveries_and_unrevoked_sessions` | 実体の欠落・hash破損・孤児・既送delivery行の復元漏れ・失効基準の改変を注入 → **全項目が報告され `ok: false`** | 検出能力の裏付け（positiveだけの空回りを防ぐ。CT-08の「消失写真/孤児/既送通知/旧sessions」の検査が効いていることの確認） |

## ローカルCLIでの実行記録（実行可能な手順の実証）

`ops/backup-restore.md` §2/§4のコマンドを、ローカルの `fireos-local`（負荷用の架空データ: members 1000＋facilities 300＋audit_logs 2000＋roles 4＋units 1＝**3,305行、ダンプ1.2MB**）で実行した:

| 手順 | コマンド | 結果 | 所要時間 |
|---|---|---|---|
| バックアップ | `npx tsx scripts/backup-manifest.ts --backup-dir … --db fireos-local` | d1-data.sql（3,305行・sha256記録）＋manifest.json＋r2-state複製 | **約4秒** |
| 復元＋照合 | `npx tsx scripts/restore-verify.ts --manifest … --scratch /tmp/… --r2-state …` | `ok: true`（全差分リスト空。schema新規作成→ダンプ適用→sessions失効→照合→R2実体のhash照合まで） | **約12秒** |

- `wrangler d1 export` は **FTS5仮想表で失敗する**ことを実測した（`D1_ERROR: cannot export databases with Virtual Tables (fts5)`）。そのため論理ダンプはCLIが表ごとのSELECTから作る。この制約は docs/07 §7 に反映済み。
- FK照合の検出能力は、復元済みDBへsqlite3で直接参照切れの行を作り（`PRAGMA foreign_keys=OFF` での手作業＝外部ツール由来の破れの再現）、`PRAGMA foreign_key_check` が `{table: members, parent: units}` を報告することで確認した（D1バインディング経路ではFKは常に強制されるため、この検査は外部ツール由来の破れの検出用）。

## ローカル実測RTO/RPO（条件つき。D10の開発用検証設定）

- **RTO（復元〜照合完了）: 約12秒**（上表。ローカル同一マシン、3,305行。アプリ再開・限定確認・承認の時間は含まない。実環境の手作業を含めればrunbook §5の全工程になる）
- **RPO（損失許容）: 日次ダンプ案＝最大24時間**（docs/14 D10の推奨案を検証設定として採用。**未承認**。Time Travelが使えればそれより短いが、実環境での動作確認は未実施）
- この数字を「実環境のRTO/RPO」とは読まないこと（データ量・網羅が桁違い。実測は下記「未実施」2）。

## 未実施（検証済みとして扱わない）

**実Cloudflare（実D1/R2）に対するバックアップ・復元演習は未実施。** 理由: ①この環境の`wrangler`は未ログインで実環境に接続できない、②実環境のTime Travel・実データ量での挙動・費用がこの環境では計測できない。ローカルworkerd＋ローカルD1/R2での合格を「実環境での合格」とは扱わない。NFR-06（バックアップ・復元方法の文書化と実運用前の復元試験）の「実運用前」の試験はこの限界を踏まえて未達と判定すべき（docs/13 RG-05も未検証のまま）。

残作業と手順（ユーザーの操作が必要。実行すれば証跡が取れる形）:
1. `npx wrangler login` と `npx wrangler d1 create`（実環境。仮database_idの置き換えはops/deploy.md §0）まで済ませ、stagingへ`npm run migrate -- --env staging --remote --yes-i-know`でschemaを作る。
2. stagingで実データ（架空データ投入後）に対して: ①`npx wrangler d1 export fireos-staging --remote` がFTS5制約で失敗するかを実測してops/backup-restore.md §3.1へ記録、②Time Travelの復元点確認、③R2複製の手順確立（§3.3。費用・権限はdocs/14 D11と管理主体の了承）、④manifest＋ダンプ＋複製を1本作成し、`scripts/restore-verify.ts`のローカル相当（別環境への復元）を実行してRTO/RPOを実測する。実測値をこの文書に上書きし、docs/14 D10の開発用案を実測で確定する。
3. 実環境の稼働環境で復旧runbook（ops/backup-restore.md §5）を1回通す（停止→復元→照合→旧sessionの扱い→限定確認→再開）。docs/07 §7「実データ投入前に復元演習」の要件はこの演習で満たす。
4. 日次実行の組み込み（scheduled workflow等）は、T078のworkflowが実環境で実行実績を持ってから足す（ops/backup-restore.md §7）。

この手順を実行するまで、「D1/R2のバックアップ・復元・外部効果照合」は **局所のみ検証済み・実環境は未検証**。NFR-06を「完成」とは扱わない（V07の残手順）。
