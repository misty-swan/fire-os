# PH1 実行証跡（2026-10-14）

対象: T007〜T014（認証・名簿・権限・監査）。実行環境はローカル（Node v26 / workerd / wrangler 4.150.0 / vitest 4.1.11 / Playwright chromium）。**実Cloudflareアカウント・実D1・実Workersは使っていない（wrangler未ログイン）。**

## 実行結果
| 確認 | コマンド | 結果 |
|---|---|---|
| 型検査 | `npm run typecheck` | 成功 |
| 契約検査 | `npm run check:contracts` | 101 API / docs/05 101行 / OpenAPI一致 |
| 単体・結合試験 | `npx vitest --run` | 12ファイル126件成功（workers 101件＝認証/認可/招待/名簿/失効/監査を含む、client 25件） |
| ブラウザ試験 | `npm run test:e2e` | 24件成功＋1件スキップ（スマホ専用試験をPC幅で除外）。setup（管理者を招待→MFAで作成）＋shell/auth/member-admin/audit を 360px と 1280px で実行 |
| ビルド | `npm run build` | 成功 |
| 実環境の試験 | `npm run test:live` | **未実施（環境未設定のため失敗＝未実施の記録）**。docs/evidence/V01-auth.md の手順が必要 |

## タスク別の指定試験
T007 `auth_works_in_workers_without_public_signup`（局所）/ T008 `admin_role_does_not_bypass_sensitive_scope` / T009 `invitation_has_one_consumer_and_bound_identity` / T010 `mfa_recovery_code_cannot_be_reused`（実ブラウザ・実Cookie）/ T011 `private_fields_never_leak_to_roster` / T012 `disabled_user_is_denied_even_if_library_revoke_fails` / T013 `stop_requires_reason_and_preserves_member_history`（実ブラウザ）/ T014 `audit_is_append_only_and_scope_filtered` — すべて成功。

## 赤→緑の扱い（正直な記録）
- **先にテストを書き、未実装を理由に失敗することを確認した**：T009（bootstrap/orphansモジュール未作成）、T011（名簿API未実装で404）、T012（disableモジュール未作成）、T014（監査API未実装で404）。T007は認証ルートを一時的に外して404で失敗を確認、T008はAPI-01の接続を外して失敗を確認。
- **実装を先に書き、試験を後から作った**：T007・T008・T010・T013（画面）。代わりに防御を外す変異で試験が失敗することを確認した（下表）。T010/T013は実ブラウザ試験の実行中に欠陥を検出して修正した（下記）。

## 試験が検出した欠陥（修正済み）
- 管理者が二要素認証なしで名簿の登録・変更ができた（PER-06 member に mfa_required が無かった）→ T010のe2e setupが検出。
- 全セッション失効(API-38)で認証ライブラリの削除が失敗すると、旧セッションが業務で使えた → `users.session_revoked_before` で業務側が拒否（T012）。
- 自分を降格することを「自己昇格」と誤判定 → 役割の序列で判定。
- 回復コードの誤りが「パスワード誤り」と表示された、確認ダイアログの既定フォーカスが「戻る」でなかった、招待リンク表示がリロードで消えた、同一画面で別の招待リンクを開くと古いtokenが残った → UI修正。

## 変異による確認（防御を外して試験が失敗することを確認）
- T007: sign-up検査（招待tokenを知らないメール一致のみ）、再設定時の全セッション失効、Origin検査、認証経路の許可リスト、回復コードの暗号化、再設定識別子のhash、回数制限 → すべて検出。
- T008: unit照合、MFA検査、管理者が他人の許可列を開く、scope/role取消条件、停止検査、試験用ヘッダーの常時許可、PER-07へのofficer追加 → すべて検出。
- T009: メール一致検査、再発行の旧招待取消、bootstrapの「分団が空」条件、再送でtoken再表示、期限検査、孤児回収条件、identity申告検査、PER-07検査 → 検出。**未検出（等価）**：団員リンクの`user_id IS NULL`と招待消費の`status='pending'`の条件除去は、版の比較(root assertion)が同じ働きをするため結果が変わらない。
- T011: 許可列の読取範囲、空の許可列表示、基本項目/許可列の権限検査、他人の許可列閲覧の監査、canManage、DBトリガーのallowlist → 検出。**未検出（等価）**：並びのid（索引が(unit_id,display_name,id)）、アカウント付き団員の事前検査（batch内conditionが同じ働き）。
- T012: 認可版の増分、失効job、session_revoked_before、セッション作成フック、自己昇格検査、担当対象の存在確認、API-38の権限、jobのセッション削除、最後の管理者の保護（事前確認と確定batchの両方を、直接呼ぶ試験で検出）→ 検出。
- T013/T010(e2e): ログアウトでsignOutを呼ばない、戻り先の外部URL許可、停止理由なしで押せる、ダイアログ既定フォーカス、canManage常時true → 検出。
- T014: PER-08検査、unit絞り込み、cursor条件、行為者絞り込み、監査のUPDATEトリガー → 検出。

## 未実施・未接続（検証済みとして扱わない）
- **V01（実Workers/staging）**：better-auth 1.7.7 の実Cloudflare上の動作・CPU時間は未測定。`tests/live/auth-workers.test.ts` と手順は docs/evidence/V01-auth.md。T007は「局所完了・実環境未完了」。T009のbootstrap CLIも実環境では未実行。
- 再設定コード・招待tokenの配送（メール等）はD04未決で未実装（`AuthDeps.deliverReset`が差込口）。passkey（生体認証ログイン）は無効表示。
- 停止した団員の再開（復帰）は未提供（422）。担当(scope)の対象種別は`member`のみ（他はそのテーブルができるPH2以降で追加）。
- 実端末（iOS/Android）・スクリーンリーダー・200%拡大は未確認（T083）。フォントはGoogle Fontsで、未読込の環境ではアイコンの字が見える（ph1スクリーンショットのloginに表れている）。
- GitHub Actions、実Cloudflare D1/R2/Queues/Cronは未接続（PH0から継続）。

## prototype準拠
login（`docs/evidence/ph1/login-*.png`）、団員名簿（`members-*.png`）、管理（`admin-*.png`）。数値は実ブラウザ試験で確認（ロゴ76px・FireOS 40px/900・入力54px・主ボタン56px・副ボタン52px、検索欄320×42px、団員ドロワー440px）。prototypeから変えた点と理由は docs/03（SCR-01/15/17の段落）。
