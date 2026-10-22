# 営業デモのユーザー準備手順（契約・ドメイン・キー・Secret）（T089）

この文書は、公開営業デモ（docs/superpowers/specs/2026-10-21-public-demo-miyanoura-design.md）に必要な**契約と鍵の準備**を、プロジェクトオーナー自身が行うための手順です。エンジニア側の実装（Task 2〜6）と並行して進めてください。どの作業がどこまで済めば次に進めるかは、§6の対応表で確認できます。

## この文書の読み方

- **対象読者**: エンジニアでない前提で書いています。手順は1ステップ1動作です。各ステップの「→ 何が起きるか」に、その操作の結果を書いてあります。
- **全27ステップ**です。画面が手順と違うときは、推測で進まず、各ステップに付けてある公式ページ（URL）を開き直してください。公式の手順ページが存在しない箇所（ステップ4）は、その旨を書いてあります。
- **値の取り扱い**: APIキー・token・Secret・パスワードの値は、**チャット・メール本文・Git・docsに絶対に貼らない**でください（AGENTS.md・ops/demo-deploy.md §6）。値は自分のパスワード管理ツールか手元の記録にだけ置きます。値の入力は、値を知っている本人が自分の端末で直接行います。
- 所要時間の目安: §1 約30分（クレジットカードが必要）／§2 約15分＋確認メール待ち／§3 約20分／§4〜5 約15分。

## §1 CloudflareアカウントとWorkers Paid（カード登録）

1. ブラウザで `https://dash.cloudflare.com/sign-up` を開き、メールアドレスとパスワードを入力して **Create Account** を選びます。→ アカウントが作られ、確認メールが届きます。
   出典: https://developers.cloudflare.com/fundamentals/account/create-account/ （2026-10-21確認）
2. 届いたメールの確認リンクを開いて、メールアドレスの確認を済ませます。→ アカウントが「メール確認済み」になります。この後にドメインを買う予定がある場合は確認済みが必須なので、必ずここで済ませてください。
   出典: https://developers.cloudflare.com/fundamentals/account/create-account/ ＋ https://developers.cloudflare.com/registrar/get-started/register-domain/ （2026-10-21確認）
3. Cloudflareダッシュボードの **Billing** ページ（`https://dash.cloudflare.com/?to=/:account/billing`）を開きます。**Subscriptions** の **Payment methods** パネルで **Add Payment Method** を選び、カード（Visa／Mastercard／American Express／Discover／UnionPay）か PayPal 等を登録して **Confirm** を選びます。→ 請求プロファイルが作られ、Workers Paidやドメインを購入できるようになります。カード番号そのものはCloudflare側に保存されません。カードによっては3Dセキュアの認証画面が出ます。
   出典: https://developers.cloudflare.com/billing/get-started/create-billing-profile/ （2026-10-21確認）
4. **Workers Paid**（月5ドル〜。D1・R2・Queues・Workers AIはこのプランで使う）への契約を、ダッシュボードの **Workers & Pages** 画面の案内に従って行います。→ このアカウントでD1（データベース）・R2（ファイル保管）・Queues（ジョブ）が使えるようになります。デモの月額は ops/demo-deploy.md §4 の上限内に収まる想定です。**正直な注記**: この契約のクリックの手順を書いた公式ページは存在しないことを確認済みです（2026-10-21）。金額と内容の正本は下記の参照ページ、支払い方法の登録はステップ3の参照ページです。ボタンの配置は、その時点のダッシュボードの案内に従ってください。
   出典: https://developers.cloudflare.com/workers/platform/pricing/ （2026-10-21確認）
5. ダッシュボードの **Workers & Pages** を開き、**Account Details** の **Account ID** の横のコピーボタンで、自分のアカウントIDをコピーして手元に控えます。→ 後続の作業（Task 5・Task 7）が使う16進の文字列が手元に揃います。アカウントIDは秘密の値ではありませんが、Gitには載せません。
   出典: https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/ （2026-10-21確認）

## §2 ドメイン取得とCloudflareへの登録（zone）

> **⚠️ 2026-10-22に決めたこと: ドメインは取得しない。この節の作業は不要です（将来使うときのために残します）。**
>
> デモのURLは、Cloudflareが無料で付ける `https://fireos-demo.<アカウントサブドメイン>.workers.dev` を使います（アカウントサブドメインは、Cloudflareのダッシュボードで初回に決めます）。ドメインを取得しない代わりに、zone（ドメインをCloudflareで管理するための登録）がないと設定できない外側の防御（WAF/Rate Limitingのカスタムルール）は使えません。デモの防御は、アプリ内のDEMO_SECURITY_POLICYとCloudflareの自動DDoS保護だけになります。この限界は ops/demo-deploy.md §5.3-1 と設計書§8-1に記録してあります。将来ドメインを取れば、この節の手順でzoneを追加でき、WAF層を後から足せます（デプロイし直しは不要です）。

 Cloudflare Registrarで直接買うのが最短です。購入したドメインは**同じアカウントのzoneとして自動で登録**され、ネームサーバーの変更作業は不要になります（RegistrarのドメインはCloudflareのネームサーバー固定）。すでに別の事業者で取得済みのドメインを使う場合は、この節の末尾の注記の手順になります。

6. Cloudflareダッシュボードで **Register domains**（`https://dash.cloudflare.com/?to=/:account/registrar/register`）を開きます。→ ドメイン検索の画面が出ます。
   出典: https://developers.cloudflare.com/registrar/get-started/register-domain/ （2026-10-21確認）
7. 検索ボックスに欲しいドメイン名を入れて **Search** を選びます。→ 取得可能な候補の一覧が出ます。入れた名前が一覧に出ないときは、すでに他人が取得済みです。日本語表記のドメイン（IDN）は未対応です。
   出典: https://developers.cloudflare.com/registrar/get-started/register-domain/ （2026-10-21確認）
8. 欲しい名前の **Purchase** を選びます。→ 取れるかどうかの最終確認（正式な空きチェック）が自動で走ります。直前で他人に取られた場合は、ここで分かります。
   出典: https://developers.cloudflare.com/registrar/get-started/register-domain/ （2026-10-21確認）
9. **Payment option** で登録年数を選びます。→ 価格と満了日が変わります。自動更新は既定でONです（止めることもできますが、営業期間中はONを推奨します）。
   出典: https://developers.cloudflare.com/registrar/get-started/register-domain/ （2026-10-21確認）
10. ドメインの連絡先情報（登録者・管理・技術・請求の4役割に使われる）を入力します。→ WHOISに紐づく情報が決まります。半角英数字（ASCII）のみ使えます。**実名・正確な住所を入れてください**（不正確だと登録が停止・取消され得ます。個人はWHOIS編集で保護されます）。
    出典: https://developers.cloudflare.com/registrar/get-started/register-domain/ （2026-10-21確認）
11. 支払い方法（ステップ3で登録したもの）を確認し、規約を確認して **Complete purchase** を選びます。→ 約30秒で登録が完了し、ドメイン管理ページへ移ります。確認メールも届きます。
    出典: https://developers.cloudflare.com/registrar/get-started/register-domain/ （2026-10-21確認）
12. 購入後に届く **ICANNの登録者メール確認**を必ず行ってください。→ 確認しないで期限を過ぎると、ICANNの規則でドメインがホールドされ、ネームサーバーが差し替えられます。確認すれば自動で戻ります。届いたらすぐに済ませてください。
    出典: https://developers.cloudflare.com/registrar/get-started/register-domain/ （2026-10-21確認）
13. 完了の確認: Registrarで買ったドメインは、自動でCloudflareのネームサーバー・同じアカウントのzoneになっています。追加の設定作業はありません。→ このドメインのDNSをCloudflareが管理する状態になります。営業URLは後続のTask 7が、このドメインの中に設定します。
    出典: https://developers.cloudflare.com/registrar/get-started/register-domain/ ＋ https://developers.cloudflare.com/fundamentals/manage-domains/add-site/ （2026-10-21確認）

   **注記（別の事業者で既にドメインを持っている場合）**: 上記ではなく「Onboard a domain」の手順になります — ①ダッシュボードの **Domains** から **Onboard a domain** でドメインを追加し、プランを選ぶ ②DNSレコードの確認 ③表示されたCloudflareのネームサーバーを、取得事業者側で登録 ④SSL/TLSの確認。参照先は手順13と同じページです（2026-10-21確認）。

## §3 Google Maps APIキー（有効化・請求先）

 キーは**本番用・他環境用と別に、このデモ専用のプロジェクトで作ってください**（docs/07 §6「環境別key」・ops/demo-deploy.md §4.3）。参照元（リファラ）制限とは、この鍵を使ってよいWebページのURLを限定する設定です。デモのURLが確定するのはTask 7のあとなので、この制限はステップ19で後から付けます。先に付けると、制限で許可したURLがまだ存在せず、地図が動かなくなります。割当（クォータ）と参照元制限の考え方の正本は ops/demo-deploy.md §4.3 です。

14. `https://console.cloud.google.com/projectselector2/home/dashboard` （プロジェクトセレクタ）を開き、**Create Project** で新しいGoogle Cloudプロジェクトを作ります。名前は分かるものにしてください（例: fireos-demo-map）。→ Mapsの鍵や課金をまとめておく入れ物ができます。
    出典: https://developers.google.com/maps/get-started （Step 1。2026-10-21確認）
15. このプロジェクトで**請求（billing）が有効になっていることを確認・設定します**。→ Maps Platformは、課金アカウントの紐付けが前提です（利用枠内は無料枠・トライアル扱いになります）。初めてGoogle Cloudを使う場合は、同ページの **Get Started** の対話設定が、案内に従って請求まで済ませてくれます（対象なら$300のトライアルクレジットの案内が出ます）。カードの登録が必要です。
    出典: https://developers.google.com/maps/get-started （Step 1。2026-10-21確認）
16. Maps API Libraryページ（`https://console.cloud.google.com/project/_/google/maps-apis/api-list`）で **Maps JavaScript API** を開きます。ボタンが **ENABLE** と表示されていたら、**そのボタンを選んで有効化してください**（押さないまま次へ進まない）。**MANAGE** と表示されていたら、すでに有効なので押す必要はありません。→ このプロジェクトで地図を表示するAPIが使えるようになります。このAPI**以外**は有効にしないでください（使わないAPIは無効のままが安全です）。
    出典: https://developers.google.com/maps/get-started （Step 2。2026-10-21確認）
17. **Google Maps Platform > Credentials**（`https://console.cloud.google.com/project/_/google/maps-apis/credentials`）で **Create credentials > API key** を選び、表示されたキーのダイアログを **Close** で閉じます。→ APIキーが作られ、Credentialsの一覧に出ます。まだ制限は付いていません。
    出典: https://developers.google.com/maps/get-started （Step 3。2026-10-21確認）
18. キーの値をコピーし、**リポジトリの外**の安全な場所（パスワード管理ツール等）に保存します。→ キーが手元に揃います。**制限を付ける前のキーで公開ページを動かしてはいけません**（悪用された請求は鍵の持ち主に来ます）。キーはGit・チャット・docsに貼りません。
    出典: https://developers.google.com/maps/api-security-best-practices （2026-10-21確認）
19. 【デプロイ後・Task 7のあとで実施】キーに**参照元（HTTPリファラ）制限とAPI制限**を付けます: Credentialsでキーを選択 → **Edit API key** → **Key restrictions** の **Set an application restriction** で **Websites** を選び、デモのURLの完全形を入力します（例 `https://<ドメイン>`、サブドメイン全体なら `https://*.example.com`。パスはブラウザが消すため**付けない**）→ **API restrictions** で **Restrict key** を選び、**Maps JavaScript API** だけに絞る → **Save**。→ 他のサイトや他のAPIでは、このキーが使えなくなります。デモURLが確定する前に行うと動かなくなるので、必ずTask 7のあとに行ってください。
    出典: https://developers.google.com/maps/api-security-best-practices （2026-10-21確認）

   注記: 月2,000ロードの割当（Quotas）と予算アラートの設定は、**デプロイ後**に ops/demo-deploy.md §4.3 の手順で行います（Google Cloud Console側の設定。根拠はその節）。

## §4 wrangler login

 wranglerは、Cloudflareを操作するためのコマンドです。この作業で、wranglerにあなたのCloudflareアカウントを操作する権限を与えます。このリポジトリのディレクトリで実行してください（ターミナルで `cd` してから）。

20. ターミナルで `npx wrangler login` を実行します。→ ブラウザが開き、Cloudflareのログイン画面（ログイン済みなら認可画面）が出るので **Allow** を選びます。ブラウザが開かないときは、端末に表示されたURLをコピーして手動で開いてください。成功すると、wranglerが「Successfully logged in.」と出します。
    出典: https://developers.cloudflare.com/workers/wrangler/commands/general/#login （2026-10-21確認）
21. この端末でブラウザを開けない場合（リモート環境など）は、`npx wrangler login --device` を実行します。→ 検証用URLと短いコードが表示されます。スマホ等の別のブラウザでそのURLを開き、コードを入れて認可すると（5分以内）、ログインが完了します。
    出典: https://developers.cloudflare.com/workers/wrangler/commands/general/#login （2026-10-21確認）

## §5 token・Secretの作成と登録先一覧

### demo用のAPI token（GitHubの週次リセットworkflowが使う。Task 5で登録）

 tokenは、GitHubの自動処理（週次リセット）がCloudflareへ接続するための鍵です。

22. `https://dash.cloudflare.com/profile/api-tokens` を開き（**My Profile > API Tokens**）、**Create Token** で **Custom token** を選びます。→ token作成の画面に入ります。テンプレートは使わず、自分で権限を絞めます。
    出典: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ （2026-10-21確認）
23. tokenに名前を付け（例: demo-reset）、権限を**最小**に設定します: **Account / D1 / Edit** ＋ **Account / Workers R2 Storage / Edit** ＋ **Account / Workers Scripts / Edit** の3つ。対象リソースは自分のアカウント（Include）にします。→ このtokenでできるのは、demo環境のデータベースとファイルの書き換え（週次リセット）だけになります。staging・production用のtokenとは別物として扱い、共有しません。権限の正式なグループ名は、下記の「Available token permissions」ページで確認できます。
    出典: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ ＋ https://developers.cloudflare.com/fundamentals/api/reference/permissions/ （2026-10-21確認）
24. **Continue to summary** → **Create Token** を選び、表示されたtokenの値を**一度だけ**コピーして、手元の安全な場所に保存します。→ tokenの値はこの画面でしか表示されません（再表示不可）。紛失したら作り直しです。
    出典: https://developers.cloudflare.com/fundamentals/api/get-started/create-token/ （2026-10-21確認）
25. GitHubにSecretを3つ登録します。このリポジトリのGitHubページ → **Settings** → **Secrets and variables** → **Actions** → **Secrets** タブ → **New repository secret** で、次の3つを登録します（値はGitHubの画面に再表示されません。staging／productionと同じ規律=ops/deploy.md §0・環境別Secret）。
    ① **Name** `CLOUDFLARE_API_TOKEN_DEMO`／**Secret** ステップ24のtokenの値 → 週次リセットのworkflow（Task 5が作る）が、Cloudflareへ安全に接続できるようになります。
    ② **Name** `CLOUDFLARE_ACCOUNT_ID_DEMO`／**Secret** ステップ5で控えたアカウントID（要と確定したのはTask 5。ops/demo-deploy.md §3.1）。
    ③ **Name** `DEMO_ACCOUNT_PASSWORD`／**Secret** 12文字以上の任意の値（自分で決める）→ 体験アカウント3本のログインパスワードとして固定で使われ、週次リセット後も同じ資格情報でログインできます。手元のパスワード管理ツールにも必ず控えてください。workflowはこの値を環境変数でスクリプトへ渡すため、Actionsのログに値は出ません（GitHubがSecretの値をログで自動マスクします。ops/demo-deploy.md §3.1）。
    出典: https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions （2026-10-21確認）

### `BETTER_AUTH_SECRET`（CloudflareのWorker側のSecret。Task 7で投入）

26. （Task 7の実行時に、値を知っている本人の端末で）32バイト以上の乱数を生成して、`npx wrangler secret put BETTER_AUTH_SECRET --env demo` を実行し、プロンプトに値を貼り付けます。乱数の生成例: `openssl rand -base64 48`。→ ログインセッションを署名する鍵が、Cloudflareに暗号化されて登録されます。以後、ダッシュボードにもwranglerにも値は表示されません（上書きは再度のputで行います）。値はチャット・メール・Gitに貼らないでください（ops/demo-deploy.md §5.1・ops/deploy.md §0どおり）。
    出典: https://developers.cloudflare.com/workers/configuration/secrets/ ＋ https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-put （2026-10-21確認）

### 値の登録先まとめ

| 名前 | 何の値か | 登録先 | 値を入れる人と方法 |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | 認証セッション署名用の乱数（32バイト以上） | CloudflareのWorker（`wrangler secret put --env demo`） | 本人が端末のプロンプトへ（ステップ26） |
| Maps APIキー | Google Mapsの鍵 | **ビルド変数** `VITE_GOOGLE_MAPS_API_KEY`（アプリを作るときだけ使う設定値。ビルドする端末の `.env.local`〔Git管理外〕。CloudflareのSecretではない） | ビルド実行者がビルド時に読み込む（Task 7） |
| `CLOUDFLARE_API_TOKEN_DEMO` | demo用API token | GitHubのリポジトリSecret | 本人がGitHubの画面へ（ステップ25①） |
| `DEMO_ACCOUNT_PASSWORD` | 体験アカウント3本の固定ログインパスワード（12文字以上。値は自分で決める） | GitHubのリポジトリSecret | 本人がGitHubの画面へ（ステップ25③。値は手元のパスワード管理ツールにも控える） |
| アカウントID | CloudflareアカウントのID（秘密値ではないがGitに載せない） | GitHub Secret `CLOUDFLARE_ACCOUNT_ID_DEMO`（**要**: Task 5で確定。ops/demo-deploy.md §3.1）・設定の実値 | 本人がGitHubの画面へ（ステップ25②。値はステップ5で控えたもの） |
| 体験アカウント3本のパスワード | デモ用ログイン資格情報 | 実環境demoはGitHub Secret `DEMO_ACCOUNT_PASSWORD` の固定値（上の行）。ローカルの`npm run demo`はseed実行時の標準出力に一度だけ表示（ops/demo-deploy.md §2・Task 4） | 実行者が画面から控えて営業時に渡す（実環境はSecretに登録した値そのもの） |

## §6 できあがるもの一覧と、後続タスクの対応表

27. 下の「あなたの値」列を、手元の記録（パスワード管理ツール等）に埋めたら完了です。→ 後続タスクが待っている値が全て揃います。埋まらない欄があれば、対応する§へ戻ってください。
    出典: https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/ （アカウントIDの確認場所。2026-10-21確認）

| できあがるもの | 作る手順 | あなたの値（例の形。実値は手元にだけ） | 待っている後続タスク |
|---|---|---|---|
| Cloudflareアカウント（Workers Paid・カード登録済み・メール確認済み） | §1（ステップ1〜4） | — | Task 7（デプロイ実行）: D1/R2/Queueの作成と `database_id` の実値反映 |
| CloudflareアカウントID | ステップ5 | 32桁の英数字 | Task 7・GitHub（`CLOUDFLARE_ACCOUNT_ID_DEMO`〔**要**: Task 5で確定〕） |
| ドメイン名（同じアカウントのzone登録済み） | §2（ステップ6〜13）**※2026-10-22裁定で不要** | `<例: fireos-demo.example.com>` | Task 7: route/custom_domain設定・`AUTH_BASE_URL` の実URL化・WAF/Rate Limiting。**Task 7のあと**ステップ19（参照元制限） |
| Google Maps APIキー（Maps JavaScript API有効・請求先紐付け済み） | §3（ステップ14〜18） | `AIza` で始まる文字列（形の例のみ。実値は手元にだけ） | Task 7: ビルド時の `VITE_GOOGLE_MAPS_API_KEY`（`.env.local`・Git管理外）。**Task 7のあと**ステップ19 |
| demo用API token（最小権限） | §5（ステップ22〜24） | `cfut_` で始まる形式 | ステップ25①を経て **Task 5**（週次リセットworkflow） |
| GitHub Secret `CLOUDFLARE_API_TOKEN_DEMO` | ステップ25① | — | **Task 5** |
| GitHub Secret `DEMO_ACCOUNT_PASSWORD` | ステップ25③（12文字以上の任意の値） | 手元のパスワード管理ツールにも控える | **Task 5**（週次リセットworkflowが体験アカウント3本のパスワードとして使う。ops/demo-deploy.md §3.1） |
| wrangler login済みの端末 | §4（ステップ20〜21） | — | Task 7: `wrangler deploy --env demo`・migration・`wrangler secret put` |
| `BETTER_AUTH_SECRET` | ステップ26（Task 7時） | 乱数64文字程度 | Task 7 |

 この手順はTask 2〜6の実装と並行して完結できます。Task 5が待つのはGitHub Secret（ステップ25）まで、Task 7が待つのは上の表の全行です。

## §7 やってはいけないこと

- キー・token・Secret・パスワードの値を、チャット・メール本文・Git・docsに貼ること（AGENTS.md・ops/demo-deploy.md §6）。値を伝える必要があるときは、相手に直接入力してもらう
- 制限を付けないままのMapsキーで、公開URLを動かすこと（悪用の請求は鍵の持ち主に来る。ステップ18・19）
- demo用tokenの権限を広げること・staging／production用の資格情報と共有すること（分離規律 RG-09・ops/demo-deploy.md §1）
- `BETTER_AUTH_SECRET` を32バイト未満にすること・使い回すこと（ステップ26）
- この手順の実施記録（いつ・どのドメインを取得したか等）をGitへ書くこと。実施記録は**値を含まない形で**営業台帳（手元）に残す。完了したら後続タスクへ「対応表が全て埋まった」ことだけを伝える
