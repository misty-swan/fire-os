# PH6 実行証跡（2026-10-17）

対象: T072〜T077（認可済snapshot・イベント再開cursor・差分取得・30端末の更新配信・切断後snapshot回復・PWA shell・端末下書きの分離/期限/消去・保留操作の同期API・通信断入力/写真先行同期/競合解消画面）。実行環境はローカル（Node v26 / workerd / wrangler 4.x / vitest / Playwright chromium）。**実Cloudflareアカウント・実D1・実R2・実Queues・実AI・実Google Maps・実端末・実30端末は使っていない（wrangler未ログイン。PH0〜PH5から継続で未接続）**。D1はwranglerのローカルシミュレータ。migrationは0031（sync_operations）を空DBから適用（各試験実行時に自動）。**計画（docs/16）のT076 Files表記「0025_sync.sql」は陳腐で、現行0030の次連番0031を採番**（T071の0030前例どおり欠番防止。docs/16 T076に裁定記録）。データはすべて架空。実装はsubagent-driven（タスクごとに実装サブエージェント→タスクレビュー→必要なら修正ラウンド）で遂行し、個別のタスクレビューで高・中0件を確認済み（詳細はdocs/evidence/ph6-review.md）。

## 実行結果
| 確認 | コマンド | 結果 |
|---|---|---|
| 型検査 | `npm run typecheck` | 成功 |
| 契約検査 | `npm run check:contracts` | 102 API / docs/05 102行 / OpenAPI一致（API-80をprovisional解除〔EventPage=events/resumeCursor/resyncRequired〕・API-70へsnapshotCursor追加の契約3点セット〔台帳・docs/05・OpenAPI〕をT072が同一コミット更新。API-81/82のDTO・docs/05・OpenAPIはT072〜T077で不変） |
| 単体・結合試験 | `npx vitest --run` | **57ファイル263件成功**（workers＝実workerd＋D1/Queues、client＝jsdom。PH5最終は52ファイル248件。T072=53/249→T073=55/253→fixラウンドで254→T074=55/254→T075=56/260→T076=57/263→T077=57/263〔クライアント結合はe2eで担保〕） |
| ブラウザ試験 | `npm run test:e2e` | **87件成功＋3件スキップ**（宣言45本×phone-360/desktop-1280＋setup project（auth.setup.ts）1件＝計91。desktopは既存のビューポート条件2本〔member-admin 44px・shell メニュータブ〕＋押下領域1本〔assistant入力まわり〕の条件スキップ3本で43本中40本実行。PH5から継続）。**フル実行でdocuments.spec desktopが1件のみフレーク**（作成直後の「保存しました」トースト断言。ph5-review.md記録の既知flap型。単独再実行は緑） |
| ビルド | `npm run build` | 成功（precache 9 entries / sw.js生成。chunkサイズ警告は既存どおり） |
| 実環境の試験 | `npm run test:live` | **未実施（実Cloudflare未接続。PH2〜PH5と同じ扱い）**: LIVE_*環境変数が揃わないためtests/live/の**9ファイル9件**がすべて「環境が未設定のため未実施」のエラーでfail（skipにはしない設計。PH5終了時の8本＋PH6追加のrealtime-load〔T073〕。このharnessは実30端末測定＝V06-realtime残手順の実行体） |

## タスク別の指定試験
T072 `snapshot_to_subscription_gap_never_loses_committed_event`（tests/events.test.ts新規）/ T073 `reconnect_ignores_old_entity_versions_and_resyncs_expired_cursor`（tests/realtime.test.ts新規）＋ `incident_detail_receives_remote_updates_and_resyncs_after_role_change`（tests/e2e/realtime.spec.ts新規。実ブラウザ×2幅）/ T074 `offline_cache_contains_no_api_response_or_google_tiles`＋`sw_update_notifies_and_does_not_destroy_unsaved_input`（tests/e2e/pwa-cache.spec.ts新規。実ブラウザ×2幅）/ T075 `account_switch_and_expiry_never_restore_another_users_draft`（tests/offline-store.test.ts新規）＋ `account_switch_never_leaves_or_shows_another_users_offline_draft`（tests/e2e/offline-account-switch.spec.ts新規。実ブラウザ×2幅）/ T076 `sync_replay_after_lost_response_has_one_effect_and_same_result`（tests/sync.test.ts新規）/ T077 `offline_conflict_never_uses_last_write_wins`（tests/e2e/offline-sync.spec.ts新規。実ブラウザ×2幅）— すべて成功。

## 赤→緑の扱い（正直な記録）
- **6タスク全報告書に実装前の赤確認記録が残る**。赤の根拠はすべて「対象機能の未実装」で、runner故障や構文エラーではない: T072/T073の1回目は新規leafモジュール（cursor.ts/transport.ts）の解決失敗＝runner由来のため**赤を取り直し**（leafの型だけ先に作成してから「snapshotCursor未実装」「route未接続404」の正当な赤を取得。T072/T073両報告書に記録）、T074（e2e）はSW未登録による2件FAIL、T075はIndexedDB store未実装のimport解決失敗→store骨格作成後に「別ユーザーdraft復元」の正当な赤を取り直し（task-75-red.md）、T076はroute未接続の404、T077（e2e）はSCR-27未実装（evidence-t077/red.md）。
- **T077は変異試験の初回で検出できず試験を強化した**: 写真先行ゲート削除の変異が初回のcompletion断言を通過したため、「completionを再接続まで遮断する2フェーズ構成」にe2eを強化してからDETECTEDを確認（evidence-t077/green.md。PH5のT067/T068と同型の試験強化経路）。競合をappliedと偽る変異もDETECTED（計2本）。
- **実装中の往復（各報告書に実記録）**: T072（D1 batchの応答形式・409へのdetails.reason区別〔cursor_invalid/cursor_expired/authz_changed/filter_changed〕）、T073（**満杯ページの更新採用破棄＝レビューで検出されたImportant**〔fixラウンド1・c1b5a94。50の倍数件の追い上げでsetSyncTick不発・appliedVersionRefが先行し自己回復しない→pendingAdvanced採用保持＋境界テスト〕）、T074（Playwrightでdist書き換えによるSW更新試験がwrangler再読み込みで他specを壊す→「別URL同scope登録＋route差替」の合成だが実経路（install→待機→SKIP_WAITING→claim）を通す方式に変更＝specと報告書に記録）、T075（**T074のpurgeUserCachesをlogoutへ接続すると生きたSWが削除済みprecacheを参照してERR_FAILED**になることをe2eが検出→「下書き・写真のみ消しprecacheは残す」へ設計変更。docs/07 §4・docs/14 D14に記録）、T076（自己レビューでallowlist照合のprototype key経路〔`toString`等〕を発見→Object.hasOwn化＋テスト追加）、T077（offline-syncの初期completion断言が変異を通す→2フェーズ化）。

## 試験が検出した（または発覚した）欠陥と弱さ
- **レビューサイクル検出のImportant 1件**: T073の満杯ページ採用破棄（前節どおり。fixラウンド1で修正・再レビューADDRESSED）。
- **e2eが検出した設計変更 1件**: T075のlogout purge（前節どおり。T074の設計では正しかったがlogoutへの配線時に壊れることが判明）。
- **自己レビューが検出した欠陥 1件**: T076のprototype key防御（前節どおり）。
- **既存の弱さ（PH5からの継続。PH6で新規に拡大していない）**: ①documents.spec desktopのトースト断言フレーク（フル実行で1件再現・単独は緑。ph5-review.md既知）②reports.spec desktopも同型のフル走行時フレーク（T077のフル実行で1回観測・単独は緑。T082以前に観察継続）③実環境・実端末の未接続（V01/V02/V04/V05/V06/T083）。

## 未実施・未接続（検証済みとして扱わない）
- **実環境検証はPH0〜PH5から継続で未実施**: 実Cloudflare・実Workers・実D1・実R2・実Queues・実AI・実Vectorize・実Google Maps・実端末（iOS/Android・スクリーンリーダー・200%拡大・実端末でのPWA install・quota・永続化はT083）。GitHub Actionsも未接続。`npm run test:live`は**未実施（実Cloudflare未接続）**。live試験は9ファイル9件が**環境変数が揃わなければ必ずfailする設計（skip＝成功扱いにしない）**。
- **局所完了の2タスク（T073＋T077。T073の残手順の正本はdocs/evidence/V06-realtime.md。T077は開始条件のT033が部分完了のままの着手＝T033完成時の点検訂正UI〔API-46のoffline capture〕との接続が残る。接続作業はT033側に割当＝docs/16 T033/T077状態欄）**:
  - **実30端末の測定（V06-realtime。D16/D18）**: ローカル実測は「同一workerd＋同一D1への30本poll接続」で更新反映p95≈2.29〜2.33秒（D18開発案5秒以内）。**実回線RTT・パケットロス・端末の電池最適化・30利用者の認証負荷は含まない。D1読み取りの金額換算は未実施（T082）**。実30端末の測定手順は`tests/live/realtime-load.test.ts`（環境変数が無いと必ずfail）とV06-realtime.mdに記録。poll方式の固定は**暫定固定**であり、実環境でp95 5秒を満たせなかった場合はSSE/DOを再評価する（V06-realtime.mdの比較表と合否基準）。
- **T072**: 未収録entity種別（report・invitation等）は既定非可視（fail-closed。docs/05 API-80行に記載）。非可視行のACL判定は1行ずつのSQL（上限1000行/リクエスト。**docs/14 D16に実測課題として追記済み**〔初回証跡で「D16に記録」と書いたがD16側の記録が無かった。PH6レビューround 1でD16へ追記し、本行はそこを指す〕）。cursorはAES-GCM＋HKDF（BETTER_AUTH_SECRET由来。新Secret不要）で24h保持。
- **T073**: 更新チェックはnavigation時＋2秒pollの範囲。長時間表示端末の扱いはT075の期限表示と合わせてT083で検討。
- **T074**: Google Fontsがcross-originのまま（offlineでアイコンがリガチャ名に劣化。自己ホスト化は後続検討）。SW更新の検知はnavigation時のみ。実端末でのinstallはT083。**完了の扱い（PH6レビューround 1で明記）**: 実端末install検証はT083先送り〔記録済み〕だが、実30端末の測定そのものが完了条件内にあるT073とは異なり、shell・キャッシュ除外・更新案内の機能完了を以て完了扱いとする（docs/16 T074状態欄）。
- **T075**: quota試験はエラー経路注入（実端末の容量挙動はT083）。e2eの下書き作成はIndexedDB直接seed（draft作成UIはT077で接続。schemaずれは赤で検知する構造）。purge失敗時はlogout継続→次ログイン時に掃除（コメント＋e2e担保）。
- **T076**: 台帳は成功（applied）のみ記録し、失敗は再送時に再導出（副作用ゼロ）。conflict/rejectedは語彙のみ予約。payloadHashはクライアント整合性用でサーバー再計算なし（IDEMPOTENCY_MISMATCHはrequestHashで強制）。API-46のsync化は点検訂正フォーム（T033残作業）が無いためallowlistのみ先行。
- **T077**: 点検訂正の競合は現値比較用の単件GET契約が無いため「手動再入力」の注記表示（API-21重複fetch問題と接続。docs/03 §1.1-22）。API-82照会分岐は到達不能コードとして残存（「照会優先」はT076台帳の同鍵再送で機能充足＝重複適用なしをe2e断言。PH7で再確認）。offline遠隔消去は保証しない（D14未決どおり）。

## prototype準拠
実ブラウザ試験が通った画面: 同期の状況（SCR-27。**prototypeに専用画面が無く共通部品で構成**。docs/03 §1.1-22新設。offline-sync.spec×2幅）。出動詳細（SCR-12。T073でオンライン/オフラインの札と「同期をやり直しています」の表示を追加。**T047のuseOnline（通信状態）を再利用し、ConnectionState型はT073で新設＝第二の真実源なし**〔初回記録の「ConnectionState語彙を再利用」は実装と違ったためPH6レビューround 1で訂正。docs/16 T073も同じ訂正〕。realtime.spec×2幅）。シェル（T074で**更新案内の札**を追加＝prototypeに無いためdocs/03 §1.1-21に記録。更新は利用者の選択＋再読込しない）。トークン（更新札・同期札は中立色。AI紫・警告色は既存規約どおり）と44px押下領域（`max-lg:min-h-11`等）・トースト位置・LeaveConfirm・404案内のrole=alert・処理中のrole=statusは既存共通UIどおり。offline時に取得できないデータを表示可能と偽装しない（T074のSW設計・T077の「未同期」表示・applied前の完了表示禁止）。実端末・スクリーンリーダーはT083で未確認。prototypeから意図して変えた点はdocs/03 §1.1の21〜22に理由つきで記録（更新案内の札・SCR-27の構成とoffline注入の限界・draft捕捉をuseMutation層で接続した点・点検訂正の競合注記）。§2のSCR-12/27行は実装内容を追記済み。
