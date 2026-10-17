# PH6 レビュー・修正サイクル（2026-10-17）

ph0〜ph5と同じ手順。範囲はPH5最終commit **d9f389e**〜HEAD（レビュー開始時 49da3eb。T072〜T077の実装7コミット〔f482fff・749d852・c1b5a94・3081b12・4ac013e・f637bdb・e0d31c3〕＋docs統合）と関連docs。レビュー担当は**読み取りのみ**（ファイルの変更・git書き込み操作・試験の実行は禁止。ls/grep等の読み取りコマンドは可）。指摘は**メインのエージェントが一件ずつコード・試験で確かめ**、分類してから直す。個々のタスクレビュー（実装直後・タスクごと）はsubagent-drivenの工程として別途実施済みで、そちらの重大指摘はT073のImportant 1件のみ（修正済み。docs/evidence/ph6.md「赤→緑の扱い」節）。

## 第1回

### 依頼
独立したサブエージェント4体を並行で起動：**A=正確さ・セキュリティ**（cursorの暗号化・認可版不一致のresync・不可視イベントで走査位置を進める・再送・PII・認可済snapshot）／**B=docs/16完了条件と試験の妥当性**（30端末実接続・実端末をモックで完了扱いにしない。V06の局所完了を正直に。実数は自分で計測）／**C=prototype準拠**（360/1280px・44px・トースト位置対応表・オフライン表示の偽装なし）／**D=docsと実装の整合**（docs/05 §8×実装・docs/11×states.ts・docs/04×DDL）。各体に差分パッケージ（.superpowers/sdd/16_実装タスク一覧/review-d9f389e..49da3eb.diff）と報告形式（ファイル:行、問題、発生条件、重大度、根拠。推測は「要確認」）を渡した。

### 指摘と分類（件数は報告の項目数。合計: 高1 / 中3 / 低11 / 要確認3）

| 観点 | 指摘 | 重大度 | 分類 | 対応 |
|---|---|---|---|---|
| A高1 | 代理参集（API-23）の通信断下書きが同期時に**本人の参集として適用**される（capture.tsのplanForがparams.memberIdを検査せず、allowlistはp.memberIdに固定＝allowlist側の設計意図「代理は同期しない」に反する。T076×T077のcross-task seamでタスクレビューの網外） | 高 | 確認済み（コード実検） | planForがmeを取り代理API-23は下書き化しない（useMutation→captureOfflineDraft→planForの一経路のみを確認。赤試験＝契約形そのもの＋変異DETECTED） |
| A中1 | API-81/82にPER-13のrequirePermission無し（docs/05権限列「PER-13＋元操作/PER-13本人」と不整合。現行はPER-13=unitWide ALLで実害ゼロの潜在ギャップ。API-80は検査済み） | 中 | 確認済み | sync routesの入口にPER-13検査追加（API-80と同一形状）。赤試験＝役割を外した主体でAPI-82照会・API-81台帳再送が403（新規POSTは修正前から元操作権限で拒否されるため層防御として区別記録） |
| A中2 | activity_attendanceイベントがUNIT_WIDE_VISIBLEで全役割に配信（API-07の読取ACL〔PER-03管理権限は全行/本人は自分の行〕より広い。docs/05 §8「現在のACLでfilter」・docs/04:166趣旨と不整合。audience一覧との組合せで回答状況を排除法特定可能） | 中 | 確認済み（activities.ts:299-307との対照で実検） | UNIT_WIDE_VISIBLEから除外し行ごと判定（本人の行 or その活動のPER-03管理権限。activities.tsと同一のauthorize式）。赤試験＋変異DETECTED |
| B中1 | T077が開始条件未達（T033部分完了）のまま着手・「完了」扱い。帰結（訂正のcapture対象外・競合は手動再入力注記）は正直記録済みだが、T033完成時の接続作業の割当が未記載 | 中 | 確認済み（docs） | docs/16 T077状態欄に着手経緯を明記＋T033状態欄に「訂正UI完成時はcapture allowlist追加＋offline-sync e2e再走」を割当。ph6.md・docs/16:5/40/78の局所完了表記を「T073＋T077〔依存未達の接続が残る〕」に修正 |
| D中1 | docs/04:167 sync_operations行に0031実装の注記・operation_code/target_id列・status語彙が未反映（docs/04が正本。:155-157の前例どおり同時改訂の規律漏れ） | 中 | 確認済み（docs） | docs/04:167を実DDL（0031）と一致する形へ更新（NOT NULL＋CHECK・applied/conflict/rejected・T076実装（0031）注記） |
| D中2 | ph6.md「非可視行のACL判定…D16の実測課題として記録」は誤引用（docs/14に該当記録が無い。実装値SCAN_MAX_ROWS=1000自体は正しい） | 中 | 確認済み（docs） | docs/14 D16にT072分の記録を新設（1行ずつSQL・1000行上限・将来実測課題）＋ph6.md表現を実在の記録へ訂正 |
| A低1 | entityIdのみのfilterで発行したresumeCursorが次回必ず409 cursor_invalid（shippedクライアントは両方送るため未発火。filterOfは死に経路） | 低 | 方針で残す | Ruling: cursorは「発行時と同一filter」を要求する設計で、部分filter発行は契約上の入力揺れ。正規化は次にroutesへ触る際の統合掃除で。コスト: 部分filterで始めた利用者だけ1回409で再snapshot |
| A低2 | 409 details語彙（cursor_invalid/cursor_expired/authz_changed/filter_changed/request_hash_mismatch等）がdocs/05未収録 | 低 | 同梱修正（docs） | docs/05 §1/§2へ実装一致で追記（client_operation_id_mismatchは400のため§2記載） |
| A低3 | draft scopeのunitIdにunitName（分団異動で既存draftが一覧から消え7日で失効。purgeはuserId単位で残留しない＝孤児） | 低 | 方針で残す | Ruling: T075レビュー既知。孤児draftは他ユーザーに見えず自動失効＝漏えい方向でない。Me DTOへの分団識別子追加は別契約変更としてT083以前に判断。コスト: 分団異動時に下書きが消えたように見える |
| B低1 | T074「完了」vs T073「局所完了」の判定基準揺れ（T074のinstall可能性もT083先送り） | 低 | 同梱修正（docs） | docs/16 T074状態欄・ph6.mdに判定注記（T073は測定そのものが完了条件内、T074はshell/キャッシュ機能の完了） |
| B低2/D低5 | ph6.mdが参照するph6-review.mdが未存在 | 低 | 本サイクルの産出 | 本文書の作成をもって解消 |
| B低3 | T073 e2eがresync札の表示を直接断言しない（間接検証のみ） | 低 | 同梱修正（client） | realtime.specへresync札の直接断言を追加（語彙はIncidentPage実装と一致。両プロジェクト緑） |
| C低1 | UpdateNoticeの札がトースト位置表と衝突（z-[60] vs トーストz-[120]。「更新」ボタンが塞がれる） | 低 | 同梱修正（client） | 位置をbottom-[224px]（PC 84px）へ移動し構造的に非重なり（トースト帯最高≈208px<224）＋44px保持＋§1.1-21に位置根拠を記録 |
| C低2 | SCR-27のstore失敗経路が黙って消える（resendAsNew/discard/retryRejectedにcatch無し。removeDraftの誠実表示型と不整合） | 低 | 同梱修正（client） | removeDraftと同じstoreError＋role=alert型へ統一。UIエラー経路の自動試験は無し（IndexedDB失敗注入の仕組み未確立＝報告書に正直記録。store層のDraftStoreError写像は既存試験が担保） |
| C低3 | UpdateNoticeの面が`bg-[#101A2B]`リテラル＋§1.1-21の「T047札と同じ配色」が実装と不一致 | 低 | 同梱修正（client+docs） | `bg-surface`トークン化＋§1.1-21の配色表現を実装どおりに訂正 |
| D低1 | docs/16 T073状態欄「T047のConnectionState語彙を再利用」は帰属誤り（実体はT073新設。T047はuseOnline） | 低 | 同梱修正（docs） | 「T047のuseOnlineを再利用し、ConnectionState型はT073で新設（第二の真実源なし）」へ訂正 |
| D低2 | T072/T073のInterfaces逐字不一致（readEventsのexplicit引数・subscribeのctx引数が未注記） | 低 | 同梱修正（docs） | docs/16 T072/T073状態欄に「実装上必要ならInterfacesも更新する」規則による補足を追記 |
| D低3 | transport.ts:9コメント「p95≈2.4秒」vs 記録値2.29〜2.33秒 | 低 | 同梱修正（server） | ≈2.3秒に統一 |
| D低4 | API-81/82のPER-13非明示（A中1と同根。docs/05権限列→実装の対応がAPI-80と不統一） | 低 | A中1と一体で解消 | （A中1の修正に含む。docs/05行にも併用検査の補足） |
| 要確認1 | 同一unit+同一認可版の他ユーザーがcursor再利用可能（データは受信者ACLで再filter＝位置メタのみ） | 要確認 | 方針で残す | Ruling: T072タスクレビュー既知。docs/05 §8のopaque要件（件数・非可視行を示さない）は満たす。userId結合は次回cursor変更時に判断。コスト: 同unit内でのsequence位置の譲渡 |
| 要確認2 | resync中の札の点色（緑＝通信）と文面「同期をやり直しています」（同期状態）の役割分担 | 要確認 | 方針で残す | Ruling: 点=通信（useOnline）・文=同期状態の分担はT073設計どおり。attention色への変更はT083の実機確認と一緒に判断。コスト: 点色だけ見る利用者に通信と同期の区別が伝わらない可能性 |

### 誤り・対象外
なし（B報告は実数を自ら計測し「tests 57ファイル/263宣言・e2e 45本×2＋setup1＝91・live 9ファイル」を確認、モックでの完了偽装・チェックのみの省略なしと判定。D報告はdocs/05 §8×実装を文単位で一致・契約3点セット・docs/11×states.ts×0031のCHECK・docs/14 D14/D16追記の前例形式を確認。C報告はSCR-27共通部品構成・44px・状態語彙一致・offline偽装なし・シェル寸法不変を確認）。

### 修正の実施
2体の実装サブエージェントに分割（①サーバー: A中1/A中2/D低3＋A低2のdocs/05追記 → commit **ee08bd8** `fix: address PH6 review round 1 (server)`。②クライアント+docs: A高1/B中1/D中1/D中2/B低1/B低3/C低1/C低2/C低3/D低1/D低2 → commit **396b2d4** `fix: address PH6 review round 1 (client/docs)`）。挙動を変える修正はすべて**先に失敗する試験を追加して旧コードでFAILを確認**（サーバー新規2件〔API-82のPER-13・出欠イベントACL〕・クライアント新規1件〔代理参集のcapture拒否〕＋e2e強化1本〔resync札の直接断言〕）。

### 変異による確認
出欠イベントの行判定を集合判定へ戻す→新試験落ち **DETECTED**／PER-13検査の除去→API-82赤試験落ち **DETECTED**（サーバー2件）／代理参集の拒否を外す→capture赤試験落ち **DETECTED**（クライアント1件）。全て復元を目視確認。

### 再実行（修正commit前）
`npm run typecheck` 成功／`npm run check:contracts` 102 API一致／`npx vitest --run` **57ファイル266件成功**／`npm run build` 成功／`npm run test:e2e` **88件成功＋3件スキップ**（phone-360/desktop-1280。realtime.specの1回目はunrouteと遅延handlerの競合で落ちたため待ち合わせを修正済み）。

## 第2回（第1回修正 ee08bd8+396b2d4 の再レビュー）

### 依頼
新しいサブエージェント2体を並行で起動：①サーバー側（修正差分 49da3eb..396b2d4のsrc/server+tests+docs/05）②クライアント・docs側（同diffのsrc/client+tests+docs/03/04/14/16+docs/evidence/ph6.md）。読み取り専用。試験は実行しない（合否は全検証記録に依拠し、判定はコード読解）。

### 解消判定
| 対象 | 判定 |
|---|---|
| サーバー系4件（A中1・A中2・D低3・A低2） | **すべてADDRESSED**。A中1はAPI-80と同一形状でsync routes入口に検査、赤試験は役割剥き主体でAPI-82照会・API-81台帳再送の厳密403＋新規POSTは「403・効果0・台帳0」の回帰併記。A中2の行判定はactivities.ts:301-306と同一判定（unit絞り三重）で、集合へ戻す変異が有効。docs/05語彙は実装と完全一致 |
| クライアント・docs系8件（A高1・B中1・D中1・D中2・B低1・B低3・C低1〜3・D低1/D低2） | **すべてADDRESSED（8/8）**。A高1はplanForの呼び出し経路が一望可能（useMutation→captureOfflineDraft→planForの1経路。API-23のuseMutationは本人2件・代理1件のみで別形状なし）で赤試験が契約形そのもの。C低1はトースト帯との構造的非重なり（モバイル224px>約208px・PC 84px>約74px）＋44px保持。D中1はdocs/04:167が0031のDDLと正確に一致 |
| diff内新規欠陥 | Critical/Important 0件。軽微1件（realtime.spec.ts:94/96の同一expect重複。動作への影響なし） |
| サーバー修正とクライアントの整合 | 問題なし（PER-13追加は全役割が保持するため既存クライアント呼び出しに影響なし。出欠イベントのACL収窄はイベント配信のみで読取API不変） |

### 判定
**2回のレビュー・修正サイクルを完了。確認済みの高・中の未解消は0件。**

## 方針で残す（Rulingつきの全リスト）

1. **A低1 entityIdのみfilterのcursorが409**（低）— Ruling: cursorは発行時と同一filterを要求する設計。部分filter発行の正規化は次にroutesへ触る際の統合掃除で。コスト: 部分filterで始めた利用者だけ1回409で再snapshot
2. **A低3 draft scopeのunitId=unitName**（低）— Ruling: 分団識別子がMe DTOに無い既知制約。孤児draftは他ユーザーに見えず7日で自動失効＝漏えい方向でない。DTO拡張はT083以前に判断。コスト: 分団異動時に下書きが消えたように見える
3. **要確認1 cursorの同unit内再利用**（要確認）— Ruling: 受信者のACLで再filterされるため漏えいは位置メタのみ。docs/05 §8のopaque要件は満たす。userId結合は次回cursor変更時に判断。コスト: 同unit内でのsequence位置の譲渡
4. **要確認2 resync中の札の点色**（要確認）— Ruling: 点=通信・文=同期状態の役割分担はT073設計どおり。色の見直しはT083実機確認と一緒に。コスト: 点色だけ見る利用者に区別が伝わらない可能性
5. **再レビュー軽微 realtime.specの重複expect**（低）— Ruling: 動作影響なし。次にrealtime.specへ触る際に清掃
6. **再レビュー観察 eventVisibleの出欠branchが行ごとにポイントルック**（低）— Ruling: SCAN_MAX_ROWS=1000で有界。outboxへのmember_id/activity_id非正規化はT082の実測と一緒に判断。コスト: 出欠イベント大量のunitでpoll時の読み取り増
7. **C低2のUIエラー経路に自動試験なし**（低）— Ruling: IndexedDB失敗注入の仕組みが未確立。store層のDraftStoreError写像は既存試験が担保。注入機構は将来課題として記録済み。コスト: 画面層のエラー表示崩れを試験が検知しない
8. **D低5/B低2 ph6-review.md先行参照**（低）— 本文書の作成で解消

## 最終状態

- 確認済みの高・中の未解消: **0件**
- 指摘総数: 高1 / 中3 / 低11 / 要確認3＝修正した確認済みは**高1件＋中3件＋低8件**（残り低3件＋要確認2件＋軽微2件は方針で残す）
- 変異確認: **3件DETECTED**（サーバー2・クライアント1。全て復元目視確認）
- 最終全検証（396b2d4時点）: `npm run typecheck` 成功／`npm run check:contracts` 102 API一致／`npx vitest --run` 57ファイル**266件**／`npm run build` 成功／`npm run test:e2e` **88件成功＋3件スキップ**（phone-360/desktop-1280。documents.spec desktopの既知flap型は今回のフル実行では発生せず）／`npm run test:live` は実環境未設定のため9件fail継続（docs/evidence/ph6.mdに記録）
- 局所完了の残手順（T073の実30端末測定＝V06-realtime・T077のT033接続）は docs/evidence/ph6.md に記録済み。レビューサイクルでは「実外部をモックで完了扱いにしない」観点でこれらの正直さを確認済み（B報告）
