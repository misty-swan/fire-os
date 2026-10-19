# V07 代表件数・30端末の性能とD1クエリ費用（T082局所／実staging・実D1 rows_read・実回線・実端末は未実施）

目的: docs/14 D18の代表負荷（**施設1,000/点検年10,000/文書100×20頁/30同時端末**）で既存APIの性能を実測し、D1のクエリ費用を概算する（docs/08 CT-14・AT-NFR-03、docs/13 RG-02、docs/14 D16＝poll輸送のD1読み取り費用が問題になった時点での再評価材料、PH6レビュー#6＝出欠イベントの1行ずつACL判定の実測）。

**この文書の数字は開発環境（ローカルworkerd＋ローカルD1）の実測であり、実Cloudflare（staging）・実回線・実端末での測定は未実施**（「未実施」節の手順で実測し直すまで、D18の合格判定には使わない）。docs/14 D18に**承認済み合格値は存在しない**ため、この文書では「通常API p95 2秒」「更新反映 p95 5秒」を**開発目標（原目標）**として使い、合格と混同しない。

## 方式

- runner: `npm run test:load`＝`vitest.load.config.ts`（既存のworkers試験と同じ実workerd＋実D1エンジン。`tests/load`は正規スイート〔`vitest.config.ts`〕から除外済みで二重実行されない）。ブリーフのInterfacesどおり `seedLoad(env, profile)`／`summarizeLoad(samples)` を `scripts/seed-load.ts` に実装する。CLI（`npx tsx scripts/seed-load.ts --out <file>`）で同じseedのSQLを生成でき、`wrangler d1 execute DB --local --file` で試験基盤の外でも再現できる。
- 測定対象: `tests/load/api-load.test.ts`（通常APIの要求mix＋30端末poll併走＋出欠イベント窓のdrain）と `tests/load/reconnect-load.test.ts`（30端末の再接続集中を通常と通信劣化で）。認証はfixtures作法どおり試験専用注入（`x-test-identity`。APP_ENV=localかつTEST_AUTH=1のときだけ有効）で、**実セッション認証・30利用者の認証負荷は含まない**。
- profile: `REPRESENTATIVE_PROFILE`＝**D18代表件数そのもの（縮小0%）**。施設1,000／点検10,000（1施設あたり10本×1,000系列）／文書100×20頁（chunk 2,000＋FTS 2,000行）／活動100（実績80・対象snapshot 33名×100）／出欠2,310行／名簿33（役割3＋一般30）／**outbox（domain_events）13,410行**（施設1,000＋点検10,000＋活動100＋出欠2,310。seedはmutation経路を通さないため1年分のoutboxを直接作る。units.event_sequenceも13,410まで進む）。seedはbatch INSERTで**約5秒**（テスト全体は約30秒。controller裁定6の10分以内）。
- policy: `tests/load/helpers.ts` の `LOAD_SECURITY_POLICY`（レート制限を実質無効にする幅）を `createApp(env, policy)` で**明示的に差す**（controller裁定5。黙った免除ではなく試験コードに記録）。実環境ではWAF/Rate Limiting製品層＋本policyの値が効く（docs/07 §2）。レート制限そのものの挙動はtests/security/abuse.test.tsが厳しいpolicyで観測する。
- 判定方法: docs/08 CT-14「平均値だけで判定しない」どおり、**p50/p95/maxと失敗数**で判定する。失敗要求は集計から外さない（`omittedFailedRequests=0`＝全sampleがちょうど1つのbucketに数えられていることをsummarizeLoadが保証）。地図（API-10の一覧＝地図データ源）とAI（API-76検索/RAG）は **別bucket** で測り、通常APIのp95に混ぜない（AT-NFR-03）。AIはローカルでは決定的なfake AI（`TEST_AI_FAKE=1`。src/server/ai/local-fake.ts）で検索→引用検証→保存までの全経路を測る＝**実モデルの遅延は含まない**。

## 実測（ローカルworkerd＋ローカルD1。実回線RTT・実端末・実モデルは含まない）

### 通常API（30端末poll〔0.5req/s±20%〕の併走下。要求mix 30端末×4ラウンド＋添付）

| bucket | n | 失敗 | p50 | p95 | max |
|---|---|---|---|---|---|
| **ordinary（通常API全体）** | **1,170** | **0** | **68ms** | **178ms** | **205ms** |
| map（API-10 地図データ源・別測定） | 30 | 0 | 68ms | 79ms | 80ms |
| ai（API-76 RAG・別測定。fake AI） | 120 | 0 | 183ms | 202ms | 202ms |
| poll（API-80 定常。空ページ） | 179 | 0 | 3ms | 4ms | 28ms |

（同一コードの実行間の揺らぎは数ms〜数十ms程度。apiごとの内訳は別回の実行例）

apiごとの内訳（p95、遅い順。CT-14の「operation単位」の証跡）: API-76（ai）223ms／API-52集計199ms／API-28ホーム176ms／API-22出動記録132ms／API-10地図83ms／API-02名簿78ms／API-69出動訂正78ms／API-83 upload 77ms／API-26 intent 70ms／API-44点検履歴69ms／API-98 draft 60ms／API-12施設詳細58ms／API-90文書一覧53ms／API-01 me 46ms。**開発目標（p95 2秒）に対して最も遅いAPI（API-76）でも約9倍の余裕**。

### 30端末の再接続集中（切断中の4イベント〔作成1＋訂正3〕のbacklog。tests/load/reconnect-load.test.ts）

| 条件 | p95（1要求） | 壁時計（30端末全部の完了） | 内容 |
|---|---|---|---|
| 通常 | **32ms** | 33ms | 全端末が同じ窓（単調順・重複なし）で4件を受領し最新版へ収束 |
| 通信劣化 | **687ms** | 1,320ms | 片道300msのRTT注入＋端末1/3の**初回要求を実際に喪失**（要求を発射したまま応答を放棄＝クライアント側timeout。サーバーは処理を完遂してもクライアントは受け取れない＝実回線の応答ロストと同じ状態。1 RTT待って**同じcursorで再送**）。喪失は失敗sample 10件として記録し**p95の百分位に含める**。再送端末はbacklogをもう一度受け取る（at-least-once。重複の畳み込みはクライアントの責務）で、取りこぼしなし |

「通信劣化」は**人工的なRTT注入と初回要求の喪失（応答放棄＝クライアントtimeout）→同じcursorでの再送**の模擬であり、実回線の帯域制限・パケットロス分布・電池最適化は含まない。V06（定常pollの更新反映p95≈2.3秒）の再接続版として、poll周期2秒が支配的でbacklog回収の1要求はpoll周期に比べて無視できる規模。

### 出欠イベント窓の30端末drain（PH6レビュー#6。tests/load/api-load.test.ts後半）

出欠イベント2,310件が窓に全て入る最悪ケース（一般団員には約2,270行が非可視＝走査位置だけ進める）を30端末が同時に回収:

| 実装 | n | p50 | p95 | max | 空ページ基線（p50） |
|---|---|---|---|---|---|
| 修正前（1行ずつACL判定。旧eventVisible） | 90 | 2,740ms | **8,942ms** | 8,943ms | 1ms |
| **修正後（バッチACL判定。現行）** | 210 | **53ms** | **496ms** | 498ms | 2ms |

## 実施した遅いクエリの修正（docs/16 T082「slow SQLを修正」。migration不要）

**`src/server/events/snapshot.ts` のACL判定を1行ずつのSQLから1走査バッチ1SQLへ変えた**（旧`eventVisible`→`visibleFlagsOfBatch`）。走査そのものはUNIQUE(unit_id, sequence)の暗黙索引で有界（下の計画監査）だったが、**非可視行1行ごとに点ルックアップ1回**（出欠ならactivity_attendance＋activitiesのJOIN）が最大SCAN_MAX_ROWS=1,000回/要求走り、代表件数の最悪窓でp95 8.9秒だった。バッチ化（通知・お知らせ・文書・出欠の各branchをD1のbind上限内のIN分割＝90件ずつ〔文書はvisibility SQLのbindを伴うため80件〕。analytics/query.tsと同じ注意）で、判定の語彙と結果は1行版と同一（fail-closed・行が無い/別unitは非可視・本人の行は本人に見える＝API-07と同じ規則）のまま、**p95を8,942ms→496msへ下げた**。既存のT072/T073試験（tests/events.test.ts・tests/realtime.test.ts）と正規スイート全体（64ファイル286試験）は無変更で通る。**索引追加は不要だった**（migration 0033は作っていない。計画監査のとおり既存索引で境界内）。test:loadはCIゲートにもAGENTS.mdの検証コマンド順にも含まれず、手動実行（`npm run test:load`）で恒久回帰ゲートが効く。

## クエリ計画監査（境界外走査0のゲート。ローカルD1＝SQLiteのEXPLAIN QUERY PLAN）

測定対象APIが主に使う **13種の読み取り（8キー）** をserver実装と同じ形のSQLで監査した（tests/load/api-load.test.ts `planAudits`。実装の複製である限界は次節）。判定基準は「SCAN <主表> で索引（USING INDEX）もFTS MATCH制約も無い」＝**境界外走査**。監査キーは `LoadSampler` がsampleに記録するAPI文字列と同じ（`API-01/02/10/28/44/52/76/80`。API-28は4本のCOUNTを、API-80は走査・絞り付き・出欠バッチACLの3文を同じキーで監査）で、結果は **①各キーの直接断言**〔`expect(…, "plan-audit: …").toBe(0)`。監査が境界外を検出すればこの断言が落ちる〕と **②sample記録→summarizeLoadの合計**（`unboundedQueryCount=0`）の **二重ゲート** に接続する。監査を強制発火させる変異を入れたとき直接断言が落ちること（`plan-audit: API-80 … expected 4 to be +0`）を確認済み（T082修正ラウンド1）。結果は**0件**。主な計画:

| クエリ（api） | EXPLAIN QUERY PLAN |
|---|---|
| poll走査（API-80。絞り無し/有り） | `SEARCH domain_events USING INDEX sqlite_autoindex_domain_events_2 (unit_id=? AND sequence>?)` — **1要求の読み取りは窓の行数に比例し、表の成長に比例しない** |
| principal解決（全API） | users/members/unitsのPK探索×3（＋役割・scopeの小さな索引探索） |
| 名簿一覧（API-02） | `SEARCH m USING COVERING INDEX idx_members_unit_name (unit_id=?)` |
| 施設一覧（API-10。地図） | `SEARCH facilities USING INDEX sqlite_autoindex_facilities_2 (unit_id=?)`＋id順のソート |
| 点検履歴（API-44） | `SEARCH facility_inspections USING INDEX idx_facility_inspections_facility (facility_id=?)` |
| ホーム件数（API-28） | `SEARCH a USING INDEX idx_activities_unit_planned (unit_id=? AND planned_starts_at>?)` ほか4本 |
| 年度集計（API-52） | activitiesの索引範囲＋results/revisionsのPK探索（活動100の年度で〜1,200行） |
| 出欠バッチACL（API-80） | `SEARCH a USING INDEX sqlite_autoindex_activity_attendance_3 (unit_id=? AND id=?)`×IN要素＋activitiesのPK探索 |
| FTS検索（API-76） | `SCAN document_chunks_fts VIRTUAL TABLE INDEX 32:M7` — MATCH制約で一致行に有界（2,000chunkの索引） |

## D1読み取り費用の概算（**実測ではない**。実rows_readの実測は「未実施」節）

**概算の方法**: ローカルには実D1のrows_read課金メトリクスが無いため、①上のEXPLAIN QUERY PLAN（実際に使われる索引と一致条件）と②seedの行数（各表の実在行数）、③D1の走査1バッチ=200行（`SCAN_BATCH`）・1要求上限=1,000行（`SCAN_MAX_ROWS`）から、**1要求あたりの読み取り行数＝各クエリが索引で読む範囲の行数の和**として求める。プラン監査がserver実装の複製であるため、実装を変えたときは監査と概算を一緒に直す。**この概算を「実測」と表記しない**。

| 要求 | 読み取り行数の概算 | 根拠 |
|---|---|---|
| poll 1周期（定常・空ページ） | **約8行** | principal約5＋走査0〜1＋units連番1 |
| poll 1要求（最悪のdrainページ） | **約2,100行** | 走査1,000（SCAN_MAX_ROWS上限）＋出欠のIN点ルックアップ約1,000＋親activities約100 |
| me／名簿／施設詳細／点検履歴 | 約5〜60行 | PK探索とunit内の小さな索引範囲 |
| 名簿一覧（1ページ50件） | 約60行 | 33名のunit＋付帯5クエリ |
| 施設一覧（1ページ100件。地図） | **約1,100行** | unitの施設1,000全行をid順ソートのために読む（ORDER BY idが索引順と違う。**通常apiの中で最大の読み取り**。地図は別測定） |
| ホーム（API-28） | 約40行 | 件数4本＋最接近1件の内訳 |
| 年度集計（API-52） | 約1,200行 | 活動100×3表＋実参加616行＋出動側 |
| RAG 1回 | 約260行 | FTS一致（topK=5＋結合）＋再検査＋回答・引用の書込み（読み替え約50行） |
| 出動の保存1件（mutation） | 読み約20行／**書き約6行** | 版と冪等の検査＋原本/履歴/監査/outboxの書込み |

**月額の目安（1unit・30端末。単価はdocs/evidence/cost-estimate.md §1の公開価格）**: 業務時間8時間×20日で30端末がpoll（0.5req/s）すると約864万要求/月≈**読み取り約6,900万行/月≈$0.07/月**（無料枠〔500万行読み/日〕は日あたり約350万行で収まる）。 通常操作（数百リクエスト/日/人）と集計を合わせても桁は変わらず、**D1読み取り費用はpoll輸送（docs/14 D16）の暫定固定を覆す規模ではない**。この概算は「実測ではない」——実rows_readの照合は未実施節の手順で行い、ops/cost-alerts.md §4の月次照合に載せる。

## 出欠イベントのACL判定とoutbox非正規化の判断材料（PH6レビュー「方針で残す」#6）

- **測定値**: 1行ずつのACL判定では最悪窓のdrain 1要求がp95 8,942ms（1要求あたり最大1,000回のSQL）。バッチ化後は**p95 496ms**（SQLは種別ごとに最大1回×90件ずつのIN。読み取り行数の概算は約2,100行でほぼ変わらず——削れたのは**SQL往復回数**であって行数ではない）。
- **判断: 現行設計を維持する（member_id/activity_idのoutbox非正規化は今は入れない）。** 理由: ①代表件数の最悪窓でも開発目標内に収まり、読み取り行数はSCAN_MAX_ROWS=1,000/要求で有界、②走査はUNIQUE(unit_id, sequence)索引で窓の行数に比例し（表の成長に比例しない）、③非正規化は「1行ずつのACL語彙をoutboxに焼き込む」ことになり、許可変更・本人特定の扱いがoutbox書込み側の複雑さと引き換えになる（docs/05 §8の「現在のACLでfilter」をoutbox側で再実装することになる）。
- **再評価の目安（これを超えたらdocs/14 D16へ実測値とともに提案する）**: ①実環境の実測（未実施節）でpoll p95がD18承認値を超える、かつ最悪窓のdrainが常態（長時間切断の端末が多い運用）になる。②実rows_read実測でpollがunitの月間読み取りの半分を超え、費用がconfig/budget-development.jsonのしきい値を圧迫する。③1unitの累積outboxが約10万行を超える規模になる（このときは非正規化より先に「古いcursorの回収期間の制限〔cursor期限24時間〕の見直し」も一緒に評価する）。判断の記録はdocs/14 D16への追記としてコントローラがdocs統合時に行う（この文書は材料の提供）。

## 限界（この数字を過大に読まないこと）

- **同一workerd・同一D1（miniflareのSQLite）**であり、実Cloudflare D1の分散構成・ネットワーク往復・CPU/IO性能は含まない。実環境のレイテンシはこの数字より悪くなる前提で、V07の残手順で実測し直す。
- **実回線のRTT・帯域・パケットロス・端末の電池最適化は含まない**。「通信劣化」は人工的なRTT注入＋初回要求の喪失（応答放棄＝クライアントtimeout）→再送の模擬。
- 30端末は「同じ団員が開いた30接続」であり、**30利用者の実セッション認証・招待・MFAの負荷は含まない**（認証注入）。30利用者での実測はV06残手順と共通。
- AI（API-76）は**決定的なfake AI**での測定（検索・引用検証・保存の経路は実物、モデルの遅延は実物ではない）。実モデルのp95・単価はV04（docs/evidence/V04-llm.md）の残手順。
- クエリ計画監査とD1費用は**概算**（server実装のSQLの複製＋SQLiteのプラン）。実D1のrows_readはSQLiteのプランと行カウントの考え方が同じでも、実測でしか確定しない。
- 地図（DSP-04の実描画・Maps API）と非同期完了（job）は**別測定**であり、この文書の対象外（V05・jobsの証跡で扱う。AT-NFR-03の「地図/AIを別測定」どおり）。

## 未実施（検証済みとして扱わない）

**実staging・実Cloudflare D1での測定（実rows_read実測）・実30端末・実回線での測定は未実施。** 理由: ①この環境の`wrangler`は未ログインで実Workersに配置できない、②実端末・実ネットワーク（モバイル回線・電池最適化）がこの環境にない。ローカルでの代表件数実測を「D18の合格」「NFR-03の充足確定」とは扱わない（docs/13 RG-02はD18承認条件での実測を要求する）。

残作業と手順（ユーザーの操作が必要）:

1. `npx wrangler deploy --env staging` でWorkerを配置し、`npm run migrate -- --env staging --remote --yes-i-know` まで済ませる（V01/V02の手順と共通）。
2. stagingへ代表件数のseedを投入する: `npx tsx scripts/seed-load.ts --out /tmp/seed-load.sql` で生成し、`npx wrangler d1 execute fireos-staging --remote --file /tmp/seed-load.sql`（`--yes-i-know` はwranglerのフラグではないため付けない＝T084レビューで訂正）（**架空データのみ**であることを確認してから。リモートへの適用はユーザーが実行する）。投入後、`SELECT COUNT(*) FROM domain_events` が13,410前後であることを確認する。
3. 団員30人分（または実ブラウザ30セッション。条件を明記）でログインし、`tests/live/realtime-load.test.ts`（V06残手順のharness）と同じ手順で: ①通常API p95の実測（D18の正式合格値の承認材料。**測定条件〔回線・端末・時刻帯〕をここに追記する**）②30端末の再接続・backlog回収の実測 ③**実D1のrows_read実測**（CloudflareのD1 metrics／`wrangler d1 insights`〔またはdashboardのMetrics〕でAPI別・期間別のrows_readを記録し、上の概算表と突き合わせる）④AI（API-76）の実モデルでのp95・単価、を記録する。
4. 実測結果をこの文書に追記し、docs/14 D16の暫定固定（poll）とD18の承認材料を確定する。D1費用が支配的になった場合・poll p95が承認値を超えた場合は、上の「再評価の目安」に従ってSSE/DO（unit単位hub）とoutbox非正規化を再評価する。

この手順を実行するまで、V07の「代表件数・30端末の性能とD1クエリ費用」は **局所のみ検証済み・実環境は未検証**。NFR-03を「合格」とは扱わない（docs/13 RG-02。T083以降の実端末検証と合わせて承認材料を揃える）。
