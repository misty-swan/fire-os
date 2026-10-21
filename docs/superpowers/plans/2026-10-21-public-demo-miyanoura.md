# 公開営業デモ（宮之浦）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 宮之浦（屋久島）が舞台の架空分団データと体験アカウントを備えた公開営業デモをCloudflareへ構築する（Google Maps実装・週次リセット・セキュリティ実設定・営業台本つき）。

**Architecture:** クライアントはMaps APIキーの有無で「実地図/現行の置き換え絵」を切り替える（キーはdemoデプロイ時のみビルド変数で注入・リポジトリには置かない）。seedは`wrangler d1 execute`経由のSQL文生成を踏襲し`--remote`対応でdemo環境へ再投入する。 CSPはWorkerがdemo環境のときだけHTML応答へ付ける。新規API endpointは作らない（契約台帳102不変）。

**Tech Stack:** Cloudflare Workers + Assets / D1 / R2 / Google Maps JavaScript API（動的ロード・`@types/google.maps`）/ GitHub Actions / 既存のseedDemo・DEMO_SECURITY_POLICY・verifyDemoIsolation。

**Spec:** `docs/superpowers/specs/2026-10-21-public-demo-miyanoura-design.md`（§8のユーザー決定4項目を含む。実装者は必ず先に読む）

## Global Constraints

- 架空データのみ。実在の水利位置・実名簿・実写写真を載せない（AGENTS.md）。施設は実地理の範囲内の**架空の点**・架空の名前・番号
- 「架空データによる検証版です」バッジ（AppShell）を維持する。団体名は実名「宮之浦分団」で、バッジと台本で架空である旨を併記（設計§8-2）
- **キーが無い環境では現行の置き換え絵のまま**（ローカル・試験・e2eは不変。X-V05の「実接続はdemo」の記載と矛盾させない）。MapsキーはGit・チャット・docsに載せない
- 認可規則（PER-06/07/08の二要素必須）を変えない。体験アカウントで機微操作が拒否される挙動は仕様（台本で説明材料にする）
- demo環境のbinding/Secret/データは他環境と分離（`npm run check:environment` 緑を維持）。TEST_AUTH等をdemoへ入れない
- 新規API endpointなし（`npm run check:contracts` は102 APIのまま緑）
- 費用はDemo budget上限（月$5・AI 500回/日等）とMaps月2,000ロード制限の内（ops/demo-deploy.md §4）
- ユーザー作業手順書（Task 1）は**公式ドキュメントの該当節を確認しながら**作り、出典URLと確認日を明記する。推測で書かない（設計§8-3）
- 各タスクの完了＝実装＋指定試験＋関連回帰＋コミット（conventional commits）。テストのskipを成功扱いにしない

## Review Focus

1. **キー入りのビルド産物がローカル/e2eに混入** — キー無しビルドのjsdom試験が置き換え絵を選ぶことを固定し、`.gitignore`へキー入りの`.env*`を追加（Task 2）
2. **体験アカウント資格情報の弱さ** — 固定パスワードは12文字以上の生成値をops記録に限定し、workers試験で実際のログインと`DEMO_SECURITY_POLICY`のレート制限が効くことを確認（Task 4）
3. **`--remote` seedが誤環境へ書く** — `--remote`は`--env demo --confirm demo`がないと拒否（bootstrap-admin.ts:27-28と同じ規律）。試験で拒否を固定（Task 5）
4. **CSP許可漏れで地図・フォント・写真が壊れる** — demo環境のみ付与・内容（maps/fonts/img/worker-src）をworkers試験で固定し、実URLでの営業前チェックリストで最終確認（Task 6・7）
5. **宮之浦データが実在水利に読める** — 施設の座標が設計で宣言した架空範囲内であること・名前/番号が架空であることをseed試験で固定（Task 3）

---

### Task 1: ユーザー作業手順書（契約・ドメイン・キー・Secret）とタスク台帳登録

**Files:**
- Create: `ops/demo-provisioning.md`
- Modify: `docs/16_実装タスク一覧.md`（営業デモのタスク行を追加: T089「営業デモ準備」単一行にTask 1〜8を紐づけるか、実装時にT089〜T092へ分割。実装者が状態欄の様式に合わせて追加）

**Interfaces:**
- Produces: 後続タスクとユーザーが参照する手順書。Task 7（デプロイ実行）とTask 5（GitHub Secret）がこの手順の完了を待つ。ユーザーはこの手順を**並行して**実施できる

- [ ] **Step 1: 公式ドキュメントを確認しながら手順書を書く**

webfetch/websearchで該当する公式ページ（Cloudflare: アカウント作成・Workers Paid契約・ドメイン購入とzone登録・API token発行 / Google: Maps JavaScript APIの有効化・APIキー発行・参照元制限・請求先）を確認し、番号付き手順として`ops/demo-provisioning.md`に書く。各手順に公式ドキュメントの出典URLと確認日を付ける。含める章: §1 CloudflareアカウントとWorkers Paid（カード登録）／§2 ドメイン取得とCloudflareへの登録（zone）／§3 Google Maps APIキー（有効化・請求先・参照元制限はデプロイ後の実URLで設定する旨も）／§4 wrangler login／§5 Secretとvarsの登録先一覧（`BETTER_AUTH_SECRET`・`GOOGLE_MAPS_API_KEY`〔ビルド変数〕・GitHubの`CLOUDFLARE_API_TOKEN`等・値の渡し方と「チャット・Gitに貼らない」）／§6 できあがるもの一覧（アカウント・ドメイン名・キー・token）と、以降のタスクがどれを待つかの対応表
- [ ] **Step 2: docs/16へタスク行を追加**

営業デモ準備のタスク行（依存: T088完了）を追加し、本計画のTask 1〜8を対応付ける（既存の表様式に合わせる。新規要件は増やさず設計書§7どおり既存残手順〔X-DEMO・X-V05〕の実施枠として位置づける）
- [ ] **Step 3: 検証してコミット**

`grep -c "出典" ops/demo-provisioning.md`で全手順に出典が付いていることを確認。`git add ops/demo-provisioning.md docs/16_実装タスク一覧.md && git commit -m "docs: add demo provisioning runbook for sales demo"`

### Task 2: Google Maps実装（キーがある環境だけで実地図）

**Files:**
- Create: `src/client/features/map/GoogleMapCanvas.tsx`（実地図タイルの上にマーカー・チップを載せるcomponent）と `src/client/features/map/useGoogleMaps.ts`（動的ローダー）
- Modify: `src/client/features/map/MapPage.tsx`（キャンバス部の分岐）、`src/client/features/map/FacilityMarkers.tsx`（マーカーDOMを両キャンバスで再利用できるよう props の切り出し）、`.gitignore`
- Test: `tests/map-google.test.tsx`（jsdom・新規）

**Interfaces:**
- Consumes: `FacilityItem`・`FACILITY_TYPES`・`facilityName`（`useFacilities.ts`）。既存の`FacilityMarker`（表示位置x/yは置き換え絵用。実地図では緯度経度から`google.maps.OverlayView`等で配置）
- Produces: `useGoogleMaps(): { loaded: boolean; error: string | null }`（キーが無い環境では`loaded:false`・呼び出しは無害）。`GoogleMapCanvas`は`facilities: FacilityItem[]`・選択状態のpropsを受け取る。MapPageは`import.meta.env.VITE_GOOGLE_MAPS_API_KEY`の有無で`GoogleMapCanvas`/現行置き換え絵を選ぶ（分岐はMapPageに1箇所）
- 制約: キーは`import.meta.env.VITE_GOOGLE_MAPS_API_KEY`（viteがビルド時に値へ差し替え。リポジトリの既定値は空）。Maps JS APIは`async` callbackで動的ロード（scriptタグ生成）。マーカーの形・色・種別チップはprototype（Design System）どおり＝`FacilityMarker`のDOMをoverlayとして使い、SVG pin（mapsの`google.maps.Marker`は使わない）で描く。帰属表示（「©Google」）はタイル由来で自動。外部地図アプリ経路ボタンは現行どおり

- [ ] **Step 1: 失敗する試験を書く**

`tests/map-google.test.tsx`に: ①キーが無い（`import.meta.env.VITE_GOOGLE_MAPS_API_KEY`未定義）ときMapPageが現行の置き換え絵（`CITY_BBOX`ベースのマーカーbox）を選ぶこと ②`useGoogleMaps`はキーが無い環境でloaded:falseのままerrorも出さないこと ③キーがある環境では`GoogleMapCanvas`がscript要素（`maps.googleapis.com/maps/api/js`）を一度だけ挿入すること（jsdomで`document.querySelector('script[src*="maps.googleapis"]')`を検査。ネットワークは呼ばない=ローダーは`Promise`を返すだけで解決は地図callback待ちにする設計） ④ロード失敗時は置き換え絵へフォールバックし「地図を読み込めませんでした。一覧で確認できます。」の案内を出すこと（エラー注入）
- [ ] **Step 2: 赤を確認**

Run: `npx vitest --run tests/map-google.test.tsx`
Expected: FAIL（component不在）
- [ ] **Step 3: 実装**

`useGoogleMaps`（キー検出・単一ロードPromise・`gm_authFailure`フックでエラー検知）と`GoogleMapCanvas`（OverlayViewで`FacilityMarker`DOM配置・`fitBounds`で宮之浦範囲へ初期視点・チップ/一覧/選択シートはMapPageの既存stateをそのまま使う）を実装し、MapPageのキャンバス部を分岐。`.gitignore`へ`.env.local`等のキー入り環境ファイルが既に無いか確認し、必要なら追記
- [ ] **Step 4: 緑と回帰を確認**

Run: `npx vitest --run tests/map-google.test.tsx tests/map-facilities.test.tsx && npm run typecheck`
Expected: 全PASS。Run: `npm run test:e2e -- tests/e2e/map.spec.ts --project=setup --project=phone-360 --project=desktop-1280`
Expected: 全PASS（キー無し=置き換え絵のため現行どおり）
- [ ] **Step 5: コミット**

`git add -A src/client/features/map tests/map-google.test.tsx .gitignore && git commit -m "feat: render real google maps when api key is present"`

### Task 3: 宮之浦の架空データへの差し替え

**Files:**
- Modify: `scripts/seed-demo.ts`（`DEMO_UNIT_NAME`・団員・施設・活動・出動・文書の地名・座標）、`src/client/features/map/FacilityMarkers.tsx`（`CITY_BBOX`を宮之浦周辺へ）
- Test: `tests/demo-isolation.test.ts`（既存・拡張）と`tests/seed-miyanoura.test.ts`（新規）

**Interfaces:**
- Consumes: 既存seed構造（`DEMO_UNIT_NAME`・`DEMO_PROFILE`・`DEMO_SEED_IDS`・facility INSERT部 seed-demo.ts:373-390 など）
- Produces: `DEMO_UNIT_NAME = "宮之浦分団"`。`export const DEMO_BBOX = { west: 130.64, south: 30.35, east: 130.70, north: 30.42 }`（宮之浦周辺の表示範囲。`CITY_BBOX`はこの値へ置き換え・名前も`DEMO_BBOX`へ変更し参照を更新）

- [ ] **Step 1: 失敗する試験を書く**

`tests/seed-miyanoura.test.ts`に: ①seedの全施設座標が`DEMO_BBOX`内にあること ②施設の管理番号・identifying_name・所在地に「架空」の標識（例: 番号プリフィクス`MY-`・所在地に「（デモ用の架空地点）」）が付くこと ③`DEMO_UNIT_NAME`が「宮之浦分団」であること ④団員名・メール（`example.test`等の既存ドメイン）・電話が架空のまま（`FICTIONAL_EMAIL_DOMAINS`準拠）であること。`tests/demo-isolation.test.ts`へ宮之浦データでの隔離検査が従来どおり通ることを確認（必要なら期待値を宮之浦へ更新）
- [ ] **Step 2: 赤を確認**

Run: `npx vitest --run tests/seed-miyanoura.test.ts`
Expected: FAIL（データ未変更）
- [ ] **Step 3: データを書き換える**

団員16名・施設13件程度を現行と同規模で宮之浦版へ。座標は`DEMO_BBOX`内の架空の点（川・港・国道沿いを意識した分布にするが、実在の消火栓位置を写し取らない。地名・番号は架空）。活動・出動・文書・点検の地名・文言の「架空市」を宮之浦の架空地名へ置換。`CITY_BBOX`→`DEMO_BBOX`へ改称して値更新（MapPage・試験の参照更新）
- [ ] **Step 4: 緑と回帰を確認**

Run: `npx vitest --run tests/seed-miyanoura.test.ts tests/demo-isolation.test.ts tests/map-google.test.tsx tests/map-facilities.test.tsx && npm run typecheck`
Expected: 全PASS
- [ ] **Step 5: コミット**

`git add scripts/seed-demo.ts src/client/features/map tests/ && git commit -m "feat: seed miyanoura fictional brigade demo data"`

### Task 4: 体験アカウント3本（固定資格情報・MFAなし）

**Files:**
- Create: `src/server/auth/demo-accounts.ts`（アカウント生成のstatements生成・純関数）
- Modify: `scripts/seed-demo.ts`（seed末尾で体験アカウントを投入）、`ops/demo-deploy.md`（体験アカウントのIDと運用記録の置き場所を追記。パスワード値自体はopsに書かず「seed実行時の標準出力で一度だけ表示」にする）
- Test: `tests/demo-accounts.test.ts`（workers・新規）

**Interfaces:**
- Consumes: `src/server/auth/bootstrap.ts`の文生成パターン（`stmts: { sql, binds }[]`）。better-authのuser/accountテーブル（`src/server/auth/`内の既存定義を確認して使う）
- Produces: `demoAccountStatements(input: { unitId: string; now: Date; credentials: DemoCredential[] }): Stmt[]`。`DemoCredential = { email: string; password: string; memberName: string; role: "admin" | "officer" | "member" }`。3件固定（`demo-admin@`・`demo-officer@`・`demo-member@` + `example.test`ドメイン）。パスワードは実行ごとに生成せず**固定値をsourceに書かない**——seed実行時に`crypto`で生成して標準出力へ一度だけ表示し、`--password`引数で再投入時に指定できる（リセット後も同じ資格情報を保つためops記録に利用者が保存）

- [ ] **Step 1: 失敗する試験を書く**

`tests/demo-accounts.test.ts`に: ①投入された体験アカウントで**実際のログインAPI**（`/api/auth/sign-in/email`）が200になりセッションが取れること（password→better-auth検証を通る=ハッシュ方式の一致を機械保証） ②3役割の内`admin`は`mfaEnabled:false`のままPER-07が`mfa_required`で拒否されること（規則不変の固定） ③`member`役職の団員行・監査行が正しく作られること ④emailが全て`example.test`ドメイン（架空検査準拠）であること
- [ ] **Step 2: 赤を確認**

Run: `npx vitest --run tests/demo-accounts.test.ts`
Expected: FAIL（module不在）
- [ ] **Step 3: 実装**

ハッシュはbetter-authと同じ方式（`src/server/auth/`内の実装かライブラリ公開APIを確認して再利用。手書きSQLの暗号は禁止）。member/user/account/監査の文を生成し、seed-demo.tsから呼ぶ
- [ ] **Step 4: 緑と回帰を確認**

Run: `npx vitest --run tests/demo-accounts.test.ts tests/demo-isolation.test.ts && npm run typecheck`
Expected: 全PASS
- [ ] **Step 5: コミット**

`git add src/server/auth/demo-accounts.ts scripts/seed-demo.ts tests/demo-accounts.test.ts ops/demo-deploy.md && git commit -m "feat: seed demo login accounts for sales hands-on"`

### Task 5: seedの`--remote`対応と週次リセットworkflow

**Files:**
- Modify: `scripts/seed-demo.ts`（`--remote --env demo --confirm demo`時は`wrangler d1 execute DB --env demo --remote`と`wrangler r2 object put --env demo --remote`へ切替。写真・文書のR2実体も含める）
- Create: `.github/workflows/demo-reset.yml`（週1回のcron＋`workflow_dispatch`。`CLOUDFLARE_API_TOKEN`〔権限はdemo環境のD1/R2/Workers deployのみ〕でseed --remote→成功通知）
- Modify: `ops/demo-deploy.md`（リセット手順・失敗時の対処を追記）
- Test: `tests/demo-reset.test.ts`（scripts純関数の単体＋workflowの内容検査は`tests/deploy-config.test.ts`様式に合わせ`tests/demo-reset.test.ts`へ）

**Interfaces:**
- Consumes: `bootstrap-admin.ts:26-28`の`--remote --confirm`規律、Task 3・4のseed
- Produces: `npm run demo:reset:remote -- --confirm demo`（package.jsonへ追加）。workflowのjob名と使うsecret名（`CLOUDFLARE_API_TOKEN_DEMO`）をopsへ記録

- [ ] **Step 1: 失敗する試験を書く**

①`--remote`が`--env demo --confirm demo`欠けで拒否（exit 1・エラー文） ②remote時のコマンド列が`--env demo --remote`を含む（純関数`buildSeedCommands`として切り出して検査） ③workflow yamlがcron（週1）と`workflow_dispatch`と最小権限permissionsを持ち、token名が`CLOUDFLARE_API_TOKEN_DEMO`であること
- [ ] **Step 2: 赤を確認・Step 3: 実装・Step 4: 緑を確認**

Run: `npx vitest --run tests/demo-reset.test.ts && npm run typecheck`
Expected: 全PASS（実環境への接続はしない。実行はTask 7）
- [ ] **Step 5: コミット**

`git add scripts/seed-demo.ts .github/workflows/demo-reset.yml tests/demo-reset.test.ts ops/demo-deploy.md package.json && git commit -m "feat: remote demo seed reset with weekly workflow"`

### Task 6: demo環境のみCSP付与

**Files:**
- Create: `src/server/security/csp.ts`（ポリシー文字列の生成・純関数）
- Modify: SPAのHTML/assetsを返すWorkerの応答箇所（`src/server/`の静的配信部分を実装者が特定）へdemo環境（`env.APP_ENV === "demo"`）のときだけヘッラーを付与
- Test: `tests/demo-csp.test.ts`（workers・新規）

**Interfaces:**
- Produces: `cspHeaderValue(env: { mapsEnabled: boolean }): string`。許可リスト: `script-src 'self' https://maps.googleapis.com`／`style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`（既存Google Fonts対応）／`font-src 'self' https://fonts.gstatic.com data:`／`img-src 'self' data: blob: https://*.googleapis.com https://maps.gstatic.com`／`worker-src 'self'`／`connect-src 'self' https://maps.googleapis.com`

- [ ] **Step 1: 失敗する試験を書く**

①demo環境のHTML応答にCSPヘッダーがあり上記の全ドメインを含む ②local環境（APP_ENV=local）の応答にCSPが**無い**（e2e不変） ③`mapsEnabled:false`でもfonts系は許可のまま（フォント崩れ防止）
- [ ] **Step 2〜4: 赤→実装→緑**

Run: `npx vitest --run tests/demo-csp.test.ts && npm run check:environment && npm run typecheck`
Expected: 全PASS
- [ ] **Step 5: コミット**

`git add src/server tests/demo-csp.test.ts && git commit -m "feat: add demo-only content security policy"`

### Task 7: デプロイ実行と営業前チェックリスト（ユーザー作業と同期）

**Files:**
- Modify: `wrangler.jsonc`（demo環境へ取得ドメインのroute/custom_domain設定・`AUTH_BASE_URL`を実URLへ）※database_id等の実値はユーザー作業後に置換
- Modify: `ops/demo-deploy.md` §5（デプロイ手順へMapsキー入りビルド（`VITE_GOOGLE_MAPS_API_KEY=… npm run build`）・ドメイン設定・WAF/Rate Limitingの実設定手順〔ops/demo-deploy.md §5.3どおり、公式ドキュメント出典つき〕を反映）
- Create: `docs/evidence/demo-live-check.md`（実URLでの営業前チェックリストの記録）

**Interfaces:**
- Consumes: Task 1の手順書が完了していること（ユーザーのアカウント・ドメイン・キー）。Task 2〜6の実装
- Produces: 稼働する公開デモURLと、その実測記録（チェックリスト: 地図表示〔キー〕・点検登録→異常→AI・出欠回答・体験3アカウントのログイン・「架空データ」バッジ・CSP下で壊れないか・レスポンス概況）

- [ ] **Step 1: 設定反映と手順更新**（wrangler.jsonc・demo-deploy.md。実行はユーザー環境で行うため、ここはコードと文書の整備）
- [ ] **Step 2: ユーザー作业完了後にデプロイ実行**（手順書どおり。`--confirm demo`ガード）※このステップはユーザーの契約作業待ち。待つ間にTask 8へ進んでよい
- [ ] **Step 3: 実URLチェックリスト実行と記録**（docs/evidence/demo-live-check.md。地図が白紙ならCSP許可を修正して再確認）
- [ ] **Step 4: コミット**

`git add wrangler.jsonc ops/demo-deploy.md docs/evidence/demo-live-check.md && git commit -m "feat: deploy wiring and live checklist for sales demo"`

### Task 8: 営業台本とQR

**Files:**
- Create: `docs/DEMO_SCRIPT.md`（5分の動線: 地図→点検登録（写真）→異常→AI提案→出欠→締めの言葉。「二要素が要る機微操作」の説明材料・体験アカウントの渡し方・QA想定集〔費用・データは架空・正式導入までの流れ＝docs/ADOPTION_PROPOSAL.md §6へ接続〕）
- Modify: `docs/USER_GUIDE.md`（営業時の案内から参照する章があれば追記）

- [ ] **Step 1: 台本を書く**（qrコード生成は`qrencode`等の代替手段も併記し、URL確定後に作る手順にする）
- [ ] **Step 2: 検証してコミット**

`git add docs/DEMO_SCRIPT.md docs/USER_GUIDE.md && git commit -m "docs: add sales demo script"`

### Task 9: 全体検証と台帳確定

- [ ] **Step 1: 全検証コマンド**（`npm run typecheck && npm run check:contracts && npm run check:coverage && npm run build && npx vitest --run`。`check:contracts`が**102のまま**緑＝新規endpoint無しの確認を含む）
- [ ] **Step 2: e2e**（`npm run test:e2e -- --project=setup --project=phone-360 --project=desktop-1280 --project=tablet-768`が緑。キー無し=置き換え絵で全試験現行どおり）
- [ ] **Step 3: docs/16状態欄・証跡の確定**（Task 1で追加した行へ実施記録。X-DEMO・X-V05の実施状況を実態どおり記録）
- [ ] **Step 4: コミット** `git commit -m "docs: complete sales demo preparation"`
