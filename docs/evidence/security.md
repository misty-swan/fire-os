# セキュリティ試験の証跡・限界（T081、2026-10-17）

対象: T081（全API/添付/検索/同期の権限・入力・濫用試験）。対応要件は AUTH-02/AUTH-04/NFR-05/NFR-07、参照は docs/07・docs/10・docs/08 CT-01/02/16/17・RG-04。実行環境はローカル（Node v26 / workerd / wrangler 4.x / vitest）。**実Cloudflare・実D1・実R2・実AI・実端末は使っていない（PH0〜PH6から継続で未接続）**。データはすべて架空。

## 1. 実装（何を足したか）

| 実装 | 内容 | 正本 |
|---|---|---|
| `src/server/security/limits.ts` | `applySecurity(app, policy)` ＋ レート上限。**2層でdocs/07 §2（D18）「IP＋user単位」を実装**: ①IP境界（routes前のmiddleware。**auth/ai/search/upload/既定の5バケット**、分類は台帳から機械展開、未認証も計上）、②user単位（`enforceUserRateLimit`を`resolvePrincipal`が有効な利用者で呼ぶ**第二計上点**。鍵はusers.id。`policy.userRateLimit`。修正ラウンド1で追加）。既定policyは寛容な開発設定（既存試験・e2e・通常運用を止めない。controller裁定2）。超過は429 RATE_LIMITED＋計算済み`Retry-After`（details.reason=`bucket_*`＝IP次元／`user_*`＝user次元） | docs/05 §1の429行・docs/07 §2（D18）と**実装（T081）**節 |
| `src/server/security/headers.ts` | 共通security headers（nosniff・X-Frame-Options DENY・Referrer-Policy no-referrer・CSP `frame-ancestors 'none'`・cache-control no-store）を全API応答へ。**値が無い場合だけ付ける**（添付・帳票のbinary応答が独自に設定した値を壊さない） | docs/07 §2 |
| `src/server/index.ts` | `applySecurity`をrequestIdの次・routesの登録前に接続（既定policy）。**Origin/CSRF検査は既存機構のまま**（重複実装しない。controller裁定4）。cache-control付与をheaders.tsへ集約 | 02（app組立） |
| `createApp(env, securityPolicy?)` | policyの差し替え口。Honoは登録順に照合するため、**routes後のapplySecurityでは既存routeの前に挟まれない**（試験で実測。§4）——このため引数で差す | docs/14（実装判断） |
| `src/server/security/redact.ts` ＋ `http.ts/onError` | 内部例外のログを `{requestId, error:{name, digest}}` に変更。**例外本文（ライブラリ内部で要求値・認証情報・bind値を含み得る）をログに出さない**。digestは同一障害の突き合わせ用 | docs/07 §1「ログに…無条件保存しない」 |
| `docs/05 §1`追記 | 429の共通挙動（バケット・鍵・Retry-After・開発設定であること・isolate限界）。API契約の変更は無し（OpenAPI再生成は不要。check:contractsで確認済み） | docs/05 §1 |

## 2. 認可matrixの機械展開（controller裁定1。黙った除外なし）

- **正本は台帳（`src/shared/contracts/registry.ts`）の102 API**を`apiIds`で展開。docs/16の「101 API分類」は陳腐な表記のため使わない。分類は試験コード内の**明示対応表（CLASSIFICATION、id→分類の全102行）**で持ち、**「台帳の全idが表にあり、表の全idが台帳にある」ことを断言**する（修正ラウンド1で対応表化。以前は補集合による抽出で網羅断言が恒真だったため、Important指摘2で修正）。新規APIの追加時は対応表（`satisfies Record<ApiId, …>`で網羅を型検査も強制）に明示追加するまで試験が落ち、未分類のidを挙げて失敗する**（対応表から1行を抜いた実測: `expected [ 'API-99' ] to deeply equal []`で検知を確認）。
- 分類（tests/security/authorization-matrix.test.ts の表どおり）:

| 分類 | 定義 | 件数 | 試験 |
|---|---|---|---|
| PROTECTED | permissionにPER-xxを持つ | 95 | 未認証・停止（fixtureのdisabled user）・member（権限で拒否されるPERは自unit、許され得るPERは別unit）の3主体＋深掘り（下記） |
| OWNER | PERでない（本人/token/依頼者/元対象ACL/編集権） | 6 | 未認証・停止の2主体。本人性・token束縛の深掘りは既存ドメイン試験（invitations/auth-adapter/jobs/attachments）が担保 |
| EXTERNAL | API-36（認証ライブラリ。method=ALL） | 1 | 招待token無しのsign-upが403（自由登録の拒否） |

- **`uncoveredProtectedRoutes=[]`** ＝ 台帳の保護対象（PER付き・HTTP到達可能な95 route）を全件試験した。除外は**1件も無い**（入力は台帳の契約shapeから機械導出し、setupが重すぎてHTTPで叩けないrouteは無かった）。
- 深掘り（機械展開に加えて実測した拒否）: ①有効な本文を送ったmemberへの403 FORBIDDEN（API-11/03/33/25＝PER-03/06/07）、②別unitの**幹部**でもunit Aの実在施設に届かない404（GET/PATCH）と一覧への混入なし、③**失権**: `authz_version`増分つきの利用停止で業務routeの次の要求から401（回復も確認）、operatorの担当scope取消で次の要求から409（認可を通っていた）→403 FORBIDDEN、④同期（API-81/82）: 同鍵再送が保存済み結果を返し効果は1回、API-82照会は本人200・他人404。
- 断言（docs/16 T081どおり）: `uncoveredProtectedRoutes=[]` / `unauthorizedSuccessfulEffects=0` / `leakedRowsOrFields=[]` / `rateLimited.status=429`（同テスト内で厳しいpolicy注入の429観測に接続）。加えて「拒否は全て共通エラーenvelope（requestId付き）」「5xx無し」「拒否された要求の冪等記録0行」を全probeで断言。

## 3. 実行結果

| 確認 | コマンド | 結果 |
|---|---|---|
| 赤（実装前） | `npx vitest --run tests/security/authorization-matrix.test.ts -t every_business_route_rejects_cross_unit_and_stale_permissions` | **FAIL `expected 200 to be 429`**（applySecurity/limits未実装による正当な赤。module解決失敗の赤は型スケルトン後に取り直し） |
| 赤（user次元・修正ラウンド1） | `npx vitest --run tests/security/abuse.test.ts -t user_dimension_limits_one_user_without_punishing_others_on_the_same_ip` | **FAIL `expected 200 to be 429`**（user単位の第二計上点が未実装の正当な赤） |
| 緑（核） | 同上 | PASS（95 protected×3主体＋owner6×2＋external1＋深掘り＋429。約330要求/約0.4秒） |
| セキュリティ試験全体 | `npx vitest --run tests/security/` | **3ファイル9件成功**（authorization-matrix 1 / abuse 4 / input-matrix 4。修正ラウンド1でuser次元の試験を追加） |
| 型検査 | `npm run typecheck` | 成功 |
| 契約検査 | `npm run check:contracts` | 102 API / docs/05 102行 / OpenAPI一致（契約変更なし。OpenAPI再生成は不要と確認） |
| 全体回帰 | `npx vitest --run` | **64ファイル285件成功**（1回目のフル実行で auth-adapter の `measures_password_hash_cost_for_v01`（壁時計 `<5000ms` の計測試験）が1件のみFAIL→単独実行と2回目のフル実行は緑。既存の時間感応試験が重いフル走行で一度だけ揺れたもので、機能回帰ではない。観察継続をph7で確認） |
| ビルド | `npm run build` | 成功（precache 9 entries） |
| e2e | `npm run test:e2e` | **未実施（タスク指示どおり。既存e2eは既定policyが寛容なことで壊れない設計。全体回帰とT082で担保）** |

- **濫用試験の実測**（tests/security/abuse.test.ts）: 厳しいpolicy注入で4バケット各自429（共通エラーenvelope＋`Retry-After`＋nosniff付き）、バケットの隔離（高価な4バケットを使い切っても既定の業務APIは止まらない）、既定policyは通常の連続要求（40連続の/me等）で429不発。**user次元（修正ラウンド1）**: IP境界を寛容・user単位だけ厳しいpolicyで、同一利用者の3回目が429（details.reason=`user_default`）になり、**同じIPの別利用者は止まらない**ことを実測。認証・招待・MFAの総当たりは: 再設定要求は登録の有無を応答で区別せず、誤パスワード・誤招待tokenは一様に拒否して対象を消費せず（正しいtokenは有効のまま）、TOTP誤codeは401×4（正しいcodeは上限内で通る）で、続く総当たりは**ライブラリ自身のD1上限（verify-totp 5回/分/IP。docs/07 §2どおり）で429**になることを実測。
- **入力試験の実測**（tests/security/input-matrix.test.ts）: XSS文字列はJSONとして配信（content-type application/json・nosniff。画面はReactのエスケープ）、CSV式注入（`=HYPERLINK(...)`）は書き出しで`'`前置＋引用符エスケープ（csvCell。docs/05 API-55）、256KiB超・壊れたJSON・2万段ネスト・巨大query・契約外query・`$gt`等の演算子は全て400で500不発、`../`や`<script>`を含む対象IDは400/404でJSONのみ、security headersは/meに全て付き、Origin検査（evil→403 cross_origin・自origin→201）は既存機構のまま有効、内部例外のログはrequestId＋name＋digestのみでcredential/位置が漏れない（redact）。

## 4. 実装中に検出・修正したこと（正直な記録）

- **修正ラウンド1（レビューImportant 2件）**: ①レート上限がIP次元のみでdocs/07 §2（D18「IP＋user単位」）と乖離 → **後退ではなく最良案**でuser単位の第二計上点を実装（`enforceUserRateLimit`。resolvePrincipalが有効な利用者で呼ぶ。policyに`userRateLimit`次元を追加、既定は寛容。赤→緑の試験つき）。②matrixの分類が補集合抽出で網羅断言が恒真 → **明示対応表（全102行）＋網羅断言**に修正（対応表から1行を抜いた実測で検知を確認。§2）。docs/07・docs/05・本書を2層方式の記述に更新し、**docs/07の記述と実装は一致**。
- **Honoの登録順（実測）**: routes登録後の`applySecurity`ではmiddlewareが既存routeの前に挟まれない（429にならない）。試験は`createApp(env, policy)`でroutes前に差す方式にした（T082の緩和policyも同じ口）。この挙動はdocs/14の実装判断としてindex.tsに記録。
- **redactionの必要性は実測で確認**: 実装中のデバッグ出力で、内部例外（BetterAuthErrorのschema不一致）の**本文がログにそのまま出る**ことを確認→`redactError`（name＋digest）へ変更し、試験で断言。
- レート上限の`requests:0`（全部拒否）policyでRetry-After計算がNaNになる潜在欠陥を試験過程で発見→窓の長さを返すよう修正。

## 5. PH6からの残課題の確認（controller裁定5）

API-82照会分岐の「到達不能コード」（ph6.md記録）: **T081の同期試験で到達不能であることを確認**——API-81の同鍵再送が台帳から保存済み結果を返すため、応答消失後の回復は照会APIを呼ばずに完結する（再送で効果は1回のまま）。API-82自体は本人200・他人404として正しく動くため、コードは削除せず残存（削除条件の利益より、契約上の照会口を残す方が保守のリスクが小さいと判断）。**PH7で再確認**（ph6.mdどおり）。

## 6. 限界（実施済みと未実施の正直な区別）

- **実ペネトレーションテストは未実施**。本試験は自分たちの防御（拒否・漏えい無し・効果無し）を機械展開で確認したもので、外部の専門評価ではない。
- **レート上限はisolate内メモリ**（Workerの1実行体ごと）。複数isolateに分散する実環境では合計が上限×isolate数に緩む——**厳密な全体上限はCloudflare WAF/Rate Limiting製品層で行う前提**であり、実環境での設定と検証（T087）は未実施。
- **実WAF/実CDN/実Workers環境**での確認（headersの実効性・IPヘッダの信頼性〔`cf-connecting-ip`の偽装可否はCloudflare層の保証〕・CSP）は未実施（T087）。
- **SPA静的asset（ASSETS経由）へのCSPは未設定**（本タスクはAPI応答が対象。HTMLのCSPは実CDN/ホスティング設定と併せてT087で判断する）。
- **ジョブ・バックグラウンド経路の内部ログ**（`mutations/execute.ts`、`src/server/jobs/`配下の`String(err)`）は本文をそのまま出す経路が残る（要求本文を含まないサーバー側jobの文脈。将来の改善点として記録）。
- pixel完全デコード・PDFのmalware検査は未実装（docs/evidence/V02-files.mdに記録済み。T081では再実施しない）。添付の検査・取得の機微ヘッダは既存試験（attachments.test.ts等）が担保。
- 既存の認証・招待・セッション失効・権限変更のライフサイクル試験（auth-adapter/authorization/revocation/invitations各試験）を**置き換えず拡充**の位置づけ。matrix試験はそれらと重複しない（HTTP全routeの機械展開＋深掘りのみ）。

## 7. 予約欄

- **重大未解決0のレビュー証跡**: PH7レビューサイクルで記録（この節は予約。実施後に結果を追記する）。
- 実環境での遮断・rotation演習: ops/security-response.md §7（初回手順つき）をT087で実施後、結果を追記。
