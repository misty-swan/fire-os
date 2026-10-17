# 費用アラート・上限停止・解除の手順（T080）

目的: 利用量の監視、上限超過の前兆（急増・429・日次枠・費用試算）の把握、上限超過時の**高価なAI呼び出しの停止**と、その**解除**を、このリポジトリだけで再現可能な手順として定める。正本は docs/07 §8（費用・監視）と docs/14 D11（費用負担・上限・公開デモ量。**未承認**。本書の数値は開発用の検証設定）。対象は docs/01 NFR-08、docs/08 AT-NFR-08、docs/13 RG-01〜10。

**現状の正直な限界（2026-10-17時点）**: この開発環境は実Cloudflareに未接続のため、**実計測（Workers/D1/R2/Mapsの実使用量）と実請求との照合は未実施**、実環境での**停止・復帰の演習も未実施**。実施済みなのは workers試験（tests/budget.test.ts）での停止・解除・記録経路の検証と、ローカル（wrangler dev / `npm run demo`）での動作だけ。実接続後は §5 の手順で未実施を解消する。

## 0. 設計（何が止まり、何が止まらないか）

| 項目 | 内容 | 実装 |
|---|---|---|
| 使用量の記録 | D1（`usage_metrics`。Workers/D1/R2/AI/Maps/通知を別計上）。unknown（計測できない使用量）はNULLで記録し0と偽装しない | `src/server/observability/metrics.ts`（recordMetric）、drizzle/0032 |
| しきい値 | 開発設定 `config/budget-development.json`（版・日付・**未承認**であることの明記つき） | `src/shared/budget-policy.ts`（サーバーと管理画面の両方で同じ値） |
| 評価 | 純関数。日次枠/通知枠/429/費用試算の超過で `stopped`、急増で `warn` | `src/server/observability/budget.ts`（evaluateBudget） |
| 停止の効き目 | **AI分類（API-29）と報告書下書き生成（API-32）が「保留（budget_stopped）」になる**。既存記録の閲覧・読み取り・他の業務更新は止まらない | `src/server/jobs/handlers/classification.ts` / `report.ts` の expensiveCallGate |
| 停止の状態 | D1単一行 `budget_state`（status normal/warn/stopped、source auto/manual）。履歴の正本は監査（`audit_logs` の entity_type='budget'） | 同上（applyBudgetDecision。状態＋監査を1つのD1 batchで確定） |
| 解除 | **手順（本書§3）のみ**。手動停止（source=manual）は評価が正常でも自動解除しない。自動停止（source=auto）は使用量が枠内に戻る評価（日次枠なら翌日）で自然解除する | 同上 |
| アラート | **自動送信は作らない**。監査への記録＋管理画面の運用パネル＋本書の手順を人が実行する | `src/client/features/admin/OperationsPanel.tsx`（SCR-17に追加） |

**アラートを自動送信しない理由**: システム要件の制約「通知の送信は本文・対象の明示承認を要する」のため、上限超過・急増のアラートを通知API経由で自動送信する実装は作っていない（作れば承認を迂回する経路になる）。代わりに「監査ログへの記録（証跡）＋管理画面への表示（気づける）＋本書の手順（人が動く）」をアラート経路とする。この判断は docs/14 D11 の「実測＋月額/急増通知」のうち「通知」を人の運用で満たす方式であり、実運用で自動化が必要になればD11の了承と一緒に再判断する。

## 1. しきい値（config/budget-development.json。開発設定・未承認）

| しきい値 | 値 | 超えたとき |
|---|---|---|
| 月額の費用上限（試算） | $5（Workers Paid基本料込みのD11推奨案） | 停止 |
| AI呼び出しの1日の枠 | 500回 | 停止 |
| 通知の1日の枠 | 2,000通 | 停止 |
| 応答制限（429）の許容 | 10件/日 | 停止 |
| 急増 | 直近7日の平均の5倍（1日20回未満は判定しない） | 予兆（warn。停止しない） |

- 費用の試算は「記録済みusage×単価固定分のみ」の**下限**（LLM等の単価未固定分は含まない。出典はconfigの `priceSource`。実請求とは照合していない）。
- しきい値を変えるときは: configの `version` を進め、`setAt` を更新し、理由をこのファイルと docs/evidence/cost-estimate.md に残す。**評価後に都合よく変えない**（AI評価の閾値と同じ規律）。

## 2. 日常の見方（週次。5分）

1. 管理画面（SCR-17 /app/admin、管理者・二要素必須）の「運用（費用と障害）」パネルを開く。
   - 「AI利用の費用と失敗」: 記録済みusageのtokens・費用試算・失敗した実行。
   - 「費用・停止の記録」: 停止/解除/予兆の監査（無ければ「まだありません」）。
2. パネルの常時注記どおり、**表示は実請求ではない**。Cloudflareダッシュボード（Workers・D1・R2・Billing）で実使用量を目視し、パネルの試算と桁が揃っているかだけ確かめる（詳細は §5 月次）。
3. 急増・停止の記録があったら: 監査で理由コードを確認（管理画面に日本語で表示。生の値は `SELECT * FROM audit_logs WHERE entity_type = 'budget' ORDER BY occurred_at DESC`）。

コマンドで確認する場合（ローカルの例。実環境は `--env staging --remote --yes-i-know` を付ける）:

```bash
npx wrangler d1 execute DB --local --command "SELECT status, source, reasons_json, updated_at FROM budget_state WHERE id='global'"
npx wrangler d1 execute DB --local --command "SELECT day, service, metric, SUM(amount) AS known, SUM(amount_known = 0) AS unknown_rows FROM usage_metrics WHERE day >= date('now','-7 day') GROUP BY day, service, metric ORDER BY day DESC, service"
```

## 3. 停止したとき（対応の順序）

1. **原因の把握**: パネル・監査の理由コードを見る（例: `daily_ai_calls_over`＝AI呼び出しの日次枠超過）。
2. **利用量の確認**: §2のコマンドで日別の計上を見る。急増の源（公開demoの濫用、異常リトライ等）を突き止める。demoが原因なら demo環境の再作成（`npm run demo:reset`）や対象の無効化を検討する。
3. **放置してよいかの判断**: 停止は高価なAI呼び出しだけに効き、業務の記録・閲覧は止まらない。月内の請求見込み（CloudflareのBilling画面）と相談し、**翌日まで待つ**（日次枠の自動停止は翌日に自然解除される）のが基本。
4. **解除が必要なとき（手動解除。手順）**:
   ```bash
   # 現状確認（status/source/reasonsを記録してから）
   npx wrangler d1 execute DB --env staging --remote --yes-i-know --command "SELECT * FROM budget_state WHERE id='global'"
   # 解除（source='auto'へ戻す。評価が超過判定を出せば直ちに再停止する＝保護。当日の使用量が枠内に
   #  戻っていない解除は無効になることを意味する。短期に上げたい場合は config の引き上げ（§1の規律）を先に）
   npx wrangler d1 execute DB --env staging --remote --yes-i-know --command "UPDATE budget_state SET status='normal', source='auto', reasons_json='[]', updated_by='ops-unstop', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='global'"
   # 監査への記録（解除の証跡。unit_idは実行者の分団を指定）
   npx wrangler d1 execute DB --env staging --remote --yes-i-know --command "INSERT INTO audit_logs (id, unit_id, actor_kind, actor_user_id, action, entity_type, entity_id, mutation_id, occurred_at, metadata_json) VALUES (lower(hex(randomblob(16))), '<実行者のunit_id>', 'system', NULL, 'budget.resume', 'budget', 'budget-dev-v1', lower(hex(randomblob(16))), strftime('%Y-%m-%dT%H:%M:%fZ','now'), json_object('from','stopped','to','normal','source','manual','note','ops-unstop'))"
   ```
5. **解除後の確認**: 管理画面で「費用・停止の記録」に解除が現れること、保留になっていた分類・報告書生成を依頼し直して進むことを確認する（停止中に保留になったjobは終端のため、**同じ元版への再依頼は新しいjobとして受付し直す**。dedupe_keyが同じ既存jobを返す場合は元版の版が進んでから再依頼するか、人が手動で作成する）。
6. **手動停止（事前に止める場合）**: 大量配信やデモの前に先に止めておくときは、上のUPDATEで `status='stopped', source='manual', updated_by='ops-manual-stop'` にする。**手動停止は評価が正常になっても自動解除しない**（解除は必ずこの手順）。

## 4. 月次の照合（実請求との突き合わせ。実施後はこの節を更新する）

1. Cloudflareダッシュボード → Billing で Workers/D1/R2/AI の当月実績を記録する。
2. `usage_metrics` の月計上（§2のコマンドの範囲を `-30 day` に）と突き合わせ、差分の大きいserviceを確認する。
   - アプリ内未計上（Workers/D1/Maps。NULL行で「未計上」と記録している分）はダッシュボード値が正本。
   - 記録は近似（jobの再実行で呼出しの重複計上があり得る。src/server/observability/metrics.tsの注記）。
3. Google Maps（実接続後）と通知チャネル（D13の了承後）の費用は docs/evidence/cost-estimate.md に実測を追記する。
4. 試算と実請求の差が大きいときは config の単価・しきい値を見直し、`version` を進めて docs/14 D11 の実測として記録する。

## 5. 未実施の手順（実Cloudflare接続後）

1. staging（`--env staging --remote --yes-i-know`）で §2/§3 のコマンドが実環境のD1に対して動くことを確認する（ローカル実行済みの同一手順）。
2. 停止→解除の演習を実環境で1回行い、監査・管理画面・保留表示（budget_stopped）の3点を確認して記録する（docs/evidence/cost-estimate.md の「実測」節へ）。
3. 実請求との月次照合（§4）を1か月分行い、しきい値をD11の実測として確定させる。**額は実団体の承認済みとしない**（了承は完成後の提案時）。
