# FireOS 設計ドキュメント総合レビュー

レビュー日：2026年10月13日（日本時間）  
対象：v0.2 未承認ドラフト、Git HEAD `0eee148b7dfe7fee51c77bd791525a2b896d2e03`  
判定：**重要事項の見直しが必要**  
指摘：**Critical 0件 / High 12件 / Medium 14件 / Low 2件（合計28件）**

本書は設計レビューであり、要件確定・団体の利用承認・稼働実証を意味しない。既存文書とソースコードは変更していない。改善案はすべて提案であり、採否を未決事項として残す。公式情報はレビュー日に取得した内容で、実アカウントでのAPI実行・料金請求・実機試験は未実施である。

## 1. 総合評価

### 1.1 完成度と実装開始の可否

企画・要件の骨格は良い。一方、画面とエンドポイントの一覧を中心とする論理設計であり、**P0の業務を保存・訂正・認可する契約が揃っていない**。このまま業務実装を始めると、活動実績・点検・出動・添付・権限の実装担当が仕様を独自に決めることになる。完成度を根拠のない百分率には換算しない。

| 評価対象 | 評価 | 根拠 |
|---|---|---|
| 目的・初期規模・安全境界 | 良好 | 単一分団、AIなしのP0、正式指令からの分離を各文書で概ね維持 |
| 要件の網羅性 | 概ね良好、一部不一致 | 日常活動・GIS・資機材・出動・文書を包含。P0の出動関連付けとP1の使用履歴が重複 |
| Cloudflare中心の実現性 | 可能 | 基本CRUD・座標範囲検索に必要な機能はある。認証CPU、D1更新方法は実証が必要 |
| データ・APIの実装準備 | 不十分 | P0操作の欠落、実績・点検明細・関連データの保存先不足、原子性未確定 |
| セキュリティの方針 | 良好、具体化不足 | サーバー認可・非公開R2・デモ分離は明記。担当範囲と添付失効の契約が未確定 |
| テスト・運用の準備 | 不十分 | 完了条件に相違。複数のP0要件に受入シナリオがない |

**業務実装の開始判定は「重要事項の見直しが必要」**。架空データを使う認証・D1・地図の限定的な技術検証は進められる。これは現状設計の承認や、本番利用の許可とは別である。

### 1.2 優れている点

- 要件ID・P0/P1/P2・画面ID・API-ID・TC-IDがあり、追跡表を補えば変更の影響を管理しやすい。
- 施設→点検→異常対応、予定→出欠→実績、出動→参加記録という業務の接続を意識している。
- 出欠回答と実参加を別フィールドにしている。点検原本、AI候補、人の確定を区別する方針も妥当。
- AIは分類・下書きに限定し、期限計算・認可を決定論的処理に分けている。AI停止でも原本が残る。
- 単一Workersのモジュラーモノリス、D1とR2の役割分担、地図障害時の一覧代替は規模に合う。
- Google Mapsの無料枠を無制限と誤認せず、予算通知が課金停止にならないことも明記している。
- 正式指令・現場指揮・安否確認の唯一の手段から除外し、公開デモを架空データに限定している。

### 1.3 最大のリスクと改善方針

**最大の技術的リスク**は、D1の複数更新、再送、添付確定を「方針」のまま実装し、点検だけ保存・異常起票なし、対応状態だけ変更・履歴なし、退団済みでも添付取得可能といった部分的成功を生むこと。ライブラリの採用自体が実装不能という証拠はない。

**最大の要件上のリスク**は、担当範囲・機微情報の閲覧範囲・確定状態と、P0完了条件が曖昧なこと。実団体の未承認事項を開発者の判断で固定してしまう危険がある。

改善は、(1)P0の権限・状態・操作を確定、(2)不足する保存先と関連を定義、(3)API/DDL/競合仕様に落とす、(4)同じ仕様から受入試験を作る順がよい。技術の全面変更やマイクロサービス化は不要。

### 1.4 対象ファイルの全件確認

README 1件と `docs/` 内10件を全行確認した。合計1,610行。レビュー開始時に既存のレビュー報告はなかった。`prototype/` はREADME 34行で見た目の参考・仕様の正ではないと明記されているため、本レビューはその視覚的品質や実装を評価していない。

| 実在ファイル | 行数 | 役割・確認内容 | 主な対応指摘 |
|---|---:|---|---|
| [README.md](/home/misty/Projects/fire-os/README.md:1) | 70 | 文書索引、確定/候補、プロトタイプの位置付け | F27 |
| [00_プロジェクト概要.md](/home/misty/Projects/fire-os/docs/00_プロジェクト概要.md:1) | 74 | 目的、規模、利用者、基本3フロー、安全境界 | F05、F25 |
| [01_要件定義書.md](/home/misty/Projects/fire-os/docs/01_要件定義書.md:1) | 470 | 機能ID、優先度、非機能、権限、受入、未決事項 | F01〜F07、F12、F15〜F18、F24〜F28 |
| [02_基本設計書.md](/home/misty/Projects/fire-os/docs/02_基本設計書.md:1) | 116 | モノリス、サービス、AI非同期、障害時処理 | F05、F08、F19、F20 |
| [03_画面設計・遷移.md](/home/misty/Projects/fire-os/docs/03_画面設計・遷移.md:1) | 116 | SCR-01〜19、主要フォーム、状態・端末 | F03、F04、F06、F14、F24、F25 |
| [04_データ設計・ER図.md](/home/misty/Projects/fire-os/docs/04_データ設計・ER図.md:1) | 186 | 概念ER、論理カラム、制約候補、GIS・履歴 | F04〜F09、F11、F13、F16、F22 |
| [05_API仕様書.md](/home/misty/Projects/fire-os/docs/05_API仕様書.md:1) | 184 | API-01〜32、共通応答、施設・点検・AI例 | F01〜F12、F14、F22、F28 |
| [06_AI設計書.md](/home/misty/Projects/fire-os/docs/06_AI設計書.md:1) | 115 | 分類、生成、承認、評価、非信頼入力 | F20〜F23 |
| [07_セキュリティ・運用設計.md](/home/misty/Projects/fire-os/docs/07_セキュリティ・運用設計.md:1) | 105 | 分類、RBAC、R2、復元、監視、代替運用 | F01、F02、F10、F11、F15、F17〜F19、F24〜F26 |
| [08_テスト・受入計画.md](/home/misty/Projects/fire-os/docs/08_テスト・受入計画.md:1) | 90 | TC-01〜18、AI評価、認可回帰、完了条件 | F12、F18、F21、F25、F27 |
| [09_ロードマップ・未決事項.md](/home/misty/Projects/fire-os/docs/09_ロードマップ・未決事項.md:1) | 84 | フェーズ、依存関係、DEC/TBD | F05、F18、F27 |

独立したOpenAPIファイル、DDL/マイグレーション設計、詳細な運用手順書は `docs/` に存在しない。記載予定と実在する成果物を区別した。簡略ERから省略と明記されたものを「テーブル不存在」とは扱わず、本文にも定義が不足する場合のみ指摘した。

## 2. 指摘事項一覧

重要度はユーザー指定に従う。HighはP0の権限・保存契約・完了条件に関わるため、業務実装前の解消を要する。MediumにはP1/P2導入時のゲートも含む。未定義から実装済み脆弱性を推断していない。

| ID | 重要度 | 対象ファイル・行 | 問題 | 影響 | 推奨修正 |
|---|---|---|---|---|---|
| F01 | High | [01:347](/home/misty/Projects/fire-os/docs/01_要件定義書.md:347)〜358、[07:12](/home/misty/Projects/fire-os/docs/07_セキュリティ・運用設計.md:12)〜22、[05:55](/home/misty/Projects/fire-os/docs/05_API仕様書.md:55)〜81 | 「担当範囲」「合意範囲」「項目制限」が未定義。機微な出動・写真は限定アクセス方針だが、API一覧はログイン者としか規定しない箇所がある。担当割当やお知らせ公開先の保存方式もない | RBACを実装してもどの行・項目を返すか決められず、一覧・集計・添付から情報が漏れる設計になり得る | 操作×役割×対象範囲×返却項目を定義。サーバーが所属を導出し、関連先も同じ範囲か検査。お知らせ対象・担当の表現を決める。OWASPのオブジェクト認可原則に対応（第4節） |
| F02 | High | [01:92](/home/misty/Projects/fire-os/docs/01_要件定義書.md:92)〜95、[04:145](/home/misty/Projects/fire-os/docs/04_データ設計・ER図.md:145)〜147、[05:87](/home/misty/Projects/fire-os/docs/05_API仕様書.md:87)、[07:19](/home/misty/Projects/fire-os/docs/07_セキュリティ・運用設計.md:19)〜24 | 招待制の認証方式、招待消費、名簿との紐付け、初期管理者・再設定が未確定。AUTH-04は再ログイン拒否のみだがテストは旧セッション失効も要求 | 招待外登録、別団員への誤紐付け、停止後も利用継続、管理者の締め出しを防ぐ契約がない | 認証方式と招待トークンの対象・期限・一回性・取消を決定。`users`/`members`の停止連動、全セッション失効、キャッシュ条件、初期化・復旧を定義。Better Auth選定のPoCに含める |
| F03 | High | [01:102](/home/misty/Projects/fire-os/docs/01_要件定義書.md:102)、[01:146](/home/misty/Projects/fire-os/docs/01_要件定義書.md:146)、[03:25](/home/misty/Projects/fire-os/docs/03_画面設計・遷移.md:25)〜33、[05:54](/home/misty/Projects/fire-os/docs/05_API仕様書.md:54)〜81 | P0の予定編集API、車両/資機材登録・変更API、資機材/出動の詳細取得、監査閲覧・権限管理のアプリ側契約が一覧にない。認証APIをライブラリへ委ねる注記では業務CRUDは補えない | ACT-01、AST-01、SCR-12/14/17、MVP台帳登録がエンドツーエンドで成立しない | 新規パス名の固定より先に、必要な操作と入出力をP0追跡表へ追加。インライン編集でもよいが操作と権限を記載。P0 OpenAPIを実装前に作るという05末尾の約束を履行 |
| F04 | High | [01:104](/home/misty/Projects/fire-os/docs/01_要件定義書.md:104)、[03:96](/home/misty/Projects/fire-os/docs/03_画面設計・遷移.md:96)〜98、[04:148](/home/misty/Projects/fire-os/docs/04_データ設計・ER図.md:148)〜149、[05:62](/home/misty/Projects/fire-os/docs/05_API仕様書.md:62) | 実績APIはあるが、DBには予定日時と出欠の`actual_status`しか明示されず、実活動内容・実開始終了/活動時間の保存方式がない | 予定時刻を実績で上書きするか、実績内容が失われる。ACT-03・将来帳票が再現できない | 同一行の予定/実績別カラムか1対1の実績表を選ぶ。活動全体の時間か団員ごとの時間かを確認し、実績登録/訂正/閲覧の契約を定義 |
| F05 | High | [01:150](/home/misty/Projects/fire-os/docs/01_要件定義書.md:150)、[01:158](/home/misty/Projects/fire-os/docs/01_要件定義書.md:158)、[02:66](/home/misty/Projects/fire-os/docs/02_基本設計書.md:66)〜68、[04:138](/home/misty/Projects/fire-os/docs/04_データ設計・ER図.md:138)、[05:74](/home/misty/Projects/fire-os/docs/05_API仕様書.md:74)〜76 | DSP-03はP0で出動↔車両/活動を要求するがAST-05は活動・出動の使用履歴をP1とする。省略注記には活動↔施設/車両があるが、出動の関連付け方式・API本文はない | 「総合管理」が共通DBに独立台帳を並べるだけになり、P0の必須連携を検証できない | P0の最低限の出動↔活動/車両参照と、P1の数量・使用時間等の詳細履歴を区別する案を合意。関係の多重度、保存先、登録/解除、表示、TCを定義 |
| F06 | High | [03:89](/home/misty/Projects/fire-os/docs/03_画面設計・遷移.md:89)〜91、[04:153](/home/misty/Projects/fire-os/docs/04_データ設計・ER図.md:153)〜158、[05:144](/home/misty/Projects/fire-os/docs/05_API仕様書.md:144)〜155 | 点検APIの`checkItems`に保存先がない。`createIssue`で作った異常と元点検のリンクも論理定義にない。追記型原本の訂正関係・理由・操作もない | 何を点検して異常起票したか辿れず、訂正の重複やダッシュボード誤集計を招く。資機材点検もコメント保存が未定義 | 明細JSONか子表を選び、項目コード・様式版を保持。異常の起点点検参照と、訂正が原本を置換/補足する規則を定義。手動の独立異常報告も許容して区別 |
| F07 | High | [01:121](/home/misty/Projects/fire-os/docs/01_要件定義書.md:121)、[01:148](/home/misty/Projects/fire-os/docs/01_要件定義書.md:148)、[04:172](/home/misty/Projects/fire-os/docs/04_データ設計・ER図.md:172)、[05:95](/home/misty/Projects/fire-os/docs/05_API仕様書.md:95)、[05:145](/home/misty/Projects/fire-os/docs/05_API仕様書.md:145) | 施設確認状態・点検結果・異常進捗が混同されやすい。異常の日本語3状態と英語5状態の対応、resolved/closedの差がない。活動/出動/参集の許可遷移・締切・訂正者も未定義 | 同じ報告が確認済み/未確認に見える。`verified`を設備使用可と誤認し、終了済みへの回答・再オープンも実装依存になる | 状態辞書と遷移表（操作・権限・前提・副作用）を共有。位置の確認、点検結果、異常対応を別概念にする。未回答と未定、未確認と欠席を区別 |
| F08 | High | [02:61](/home/misty/Projects/fire-os/docs/02_基本設計書.md:61)、[04:158](/home/misty/Projects/fire-os/docs/04_データ設計・ER図.md:158)、[05:155](/home/misty/Projects/fire-os/docs/05_API仕様書.md:155) | 更新と監査が「可能な範囲」の同一単位。点検→異常→添付関連→監査、進捗→履歴の原子性が未確定 | 保存済み点検に異常チケットがない、進捗と履歴が食い違うなど業務フローが途中で成功する | 各操作のD1内の必須書込を一つの`batch()`等にまとめる設計を示す。条件付き更新0件はSQLエラーではないため、その後の履歴も条件付きにする。R2/Queuesとの跨ぎは別の再調整処理とする（第4節） |
| F09 | High | [04:174](/home/misty/Projects/fire-os/docs/04_データ設計・ER図.md:174)、[05:61](/home/misty/Projects/fire-os/docs/05_API仕様書.md:61)〜76、[05:176](/home/misty/Projects/fire-os/docs/05_API仕様書.md:176)〜177、[08:40](/home/misty/Projects/fire-os/docs/08_テスト・受入計画.md:40)〜41 | APIは楽観ロックを行うがDBは検討扱い。冪等キーの対象・保存先・再実行応答・有効期間がない。PUT出欠/参集の一意制約だけでは古い再送による上書きを防げない | 通信断再試行で二重点検や、後の回答を古い回答で上書き。承認の二重反映 | 対象POSTとPUT/PATCHを列挙。キーをユーザー/操作に束縛し本文ハッシュ・処理結果・期限を保存。同じキーで本文違いは409。`version`必須箇所と条件付き更新、応答消失後の取得/再送を定義 |
| F10 | High | [07:54](/home/misty/Projects/fire-os/docs/07_セキュリティ・運用設計.md:54)〜57、[05:80](/home/misty/Projects/fire-os/docs/05_API仕様書.md:80)、[08:75](/home/misty/Projects/fire-os/docs/08_テスト・受入計画.md:75) | 短寿命URL配信と「退団・役割変更後に旧URL経由で取得できない」検証の整合が取れていない | R2署名URLはセッションを再確認せず期限まで利用可能。失効時刻の期待と実装が食い違う | P0は認可するWorkers経由で本文配信する案を推奨。署名GETを選ぶなら残存アクセス時間を明示・合意し、即時失効保証を変更する。既に端末へ保存されたファイルの回収は保証しない |
| F11 | High | [04:159](/home/misty/Projects/fire-os/docs/04_データ設計・ER図.md:159)〜160、[05:79](/home/misty/Projects/fire-os/docs/05_API仕様書.md:79)〜80、[05:151](/home/misty/Projects/fire-os/docs/05_API仕様書.md:151)、[07:53](/home/misty/Projects/fire-os/docs/07_セキュリティ・運用設計.md:53)〜58 | upload-intent後の転送・検査・完了・業務関連付けが未定義。種類/容量/マルウェア対策は方針だけ。既存`attachmentIds`の所有・対象検査契約もない | 未検査データ公開、偽装MIME、他記録の添付奪用、未完了アップロードの蓄積、R2とD1の孤児 | 未完了/検査済/拒否等の状態、サーバー生成キー、許可形式/上限、完了APIまたは一括アップロードAPIを決定。確定時実体確認・権限再検査、未完了回収、能動コンテンツの配信制限を規定 |
| F12 | High | [01:399](/home/misty/Projects/fire-os/docs/01_要件定義書.md:399)〜414、[08:26](/home/misty/Projects/fire-os/docs/08_テスト・受入計画.md:26)〜45、[08:82](/home/misty/Projects/fire-os/docs/08_テスト・受入計画.md:82) | 要件は「すべて」満たすがテスト計画は「優先度の高い項目が通過」でMVP。AUTH-03/04、ACT-04、AST-03、DSP-03、COM-01、DASH-01等の明示TC不足 | 権限・異常対応・統合導線が欠けても完了扱いになり得る。AUTH-01も招待外登録拒否を検証していない | 完了条件を一つにし、全P0要件に正常/拒否/競合の必要ケースを対応。未合格例外の承認者を定義し、セキュリティ・整合性を黙って免除しない |
| F13 | Medium | [04:146](/home/misty/Projects/fire-os/docs/04_データ設計・ER図.md:146)〜165、[04:169](/home/misty/Projects/fire-os/docs/04_データ設計・ER図.md:169)〜175 | NULL・FK・削除・索引が物理設計へ一括先送り。`members.user_id`の一意性、`member_roles`重複、保管場所二重指定、数量範囲も未確定 | データ修復が必要になる。IDの実在だけを検査しても所属が異なる参照は防げない | 各モジュールのマイグレーション前に型・NOT NULL・UNIQUE・CHECK・FK・ON DELETE・索引を確定。所属一致はサービス検証または複合FK。退団しても履歴を残す方式を決める |
| F14 | Medium | [01:118](/home/misty/Projects/fire-os/docs/01_要件定義書.md:118)、[04:179](/home/misty/Projects/fire-os/docs/04_データ設計・ER図.md:179)、[05:48](/home/misty/Projects/fire-os/docs/05_API仕様書.md:48)、[05:91](/home/misty/Projects/fire-os/docs/05_API仕様書.md:91)〜96 | 要件の「点検状態」「管理番号検索」に対し例は位置確認`verificationStatus`中心。bboxページングとクラスタリングを代替策として併記し、全件性・上限・並び順が不明 | limit=100の先頭だけを地図に出すと、施設がないと誤認。クラスタリングだけでは取得漏れを解消しない | 点検結果・位置確認を別フィルターにする。cursor完走/省略表示ルール、最大limit・bbox境界、安定順、地図移動時の古い応答破棄を定義 |
| F15 | Medium | [01:293](/home/misty/Projects/fire-os/docs/01_要件定義書.md:293)〜302、[07:39](/home/misty/Projects/fire-os/docs/07_セキュリティ・運用設計.md:39)〜49 | Google規約対策がキャッシュ/キー中心。公開利用規約・プライバシーポリシー、帰属表示、High Risk Activitiesとの用途境界の確認がない | ログイン制でも公開ポリシー等を欠く。地図下部シートが帰属表示を隠す可能性。将来の現場依存用途は別評価が必要 | 公開前にGoogle要件を満たすポリシーとUI試験を追加。P0は管理・訓練・事後記録として境界を具体化し、将来の生命安全依存用途は契約適合を確認。現状を規約違反とは断定しない |
| F16 | Medium | [01:128](/home/misty/Projects/fire-os/docs/01_要件定義書.md:128)〜138、[04:152](/home/misty/Projects/fire-os/docs/04_データ設計・ER図.md:152)、[05:124](/home/misty/Projects/fire-os/docs/05_API仕様書.md:124)〜136 | 座標更新後に旧確認を失効させるか、誰が何を確認したかが未定義。所在地/目印・写真・登録者等が各文書に散在 | 確認済み地点を別位置に移してもverifiedが残る。障害時の文字一覧に必要な情報も保存が保証されない | 変更前後座標、出典、確認者・日時・確認対象版を持つ案を検討。重要座標変更は再確認へ戻すか合意し、目印等をAPI/DBに対応付ける |
| F17 | Medium | [01:296](/home/misty/Projects/fire-os/docs/01_要件定義書.md:296)、[01:382](/home/misty/Projects/fire-os/docs/01_要件定義書.md:382)、[07:76](/home/misty/Projects/fire-os/docs/07_セキュリティ・運用設計.md:76) | Maps単価は正しいがWorkers・認証CPU・D1走査・写真増加・デモアクセス・AIの数量見積もりがない | 30人という人数から無料運用を判断できない。認証や写真処理がFree制約を超える可能性 | 第4節の仮定付き見積もりを実数で置換。$5/月のWorkers Paidも選択肢にし、月次確認に加え異常/上限接近の通知と担当を決める |
| F18 | Medium | [01:380](/home/misty/Projects/fire-os/docs/01_要件定義書.md:380)、[07:64](/home/misty/Projects/fire-os/docs/07_セキュリティ・運用設計.md:64)〜70、[09:12](/home/misty/Projects/fire-os/docs/09_ロードマップ・未決事項.md:12) | 復元試験は実運用前必須だがロードマップではAI後のフェーズ5。D1時点復元とR2の整合回復手順も未定義 | MVPで実データ運用を始めると復旧が未検証。DBを戻しても写真は復元されない | 実データ投入ゲートへ復元試験を移す。RTO/RPO、誤削除時のR2保持、孤児/欠落照合、復元後セッション失効・AI再投入を手順化 |
| F19 | Medium | [02:25](/home/misty/Projects/fire-os/docs/02_基本設計書.md:25)〜37、[02:112](/home/misty/Projects/fire-os/docs/02_基本設計書.md:112)、[07:94](/home/misty/Projects/fire-os/docs/07_セキュリティ・運用設計.md:94) | 同一オリジンの配置方式、Workers互換フラグ/版、環境binding、SPA/API分岐、D1 migrationの適用順がない | ローカルだけ動作、APIにHTMLを返す、誤環境デプロイ、認証/写真処理のCPU超過を発見しにくい | Workers Static Assets＋API案、固定版とcompatibility設定、環境ID検査、migration/rollback、実Workers試験を設計。Secrets・認証APIと自作APIのCSRF適用範囲も明示 |
| F20 | Medium | [02:91](/home/misty/Projects/fire-os/docs/02_基本設計書.md:91)〜101、[06:27](/home/misty/Projects/fire-os/docs/06_AI設計書.md:27)〜33 | DB保存成功とQueue投入の隙間、最大再試行・再投入・古い元データへの結果の扱いが未定義 | 元報告は残っても分類されない、再送で課金・候補が重複、訂正前本文の候補が後から現れる | P1開始時にD1の処理待ちジョブを原本と保存し、Cron/Queueで回収する案を採用判断。元版＋質問版の一意キー、失敗状態、再試行上限、手動復旧を定義 |
| F21 | Medium | [01:196](/home/misty/Projects/fire-os/docs/01_要件定義書.md:196)、[06:15](/home/misty/Projects/fire-os/docs/06_AI設計書.md:15)〜16、[06:95](/home/misty/Projects/fire-os/docs/06_AI設計書.md:95)〜115、[08:51](/home/misty/Projects/fire-os/docs/08_テスト・受入計画.md:51)〜63 | Jev候補は実在するが要求/応答・保留への変換・評価件数/分割/合格閾値が未確定。6例は採用精度の証拠にならない | Noulをbooleanと扱う等の誤実装、質問への過適合、分類価値を示せない | 公式型でアダプター契約を固定し日本語PoC。ルール/手動分類を比較基準にし、クラス別見逃し・保留率・修正負荷を測る。TypeSafe契約/処理地域は未検証項目として導入ゲートへ |
| F22 | Medium | [04:162](/home/misty/Projects/fire-os/docs/04_データ設計・ER図.md:162)、[05:159](/home/misty/Projects/fire-os/docs/05_API仕様書.md:159)〜170、[06:29](/home/misty/Projects/fire-os/docs/06_AI設計書.md:29)〜32、[06:63](/home/misty/Projects/fire-os/docs/06_AI設計書.md:63)〜67 | `ai_evaluations`に確定分類・レビュー時刻/理由・元版・質問版がない。報告書保存/編集/承認/出力モデル・APIも下書き作成以外は未定義 | 何を人が承認したか再現できず、更新後も古い提案を承認。DOC-02/AI-04が完走しない | P1で生成物とレビュー記録、入力スナップショット/参照版、確定効果を定義。承認時に元版・権限再検査、二重実行を防止。提案の自動保存と正式変更を区別 |
| F23 | Medium | [01:184](/home/misty/Projects/fire-os/docs/01_要件定義書.md:184)〜185、[06:19](/home/misty/Projects/fire-os/docs/06_AI設計書.md:19)、[06:91](/home/misty/Projects/fire-os/docs/06_AI設計書.md:91) | RAGは「出典付き」の目標のみで、文書版/ページ・検索前ACL・失効文書の索引削除・根拠不足時の応答がない | 権限外資料の断片や失効規程を回答に混ぜる | P2開始前に文書取込/版/チャンク/権限同期、引用の原文表示、回答保留と評価を定義。MVPのベクトル基盤導入は不要 |
| F24 | Medium | [01:450](/home/misty/Projects/fire-os/docs/01_要件定義書.md:450)、[03:115](/home/misty/Projects/fire-os/docs/03_画面設計・遷移.md:115)〜116、[07:58](/home/misty/Projects/fire-os/docs/07_セキュリティ・運用設計.md:58)、[07:87](/home/misty/Projects/fire-os/docs/07_セキュリティ・運用設計.md:87) | GPSは許可取得のみで、精度不足/タイムアウト・保存有無が未定義。P1端末下書きの保持・失効・同期中状態・ユーザー切替も未定義 | 誤位置登録、共有/紛失端末の情報残存、保留を登録済みと誤認 | P0は一回取得・精度表示・手動確認・拒否時代替を具体化。P1は自前データのみ保持し、保存期限・ログアウト削除・同期状態と競合解決を別設計 |
| F25 | Medium | [00:41](/home/misty/Projects/fire-os/docs/00_プロジェクト概要.md:41)〜43、[01:375](/home/misty/Projects/fire-os/docs/01_要件定義書.md:375)〜386、[03:109](/home/misty/Projects/fire-os/docs/03_画面設計・遷移.md:109)〜114 | 少数操作/十分なタップ領域が測定可能でなく、低頻度利用者試験・管理者不在時の代行/復旧経路もない | 入力完了率・p95目標の合否が判定できず、唯一の管理者不在で停止 | 代表端末/回線/データ量/操作成功条件を定義。点検フォームの実測とキーボード/拡大試験、管理者代行・最後の管理者の無効化防止を検討 |
| F26 | Medium | [01:66](/home/misty/Projects/fire-os/docs/01_要件定義書.md:66)〜68、[01:169](/home/misty/Projects/fire-os/docs/01_要件定義書.md:169)、[02:80](/home/misty/Projects/fire-os/docs/02_基本設計書.md:80)〜101 | 通知がP1にあるが、配送チャネル・対象・承認内容・失敗/取消/既読の意味がない。Queues/Cron採用だけでは端末配送にならない | 「送信成功＝届いた」「既読＝参集」と誤認し、二重通知も起き得る | P1は通常業務通知から開始する案。チャネル選定、サーバー受付/配送/既読を分離し、再送・対象確定・正式連絡の代替禁止を定義 |
| F27 | Low | [README:3](/home/misty/Projects/fire-os/README.md:3)、[README:53](/home/misty/Projects/fire-os/README.md:53)、[08:45](/home/misty/Projects/fire-os/docs/08_テスト・受入計画.md:45)、[09:73](/home/misty/Projects/fire-os/docs/09_ロードマップ・未決事項.md:73) | 既にv0.2だが次版v0.2が残る。`AUDIT`は仮IDのままで、要件正の参照が不安定 | 差分・承認対象・TC追跡が分かりにくい | 次版番号と承認状態を統一。監査・デモ要件へ正式IDを付け、更新履歴と追跡表を持つ |
| F28 | Low | [01:128](/home/misty/Projects/fire-os/docs/01_要件定義書.md:128)、[04:152](/home/misty/Projects/fire-os/docs/04_データ設計・ER図.md:152)、[05:131](/home/misty/Projects/fire-os/docs/05_API仕様書.md:131)、[07:15](/home/misty/Projects/fire-os/docs/07_セキュリティ・運用設計.md:15)〜42 | 管理番号「または識別名」とAPI必須番号、`source`/`locationSource`等の対応未記載。APIキー一律非表示とブラウザキーの区別も弱い | バリデーション・命名の認識差、ブラウザキーを秘密扱いする誤解 | DB↔API↔画面辞書を作る。ブラウザMapsキーは露出前提で制限、サーバーSecretは非公開と明確に区分 |

### 2.1 High指摘の修正を具体化するための最小契約

以下は設計の修正案であり、パス・状態名・保存方式を確定するものではない。

| 操作 | サーバーが確定する情報 | 同時に整合させる情報 | 拒否/競合時の条件 |
|---|---|---|---|
| 出欠回答 | セッションから団員ID、活動・所属、回答受付可否 | 回答、version、必要な監査 | 他人ID/締切後/旧versionは拒否。応答消失後の同一再送を定義 |
| 点検登録 | 対象、報告者、実施者指定の許可、点検様式 | 原本・明細・必要な異常・添付リンク・監査 | 未検査/別所属添付、同一キー別本文、関連保存失敗は成功にしない |
| 活動実績 | 実績入力権限、予定参照、参加者の所属 | 実内容/時刻、実参加、変更履歴 | 予定値を壊さず、二重実績/旧versionを検知 |
| 出動参加/状態 | 本人と代理入力権限、イベント種別、許可遷移 | 現状態・参加時刻・変更履歴 | 古い再送による巻戻し、終了後の無断変更を拒否 |
| 異常確認/解決 | 対象範囲、遷移元、確認者、対応理由 | 状態/担当、issue_events、監査 | 状態が既に変化した場合は履歴も増やさない |
| AI承認（P1） | 現在の権限、提案版、元データ版、承認対象の差分 | 決定記録・確定分類/タスク・監査 | 元の更新/二重承認/権限変更後は反映せず再確認 |

`batch()`を使うだけで楽観ロックが完成するわけではない。`UPDATE ... WHERE version = ?`が0行でもバッチは通常成功し得るため、後続のイベント/監査が「更新を行った」扱いにならないようSQLと判定の設計が必要である。[Cloudflare D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)

## 3. 不足している要件

下表の「不足」は要件の追加確定を意味しない。既存要件の具体化と、新たに利用者判断が必要な提案を区別する。

| 不足項目 | 区分・必要性 | 追加/具体化すべき文書 | 関連 |
|---|---|---|---|
| 招待の一回性・取消・名簿照合、初期管理者と再設定 | AUTH-01/04の具体化。ログイン前後のライフサイクルが必要 | 01、04、05、07、08 | F02 |
| 名簿の項目別閲覧、出欠一覧/出動/写真の可視範囲 | 既存の最小化・限定アクセスの具体化。連絡先や参加理由を全員共有してよいとは書かれていない | 01権限表、04項目、05レスポンス、07分類 | F01 |
| 担当範囲・代理入力・役割競合・複数ロールの規則 | 既存RBACの具体化。班長/担当者を認証ロールと同一視しない | 01、02、04、05、08 | F01、F07 |
| 予定変更/中止、回答受付期限、実績訂正 | ACT-01〜04の具体化。予定と実績の区別を維持 | 01、03、04、05、08 | F03、F04、F07 |
| 点検票の項目、必須/任意、様式変更後の履歴解釈 | AST-02/MAP-06の具体化。実帳票の合意前にチェック項目を勝手に固定しない | 01付表、03、04、05、08 | F06 |
| 異常の確認/差戻し/解決/再開、点検との関連 | AST-03/MAP-07の具体化。完了した事実と未確認報告を分離 | 01、03、04、05、08 | F06〜F08 |
| 車両・資機材保管先、数量単位、廃止/移動 | AST-01の具体化。個体管理か数量台帳かは要確認。在庫取引システムまで要求しない | 01、04、05 | F03、F13 |
| 出動↔活動/車両の最小リンクと実績二重計上防止 | DSP-03の具体化。活動と出動の同一出来事を二回集計しない規則が必要 | 01、04、05、08、09 | F05 |
| お知らせ公開先・公開状態、ダッシュボード計数定義 | COM-01/DASH-01の具体化。公開前投稿や権限外件数を漏らさない | 01、03、04、05、08 | F01、F07、F12 |
| 添付確定・削除・許可種類/容量・権限失効 | DOC-01の具体化。未完了データと閲覧可能ファイルを分ける | 03、04、05、07、08 | F10、F11 |
| 監査する操作・項目・保持、訂正理由 | NFR-07の具体化。ログ一覧だけでは「何を変更」が決まらない。本文/名簿全文を監査へ複製しない | 01、04、05、07、08 | F08、F13、F18 |
| 管理者不在・最後の管理者、事故/漏えい時の連絡・停止 | 新たな運用具体化の提案。小規模でも引継ぎ窓口が必要 | 07手順、08演習、09導入条件 | F25 |
| 実データ投入条件と復元完了条件 | 既存未決事項のゲート化。ポートフォリオ公開と実運用開始を別判定にする | 01、07、08、09 | F12、F18 |
| 性能/操作性の試験条件 | NFR-01〜03/09の具体化。施設件数、回線、端末、タップ/入力完了条件 | 03、08 | F14、F25 |
| AI採用比較、承認対象の版、実送信データ許容範囲 | AI-01〜05の具体化。分類精度だけで実用価値・承認の安全性は評価できない | 04〜08 | F20〜F22 |

詰所・車庫・その他施設は、要件01の111行で将来追加とされる。ユーザー依頼の管理対象として検討したが、現設計のP0がこれらを含むとは補完していない。団員の勤怠給与、会計、法定帳票一式等も実需要の記載がないため、欠落した必須機能とは断定しない。

## 4. 技術スタックの検証結果

### 4.1 採用技術ごとの評価

「公式確認済み」は対応手段が公式文書にあることを示す。FireOSで選択した版・設定・プラグインの組合せが動作したという意味ではない。ライブラリの具体的な固定版は現文書にない。

| 技術 | 採用妥当性・互換性 | 制約・リスクと必要な確認 | 代替の必要性 / 公式確認 |
|---|---|---|---|
| React / TypeScript / Vite | 認証後の業務SPAに妥当。ビルド成果物を配信しブラウザで実行 | Vite自体はAPIルーター・認可を提供しない。ルーティング、データ取得、失敗状態は別途設計 | 変更不要。[React公式のVite/TS案内](https://react.dev/learn/build-a-react-app-from-scratch)確認済み |
| Tailwind / shadcn/ui | ブラウザUIとしてCloudflareと衝突する要素なし | UI部品導入だけでタップ領域・フォーカス・コントラストは保証されない。現版組合せは未実証 | 変更不要。[Tailwind Vite](https://tailwindcss.com/docs/installation/using-vite)、[shadcn Vite](https://ui.shadcn.com/docs/installation/vite)確認済み |
| Workers / Hono | Web標準Request/Response、環境binding、scheduledとの統合が可能。単一APIに適合 | Node専用API/ネイティブ実行を無条件に使わない。CPU、メモリ、起動/バンドル制約を検証 | 変更不要。[Hono Workers](https://hono.dev/docs/getting-started/cloudflare-workers)確認済み |
| Drizzle ORM / Zod | DrizzleのD1ドライバーが公式にある。Zodによる入力検証方針も妥当 | ORMの関係定義はDBのFK・所属検査の代用ではない。一般的なinteractive transactionを前提にしない。スキーマとAPIの二重管理を避ける | 変更不要。[Drizzle D1](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1)確認済み。FireOSのスキーマ変換は未実証 |
| D1 | 単一分団のCRUD、点検履歴、基本bbox検索に妥当 | 単一DB処理の特性、行走査課金、物理制約、複数更新の原子性を考慮。高度なGIS機能は現在要求されない | PostGIS移行は不要。公式制約/SQL API確認済み。第4.2節 |
| R2 | 写真/PDF本体をDBから分離する方針は妥当 | 署名URLのbearer性、検査・確定・失効、孤児回収をFireOS側で設計。R2非公開だけでは対象認可にならない | 変更不要。P0の取得はWorkers経由を推奨。[R2署名URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)確認済み |
| Better Auth | 候補として成立。D1ネイティブ対応とDrizzle SQLiteアダプター、Hono統合の公式情報あり | 招待制はライブラリ採用だけで完成しない。使用プラグイン、名簿紐付け、停止、CSRF、Cookie、パスワードCPUをPoC。すべてのプラグインがD1対応とは限らない | 現時点で交換不要。[D1対応](https://better-auth.com/blog/1-5)、[Drizzle adapter](https://better-auth.com/docs/adapters/drizzle)、[Hono integration](https://better-auth.com/docs/integrations/hono)確認済み |
| Google Maps JavaScript API | 採用確定方針と用途が合う。自前施設のマーカー表示は実現可能 | 請求、browser key制限、Map ID、帰属表示、公開ポリシー、用途規約。別SKUの混入に注意 | 変更提案なし。第4.3節 |
| @vis.gl/react-google-maps | Reactとの統合に妥当。AdvancedMarkerをサポート | AdvancedMarkerに`mapId`が必要。独自シンボル、クリック/キー操作、件数増加時を試験 | 変更不要。[公式AdvancedMarker](https://visgl.github.io/react-google-maps/docs/api-reference/components/advanced-marker)確認済み |
| Workers AI / 生成LLM | サーバー側分類/生成とP1ゲートは妥当 | 生成モデル未選定なので日本語品質、JSON制約、コンテキスト、遅延、単価の適合は未検証。型検証は事実の正しさを保証しない | モデル比較後に選定。第4.4節 |
| TypeSafe AI Jev | 選択肢分類/真偽候補に適合し、生成LLMとの分離は妥当 | 自動判断の必要性を過大評価しない。日本語精度と手動修正削減を検証。原文や画像からの自由生成用途と混同しない | 採用ゲート付きで維持。公式にモデル・型は確認済み、業務精度・契約詳細は未検証 |
| Queues | P0に不要。P1でリクエスト寿命から独立した処理に有用 | 少数件でも信頼性が理由なら採用価値あり。ただし重複・保存と投入の隙間・期限切れを設計。現在はFreeでも利用可能 | まずD1ジョブ＋Cron案と比較。[配送保証](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)、[料金](https://developers.cloudflare.com/queues/platform/pricing/)確認済み |
| Cron Triggers | 点検期限・未処理ジョブの回収に妥当 | UTC基準の起動を日本時間の業務日と対応。日付判定・重複実行・失敗回収を定義 | 定期処理が発生するP1で導入。[公式Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/)確認済み |
| Durable Objects | P0に不要。30端末の参集試験ならまず再取得/ポーリングで要求を確認可能 | DOとD1を両方の正本にすると同期・再接続が増える。導入時は認可、イベント順序、再接続スナップショットを設計 | 双方向・低遅延が受入要件になってから。現文書は候補であり過剰導入済みとは評価しない。[公式料金/FreeのSQLite制約](https://developers.cloudflare.com/workers/platform/pricing/)確認済み |
| Vite PWA Plugin | P1の配布・アプリシェルには妥当 | Service Worker生成がDB同期・競合解決・機密データ保護まで提供するわけではない。Google地図をキャッシュ対象にしない | 通信断要件確定後に導入。[Vite PWA公式](https://vite-pwa-org.netlify.app/guide/)確認済み |
| GitHub Actions / Wrangler | 環境別CI/CDに妥当 | 環境binding、最小権限token、migration順、デモから本番アクセス禁止、Secret混入防止が必要 | 変更不要。[Honoの公式デプロイ案内](https://hono.dev/docs/getting-started/cloudflare-workers)確認済み。パイプライン自体は未実証 |

### 4.2 D1・データモデル・GIS

公式上、D1の単一DB最大容量はFree 500 MB / Paid 10 GB、1クエリのbound parameterは最大100、行/文字列/BLOBは最大2 MB。Time TravelはFree 7日 / Paid 30日。単一DBはクエリを順次処理するため、人数より重い走査・長いクエリが影響する。[D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)

この制約はFireOSの初期要件と両立する。写真をR2に置き、巨大なAI入出力や帳票を一つの行に詰め込まなければ、直ちに容量不足とする根拠はない。ただし施設数・点検件数・保持期間は未確定であり、十分な容量を実測で保証したわけではない。

複数SQLは`batch()`で失敗時に全体ロールバック可能。一方、リクエスト途中で読み取り結果に応じて任意のSQLを組み立てる対話型トランザクションと同一視しない。**D1はトランザクションが一切ない、という指摘は誤り**である。[D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[Better AuthのD1対応説明](https://better-auth.com/blog/1-5)

| GIS要件 | D1での評価 | 具体的な設計案 |
|---|---|---|
| 緯度・経度保持 | `REAL`で十分 | WGS84の範囲CHECK＋入力検証。`lat,lng`とbbox/GeoJSONの`lng,lat`を変換境界で明記 |
| 種別/状態/管理番号検索 | 通常の条件検索で可能 | `unit_id`起点、番号一意性と検索方法（前方/部分一致）を定義。確認状態と点検状態を分離 |
| 地図範囲検索 | 緯度/経度の比較条件で可能 | `longitude BETWEEN west AND east`、`latitude BETWEEN south AND north`。日付変更線を跨ぐ範囲は分割、またはMVPは対象地域へ制限する案を明記 |
| 履歴・写真・異常参照 | 通常FK/JOINで可能 | 施設→点検、起点点検→異常、添付→対象。直近点検と未解決件数の定義を共有 |
| 小規模な直線距離・近隣候補 | アプリ計算を含め可能 | bboxで絞って必要なら距離計算。現設計のP0に距離計算要件はない |
| ポリゴン包含・多数の空間JOIN | 将来の要求次第 | 全国/広域件数や複雑な領域処理でp95/走査量が目標に届かないならPostGISを評価 |
| 道路距離・経路最適化 | D1/単なるPostGIS導入では完結しない | 道路網・routing engineまたは別APIが必要。Google Routes等の費用/規約も別評価 |

索引候補は、施設の`(unit_id,type,management_number)`、`(unit_id,verification_status)`、範囲検索向け`(unit_id,latitude)`等、履歴の`(facility_id,inspected_at,id)`、異常の対象/状態、活動の所属/日時、参加者逆引き。これは**測定対象の候補**であり、すべてを必須としない。通常のB-tree複合索引が2方向の範囲条件を同時に理想的に絞るとは保証しない。代表施設数で`EXPLAIN QUERY PLAN`とrows_readを測り、N+1で詳細を反復取得しない設計を選ぶ。

型・NULL・FK・UNIQUE・削除方針はDrizzleからDDLへ明示する。出欠のUNIQUEは既に妥当だが、それだけで別所属団員の紐付けは防げない。`asset_inspections`の対象片方のみCHECK、`issues`の対象一つCHECKは記載済みなので維持し、保管場所にも同じ規則が適用されるか確認する。D1は外部キーと削除アクションを扱える。[D1 Foreign Keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)

当初は1 DB＋`units`と所属検査を維持すればよい。分団ごとのDB分割、汎用テナント管理基盤、空間専用サービスの導入を初期から要求しない。複数所属ユーザーを将来許す場合は現在のUSERS対MEMBERSの0..1関係を見直すが、今から完全な複数所属UIを実装する必要はない。

### 4.3 Google Maps・料金・規約

次表は一般料金表の無料枠と最初の有料帯（USD/1,000課金イベント）。契約割引・地域条件・税は除く。P0が呼ばないAPIの料金も確認したが、採用を提案するものではない。[Google公式料金表](https://developers.google.com/maps/billing-and-pricing/pricing)

| API / SKU | 課金単位 | 月次無料枠 / 最初の有料帯 | FireOSでの扱い |
|---|---|---|---|
| Maps JavaScript / Dynamic Maps | 地図ロード | 10,000 / $7 | P0で利用。文書01の296行は整合 |
| Dynamic Street View | パノラマ | 5,000 / $14 | P0対象外。標準Street View導線を含め呼出し有無を確認 |
| Maps Static / Static Maps | 静止画リクエスト | 10,000 / $2 | P0では不要。障害時代替として自動追加しない |
| Geocoding | リクエスト | 10,000 / $5 | P0は住所自動変換を要求しない。手入力の目印を優先 |
| Places Autocomplete Requests | リクエスト | 10,000 / $2.83 | P0不要。セッション構成/終端要求で課金条件が変わるため追加時再設計 |
| Places Details Essentials / Pro | リクエスト | 10,000 / $5、5,000 / $17 | 取得フィールドでSKUが変わる。独自施設検索に使う必要はない |
| Routes Compute Routes Essentials | リクエスト | 10,000 / $5 | P0不要 |
| Routes Compute Route Matrix Essentials | 起点×終点の要素 | 10,000 / $5 | P0不要。1リクエストが1課金とは限らない |
| Maps URLs | 外部アプリ/ブラウザへのリンク | APIキー不要 | MAP-09の方法は妥当。FireOS側でRoutes APIを呼ばない |

Mapロード、Places、Street View、Routesは別課金であり、JavaScript APIの読み込みだけを見て「地図料金に全部含まれる」としない。詳細な単位は[Maps JavaScript Usage and Billing](https://developers.google.com/maps/documentation/javascript/usage-and-billing)、外部リンクは[Maps URLs](https://developers.google.com/maps/documentation/urls/get-started)で確認した。

施設の独自マーカーはAdvancedMarkerを第一候補にできる。旧`google.maps.Marker`は非推奨で、AdvancedMarkerではmarker libraryとMap IDが必要。クラスタリングは描画負荷の対策であり、APIが取得しなかった施設を補完しない。[Google Advanced Markers移行](https://developers.google.com/maps/documentation/javascript/advanced-markers/migration)

ブラウザキーは利用者から見える。HTTPリファラー制限＋API制限を必須とし、localhost/ステージング/デモ/本番を分ける。広いワイルドカードやサーバー用キーの共用は避ける。キー制限はFireOSの施設データ認可の代わりにならない。[Google API Security Guidance](https://developers.google.com/maps/api-security-best-practices)

規約上、Google帰属表示を下部シートや独自UIで隠さず、公開してアクセス可能な利用規約/プライバシーポリシーを用意する。認証制アプリ自体を禁止しているという意味ではない。独自の施設台帳はGoogle提供コンテンツと分離し、地図画像/タイルをService Workerへ保存しない。[Maps JavaScript Policies](https://developers.google.com/maps/documentation/javascript/policies)

将来Geocoding等を追加する場合、取得座標・住所を一律に自前所有データとみなさない。Service Specific TermsにはAPIごとの保存条件と利用者間の再利用制限等があるため、共有台帳への永久転用が当然に可能とは判断しない。P0の手入力/GPS/許諾台帳と、Googleが返したデータの出典を分ける。[Google Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)

Google Mapsの一般規約には、利用/障害によって死亡・重大な傷害等が合理的に予想されるHigh Risk Activitiesの制限がある。「消防団向け」という名称だけで禁止とは断定できない。現P0の事務・訓練・事後記録は、災害現場での水利選択/誘導をサービスに依存する設計とは区別して評価する。「唯一の手段ではない」と書くだけで将来用途の適合が保証されるわけでもない。現場運用へ広げる際は実用途と契約を確認する。[Google Maps Platform Terms §3.2.2 / High Risk Activities定義](https://cloud.google.com/maps-platform/terms)

地図障害時の施設一覧代替は妥当。ただしGoogle障害とWorkers/D1障害を分け、後者にはオンライン一覧も使えないことを運用演習へ反映する。座標に加え管理番号・目印・最終確認日時が必要。Googleの背景地図をオフライン提供できる前提は置かない。

### 4.4 AI・Jev・承認の検証

`typesafe/jev`は実在し、Workers bindingの`env.AI.run`で`state`と`questions`を渡す公式例がある。質問型は`noul`/`choice`/`score`であり、一般的なチャットの`messages`だけを渡す設計とは異なる。応答には`model`、`answers`、`usage`がある。カタログ上のcontext windowは32,000 tokensで、third-party / zero data retentionと表示されている。[Cloudflare Jev](https://developers.cloudflare.com/ai/models/typesafe/jev/)

TypeSafe側でもChoiceは選択肢、Scoreは尺度、Noulは0〜1値を返す仕様が確認できる。Noulの回答は直接booleanではなく、別`confidence`がある前提にもできない。FireOSの「追加確認必要」という意味に合わせて閾値・保留帯を評価し、否定/複数異常は複数の独立質問または補助フラグで扱う。公式のconfidenceは正答保証ではない。[TypeSafe Introduction](https://docs.typesafe.ai/introduction)、[Noul](https://docs.typesafe.ai/primitives/noul)、[Confidence](https://docs.typesafe.ai/confidence)

推奨するP1の契約は、サーバーが質問と選択肢を固定し、入力を最小化した後に呼び出し、戻り値のキー・型・許可カテゴリ・数値範囲を検証して、独自の候補DTOへ変換する方式。`needs_manual_review`はモデルの選択肢とアプリの処理状態を混同しない。質問設計を保存する版、実際に返ったモデル版、元報告の版を残す。モデルのエイリアスだけで再現性を保証しない。

採用理由は自由記述の振り分け時間を削減できる場合に成立する。30名未満・月1〜2回ではAIコストより評価データ作成とレビューUIの実装負担が大きくなり得る。固定項目の選択、点検期限、権限、数量不足の算術判定はルールで処理し、自由記述にJevを使う。手動カテゴリ選択との比較で修正件数/所要時間が改善するかを示せばポートフォリオ価値もある。

LLMは日本語の報告下書きに限定し、入力から決まる人数/時刻をサーバーで集計する。JSON Schemaへの適合だけで未記載事実の生成を防げないため、確定前に元メモと差分を表示し、機械的な整合チェックと人の確認を行う。選択モデルがJSONモードに対応するかは**未検証**。未選定のモデルIDやAPIスキーマを本書で実装仕様として捏造しない。

評価は、質問を調整する集合と最終評価集合を分け、クラス件数・人手ラベルの根拠・複数異常・曖昧・否定・誤字を含める。精度/マクロF1に加え、保留率、異常を`no_issue`とする件数、承認時の修正、失敗率・p95・費用を比較する。高confidenceでも正式変更/一斉通知の承認を省略しない。合格閾値をここで勝手に決めず、担当者が許容する見逃しと作業負担から事前に決める。

Workers AIは無断でCustomer Contentをモデル学習等に使わないと説明するが、モデルライセンスや併用ストレージの保持は別に確認が必要。[Workers AI Data Usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/)

Jevのモデル個別Terms/Licenseリンクの本文は今回取得できず、TypeSafeの契約全文・処理地域・国外移転・障害時の保持例外は**未検証**。zero data retentionという表示から「国内処理」「全ログ不保存」を推断しない。AI Gateway、Workersログ、D1にFireOS自身が残す情報も送信先/保持期間の一覧に含め、実データ送信前に確認する。

### 4.5 認証・添付・監査の設計選択

Better AuthのHono統合は`auth.handler`にWeb Requestを渡す方式。公式文書はWorkersでのAsyncLocalStorage用互換設定も示している。`/api/auth/*`と`/api/v1/*`の境界を明示し、認証側の保護が自作業務APIへ自動で適用されると考えない。同一オリジン、Secure/HttpOnly/SameSite Cookie、許可Origin、CSRF、認証/アップロード/AIのレート制限をどの層で担うか決める。[Better Auth Hono Integration](https://better-auth.com/docs/integrations/hono)

セッションCookie cacheを有効にすると、失効したセッションがキャッシュ期限まで他端末で有効になり得る。P0は最新の所属/停止状態をサーバーで確認する方式を推奨。権限をCookieへ焼き付ける場合は失効時間の契約が必要。[Better Auth Session Management](https://better-auth.com/docs/concepts/session-management)

R2署名URLは所持者が期限内に再利用できる。P0の少数利用なら、`GET /attachments/:id/content`が毎回セッション/対象の権限を確認してR2 bindingからストリーム配信する方が失効要件に合う。個人/機微情報は共有キャッシュへ保存しない。署名PUTを選ぶ場合も、一時領域へのアップロードから検査済み領域/状態へ確定させる手順が必要。[R2 Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

OWASPは、ユーザーから渡された対象IDごとの認可、アップロードの許可種類・実体検証・サイズ制限・サーバー生成名・認可を求める。FireOSには方向性が既にあるため、その実装可能な上限値・状態・例外を補う。検査のため機微写真を公開スキャンサービスへ無断送信する案は採らない。[OWASP API1 BOLA](https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/)、[OWASP File Upload](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)

監査ログは業務DBで保持する方針を明示し、短期のプラットフォーム実行ログを監査履歴の代用にしない。操作ID、操作者、対象、変更項目/必要最小限の差分、成功時刻を記録し、一般アプリ経由の更新/削除を禁止する。個人開発規模で専用の改ざん防止ログ基盤まで必須にする必要はないが、管理権限での変更可能性とバックアップの限界は文書化する。

### 4.6 非同期処理と簡素化案

Queuesはat-least-onceであり、順序やexactly-onceを前提にしない。再試行があることと、D1保存後にQueueへ送れなかったものを救済できることは別問題である。[Queues Delivery Guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)

P1の小規模案は、原本と処理待ちジョブをD1へ同時保存し、手動実行またはCronで回収し、必要ならQueueへ配送する方式。`source_id/source_version/question_version`などを一意にし、処理権の期限、実行中/失敗/成功、再試行時刻を管理する。外部推論が成功後にDB保存失敗した場合、推論呼出し自体の完全な一回性は保証できないため、重複候補の確定防止と再課金上限を分ける。

通知では同じジョブ基盤を流用できるが、承認した対象者/本文の版と実配送キーを紐付ける。DO導入時もD1を業務記録の正本にするか明示し、DOとの二重書込を根拠なく原子的とみなさない。小規模だからすべて同期、または将来性のため全サービスを今から導入、のどちらも不要。

### 4.7 仮定付き運用費の試算

原文にない数量は次表の**試算仮定**であり、要件や予測値ではない。実データ件数、デモ閲覧数、写真圧縮、保持年数の確認後に置換する。USD、税・為替・ドメイン・メール/通知サービス・外部バックアップ費を除く。

| 対象 | 公式条件と試算仮定 | 試算・留意点 |
|---|---|---|
| Workers | Free 100,000 req/日・CPU 10 ms/呼出し。Paid最低$5/月、1,000万req/月とCPU 3,000万ms/月込み | API 50,000 req/月・平均CPU 20 msなら合計100万msでPaid内。ただしFreeは平均ではなく各呼出し上限が問題。パスワード処理/写真検査を実測しPaidを選ぶ。[Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)、[Workers Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| D1 | Free 500万rows read/日、10万rows written/日、合計5 GB。仮に月200万read/1万write、DB 50 MB | 日次集中と単一DB 500 MB制限を満たせば追加$0。料金は返却件数ではなく走査行数。索引・デモ・監査・migrationも含める。[D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| R2 Standard | 無料10 GB-month、A 100万/B 1,000万回/月。超過保存$0.015/GB-month | 写真120枚/月×2 MB＝0.24 GB/月増、1年で2.88 GB（別複製等を除く）。単一原本なら無料内の例。保持年数とバックアップで増加する。[R2 Pricing](https://developers.cloudflare.com/r2/pricing/) |
| Dynamic Maps | 本番30人×月10セッション×1ロード＋デモ2,000ロード＝2,300/月と仮定 | 当該SKU $0。公開デモ等で計20,000なら超過10,000×$7/1,000＝$70/月。同一請求先の他プロジェクト利用も集計に注意。[Google Pricing](https://developers.google.com/maps/billing-and-pricing/pricing) |
| Queues（P1） | Free 10,000 operations/日・保持24h、Paid 100万operations/月込み、超過$0.40/100万。一般に1配送は書込/読取/削除の3操作 | 月1,000件・小さいメッセージなら通常3,000操作＋再試行。日次枠内の例では追加$0。24h停止で消えるジョブをD1側に残す。[Queues Pricing](https://developers.cloudflare.com/queues/platform/pricing/) |
| Jev（P1） | カタログは入力100万tokens当たり$0.042、出力$0。質問等を含め1,000入力tokens×1,000件と仮定 | 単純計算$0.042、再試行・複数呼出しは別。一般Workers AIの無料Neurons枠がこのthird-partyモデルにどう適用されるかは未検証。無料を確約しない。[Jev料金](https://developers.cloudflare.com/ai/models/typesafe/jev/) |
| 生成LLM（P1） | モデル未定。一般Workers AIは10,000 Neurons/日の無料枠、超過にはPaid等の条件あり | 実モデルの入力/出力tokens単価×件数＋再試行で計算。全モデル無料やJevと同じ単価とはしない。[Workers AI Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |

この数量仮定ではP0は**Paidを使うならCloudflare基本$5/月＋Maps $0＋R2追加$0の例**になる。Free $0で運用できるかはCPU等の検証次第で、文書の「無料枠を基本」は保証ではない。公開デモのアクセス増や地図再マウントが主な費用変動要因になり得る。写真のストリーム取得は低CPUにできても、変換/検査のCPUは別測定が必要。

通常の月次使用量確認に加え、地図/AIの急増、D1日次枠、R2増分への通知、停止担当と手順を設ける。月額上限をユーザー判断で定め、通知だけで課金が止まると扱わない。

### 4.8 変更提案とトレードオフ

| 提案 | 変更理由・メリット | デメリット | コスト・難易度 / 採用タイミング |
|---|---|---|---|
| P0の添付GETをWorkersで認可・配信 | 旧署名URLの失効不一致を避け、07の要求に近づける | 取得ごとにWorker/D1照会。ダウンロード済みデータの回収はできない | Worker req分増、R2 egressは無料。少数規模では小さい見込み。難易度低〜中、P0 |
| Workers Freeに固執せずPaidを選択可能にする | 認証CPU、処理余裕、D1容量/Time Travel期間に余裕 | 月額固定費が発生 | 基本$5/月、難易度低。PoC計測後に判断 |
| P1はD1ジョブ＋Cronから開始しQueuesを必要時追加 | 部分投入失敗から回収可能。少量なら構成を抑えられる | ジョブのclaim/再試行/期限管理は自作、即時性に制約 | D1/Cron利用増。難易度中。Queues利用も無料枠あり、信頼性が必要なら当初から併用可 |
| P1のDO導入前にポーリングで試験 | デプロイ対象と接続/再接続実装を削減 | 即時性、通信効率は劣る | 30端末×毎30秒×2h＝7,200読取reqの試算。常時は使わず画面表示中限定案。難易度低、試験で更新遅延が不適合ならDO |
| Jevは手動分類/ルールと比較後に採用 | 効果がなければ運用を軽くできる。比較評価自体が技術実績になる | 手動の負担は残る。AI紹介の見映えは控えめ | 手動は推論$0。難易度低、P1評価ゲート |
| PostGISは空間演算要件が出るまで延期 | 現在のCloudflare中心構成と費用を維持 | 将来の移行でデータ/問い合わせを変更 | 導入時は外部Postgresの契約、接続、移行・復旧が増え難易度中〜高。提供事業者未選定のため実額未検証。P2の具体要件/実測後に見積もる |

## 5. ER図・API・画面の整合性

### 5.1 P0要件から受入試験までの対応

以下のAPI/SCR/TCは既存文書に実在するID。欠落箇所に架空の既存IDは割り当てていない。「部分」は概念上の対応があるが、その業務の完了を保証する仕様/試験が不足することを示す。

| 要件 | 画面 | API | データモデル | テスト | 整合性評価 |
|---|---|---|---|---|---|
| AUTH-01 招待・認証 | SCR-01/17 | 認証ライブラリへ委任、API-01 | users/members、認証固有表は後決め | TC-01は未認証拒否のみ | 招待作成/消費/取消と名簿紐付け不足（F02） |
| AUTH-02 ロール | SCR-17、全画面 | API-01、各APIの概略権限 | roles/member_roles | TC-02、回帰試験 | 担当範囲と役割変更契約が不足（F01） |
| AUTH-03 団員CRUD | SCR-15/17 | API-02〜04 | membersに連絡先/公開範囲の具体項目なし | 明示TCなし | 項目別認可/保持、対応TC不足（F01、F12） |
| AUTH-04 利用停止 | SCR-15/17 | API-04と認証側の失効連動は未定 | users.status/members.status | 08の76行に旧セッション回帰項目 | 要件の再ログイン停止と旧セッション失効を統一（F02） |
| ACT-01 予定登録/編集 | SCR-08〜10 | API-05〜07、編集APIなし | activitiesに担当保存先なし | TC-03 | 登録は部分整合、編集契約不足（F03） |
| ACT-02 出欠 | SCR-09 | API-08 | activity_attendanceのUNIQUEあり | TC-03、TC-15 | responseとactual_status分離は良い。未回答/締切/version不足（F07、F09） |
| ACT-03 実績 | SCR-09 | API-09 | actual_statusのみ明示、実内容/時間不足 | TC-04 | P0実績保存契約不足（F04） |
| ACT-04 履歴検索 | SCR-08 | API-05、フィルター未定義 | activities/attendance | 明示TCなし | 日付/種別/参加者、安定順、日時境界不足（F12、F14） |
| MAP-01/02 表示/種別 | SCR-03 | API-10 | facilities.type/座標 | TC-05、TC-17 | 概ね整合。mapId・大量表示・外部障害の実証は必要 |
| MAP-03 登録/修正 | SCR-05、SCR-04から編集 | API-11/13 | facilities、番号UNIQUEは候補 | TC-06/07、TC-16 | 座標範囲は整合。確認失効/一意範囲不足（F13、F16、F28） |
| MAP-04 検索/絞込 | SCR-03 | API-10、bbox/type/verificationStatus | 範囲検索可能 | TC-08 | 「点検状態」と「位置確認状態」の違い、取得全件性不足（F14） |
| MAP-05 詳細/写真 | SCR-04 | API-12/27 | facilities/attachments/links | TC-09/13 | 非公開方針は整合、添付の確定/失効は不足（F10、F11） |
| MAP-06 点検・異常関連 | SCR-06/07 | API-14/16/17 | inspections→facilities、issues→facilitiesはある | TC-09/10 | inspections→issuesと明細・訂正の保存不足（F06） |
| MAP-07 確認状態 | SCR-04/06/07 | API-13/17 | verification_status、result、issues.status | TC-10 | 位置/点検/対応の状態辞書・確定者不足（F07） |
| AST-01 台帳 | SCR-13/14 | API-18/19はGETだけ | vehicles/equipment | TC-11は車両のみ | 作成・変更・資機材検証不足（F03、F12、F13） |
| AST-02 資産点検 | SCR-14、専用フォーム未記載 | API-20 | asset_inspections、片側対象CHECKあり | TC-11 | 写真/コメント/明細/履歴取得の具体化不足（F03、F06、F11） |
| AST-03 異常・対応履歴 | SCR-07/14 | API-16/17 | issues/issue_events | 明示TCなし | 進捗/履歴の原子性、確認・解決のTC不足（F07、F08、F12） |
| DSP-01 イベント登録 | SCR-11/12、作成導線未記載 | API-21/22 | incidents.kind | TC-12は模擬のみ | 種別は整合。詳細取得、訂正/状態変更の契約不足（F03、F07） |
| DSP-02 参集/参加 | SCR-12 | API-23 | incident_participants、UNIQUEあり | TC-12 | 本人/代理権限、遷移、時刻・履歴/競合不足（F01、F07、F09） |
| DSP-03 車両/活動リンク | SCR-12「関連記録」 | 対応API/本文なし | incidentsからの関連の定義なし | 明示TCなし | P0/P1の境界と保存・取得の両方を補う（F05） |
| COM-01 お知らせ | SCR-16 | API-24/25 | announcements、対象者/公開先なし | 明示TCなし | 公開対象/公開状態と閲覧制御不足（F01、F07、F12） |
| DOC-01 添付 | SCR-04/06/09/14 | API-26/27 | attachments/attachment_links | TC-09/13、回帰試験 | 登録から検査・確定・取得までの契約不足（F10、F11） |
| DASH-01 集計と導線 | SCR-02/07/08 | API-28 | activities/attendance/issues等から算出 | 明示TCなし | 未回答母数/確認待ち/対象範囲の定義と一覧一致TC不足（F01、F12） |
| NFR-05/07 整合性/監査 | 各編集画面/SCR-17 | 共通規約、監査取得APIなし | audit_logs、version検討 | TC-14〜16 | 処理途中失敗、同時POST、同一キー別本文、PUT旧再送を追加（F08、F09） |
| NFR-04/06 障害・復元 | 地図→一覧、エラー状態 | 共通エラー | D1/R2 | TC-17、復元成果物記載 | 復元の具体シナリオ/RTO/RPO/実施時期不足（F18） |

### 5.2 P1/P2と統合モデル

| 要件 | 既存の対応 | 不足・判断事項 |
|---|---|---|
| AUTH-05 MFA | 07で導入検討 | 管理者優先、紛失/再設定、認証方式との整合をP1前に決定 |
| ACT-05、COM-02 通知 | 02のQueues/Cron、AI-04 | 実配送API/通知表/対象と既読の意味なし（F26） |
| ACT-06、DASH-02 集計 | 要件と画面上の実績参照 | 年度境界、出動との二重計上、出力形式/権限が未定 |
| MAP-08 CSV、MAP-09 外部地図 | 要件のみ、外部URL方針 | CSVプレビュー/不正列/重複/取込原子性、機微地点の外部アプリ送信確認 |
| AST-04 期限 | SCR-02に期限が近い点検表示 | 次回日/周期/期限基準とタイムゾーンのモデルなし。P0表示から除くかP1と明示 |
| AST-05 使用履歴 | 04で活動↔施設/車両を省略と注記 | DSP-03との最低限/高度履歴の境界、資機材数量管理の要否（F05） |
| DSP-04/05 同期 | DO/PWA候補 | 更新遅延の合否、正本、オフライン競合/再送/再認証（F24、F26） |
| AI-01/02/05 分類/評価 | API-29/30、ai_evaluations、08の例文 | Jev型、ジョブ、質問版、評価ゲート（F20、F21） |
| AI-03/04、DOC-02 下書き/承認/タスク | SCR-18/19、API-31/32 | report本体/版・編集/承認/出力、確定分類・タスクの効果（F22） |
| MAP-10 巡回 | 構想のみ | 巡回単位・最適化目的・道路データ等をP2で確認。現時点でGIS基盤追加不要 |
| AI-06/07 RAG/横断 | 要件・AI方針のみ | 検索ACL・文書版・根拠・tool実行の承認/監査（F23）。P2の未定義をP0阻害としない |

活動→報告書、出動→車両/活動、点検→異常、AI→承認結果は、現ERに線がないこと自体よりも、**本文にキー・多重度・保存項目・更新操作が揃わないこと**が問題である。施設↔資機材・車両↔資機材の関係はERに存在する。両方が指定された場合、数量を持つ台帳行が複数場所に分割される場合の意味だけを追加判断すればよい。

### 5.3 テスト計画の最小補完案

TC-01〜18の置換ではなく、欠けているP0受入の補完を提案する。

- 招待外登録、期限切れ/再利用招待、名簿誤紐付け、停止済みのログインと既存セッション、役割変更直後の取得を拒否する。
- 一般団員/担当者/幹部/管理者の操作と返却項目を比較し、対象ID・添付ID・関連団員ID・公開先を入れ替えた否定ケースを実行する。将来分団分離の下地は架空の別unitで検証できる。
- 予定編集→出欠→実績登録→訂正→履歴検索で、予定と実績が別に残ることを確認する。
- 点検明細・写真→異常生成→確認→担当→解決/訂正を辿り、起点点検と履歴を参照できることを確認する。
- 点検途中のDB失敗、添付確定失敗、同時二重POST、応答消失後の再送、同一キー別本文、古いPUT再送により部分記録・上書きが起きないことを確認する。
- 車両だけでなく資機材の登録/変更/点検/異常、出動↔活動/車両の関連を確認する。
- お知らせの非公開/公開先、ダッシュボード数値と元一覧、施設取得が100件を超えた地図と一覧の一致を確認する。
- 地図のみ失敗とAPI停止を分け、入力が保存されたか不明な場合も成功表示しない。Google帰属表示がモバイルUIで隠れないことを確認する。
- D1時点復元後にR2欠落/孤児・集計・認可を照合し、実運用前に復旧時間と損失を測定する。

Cloudflare制約の検証は汎用SQLiteのテストだけで代替せず、Wrangler/Workers向け実行環境とステージングを使い分ける。外部Maps/AIの限定アクセスは、認可や画面テストすべてを毎回実課金APIに依存させない構成がよい。[Hono Workersのテスト案内](https://hono.dev/docs/getting-started/cloudflare-workers)

## 6. MVPの再評価

現P0は範囲が広いが、総合管理を目的とする以上、GISだけに縮小する必要はない。各領域を最小の縦の業務フローとしてつなぎ、帳票・通知・リアルタイム・AIを後段にすれば成立する。以下は再評価案であり、現行優先度の変更を確定しない。

### 6.1 MVPで必須と考える機能

| 領域 | 最低限の成立範囲 | 複雑性を抑える案 |
|---|---|---|
| 認証・組織・団員 | 招待、ログイン/ログアウト、停止、ロール、最小名簿 | 初期unit一件、役割は固定コード。機微連絡先は必要性が合意されたものだけ |
| 活動・出欠・実績 | 予定作成/編集/中止、本人回答、担当者の実績/参加登録、履歴検索 | 高機能カレンダーや反復予定を必須にせず一覧で完結 |
| GIS | 消火栓/水槽/格納箱の登録/修正、検索、地図/一覧/詳細 | 座標/目印は手入力・許諾台帳。住所自動検索・経路API不要 |
| 点検・異常 | 対象→明細/写真→確認待ち異常→担当/対応→履歴 | 様式は最小限。自動使用可否・独自緊急度判定を加えない |
| 車両・資機材 | 台帳作成/修正、保管場所、点検/異常参照 | 予約・在庫移動取引・保守契約管理を増やさない |
| 出動記録 | 種別・概要・参加/参集の手動記録、車両/活動の参照 | P0の用途は訓練/事後記録。外部指令連携・プッシュ・DO不要 |
| お知らせ・添付・ホーム | 公開対象付きお知らせ、非公開添付、次回予定/未回答/要対応から詳細へ遷移 | 独立した文書管理製品を作らず共通添付として提供。高度月次帳票はP1 |
| セキュリティ・運用・デモ | サーバー認可、監査、再送/競合、地図障害代替、費用監視、架空デモ分離 | 専用運用基盤は不要。実データ運用前には許諾・復元試験を完了 |

AIの分類候補テーブルや承認APIをP0から動作させる必要はない。点検原本と人の確認を分け、将来その間に候補を追加できる構造を維持すればよい。要件01の407行の「AI推定」はAI無効時に該当なしとして試験を整理する。

### 6.2 MVP後に追加する機能

- 日本語評価を通過したJev分類、根拠のあるLLM下書き、版に紐付いた承認と実績出力。
- CSV入出力、点検期限、未回答確認依頼、通常業務の通知。年度集計と既存帳票への対応。
- PWAアプリシェルと、合意した自前データだけの下書き。同期競合・権限変更・端末紛失を試験してから限定運用。
- 参集情報の訓練での共有。必要な更新遅延がポーリングで満たせない場合にDOを追加。
- 詰所/車庫などの追加施設種別は、実台帳と用途を確認してから追加する。既存`type`と対象ごとの詳細項目を拡張可能にする。

### 6.3 現段階で不要または過剰な機能

マイクロサービス化、分団ごとのDB/Workerを自動発行する基盤、汎用ワークフローエンジン、常時WebSocket/DO、ベクトルDB/RAG、PostGIS・道路経路最適化、地図タイルの独自オフライン保存、常時GPS、正式な出動指令連携はP0に不要。現文書も多くを候補/将来とするので、これらを現在の実装済み過剰設計とは扱わない。

ポートフォリオとしては、サービス数より、3フローが同じ団員・施設・資産・履歴を参照し、権限外操作/競合/AI誤分類を正しく扱う証跡の方が設計力を示しやすい。AIの比較評価と失敗例はP1の独立成果物として公開できる。

## 7. 修正優先順位

### 7.1 開発開始前に必ず修正する項目

業務実装開始前の順序。PoCはこれと並行できるが、実データを使わない。

| 順 | 対応指摘 | 解決する内容 | 確認できる成果物・完了条件 |
|---:|---|---|---|
| 1 | F01、F02 | P0の対象範囲、認証/招待、担当・閲覧・代理・停止の境界 | 操作/項目別権限表、招待と停止フロー、Better Auth/D1での限定検証計画 |
| 2 | F05、F07 | P0/P1の関連付け境界、状態辞書、許可遷移 | 出動↔活動/車両の最低限を合意、共通状態/用語、遷移表 |
| 3 | F04、F06 | 活動実績・点検明細・異常起点・訂正の保存方法 | 論理カラムと関係・訂正履歴、画面入力との対応 |
| 4 | F08、F09 | D1内原子性、再送・楽観ロックの契約 | 代表操作のSQL/batch方針、冪等キー保存・再応答・0行競合処理 |
| 5 | F10、F11 | 添付転送/検査/確定/取得と権限失効 | 添付ライフサイクル図、許可形式/上限、取得方式と失効の受入条件 |
| 6 | F03、F12 | 上記契約を全P0 API/画面/受入へ反映 | P0 OpenAPI、主要DDL草案、全P0追跡表、統一したMVP完了条件 |

依存関係は、**権限・業務状態 → 保存モデル → 原子性/競合 → API/画面 → 受入**。認証や添付の選択によって実装方法が変わるため、UI実装後に仕様を合わせる順は避ける。

### 7.2 MVP実装中に修正する項目

| 指摘 | 解決期限 | 内容 |
|---|---|---|
| F13、F16、F28 | 各モジュールのDDL/API固定前 | FK・NULL・削除・索引、座標確認版、項目対応辞書 |
| F14、F19 | 地図/認証結合前 | bbox全件性と性能、同一オリジン・binding・runtime、APIとSPA分岐、migration |
| F17、F25、F27 | MVP受入前 | 数量見積もり、端末/回線/操作条件、代行管理、版・正式ID |
| F15 | デモを含む公開前 | 公開規約/プライバシー、帰属表示、用途境界の確認 |
| F18 | **実データ投入/実運用前** | RTO/RPO・保持、D1/R2復元、担当者、代替連絡手順の演習。AIやPWAの完成を待たない |

### 7.3 将来の拡張時に検討する項目

| 指摘 | ゲート | 内容 |
|---|---|---|
| F20、F21、F22 | P1 AI導入前 | ジョブ回収/重複/元版、Jev評価と契約、承認履歴・報告書編集/出力 |
| F24 | P0 GPSの具体化はMVP中、端末保存はP1前 | 精度不足/拒否/タイムアウト、端末下書き/削除/同期/再認証 |
| F26 | P1通知/リアルタイム導入前 | 配送方式・失敗/既読・承認対象。DO導入を必要遅延から判断 |
| F23 | P2 RAG導入前 | 文書ACL/版/引用/削除同期、根拠不足の保留 |
| F13、F14、F15の拡張分 | 複数分団/高度GIS/現場用途の開始前 | 複数所属、共有施設の所有・参照、空間処理、外部データ/Google規約を再評価 |

Mediumの将来事項をすべてP0の着手条件にしない。P1の品質やP2のRAGを待つより、HighのP0契約を先に固める。

## 8. 未決事項と確認質問

利用者・開発者が設計を確定する際の質問一覧。推奨は暫定案であり、本レビューで採用済みにはしない。

| ID | 確認質問・選択肢 | 推奨する選択肢と理由 | 判断者・期限 |
|---|---|---|---|
| Q01 | 初回は架空デモか、実分団の試験利用か。正式な管理主体/承認者は誰か | 架空デモを先に完成し、実データ利用を別ゲートにする。未承認事項を開発上の仮定から分離できる | 分団責任者/開発者、実データ投入前 |
| Q02 | 名簿に氏名/所属/役職以外の何が必要か。住所/電話/緊急連絡先は誰が見られるか | 実用上必要な項目だけ収集し、連絡先を全団員へ一律公開しない。具体項目は現規程で合意 | 管理主体、権限/DDL固定前 |
| Q03 | 認証はメール＋パスワード、外部ID等のどれか。招待・再設定は誰が届けるか | Better Authを維持して一方式を先にPoC。メール方式なら配送手段/費用/到達失敗を決める。認証自作への切替は避ける | 開発者/運用責任者、基盤実装前 |
| Q04 | 担当範囲は班/施設群/活動ごとのどれか。幹部の名簿・権限管理は可か | P0は固定ロールと明示的な担当割当で十分。細かな権限編集UIを作らず、条件を表にする | 分団責任者、業務実装前 |
| Q05 | 出欠の代理入力・受付締切、活動実績の訂正者/承認者は誰か | 回答は本人、代理/実績訂正は許可担当者とし操作者を残す案。実施者と入力者を区別できる | 活動担当、状態設計前 |
| Q06 | 活動時間は活動全体か団員ごとか。予定なし実績を許すか | 当初は実開始終了と実参加を必須軸とし、団員別時間は帳票需要を確認して選ぶ | 活動担当、F04修正前 |
| Q07 | 点検票の実項目と、判定不能/確認待ち/対応完了の意味は何か | 既存の点検票を基準とし様式版を保持。使用可否の判断をAIや自由記述分類に委ねない | 点検責任者、GIS/点検実装前 |
| Q08 | 施設番号は種別内/分団内のどちらで一意か。識別名のみを許すか | 現台帳を優先し、表示番号と内部IDを分離。番号生成が不要なら無理に追加しない | 台帳保有者、登録API固定前 |
| Q09 | 座標の提供元・許諾・公開範囲・実件数は。位置変更後は確認を戻すか | 許諾台帳/GPS/手入力の出典を残し、重要変更は再確認候補へ戻す案。確認済みの意味を保てる | 台帳保有者/点検責任者、実データ登録前 |
| Q10 | P0出動記録は事後入力のみか、訓練中の参集入力も使うか | 実出動は事後記録、参集の進行入力は訓練から。正式連絡は既存手段を継続 | 分団責任者、F05/F07修正前 |
| Q11 | DSP-03の車両/活動リンクをP0に残すか、AST-05と共に延期するか | 最小の参照リンクをP0に残し、数量・時間の詳細使用履歴をP1へ。総合管理の価値を維持 | 開発者/分団担当、P0確定前 |
| Q12 | 資機材は個体台帳か数量管理か。複数保管場所の分割を許すか | 個体/集計行の意味を台帳に合わせる。P0で汎用在庫台帳・引当を作り込まない | 資機材担当、AST実装前 |
| Q13 | 退団/権限変更後、添付の残存アクセスを何秒まで許すか | P0はWorkers認可取得を推奨。署名GETは許容時間を合意する場合に限定 | 運用責任者、F10修正前 |
| Q14 | 添付は写真だけかPDF/Officeも必要か。ファイル/件数上限と検査は | P0は必要形式を絞り、能動コンテンツを安全に配信する。写真の顔/ナンバー/EXIF方針も決める | 運用責任者/開発者、F11修正前 |
| Q15 | 故障/誤削除の許容損失と復旧時間、履歴/名簿/写真の保持年限は | D1 Time Travel＋定期エクスポートとR2誤削除対策を組み合わせ、実復元からRTO/RPOを決める案。具体日数は規程優先 | 管理主体、実運用前 |
| Q16 | 費用負担者と月額上限は。公開デモにどの程度のアクセスを見込むか | 認証実測後に$5/月Paidを許容する案、デモ含む地図ロードを別見積もり。超過通知と停止担当を決める | 費用負担者、クラウド契約/公開前 |
| Q17 | AIへ送れる文章・個人情報・位置の範囲と、Jev採用の成功条件は | 初期は匿名化した点検本文に限定し、手動分類より修正負荷が低いことを採用条件にする。日本語評価閾値は事前合意 | 管理主体/レビュー担当、P1前 |
| Q18 | 通知はアプリ内/メール/Web Push等のどれか。既読や配送失敗をどう扱うか | 通常業務から一チャネルずつ。既読を参加/安否の確定としない | 運用担当、P1通知前 |
| Q19 | オフラインで必要なのは閲覧、写真付き点検下書き、参集のどれか | P1は自前点検の下書きから。機微な名簿/出動情報を丸ごと端末へ保存しない | 利用者/管理主体、P1 PWA前 |
| Q20 | 管理者不在時に誰が代行し、アカウント喪失/漏えいを誰に連絡するか | 代行可能な担当者と復旧窓口を決める。最後の管理者削除を防ぐ案 | 運用責任者、実運用前 |

未決事項のうち、実データの許諾・保持年限は架空デモの技術検証を止める理由にはしない。権限・状態・保存契約は架空デモでも必要なので、未決のまま業務機能を実装しない。

## 9. 最終判定

**「現在のFireOS設計ドキュメントは、このまま実装を開始して問題ないか？」への回答は、いいえ。判定は「重要事項の見直しが必要」。**

実装を妨げる具体的理由は、(1)担当範囲・招待/停止の契約未確定、(2)P0の予定編集/台帳操作と活動実績・点検明細・出動連携の不足、(3)D1更新/監査の原子性と再送・競合契約の不足、(4)添付の確定/失効の不一致、(5)MVP完了条件の矛盾である。これは技術スタックの根本破綻や、AIが指令を自律実行する設計を発見したという評価ではない。**Critical 0件、High 12件**。

次の条件を満たせば「条件付きで実装開始可能」へ変更できる。

1. F01〜F12のP0契約と文書間の矛盾を解消し、関係者の判断事項を明示する。
2. 代表フローが画面→API→保存先→認可/状態遷移→受入試験まで追跡でき、P0 OpenAPIと主要DDL草案がある。
3. Workers上の認証/D1/添付/地図のPoCで、選択版・CPU・Cookie/失効・更新方法を確認し、必要ならPaid条件を合意する。

実データ運用へ進む条件はさらに、利用許諾・責任者・項目別アクセス/保持、公開ポリシー、費用通知、D1/R2復元試験、既存連絡系統の代替運用が整うこと。AI/RAG/DO/PWAはそれぞれの導入ゲートで検証すればよく、P0の完了を待たせる必要はない。

### レビューの検証限界

全11文書を確認し、公式のCloudflare/Google/TypeSafe/ライブラリ/OWASP資料と照合した。モデル呼出し、課金アカウント、実データの規程適合、Google契約の個別適用、端末UX/アクセシビリティ、実Workers上のライブラリ組合せは実証していない。未検証事項を実装不能や不採用と断定していない。既存設計書の修正、ソース実装、要件の無断確定は行っていない。
