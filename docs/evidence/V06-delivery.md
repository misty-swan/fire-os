# V06 通知の配送provider・再送安全性（T051局所／実チャネルは未実施）

方式: **チャネル抽象化（NotificationProvider）＋D1台帳による再送安全性**（docs/02 §5「外部効果の一回性はhandlerの責務」、docs/11 配送、docs/14 D13/D16）。実装は `src/server/notifications/provider.ts`（provider登録点・inapp内部成立provider）、`src/server/notifications/dispatcher.ts`（dispatchNotification・cancelUnsentDeliveries）、`src/server/jobs/handlers/notification.ts`（notification.deliver jobの登録点）。

## 実施したこと（ローカルworkerd＋ローカルD1。実チャネルはfake adapter）

| 確認 | 結果 | 試験 |
|---|---|---|
| 承認（API-64）が登録した配送jobがdeliveries行を宛先ごとに1本だけ作る（delivery_key=`通知ID\|recipientId\|channel`の固定キー・UNIQUE。attempt_count=1で作る） | 合格 | `unknown_delivery_is_not_blindly_retried` |
| providerの明確な拒否（failed）はretry_waitになり、jobの再試行で**同じdelivery_keyのまま**再送される（attempt_count=2。台帳側で二重作成しない） | 合格 | 同上（deliveryKeysAcrossRetries=[fixedKey,fixedKey]） |
| unknown（受付の成否不明）は**無条件に再送しない**。2回目の実行でprovider.sendを呼ばない（非冪等providerへの2回目のsendが起きない） | 合格 | 同上（unknownNonIdempotentSendCount=1） |
| 受付後タイムアウト（providerが応答しない）でrunnerに打ち切られsendingに取り残された行は、再実行でもsendせずunknownへ確定する | 合格 | `duplicate_and_timed_out_runs_never_send_twice` |
| 再試行上限（job 3回）まで全員に拒否されたらjob=manual_review・通知=failed・attempt_count=3（試行履歴はnotification_eventsに3本追記） | 合格 | `delivery_retry_exhaustion_marks_notification_failed` |
| 受付（provider_accepted）は既読（recipients.read_at）を作らない（受付≠到達≠既読。docs/07 §5） | 合格 | `unknown_delivery_is_not_blindly_retried`（acceptedMarkedRead=false） |
| 未送分の取消はdeliveries単位（docs/11）。全宛先の行を先に確保してからpendingだけcancelledへ（取消後にjobが走っても送らない・新規pendingを作らない） | 合格 | 同上（afterCancellationUnsentCount=0） |
| 期限切れ（expires_at経過）の承認済み通知は送らない（deliveries行を作らず、dispatch.expired履歴。承認状態は変えない） | 合格 | `delivery_skips_expired_notifications_and_inactive_recipients` |
| 退団（retired）・休団（paused）宛先は配送直前で除外（行を作らずdelivery.skippedに記録。承認時の検査はactive・同unit） | 合格 | 同上 |
| 確定済み（finished/failed）の通知jobの二重実行では何も送らない | 合格 | `duplicate_and_timed_out_runs_never_send_twice` |

実チャネル（Web Push/email）は**未選定**（docs/14 D13未了承）。試験は宛先ごとに挙動を注入できる記録型fake adapter（`tests/notification-delivery.test.ts`）でprovider.sendを置き換えて行った。channel='inapp'の既定providerは「内部成立」（recipients行そのものが受信箱＝API-67/100が読む。外部への送出は無いため即座にprovider_acceptedを返す）。

## 方式の決定（docs/16 T051のコントローラ裁定どおり）

1. **delivery_keyは再試行で不変**（`${通知ID}|${recipientId}|${channel}`）。deliveriesのUNIQUEが行の二重作成を防ぎ、送信対象はpending/retry_waitの行だけ。unknownとsending取り残しは送り直さないため、非冪等な実providerへ同じ通知を2回出す経路が無い。
2. **unknownは「照会/人確認」に回す**（無条件再送しない）。実providerが照会APIを持たない場合、unknownは人手で受信確認してから手動で確定する運用になる（T052以降の画面/契約）。
3. **通知レベルのfinished/failed**は受付>=1でfinished／受付0件で拒否・未送の残はfailed／全件unknown・全件取消・0件送信（期限切れ・全員退団）はfinished。個別のdelivery状態が正本で、通知レベルのfinishedは到達を意味しない。
4. **未送分取消（cancelUnsentDeliveries）はAPIに出さない**。T052の取消導線が使うサーバー関数として実装（API化が必要なら契約追加とセット）。

## 未実施（検証済みとして扱わない）

**実端末へのWeb Push/emailの一経路は未実施。** 理由: ①この環境の`wrangler`は未ログインで実Workers/実Queuesが使えない、②チャネルの選定（docs/14 D13＝通知チャネル・送信許可・既読の了承）がまだ。fake adapterでの成功を「実端末への到達」とは扱わない。

D13の比較観点（了承取得の材料。**採否は未決のまま手順だけを残す**）:

| 観点 | Web Push（推奨案の片方） | email（もう片方） |
|---|---|---|
| 許可・登録 | 端末ごとのPush許可が要る。許可拒否・再登録（subscriptionの失効・更新）の運用が要る。通知対象者＝団員と端末の対応（users↔端末）を保存する表が要る | 連絡先emailの実在・検証（自分の連絡先でのみ受信可）。D02の許可列にemailは現状含まれない（phone/emergencyContactのみ＝docs/14 D02のPH1検証設定）→**許可列の拡張が必要** |
| 費用・Secret | Push送信は自前（VAPID鍵ペアをSecretへ。`wrangler secret put`。無償）。ブラウザPushサービス（FCM/APNs等）への依存 | 送信API（Resend/SendGrid等）の契約・APIキーをSecretへ。送信ドメイン認証（SPF/DKIM）と月額/通数課金が要る |
| 配送照会 | 受付＝ブラウザPushサービスの受領まで。端末到達はサービスが保証しない（既読は本人操作のみ） | バウンス・開封はAPI次第。開封追跡はプライバシー上使わない方が良い（既読は本人操作のみ＝docs/11） |
| 冪等性 | subscriptionの再発行で同一端末に重複配信が起こり得る。delivery_keyをprovider側のidempotencyへ渡せるか要確認 | Message-IDを持たせれば重複受信を追跡できる（送信API次第） |
| 個人情報 | 通知本文に個人情報を載せず、受信箱（inapp）への誘導に留める方針（docs/07 §5）と親和 | email本文に本文全文を載せるか（転送・保存のリスク）方針が要る |

残作業と手順（ユーザーの操作が必要）:
1. D13の提案資料に上表を添えて消防団へ了承を求め、チャネルを1つ選定する（docs/14 D13。決定者＝連絡責任者・管理主体）。
2. 選定後にSecretを設定する: Web Pushなら `npx wrangler secret put WEBPUSH_VAPID_PUBLIC_KEY` ＋ `WEBPUSH_VAPID_PRIVATE_KEY`、emailなら `wrangler secret put EMAIL_API_KEY`（wrangler未ログインのため現環境では実施不可）。各環境（staging/production）ごとに設定する。
3. 選定チャネルのproviderを `src/server/notifications/provider.ts` へ実装し（`registerChannelProvider`）、channel列挙（states.ts notificationChannels）・0022のchannel CHECK・API-63の契約を一緒に拡げる（docs/11 T050注記どおり）。
4. `npm run test:live -- tests/live/notification-delivery.test.ts` を実行（`LIVE_BASE_URL`/`LIVE_BOOTSTRAP_EMAIL`/`LIVE_BOOTSTRAP_TOKEN`/`LIVE_DELIVERY_CHANNEL`。stagingへのデプロイはV01/V02の手順と共通）。実端末での受信・拒否・不明を確認し、証跡（スクリーンショット・受信ヘッダ・API応答）をこの文書へ追記する。
5. 実データ投入前に、通知本文の個人情報方針（docs/07 §5）とemailの許可列（D02）をD13/D02の正式決定として記録する。

この手順を実行するまで、V06は **局所のみ検証済み・実チャネル/実端末は未検証**。RG-07/10は引き続き阻止される。通常通知（COM-02/ACT-05/AST-04）を「完成」とは扱わない。
