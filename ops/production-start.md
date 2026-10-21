# 正式運用開始の手順（T088）

目的: docs/13の正式リリース判定が「許可」になった後に、production環境への配置と実データ投入を、このリポジトリの手順だけで再現可能に行う。正本は docs/13_リリース判定基準.md（全ゲート RG-01〜10・§3 判定手順）と docs/14_設計判断・未決事項.md §2（D01〜D20）。配置の詳細は ops/deploy.md §3、初期管理者は ops/bootstrap-admin.md、backup/復元は ops/backup-restore.md、判定の記録は docs/evidence/release-decision.md。

**この手順は今は実行しない。** 正式リリースは不可のままである（docs/evidence/release-decision.md §1・§4）。判定後のみ実行する手順として、実行前の全ゲート確認を§1に置く。

## 0. 前提（実行の停止条件）

- 本手順は、**docs/13の全ゲート（RG-01〜RG-10）合格＋D01〜D20の全項目の回答の記録＋validateProductionPolicy の allowed:true が確認できるまでは絶対に実行しない**〔出典: docs/13_リリース判定基準.md §2・§3 手順4〕。
- 現時点（2026-10-21）は全ゲート不合格＝正式リリース不可のため**実行禁止**〔出典: docs/evidence/release-decision.md §1・§4・config/production-policy.json（回答空欄・全ゲート不合格・approved:false のまま）〕。
- 開発完成（架空データ・ローカル。docs/evidence/development-completion.md）と正式運用開始は別物である。開発完成を「正式運用開始」と呼んではいけない（docs/16 末尾の規定どおり）。

## 1. 実行前の判定確認（番号付き。1つでも満たなければ実行しない）

1. docs/evidence/release-decision.md の改訂版（v2以降）で全ゲート合格が記録されていること（「正式リリース不可」の判定と、その根拠が残ったままになっていないこと）。
2. docs/ADOPTION_CHECKLIST.md の回答欄が全項目記入済みで、同じ回答が config/production-policy.json と DecisionRecord（docs/evidence/release-decision.md が台帳）へ1項目1回答で記録されていること。
3. config/production-policy.json の D01〜D20 で回答空欄・approved:false が残っていないこと（validateProductionPolicy の reasons が空であること）。
4. `npx vitest --run tests/production-policy.test.ts` が緑であること。実ファイルアンカーが allowed:true 側の期待へ**意図的に更新されている**こと（回答を記録した版とセットで更新する。回答の捏造のためのコード変更はしない〔出典: docs/evidence/release-decision.md §5 ⑦〕）。
5. AGENTS.md の検証コマンドが全部緑であること（`npm run typecheck`・`npm run check:contracts`・`npm run check:coverage`・`npm run build`・`npx vitest --run`・業務e2eの全project）に加え、`npm run collect:evidence` の再実行で受入ゲート（docs/evidence/acceptance-index.json・docs/evidence/acceptance-results.md）が緑であること。
6. docs/evidence/acceptance-results.md「実外部・実端末・人の残手順」の29件（X-V01〜X-OUT-10・X-COST）が実施済みで、未実施が残っていないこと（docs/13 RG-03行どおり未実施は合格に数えない）。

## 2. 本番環境の構築（ops/deploy.md §3どおり。番号付き）

1. 資源の作成: D1 `fireos-production`・R2バケット・Queue をCloudflareへ作り、実database_idをwrangler.jsoncのproduction環境へ反映する（仮値 …0004と置き換え。他環境と共有しない。ops/deploy.md §0）。
2. Secret: `npx wrangler secret put BETTER_AUTH_SECRET --env production`（32バイト以上の乱数。Git・チャット・メール本文に貼らない〔ops/deploy.md §0〕）。`GOOGLE_MAPS_API_KEY` 等の他のSecretは `npm run check:environment` の `--secret` で明示して検査対象にする。
3. migration: `npm run migrate -- --env production --remote --yes-i-know`（`--env` と `--yes-i-know` 無しでは実環境へ適用不可＝scripts/migrate.tsのガード。先にexpand（追加のみ）を適用する〔ops/deploy.md §2・§4.2〕）。
4. 初期管理者: ops/bootstrap-admin.md の手順で `--env production` を明示して作る（招待リンクは一度しか表示されない。Worker側のSecret `BETTER_AUTH_SECRET` と `AUTH_BASE_URL` を先に設定しておく）。
5. 実施前にD1 exportとR2のmanifestを取り、復旧点として保管する（ops/deploy.md §3・ops/backup-restore.md）。
6. 配置: GitHubの `deploy-production` workflow（workflow_dispatchのconfirm入力が正確に `production` のときだけ動く。GitHub Environment "production" の承認者レビューと併用）か、ops/deploy.md §1のverify全ゲートを通してから `npx wrangler deploy --env production`。稼働version・commit・日時・実施者を運用記録へ残す。

## 3. 分離の実地確認（RG-09。配置後）

1. `npm run check:environment` が緑であること（4環境の必須binding・資源分離・demo→production参照の拒否・Secret混入なし。ops/deploy.md §1の5）。
2. demo環境からproductionへの接続が拒否されることを実地で確認する（demoのtokenでproductionのAPIを呼べないこと。docs/13 RG-09行・CT-15）。
3. 実データ（実名簿・実出動・非公開水利・現場写真）の投入は正式リリース判定（docs/13 §3 手順4の承認）後の初回のみとし、Gitと公開画面に載せない（AGENTS.md）。公開デモは架空データのみ（実環境のdemo構築とseedの--remote対応は ops/demo-deploy.md §5）。

## 4. 正式開始の宣言と記録

- 承認者（管理主体・開発責任者。docs/13 §3 手順4）・日付・リリース版（commit）・対象・環境・復旧点（ops/backup-restore.md）・runbook一覧（ops/outage-runbook.md・ops/security-response.md・ops/cost-alerts.md・ops/contact-flow.md・ops/admin-handover.md・ops/account-recovery.md）を docs/evidence/release-decision.md へ追記する。
- 開始の記録は本記録の改訂（版の繰上げ）で行う。旧版を書き換えず、以後の変更で影響する試験・ゲートは再判定する（docs/13 §3 手順1）。

## 5. 開始後の観察

- 監視と障害時の対応は docs/07（セキュリティ・運用設計）と ops 手順どおりに行う: 費用は ops/cost-alerts.md（月次の費用・AI回数・Maps割当の確認）、障害は docs/07 §7 と ops/outage-runbook.md、セキュリティ事象は ops/security-response.md、管理者の交代は ops/admin-handover.md。
- 性能・UXの実測（D18で決めた合格値）を定期的に取り直し、閾値を超えたら docs/07 と ops 手順に従って対応する（docs/13 §3 手順5。障害時縮退設計があることは未実装での開始を意味しない）。

## 6. やってはいけないこと

- 判定の前に本手順を実行すること・§0の停止条件を外したり緩めたりすること（docs/evidence/release-decision.md §1）
- Secret・招待リンク・tokenをGit・チャット・メール本文に貼ること（ops/deploy.md §0）
- 実データ（実名簿・実出動・非公開水利・現場写真）を架空データの環境（local/demo/e2e）へ入れること・Gitに載せること（AGENTS.md・ops/demo-deploy.md §1）
- 開発完成（架空データ・ローカル）を「正式運用開始」「正式リリース」と呼ぶこと（docs/evidence/development-completion.md §5）
- 回答空欄・approved:false の項目を残したままproductionへ配置すること・未実施の手順を合格に数えること（docs/13 §2）
- 正式開始の記録（§4）より先に実データを投入すること（復旧点と承認の記録が投入より先）
