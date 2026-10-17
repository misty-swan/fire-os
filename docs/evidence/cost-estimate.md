# 費用の試算（SKU別単価・無料枠・有料最低費・通知費）— T080

目的: docs/14 D11（費用負担・上限・公開デモ量。**未承認**）の推奨案を開発用の検証設定（`config/budget-development.json`）として固定するにあたり、SKU別の単価・無料枠・有料の最低費・通知費を再確認して試算を記録する。**金額は実団体の承認済みではない**。単価の正本は docs/07 §8（出典つき）。試算日: 2026-10-17。

**正直な限界**: この開発環境は実Cloudflareに未接続のため、**実使用量の実測と実請求との照合は未実施**。下の表は公開価格ページに基づく机上の試算であり、実測ではない。実接続後は ops/cost-alerts.md §4/§5 の手順で照合し、この節を実測で更新する。

## 1. SKU別の単価・無料枠・有料最低費（公開価格からの再確認）

| SKU | 単価（公開価格。試算日現在） | 無料枠 | 有料の最低費 | 出典 |
|---|---|---|---|---|
| Workers（標準） | $0.30/100万リクエスト＋CPU $0.02/100万ms | Free: 10万リクエスト/日 | Workers Paid **$5/月**（基本料。含まれる使用量つき） | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| D1 | 読み取り$0.001/100万行・書き込み$1.00/100万行 | Free: 500万行読み/日・10万行書き/日 | Paid（Workers Paid込み。 billed分は上記の無料枠を超えた分） | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| R2 Standard | 保存$0.015/GB-月、操作$4.50/100万回（Class A）/ $0.36/100万回（Class B）。egress $0 | Free: 10GB-月 | Workers Paid込み（R2単独の最低課金なし。超過分のみ） | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Workers AI | モデル別。Jev（入力）$0.042/100万tokens（docs/06 §2の検証設定。**実請求の実測はV04で未実施**） | Neuronsの月割当（プランによる。実測未確認） | Workers Paid込み | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Google Maps（Dynamic Maps） | $7/1,000ロード（月10,000まで無料） | 10,000ロード/月 | 実接続はV05（**未実施**。docs/14 D22）。請求アカウント必須 | [Maps pricing](https://developers.google.com/maps/billing-and-pricing/pricing) |
| Queues | $0.40/100万操作（標準キュー） | Paidのみ（$5に含む。月の無料操作枠の記載なし。実請求で確認） | Workers Paid込み | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) |
| 通知（email / Web Push） | emailは配送サービス（未選定）。Web Pushはサーバー費用のみで端末へは無料（サービスワーカー経由） | — | **未選定**（docs/14 D13。固定額を捏造しない） | D13で判断 |

税・為替・ドメイン・メール送信ドメイン・外部バックアップ保管は別費用。価格は公開ページの試算日時点の値で、変更がありうる（月次照合時に更新する）。

## 2. 代表使用量での月額試算（docs/07 §8と同じ前提。数量は試算）

| サービス | 前提数量 | 試算 | 根拠 |
|---|---|---|---|
| Workers | 50,000リクエスト/月、平均CPU 20ms（＝100万ms/月） | $5（Paid基本料内。CPU課金は基本料に含まれる範囲） | docs/07 §8。FreeのCPU 10ms/呼出しに認証が収まることは未実証 |
| D1 | 200万行読み/月・1万行書き/月、DB 50MB | 日次枠内なら $0（Paid込み） | 走査・backup・migration・demo分も計測対象（ops/cost-alerts.md §4） |
| R2 | 写真120枚×2MB/月＝0.24GB増、年2.88GB | 無料枠内なら $0（10GB-月まで） | 複製・旧版・保持・検査のコストは別（D10） |
| Maps | 本番30人×10ロード＋demo 2,000＝2,300ロード/月 | $0（10,000まで無料）。20,000ロードなら $70 | 実接続前。Street View等は別SKU |
| AI（Jev） | 1,000件×1,000入力tokens＝100万tokens/月 | $0.042（入力のみ。出力$0。LLMの単価はdocs/14 D16で未固定のため含めない） | docs/06 §2（検証設定）。実測はV04 |
| Queues | queue操作 通常3/job×ジョブ数 | 試算のオーダーでは $0〜（$5に含む範囲） | docs/07 §8 |
| 通知 | inapp（アプリ内）は追加費用0。email/PushはD13未了承 | $0（現状。実チャネルは未実施＝docs/evidence/V06-delivery.md） | docs/14 D13 |

合計見込み: **Workers Paid $5/月を基本とすれば、代表使用量の範囲では追加費はほぼ0**（AI・D1・R2が枠内の間）。これが D11 推奨案「Workers Paid $5基本を許容し実測＋月額/急増通知」の根拠。**$0運用を保証しない**（FreeのCPU制約・急増・実モデルの単価は実測でしか確定しない）。

## 3. 開発設定（config/budget-development.json）の値の根拠

| 項目 | 値 | 根拠 |
|---|---|---|
| monthlyLimitUsd | 5 | D11推奨案のWorkers Paid基本料。代表使用量（§2）の合計見込みと一致 |
| dailyAiCallCap | 500 | docs/07 §8のAI例（1,000件/月≈33件/日）に対する余裕（約15倍）。急増の停止線として |
| dailyNotificationCap | 2,000 | inapp配送は費用ほぼ0だが、濫用（demo攻撃）の検出線として1日約60,000通/月相当で止める |
| maxRateLimitedPerDay | 10 | providerの応答制限（429）は正常運転ではほぼ出ない想定。10件で予兆停止 |
| spikeFactor / spikeWindowDays / spikeMinCalls | 5倍 / 7日 / 20回 | 直近7日平均の5倍を「急増」とする。1日20回未満の日は判定しない（立ち上げ期の誤検知回避） |
| prices（AI入力/出力） | $0.042 / $0（100万tokensあたり） | docs/06 §2のJev定価（検証設定）。LLMは単価未固定（docs/14 D16）のため試算に含めない＝下限試算 |

しきい値を変更するときは config の `version` を進め、理由を ops/cost-alerts.md §1 に残す（評価後に都合よく変えない）。

## 4. 実測（未実施 — 実Cloudflare接続後に記録する）

- 実D1/R2/Workers/AI/Mapsの月次使用量と請求額: **未実施**（ops/cost-alerts.md §4の手順）。
- 実環境での停止・復帰の演習: **未実施**（ops/cost-alerts.md §5-2）。
- 実モデル（Workers AI）の単価・応答形: **未実施**（docs/evidence/V04-llm.md / V04-jev.md。D12の了承後）。
- email/Web Pushの配送費: **未選定**（docs/14 D13。固定額を捏造しない）。

ローカルで実施済みなのは: workers試験（tests/budget.test.ts）による記録・評価・停止・解除・監査経路の検証のみ。使用量の記録はjob再実行時に呼出し分が重複計上され得る近似であり、実測照合時にはその偏差も確かめる。
