# 営業デモのユーザー準備手順（契約・ドメイン・キー・Secret）（T089）

目的: 公開営業デモ（docs/superpowers/specs/2026-10-21-public-demo-miyanoura-design.md）に必要な**契約と鍵まわりの作業**を、プロジェクトオーナー自身の手で行うための手順。書く人（エンジニア側）のTask 2〜6の実装と**並行して**進めてよい。技術的な実装（Task 5・Task 7）はこの手順の対応する項目の完了を待つ（§6の対応表）。

- **対象読者**: エンジニアでない前提。手順は1ステップ1動作。「→ 何が起きるか」に結果を書いた。
- **全27ステップ。** 各ステップに公式文書の参照先（URL）と確認日（2026-10-21）を付けてある。画面がこの手順と違うときは、推測で進めずそのURLのページを開き直す。公式に手順ページが存在しない箇所（ステップ4）はその旨を明記してある。
- **値の取り扱い**: APIキー・token・Secret・パスワードの値は**チャット・メール本文・Git・docsに絶対に貼らない**（AGENTS.md・ops/demo-deploy.md §6）。値は自分のパスワード管理ツールか手元の記録にのみ置く。値を入力するときは、値を知っている本人が自分の端末で直接入力する。
- 所要時間の目安: §1 約30分（クレジットカードが必要）／§2 約15分＋確認メール待ち／§3 約20分／§4〜5 約15分。

## §1 CloudflareアカウントとWorkers Paid（カード登録）

1. ブラウザで `https://dash.cloudflare.com/sign-up` を開き、メールアドレスとパスワードを入力して **Create Account** を選ぶ。→ 何が起きるか: アカウントが作られ、確認メールが自動で届く。
   出典: https://developers.cloudflare.com/fundamentals/account/create-account/ （2026-10-21確認）
2. 届いたメールの確認リンクを開いてメールアドレスを確認する。→ 何が起きるか: アカウントが「メール確認済み」になる。次の§2のドメイン購入には確認済みメールアドレスが必須なので、必ずここで済ませる。
   出典: https://developers.cloudflare.com/fundamentals/account/create-account/ ＋ https://developers.cloudflare.com/registrar/get-started/register-domain/ （2026-10-21確認）
3. Cloudflareダッシュボードで **Billing** ページ（`https://dash.cloudflare.com/?to=/:account/billing`）を開き、**Subscriptions** の **Payment methods** パネルから **Add Payment Method** でカード（Visa／Mastercard／American Express／Discover／UnionPay）か PayPal 等を登録して **Confirm** を選ぶ。→ 何が起きるか: 請求プロファイルが作られ、Cloudflareの製品（Workers Paid・ドメイン）を購入できるようになる。カード番号そのものはCloudflare側に保存されない。カードによっては3Dセキュアの認証画面が出る。
   出典: https://developers.cloudflare.com/billing/get-started/create-billing-profile/ （2026-10-21確認）
4. **Workers Paid**（月5ドル〜の最低請求。D1・R2・Queues・Workers AIはこのプランで使う）への契約を、ダッシュボードの **Workers & Pages** 画面のプラン契約の案内に従って行う。→ 何が起きるか: このアカウントでD1（データベース）・R2（ファイル保管）・Queues（ジョブ）が使えるようになる。デモの月額は§「費用の枠」（ops/demo-deploy.md §4）の内部で収まる想定。**正直な注記**: 契約のクリック経路そのものを書いた公式の手順ページは存在しないことを確認済み（2026-10-21）。金額と内容の正本は下記の参照ページ、支払い方法の登録はステップ3の参照ページ。実際のボタンの配置はその時点のダッシュボードの案内に従う。
   出典: https://developers.cloudflare.com/workers/platform/pricing/ （2026-10-21確認）
5. ダッシュボードの **Workers & Pages** を開き、**Account Details** セクションの **Account ID** の横のコピーボタンで自分のアカウントIDをコピーし、手元の記録に控える。→ 何が起きるか: 後続タスク（Task 5・Task 7）が設定に書くために使う16進の文字列が手元に揃う。アカウントIDは秘密値ではないが、Gitには載せない。
   出典: https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/ （2026-10-21確認）

## §2 ドメイン取得とCloudflareへの登録（zone）

> **⚠️ 2026-10-22 ユーザー裁定: ドメインは取得しない。本節の作業は不要（将来読み替えて使うために残す）。**
> デモのURLはCloudflareが無料で付ける `https://fireos-demo.<アカウントサブドメイン>.workers.dev` を使う（アカウントサブドメインはCloudflareのダッシュボードで初回に決める）。**代わりに、zoneがないと設定できない外側の防御（WAF/Rate Limitingのカスタムルール）は使えない**＝防御はアプリ内のDEMO_SECURITY_POLICYとCloudflareの自動DDoS保護のみ。この限界は ops/demo-deploy.md §5.3-1 と設計書§8-1に記録した。将来ドメインを取れば本節の手順で zone を追加し、WAF層を後から足せる（デプロイし直しは不要）。

 Cloudflare Registrarで直接買うのが最短。購入したドメインは**同じアカウントのzoneとして自動で登録**され、ネームサーバーの変更作業が不要になる（RegistrarのドメインはCloudflareネームサーバー固定）。既に別の事業者で取得済みのドメインを使う場合は、この§の末尾の注記の手順になる。

6. Cloudflareダッシュボードで **Register domains**（`https://dash.cloudflare.com/?to=/:account/registrar/register`）を開く。→ 何が起きるか: ドメイン検索の画面が出る。
   出典: https://developers.cloudflare.com/registrar/get-started/register-domain/ （2026-10-21確認）
7. 検索ボックスに欲しいドメイン名を入れて **Search** を選ぶ。→ 何が起きるか: 取得可能な候補の一覧が出る。入れた名前が一覧に出ないときは既に他人が取得済み。日本語表記のドメイン（IDN）は未対応。
   出典: https://developers.cloudflare.com/registrar/get-started/register-domain/ （2026-10-21確認）
8. 欲しい名前の **Purchase** を選ぶ。→ 何が起きるか: 取得可否の最終確認（正式な空きチェック）が自動で走る。直前で他人に取られた場合はここで分かる。
   出典: https://developers.cloudflare.com/registrar/get-started/register-domain/ （2026-10-21確認）
9. **Payment option** で登録年数を選ぶ。→ 何が起きるか: 価格と満了日が変わる。自動更新は既定でON（止めることもできるが、営業期間中はON推奨）。
   出典: https://developers.cloudflare.com/registrar/get-started/register-domain/ （2026-10-21確認）
10. ドメインの連絡先情報（登録者・管理・技術・請求の4役割に使われる）を入力する。→ 何が起きるか: WHOISに紐づく情報が決まる。半角英数字（ASCII）のみ。**実名・正確な住所を入れる**（不正確だと登録が停止・取消され得る。個人はWHOIS編集で保護される）。
    出典: https://developers.cloudflare.com/registrar/get-started/register-domain/ （2026-10-21確認）
11. 支払い方法（ステップ3で登録した請求プロファイル）を確認し、規約を確認して **Complete purchase** を選ぶ。→ 何が起きるか: 約30秒で登録が完了し、ドメイン管理ページへ移る。確認メールも届く。
    出典: https://developers.cloudflare.com/registrar/get-started/register-domain/ （2026-10-21確認）
12. 購入後に届く **ICANNの登録者メール確認** を必ず行う。→ 何が起きるか: 確認しない（期限切れ）だと、ICANNの規則でドメインがホールドされネームサーバーが差し替えられてしまう。確認すれば自動で戻る。届いたらすぐに済ませる。
    出典: https://developers.cloudflare.com/registrar/get-started/register-domain/ （2026-10-21確認）
13. 完了の確認: Registrarで買ったドメインは自動でCloudflareネームサーバー・同じアカウントのzoneになっており、追加の設定作業はない。→ 何が起きるか: このドメインのDNSをCloudflareが管理する状態になる。営業URLは後続タスク（Task 7）がこのドメインの中に設定する。
    出典: https://developers.cloudflare.com/registrar/get-started/register-domain/ ＋ https://developers.cloudflare.com/fundamentals/manage-domains/add-site/ （2026-10-21確認）

   **注記（別の事業者で既にドメインを持っている場合）**: 上記ではなく「Onboard a domain」の手順になる — ①ダッシュボードの **Domains** から **Onboard a domain** でドメインを追加しプランを選ぶ ②DNSレコードの確認 ③表示されたCloudflareのネームサーバーを取得事業者側で登録 ④SSL/TLSの確認。参照先は手順13と同じページ（2026-10-21確認）。

## §3 Google Maps APIキー（有効化・請求先）

 キーは**本番用・他環境用と別に、このデモ専用のプロジェクトで作る**（docs/07 §6「環境別key」・ops/demo-deploy.md §4.3）。参照元（リファラ）制限はデモのURLが確定した**後**（Task 7のあと）に付ける。その旨はステップ19。割当（クォータ）と参照元制限の考え方の正本はops/demo-deploy.md §4.3で、この手順が参照元制限をTask 7の**後**（ステップ19）に並べているのは、制限する先のURLが先に存在しないと地図が動かなくなるため。

14. `https://console.cloud.google.com/projectselector2/home/dashboard` （プロジェクトセレクタ）を開き、**Create Project** で新しいGoogle Cloudプロジェクトを作る。名前は分かるものに（例: fireos-demo-map）。→ 何が起きるか: Mapsの鍵や課金をまとめておく入れ物ができる。
    出典: https://developers.google.com/maps/get-started （Step 1。2026-10-21確認）
15. プロジェクトで**請求（billing）が有効になっていることを確認・設定する**。→ 何が起きるか: Maps Platformは課金アカウントの紐付けが前提（利用枠内は無料枠・トライアル扱いになる）。初めてGoogle Cloudを使う場合は同ページの **Get Started** の対話設定が案内に従って請求まで済ませてくれる（対象なら$300のトライアルクレジットの案内が出る）。カードの登録が必要。
    出典: https://developers.google.com/maps/get-started （Step 1。2026-10-21確認）
16. Maps API Libraryページ（`https://console.cloud.google.com/project/_/google/maps-apis/api-list`）で **Maps JavaScript API** を開く。ボタンが **ENABLE** と表示されていたら**そのボタンを選んで有効化する**（押さないまま次のステップへ進まない）。**MANAGE** と表示されていたら既に有効なので押す必要はない。→ 何が起きるか: このプロジェクトで地図を表示するAPIが使えるようになる。このAPI**以外**は有効にしない（使わないAPIは無効のままが安全）。
    出典: https://developers.google.com/maps/get-started （Step 2。2026-10-21確認）
17. **Google Maps Platform > Credentials**（`https://console.cloud.google.com/project/_/google/maps-apis/credentials`）で **Create credentials > API key** を選び、表示されたキーのダイアログを **Close** で閉じる。→ 何が起きるか: APIキーが作られ、Credentialsの一覧に出る。まだ制限は付いていない。
    出典: https://developers.google.com/maps/get-started （Step 3。2026-10-21確認）
18. キーの値をコピーし、**リポジトリの外**の安全な場所（パスワード管理ツール等）に保存する。→ 何が起きるか: キーが手元に揃う。**制限前のキーで公開ページを動かしてはいけない**（悪用された請求はキーの持ち主に来る）。キーはGit・チャット・docsに貼らない。
    出典: https://developers.google.com/maps/api-security-best-practices （2026-10-21確認）
19. 【デプロイ後・Task 7のあとで実施】キーに**参照元（HTTPリファラ）制限とAPI制限**を付ける: Credentialsでキーを選択 → **Edit API key** → **Key restrictions** の **Set an application restriction** で **Websites** を選び、デモのURLの完全形を入れる（例 `https://<ドメイン>`、サブドメイン全体は `https://*.example.com`。パスはブラウザが消すため**付けない**）→ **API restrictions** で **Restrict key** を選び **Maps JavaScript API** だけに絞る → **Save**。→ 何が起きるか: 他のサイトや他のAPIでこのキーが使えなくなる。デモURLが確定する前に行うと動かなくなるので必ずTask 7のあと。
    出典: https://developers.google.com/maps/api-security-best-practices （2026-10-21確認）

   注記: 月2,000ロードの割当（Quotas）と予算アラートの設定は**デプロイ後**に ops/demo-deploy.md §4.3 の手順で行う（Google Cloud Console側の設定。根拠はその節）。

## §4 wrangler login

 Cloudflareの操作コマンド（wrangler）に、あなたのCloudflareアカウントを操作する権限を与える作業。実行する場所はこのリポジトリのディレクトリ（ターミナルで `cd` してから）。

20. ターミナルで `npx wrangler login` を実行する。→ 何が起きるか: ブラウザが開いてCloudflareのログイン画面（既にログイン済みなら認可画面）が出るので **Allow** を選ぶ。ブラウザが開かないときは、端末に表示されたURLをコピーして手動で開く。成功するとwranglerが「Successfully logged in.」を出す。
    出典: https://developers.cloudflare.com/workers/wrangler/commands/general/#login （2026-10-21確認）
21. この端末でブラウザを開けない場合（リモート環境など）は `npx wrangler login --device` を実行する。→ 何が起きるか: 検証用URLと短いコードが表示され、スマホ等の別のブラウザでそのURLを開いてコードを入れて認可すると（5分以内）、ログインが完了する。
    出典: https://developers.cloudflare.com/workers/wrangler/commands/general/#login （2026-10-21確認）

## §5 token・Secretの作成と登録先一覧

### demo用のAPI token（GitHubの週次リセットworkflowが使う。Task 5で登録）

22. `https://dash.cloudflare.com/profile/api-tokens` を開き（**My Profile > API Tokens**）、**Create Token** で **Custom token** を選ぶ。→ 何が起きるか: token作成の画面に入る。テンプレートは使わず自分で権限を絞る。
    出典: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ （2026-10-21確認）
23. tokenに名前（例: demo-reset）を付け、権限を**最小**に設定する: **Account / D1 / Edit** ＋ **Account / Workers R2 Storage / Edit** ＋ **Account / Workers Scripts / Edit** の3つ。対象リソースは自分のアカウント（Include）にする。→ 何が起きるか: このtokenはdemo環境のデータベースとファイルの書き換え（週次リセット）しかできない。staging・production用のtokenとは別物として扱い共有しない。権限の正式なグループ名は下記の「Available token permissions」ページで確認できる。
    出典: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ ＋ https://developers.cloudflare.com/fundamentals/api/reference/permissions/ （2026-10-21確認）
24. **Continue to summary** → **Create Token** を選び、表示されたtokenの値を**一度だけ**コピーして手元の安全な場所に保存する。→ 何が起きるか: tokenの値はこの画面でしか表示されない（再表示不可）。紛失したら作り直す。
    出典: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ （2026-10-21確認）
25. GitHubに登録する: このリポジトリのGitHubページ → **Settings** → **Secrets and variables** → **Actions** → **Secrets** タブ → **New repository secret**。**Name** に `CLOUDFLARE_API_TOKEN_DEMO`、**Secret** にステップ24のtokenの値を入れて **Add secret**。→ 何が起きるか: 週次リセットのworkflow（Task 5が作る）がCloudflareへ安全に接続できる。値はGitHubの画面に再表示されない。既存のstaging／productionと同じ規律（ops/deploy.md §0。環境別Secret）。**併用の `CLOUDFLARE_ACCOUNT_ID_DEMO` も同じ画面・同じ手順で登録する**（要と確定: Task 5。ops/demo-deploy.md §3.1。値はステップ5で控えたアカウントID）。**さらに同じ画面でもう1つ `DEMO_ACCOUNT_PASSWORD` を登録する**: Name に `DEMO_ACCOUNT_PASSWORD`、Secret に12文字以上の任意の値（自分で決める。体験アカウント3本のログインパスワードとして固定で使われ、週次リセット後も同じ資格情報でログインできる。手元のパスワード管理ツールにも必ず控える。workflowはこの値を環境変数でスクリプトへ渡すため、Actionsのログに値は出ない〔GitHubがSecretの値をログで自動マスクする〕。ops/demo-deploy.md §3.1）。
    出典: https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions （2026-10-21確認）

### `BETTER_AUTH_SECRET`（CloudflareのWorker側のSecret。Task 7で投入）

26. （Task 7の実行時に、値を知っている本人の端末で）32バイト以上の乱数を生成して `npx wrangler secret put BETTER_AUTH_SECRET --env demo` を実行し、プロンプトに値を貼り付ける。乱数の生成例: `openssl rand -base64 48`。→ 何が起きるか: ログインセッションを署名する鍵がCloudflareに暗号化されて登録され、以後ダッシュボードにもwranglerにも値は表示されない（上書きは再度のput）。値はチャット・メール・Gitに貼らない（ops/demo-deploy.md §5.1・ops/deploy.md §0どおり）。
    出典: https://developers.cloudflare.com/workers/configuration/secrets/ ＋ https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-put （2026-10-21確認）

### 値の登録先まとめ

| 名前 | 何の値か | 登録先 | 値を入れる人と方法 |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | 認証セッション署名用の乱数（32バイト以上） | CloudflareのWorker（`wrangler secret put --env demo`） | 本人が端末のプロンプトへ（ステップ26） |
| Maps APIキー | Google Mapsの鍵 | **ビルド変数** `VITE_GOOGLE_MAPS_API_KEY`（ビルドする端末の `.env.local`〔Git管理外〕。CloudflareのSecretではない） | ビルド実行者がビルド時に読み込む（Task 7） |
| `CLOUDFLARE_API_TOKEN_DEMO` | demo用API token | GitHubのリポジトリSecret | 本人がGitHubの画面へ（ステップ25） |
| `DEMO_ACCOUNT_PASSWORD` | 体験アカウント3本の固定ログインパスワード（12文字以上。値は自分で決める） | GitHubのリポジトリSecret | 本人がGitHubの画面へ（ステップ25。値は手元のパスワード管理ツールにも控える） |
| アカウントID | CloudflareアカウントのID（秘密値ではないがGitに載せない） | GitHub Secret `CLOUDFLARE_ACCOUNT_ID_DEMO`（**要**: Task 5で確定。ops/demo-deploy.md §3.1）・設定の実値 | 本人がGitHubの画面へ（ステップ5で控えた値） |
| 体験アカウント3本のパスワード | デモ用ログイン資格情報 | 実環境demoはGitHub Secret `DEMO_ACCOUNT_PASSWORD` の固定値（上の行）。ローカルの`npm run demo`はseed実行時の標準出力に一度だけ表示（ops/demo-deploy.md §2・Task 4） | 実行者が画面から控えて営業時に渡す（実環境はSecretに登録した値そのもの） |

## §6 できあがるもの一覧と、後続タスクの対応表

27. 下の「あなたの値」列を、手元の記録（パスワード管理ツール等）に埋めて完了とする。→ 何が起きるか: 後続タスクが待っている値が全て揃った状態になる。埋まらない欄があれば対応する§へ戻る。
    出典: https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/ （アカウントIDの確認場所。2026-10-21確認）

| できあがるもの | 作る手順 | あなたの値（例の形。実値は手元にだけ） | 待っている後続タスク |
|---|---|---|---|
| Cloudflareアカウント（Workers Paid・カード登録済み・メール確認済み） | §1（ステップ1〜4） | — | Task 7（デプロイ実行）: D1/R2/Queueの作成と `database_id` の実値反映 |
| CloudflareアカウントID | ステップ5 | 32桁の英数字 | Task 7・GitHub（`CLOUDFLARE_ACCOUNT_ID_DEMO`〔**要**: Task 5で確定〕） |
| ドメイン名（同じアカウントのzone登録済み） | §2（ステップ6〜13） | `<例: fireos-demo.example.com>` | Task 7: route/custom_domain設定・`AUTH_BASE_URL` の実URL化・WAF/Rate Limiting。**Task 7のあと**ステップ19（参照元制限） |
| Google Maps APIキー（Maps JavaScript API有効・請求先紐付け済み） | §3（ステップ14〜18） | `AIza` で始まる文字列（形の例のみ。実値は手元にだけ） | Task 7: ビルド時の `VITE_GOOGLE_MAPS_API_KEY`（`.env.local`・Git管理外）。**Task 7のあと**ステップ19 |
| demo用API token（最小権限） | §5（ステップ22〜24） | `cfut_` で始まる形式 | ステップ25を経て **Task 5**（週次リセットworkflow） |
| GitHub Secret `CLOUDFLARE_API_TOKEN_DEMO` | ステップ25 | — | **Task 5** |
| GitHub Secret `DEMO_ACCOUNT_PASSWORD` | ステップ25（12文字以上の任意の値） | 手元のパスワード管理ツールにも控える | **Task 5**（週次リセットworkflowが体験アカウント3本のパスワードとして使う。ops/demo-deploy.md §3.1） |
| wrangler login済みの端末 | §4（ステップ20〜21） | — | Task 7: `wrangler deploy --env demo`・migration・`wrangler secret put` |
| `BETTER_AUTH_SECRET` | ステップ26（Task 7時） | 乱数64文字程度 | Task 7 |

 この手順はTask 2〜6の実装と並行して完結する。Task 5が待つのはGitHub Secret（ステップ25）まで、Task 7が待つのは上の表の全行。

## §7 やってはいけないこと

- キー・token・Secret・パスワードの値をチャット・メール本文・Git・docsに貼ること（AGENTS.md・ops/demo-deploy.md §6）。値を伝える必要があるときは、相手に直接入力してもらう
- 制限を付けないままのMapsキーで公開URLを動かすこと（悪用の請求はキーの持ち主に来る。ステップ18・19）
- demo用tokenの権限を広げること・staging／production用の資格情報と共有すること（分離規律 RG-09・ops/demo-deploy.md §1）
- `BETTER_AUTH_SECRET` を32バイト未満にすること・使い回すこと（ステップ26）
- この手順の実施記録（いつ・どのドメインを取得したか等）をGitへ書くこと。実施記録は**値を含まない形で**営業台帳（手元）に残す。完了したら後続タスクへ「対応表が全て埋まった」ことだけを伝える
