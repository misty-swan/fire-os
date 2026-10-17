# バックアップ・復元・外部効果照合の手順（T079）

目的: D1とR2の保全、別環境への復元、復元後の整合照合（FK/hash/ACL/集計/job/外部配送差分）と旧sessionの失効を、**このリポジトリだけで再現可能な手順**として定める。正本は docs/07 §7（復旧runbookの順序）と docs/14 D10（保持年限・RTO/RPO。**未承認**。本書の数値は開発用の検証設定）。対象ゲートは docs/13 RG-05、docs/08 CT-08/AT-NFR-06。

**現状の正直な限界（2026-10-17時点）**: この開発環境は実Cloudflareに未接続（wrangler未ログイン）のため、**実D1/R2に対するバックアップ・復元演習は未実施**。§2/§4のローカル手順と workers試験（tests/restore-consistency.test.ts）は実行・合格済み。実環境の手順は docs/evidence/V07-restore.md「未実施」に番号付きで記録する。

## 0. 契約（docs/07 §7、docs/04 §1、実装）

| 項目 | 契約 | 実装 |
|---|---|---|
| D1 | 原本。復元点は「manifest取得時刻＋同じ時点の論理ダンプ」 | `src/server/backup/manifest.ts`（buildBackupManifest）、`scripts/backup-manifest.ts`（CLI） |
| D1 export | **`wrangler d1 export` は使えない**: FTS5仮想表（0028）で「cannot export databases with Virtual Tables (fts5)」となり失敗する（T079実測。実Cloudflareでも同様の制約の可能性が高い＝要確認） | CLIが表ごとのSELECTから論理ダンプ（INSERT文）を作る |
| R2 | ready実体はhash固定の不変キー（docs/07 §3.5）。削除はtombstone→猶予→削除→照合（§3.7）。復元に必要なキーは削除前に複製する（D10） | ready key/hashをmanifestへ記録。ローカルは `.wrangler/state/v3/r2` の複製 |
| manifest | D1復元点/R2 key+hash/参照/論理削除時刻/既送delivery/未確定job/session失効基準 | `BackupManifest`（schemaVersion v1） |
| 復元先 | **新規にschemaを作った別環境のみ**。上書き復元は不可 — audit_logs/domain_events等の追記専用表はDELETE・上書きINSERTをトリガーで拒否する（0001/0003/0012/0020/0022/0024/0027）。監査と履歴を復元で書き換えられないことは契約どおり | `applyRestore` が復元先の残骸を検出して拒否する。`tests/restore-consistency.test.ts` の `resetRestoreTarget` が「新環境」相当 |
| 復元後のsession | 復元は「消えたはずのsession行を復活させる」操作。全userを復元点で失効させる（API-38の `users.session_revoked_before` 機構を再利用） | `applyRestore` / CLI §4の手順3 |
| 復元後のjob・配送 | 未送分（pending/retry_wait）の再試行は続く。**既送（provider_accepted/unknown）は再送しない**（deliveryKey固定。docs/07 §5） | deliveriesごとmanifestと照合（`verifyRestore`）。再送が起きないことの観測は上記試験 |
| 検索索引 | `document_chunks.index_status='indexed'` ⇔ FTS行（0028の不変量）。ズレたら `document.reindex` で再構築 | `verifyRestore` が `fts_index_drift` として報告 |

## 1. 保全の構成（D10の開発用検証設定。未承認）

| 層 | 方式 | 頻度（開発用案） | 保持（開発用案） |
|---|---|---|---|
| D1 時点復元 | Time Travel（Free 7日/Paid 30日。実環境での動作確認は未実施＝V07-restore「未実施」1） | 常時（Cloudflare側） | プランに従う |
| D1 論理ダンプ | `scripts/backup-manifest.ts`（manifest＋d1-data.sql＋R2複製を1ディレクトリへ） | 日次案（本番）。演習は随時 | 30日案＋四半期1本 |
| R2実体 | 不変キー＋削除猶予。ローカルは状態ディレクトリの複製、実環境はR2の別複製（§3） | D1ダンプと同時 | D1と同じ案 |
| manifest | バックアップ1本ごとに1ファイル（JSON） | D1ダンプと同時 | 同上 |

RTO/RPOの開発用案: **RTO 24時間 / RPO 24時間**（docs/14 D10の推奨案を検証設定として使う。承認済みではない）。ローカル実測は §6、実環境での実測は未実施（V07-restore「未実施」2）。

## 2. バックアップの作成（ローカル。実行可能な手順）

前提: ローカルのD1/R2状態があること（`npm run demo` や workers試験の実行後。無いと「表がありません」で止まる）。バックアップは **Git管理外**（`.gitignore` の `backup/`。実データを含むため絶対にcommitしない）。

```bash
npx tsx scripts/backup-manifest.ts --backup-dir backup/local-20261017-1 --db fireos-local
# → backup/local-20261017-1/ に次の3つを作る（実行時間の目安: 数秒〜。§6に実測あり）
#   d1-data.sql    全表の論理ダンプ（INSERT。FKの親が先の順。先頭に「--」の説明つき）
#   manifest.json  復元点のmanifest（export.file/export.sha256 を含む）
#   r2-state/      ローカルR2の状態複製（.wrangler/state/v3/r2のcopy。無い場合は警告が出る）
```

出力の確認点:
- `d1Data.rows` が想定の件数オーダーか（0件は状態が無いだけの可能性）
- `manifest.json` の `d1.tables` に `roles` の4行・業務表の件数が入っているか
- `r2State.copied: true` か（falseのまま運用しない。R2複製なしで復元は成立しない）

**実環境（staging/production）**: §3。手作業での実行はまだ（V07-restore「未実施」）。

## 3. 実環境のバックアップ（未実施の手順）

1. `npx wrangler d1 export fireos-staging --remote --output backup/staging-<日時>.sql` を試し、FTS5制約で失敗するかを実測して記録する（T079のローカル実測では失敗。失敗する場合は論理ダンプをWorker経由で作る代替を実装するか、Time Travel＋R2複製を主経路にする判断をdocs/14 D10へ記録する）。
2. Time Travelの復元点を確認: `npx wrangler d1 time-travel info fireos-staging --remote`（コマンド名・出力はwrangler版で確認）。
3. R2の別複製: バケット `fireos-staging-files` を別バケット/別アカウントへ複製する手順を確立する（`wrangler r2 object` の一括copyは現状のwranglerに無いため、S3互換API（rclone等）かWorkersでのcopy処理。費用・権限はdocs/14 D11と合わせて管理主体の了承を取る）。
4. 上記が揃ったら、本書§2と同じ形（manifest.json＋ダンプ＋R2複製）をstagingで1本作り、docs/evidence/V07-restore.mdの「未実施」を上書きする。

## 4. 復元と照合（ローカル。実行可能な手順）

```bash
npx tsx scripts/restore-verify.ts --manifest backup/local-20261017-1/manifest.json \
  --scratch /tmp/fireos-restore-scratch --r2-state backup/local-20261017-1/r2-state
```

この1コマンドが次を行う（同等の手作業のコマンドも載せる。再現や部分実行に使う）:

1. **空のschemaを新規作成**（「別環境への復元」相当。追記専用表があるため、既存環境への上書きはしない）:
   ```bash
   rm -rf /tmp/fireos-restore-scratch && mkdir -p /tmp/fireos-restore-scratch
   npx wrangler d1 migrations apply fireos-local --local --persist-to /tmp/fireos-restore-scratch
   ```
2. **論理ダンプの適用**:
   ```bash
   npx wrangler d1 execute fireos-local --local --persist-to /tmp/fireos-restore-scratch --file backup/local-20261017-1/d1-data.sql
   ```
3. **復元後sessions失効**（復元点を `<RP>` として。manifest.jsonの `restorePointAt` の値）:
   ```bash
   npx wrangler d1 execute fireos-local --local --persist-to /tmp/fireos-restore-scratch \
     --command "UPDATE users SET session_revoked_before='<RP>', updated_at='<RP>' WHERE session_revoked_before IS NULL OR session_revoked_before<'<RP>'"
   ```
4. **照合**（FK/集計/索引/job/ACL/既送delivery/失効基準＋R2実体のhash）:
   ```bash
   npx wrangler d1 execute fireos-local --local --persist-to /tmp/fireos-restore-scratch --json \
     --command "PRAGMA foreign_key_check"     # [] であること
   npx tsx scripts/restore-verify.ts --manifest ... --scratch ... --r2-state ...   # 上のコマンド全体
   ```

判定: 出力のJSONで `ok: true`（全ての差分リストが空）なら合格。**1つでも項目があれば終了コード1**で止まるので、`|| echo FAILED` などで握りつぶさない。

| 項目 | 意味と対処 |
|---|---|
| `missingReadyObjects` | ready実体が複製したR2に無い（消失写真）。R2複製の取り直しか、欠落の原因調査（削除jobの誤走査・手動削除） |
| `orphanReadyObjects` | R2にあるready実体で、どのattachments行も参照しないもの（削除漏れ・孤児）。回収の判断はdocs/07 §3.7（D1が原本。削除は手順に従う）。**CLIでは未実施**（wranglerにR2一覧が無い）。workers試験の `verifyRestore` がR2 listで行う |
| `hashMismatches` | 実体はあるがhash/容量がmanifestと違う（書換え・破損）。そのキーの実体は使わず、より古い複製から戻す |
| `foreignKeyErrors` | 外部ツール由来の参照切れ（D1バインディング経路では常に強制されるため、sqlite3直操作などの検出用。§6.3の再現手順） |
| `countMismatches` | 行数がmanifestと違う（復元漏れ・余分な行）。ダンプと復元手順を見直す |
| `deliveryDiffs` | 既送delivery行が無い/状態が違う（**復元後に再送が起きる事故**）。ダンプの対象表を見直し、runbook §5の「配送停止」からやり直す |
| `unrevokedSessions` | 復元点で失効していないuser。§4の手順3が効いていない（手作業ならコマンドの<RP>を確認） |
| `jobIssues` / `fts_index_drift` | 参照切れjobは手動確認へ。索引のズレは `document.reindex` jobを登録して再構築する |

## 5. 復旧runbook（docs/07 §7の順。運用時の全体フロー）

1. **影響把握**: いつから何が壊れているか（監査・照合結果・利用者報告）。影響範囲をunit/表/時刻で記録する。
2. **新規mutation・配送の停止**: `wrangler dev` の停止、実環境ではWorkerの一時停止（`npx wrangler versions rollback` やルートの無効化。手順の実環境確認は未実施＝V07-restore「未実施」3）。Cron（`triggers.crons`）も止める。
3. **復元点の選定**: 破損前の時刻のmanifest＋ダンプ＋R2複製を揃える。manifestの `restorePointAt` とダンプhash（`export.sha256`）を突き合わせる。
4. **復元**: §4（実環境では `--persist-to` に staging相当の新規環境を使う。productionへ戻すのは管理主体の承認後）。
5. **照合**: §4の出力で `ok: true`。`jobIssues`・`fts_index_drift` があれば §4の表の対処（索引再構築）まで済ませる。
6. **旧job・外部効果の照合**: 復元後にjobを回す前に、未確定job（manifestの `jobsUncertain`）の一覧を確認する。**既送通知の再送は起きない**（deliveryKey固定。workers試験が観測済み）。外部providerの送信結果が不明な宛先（unknown）は照会・人確認に回す（無限再送しない。docs/07 §5）。
7. **旧sessionの扱い**: 復元後は全userが再ログインになる（§4の手順3）。管理主体が「全員再ログイン」の案内を出す。
8. **限定確認**: 架空データの画面確認（参照・作成・添付表示・検索）を1回行い、監査に記録が残ることを確認する。
9. **管理主体の承認→再開**: 承認を得てからWorkerとCronを戻す。実施記録（時刻/復元点/照合出力/承認者）を運用記録へ残す。

## 6. 検出能力の確認（合格を見逃さないための道具）

1. **自動試験（workers。実workerd＋D1/R2）**: `npx vitest --run tests/restore-consistency.test.ts` — 2ケース。
   - `restore_does_not_resend_notifications_or_revive_old_sessions`: 別環境への復元後に ①FKエラー0 ②ready実体の欠落0 ③既送deliveryの再送0（deliveryKey照合。配送jobを実際に回して観測）④復元点より前の旧sessionが業務APIで拒否（session_revoked経路）を確認する。
   - `verify_restore_detects_missing_object_lost_deliveries_and_unrevoked_sessions`: 実体の欠落・hash破損・孤児（参照しないready実体）・既送行の復元漏れ・失効基準の改変を注入し、**全部が報告されて `ok: false` になる**ことを確認する（positiveだけの空回りを防ぐ変異的裏付け）。
2. **ローカル実測（3,305行＝members 1000＋facilities 300＋audit_logs 2000＋その他5、ダンプ1.2MB。2026-10-17、同一マシンのローカルworkerd/D1）**:
   - `scripts/backup-manifest.ts`: 約4秒（manifest＋ダンプ作成＋R2複製）
   - `scripts/restore-verify.ts`: 約12秒（schema作成＋ダンプ適用＋sessions失効＋全照合＋R2実体の取得とhash照合）
   - この数字を「実環境のRTO」とは読まない（データ量・網羅が桁違い。実測はV07-restore「未実施」2）。
3. **FK検出の裏付け（外部ツール由来の破れ。手順）**: 復元済みのscratchにsqlite3で直接参照切れを作り、`PRAGMA foreign_key_check` が報告することを確認した（2026-10-17実施）。sqlite3は**実DBファイルを直接指定する**（glob `*.sqlite` はwranglerの管理ファイル `metadata.sqlite` も展開してParse errorになる。scratchには復元したDBの実体がhash名 `.sqlite` として1つだけある）:
   ```bash
   DBFILE="$(find /tmp/fireos-restore-scratch/v3/d1/miniflare-D1DatabaseObject -maxdepth 1 -name '*.sqlite' ! -name 'metadata.sqlite')"
   sqlite3 "$DBFILE" \
     "PRAGMA foreign_keys=OFF; INSERT INTO members (id, unit_id, display_name, status, created_at, updated_at, actor_kind) \
      VALUES ('demo-orphan','no-such-unit','不在の分団','active','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','system');"
   npx wrangler d1 execute fireos-local --local --persist-to /tmp/fireos-restore-scratch --json --command "PRAGMA foreign_key_check"
   # → {"table":"members","rowid":<環境依存の値>,"parent":"units","fkid":2} の形が返る
   #   （rowidはデータ量で変わる。verifyRestoreがforeignKeyErrorsへ載せる形と同じ）
   ```

## 7. 未整備（正しく「未実施」として扱う）

- 実Cloudflare（staging/production）へのバックアップ・復元演習、Time Travelの実測、実環境RTO/RPO（V07-restore「未実施」1〜3）。
- 実環境での日次実行の組み込み（GitHub Actionsのscheduled workflow等。実行実績のあるCI構成が無いためT079では作らない。T078のworkflowが実環境で回るようになった時に、§2/§3の手順をjobとして足す）。
- R2複製の実環境手順（§3.3）と保持年限・削除の本番値（docs/14 D10。管理主体の了承が必要）。
- 大容量ダンプ（実データ規模）でのメモリ・時間の実測。CLIは1表ごとに全行をメモリへ読むため、実データ規模でどうなるかは未計測（問題が顕在化したらpaged読み取りへ改める）。
