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

（再レビュー後に記載）
