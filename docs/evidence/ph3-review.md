# PH3 レビュー・修正サイクル（2026-10-15）

ph0/ph1/ph2と同じ手順。範囲はPH2最終commit **2a6a488**〜HEAD（レビュー開始時 cbb8f66。T035〜T047の実装13コミット＋docs統合コミット）と関連docs。レビュー担当は**読み取りのみ**（ファイルの変更・git書き込み操作・試験の実行は禁止）。指摘は**メインのエージェントが一件ずつコード・試験で確かめ**、分類してから直す。

## 第1回

### 依頼
独立したサブエージェント4体を並行で起動：**A=正確さ・セキュリティ**（代理回答の許可理由・締切・versionガード、実参加と出欠の分離、出動の本人/代理記録と時刻順序、resource_usagesの全集合PUT、executeMutation宣言漏れ、PII）／**B=docs/16完了条件と試験の妥当性**（UIから操作できない完了操作を作らない。ph2では異常の状態操作UI欠落が高指摘になった）／**C=prototype準拠**（予定・活動・出動・お知らせ・ホームのHTMLと寸法・文言、360/1280px、押下領域44px）／**D=docsと実装の整合**。各体に、リポジトリ・範囲・読むdocs・観点ごとの差分パッケージ（src/server+tests／docs/16+tests／src/client／docs）・報告形式（ファイル:行、問題、発生条件、重大度、根拠。推測は「要確認」）を渡した。

### 指摘と分類（件数は報告の項目数。同じ原因は束ねた）
| 観点 | 指摘 | 重大度 | 分類 | 対応 |
|---|---|---|---|---|
| A1 | 同キー再送が保存済み応答を返さない経路がT035/T037/T040/T045側に9箇所残る（API-09作成の再送→409 DUPLICATE、API-22 activityId付き作成の再送→409、API-39 no_changes 400、API-40中止の再送→422、API-69 voided/no_changes、API-72公開/アーカイブの再送、API-66アーカイブ後既読→404。docs/05 §2「同キー再送は元HTTP status/dataを返す」違反。T041〜T043は鍵先読みで対処済み） | 中 | 確認済み（activities.ts:157のthrowがexecuteMutation呼び出し:184より先行することをコードで確認） | T041流儀の鍵先読み（既存キーなら状態前提検査をスキップし保存応答を返す）を9箇所へ適用。再送試験を7経路で追加（旧コードでFAIL確認） |
| A2/D1/D6 | docs/05 API-26行は対象に`activity`を含めるが、upload-intentの対象表に無く422になる（契約は通るがrouteで落ちる乖離。upload.tsのコメント「activity等はPH3以降に追加」も陳腐化。§3 AttachmentTargetとの対比も読みにくい） | 中（D）/低〜中（A） | 確認済み（ATTACHMENT_TARGET_TABLESにactivity無しを確認） | 対象表に`activity: "activities"`を追加、コメント実態化。activity宛intent→転送→完了の試験を追加（旧コードでFAIL確認）。§3はAttachmentTarget行が全型列挙のためAPI-26行と一致し追加修正不要と判断 |
| D2 | API-41（代理出欠）のreason契約がDB CHECK(2,000)より広いReason(20,000)→2,001字で500リスク（docs/05 §1「DBに揃えて引き締める」方針違反） | 中 | 確認済み（契約:395とdrizzle/0015:124を突き合わせ） | API-41のreasonをReason2000へ。docs/05 §1の列挙に「代理回答・参集の理由2,000」を追記。2,001字→400の試験追加（旧コードでFAIL確認） |
| D3 | API-23（参集記録）のreasonも同様 | 中 | 確認済み（同型を確認） | API-23もReason2000へ（試験・docs追記は上とセット） |
| A（要確認2） | お知らせの応答が対象者（一般）にもaudienceMemberIds＝他対象者のID一覧を無条件で返す（announcements.tsの応答SQL。画面で対象者ビューに使う箇所は無い。unit内名簿IDの不要開示） | 中 | 確認済み（応答SQL:27が無条件でaudienceを組み立てることを確認） | 管理権限（PER-03相当）のときだけ含める投影制限＋DTOをoptional化（openapi再生成。編集・公開先確認は管理権限専用画面のためクライアント影響は最小）。対象者応答に含まれない試験を追加（旧コードでFAIL確認） |
| C1 | インライン編集フォーム（実績ActualResultForm・使用ResourceUsageEditor・参集/帰還IncidentPage RecordForm・ProxyRecord・ActivityPage内フォーム）に未保存警告が無い（docs/03:78「未保存の離脱は確認ダイアログ」は全画面共通規則。LeaveConfirmはルート型エディタのみ） | 中 | 確認済み（LeaveConfirm使用箇所をrg -l で確認） | 既存流儀どおり`<LeaveConfirm dirty=…>`を各フォームと親ページに適用（自分の出欠は即時保存のため対象外）。途中入力→離脱→ダイアログのe2eを追加（旧コードで両プロジェクトFAIL確認） |
| A3/D4 | drizzle/0017/0018のevents表`reason`がNULL可（作成初行でNULLが必ず入る）なのにdocs/04が`reason:T`（NOT NULL表記） | 低 | 確認済み | docs/04側を`reason:T?`に訂正（docs/04冒頭の突き合わせ済み記述に対する唯一の例外を解消） |
| A6 | docs/05 API-28行のmyResponse記述「未回答はnull」と実装が乖離（取り下げ済みは契約・実装どおり`"unanswered"`。docs/14 D23⑥の方式） | 低 | 確認済み（dashboard.tsのmyResponse算出を確認） | docs/05側を「取り下げ済みは"unanswered"を返す（docs/14 D23）。行なし未回答・対象外はnull」に訂正 |
| A（要確認1） | API-07の可視出欠を管理権限=全行・本人=自分の行に限定する根拠がdocsに無い | 低 | 確認済み（実装は最小権限として妥当。docsの記述が薄いだけ） | docs/05 API-07行に「管理権限（PER-03相当）は対象者全行、本人は自分の回答行（T035実装）」を明記 |
| D5 | docs/05 API-51行「T030/T032/T048で接続」のT032はPH2で完了済みで、異常子Pageの接続主が浮く（docs/16 T042行も踏襲） | 低 | 確認済み | docs/05・docs/16を「点検履歴=T030の残、異常=接続タスク未割当（APIはT032完了・子Page未接続）、点検期限=T048」に訂正 |
| B3 | docs/16 T047状態欄の「400 unsupported_period」はコード名（VALIDATION_ERROR）とreasonの混在表記 | 低 | 確認済み | 「400 VALIDATION_ERROR（details.reason=unsupported_period）」に表記統一 |
| B1 | T046のworkers試験名がlinked_attachmentsを謳うが検査は空配列の形のみ | 低 | 確認済み | ready添付を実際にリンクして応答attachmentsに載ることを検査する形に強化（旧コードでFAIL確認） |
| B2 | announcements e2e手順8のコメント「画面には変更操作が出ない」を検査していない | 低 | 確認済み | 「対象者ページに公開/編集/終了が出ない」assertionを追加 |
| C2 | 出動詳細とResourceUsageEditorのトースト下位置が110px（正はtab:menu相当の100px。同一画面内で100/110混在） | 低 | 確認済み（prototype support.js:904対応表） | 4箇所を100pxに |
| C3 | 活動詳細の題が26px（prototype Activity指定は28px） | 低 | 確認済み | 28pxに |
| C4 | ホーム挨拶が氏名の最後のトークン（名）を使う（prototypeは姓＝先頭トークン「佐藤さん」） | 低 | 確認済み | 先頭トークンに修正 |
| C5 | 出動詳細の状態操作・種別訂正が権限に関係なく全員に表示（ActivityPage/AnnouncementsPageのcanManage流儀と不一致。サーバー403で守られるが画面間で不整合） | 低 | 確認済み | IncidentPageの該当操作をcanManageで出し分け |
| C6 | 理由必須の確認ダイアログで、空理由をそのまま送って422汎用エラーになる箇所（活動の中止・出動の状態変更）と事前ガードする箇所が混在 | 低 | 確認済み | confirmDisabled（空理由は実行不可）に統一 |
| C7 | docs/03 §1.1-9⑦「使用資産・報告書の導線も後続タスク（T044/T059）」が陳腐化（使用資産はT044で実装済み） | 低 | 確認済み | 「使用資産はT044で実装済み（詳細から編集・資産履歴から辿れる）。報告書のみT059」に訂正 |
| C9 | SCR-10の別入口`/app/activities/:id/edit`がdocs/03 §1.1-9に記録されていない（お知らせの別入口は§1.1-11⑦で記録済み） | 低 | 確認済み | ⑧として追記 |
| D7 | screens.tsのSCR-08 summaryがdocs/03 §2更新後の語（実参加/未回答検索）に追いついていない | 低 | 確認済み | 実装どおりの語に更新 |
| A4 | API-22でactivityId＋resourceUsages同時指定時、operation版の増分UPDATEが同一batchに2本積まれ2本目が黙って0行（現状の結果は正しい＝単一増分。0行UPDATEを成功扱いにしないという原則の盲点。文順序変更時に二重増分/誤409の温床） | 低 | **方針で残す** | 現状動作は正でtestsが通る。root宣言・文順序を触る拡張（PH4以降の統合改修）時にbuildResourceUsageMutation側の二重化を解消する。本レビューの修正対象外（記録のみ） |
| A5 | 出欠の「対象外」が行の有無で404（未回答）/403（過去に回答行あり）に揺れる（docs/05 §1の403/404使い分けで説明は付くが同一状態で応答が揺れる） | 低 | **方針で残す** | 防御の穴ではない。応答一貫性の改善は画面改善（T083系）で扱う |
| C8 | 活動・出動・お知らせ一覧の等幅小見出しがprototypeの「年 · 月」形式から外れる（PH2のMAP/IMPORTからの既存流儀） | 低 | **方針で残す** | 既存流儀の踏襲。統一は画面改善タスクで |

### 誤り・対象外
なし（B報告は高severityゼロ・「UIから操作できない完了操作」の観点で問題なしと判定。D報告もdocs整合は高水準と評価）。

### 修正の実施
修正は2体の実装サブエージェントに分割（①サーバー+workers試験: A1/A2/D2/D3/お知らせ投影/B1＋docs/05 §1追記、②クライアント+e2e: C1〜C6/B2/D7）。docs（docs/03/04/05/16の低severity表記）はメインが修正。挙動を変える修正はすべて**先に失敗する試験を追加して旧コードでFAILを確認**（①: 再送9箇所で9失敗、activity intent 422、2,001字reason、対象者応答へのaudienceMemberIds混入。②: 離脱ダイアログが出ず両プロジェクトFAIL）。

### 変異による確認
①（scripts/mutate.sh流儀）: 鍵先読み除去→再送試験落ち **DETECTED**／Reason2000→Reason→2001字試験落ち **DETECTED**／投影制限除去→対象者応答試験落ち **DETECTED**／linkId投影変異→T046強化試験落ち **DETECTED**（全て復元目視確認）。②（scripts/mutate-e2e.sh）: ActualResultFormのLeaveConfirm削除→離脱試験が両プロジェクトで落ちる **DETECTED**（等価でない。自動復元済み）。

### 再実行（修正commit前）
`npm run typecheck` 成功／`npm run check:contracts` 101 API一致／`npx vitest --run` 32ファイル**186件成功**（レビュー修正で+8件）／`npm run build` 成功／`npm run test:e2e` **52件成功＋1件スキップ**（phone-360/desktop-1280。activities/incidents/announcements specは修正＋新試験込みでPASS）。

### 判定
第1回で見つかった確認済みの高・中（6件）はすべて修正済み。残すは「方針で残す」（低3件。上表）のみ。**修正差分（cbb8f66..05c0cb6）の再レビューを新しいサブエージェントで実施**（次節）。

## 第2回（第1回の修正 05c0cb6 の再レビュー）

### 依頼
新しいサブエージェント2体を並行で起動：①サーバー側（修正差分 cbb8f66..05c0cb6 の src/server・契約・workers試験・docs/05 §1）の解消判定と新規欠陥検出、②クライアント・docs側（src/client・e2e・docs/03/04/16＋docs/05の表記訂正）の解消判定と新規欠陥検出。読み取り専用。試験は実行しない（合否は第1回の全検証記録に依拠し、判定はコード読解）。

### 解消判定
| 指摘 | 判定 | 根拠（要旨） |
|---|---|---|
| A1 再送9箇所 | **ADDRESSED** | 9箇所すべて鍵先読み導入。同キー別本文は409のまま（hash不一致→IDEMPOTENCY_MISMATCH。試験3経路）。応答は初回の保存JSONをそのまま返し現在データを再構成しない。認可は毎再送検査（principalIsCurrent） |
| A2 activity対象 | **ADDRESSED** | upload.ts:32。存在条件は他種別と同一形 |
| D2/D3 reason上限 | **ADDRESSED** | 契約・openapi・docs/05 §1・試験が整合。API-08等への波及なし（openapi機械走査で確認） |
| お知らせ投影制限 | **ADDRESSED** | 条件付き投影（管理権限のみ）。クライアントの全参照が任意前提。可視WHEREのbind順まで照合 |
| B1 試験強化 | **ADDRESSED** | ready添付の実リンク＋linkId込み投影を実値検査 |
| C2/C3/C4/C6/B2/D7 | **ADDRESSED** | 各該当行を実装・prototype・docsと突き合わせ |
| docs修正分（7件） | **ADDRESSED** | docs/04/05/03/16の訂正がすべて実装と一致 |
| C1 未保存警告 | **PARTIAL** | 実績・使用（編集）・参集・代理参集・代理回答の5フォームは適用済み（値ベースのdirty判定で正確）。**出動登録フォームの下書き使用行だけページのdirtyに乗らない**（下記N1） |

### 新規指摘（すべて低）
| 指摘 | 重大度 | 分類 | 対応 |
|---|---|---|---|
| N1: 出動登録フォームの下書き使用行がページのdirtyに乗らない（使用行だけ入力して離れると警告なしで消失） | 低（C1の残置としてPARTIAL判定） | 確認済み | **第2回で修正**（下記） |
| サーバー新規1: API-22×resourceUsages同時再送で、buildResourceUsageMutation内部の鍵先読みがoperation_code不一致のため資産廃止検査が残り、狭い条件で再送が404になる（データ破壊なし・置換文は適用されない） | 低 | 方針で残す | A4（operation版増分の二重積み）と同根の「API-22と使用履歴の組み立て統合」課題。PH4以降の統合改修時に解消（docs/evidenceと本節に記録） |
| N2: 同一ページの複数LeaveConfirmが同時dirtyになりうる（react-router複数blockerの挙動は実装依存。実機確認が要る） | 低・要確認 | 方針で残す | 実機動作確認はT083（アクセシビリティ・UI改善）で扱う |
| N3: 代理回答フォームが保存後も前回の回答値を保持し、再オープン→離脱で誤警告が出る（ProxyRecordだけcloseで全初期化済みで非対称） | 低 | 確認済み | **第2回で修正**（下記） |
| N4: 出動詳細のcanManage（役割）出し分けとサーバーのPER-04担当scope（一般団員）の微細な乖離 | 低 | 方針で残す | ActivityPage/AnnouncementsPageと同じ「役割で出し分け」流儀への統一がC5の目的。担当scope保持者の一般団員は稀。docs/03 §1.1-10に流儀として記録済み |
| 参考（範囲外・記録のみ）: 活動詳細API-07が対象者ID一覧をPER-01全員に返す（お知らせと同じ形のID開示だが名簿基本項目が全員可視の前提下で影響小）／scope担当のPER-03保持者が対象外の公開済をお知らせ一覧で見られない（T045仕様・コード内コメントに意図記載） | 低 | 方針で残す | 既存のD23設計の範囲。必要になった時に契約変更で整理 |

### 第2回の修正（N1・N3）
小修正サブエージェント1体で実施: ①`IncidentEditorPage.tsx` のResourceUsageEditor(draft)のonChangeでsetTouched（使用行の追加・編集・削除が全てdirtyに載る）②`ActivityPage.tsx` のProxyAnswer保存時closeでresponseを初期値に戻す（「閉じる」ボタンは入力保持が正のため触らない）。いずれも**先に失敗するe2eを追加して旧コードでFAILを確認**（使用行のみ入力→離脱でダイアログ未出現／代理回答保存後の再オープン離脱で誤ダイアログ。両方両プロジェクトFAIL→PASS）。なお代理scopeのseedはD05の付与APIが未実装のため `wrangler d1 execute` による直接INSERT（サーバー未触碰。D05承認フロー実装時にAPI経由へ置換＝docs/evidenceに記録）。

### 再実行（第2回修正commit前）
`npm run typecheck` 成功／`npm run check:contracts` 101 API一致／`npx vitest --run` 32ファイル186件成功／`npm run build` 成功／`npm run test:e2e` **56件成功＋1件スキップ**（phone-360/desktop-1280。第1回より+4件＝第2回の新規e2e 2件×2プロジェクト）。

### 判定
**確認済みの高・中の未解消は0件**（C1の残置N1も第2回で解消）。残るは「方針で残す」（低5件＋参考2件）のみ。第2回修正差分（05c0cb6..b3d3cef）の再レビューを1体で実施（第3回・上限3回の範囲内）。

## 第3回（第2回の修正 b3d3cef の再レビュー）

### 依頼
新しいサブエージェント1体（読み取り専用）で修正差分（05c0cb6..b3d3cef。約200行。N1・N3の実装＋新規e2e 2件＋本書の第1回・第2回節）を再レビュー。

### 解消判定
| 対象 | 判定 | 根拠（要旨） |
|---|---|---|
| N1 使用行のdirty取り込み | **ADDRESSED** | IncidentEditorPage:208-215。draftのonChangeでsetTouched→行の追加・編集・削除の全てがdirtyに載る。draft固有のLeaveConfirmは無く二重ダイアログなし。新規e2eは旧コードでFAILする構造（種別・発生日時・概要を不触のためtouchedがfalseのまま）でセレクタも実在と一致 |
| N3 代理回答の保存後の誤警告 | **ADDRESSED** | ActivityPage:662のsetResponse("参加")。dirtyは値ベース（:704）で正しい変数を修正。「閉じる」ボタンの入力保持は壊れていない（:699-701は未触碰）。新規e2eは旧コードでblockerがURL遷移を止めFAILする構造 |
| docs/evidence/ph3-review.md記載 | **ADDRESSED** | 第1回・第2回の主要主張をスポット照合し全てコードと一致（C1の5フォーム・C2〜C6・B2・C7/C9・D7の該当行を確認） |

### 新規指摘（すべて低・修正対象外）
| 指摘 | 重大度 | 分類 |
|---|---|---|
| activities.spec.ts:214の`activityUrl`が未使用（死に変数。noUnusedLocals無しでtypecheck通過） | 低 | 方針で残す（テストの死に変数。次回のテスト整理時に除去） |
| activities.spec.ts:201-202の保存直後「不参加が見える」断言がフォーム内`<option>`に先取りされうる（実判定は手順3のURL断言が担うため判定力は損なわれない。チップ限定ロケータが望ましい） | 低・要確認 | 方針で残す（実害なし。テスト整理時にロケータを絞る） |
| 代理scopeのseedに`wrangler d1 execute`（稼働中のwrangler devと同じローカルD1への並行アクセス）を使用。まれなフレーク候補 | 低 | 方針で残す（D05の付与API実装時にAPI経由へ置換＝第2回節に記録済み） |
| 観察: 使用行のみ触れた直後も「発生日時/概要を入力してください」の必須エラーが出る（ページの既存流儀と一貫。問題なし） | — | 対象外 |

### 判定
**3回のレビュー・修正サイクルを完了（上限どおり）。確認済みの高・中の未解消は0件。** 残すは「方針で残す」（第1回3件＋第2回5件＋第3回3件。いずれも低か要確認で、後続タスク（PH4統合改修・D05承認フロー・T083画面改善・テスト整理）で扱う）のみ。第3回時点の全検証（第2回修正コミット前に実施）: typecheck成功／契約検査101一致／vitest 32ファイル186件／build成功／e2e 56件成功＋1スキップ（360/1280px）。
