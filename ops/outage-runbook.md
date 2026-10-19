# 外部障害・通信断の代替運用の手順（T084）

目的: Google・AI・API（保存応答の消失）・Queues・通知provider・管理者不在の6つの障害で、**保存・送信・到達を取り違えず**、一覧・手動帳票・同期結果照会・正副管理の代替経路で業務を続け、復旧後に照合する手順を定める。正本は docs/07 §1/§5/§7、docs/14 D08（実災害用途・正式連絡）/D17（管理主体・代行）、試験は docs/08 AT-NFR-04・CT-07・TC-17。災害時の正式連絡は **ops/contact-flow.md**、管理者の交代は **ops/admin-handover.md**。

**現状の正直な限界（2026-10-19時点）**: 6つの障害の演習は**ローカル（workerd＋ローカルD1＋Playwright、架空データ）でのみ実施**（`tests/e2e/dependency-outages.spec.ts` の `outage_never_claims_dispatch_or_saved_success`）。staging・実Googleキーの停止・実provider・実在の正副担当の交代・実際の紙/電話への切替演習は**未実施**（docs/evidence/V07-outage.md「未実施」）。担当名は役割名で書く（実在の人名を書かない。D17未決）。

## 0. 原則（全障害共通）

1. **画面が「保存しました」と出したものだけが保存済み**。「結果を確認できません」「処理中です（完了ではありません）」「保留」「到達不明」は、いずれも完了ではない（docs/03 §1、src/client/components/MutationStatus.tsx）。
2. **同じ内容の再送は二重にならない**（同じ送信鍵。docs/05 §2）。結果が分からないときは、まず同期の状況（SCR-27 `/app/sync`）で照会してから再送する。
3. **アプリは正式な指令・連絡の唯一の手段ではない**。出動・通知の画面は常に「正式な指令/連絡ではない・補助」と表示している（出動一覧・出動詳細・通知一覧・通知の承認前確認・配送結果）。この表示が無い画面を見つけたら不具合として報告する。
4. 外部の請求・送信を**無限に再試行しない**（AIは保留へ、通知の到達不明は人の確認へ、jobは上限回数でmanual_reviewへ）。

## 1. 役割（担当。D17の推奨案＝正副担当。未承認）

| 役割名 | この手順での責任 |
|---|---|
| 正担当管理者 | 障害の判定・利用者への周知・復旧の確認。不在時は副担当が代行 |
| 副担当管理者 | 正担当の代行（ops/admin-handover.md）。正担当のセッション失効・業務継続 |
| 分団長（管理主体） | 正式連絡の責任者（ops/contact-flow.md）。管理者が全員不在のときの立会い |
| 幹部（通知の承認者） | 通知の承認と、到達不明の宛先への直接確認 |
| 記録係 | 紙帳票（手動帳票）の記入と、復旧後の入力・照合。アプリでは役割「幹部」（または「管理者」）が要る（出動記録の登録・実績の入力・報告書の手動作成。ops/contact-flow.md §5） |
| 環境管理者 | Cloudflare/Googleの管理画面での確認・キー/Secretの操作、`wrangler d1 execute` による読み取り確認（staging/production。Cloudflareの資格情報が要る） |

## 2. 障害ごとの手順（trigger / detection / fallback / recovery / 担当）

### 2.1 Googleのみ停止（地図・フォントが読めない）

- **trigger**: Google側の障害、ブラウザ用Mapsキーの停止/制限誤り、回線のGoogle向けだけの遮断。
- **detection**: マップ（`/app/map`）の地図面が表示されない／アイコンが文字（`search` `list` 等の英単語）で表示される。※現行の地図面はプレースホルダーで、Maps JavaScript APIはまだ接続していない（T021/V05の残）。実地図接続後は地図タイルの読込失敗として現れる。
- **fallback（ローカル演習で確認済みの操作）**:
  - スマホ: マップ上部の「**一覧**」ボタン → 「施設一覧」から対象の行（種別＋管理番号＋目印）を押す → 施設詳細（`/app/facilities/:id`）が開く → 「この施設を点検する」から点検登録へ。
  - PC: 右の「施設一覧」の検索欄（プレースホルダー「施設名・管理番号・住所」）に管理番号を入れる → 行を押す → 右パネルに「座標（外部マップへ送る値）」と管理番号 → 「点検を依頼」。
  - 経路はGoogleマップのURL（「Googleマップで経路を開く」）を外部アプリで開く。外部も使えないときは座標（緯度・経度）を紙/口頭で伝える。
- **recovery**: キーの制限・請求状態を環境管理者がGoogle Cloudコンソールで確認する（docs/07 §6）。地図が戻っても台帳（施設一覧）が正本なので照合は不要。
- **担当**: 検知=利用者→正担当管理者、キー確認=環境管理者。

### 2.2 AIのみ停止（Workers AIの障害・上限停止・応答が契約外）

- **trigger**: Workers AIの障害、日次/月次上限での自動停止（ops/cost-alerts.md）、モデル応答が契約外。
- **detection**: 報告書（`/app/reports?activity=<活動ID>`）で「AIで下書き生成」→「AIが下書きを作成しています（処理中であり完了ではありません）」→ しばらくして「**保留（AIだけで決めない）**」と理由（例:「この環境ではAIを使えないため…手動で作成できます」）。管理画面（`/app/admin`）の運用パネル「AI利用の費用と失敗」「費用・停止の記録（監査）」。
- **fallback**: 報告書の画面（`/app/reports?activity=<活動ID>`。辿り方: 予定・活動 → 対象の活動 → 「報告書を作る」。**幹部または管理者の役割**で、**活動に実績の記録がある**ときだけ作れる＝実績が無いと作成は拒否される）の「この活動の報告書」で、「AIで下書き生成」の隣の「**手動で作成**」→「実施内容」を入力 →「下書きを作成」→ 報告書の下書き画面（`/app/reports/<id>/draft`）へ。AIの分類候補（点検の異常）は人が分類を決める（AIレビューの承認を待たない）。AIアシスタントは「手動で探す」の導線（文書・規程の一覧）を使う。
- **recovery**: 上限停止なら ops/cost-alerts.md §3 の順で原因→解除判断。保留になったjobは終端なので、復旧後に必要なら**依頼し直す**（自動で再実行はしない）。
- **担当**: 帳票の手動作成=幹部/記録係、停止の解除判断=正担当管理者。

### 2.3 API保存応答の消失（保存は届いたが結果が分からない）

- **trigger**: 送信中の回線断・タイムアウト。サーバーには届いて保存されたが、応答だけが失われる。
- **detection**: 保存操作の直後に「**結果を確認できません**」（点検登録の場合「同じ内容で再送しても二重登録にはなりません。」）。「保存しました」は出ない。
- **fallback（同期結果照会）**: メニューの「**同期の状況**」（`/app/sync`）を開く。結果不明だった操作（点検の保存・本人出欠・参集の記録）は同じ送信鍵のまま「同期待ちの入力」に入っている → 「**今すぐ同期**」→ 一覧が「同期待ちの入力はありません。」になれば照会・再送が済んでいる（反映はサーバーが確認できたものだけを数える）。競合・拒否が出たら画面の案内（「現値の版で送り直す」等）に従い、自動上書きはしない。
- **recovery**: 施設詳細（`/app/facilities/<id>`）の「最新の点検」が今回の内容であることを確認する。**画面には点検の履歴一覧が無い**（最新1件だけを表示）ため、二重になっていないか（件数）の確認は環境管理者がD1を読み取りで確認する（ローカル演習ではAPI `GET /api/v1/facilities/<id>/inspections` で1件を確認した）:
  ```bash
  # 読み取り（SELECT）だけ。施設IDは施設詳細のURLの末尾
  npx wrangler d1 execute DB --env staging --remote --command "SELECT COUNT(*) AS n, MAX(inspected_at) AS latest FROM facility_inspections WHERE facility_id = '<施設ID>'"
  ```
- **担当**: 入力者本人。同期できない（拒否が続く）ときは正担当管理者。件数の確認（D1の読み取り）は環境管理者。

### 2.4 Queues障害（jobの送信失敗・配達遅延）

- **trigger**: Queueへの送信失敗、consumerの停止。
- **detection**: 依頼した処理（AI生成・添付検査・通知配送）が「処理中です／受け付けました。処理が終わるまで完了ではありません」のまま進まない。運用の監視項目 `jobs.lease_expired`（ops/cost-alerts.md §2のコマンド）。
- **fallback**: 何もしない（**待つ**）。jobはD1に `queued` で残り、毎分のCron（`handleScheduled`）が回収して実行する（Queue送信に失敗してもjobは失われない＝workers試験 `tests/jobs.test.ts` の `queue_send_failure_does_not_lose_the_job_and_cron_recovers_it`）。急ぐ帳票は2.2の手動作成。
- **recovery**: 滞留jobの確認（staging/production。Cloudflareの資格情報が要るため**環境管理者**が行う。**`--yes-i-know` はwranglerのフラグではない**＝本番誤適用ガードは `npm run migrate`〔scripts/migrate.ts〕専用。ここでの `wrangler d1 execute` は**読み取りのSELECTに限る**）:
  ```bash
  # 終わっていないjobの件数（種類・状態ごと）。queued/retry_waitが減っていけば回収されている
  npx wrangler d1 execute DB --env staging --remote --command "SELECT kind, status, COUNT(*) AS n, MIN(created_at) AS oldest FROM jobs WHERE status IN ('queued','running','retry_wait','manual_review') GROUP BY kind, status"
  ```
  `manual_review`（上限回数で止まったjob）は自動では再実行しない。内容を見て、必要なら元の画面から依頼し直す。
- **担当**: 環境管理者（滞留確認のSELECT・Queue/consumerの状態確認）、正担当管理者（manual_reviewの依頼し直しの判断）。

### 2.5 通知の到達不明（provider障害・宛先不明）

- **trigger**: providerの応答タイムアウト、宛先が解決できない。
- **detection**: 通知の配送結果（承認した直後の同じ画面。**送信した通知の一覧画面は無い**〔docs/03 §1.1-14の既知の制限〕ため、後から開くには通知のURL `/app/tasks-notifications/notifications/<id>` を控えておく）で「**到達不明**」が1人以上（終端の札も「配送の処理を終えました（到達不明あり・要確認）」と黄色で出る） → 「**結果を確認**」で対象者の氏名と「宛先の結果が確認できていません。無条件の再送は行われないため、対象者に直接確認してください。」。受付済み・到達不明・既読は別の行で数える（受付≠到達≠既読）。監視項目 `notification.delivery_unknown`。
- **fallback**: 幹部が対象者へ**既存の連絡手段（電話・対面・既存連絡網）で直接確認**する（ops/contact-flow.md §2）。アプリから同じ通知を作り直して再送しない（同じ人に二重に届く恐れ）。
- **recovery**: 直接確認の結果は紙/連絡記録に残す。アプリの「到達不明」表示は直接確認後も**そのまま残る**（到達したことにしない）。
- **担当**: 幹部（通知の承認者）。

### 2.6 正担当の管理者不在

- ops/admin-handover.md の手順（副担当が管理画面から正担当の全セッションを失効させ、業務を続ける）。

## 3. ローカルでの演習（再現手順）

```bash
# 6つの障害を順に注入する演習（phone-360とdesktop-1280の2サイズ。webServerがD1再作成→migration→初期管理者→wrangler dev まで自動で行う。
# 手動の wrangler dev を先に起動しておくと「already used」で止まる＝ポート8787を空けてから実行する）
npm run test:e2e -- tests/e2e/dependency-outages.spec.ts --grep outage_never_claims_dispatch_or_saved_success
# Queue送信失敗の観測（workers試験。e2eでは本番に試験経路を足さないと注入できないため）
npx vitest --run tests/jobs.test.ts -t queue_send_failure_does_not_lose_the_job_and_cron_recovers_it
```

注入の方法と観測値の定義は試験ファイル冒頭のコメントと docs/evidence/V07-outage.md。

## 4. 未実施（実環境）

docs/evidence/V07-outage.md「未実施」の番号付き残手順を正本とする。実Cloudflare/staging/実キーが要るもの（staging演習・実Googleキー停止・ops/security-response.md §7の遮断/rotation演習・実Queuesの送信失敗観測・管理者全員喪失時のCloudflare側復旧手順の整備）は**T086**、消防団の人・了承・D13決定が要るもの（実providerの到達不明・実在の正副担当の交代・別担当〔人〕による再現・紙/電話の切替と復帰照合の実地演習・代理の参集記録の担当を付ける画面）は**T088**が引き受ける（V07-outage.md「未実施」1〜10。T086=1,2,7,8,9／T088=3,4,5,6,10）。
