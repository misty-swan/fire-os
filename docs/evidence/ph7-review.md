# PH7 レビュー・修正サイクル（2026-10-17〜18）

ph0〜ph6と同じ手順。範囲はPH6最終 **b8c0fa6**〜HEAD（レビュー開始時 389067e。PH7の実装9コミット＋docs統合）と関連docs。レビュー担当は**読み取りのみ**（ファイルの変更・git書き込み操作・試験の実行は禁止。ls/grep等の読み取りコマンドは可）。指摘は**メインのエージェントが一件ずつコード・試験で確かめ**、分類してから直す。個々のタスクレビュー（実装直後・タスクごと）はsubagent-drivenの工程として別途実施済みで、そちらの確認済みImportantは7件〔T079 1件／T080 2件／T081 2件／T082 2件。すべて修正ラウンド1回でADDRESSED。docs/evidence/ph7.md「レビューの記録」節〕。

## 第1回（4体並行）

### 依頼
独立したサブエージェント4体を並行で起動: **A=正確さ・セキュリティ**（CI/deployの権限・Secret扱い・rollbackの正しさ・負荷試験の実測の正直さ・budget停止の迂回路）／**B=docs/16完了条件と試験の妥当性**（実Cloudflare・実端末をモックで完了扱いにしない。V番号の局所完了を正直に。T082の実測値とD18合格値の混同なし。実数は自分で計測）／**C=prototype準拠**（360/1280px・44px・トースト位置・既存画面の非変更・完成版の見た目）／**D=docsと実装の整合**（docs/13判定基準×実装・docs/08×試験一覧・docs/07×手順・docs/04×DDL・docs/05×実装の文単位照合）。各体に差分パッケージ（.superpowers/sdd/16_実装タスク一覧/review-b8c0fa6..389067e.diff・約687KB）と報告形式（ファイル:行、問題、発生条件、重大度、根拠。推測は「要確認」）を渡した。

### 指摘と分類（件数は報告の項目数。合計: 高0 / 中5 / 低16 / 要確認5）

| 観点 | 指摘 | 重大度 | 分類 | 対応 |
|---|---|---|---|---|
| A中1 | check-migrations.tsの「適用済み履歴の書き換え検出」がCIでは恒真（基準ref=HEADでcheckoutと常に一致＝書き換えを検出しない。ops/deploy.md §1-3が検出能力を主張） | 中 | 確認済み（scripts/check-migrations.ts:145実検） | 基準ref選択を純関数`pickHistoryRef`（origin/main→HEAD~1→HEAD）へ切出し＋`--base`オプション＋全workflowのcheckoutに`fetch-depth: 0`＋ops/deploy.md更新。選択順の赤→緑試験（64d2f33） |
| A中2 | budgetの「月額の費用上限」が実質単日比較（当日の行のみ集計→monthlyLimitUsd比較。月次では構造上発火しない＝ops/パネルの表記と不一致） | 中 | 確認済み（budget.ts:134/182/186実検） | month-to-date集計へ変更（当月初日以降の全行・前月末不含・急増baselineは直近7日維持・日次枠は不変）。赤＝同月2日で月累計$5.04>$5が発火しない再現→緑。既存試験は意味を月累計に更新し対照断言を追加（緩めず）（64d2f33） |
| C中1 | `budget_stopped`の日本語ラベルが未追加で、AIレビュー（SCR-18）・報告書下書き（SCR-19）の保留理由に生コードが見える | 中 | 確認済み（classification.ts:125・report.ts:72は発行、ラベル表に無し） | 両ラベル表へ日本語追加＋jsdom赤試験（キー無しで落ちる）（64d2f33） |
| C中2 | docs/03 §1.1-23⑥「画面文面に内部文書番号を入れず」が、OperationsPanelの出典表示（単価の出源=docs/06 §2等）と1発で反証される | 中 | 確認済み（docs/03:70⑥実検） | docs/03⑥を「案内文には入れない。**出典の引用**はAI評価パネル前例どおり許容」へ精緻化（24c33c4） |
| D中1 | 実環境でのレート上限値の確定・WAF/Rate Limiting設定・遮断/鍵rotation演習が「T087」に帰属しているが、docs/16のT087は提案資料作成のみ＝残留検証がどのタスクにも現れない（docs/05:22・docs/07:30・security.md:62-64,72・ops/security-response.md:49,83） | 中 | 確認済み（7箇所実検＋docs/16 T087節確認） | 帰属先をT086（公開環境設定）/T084（演習）へ訂正。docs/16 T086節へ工程追記・docs/12 NFR-08行へT086追加。追い修正で残存9箇所（ph7.md:43・cost-alerts.md:46・docs/16:40/78/175・NFR-08対応表・src/コメント3箇所）も訂正し、grep実検で「T087自身の記述以外は0件」を確認（24c33c4・301166f・353ae0e） |
| A低1 | classification.tsが`env.AI`存在確認より前に`ai.calls`を計上（AI無し環境でも枠を消費。T080タスクレビューのdeferred minorと同根） | 低 | 方針で残す | Ruling: 実AIがある環境では影響なし。実接続時（T086の検証）に計上位置を見直す |
| A低2 | user次元の429のRetry-Afterが包括既定60秒（IP次元のような窓計算値でない） | 低 | 方針で残す | Ruling: docs/05 §1「Retry-After（秒）」とは整合。窓整合は次にlimits.tsへ触る際 |
| A低3 | `cf-connecting-ip`欠落時の`x-forwarded-for`フォールバックの限界がsecurity.mdに未記載 | 低 | 同梱修正（docs） | docs/05:22・security.mdへ「Cloudflare経由では常在のため実質不使用の経路」と追記（24c33c4） |
| A低4 | Secret名スキャンの既定対象が`BETTER_AUTH_SECRET`+`dev-only-`のみで、カバー範囲が書類に未明記 | 低 | 同梱修正（docs） | ops/deploy.mdへ既定対象と`--secret`追加を明記（24c33c4） |
| A要1 | workflow 3件に`permissions:`ブロックが無い（GITHUB_TOKENが既定権限） | 要確認 | 確認済み（軽微）→同梱修正 | 3workflowへ`permissions: contents: read`＋試験断言（64d2f33） |
| A要2 | snapshot.ts文書branchのbind数が「roles≤4」前提（roles>9でD1 bind上限超過の可能性） | 要確認 | **誤りなし** | Ruling: roles表は固定4種（code enum: member/operator/officer/admin・0001でseed 4行）＋`uq_member_roles_active(member_id, role_id)`部分一意索引により、アクティブ役割は構造的に最大4。bind数は最大91<100で担保される |
| A要3 | ops/cost-alerts.md §1の「通知の1日の枠｜停止」が通知配送の停止と誤読され得る | 要確認 | 確認済み（軽微）→同梱修正 | 「AIの呼出しを停止する（通知の配送自体は止まらない）」へ明確化（24c33c4） |
| B低1 | ci.ymlがtest:loadを実行しない（恒久回帰ゲートがCI/検証コマンド順で自動に回らない事実の明記なし） | 低 | 同梱修正（docs） | ph7.md・V07-performance.mdへ「手動実行（npm run test:load）で効く」と明記（24c33c4）。CIへの組込みはしない（負荷試験はローカル測定性格・docs/16 T078の必須ゲート定義にも含まれない） |
| B低2 | task-082-report.md内のtest:load実行数が「3ファイル4試験」と「3 passed」で混在（実態は2ファイル3件） | 低 | 方針で残す | Ruling: ワークスペースの報告書内の数え間違い。証跡の正本はph7.md（2ファイル3件）で正しく記録済み。リポジトリ外のため修正しない |
| B要1 | T081「完了」の根拠がタスクレビュー2件で、フェーズのレビューサイクル証跡（ph7-review.md）が本報告時点で未存在 | 要確認 | サイクル完了で解消 | 本文書の作成とdocs/16 T081状態欄の確定更新をもって解消（docs/13 RG-04が「未達」のままであること自体は正しい） |
| C低1 | 「未計上」という表示要素が画面のどこにも無い（文言だけ） | 低 | 同梱修正（client） | 費用Figureに「Workers・D1・地図の利用量: 未計上（Cloudflare管理画面で確認）」の行を実体として追加＋試験（64d2f33） |
| C低2 | 直近20件/10件のみの集計の注記なし | 低 | 同梱修正（client） | Figureへ「最新の実行20件分・監査10件分の合計」注記＋試験（64d2f33） |
| C低3 | パネル内で理由コードの扱いが不統一（REASON_LABELで日本語化する行と生コードの行が混在） | 低 | 方針で残す | Ruling: AiEvaluationPanel.tsxのチップ生コードが既存前例。次にパネルへ触る際に統一 |
| C低4 | 403表示が隣接AuditPanelと違い、ph7.mdの「AuditPanelと同じ」記述が不正確 | 低 | 同梱修正（docs）＋表示は方針で残す | ph7.md記述を「ゲート構造は同じ。表示は403=Notice warning（AuditPanelはBanner error）」へ精緻化。表示の統一はT083の実機確認と一緒に判断（24c33c4） |
| D低1 | docs/04:3の「§3.4の該当行」が実際は§3.5（0031由来の既存誤りの踏襲） | 低 | 同梱修正（docs） | 0031/0032の両表記を§3.5へ訂正（24c33c4） |
| D低2 | docs/04:168にusage_metricsの索引`idx_usage_metrics_day_service`とbudget_stateの`policy_version/updated_by/updated_at`列が未反映 | 低 | 同梱修正（docs） | 実DDL（drizzle/0032_observability.sql:27,38-40）と一致する形でdocs/04:168と§4索引一覧へ追記（24c33c4。再レビューで実ファイル突合済み） |
| D低3 | docs/05:22にXFFフォールバックの記述なし（A低3と同根） | 低 | 同梱修正（docs） | A低3と一体で解消 |
| D低4 | ph7.md「HEAD=1abc273」がdocsコミット時点のHEADとずれる | 低 | 同梱修正（docs） | 「実装HEAD=1abc273（docs改訂は別コミット）」へ（24c33c4。サイクル完了後にさらに修正コミット追記へ更新） |
| D低5 | V07-performance.md「公开」簡体字混入 | 低 | 同梱修正（docs） | 「公開」へ（24c33c4） |
| D低6 | V07-restore.md・restore.tsコメントの「docs/07 §1と一致」が誤引用（正本は§8） | 低 | 同梱修正（docs+コメント） | §8へ訂正（実文「監査はD1追記型」と一致。24c33c4） |

### 誤り・対象外
A要2（bind上限のroles≤4前提）は**誤りなし**（schema担保。上表どおり）。B報告は実数を自ら計測し「64ファイル286件・tests/load 2ファイル3件・e2e 27spec/宣言45本・レンジ内10コミット・0033無し・config approved: false・ci.ymlゲート9ステップ（test:load無し）」を確認、モックでの完了偽装・局所完了の隠蔽なしと判定。D報告はdocs/05 §1の429追記を文単位で実装と照合（5バケット分類・2層・details.reason・isolate限界）、docs/13の全RG「未達」維持を確認（T082で性能合格と書き替えていない）。C報告はprototype 4本の実grepで「operations/運用（費用」0件（パネル不在の記録どおり）・既存画面の非変更・共通部品・44px・NOT MEASURED常時注記を確認。

### 修正の実施
4コミットに分割: **64d2f33** `fix: address PH7 review round 1 (server/client)`（A中1/A中2/C中1＋A要1/C低1/C低2。挙動変更はすべて赤→緑）→ **24c33c4** `fix: address PH7 review round 1 (docs)`（C中2/D中1＋同梱10件）→ **301166f** `docs: complete PH7 review round 1 reattribution`（D中1の残存6箇所）→ **353ae0e** `fix: PH7 round 1 follow-up (comments)`（src/コメント3箇所のT086帰属統一）。

### 再実行（修正commit後・コントローラ実行・353ae0e時点）
`npm run typecheck` 成功／`npm run check:contracts` **102 API一致**／`npx vitest --run` **65ファイル291件成功**／`npm run test:load` **3件成功**／`npm run build` 成功／`npm run test:e2e` **2回のフル実行でいずれも87件成功＋1件失敗＋3件スキップ**（失敗は2回ともdocuments.spec desktopのトースト断言＝既知flap型。**単独再実行は2回とも締（2 passed）**。ph5/ph6では各1回だったため頻度上昇をph7.md「既知フレーキー」に観察強化として記録。サーバー側のPH7変更は文書作成経路に触れていない。次にdocuments.specへ触る際にトースト断言の作り直しを割当）。

## 第2回（round 1修正 389067e..353ae0e の再レビュー）

### 依頼
新しいサブエージェント2体を並行で起動: ①コード系（A中1/A中2/C中1＋同梱A要1/C低1/C低2。budget月累計の赤試験・`pickHistoryRef`・jsdomラベル試験の実質性と新規破壊）②docs系（C中2/D中1＋同梱10件。**`grep -rn "T087" docs/ ops/ src/`の実検**・docs/04:168と実DDL 0032の突合・docs/05/07の2層記述が文単位で意味不変か）。読み取り専用。試験は実行しない（合否は全検証記録と報告書の赤/緑出力に依拠し、判定はコード読解）。

### 解消判定
| 対象 | 判定 |
|---|---|
| コード系5件（A中1・A中2・C中1・A要1・C低1/C低2） | **すべてADDRESSED**。A中1は`pickHistoryRef`（check-migrations.ts:60-71）が候補順どおりで--base両形式が実効、fetch-depth:0は3yaml断言つき。A中2の月初境界を含む赤試験（前月末200Mを含めず同月2日で停止・1日分では非停止・`monthAiTokensInput===120M`断言）と「当日200Mでも月累計1Mなら費用理由では止まらない」対照追加を確認。C中1のjsdom試験はキー無しで落ちる本物。取得窓拡大の影響は`expensiveCallGate`経由のみで他経路なしを確認 |
| docs系全件（C中2・D中1＋同梱10件） | **すべてADDRESSED**。T087帰属の残存はgrep実検で0件（残存はT087自身の記述・依存表のみ）。docs/04:168は実DDL 0032:27,38-40と完全一致。docs/05:22・docs/07:30の2層記述は訂正前後で意味不変。T086節への追記はstep 3の文末1文でFiles/Interfaces/依存は無傷 |
| diff内新規欠陥 | Critical/Important 0件。**Minor 3件**: ①budget_stoppedラベルが「月次上限」固定（serverは全停止理由で同コードを返す。中立語彙が望ましい）②docs/16 T086節「対応」行にNFR-08未追加（表の非対称）③limits.ts:44コメント「負荷検証」（docsは「公開設定時の検証」に統一済み）— いずれも次回触る際の掃除候補として下記「方針で残す」へ |
| コード修正とクライアント/運用の整合 | 問題なし（月累計化はexpensiveCallGateのみに効き、OperationsPanel・API-88/93は不変。usage_metricsはday×service×metricの事前集計行のみで読み取り増は僅少） |

### 判定
**1回のレビュー・修正サイクルを完了。確認済みの高・中の未解消は0件**（上限3回に対し1回で収束）。

## 方針で残す（Rulingつきの全リスト）

1. **A低1 classification ai.calls計上位置**（低）— Ruling: 実AI環境では影響なし。計上位置の見直しは実Cloudflare接続後（T086の検証）に。コスト: AI無し環境で日次枠の母数が汚れる
2. **A低2 user次元429のRetry-After固定60秒**（低）— Ruling: docs/05 §1の語彙とは整合。窓整合値は次にlimits.tsへ触る際。コスト: 再送タイミングの精度のみ
3. **B低2 報告書のtest:load数え間違い**（低）— Ruling: ワークスペース報告書のみ。証跡正本はph7.md。リポジトリ外
4. **C低3 理由コード扱いの不統一**（低）— Ruling: AiEvaluationPanel前例と同じ。次にパネルへ触る際に統一。コスト: パネル内の基準割れ
5. **C低4の表示統一**（低）— Ruling: 403のNotice/Banner差はT083の実機確認と一緒に判断。コスト: 同一画面で同種状態の見た目が分かれる
6. **再レビュー軽微1 budget_stoppedラベルの「月次上限」固定**（低）— Ruling: クライアントにreasonsが渡らない構造制約。次にラベルへ触る際に中立語彙へ。コスト: 日次枠・手動停止の保留に「月次上限」と表示され得る
7. **再レビュー軽微2 T086節「対応」のNFR-08欠落**（低）— Ruling: 表の非対称。次に対応表を触る際に追加。コスト: T086のWAF工程の追跡が表から分かりにくい
8. **再レビュー軽微3 limits.ts:44「負荷検証」文言**（低）— Ruling: 帰属（T086）は正で文言のみ。次にlimits.tsへ触る際に統一。コスト: なし
9. **documents.spec desktopトースト断言のフレーク頻度上昇**（既知・観察継続）— Ruling: PH7のサーバー変更は文書作成経路に触れていないため既知の表示競合型と判断。単独実行は常に緑。次にdocuments.specへ触る際（またはT083）にトースト断言を非時間依存の待ち合わせへ作り直す。コスト: フル実行の合格判定に手動の単独再実行確認が要る状態が続く

## 最終状態

- 確認済みの高・中の未解消: **0件**
- 指摘総数: 高0 / 中5 / 低16 / 要確認5＝修正したのは**中5件＋低12件＋要確認2件**（残り低4件＋要確認3件〔A要2=誤りなし・B要1/D要1=サイクル完了で解消〕は方針で残すまたは解消。再レビュー新規のMinor 3件は方針で残す）
- 変異・赤の確認: round 1の挙動変更は全て赤→緑〔基準ref選択3ケース／月累計$5.04の月初境界／ラベルキー無し／permissions断言〕＋T082の監査強制発火変異は前ラウンド（1abc273）で実施済み
- 最終全検証（353ae0e時点）: `npm run typecheck` 成功／`npm run check:contracts` **102 API一致**／`npx vitest --run` 65ファイル**291件**／`npm run test:load` **3件**／`npm run build` 成功／`npm run test:e2e` **87件成功＋1件失敗（既知flap型・単独は緑）＋3件スキップ**／`npm run test:live` は実環境未設定のため9件fail継続（docs/evidence/ph7.mdに記録）
- 局所完了の残手順（T078 GitHub Actions実行・T079 V07-restore実環境演習・T080実計測/請求照合・T082 V07-performance実staging測定。T073のV06-realtime・T077のT033接続は継続）は docs/evidence/ph7.md に記録済み。レビューサイクルでも「実外部をモックで完了扱いにしない」観点でこれらの正直さを確認済み（B報告）
