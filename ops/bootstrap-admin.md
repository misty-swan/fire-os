# 初期管理者の作成手順（T009）

公開の初期登録エンドポイントは存在しない。最初の管理者は、運用担当が次の一回手順で作る。

## 前提
- 環境（local / demo / staging / production）ごとに別のD1。**環境名を必ず明示**する（`--env` なしは実行不可）。
- migration（`wrangler d1 migrations apply`）が済み、`units` が空であること。
- Secret `BETTER_AUTH_SECRET` と `AUTH_BASE_URL` が設定済み。

## 実行
```
npm run bootstrap:admin -- --env local --unit-name "架空市消防団 第一分団" --admin-name "架空 管理者" --email admin@example.test
# 実環境:
npm run bootstrap:admin -- --env staging --remote --confirm staging --unit-name ... --admin-name ... --email ...
```
標準出力のJSONの `token` が初期管理者の招待token（72時間有効、既定）。**一度しか表示されない**。DBにはhashしか残らない。安全な経路で本人に渡す（チャット・メール本文・Gitに貼らない）。

## 受領
本人は `https://<環境>/login#invite=<token>`（tokenはURLの # 以降に置く。サーバーのログ・Refererに残らず、画面を開くとアドレスからも消える） を開き、招待先メールとパスワード（12文字以上）で登録する。続けて二要素認証（TOTPと回復コード）を設定する。管理者の招待・権限・監査の操作は二要素が有効になるまで拒否される。

## 無効化と再実行
- 分団が一つでもあるとCLIは `already_bootstrapped` で拒否する（二重実行・別分団の追加は不可）。
- 管理者が受領する（招待が `consumed`）と、再発行も `admin_already_linked` で拒否される。
- 受領前にtokenを紛失／期限切れの場合だけ、`--reissue` で旧招待を取消して再発行できる（管理者が一人もいないことが条件）。
  `npm run bootstrap:admin -- --env <env> [--remote --confirm <env>] --reissue --unit-name <同じ> --admin-name <同じ> --email <メール>`
- 監査: 発行は `bootstrap.issue`（システム主体）、受領は `invitation.accept`（kind=bootstrap）として追記される。tokenとメールは記録しない。

## 失敗時の復旧
- `wrangler d1 execute --file` は途中失敗の原子性を保証しない。assertionで事前条件を検査しているので、条件不成立では何も書かれない。実行後に `units` が1件、`invitations` に `kind='bootstrap'` が1件あることを確認する。
- 分団だけ作られて招待が無い等の中途半端な状態になった場合（接続断など）：`SELECT * FROM units; SELECT * FROM invitations;` で確認し、実データ投入前の環境ならD1を作り直す。実データ投入後は人手で不足行を補い、監査へ手当ての記録を残す。
