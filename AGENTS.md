# AGENTS.md

エージェント向けの作業指針。詳細の正本は README.md と docs/。

## 正本と優先順位

- **画面の構成・導線・見た目・文言の正本は `prototype/`（FireOS Prototype.dc.html / Desktop / Design System / Directions）。フロントエンド実装（React）はprototypeに厳密に従うこと。docsと食い違う場合はprototypeを優先し、意図して変える点だけ docs/03「prototypeから意図して変えた点」に記録する。**
- 業務規則・権限・状態遷移・API・DBは docs/ が正本。競合時は docs/01（要件）・docs/13（リリース判定）を優先（ただし画面はprototypeが正）。
- docsは凍結しない。実装で分かった方式変更は、設計・実装・試験・docs/12/16（トレーサビリティ・タスク）を一緒に直してよい。理由と影響はコミットに残す。
- Git・公開画面には実データ（実名簿・実出動・非公開水利・現場写真）を載せない。架空データのみ。

## 進め方

- 作業は docs/16 の全89タスク（T001〜T088＋枝番T085b＝e2e高速化）に従う。PH0/PH1（T001〜T014）は完了、次はPH2のT015から。
- タスクの完了 = 実装＋指定試験＋関連回帰＋docs/16の状態・証跡更新。省略してチェックを付けない。テストのskipやSecret未設定を成功扱いにしない。
- **作業完了後は必ずコミットする。** コミットはタスクの区切り。実績は conventional commits（`feat: complete T014 audit` / `fix:` / `docs:`）。実装コミットには対応するdocs・試験の差分も含め、文書だけの改訂は`docs:`で分ける。混在するファイルは`git add -p`で切り出す。
- lint/formatterは無い。型検査が主ゲート。

## 検証コマンド（CIと同じ順）

```bash
npm ci                  # Node >=22（.nvmrc は26）
npm run typecheck       # tsc --noEmit
npm run check:contracts # 102 API台帳×docs/05の表×openapi/fireos.json の一致検査
npm run check:coverage  # 受入manifest（tests/acceptance/manifest.json）が54要件/AT×CT/18TC/102API/28SCR/journey4を実テストへ対応付けているかの静的検査
npm run build           # vite build → dist/client
npx vitest --run        # workers（実workerd＋D1/Queues）と client（jsdom）の両プロジェクト
npm run test:e2e -- --project=setup --project=phone-360 --project=desktop-1280 --project=tablet-768  # 業務のe2e（CIと同じ。要: npx playwright install chromium）
```

- 受入ゲート（T085）: `npm run collect:evidence` が vitest・`test:load`・業務e2eを実行して証跡index（docs/evidence/acceptance-index.json）と docs/evidence/acceptance-results.md を作る（約20分。e2eのポート〔既定8797〕を使う。`test:live` はSecret無しなら「未実施」と記録）。ゲートは `npm run test:e2e -- tests/acceptance/all-requirements.spec.ts --grep acceptance_gate_fails_on_skip_missing_route_or_unexecuted_case`。**index作成後にコード（src/・tests/・drizzle/・scripts/・public/・config/・.github/・openapi/・docs/03・ルートの設定ファイル。受入ゲート自身のmanifest・spec・3scriptは除く）を変えると全件「未実行」で赤**＝変えたら collect:evidence をやり直す。フレーキーで1スイートだけ落ちたときは `npm run collect:evidence -- --only=e2e`（スイート全体を同じコードで再実行し、旧実行は記録に残す）。`--project` を付けない `npm run test:e2e` は受入ゲート（project acceptance）も流す
- manifestを直したら `npm run check:coverage` → `npx tsx scripts/collect-evidence.ts --report-only`（acceptance-results.mdの作り直し。manifestはhashの対象外なので再収集は不要）

- 単一テスト: `npx vitest --run tests/members.test.ts -t "ケース名"` / e2e単独: `npm run test:e2e -- tests/e2e/auth.spec.ts --grep ケース名`
- `npm run test:e2e:smoke`: 開発中の反復用の縮小セット（setup＋journeys＋auth＋shell をdesktop-1280だけ）。フルe2eの代わりにはしない（コミット前はフルで確認）
- API/DTOを変えたら `npm run generate:contracts` で `openapi/fireos.json` を再生成（check:contractsが古い生成物を検出する）
- `npm run test:e2e` の webServer は D1再作成→migration→初期管理者作成→`wrangler dev`（**:8797**。inspectorは9239）まで自動で行う。ポートは `scripts/e2e-port.ts` が正本で、環境変数 `FIREOS_E2E_PORT`（inspectorは `FIREOS_E2E_INSPECTOR_PORT`）で変えられる。demo（`npm run demo`）は従来どおり8787で、別プロジェクトの8787と並行できるようe2eは別番号にしている。e2eの前にそのポートが空いていることを確かめ、手動のwrangler devを同じ番号で先に上げない。workers=2（T085b。試験ごとの架空データ分離が前提）。幅の絞り込み（T085b）: 各試験の宣言直上の「幅:」マーカーが正本で、幅で変わる断言（isPhone分岐・押下領域44px・ナビ構成・はみ出し・prototype寸法）のある試験だけ両幅で走り、他はdesktop-1280だけ。仕分け表は docs/evidence/e2e-speed.md。新規試験には必ずマーカーを付ける（無いと設定の読み込みが落ちる）
- `npm run test:live` は実Cloudflare(staging)向け。`LIVE_BASE_URL` `LIVE_BOOTSTRAP_TOKEN` `LIVE_BOOTSTRAP_EMAIL` が必要
- `npm run migrate` はローカルD1のみ。`--remote` には `--env <名前> --yes-i-know` が必須（本番誤適用ガード）
- `npm run demo` / `demo:reset` で手元の画面確認。初回の管理者招待リンクは一度しか表示されない。デモのログイン情報はGit管理外の `.env.demo-login`
- `scripts/mutate.sh` / `mutate-e2e.sh`: 防御を外して試験が落ちることを確認する変異テスト（終了時にファイルは自動復元）

## アーキテクチャの要点

- Workers1本にHono APIとReact SPAを同一originで同居。`/api/*` は必ずJSONで応答する（未実装APIがSPAのHTMLを返して成功に見えないため）。API追加は `src/shared/contracts/` の台帳・docs/05・OpenAPI を3点同時に揃える
- 認可は `src/server/auth` の同期純関数。主体・権限は毎要求D1から引き直す（権限変更が次要求で効く）
- 業務更新は版・冪等・認可を検査し、原本/履歴/監査/outboxを1つのD1 batchで確定する。R2/Queues/AIとD1の分散transactionは仮定しない
- wrangler.jsonc は4環境（local/demo/staging/production）。**wranglerのenvはbindingを継承しない**ので、各環境に全bindingを書く。database_idは仮値。Secretは設定に書かない（localは `.dev.vars`＝自動生成、他は `wrangler secret put`）
- `TEST_AUTH=1` はテスト専用の認証注入binding。demo/staging/productionの設定には入れない
- migrationは `drizzle/000N_*.sql` の連番必須（欠番・重複で migrate.ts が拒否）。`compatibility_date` 変更時は tests/runtime.test.ts と docs/02 §2 を再確認する
