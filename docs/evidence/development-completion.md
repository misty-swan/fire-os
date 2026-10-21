# 開発完成の証跡（T086。2026-10-21時点〔レビューwave 1込み〕・実装完了・最終検証待ち）

T001〜T086（docs/16）の実装が揃った時点での「何が完成し、何が残っているか」の正本。**開発完成と正式運用開始は別物**（docs/16末尾の規定どおり）: この文書は架空データ・ローカル検証の範囲の完成を述べるもので、実データの投入・実団体の了承・docs/13の正式リリース判定（RG-01〜10）は含まない。数値はすべて docs/16 の各状態欄・証跡文書の実測を参照する（この文書では再計測しない。実行時点: docs/evidence/ph8.md「T086」の検証表＝2026-10-21）。

## 1. 完成の範囲

- **タスク**: T001〜T086（89タスク: T001〜T088＋枝番T085b。T087〔提案資料〕の資料は2026-10-21に実装済み＝docs/ADOPTION_PROPOSAL.md・docs/ADOPTION_CHECKLIST.md〔回答欄は空欄で配布〕。T088〔正式判定〕は完成後の別タスク）。このうち完了・局所完了の内訳と各タスクの詳細は docs/16 の状態欄が正。
- **受入の網羅（docs/evidence/acceptance-results.md の機械抽出どおり）**: 要件**54** / AT**54** / CT**17**（AT×CTの組220・うちnotApplicable 0） / 継続TC**18** / API**102** / 画面**SCR28** / 横断journey**4**。参照している実テスト272件。※docs/16のT085/T086本文にある「101 API」は陳腐な初期表記で、契約台帳・docs/05・OpenAPIの一致検査（`npm run check:contracts`）が**102 API**を正とする（T085裁定R9と同じ）。
- **実装commitとテスト結果**: 各タスクの実装commitはdocs/16の該当行に記録済み。受入の全AT×CT×TC×journeyへの実テストの対応付けと実行結果は **docs/evidence/acceptance-index.json**（testId/reqIds/commit/codeHash/設計版/実行環境/結果/証跡。収集は `npm run collect:evidence`）と **docs/evidence/acceptance-results.md** が正。ゲート（`acceptance_gate_fails_on_skip_missing_route_or_unexecuted_case`）がindexの新しさ（codeHash）とskip・未実施の無いことを機械的に検査する。
- **画面**: 28画面（SCR-01〜28）すべてがプレースホルダーでなく実装済み（`src/client/routes.tsx` の screenElements。docs/03 が正本）。シェル画面も実装済み（`/app/menu` メニュー・`/app/help` 使い方ガイド〔SHELL-HELP。T086 da22779で実装。docs/03 §1.1-28〕）。

## 2. 証跡への参照（docs/evidence/ 配下）

| 範囲 | 証跡 |
|---|---|
| 受入の対応付け・実行結果 | acceptance-index.json・acceptance-results.md（T085。上記） |
| PH0〜PH8 の実行記録 | ph0.md 〜 ph8.md と各 phN-review.md（レビューサイクル。確認済みの高・中の未解消0件） |
| 認証 | V01-auth.md |
| 添付・写真 | V02-files.md |
| AI（分類・生成・RAG・評価） | V04-jev.md・V04-llm.md・V04-retrieval.md・ai-evaluation.md |
| 通知・リアルタイム | V06-delivery.md・V06-realtime.md |
| 外部障害・通信断・管理者不在 | V07-outage.md（+ ops/outage-runbook.md・admin-handover.md・contact-flow.md） |
| 性能・復元・帳票表示・UX | V07-performance.md・V07-restore.md・V07-report-render.md・V07-ux.md |
| セキュリティ | security.md（T081。matrix・abuse・input-matrix・限界） |
| 費用 | cost-estimate.md（+ ops/cost-alerts.md・config/budget-development.json） |
| e2e高速化・幅仕分け | e2e-speed.md（T085b） |
| 公開デモ | ops/demo-deploy.md（T086。分離・seed・レート/費用上限・外部公開手順） |
| 操作説明 | docs/USER_GUIDE.md（T086。導入/通常利用/点検/承認/通知/通信断/復旧）＋アプリ内「メニュー → 使い方ガイド」画面（da22779。docs/03 §1.1-28） |

## 3. 局所完了の明示（実環境・実端末・実キーが要るもの）

この開発環境は実Cloudflareに未接続（wrangler未ログイン）で、実端末（iOS/Android実機）・実スクリーンリーダー・実Google Maps・実AI課金も持たない。そのため次のタスクは**局所完了**（ローカルでできる範囲を実施し、実環境部分を番号付き残作業として明示。T083〜T085と同じ扱い）:

- T007（実Cloudflareでの認証実測）・T016（実R2）・T021（実Google Maps JS API。地図面はプレースホルダー）
- T051（実配送）・T053/T057/T061/T064〜T068（実AIモデル・実PDF・Vectorize実測比較）
- T073（実30端末の反映遅延測定）・T078（GitHub Actions実行・staging実配置）・T079（実D1/R2での復元演習）・T080（実計測/実請求照合）・T082（実staging性能測定）
- T083（実機・実スクリーンリーダー・実PWA install）・T084（6障害の実環境演習）・T085（実外部/実端末/生成ファイル試験。29件）・T085b（wrangler 4.150 ProxyWorkerドロップの残存クラス観察）・**T086（公開デモの実環境構築・RG-09実地確認）**

実外部・実端末・人の残手順29件（合格に数えない）の正は **acceptance-results.md「実外部・実端末・人の残手順」の表**（X-V01〜X-OUT-10・X-COST。以下、T086が引き受けた分の現在状態）:

| id | 内容（acceptance-results.mdより） | T086での現在状態 |
|---|---|---|
| X-DEMO | 公開デモ（分離した実環境）の構築と本番データとの完全分離の実地確認（RG-09） | **未実施**（局所完了）。実施済み: 架空完成版seed（seedDemo/CLI）・分離検査（verifyDemoIsolation・demo-isolation試験）・公開デモpolicy（DEMO_SECURITY_POLICY）・運用手順（ops/demo-deploy.md）。残作業: ①実Cloudflare上のdemo環境構築（資源作成→migration→bootstrap→seed）とRG-09実地確認 ②WAF/Rate Limiting設定とレート上限値の実環境確定（docs/05 §1・docs/07 §2） ③security headers/CSPの実CDN設定判断（security.md §6） ④seed CLIの--remote対応 ⑤Googleコンソール側のMaps割当設定（§4.3。Maps接続＝X-V05後） |
| X-OUT-9 | 管理者全員回復不能時のCloudflare側復旧手順の整備 | **整備は実施**（ops/account-recovery.md §5 に番号付き手順。manifestのsummaryも更新済み）。残: stagingでの演習（X-OUT-1と併せて） |
| X-V01 / X-V02 / X-V05 / X-DEV-MAPS / X-V06-RT / X-V07-PERF / X-V07-RENDER / X-OUT-1 / X-OUT-2 / X-OUT-7 / X-OUT-8 | 実Cloudflare・実R2・実Maps・実端末・実Queuesが要る残手順（V01/V02/V05/V06/V07各文書の「未実施」） | **未実施のまま**（実環境が本開発環境に存在しないため。担当はT086のまま、実環境が用意できた時に実施） |
| X-COST / X-V04-JEV / X-V04-LLM / X-V04-RET / X-AIEVAL | 実使用量・実請求との照合、実モデル評価（T086/T088の共有） | T086分として実施済み: デモの費用上限（月$5・AI 500回/日等。config/budget-development.json〔T080実装〕をdemoでも運用）とGoogle Maps割当の手順整備。実環境照合はT088と分担のまま |
| X-DEV-1 / X-DEV-2 / X-DEV-3 | 実機3種・実スクリーンリーダー・全SCRのaxe走査 | **未実施のまま**（ops/device-test-matrix.md §2 の番号付き残手順） |

T086で実施した「できる範囲」の詳細と検証値は docs/evidence/ph8.md「T086」節。

## 4. issues台帳（tests/acceptance/manifest.json のissues）の要約

**T086で解消（resolved。6件）**: PH1-A2（認証イベントの監査記録）・PH2-C15（種別チップのトグルで一覧が点滅）・PH4-B2（承認待ち通知draftが送信者の一覧に現れない。API-67 sent=true拡張）・PH1-C（ログインの誤りと入力欄のaria関連付けほか）・PH2-C19（選択シートのEsc・フォーカス）・PH7-L（ai.calls計上位置・user次元429のRetry-After・budget_stoppedラベル等9項目）。各々の修正内容・赤→緑は manifestのbasis と ph8.md「T086」節に記録。

**T087で解消（resolved。1件）**: PH2-A12（API-27の状態別応答・import解析中の固定等4項目を個別判定し、意図した設計として維持。判定の根拠は manifestのbasis を参照）。

**T086で判定したが残る（open）**: PH3-C8（小見出し形式・複数LeaveConfirm等。現状確認の記録のみでowner未割当。構造判断が固まった時に再対応）・T085b-W1（wrangler 4.150 ProxyWorkerドロップの残存クラス。**状態確認はT086の最終検証フルe2eで行う**＝未発火ならbasisに記録。コントローラ実施）。

**残るopen全体**: acceptance-results.md「課題台帳」の open 行（PH1-A1〔T088/D03〕・PH1-B1・PH0-BF07・PH2-B12〔T088で再確認〕・PH4-B3〔T033/T055〕・FLAKE-1〔T085b。根因未特定・抑止済み〕・T085b-W1〔上記〕・PH3-C8〔上記〕ほか low の未割当分・T085-O1）。highのopenは**0件**。

## 5. 既知の制限（完成と言わない部分の正直な一覧）

1. **docs/13 の正式リリース判定（RG-01〜RG-10）はすべて未達**。上記の局所完了・実外部残手順・下記の了承待ちが解消されるまでは「合格」と主張しない（acceptance-results.md冒頭の注記と同じ規定）。
2. **実データ・実団体を一切使っていない**（AGENTS.md。名簿・出動・水利・写真は全部架空。公開デモも架空のみ＝RG-09）。
3. **了承待ちの未決事項**（docs/09・docs/14のD台帳）: データ保存・実災害時の用途・配送手段（D04/D08/D13）・費用の了承（D11）・管理主体と代行（D17）等。**docs/ADOPTION_CHECKLIST.md（T087・2026-10-21）でD01〜D20を一項目一回答として確認する**（回答欄は空欄のまま配布し、回答の記録はT088。導入提案資料はdocs/ADOPTION_PROPOSAL.md）。
4. **開発設定のままの値**: レート上限（DEVELOPMENT_SECURITY_POLICY/DEMO_SECURITY_POLICYとも未承認・docs/14 D11で確定予定）・費用上限（approved:false）・RTO/RPO 24時間案（D10未承認）。
5. **アプリ内のレート計数はisolate内メモリ**であり、厳密な全体上限はCloudflareのWAF/Rate Limiting層の設定が要る（未実施。ops/demo-deploy.md §5.3）。
6. **既知のフレーキー**: documents.spec「題名消失」の引き金は未特定（回復ループで抑止。FLAKE-1）。ProxyWorkerドロップの残存クラス（T085b-W1）。
7. **パスワード再設定コード等の配送手段は未実装**（D04未決。ops/account-recovery.md §3）。

## 6. 最終検証

T086最終検証の実測値は docs/evidence/ph8.md「T086」節「最終検証」（2026-10-21・コミット85681e4時点）が正。
