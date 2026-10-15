# 05 API仕様書

版：v0.3 / 2026-10-14 / 設計契約ドラフト。API-01〜32を保全、欠落操作/統合機能を追加。全101件の契約(Zod/OpenAPI)はPH0で実装済み。業務処理はPH1（認証・名簿・権限・監査: API-01/02〜04/33〜38）とPH2（添付・施設GIS・CSV・資産・点検様式・点検・異常: API-10〜14/15〜20/26/27/44〜51/53〜55/83〜86/94〜98/101）まで実装。残り（活動・出動・お知らせ・AI・帳票等）はPH3以降。権限は10、状態は11、データは04、未承認条件は14。

## 1. 共通入出力・検証

業務ベース`/api/v1`、同一originのHTTPS/JSON。API-36のみ認証base path。クライアントのunit/actor/roleを信用しない。成功`{data:DTO,meta:{requestId,nextCursor?,snapshotRevision?}}`、失敗`{error:{code,message,details:[{field,reason}]},meta:{requestId}}`。binary/CSV/stream/204はJSON envelope外。Inspection DTOは原本＋seriesId/seriesVersion＋明細/添付ID、Template DTOは項目schemaと承認版。その他DTOは04の同名モデルのcamelCase＋version＋10の許可列、Secret/内部token/R2キーを返さない。ResourceUsageListのPUTはoperation版をガードし全有効集合を更新、抜けた既存行はcancelled＋イベントで保持。全件編集権がなければ拒否する。Detailは親＋認可された子PageとnextCursorを返し、子一覧の件数を黙って切り捨てない。

IDは存在/所属/許可を全関連先まで検査。ISO8601 UTC瞬間とYYYY-MM-DD業務日を区別。未知JSON列・列挙外を拒否。文字上限案：件名200、note/body20,000、AI/RAG質問4,000文字、JSON要求256 KiB（binary別）、limit既定50/最大200、配列最大100。大きいCSV/多数対象はimport/job分割、D1 bound parameter上限100を越えない。値は負荷検証で固定するB案で機能上限の無断削減を意味しない。**列ごとにDBのCHECKより広い共通上限を使う場合、その列の入力だけDBに揃えて引き締める（PH2〜: 管理番号・識別名・出典・資産コード・状態100、数量単位50、位置確認/訂正/対応の理由2,000、点検明細の項目コード100、開催の変更・中止の理由2,000（activity_events.reason。T035）、出動の訂正・無効化の理由2,000（incident_events.reason。T040）、使用履歴の訂正・取消の理由2,000（resource_usage_events.reason。T042）。docs/04の各DDLと一致）。超過は400で拒否し、通ってからDBのCHECKで500にならないようにする。**

| HTTP / code | 意味 |
|---|---|
| 200/201/202/204 | 取得/更新、作成、永続job受付、本文なし。202は業務完了と表示しない |
| 400 VALIDATION_ERROR | 型/範囲/未知列/形式違反 |
| 401 UNAUTHENTICATED | セッションなし/失効 |
| 403 FORBIDDEN、404 NOT_FOUND | 既知対象の操作不可/存在を明かさない対象不可 |
| 409 VERSION_CONFLICT / IDEMPOTENCY_MISMATCH / DUPLICATE / SNAPSHOT_CHANGED / RESYNC_REQUIRED | 旧版、同キー別本文または保持期限切れのキー（details.reason=key_expired）、競合リンク/番号、続き取得中のsnapshot更新(§5)、再開cursor失効(§8) |
| 422 INVALID_TRANSITION / UNAPPROVED_POLICY / ATTACHMENT_NOT_READY | 業務前提/採用未決/未検査添付 |
| 429 RATE_LIMITED | 認証/AI/検索/アップロード上限、Retry-After |
| 500 INTERNAL_ERROR、503 DEPENDENCY_UNAVAILABLE | rollback済か結果不明かをoperation照会で確認。内部本文を漏らさない |

**契約の実装（T002、`src/shared/contracts`）：** リクエストは`{params,query,body,headers}`の形で検証し、契約に無い項目は未知列として400。JSON 256 KiB超（content-lengthが無くても読みながら打ち切る）・壊れたJSON・本文があるのに`Content-Type: application/json`でない要求、契約に無いqueryや本文も400 `VALIDATION_ERROR`（理由は`details`）。UTC瞬間は小数秒の桁数を問わず受け付け、ミリ秒3桁のZ形式へ正規化してから比較・保存する。IDは小文字のUUIDのみ。API-IDは`API-01`〜`API-101`で、docsの表と台帳を`npm run check:contracts`が照合する。**応答DTOのうち04/10で列が確定していないものは`provisional`（id/versionのみ必須、他は通す）として登録**し、該当機能のタスクで厳密化する（OpenAPIにも`x-provisional-response`で出る）。固定パス（`/facilities/export`・`/facilities/imports`・`/notifications/me`・`/activities/:id/attendance/me`）は同階層の`:id`/`:memberId`より先に照合する（Honoは登録順）。出欠APIの`response`は`unanswered`も受け付ける（11「間の変更」）。

## 2. 冪等性・同時更新（全業務変更へ適用）

API-36はライブラリ契約を別検証。API-83はバイナリで別規則。API-76（検索のPOST）は永続変更を伴わないため不要。その他POST/PUT/PATCH/DELETEのJSON変更には`Idempotency-Key`必須（API-77はAI提案を保存するため必須）、GETには不要。キーはuser＋operation code＋keyで一意、正規化した本文（method/path、対象、baseVersion含む）のSHA256を保存。形式を変えても意味が同じJSONは同hash、別本文は409。保存7日案、通知/AI承認/同期effectは別UNIQUEを恒久保持し期限後も二重効果を防ぐ。下書きの自動再送は7日を上限とし、超過時は結果確認＋人が新操作を作る（D14）。

同じキー/本文の再送は元HTTP status/dataを返し、現在の認可は再検査する（失権後に旧レスポンスのPIIを返さない）。応答不明時は同キー照会/再送。既存rowはversion必須、未作成PUTは0を指定してINSERT UNIQUEをガード。version欠落400、旧版409。競合では履歴/監査成功行/通知を残さない。02のassertion方式で確認し、処理不成立ログは業務成功監査と分離する。

binary upload API-83はintent/attempt ID＋content hashで再送を判定し、試行ごとに不変一時キーを使用。既にreadyになった実体は上書きしない。notification delivery keyとAI job dedupe、端末clientOperationIdはAPI冪等キーと役割が異なる。

## 3. リソース入力DTO

`version`は変更時必須、作成入力には含めない。?は省略可、null可は04の?列のみ。PATCHの省略は不変更、nullは許可列のみ消去。入力者/登録者/確認者/監査時刻はサーバー決定。新規entityに添付を同時確定する要求はattachmentDraftIdを省略可で持ち、予約/所有者/親/意図種別をガードして一回consumeする。既存の親への添付は予約不要。

| DTO | 必須入力・構造 | 検証/返却の補足 |
|---|---|---|
| ActivityInput | title,kind,plannedStartsAt,locationText,ownerMemberId,audienceMemberIds;plannedEndsAt?,responseDueAt? | 対象snapshot、日時順序/担当権限。ActivityはoperationId/status/versionも返す |
| ActualInput | content,actualStartsAt?,actualEndsAt?,participants[{memberId,actualStatus,individualStartsAt?,individualEndsAt?}],attachmentIds | 未知時刻は欠落表示、実参加と予定回答は別。D05の記録義務 |
| Target | type=facility/vehicle/equipment,id | 一つのみ。entityType/entityIdのAPI表現を04の片側FKへ変換 |
| ResourceUsageInput | id?,Target,quantity,from?,to? | id付きは既存行の更新、無しは新規。quantity>0、時間順序は両方既知時のみ検査（400）。対象はvehicle/equipmentのちょうど一つ（T042。ResourceUsageListのPUTはdocs/05 §1のとおり全有効集合の置換） |
| AttachmentTarget | type=facility/activity/vehicle/equipment/inspection/issue/announcement/report_version/document/import_batch/attachment_draft,id | draftはAPI-98で予約、親作成権/分類/同unitと最終link先を検査 |
| FacilityInput | type,latitude,longitude,locationSource,locationNote,managementNumberまたはidentifyingName;metadata?,attachmentIds? | 重複範囲D19、数値有限/範囲、verificationStatusは作成時unverified固定。確認専用API45 |
| InspectionInput | templateVersionId,inspectedAt,inspectorMemberId,result,checkItems[{code,result,value?,note?}],note,createIssue,attachmentIds | 承認様式版・必須明細・対象・実施者指定権、createIssue時同一batchで起点参照。原文をAI入力で置換しない |
| ReviewInput | version,sourceVersion,decision=approve/approve_with_edit/reject,confirmedPayload,reviewNote | D03/D07/D12の承認権、元版/質問版/効果差分、却下も一回の決定 |
| SyncCommand | clientOperationId,deviceId,operationCode,targetId,baseVersion,payload,payloadHash | 許可リストAPIのみ、ユーザーIDはsession、version衝突自動merge禁止 |
| Citation | documentId,documentVersionId,chunkId,pageNo?,section?,quotedSpan | 原文の現在ACLを検査、出典なし/失効文書を正当な根拠にしない |

## 4. API一覧（権限は操作＋対象scope＋項目を併用）

表の入力列は共通規約/DTOと合わせて必須契約。全変更は同一unit/FK/版/冪等/状態検証、共通400/401/403/404/409/422/429/500/503を適用。GETは409/422を通常返さず、snapshot失効や採用未決の該当操作だけに適用する。業務規則未承認は14のDを参照し、未承認データで成功させない。

| API-ID | method / path | 権限 | 入力と固有検証 | 成功data |
|---|---|---|---|---|
| API-01 | GET /me | PER-01 | なし | Me(profile,unitName,roles,authzVersion,policyVersion,mfaEnabled,mfaRequired)。未受領/停止/失効済みは401（details.reason=account_not_linked/account_disabled/session_revoked） |
| API-02 | GET /members | PER-01(一覧)/PER-06(許可列) | q/status/squad/limit/cursor（名前→IDのkeyset。絞り込み・ページングはSQL）;基本項目は全員、roleCodes/invitationはPER-07、privateFieldsは本人または担当(scope)の分だけ（他人分を返したら`member.private.view`を監査） | Page<Member>（privateFieldsは許可された行にだけ現れる） |
| API-03 | POST /members | PER-06 | displayName,status,rank?,squad?,qualifications?,joinedOn?,privateFields?(phone/emergencyContactのみ。未知列400);管理者のみ。登録時の許可列入力は可（読み返しは別権限） | Member（応答・冪等保存にprivateFieldsを含めない） |
| API-04 | PATCH /members/:id | PER-06/07 | version,変更列（基本項目=管理者、privateFields=本人または担当、status=管理者）,reason（status変更時は必須）;旧版409、未知列400、アカウントのある団員の休団・退団は利用停止（団員の状態＋利用者の停止＋認可版の増分＋失効job＋監査を一つのcommit、他の列との同時変更は400、再開は未提供422、最後の管理者は422 last_admin） | Member |
| API-05 | GET /activities | PER-01 | from/to/kind/memberId/status/limit/cursor;実参加検索はactual=true。**unanswered=true（T047）は自分（この要求の主体）が対象snapshotに含まれ、出欠の回答（unanswered以外の行）が無い活動だけ。from/statusと組み合わせてホームの「本人未回答」の一覧に使う（href例 `?status=scheduled&from=<現在>&unanswered=true&memberId=<自分>`）** | Page<Activity> |
| API-06 | POST /activities | PER-03 | ActivityInput＋audienceMemberIds;同unit/日時順序 | Activity |
| API-07 | GET /activities/:id | PER-01 | なし;可視出欠と現在実績を含む。operationVersion（出来事rootの現行版。API-57/71の版ガードに画面が使う）とresourceUsages（使用履歴。API-57はPUTのみで読み取り経路が無いため詳細に載せる。T044） | ActivityDetail |
| API-08 | PUT /activities/:id/attendance/me | PER-02 | version(未作成0),response;締切/対象検査 | Attendance |
| API-09 | POST /activities/:id/actual-results | PER-04 | activityVersion,ActualInput;未作成のみ | ActivityResult |
| API-10 | GET /facilities | PER-01 | FacilityQuery;範囲/型/状態を別検証 | SnapshotPage<Facility> |
| API-11 | POST /facilities | PER-03 | FacilityInput;番号か識別名必須/出典/座標 | Facility |
| API-12 | GET /facilities/:id | PER-01 | なし;概要と履歴取得cursor/添付ID | FacilityDetail |
| API-13 | PATCH /facilities/:id | PER-03 | version,変更列;座標/出典変更は確認失効。**添付の変更はこのAPIでは行わない（attachmentIds/attachmentDraftIdは受理しない。 unlink＋再アップロードで行う）** | Facility |
| API-14 | POST /facilities/:id/inspections | PER-04 | InspectionInput;様式/明細/添付ready/実施者 | Inspection |
| API-15 | GET /issues | PER-01 | targetType/targetId/status/assigneeMemberId/limit/cursor | Page<Issue> |
| API-16 | POST /issues | PER-04 | Target,title,description,originInspectionId?,attachmentIds;起点一致 | Issue |
| API-17 | PATCH /issues/:id | PER-05 | version,status?,assigneeMemberId?,reason;遷移検査 | Issue＋events |
| API-18 | GET /vehicles | PER-01 | q/status/limit/cursor | Page<Vehicle> |
| API-19 | GET /equipment | PER-01 | q/status/storage/limit/cursor | Page<Equipment> |
| API-20 | POST /asset-inspections | PER-04 | Target(vehicle/equipment)＋InspectionInput | Inspection |
| API-21 | GET /incidents | PER-01 | kind/from/to/status/limit/cursor;機微scope | Page<Incident> |
| API-22 | POST /incidents | PER-04 | kind,occurredAt,summary,activityId?,resourceUsages?;operation生成/共用;activityIdは同unitの既存活動と未リンクのみ（リンク済み409）。**activityId指定時は活動側operationへ一致させ（docs/04:94「リンク時operation一致」T043）、別operationを作らず生存operationの版を比較更新で増分する**。resourceUsagesは同一batchで作成（T042で共通関数buildResourceUsageMutation経由に接続。対象/数量/時間/資産の検査とresource_usage_events初行も同batch。一mutation一event） | Incident |
| API-23 | PUT /incidents/:id/participants/:memberId | PER-04 | version(未作成0),attendanceStatus,times?,reason?;本人/代理/時刻。times省略は既存維持（未知NULLを保持）、既知時刻の順序は両方既知のみ検査（400）。代理はmember×PER-04のscope（D08。理由は任意）。同一状態への再送は時刻の訂正、変更点なしは400。unconfirmedは行なしで表現 | Participant |
| API-24 | GET /announcements | PER-01 | status/limit/cursor;可視公開対象のみ。**Announcementには作成者createdByMemberId（users→membersを解決。T046）・readAt（この要求の本人による現行版の既読日時。未読null。旧版の既読は含めない＝改版で未読に戻る）・attachments（リンク中の添付id/linkId/linkVersion/status/contentType。API-101の解除と表示に画面が使う）を含む。単一件のGET契約は無く、画面は一覧のページ送りで対象を探す（T046）** | Page<Announcement> |
| API-25 | POST /announcements | PER-03 | title,body,audienceMemberIds,publishAt?;最初draft | Announcement |
| API-26 | POST /attachments/upload-intents | PER-04 | AttachmentTarget,contentType,byteSize,sha256?;対象/上限。**対象は存在確認できる業務表に限る（facility/vehicle/equipment/activity/announcement。T046でannouncementを追加。他は422 unsupported_entity_type）** | UploadIntent(id,uploadPath,uploadToken,expiresAt,version) |
| API-27 | GET /attachments/:id/content | 元対象ACL | なし;ready/最新認可;署名GETへredirectしない | binary(stream,Content-Type,Content-Disposition) |
| API-28 | GET /dashboard | PER-01 | period?;全指標に同scope、元一覧filter返却。**Dashboard（T047で確定）: `{nextActivity, myUnanswered, openIssues, inspectionDue, notifications, myTasks}`。指標は`{count, href, connected}`（hrefは同じ条件・同じscope（この要求の本人の所属unit＝PER-01）で開いた一覧のURLで、countはその一覧の件数と必ず一致させる。connected=falseは後続タスクで接続（点検期限=T048、通知・自分のタスク=PH4）で0件と区別する）。nextActivityは「これからの予定」（status=scheduled、開始>=現在。API-05のfrom包含）の件数＋最接近の1件（id/title/kind/plannedStartsAt/responseDueAt＋回答内訳attending/undecided/absent/unanswered（対象snapshot基準。docs/11出欠行）＋myResponse（本人の回答。未回答・対象外はnull）＋inAudience）。myUnansweredは自分が対象で出欠の回答が無いこれからの予定（API-05 `?unanswered=true&from=<現在>&status=scheduled`と同じ条件。T036の方式）、openIssuesは`issues.status='reported'`（docs/03 SCR-07「未確認（確認待ち）」。API-15と同じunit＋status条件）。periodはDASH-02（PH4）の期間集計用の予約で、T047では値を受けない（指定すると400 VALIDATION_ERROR unsupported_period。黙って無視しない）** | Dashboard |
| API-29 | POST /ai/classifications | PER-09 | sourceType,sourceId,sourceVersion,questionVersion;送信許可 | Job(202) |
| API-30 | GET /ai/reviews | PER-10 | status/sourceType/limit/cursor | Page<AiEvaluation> |
| API-31 | POST /ai/reviews/:id/decision | PER-10 | ReviewInput;元版/提案版/反映先権限 | ReviewDecision＋effectIds |
| API-32 | POST /reports/drafts | PER-09 | activityId,resultVersion,templateVersion;読取/送信可 | Job(202) |
| API-33 | POST /invitations | PER-07 | memberId,email,expiresInHours(1〜720);未リンク・active団員のみ(422)、別unit404、旧い有効な招待は同batchで取消して再発行 | Invitation（生tokenは作成した応答の一回だけ。同じ鍵の再送・保存応答にはtokenを含めず`token:null`） |
| API-34 | POST /invitations/:id/cancel | PER-07 | version,reason;未消費のみ | Invitation |
| API-35 | POST /invitations/accept | token＋認証所有確認 | token,verifiedAuthIdentity(=セッションのidentity。不一致400、セッション無し401、未知token404);招待先メールと一致(403)、使用済み409、取消/期限切れ422(details.reason=cancelled/expired)、同時受領は片方のみ(409) | AccountLinkResult(memberId,linked,roleCodes,authzVersion)。usersの作成・団員リンク・招待消費・役割付与を一つのbatchで確定 |
| API-36 | ALL /api/auth/*（v1外） | 認証ライブラリ | better-auth 1.7.7固定。公開する経路は契約の一覧(`authLibrary.endpoints`、OpenAPI `x-external-apis`)だけ：sign-up(招待token必須)/sign-in/sign-out/get-session/request-password-reset/reset-password/change-password/two-factor(enable・verify-totp・verify-backup-code・generate-backup-codes・get-totp-uri。二要素の解除は公開しない）。一覧外はJSON 404 | ライブラリResponse（業務data envelope外） |
| API-37 | PUT /members/:id/roles | PER-07 | version,expectedAuthzVersion,roleCodes,scopes,reason;管理者のみ（二要素必須）。対象は有効なアカウント付きの同unit団員。自己昇格(今持つ最上位より上の役割・新しい担当)403、最後の管理者の降格422(details.reason=last_admin)、旧版/旧認可版409、担当の対象種別は存在を確認できる種別だけ(PH1は`member`のPER-06のみ、他は422)。外れた役割・担当は取消して履歴に残し、認可版を増やす | MemberRoles(memberId,version,authzVersion,roleCodes,scopes) |
| API-38 | POST /users/:id/session-revocations | PER-07/本人 | expectedAuthzVersion,reason;管理者または本人。認可版を増やし、基準時刻(users.session_revoked_before)より前のセッションを業務側で拒否したうえで認証側の全セッションを削除。失敗は再試行job(`auth.revoke_sessions`)が残り`pending` | RevocationResult(userId,authzVersion,sessionRevocation=completed/pending) |
| API-39 | PATCH /activities/:id | PER-03 | version,ActivityInputの変更列,status?;公開済の変更理由/許可遷移 | Activity |
| API-40 | POST /activities/:id/cancellation | PER-03 | version,reason;出欠保持/通知は別承認 | Activity |
| API-41 | PUT /activities/:id/attendance/:memberId | PER-02代理許可 | version,response,reason;D05承認済scope | Attendance |
| API-42 | POST /activities/:id/actual-results/corrections | PER-04 | resultVersion,ActualInput,reason;新revision | ActivityResult |
| API-43 | GET /activities/:id/actual-results | PER-01 | revision?;旧版も認可 | ActivityResult＋revisions |
| API-44 | GET /facilities/:id/inspections | PER-01 | from/to/result/limit/cursor;系列の原本を時系列で返す（訂正前の旧原本も含む。現在版はseriesポインタ） | Page<Inspection> |
| API-45 | POST /facilities/:id/location-reviews | PER-03確認許可 | version,locationVersion,decision=request/verify/reject,reason(2000まで);座標版一致。**確認者は現状PER-03で暫定（「誰が確認できるか」はD09未決）** | Facility＋LocationRevision |
| API-46 | POST /inspections/:type/:id/corrections | PER-04 | seriesVersion,InspectionInput,supersedesId,reason;series版/同対象/分岐拒否。**訂正対象はseriesの現在版であること（過去版からの枝分かれは409 VERSION_CONFLICT）。並行の第2訂正もseries版ガードで409。supersedes_id非NULL UNIQUEの二重防御。再訂正は現在版への訂正として重ねる** | Inspection |
| API-47 | POST /vehicles | PER-03 | assetCode,name,status,storageFacilityId?;番号一意 | Vehicle |
| API-48 | PATCH /vehicles/:id | PER-03 | version,変更列;参照中物理削除なし | Vehicle |
| API-49 | POST /equipment | PER-03 | assetCode,name,quantity,quantityUnit,storage;番号一意。**保管先の施設/車両の排他（両方指定）は契約でなくサーバーの422 INVALID_TRANSITION業務規則（docs/14 D22）。契約は形だけ検査する** | Equipment |
| API-50 | PATCH /equipment/:id | PER-03 | version,変更列;数量非負/保管先 | Equipment |
| API-51 | GET /assets/:type/:id | PER-01 | type vehicle/equipment;limit/cursor;**使用履歴のcursor子Pageは接続済み（T042。asset＋usages。cancelled行も残り、operationIdで元活動/出動へ辿る）**。点検/異常/点検期限の子Pageは未接続＝残作業（T030/T032/T048で接続） | AssetDetail |
| API-52 | GET /analytics | PER-01 | from/to/fiscalYear/memberId/kind;distinct operation、D05年度 | Analytics＋sourceFilters |
| API-53 | POST /facilities/imports | PER-03 | csvAttachmentId,templateVersion;UTF8/列/座標/重複プレビュー。**解析job(import.parse)の応答はjobs.result_refに`ready:<previewHash>:<有効行数>/<全行数>`を載せ、行エラー（先頭分。上限は500字、溢れは`~`）も`:行=理由コード`で併載する。全件はimport_rows台帳、照会はAPI-86。プレビューだけで台帳は不変** | ImportBatch(202) |
| API-54 | POST /facilities/imports/:id/commit | PER-03 | version,previewHash,conflictResolution;元台帳版一致 | ImportResult(202可) |
| API-55 | GET /facilities/export | PER-03閲覧＋出力 | FacilityQuery;同ACL/CSV式注入escape | CSV＋exportVersion |
| API-56 | PUT /assets/:type/:id/inspection-schedule | PER-03 | version(未作成0),nextDueDate,intervalDays?,timezone;日付規則D06 | InspectionSchedule |
| API-57 | PUT /operations/:id/resource-usages | PER-04 | version,usages[{id?,Target,quantity,from?,to?}],reason;有効全件/同unit/全対象編集権。operation版をガードし増分（旧版・並行は409）、id付きは既存行の更新・id無しは新規・来なかった既存行はcancelled（物理削除しない。cancelledは終端422）、quantity>0/時間順序（両方既知時）/対象はvehicleかequipment片側、存在しない・廃止資産は404、全行編集権がなければ403で全体を拒否、変更前後はresource_usage_eventsへ（T042） | ResourceUsageList＋operationVersion |
| API-58 | GET /reports/:id | PER-11 | revision?;未承認版は担当のみ | Report＋ReportVersion |
| API-59 | POST /reports/:id/versions | PER-10 | version,text,missingFields,sourceVersions,reason;新draft版 | ReportVersion |
| API-60 | POST /reports/:id/decision | PER-10 | version,reportVersion,decision=request_review/approve/changes_requested,sourceVersions,reason | request_reviewはVersion＋submissionEvent、最終審査はReviewDecision＋Version |
| API-61 | GET /reports/:id/content | PER-11 | format=pdf/csv;承認版のみ/D20 | binary/CSV |
| API-62 | POST /reports/manual | PER-04 | activityId,resultVersion,templateVersion,text;AI停止時 | Report(draft) |
| API-63 | POST /notifications/drafts | PER-12 | source,body,audienceMemberIds,channels,expiresAt? | Notification(draft) |
| API-64 | POST /notifications/:id/approval | PER-12 | version,bodyHash,audienceHash,decision=approve/cancel;送信明示承認 | Notification＋Job(202) |
| API-65 | GET /notifications/:id | PER-12/対象者 | なし;送信者と本人で項目投影 | Notification＋Deliveries |
| API-66 | PUT /announcements/:id/read | 本人 | revisionNo;対象・公開版 | ReadReceipt |
| API-67 | GET /notifications/me | PER-01 | status/limit/cursor;本人のみ | Page<Notification> |
| API-68 | POST /tasks | PER-04/10 | title,assigneeMemberId?,dueDate?,sourceDecisionId?;AI効果は承認済 | Task |
| API-69 | PATCH /incidents/:id | PER-04 | version,status?,kind?,summary?,reason（必須。訂正/無効化理由）;許可遷移。voidedは終端（変更は422） | Incident |
| API-70 | GET /incidents/:id | PER-01限定 | なし;参集/活動/使用履歴/イベント。operationVersion（出来事rootの現行版。API-57/71の版ガードに画面が使う。T044） | IncidentDetail |
| API-71 | PUT /incidents/:id/activity | PER-04 | version,activityId,activityVersion,operationVersions,reason（2,000）;両root＋双方のoperation版を同一batchの比較更新でロック（不一致は409で全体不変。キー不足400）。競合リンク（既存の別出動あり）409、リンク済み出動の付け替えとvoided出動は422。出動と使用履歴を活動側operationへ付替し旧operationはcountable=0で履歴/監査参照可、旧ID/理由はincident_eventsへ | Incident＋OperationLink |
| API-72 | PATCH /announcements/:id | PER-03 | version,title?,body?,status?,audienceMemberIds?;新revision | Announcement |
| API-73 | POST /documents | PER-11管理 | title,classification,acl;D20許諾 | Document |
| API-74 | POST /documents/:id/versions | PER-11管理 | version,attachmentId,licenseRef;ready原本/抽出job | DocumentVersion＋Job(202) |
| API-75 | POST /documents/:id/decision | PER-10文書承認 | version,documentVersion,decision=request_review/approve/changes_requested,reason;出典許諾 | request_reviewはVersion＋submissionEvent、approve時Decision＋indexJob |
| API-76 | POST /search/rag | PER-11/09 | query,maxSources?,documentIds?;ACL前置/引用必須 | RagAnswer(answer,citations,abstained) |
| API-77 | POST /ai/assistant | PER-09 | query,contextRefs;許可読取/書込はproposalだけ | AssistantProposal＋references |
| API-78 | POST /patrol-plans | PER-14 | facilityIds,date,objective;D01設計案で検証、正式対象は提案時確認 | PatrolPlan(draft) |
| API-79 | POST /patrol-plans/:id/decision | PER-14 | version,orderedFacilityIds,decision=confirm/cancel,reason;人が確定 | PatrolPlan |
| API-80 | GET /events | PER-13 | entityType/entityId/afterSequence;再接続認可 | 認可イベントstreamまたは同等poll DTO（D16） |
| API-81 | POST /sync/commands | PER-13＋元操作 | SyncCommand;許可元API/同requestHash/baseVersion | SyncOperation(200/202/409) |
| API-82 | GET /sync/operations/:id | PER-13本人 | なし;本人/端末operation | SyncOperation |
| API-83 | PUT /attachments/:id/upload | PER-04本人申請 | `x-upload-token`ヘッダー(URLに残さない),本文bytes;実測容量、試行専用キー | UploadAttempt(id,sha256,size,version) |
| API-84 | POST /attachments/:id/completion | PER-04 | version,uploadAttemptId,sha256;実体HEAD/検査job | Attachment＋Job(202) |
| API-85 | DELETE /attachments/:id | PER-04（本人分を含む） | version,reason;有効リンクがある場合422。**保持期間の猶予はD10未決のため未実装（tombstone後にjobで即時削除）** | 204（D1 tombstone後R2削除job） |
| API-86 | GET /jobs/:id | 依頼者（PH0。担当者への拡張はPH4で通知/AI jobの利用時に判断） | なし;機微入力/内部error本文なし | Job(status,attempts,errorCode,resultRef) |
| API-87 | PATCH /tasks/:id | PER-04/10 | version,status?,assigneeMemberId?,reason;業務対象権限 | Task |
| API-88 | GET /ai/evaluation-runs | PER-08 | modelId/datasetVersion/limit/cursor | Page<EvaluationRun> |
| API-89 | POST /ai/evaluation-runs | PER-08運用 | datasetVersion,questionVersion,modelId;架空/許諾済dataset | Job(202) |
| API-90 | GET /documents | PER-11 | q/status/limit/cursor;文書ACL前置 | Page<Document> |
| API-91 | GET /documents/:id | PER-11 | revision?;原文添付参照/引用元版 | DocumentDetail |
| API-92 | POST /documents/:id/withdrawal | PER-11管理 | version,reason;即時検索除外/旧引用失効 | Document＋deindexJob |
| API-93 | GET /audit-logs | PER-08 | entityType/entityId/from/to/actorId/limit/cursor（新しい順の安定keyset=occurred_at,id）;管理者のみ・二要素必須・自分の分団だけ。監査の更新/削除/追加のAPIは無い(PATCH/DELETE/POSTは404) | Page<AuditLog>（id,occurredAt,actorKind,actorId,action,entityType,entityId,mutationId,entityVersion,eventType,metadata。本文・氏名・連絡先・token・Secretは含まない） |
| API-94 | GET /inspection-templates | PER-04 | targetType/status/limit/cursor;承認版一覧を担当範囲で取得 | Page<InspectionTemplate> |
| API-95 | POST /inspection-templates | PER-03様式管理 | name,targetType,itemSchema;code一意/型/必須/結果列挙,D06 | InspectionTemplate(draft) |
| API-96 | POST /inspection-templates/:id/versions | PER-03様式管理 | version,itemSchema,reason;新draft版/旧版不変 | InspectionTemplateVersion |
| API-97 | POST /inspection-templates/:id/decision | PER-10様式承認 | version,templateVersionId,decision=request_review/approve/changes_requested,reason;D06承認者/現版。**決定は様式root(inspection_templates)の版ガードで競合を409にし、一版一決定。同じ版への並行の決定は409、承認済み（または差戻し済み）の版への新しい決定は422 INVALID_TRANSITION。他の様式の版IDは404。承認済み版はトリガーで不変** | InspectionTemplateVersion |
| API-98 | POST /attachment-drafts | PER-04＋対象作成権 | intendedEntityType,parentType?,parentId?;作成権/同unit、15分期限案 | AttachmentDraft(id,version,expiresAt) |
| API-99 | PATCH /documents/:id/access-policy | PER-11管理 | version,classification,acl[{memberIdまたはroleId,permission,effect}];引下げ承認/同unit | Document＋policyVersion＋reindexJob |
| API-100 | PUT /notifications/:id/read | 本人recipient | notificationVersion;本人/対象/可視版 | ReadReceipt（recipient.readAt） |
| API-101 | DELETE /attachments/:id/links/:linkId | 元対象編集権 | version,reason;同unit/分類/保持方針D10、link tombstone | 204（本文なし。attachmentEventは履歴へ追記し応答へ含めない） |

## 5. GIS・ページング・集計契約

FacilityQueryは`bbox=west,south,east,north`、type、managementNumber(q)、verificationStatus、inspectionResult、hasOpenIssue、limit/cursor。点検状態は最新有効点検のresult、位置確認はverificationStatusで別列。bbox境界包含、南<=北、経度跨ぎ対応。cursorはfilterHash/sortKey/snapshotRevisionを含むサーバー署名値、条件変更で破棄。順序はid（GIS）または日時＋id、同一snapshotで抜け/重複を防ぐ。

GIS可変root/点検/異常変更はunitsのdataset_revisionも同batchで増分。続き取得でrevisionが変われば409 SNAPSHOT_CHANGED、UIは再取得し一部取得表示。クライアントは全cursor完走してから「取得済み」、地図移動時は前世代応答を破棄。クラスタリングは描画最適化だけで取得漏れを隠さない。大量データはサーバー集約との仕様を実測して確定し、未取得部分を空白事実としない。

一般一覧も安定keysetと重複ID除去を行い、厳密snapshotが必要な帳票/CSVはexport job時に元版snapshotを固定する。集計は10のACLを先に適用。未回答はactivity_audience－回答済、確認待ちはreported/under_review、点検期限は業務日、活動と出動はdistinct operationで数える。期間はfrom包含/to排他、年度開始月はD05。

## 6. 形式・既存名称対応

DB planned_starts_at ↔ API plannedStartsAt ↔ UI予定開始、actual_starts_at↔actualStartsAt↔実開始、location_source↔locationSource↔位置出典、verification_status↔verificationStatus↔位置確認、result↔inspectionResult（検索）↔点検結果、confirmed_category↔confirmedCategory↔人確認分類。v0.2のsource/starts_at/actual_statusは04の新分離へ移行する設計変更。user/status/roleの自己申告をbodyから採用しない。

## 7. 機械可読化と技術確認

T002で`src/shared/contracts`（Zod）に全101件を実装し、`openapi/fireos.json`を生成した（`npm run generate:contracts`/`check:contracts`）。応答DTOの`provisional`分は各機能タスクで確定する。以下は設計時点の注意として残す：該当API実装前にOpenAPI 3.1/Zodの同一スキーマへ転記し、全API-ID/DTO/拒否/再送をCI検査する（V03、13）。API-36の固定版認証スキーマ、SSE/poll/DO選択、生成/索引モデルの実呼出しは未検証。未検証を全機能正式リリースからの延期理由にしない。

## 8. リアルタイムsnapshotと再開cursor

API-70等の同期対象snapshotは、親/子データとunits.event_sequenceを同一D1 read batchで取得しsnapshotCursorを返す。API-80はそのcursor以後のoutboxを走査して現在のACLでfilterするため、snapshotと接続間のcommitも回収する。cursorはunit/認可版/対象filter/走査済sequence/期限を暗号化・認証したopaque値で、利用者に全イベント件数や非可視行を示さない。

単調採番はunit内、一mutation一event、UNIQUE(unit_id,sequence)。各業務mutationと同batchでunits.event_sequence増分→event保存。配信はevent payloadの最小ID/対象版、重複/順序逆はentityVersionで検知。非可視イベントは走査位置だけ進め、heartbeat/resumeCursorで伝えるため番号飛びを通信欠落と誤認しない。cursorの認可版不一致/保持期間外は409 RESYNC_REQUIREDでsnapshotを再取得。更新後はdomain_eventを失ってもD1 outbox再読で回収できる。D16/V06で実方式と負荷を検証する。

## 9. 完成後の提案に向けた検証

架空データの開発/試験では14の推奨設定を明示的な検証設定として使用する。実団体の役割や情報利用が了承済みであると偽装しない。UNAPPROVED_POLICYは実データ/正式運用に必要な設定が未承認のときの拒否条件であり、消防団からの事前了承なしに設計案を架空環境で作ることを禁止しない。
