# セキュリティ事象対応の手順（検知→連絡→遮断→鍵rotation→再開）— T081

目的: 漏えい・不正アクセス・濫用・鍵の漏洩・データ消失の疑いがあったときの**初動を、このリポジトリの手順だけで再現可能にする**。正本は docs/07（セキュリティ・運用設計）、docs/10（権限マトリクス）、docs/13（リリース判定基準）。データ復旧そのものは ops/backup-restore.md、費用の停止と解除は ops/cost-alerts.md を使う。**本書の連絡先・責任者はプレースホルダ（`<>`）であり、管理主体（D17）の確定で埋める**。

**現状の正直な限界（2026-10-17時点）**: この開発環境は実Cloudflareに未接続のため、①実ペネトレーションテスト・実WAF/CDN層での防御は**未実施**、②本書の手順の**実環境での演習も未実施**（workers試験とローカルでの動作確認まで。§7に初回演習の手順）。アプリ内のレート上限はWorkerのisolate内メモリの防衛線で、**厳密な全体上限はCloudflare側（WAF/Rate Limiting）で行う前提**（docs/evidence/security.md）。

## 0. 事象の分類（初動を決める入力）

| 分類 | 例 | 最初に何をするか |
|---|---|---|
| 濫用（可用性） | 429の急増、同期の拒否（`sync.rejected`）急増、添付検査拒否の急増 | §1で源を特定→§3.4（レート/WAF）→原因が内部なら§3.1 |
| 不正アクセス（機密性） | 知らない端末のセッション、権限外データの参照疑い | §3.1〜3.2（停止・失効）→§4（鍵rotationを検討） |
| 鍵・Secretの漏洩 | Secret誤公開、リポジトリ混入、端末紛失 | **§4を最優先**（rotateしてから調査） |
| データの消失・破壊 | 誤削除、復旧が必要 | ops/backup-restore.md（遮断が先。§3.2） |

## 1. 検知と状況把握（何が起きたか）

1. **入口は3つ**: ①管理画面の運用パネル（SCR-17 `/app/admin`。費用・停止・監視項目）、②監査ログ（`audit_logs`。追記専用で書換え不可）、③利用者・管理者からの連絡。自動アラート送信は作っていない（通知は本文/対象の明示承認を要するため。監査記録＋管理表示＋この手順を人が動かす。docs/07 §8）。
2. 濫用の兆候は数値で見る（ops/cost-alerts.md §2のコマンドと同じ。429は`ai.rate_limited`、同期の拒否は`sync.rejected`、添付の検査拒否は`attachments.scan_rejected`）:
   ```bash
   npx wrangler d1 execute DB --local --command "SELECT day, metric, SUM(amount) AS n FROM usage_metrics WHERE day >= date('now','-7 day') GROUP BY day, metric ORDER BY day DESC"
   ```
3. **エラーログの読み方**: 予期しない内部例外は `{"requestId": "...", "error": {"name": "...", "digest": "..."}}` の形で出る（**例外本文は出ない**。src/server/security/redact.ts。本文に要求値・認証情報が含まれるため）。同じ入力の再現で詳細を確認し、`requestId`で要求と突き合わせる。`wrangler tail`で生の要求を見る場合も、credentialや個人情報をそのまま貼らない（マスクして記録する）。
4. 時刻（UTC）・事象・requestId・判明した範囲を**最初に記録し始める**（§6の証跡）。

## 2. 連絡（0〜60分の目安）

| いつ | 誰に | 連絡先 |
|---|---|---|
| 分類できたら直ちに | 運用責任者（副担当も。D17で確定） | `<運用責任者の連絡先>` |
| 個人情報の漏えい疑い | 管理主体の責任者 | `<管理主体の責任者>` |
| 鍵の漏洩・請求の異常 | Cloudflare/Google等の契約窓口 | `<各サービスのサポート窓口>` |
| 法令上の報告義務の確認 | 管理主体（個人情報保護の窓口。D02/D17） | `<法令対応の窓口>` |

- 連絡の記録（いつ・誰に・何を）も§6の証跡に残す。被害の確定前でも「疑い」の段階で連絡する（確定を待たない）。

## 3. 遮断（被害の拡大を止める。原因究明より先）

1. **特定の利用者**を止める（次の要求から401。Cookieが残っていても業務は拒否される。docs/07 §2）:
   ```bash
   # ①業務側の停止（authz_version増分つき。API-38が動かない場合の直接手順）
   npx wrangler d1 execute DB --local --command "UPDATE users SET status='disabled', disabled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), authz_version=authz_version+1 WHERE id='<対象のuser_id>'"
   # ②セッションの失効（基準時刻より前のセッションを業務APIが拒否。API-38と同じ機構）
   npx wrangler d1 execute DB --local --command "UPDATE users SET session_revoked_before=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='<対象のuser_id>'"
   ```
   対象の特定は監査と名簿から: `SELECT id, user_id, display_name FROM members WHERE ...`。名簿の休団（`members.status='paused'`）でも同じく401になる。
2. **分団全体**を止める（漏えいの範囲がunitに及ぶ疑い）: `UPDATE units SET status='disabled' WHERE id='<unit_id>'`。解除は `status='active'`。
3. **高価な系列（AI等）を止める**: ops/cost-alerts.md §3.6の手順（`budget_state`を`stopped, source='manual'`へ。手動停止は自動解除されない）。既存記録の閲覧は止まらない。
4. **外部からの洪水**: アプリ内のレート上限（`src/server/security/limits.ts`。auth/ai/search/upload/既定の5バケット）はisolate内の防衛線。**全体を確実に止めるにはCloudflareのWAF/Rate Limitingルール**（ダッシュボードまたはTerraform。T086で設定手順を確定する。それまではダッシュボードの手動設定）。特定IPの遮断もCloudflare側で行う。
5. **遮断の記録**: 実行したSQL・時刻・実行者を監査に残す（`audit_logs`へのINSERT。§6）。

## 4. 鍵・Secretのrotation（漏洩が疑われるら最優先。順序は「rotateしてから調査」）

| Secret | 影響と手順 |
|---|---|
| `BETTER_AUTH_SECRET` | 認証sessionと同期cursorの鍵（src/server/events/cursor.ts）。rotateすると**全員のログインと同期cursorが無効**になる（再ログイン・再同期が必要＝安全側）。`npx wrangler secret put BETTER_AUTH_SECRET --env <環境>`。staging/productionは別の値（wrangler.jsoncに書かない。Secretは設定に載せない） |
| Google Maps browser key | 露出前提で運用（リファラー制限・API制限が前提。docs/07 §6）。漏洩時はGoogle Cloud Consoleで再発行→`wrangler secret put GOOGLE_MAPS_API_KEY --env <環境>`（名称は実装に合わせる）＋旧keyの無効化と制限見直し |
| AI/通知providerの鍵 | 各providerで発行し直し→`wrangler secret put`。呼出し失敗はjobがmanual_reviewになる（停止が正しい。偽の応答を作らない） |
| R2/D1のアクセス | CloudflareのAPI tokenを無効化・再発行。R2のバケット参照はbindingなのでtoken変更でアプリは壊れない |

- rotation後の確認: ログイン→業務API→同期（cursor再取得）→添付→AIの順に手動確認する。**rotationの実施記録も監査へ**。

## 5. 復旧・再開の判定

1. 原因が排除された証拠（遮断の対象・範囲・期間を明示）を揃える。
2. 遮断の解除（§3の逆手順。利用者単位は `status='active', disabled_at=NULL`。budgetはops/cost-alerts.md §3.4の評価つき解除）。
3. **限定確認**: 解除対象の利用者でログイン・閲覧・同期を実際に確認してから全体再開。データを復旧した場合は ops/backup-restore.md の照合（sessions失効・ACL・集計）を先に済ませる。
4. **再開の承認は管理主体**（人。システムが自動再開しない。docs/13の判定基準も参照）。
5. 監査への記録（`security.incident` 相当のactionで、metadataに事象id・範囲・判断）と、§6の証跡を閉じる。

## 6. 証跡（何を保存するか）

- 時系列記録（検知→連絡→遮断→rotation→再開。UTC。誰が実行したか）
- 実行したSQL/wranglerコマンドとその結果、`requestId`とエラーログの写し（credential・個人情報は**マスク**してから保存する）
- `audit_logs`のダンプ（該当期間。監査は追記専用で正本。`SELECT * FROM audit_logs WHERE occurred_at BETWEEN ... ORDER BY occurred_at`）
- 連絡の記録（いつ・誰に・何を伝えたか・返答）
- 保存先と保持期間はD10（未決）。決定まで実データを載せない（架空データの手順演習のみ）

## 7. 演習（未実施。初回の手順）

1. staging環境（`wrangler`の `--env staging --remote`。`--yes-i-know` はwranglerのフラグではなく `npm run migrate` 専用のガード）で架空の事象（テスト用利用者の不正アクセス想定）を作り、§1→§3.1→§5を通しで実施して記録する（実データを使わない）。
2. `BETTER_AUTH_SECRET`のrotation演習（staging限定。全セッション無効→再ログインを確認）。
3. Cloudflare WAF/Rate Limitingの設定と、アプリ内レート上限との役割分担をT086の公開設定で確認し、docs/evidence/security.mdと本書を実測で更新する（T084の障害演習はローカルのみで、この節の演習は含まない＝docs/evidence/V07-outage.md「未実施」7。担当T086）。
4. 演習の結果はこの節を「実施済み」に更新して残す（実施日・発見・修正）。
