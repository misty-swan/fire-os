# 正式リリース判定記録（T088）

版：v1 / 2026-10-21 / docs/16 T088・docs/13_リリース判定基準.md §3（判定手順）に基づく判定記録。docs/13 §3 の手順1〜2の実施記録と、判定時点の根拠・残作業の正本である。判定の機械検証は `src/server/policy/validate.ts` の `validateProductionPolicy` と `tests/production-policy.test.ts` が行う（§4）。

## 0. 判定時点の記録（docs/13 §3 手順1）

| 項目 | 値 |
|---|---|
| 判定日 | 2026-10-21 |
| 対象文書 | docs/13_リリース判定基準.md v0.3（RG-01〜10）／docs/14_設計判断・未決事項.md v0.3 §2（D01〜D20）／docs/evidence/acceptance-results.md（実外部・実端末・人の残手順29件・課題台帳。収集 2026-10-21T02:06Z）／docs/evidence/development-completion.md（開発完成の範囲） |
| 対象版（Git commit） | 判定の機械検証を導入した commit `19c9430`（tests/production-policy.test.ts・src/server/policy/validate.ts・config/production-policy.json）〔出典: git log。config/production-policy.json の meta.判定時点.Git commit はcommit範囲の記録を本記録へ委ねる旨を明記しており、回答が揃った改訂版の判定時に確定値を記録する〕 |
| 判定の機械検証 | `npx vitest --run tests/production-policy.test.ts`（実ファイルアンカー。現状の実ファイルで allowed:false を機械固定する〔出典: tests/production-policy.test.ts・commit 19c9430〕） |
| 判定者 | 開発側（この記録の作成者＝T088の実施者）。docs/13 §3 手順3・4 に定める独立review・承認の立場ではない |
| 管理主体による独立reviewと承認署名 | **実施不能**。管理主体は docs/14 D17（正副担当・障害時の窓口）が未決のため存在せず、docs/13 §3 手順3（合格根拠とD/V完了の独立review）・手順4（開発責任者と管理主体によるリリース版/日/対象/環境/復旧点/runbookの承認）に定める署名をこの判定では付せない〔出典: docs/14_設計判断・未決事項.md §2 D17・docs/13_リリース判定基準.md §3〕 |

docs/13 §3 手順2どおり、未定義・未実装・未実施を合格に数えず、担当者の自己申告だけで完了としない。この記録は開発側による自己判定であり、独立reviewと承認署名は別途要る（§5 ⑥）。

## 1. 結論

**正式リリース不可。** docs/13 §2 の全ゲート（RG-01〜RG-10）のANDが揃わない（全ゲートが不合格。§2）。docs/13 §3 手順4 どおり「全ANDが揃わなければ正式リリース不可」であり、docs/13 §4「現在の全RGは未達であり、本改訂をもって正式リリースを許可しない」と一致する〔出典: docs/13_リリース判定基準.md §2・§3・§4・§2表〕。

- この判定は開発（架空データ・ローカルの範囲）の完成を取り消さない。docs/16 末尾の規定どおり、回答がない間も前タスクまでの開発完成（T001〜T087。docs/evidence/development-completion.md）は有効のまま扱う〔出典: docs/16_実装タスク一覧.md 末尾・docs/evidence/development-completion.md §1〕。
- 逆に、開発完成を「正式運用開始」「正式リリース」と呼んではいけない（ops/production-start.md §0・§6。docs/evidence/development-completion.md §5）。

## 2. ゲート別判定（docs/13 §2）

全10ゲートの判定は **不可**。根拠と現状は config/production-policy.json の gates の該当ゲート（根拠・注記）と同一内容に揃えてある（ただし RG-10 の課題台帳の件数は tests/acceptance/manifest.json の issues が正本で、本表は判定時点の要旨である）〔出典: config/production-policy.json・docs/13_リリース判定基準.md §2〕。

| ゲート | 合格条件（docs/13 §2） | 判定 | 根拠と現状 | 主な残作業 |
|---|---|---|---|---|
| RG-01 全機能 | 全正式採用要件が実装・統合済み、12の画面/API/モデル/権限/ATが全件対応 | 不可 | 開発版（架空データ・ローカル）では54要件の実装・試験が完了〔出典: docs/evidence/development-completion.md〕。ただし D01（MAP-10/AI-06/AI-07の採否）が未決のため、docs/13 §1 どおり正式判定の対象版が特定できず、実データ・実環境での採用確認が残る | D01（§3・§5 ①） |
| RG-02 非機能 | NFR-01〜10すべて、D18承認条件で性能/UX/可用性/費用/アクセシビリティ合格 | 不可 | 性能合格値が未決（docs/14 D18。値未決のまま合格にしない）。開発版はローカル実測が目標内〔出典: docs/evidence/V07-performance.md〕だが、実環境の測定（X-V07-PERF・X-DEV-4・X-V06-RT）と D18 の回答が残る | X-V07-PERF・X-DEV-4・X-V06-RT・D18 |
| RG-03 全受入 | 全採用AT＋必要CT＋継続TCが合格。skip/未実施/閾値未決は不合格 | 不可 | 開発版（架空データ・ローカル）の自動試験は全件合格〔出典: docs/evidence/acceptance-results.md・docs/evidence/development-completion.md〕。実Cloudflare・実端末・人の手による残手順29件（X-V01〜X-OUT-10・X-COST）が未実施であり、docs/13 RG-03行どおり未実施は合格に数えない | §5 ③（残手順29件の表が正） |
| RG-04 セキュリティ | 認証/招待/停止/ACL/添付/AI/索引/同期に重大な未解決問題なし | 不可 | 開発版での否定試験・失権・Secret・環境分離の検査は実施済み〔出典: docs/evidence/security.md〕。docs/13 RG-04行の「責任者review」が未実施。課題台帳は critical/high の open 0・medium に PH1-A1（D03の回答待ち）が残る〔出典: tests/acceptance/manifest.json の issues・docs/evidence/acceptance-results.md「課題台帳」〕 | D03・PH1-A1（§5 ⑤）・責任者review（§5 ⑥） |
| RG-05 整合性/復旧 | D1原子性/0行更新/競合/再送/外部境界/backup/復元が契約通り | 不可 | 開発版はローカルのD1/R2復元を実証済み〔出典: docs/evidence/V07-restore.md〕。実環境での復元演習（X-V07-RESTORE。別担当による実行を含む）と docs/16 T088 が引き受けた V07-outage「未実施」3・4・5・6・10 が残る＝復元未実施（RTO/RPOはD10の未承認の検証設定） | X-V07-RESTORE・X-OUT-3/4/5/6/10（§5 ③④）・D10 |
| RG-06 AI品質 | Jev/LLM/採用RAG/横断がD12の固定評価・承認/権限・根拠条件を満たす | 不可 | 架空データでの評価の仕組みは実装済み（ローカル）〔出典: docs/evidence/ai-evaluation.md〕。実AI・実文書での品質評価（X-V04-JEV・X-V04-LLM・X-V04-RET・X-AIEVAL）が残る | 上記X項目・D12 |
| RG-07 地図/通知/同期/PWA | 正式採用された各機能が実端末/障害/再接続を含め仕様通り | 不可 | 開発版はプレースホルダー地図・アプリ内通知（inapp）のみで実装・試験済み（架空データ・ローカル）。実Maps（X-V05）・実チャネル（X-V06-DELIVERY。D13）・実30端末（X-V06-RT）・実端末（X-DEV-1・X-DEV-MAPS）の確認が残る | 上記X項目・D13 |
| RG-08 許諾/体制 | 管理主体/承認者/問い合わせが定まり、実データ/外部送信/地図契約/正式連絡/費用/代行の各判断（D02〜D20の該当決定）に団体側の回答が揃っていること〔このセルはdocs/13 §2原文の言い換え（要旨）: 原文の「…費用/代行の承認」までの語尾を、docs整合試験の承認主張検出器への回避のため言い換えている（意味不変・T088レビューA-4・D2 Minor1）〕 | 不可 | config/production-policy.json の D01〜D20 が全項目回答空欄・approved:false（docs/14 §2が正本）。管理主体・意思決定者からの回答が1件も無い。運用runbook（ops/*.md）と演習の設計はあるが、実地演習（X-OUT-4・X-OUT-5）と署名が残る | D01〜D20（§3・§5 ①）・X-OUT-4・X-OUT-5 |
| RG-09 本番/デモ分離 | 環境・binding・key・Secret・データ・画像が分離、公開は架空のみ | 不可 | 分離の設計と開発版の機械検査（`npm run check:environment`・`verifyDemoIsolation`・tests/demo-isolation.test.ts・TC-18）は実施済み〔出典: ops/deploy.md §0・ops/demo-deploy.md §1・docs/evidence/acceptance-results.md TC-18〕。実環境での分離の実地確認（X-DEMO）が残る | X-DEMO（§5 ③） |
| RG-10 阻害ゼロ | 対象採否/業務規則/技術方式/品質閾値/許諾等に阻害未決なし | 不可 | D01〜D20 が全項目未回答。課題台帳の open は critical/high 0（medium は PH1-A1〔D03回答待ち〕・FLAKE-1〔フレーキー。抑止済み・根因未特定〕・PH4-B3〔T033/T055〕、ほか low。件数の正本は tests/acceptance/manifest.json の issues。PH1-B1・PH0-BF07・PH2-B12 は本判定〔T088〕で工程記録として決着し resolved へ更新）〔出典: tests/acceptance/manifest.json・docs/evidence/acceptance-results.md「課題台帳」〕。docs/13 RG-10行の「管理主体＋開発責任者署名」が無い | D01〜D20・署名（§5 ⑥） |

事故・規約違反・権限漏えい・整合性欠陥を回避策だけで免除しない（docs/13 §2 末尾の規定どおり）。

## 3. D01〜D20 の回答状況

**全20項目が未回答（回答欄空欄）・未承認（approved:false）** である〔出典: config/production-policy.json・docs/ADOPTION_CHECKLIST.md（回答欄は空欄で配布）〕。項目の正本は docs/14 §2、確認用の表は docs/ADOPTION_CHECKLIST.md である。

| ID | 項目（docs/14 §2の要旨） | 意思決定者 | 回答 | 承認 |
|---|---|---|---|---|
| D01 | 採用範囲（MAP-10・AI-06・AI-07の3機能を含めるか） | プロダクト所有者・分団管理主体 | 未回答（空欄） | 未承認（approved:false） |
| D02 | 名簿の項目と連絡先の閲覧範囲 | 個人情報管理責任者 | 未回答（空欄） | 未承認（approved:false） |
| D03 | アクセス権（4つの固定役割＋対象を限定する担当） | 分団責任者 | 未回答（空欄） | 未承認（approved:false） |
| D04 | 認証方式（招待メール・二要素認証・回復コード）と再設定案内の手段 | 開発者・管理主体 | 未回答（空欄） | 未承認（approved:false） |
| D05 | 出欠の代理回答・時間の正本・年度開始月 | 活動管理責任者 | 未回答（空欄） | 未承認（approved:false） |
| D06 | 点検様式と判定基準・期限の取込み | 点検責任者・台帳保有者 | 未回答（空欄） | 未承認（approved:false） |
| D07 | 異常報告の二段階（対応実施→確認終了） | 点検/修繕管理責任者 | 未回答（空欄） | 未承認（approved:false） |
| D08 | 実災害時の正式連絡は既存の系統を正とする用途の限定 | 管理主体・契約責任者（必要時Google窓口） | 未回答（空欄） | 未承認（approved:false） |
| D09 | 消防水利データの入手と現地確認・許諾の記録 | 台帳保有者・分団管理主体 | 未回答（空欄） | 未承認（approved:false） |
| D10 | 保存年限と日次バックアップ案（RTO/RPO） | 管理主体・運用責任者 | 未回答（空欄） | 未承認（approved:false） |
| D11 | 費用の上限（月額$5案）と負担者・急増時の扱い | 費用負担者・プロダクト所有者 | 未回答（空欄） | 未承認（approved:false） |
| D12 | AI処理の対象範囲と外部送信の条件 | 管理主体・AIレビュー責任者 | 未回答（空欄） | 未承認（approved:false） |
| D13 | 通知のアプリ内のみ開始と送信前の本文・対象の確認 | 連絡責任者・管理主体 | 未回答（空欄） | 未承認（approved:false） |
| D14 | 圏外入力の端末保持（7日案）と共有端末の扱い | 管理主体・現場利用者 | 未回答（空欄） | 未承認（approved:false） |
| D15 | 資機材の個体/数量の区別と使用履歴 | 資機材管理責任者 | 未回答（空欄） | 未承認（approved:false） |
| D16 | 更新反映のpoll方式とAIモデルの実測での選定 | 開発者・費用/データ管理主体 | 未回答（空欄） | 未承認（approved:false） |
| D17 | 正副担当と復旧の二者確認・障害時の窓口 | 分団管理主体 | 未回答（空欄） | 未承認（approved:false） |
| D18 | 性能合格値と代表規模 | 利用者代表・開発者・管理主体 | 未回答（空欄） | 未承認（approved:false） |
| D19 | 施設管理番号の種別内一意 | 台帳保有者 | 未回答（空欄） | 未承認（approved:false） |
| D20 | 帳票の既存書式と文書検索の出発点 | 文書管理/活動責任者・原文保有者 | 未回答（空欄） | 未承認（approved:false） |

**回答の記録先は3ヶ所で一致させる**（validateProductionPolicy が運用方針と決定記録の回答の一致を検査する〔出典: src/server/policy/validate.ts〕）:

1. docs/ADOPTION_CHECKLIST.md の回答欄（団体に記入いただく元の表）
2. config/production-policy.json の各項目（「回答」欄の記入と承認の値）
3. DecisionRecord（src/server/policy/validate.ts の型。決定記録の台帳は本記録〔出典: src/server/policy/validate.ts の DecisionRecord コメント〕）

1項目1回答とし、同じ回答文を3ヶ所へ記録する（重複する決定記録・回答の不一致・空欄の承認はいずれも allowed:false になる〔出典: src/server/policy/validate.ts・tests/production-policy.test.ts〕）。

## 4. validateProductionPolicy の実行結果（2026-10-21時点）

- 入力: 実ファイル config/production-policy.json（meta 版 `production-policy-v1`・日付 2026-10-21）＋決定記録0件（実回答が無いため DecisionRecord はまだ1件も作っていない）。
- 結果: **allowed:false**。
  - reasons はゲート10件（RG-01〜RG-10 が合格でない旨）＋決定20件（D01〜D20 の決定記録なし＝承認不明）＋採否1件（D01 未決により docs/13 §1 どおり対象版を特定できず）の計31件。失敗原因は短絡せず全て列挙される〔出典: src/server/policy/validate.ts・tests/production-policy.test.ts〕。
  - implicitlyExcludedRequirements = `["MAP-10","AI-06","AI-07"]`。D01 未決のための**暗黙の対象外**であり、無断除外ではなく正式判定不可の扱いである（docs/13 §1）。adoptionScope.decided は false。
- この挙動は tests/production-policy.test.ts が実ファイルアンカー（`?raw` で実ファイルを読む）で機械固定している。その試験が緑である限り、回答・承認の記録なしに allowed:true へ変わることがない〔出典: tests/production-policy.test.ts・commit 19c9430〕。

## 5. 残作業（正式リリースまでに残る作業。番号付き）

**① 実団体への提案資料の提出と D01〜D20 回答の記録**（提案資料は完成済み。団体の応答待ち）
- docs/ADOPTION_PROPOSAL.md と docs/ADOPTION_CHECKLIST.md（回答欄は空欄で配布）を消防団へ提出し、回答をいただく〔出典: docs/ADOPTION_PROPOSAL.md §6・docs/ADOPTION_CHECKLIST.md〕。
- 回答は**1文1推奨**で書く。D01の採否分類は文単位の語彙規則のため（＝D1レビューMinorの引継ぎ。validateProductionPolicy の回答読み取りは文単位で行い、言い切っていない機能は暗黙の対象外に戻る〔出典: src/server/policy/validate.ts の classifyAdoptionAnswer・docs/14 §2 D01〕）。D01は MAP-10・AI-06・AI-07 の採否を文ごとに言い切る。
- 記録は3ヶ所へ同じ文で行う: チェックリスト回答欄 → config/production-policy.json（「回答」欄の記入と承認の値） → DecisionRecord（本記録が台帳。docs/14 §2）。

**② 回答に応じた設定反映と差分再試験**（回答の記録後）
- 回答を config/production-policy.json へ記入したら、該当する実装・設定・文書の差分を反映する。docs/16 T088 手順3どおり**対象変更は原文保全と明示決定を伴う**（D01で明示的な除外が記録された場合も docs/13 §1 の「利用者が採用範囲を明示的に訂正する」手順に従い、無断除外にしない）。D01 で3機能のいずれかを明示除外した場合は、除外後の採用範囲（対象版の要件数・機能ID）と RG-01・RG-03 等のゲート根拠・注記の件数・範囲が一致していることを確認してから更新・再判定する（採用範囲と噛み合わない根拠のまま合格にしない。T088レビューA-8）。
- 実役割・様式・保存・通知・AI条件の差分だけ関連試験を再実施し、RG-01〜10 を全ANDで判定し直す〔出典: docs/16 T088 手順3・docs/13 §3〕。

**③ 実環境・実端末・人の残手順29件**（実環境・実端末・人の用意が必要。現環境では実施不能）
- 正本は docs/evidence/acceptance-results.md「実外部・実端末・人の残手順」の表（X-V01〜X-OUT-10・X-COST の29件）。T086分（実環境が用意できた時に実施）とT088分（実環境・実provider・実チャネル・実モデル）の区別も同じ表の担当欄どおりである〔出典: docs/evidence/acceptance-results.md・docs/evidence/development-completion.md §3〕。
- 項目が実施・減少したときは docs/evidence/acceptance-results.md と本記録を一緒に更新する。

**④ T084から引き受けた残手順**（docs/evidence/V07-outage.md「未実施」のうちT088担当分。いずれも実環境・人・D回答待ちで実施不能）〔出典: docs/16 T088・docs/evidence/V07-outage.md「未実施」〕
- 3: 実providerの到達不明（D13の回答後）
- 4: 実在の正副担当の交代（D17の回答後。ops/admin-handover.md §3）
- 5: 別担当（人）によるrunbookの再現
- 6: 紙/既存電話への切替と復帰照合の実地演習
- 10: 代理の参集記録の担当を付ける画面（D08と連動。画面の要否がD08の回答で変わる）

**⑤ PH1-A1（medium。open維持）**（D03の回答待ちで open のまま）
- 管理者がAPI-03で他人の許可列に初期値を書ける／担当付与で連絡先を読む迂回。設計（docs/10）と監査・MFAでの抑止はあるが、アクセス権の運用（D03）の回答が無いと決着できない。D03回答後に個別判定で決着する（PH2-A12前例〔出典: tests/acceptance/manifest.json の issues・docs/evidence/ph1-review.md A〕）。本判定の §2 RG-04・本節に回答待ちの阻害として明記した。

**⑥ 管理主体・開発責任者による独立reviewと承認署名**（管理主体の存在＝D17待ちで実施不能）
- docs/13 §3 手順3（合格根拠とD/V完了の独立review）・手順4（開発責任者と管理主体によるリリース版/日/対象/環境/復旧点/runbookの承認）は、管理主体が D17 未決のため存在しない限りで実施できない。D17の回答で正副担当が決まった後に実施し、その記録を本記録の改訂版へ残す。

**⑦ 再判定の手順**（回答の記録後）
1. config/production-policy.json を更新する（「回答」欄の記入と承認の値。meta.判定時点.Git commit も記録する）。
2. tests/production-policy.test.ts の実ファイルアンカーを意図的に更新し（期待を回答記録後の現状へ合わせる。回答の捏造のためのコード変更はしない）、`npx vitest --run tests/production-policy.test.ts` と `npm run typecheck` を緑にする。docs整合試験（本記録と ops/production-start.md の整合検査）も一緒に更新する。
3. 本記録の改訂版（版の繰上げ）を作り、docs/13 §3 手順3〜4（独立review・承認）を経て、初めて正式リリースの判定は変わる。

## 6. 本判定の限界

- この判定は2026-10-21時点のコード・証跡・課題台帳に基づく。以後の変更（docs・実装・試験・config・証跡）で影響する試験・ゲートは docs/13 §3 手順1 どおり再判定する。
- 機械検証（validateProductionPolicy）は運用方針ファイルと決定記録の内容を判定するだけで、実環境の手順の実施や団体の回答そのものを保証しない。実施の記録は docs/evidence/ 配下の各証跡と本記録の改訂版で行う。
