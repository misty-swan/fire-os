# V04 Jev実API・型検証・質問版・分類候補（T053局所／実Workers AIは未実施）

方式: **サーバー固定の質問版＋Jev応答の全量検証＋保留（manual_review）への確実な落ち先**（docs/06 §2/§3、docs/14 D12、docs/11 永続ジョブ）。実装は `src/server/ai/questions.ts`（質問版 v1）、`src/server/ai/jev.ts`（classifyInspection・validateJevOutput・複数異常フラグ）、`src/server/jobs/handlers/classification.ts`（ai.classify job）、`src/server/routes/ai-classification.ts`（API-29/30）。

## 実施したこと（ローカルworkerd＋ローカルD1。env.AIは試験内で注入したfake）

| 確認 | 結果 | 試験 |
|---|---|---|
| 固定質問（docs/06 §2のchoice+noul）をそのまま送る（クライアントは質問を作れない。未知の質問版は400） | 合格 | `jev_noul_value_is_not_a_confidence_field`／`classification_requests_are_validated_before_a_job_is_created` |
| noul（0〜1の保留度）はそのままneedsReviewへ保存する。boolean・範囲外は拒否。**choiceのconfidence（高く偽装した0.99）を保留判定に使わない** | 合格 | 同上（noulNeedsReview=0.9、inventedConfidenceFieldUsed=false） |
| 未知キー（answers/トップレベル）・欠落・空出力・非オブジェクト・許可外カテゴリ・裸score（尺度legend無し）は候補にせずjob=manual_review ai_output_invalid。候補行は残さない | 合格 | `invalid_outputs_go_to_manual_review_and_keep_no_candidate`（10種の出力形） |
| 複数異常はprobabilitiesからフラグ化し、代表分類に隠さない（代表とフラグは分離） | 合格 | `multiple_anomaly_probabilities_are_flagged_and_the_representative_is_kept` |
| 実行時の送信条件の再検査: 元版が変わったらstale source_changed／依頼者が権限を失ったらstale requester_unauthorized | 合格 | `source_version_change_or_requester_permission_loss_becomes_stale` |
| env.AIが無い環境（local）はmanual_review ai_unavailable（偽の候補を作らない。src/server/env.tsの契約） | 合格 | `without_the_ai_binding_the_job_lands_in_manual_review` |
| 同一元版＋質問版の依頼は1本のjobにdedupe。元版が進んだ後の再依頼は別job | 合格 | `same_source_version_and_question_share_one_job` |
| inputは最小化（点検のnote＋項目コード/結果、異常はtitle+description。氏名・実行者IDを送らない）でinput_hash＋参照版（`d1:<種別>:<id>@<版>`）を記録 | 合格 | `jev_noul_value_is_not_a_confidence_field` |
| usage（prompt/completion tokens）をai_evaluations.usage_jsonへ保存。実モデル版をactual_model_versionへ保存 | 合格 | 同上 |
| AIだけでは設備・資産・異常の状態を一切変更しない（automaticFacilityStateChanges=0。docs/06 §1） | 合格 | 同上（実行前後のfacilities/vehicles/equipment行の比較） |
| 候補の一覧（API-30）は厳密DTO・status/sourceTypeフィルタ・作成降順keyset・改変cursor 409・PER-10外は403・別分団0件・氏名を複製しない | 合格 | `ai_reviews_lists_pending_candidates_with_filters_and_keyset` |

fakeはJevの戻り値形（`{model, answers:{category:{choice,probabilities,confidence}, needs_check:{noul}}, usage}`）を模倣した記録型で、`runDueJobs({...env, AI: fake})` で注入した。**fakeでの合格は実AIでの合格を意味しない。**

## Jev契約の転記（実呼出し前に確定させた検証項目の一覧。docs/06 §2どおり）

- **経路**: `env.AI.run("typesafe/jev", { state, questions })`。チャットmessages専用モデルとは異なる。
- **要求**: `state`＝最小化input（T053実装: 点検のnote＋項目コード/結果、異常はtitle+description。氏名・連絡先を含めない＝docs/14 D12）。`questions`＝サーバー固定（`src/server/ai/questions.ts`、版`v1`。docs/06 §2のcriteriaの文面そのもの）。
- **応答**: `model`（実モデル版。T053はactual_model_versionへ保存）／`answers`（category=choice: `equipment_issue`/`access_obstruction`/`missing_equipment`/`no_issue`/`other`＋probabilities/confidence（任意）、needs_check=noul: **0〜1の数値でbooleanでも別confidence付きでもない**）／`usage`（prompt_tokens/completion_tokens）。
- **検証項目（validateJevOutput。すべて満たさない候補は作らない）**: ①トップレベルキー⊆{answers, model, usage}かつanswers必須 ②answersのキーは{category, needs_check}ちょうど（未知キー・欠落は拒否） ③choiceは許可カテゴリのみ ④probabilities/confidenceは任意だが形が悪ければ拒否（値は0〜1。confidenceは**検証だけして判定に使わない**） ⑤noulは0〜1の数値ちょうど1キー ⑥usageは非負整数の対 ⑦応答の正規化JSONサイズ≤100,000バイト ⑧入力（state）≤100,000バイト（過大はinput_too_largeで保留）。
- **保留の落ち先**: 壊れ出力・未知型・入力上限→job=manual_review（ai_output_invalid/input_too_large）。呼出し自体の失敗（通信・レート）→retryable（ai_run_failed、上限3回でmanual_review）。binding無し→manual_review（ai_unavailable）。元版変更・権限喪失→stale。
- **複数異常フラグ**: probabilities≥0.2の異常カテゴリ（equipment_issue/access_obstruction/missing_equipment）が2以上でmultipleIssues=true（レビュー補助表示のためのアプリ側値。docs/06 §6の品質閾値ではなく、V04/D12の評価対象でもない）。
- **送料（docs/06 §2のカタログ値。実測は未実施）**: context 32,000 tokens、入力$0.042/100万tokens・出力$0、third-party/ZDR Yes。質問/選択肢を含む実token量で計算する（usage実測後にここへ記入する）。

## 未実施（検証済みとして扱わない）

**実Workers AI（typesafe/jev）への実呼出しは未実施。** 理由: ①この環境の`wrangler`は未ログインで実Cloudflareに接続できず、ローカルのworkerdには`env.AI`が無い（wrangler.jsoncのlocalはAI bindingを持たない。demo/stagingのみ）、②送信条件（docs/14 D12＝AI送信条件・評価集合・品質閾値）が未了承のため、実データ・実品質評価に進めない。fakeでのスキーマ検証の合格を「実モデルでの動作」とは扱わない。

V04で確定すべき項目と現状:

| 項目 | 現状 |
|---|---|
| 実応答のJSON形（model/answers/usageの実在キー・noulの実際の型） | 未実施。docs/06 §2のJSON例は架空（docs/06自体が「JSON例は架空であり実呼出し未実施」と明記）。実測後にvalidateJevOutputとこの表を確定させる |
| モデル版の固定可否（バージョンピン運用の可否） | 未実施。TypeSafe直APIの版/上限/データ保持をCloudflare経路へ転記しない（docs/06 §2） |
| usage実測と1依頼あたり費用（入力$0.042/100万tokens） | 未実施。実測後に上の「送料」へ記入 |
| 日本語品質（docs/06 §6のsmoke例6件: 「蓋が固い」等）とmacro F1/再現率の評価（最低200例） | 未実施。D12の評価集合（架空/許諾済・最小化本文）の承認後。閾値決定を評価後に都合よく変更しない |
| 入力上限の実測（context 32,000 tokens相当） | 未実施。検証設定の100,000バイトは実測で見直す |

残作業と手順（ユーザーの操作が必要）:

1. D12の提案資料（送信経路/提供先/処理地域/例外/保持/削除/許諾。docs/06 §7）を添えて消防団へ了承を求める（決定者＝管理主体・AIレビュー責任者）。**了承前に実団員の実データを送らない**（架空データの検証は可）。
2. `npx wrangler login` のうえ、AI binding付き環境（demo/staging。wrangler.jsoncの`ai: { binding: "AI" }`）へ配置する。
3. 架空データの点検/異常を作り、API-29で分類を依頼→API-86でjob確認→ai_evaluationsの候補と実測usageを確認する（手順の詳細は tests/live/jev.test.ts のコメント。`LIVE_BASE_URL`/`LIVE_BOOTSTRAP_EMAIL`/`LIVE_BOOTSTRAP_TOKEN`を設定して `npm run test:live -- tests/live/jev.test.ts`）。
4. 壊れ出力・曖昧（noul高位）・範囲外の実応答がmanual_reviewになることを確認し、実測をこの文書へ追記する。
5. docs/06 §6の評価集合（smoke例6件→最低200例）で品質を測り、D12の閾値決定の材料としてai_evaluation_runs（API-88/89。**T061で機構実装済み**。記録手順はdocs/evidence/ai-evaluation.md）へ記録する。

この手順を実行するまで、V04は **局所のみ検証済み・実AIは未検証**。RG-06/10は引き続き阻止される。AI-01/02（SCR-18の分類候補）を「完成」とは扱わず、採用判定は品質ゲート（docs/06 §6）の合格後とする。
