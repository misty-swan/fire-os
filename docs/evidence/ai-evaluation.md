# V04 補助: AI評価の固定holdout（T061）— 実モデル実行前の手順

方式: **固定holdout（人手ラベル＋記録済み出力）の決定的な再計算**（docs/06 §6、docs/14 D12の推奨案「架空/許諾済・最小化本文、事前holdout/閾値固定」）。実装は `src/server/ai/evaluation.ts`（指標・ゲート・保存・job）、`src/server/routes/ai-evaluation.ts`（API-88/89）、`src/client/features/admin/AiEvaluationPanel.tsx`（SCR-17の表示）、`scripts/generate-ai-holdout.ts`（dataset生成）。保存は `ai_evaluation_runs`/`ai_evaluation_cases`（0026。docs/04 §3.4:155の注記どおり統計のみで個人本文は複製しない）。

## 局所完了の範囲（この評価で分かること・分からないこと）

- **分かること（実装済み・試験済み）**: 指標の計算（macro F1/要確認再現率/falseSafe/保留率/p95/tokens/費用/失敗例）、ゲート判定（事前固定閾値）、実行履歴の保存と一覧、失敗例の保存（恣意的除外なし）、未実施・失敗を合格と表示しない構造（DB CHECKとDTO・表示の3段）。
- **分からないこと（=局所完了の核心）**: **実モデル（Workers AI）の出力に対する品質は未測定**。現在の数値は、生成スクリプトが作った架空の記録済み出力（「あるモデルがそう出力した」という系列）の再計算であり、実測ではない。Jevの実呼出し（T053時点で未実施＝docs/evidence/V04-jev.md）、LLMの実呼出し（T057時点で未実施＝docs/evidence/V04-llm.md）が前提のまま。

## dataset（コミット済み。生成は決定的）

- `tests/fixtures/ai/classification-holdout.jsonl`（分類300件）: 5代表クラス×60。誤分類10・**異常→no_issueの見逃し2**・未知usage（usage:null）10・確率未記録（probabilities:null、複数異常フラグを計算できない記録）8・要確認24（うち1件を見逃す＝再現率0.958）。sha256 `67d6e457cd003b840f57dd3ee4e79ed7bbd72b54c8fefb14a2f0b286c22d45a0`。
- `tests/fixtures/ai/report-holdout.jsonl`（報告書50件）: 人数/開始・終了時刻の欠落、本文がサーバー集計と矛盾する人数、指示注入を含む。記録済み出力は検証を通過した「従順なモデル」の記録（捏造を含まない＝合格系の再現。検出が空振りでないことは試験の変異ケース〔捏造1件差し込みでゲートが落ちる〕で担保）。sha256 `6f3260c47de719422cf047f55f409c99f906b67bf89b34fcd5748de43bae0d38`。
- 同一内容の生成TSモジュールを `tests/fixtures/ai/generated-*.ts`（試験が一致を見る）と `src/server/ai/dataset/*.ts`（実行時にimport。srcのサーバーモジュールからtests/を跨ぐimport〔.jsonl直importを含む〕はvitest workers環境でモジュール解決が不安定なため、実行時はsrc内に閉じる）。再生成: `npx tsx scripts/generate-ai-holdout.ts`（固定seed。sha256が変わったら意図として試験の定数とdocs/06 §6の値を更新）。
- 本文はすべて架空（実団員・実在地名・連絡先を含まない＝D12最小化）。datasetの「人手ラベル」はこの生成物のexpectedLabel/expectedNeedsReviewであり、**実データの人手ラベルではない**（D12了承後に実データ版の評価集合を作るときはラベル合意〔担当者二名案〕とtrain/dev/holdout分離を docs/06 §6どおりに行う）。

## 閾値（事前固定。評価後に変更しない）

- `src/server/ai/evaluation.ts` の `QUALITY_GATE_THRESHOLDS`（thresholdVersion=b-plan-2026-10-16）: macro F1>=0.85・要確認再現率>=0.95・異常→no_issue見逃し0（1件でも不合格）・捏造0・未記載補完0。出典はdocs/06 §6のB案・docs/14 D12推奨案。
- `NEEDS_REVIEW_EVAL_THRESHOLD=0.5`（noul→要確認判定の集計用）。**D12未決**の検証設定で、表示はT053どおりnoulそのものを行う。確定はD12/V04。
- 費用の単価: Jevはdocs/06 §2定価（入力$0.042/100万tokens・出力$0。検証設定。usage未知の行は合算から外し既知件数を明示）。LLMは単価未固定（D16/V04）のためcostUsd=null（tokensのみ）。

## 実モデル実行前の手順（未実施。この順で）

1. D12の了承（docs/14 D12。送信経路/提供先/処理地域/例外/保持/削除/許諾）。了承前に実団員の実データを送らない（架空データの検証は可）。
2. `npx wrangler login`＋AI binding付き環境（demo/staging）へ配置（localにはAI bindingが無い。wrangler.jsonc参照）。
3. `npm run test:live -- tests/live/jev.test.ts` と `tests/live/report-generation.test.ts`（LIVE_*環境変数。V04-jev.md/V04-llm.mdの手順）で実呼出し・usage実測・応答形を確定させる。
4. **実モデル出力の記録**: V04の実行で得た出力（最小化input＋実モデルの応答＋usage＋遅延）を、この固定holdoutと同じ行形式（expectedLabel/expectedNeedsReviewは人手ラベルのまま）で新dataset版（例: classification-holdout-v2）として保存する。`evaluateRun`はdataset版を進めるだけで同型評価ができる（記録済み出力の無いモデルは評価せずfailedになる設計）。
5. API-89で評価を実行し、ai_evaluation_runsへ記録。閾値の達成可否をD12の閾値決定の材料とする（**実測を見てから閾値を変えない**。閾値変更はthresholdVersionを進めてdocs/06 §6と一緒に記録）。
6. 恣意的に失敗例を除外しない（失敗例はai_evaluation_casesに保存され、全件数はmetrics.failedCasesで突き合わせできる）。改善後の再評価は「同固定集合＋追加回帰」で行う（docs/16 T061の実装方針どおり）。

## 試験と現在の値（局所）

- `tests/ai-evaluation.test.ts`（5件）: fixtureの語彙・版・再現性（sha256と生成TSモジュールの一致）、指定試験 `quality_gate_fails_on_one_abnormal_to_no_issue_case`（**1件の見逃しでゲートが落ちること**を含む）、未知版の400・非管理者403・記録済み出力の無いモデルのfailed（gate_passed=NULL）、API-88のkeysetとフィルタ、捏造検出の変異ケース。
- 固定holdout上の値（**実モデル品質ではない**）: 分類 macro F1=0.960・要確認再現率=0.958・保留率=0.09・見逃し2件→**不合格**（理由 false_safe_over_0。見逃し0は未達）。報告書 捏造0・未記載補完0・p95=3209ms→合格。Jev費用換算 $0.00566（usage既知290件分。検証設定の単価）。
- 検証コマンドと結果は docs/16 T061の状態欄に記録（workdir /home/misty/Projects/fire-os）。
