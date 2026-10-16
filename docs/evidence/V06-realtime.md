# V06 30端末の更新配信と切断後snapshot回復（T073局所／実30端末は未実施）

方式: **poll（API-80の再開cursorを一定間隔で回す）**（docs/05 §8、docs/14 D16）。実装は `src/server/events/transport.ts`（輸送の契約 `EventTransport.subscribe`・poll間隔の根拠）、`src/server/routes/events.ts`（API-80＝pollの1周期。応答契約はT072のEventPageのまま・新規endpointなし）、`src/client/features/incidents/useIncidentUpdates.ts`（SCR-12の接続部品）。

## 方式の決定（docs/16 T073／docs/14 D16の開発選定）

候補3方式をD18の開発案（更新遅延p95 5秒）と30端末の条件で比較し、**pollに暫定固定**した。

| 観点 | **poll（採用）** | SSE（不採用） | Durable Objects（不採用） |
|---|---|---|---|
| 遅延 | 下限＝poll間隔（2秒）。実測p95≈2.3秒で案内を満たす | pushなので部分が最も小さい（下限は配信経路のみ） | pushと同等 |
| サーバー費用 | 要求ごとのD1読み取り。30端末×0.5req/s＝15req/s/unit（1要求≈principal引直し2query＋走査2query＋ACL判定） | 接続を保持する間のアイドル課金・同時接続管理。push源を作るには結局D1内部pollかDOが要る | DOリクエスト課金＋4環境すべてへのbinding/class/migration（**wranglerのenvはbindingを継承しない**＝AGENTS.md） |
| 実装・試験の費用 | 既存API-80のみ。輸送の契約（AsyncIterable）と画面の部品で済む | Workersでの長時間接続の再接続・proxyでの切替・試験基盤（streaming）の整備 | classの新規試験基盤（vitest-pool-workersのDO構成）＋migration。D1 outboxが既に担う順序保証・ACL filterとの二重管理 |
| 切断後の回復 | cursorの位置から再開（at-least-once）。409でsnapshot再取得 | 再接続時に最終イベントIDの管理が別途要る | DOセッションの再接続管理が要る |
| 段階的な移行 | SSE/DOへ移すときは `EventTransport.subscribe` のpush実装に差し替える（受け手の語彙は不変） | ― | ― |

採否の根拠: **pollの実測が開発案を満たした**うえで、SSE/DOが払う費用（4環境への設定追加・課金・二重実装）に対して得るもの（2.3秒→サブ秒）が30端末/unitの規模では小さい。**D1読み取り費用が実データ量で問題になった時点で再評価する**（T082の代表件数測定とV06残手順）。

## 実施したこと（ローカルworkerd＋ローカルD1。実端末・実回線は含まない）

`tests/realtime.test.ts`（workers試験。実worker＋実D1エンジン上で実行）で、**30本の独立したpoll接続**（同じ団員が開いた端末ごとのcursorとpoll周期を持つ。利用者アカウント単位の認証負荷は含まない）を模擬して実測した。

| 確認 | 結果 | 条件 |
|---|---|---|
| 更新の反映遅延（commitの完了→各端末が最初にその版を受け取るまで） | **p50≈2.17秒 / p95≈2.29〜2.33秒 / 最大≈2.35秒**（3回実行。30サンプルの最近点順位法） | poll周期2秒＋揺らめき±20%（斉奏を崩す）。D18開発案のp95 5秒以内 |
| 切断→再接続の集中（30端末が同時に再開） | 取りこぼしなし。切断中の3件のcommitを全端末が同じ窓（単調順・重複なし）で受領 | at-least-once。窓の同値はdomain_eventsの実行と照合 |
| 順序逆・旧版の再配信 | 版は後退しない（entityVersionAfter >= entityVersionBefore）。畳み込み後の版は最新に収束 | 古いcursorを後から見直しても同じ窓が返る（決定的）。画面側は「新しい版だけ採用」 |
| 不可視イベントの露出 | **0行**（visibleLeakCount=0）。宛先外のお知らせ・他分団の出動は1行も現れない | 全フェーズで受け取った全ページを検収 |
| 失権（認可版の増分）・期限切れcursor | 30端末＋期限切れ1本の**31本すべてが409 RESYNC_REQUIRED** → snapshot（API-70）の取り直しで全員回復（resyncSnapshotCount=31） | 役割変更と同じ状態（users.authz_versionの増分）を注入 |
| 輸送の契約 | `EventTransport.subscribe`が絞り付き（entityType=incident&entityId）でsnapshot位置以後の全差分を1接続でdrain | pollの正本経路（API-80）と同じ走査核（readEvents）。主体・ACLは毎ページ引き直す |

実測の限界（**この数字を過大に読まないこと**）:
- 同一workerd・同一D1への接続であり、**実回線のRTT・パケットロス・端末の電池最適化（バックグラウンド制限）は含まない**。実環境のp95はこれより悪くなる前提で、V06の残手順で実測し直す。
- 30端末は「同じ団員の30接続」であり、30利用者の認証・セッション検証の負荷は含まない。
- D1の読み取り費用は件数に比例する（15req/s/unit）。**金額換算は未実施**（T082で代表件数とともに測定する）。

## 画面側の実装（SCR-12）

`useIncidentUpdates(id): {status: ConnectionState; refresh: () => void}`:
- poll周期2秒（新着なし時）。ページが満杯の間は間を置かず追いつく（長い切断の回収）。失敗は2→4→…→30秒のbackoff。
- 409 RESYNC_REQUIRED（cursor期限切れ・失権）はsnapshot（API-70）を取り直して続行する（「resync」の札）。
- 版比較は「entityVersionが前より大きいときだけ採用」（重複・順序逆・旧版で画面の版が後退しない）。採用のたびに`refresh`の参照が変わり、画面は依存に置くだけで読み直す。
- オンライン/オフラインの語彙はAppShellの札（`useOnline`）と共通（`ConnectionState = "online" | "offline" | "resync"`）。オフラインの間は要求を出さない。
- cursorは応答ごとに新しくなり24時間の期限が延びる（開きっぱなしの画面は失効しない＝poll輸送におけるheartbeat。docs/05 §8「resumeCursorで伝える」）。

e2e（`tests/e2e/realtime.spec.ts`）: 実ブラウザの2端末で、片方の画面操作（記録中→出動中→終了）がもう片方の画面に**再読込なしで**届くこと、および役割変更（認可版の増分）を挟んでも配信が続くこと（409→snapshot再同期）を両プロジェクト（phone-360/desktop-1280）で確認した。

## 未実施（検証済みとして扱わない）

**実30端末・実回線での測定は未実施。** 理由: ①この環境の`wrangler`は未ログインで実Workersに配置できない、②実端末・実ネットワーク（モバイル回線・電池最適化）がこの環境にない。ローカルworkerdでの30接続実測を「実30端末での合格」とは扱わない。

残作業と手順（ユーザーの操作が必要）:
1. `npx wrangler deploy --env staging` でWorkerを配置し、`npm run migrate -- --env staging --yes-i-know` まで済ませる（V01/V02の手順と共通）。
2. 団員30人分を招待し（API-03→API-33）、実端末（実ブラウザ。実機が揃わない場合は別ネットワークの実ブラウザ30セッションで代用し条件を明記）で招待を受領する。すべて架空データで行う。
3. 30端末で同じ出動記録（SCR-12）を開き、`npm run test:live -- tests/live/realtime-load.test.ts`（`LIVE_BASE_URL`/`LIVE_BOOTSTRAP_EMAIL`/`LIVE_BOOTSTRAP_TOKEN`）の手順に沿って、①更新反映遅延のp95実測（D18の正式合格値の承認材料）②切断/復帰・バックグラウンド復帰での取りこぼし0③失権後の409→snapshot再同期の動作④D1読み取り費用の概算、を記録する。
4. 実測結果をこの文書の「未実施」に上書きし、docs/14 D16の暫定固定を実測で確定する（pollのままか、SSE/DOへ再評価するか）。D1費用が支配的になった場合はT082の代表件数測定と合わせてDO（unit単位hub）を再評価する。

この手順を実行するまで、V06の「30端末の更新配信」は **局所のみ検証済み・実環境は未検証**。DSP-04を「完成」とは扱わない（V06の残手順）。
