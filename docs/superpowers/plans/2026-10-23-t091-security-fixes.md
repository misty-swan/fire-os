# T091 セキュリティ監査指摘の修正（S1〜S10）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 監査run-1で確定した9件（S1〜S9）と要検証1件（S10）を、再現を回帰試験にしたうえで塞ぎ、S1は公開デモへ先行反映する。

**Architecture:** どれも「入口Aは認可するが同じ効果に届く入口Bが認可しない」型。各修正は既存handlerへ①早期の認可/状態検査と②`executeMutation` の in-batch `ExtraCondition`（`{existsSql, binds, failCode}`・src/server/mutations/execute.ts:39）を足す。新規endpoint・migration・DTOの形の変更はしない（契約102不変）。

**Tech Stack:** Cloudflare Workers・Hono・D1・better-auth・vitest（project `workers`＝実workerd）・wrangler。

**Spec:** `docs/16_実装タスク一覧.md` の「### T091」節（指摘1〜10・「設計の確定（2026-10-22）」）。本計画のTask 0でその設計欄を調査結果に合わせて訂正する。監査の再現手順は `~/security-audit-skill/fire-os/run-1/final-records/v01〜v10-*.json`（Git管理外。読むだけ）。

## Global Constraints

- 架空データのみ（Git・公開画面に実データを載せない）。試験は `createFixture("two-units")`（tests/helpers/fixture.ts）か既存seed。
- 各指定試験は**修正前に赤**を確認してから直す。skipを成功扱いにしない。
- 1指摘＝1コミット（`fix: T091-Sn ...`、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`）。各コミットに①実装②試験③`tests/acceptance/manifest.json` の該当 `T091-Sn` を `"status": "resolved"`・basisを「T091手順nで修正: <修正の要点>。試験 <file> <test名>（修正前<赤の様子>→緑）」へ④docs/16 T091節の該当チェックを `[x]` を含める。manifest変更後は `npm run check:coverage`。
- 型検査が主ゲート: 各タスクの最後に `npm run typecheck`。
- 単一試験: `npx vitest run --project workers <file> -t "<name>"`。
- 実環境（fireos-demo）を変える操作（`wrangler deploy`・`--remote` の書き込み）は**実行直前に利用者へコマンドを示してOKを得る**。読み取りの `--remote` 問い合わせも同様に事前提示する。
- 新規の業務文言・エラーコードは増やさない。例外はS1の `DEMO_ACCOUNT_LOCKED`（better-auth層のcode）とS8の伏せ文1文のみ。

## Review Focus

1. 体験アカウント以外の利用者は、S1後も二要素の登録・サインイン時のTOTP検証ができる → Task 1 の関連回帰に既存 `tests/audit.test.ts`（l.152で `loginAs` の利用者が `/two-factor/enable`）と `tests/auth-adapter.test.ts` を含める。
2. 既存の正規の添付導線（下書き経由のattachmentIds・施設へ自動紐付けされた本人写真の点検/課題への移動・本人の活動向け添付）がS2後も通り、移動で消えるのは自動紐付けだけ → Task 3 の回帰（既存3試験）＋新試験 `own_autolinked_photo_still_moves_and_only_its_autolink_is_removed`。
3. 担当者の付け替えを正当に行う管理者・自分への付け替え（変化なし）はS4後も通る → Task 5 試験内の対照断言。
4. 本人の `notification.read` と公開後の通知・お知らせイベントは引き続き本人に届く → Task 10 試験内の対照断言。
5. 全文書を閲覧できる閲覧者はS8後も回答本文・提案・参照をそのまま受け取る → Task 9 試験内の対照断言。

---

### Task 0: 設計欄の訂正（docs）

**Files:**
- Modify: `docs/16_実装タスク一覧.md`（T091「設計の確定」）

- [ ] **Step 1: 調査で判明した4点へ書き換える**
  - S2: 紐付けてよい元添付は「本人（`owner_user_id = actorUserId`）が上げ、文書原本でなく、有効なリンクが無いか、上げた時の対象への自動紐付け・今回の紐付け先へのリンクだけのもの」に限る（他人の可視添付の再共有は扱わない＝必要になれば別設計）。移動で消すのはその自動紐付けだけ。
  - S3: principalは変えず、handlerに保持scopeを期限付きで読み直す問い合わせを足す（「既に読み直している」は誤り）。
  - S6: API-22（出動作成時の活動紐付け）も同じ穴のため同じ修正を入れる。
  - S8: `answer` は契約で1文字以上・`references` にmasked形が無いため、回答本文を伏せ文 `閲覧できない文書を参照しているため、この回答は表示しません` に置換・`proposedEffects` を空・見えない文書のreferencesを除外する（readResultsは既存masked）。
  - S10: 文書全体の予算は既存の `MAX_INFLATED_BYTES`（32MiB）を文書あたり合計として使う。
- [ ] **Step 2: コミット**

```bash
git add docs/16_実装タスク一覧.md
git commit -m "docs: correct T091 design notes from code survey"
```

---

### Task 1: S1 体験アカウントの二要素自己登録・パスワード変更を拒否

**Files:**
- Modify: `src/server/auth/demo-accounts.ts`・`src/server/auth/config.ts:250-265`（hooks.before）
- Test: `tests/demo-accounts.test.ts`

**Interfaces:**
- Produces: `export function isDemoAccountUserId(authUserId: string): boolean`（demo-accounts.ts。`DEMO_ACCOUNTS` の `ids.authUser` との一致）

- [ ] **Step 1: 失敗する試験を書く**（既存の `signIn(email)`・`TEST_PASSWORD` を使う）

```ts
it("demo_admin_cannot_enable_two_factor_or_change_password", async () => {
  const b = await signIn(DEMO_ACCOUNTS[0].email);
  const enable = await b.json("POST", "/api/auth/two-factor/enable", { password: TEST_PASSWORD });
  expect(enable.status).toBe(403);
  expect(enable.data.code).toBe("DEMO_ACCOUNT_LOCKED");
  const verify = await b.json("POST", "/api/auth/two-factor/verify-totp", { code: "000000" });
  expect(verify.status).toBe(403);
  const change = await b.json("POST", "/api/auth/change-password", { currentPassword: TEST_PASSWORD, newPassword: "another-pass-12345" });
  expect(change.status).toBe(403);
  // two_factor_enabled は 0 のまま、API-33 は引き続き mfa_required
  const inv = await b.json("POST", "/api/v1/invitations", { memberId: DEMO_ACCOUNTS[2].ids.member, email: "invitee2@example.test", expiresInHours: 24 }, { "idempotency-key": crypto.randomUUID() });
  expect(inv.status).toBe(403);
  expect(inv.data.error.details[0].reason).toBe("mfa_required");
});

```

- [ ] **Step 2: 赤を確認** — `npx vitest run --project workers tests/demo-accounts.test.ts -t "demo_admin_cannot"` → enableが200で FAIL。
- [ ] **Step 3: 実装** — `hooks.before` の先頭で `ctx.path.startsWith("/two-factor/") || ctx.path === "/change-password"` のとき `getSessionFromCtx(ctx).catch(() => null)` を読み、`isDemoAccountUserId(session.user.id)` なら `throw APIError.from("FORBIDDEN", { code: "DEMO_ACCOUNT_LOCKED", message: "体験アカウントでは二要素認証とパスワードを変更できません" })`。セッションが無い経路（サインイン途中のverify-totp）は従来どおり素通し（体験アカウントは二要素を持たないので到達しない）。demo-accounts.tsのdocコメントの「解除経路は公開しない」を「hooks.beforeで拒否（T091-S1）」へ直す。
- [ ] **Step 4: 緑と関連回帰** — `npx vitest run --project workers tests/demo-accounts.test.ts tests/demo-reset.test.ts tests/auth-adapter.test.ts tests/audit.test.ts tests/revocation.test.ts tests/invitations.test.ts` と `npm run test:e2e -- tests/e2e/auth.spec.ts --project=setup --project=desktop-1280` → PASS。`npm run typecheck`。
- [ ] **Step 5: コミット**（Global Constraintsの③④を含む） `fix: T091-S1 block demo accounts from 2FA enrollment and password change`

---

### Task 2: S1 を公開デモへ反映し、実環境の体験管理者を正準状態に戻す

**Files:**
- Modify: `ops/demo-deploy.md`（§5.1 の後に「体験アカウントの二要素状態の確認と戻し」手順）・`docs/evidence/demo-live-check.md`（節「T091-S1 の反映」）・`docs/16_実装タスク一覧.md`（手順1の実施記録）

- [ ] **Step 1: 配置ゲート**（ops/deploy.md §2と同じ） — `npm run typecheck && npm run check:contracts && npm run check:migrations && npm run build && npm run check:environment && npx vitest --run` と CIと同じe2e（AGENTS.mdの4project）→ 全PASS。`npx wrangler whoami` でログイン確認。ビルドは `src/client/.env.local` のMapsキーを読む（demo-live-check.md「デプロイ中に見つけて直したこと」）。
- [ ] **Step 2: 実環境の状態を読む（利用者へ提示しOKを得てから）**

```bash
npx wrangler d1 execute DB --env demo --remote --command "SELECT id, email, two_factor_enabled FROM auth_users WHERE id IN ('00000000-0000-4000-8000-000000de0015','00000000-0000-4000-8000-000000de0018','00000000-0000-4000-8000-000000de001b'); SELECT user_id, COUNT(*) FROM auth_two_factors WHERE user_id LIKE '00000000-0000-4000-8000-000000de%' GROUP BY user_id;"
```

- [ ] **Step 3: 配置（利用者のOK後）** — `npx wrangler deploy --env demo` → `npx wrangler deployments list --env demo` で稼働versionを控える。
- [ ] **Step 4: 戻し（Step 2で `two_factor_enabled=1` または auth_two_factors 行があった体験アカウントだけ。コマンドを提示しOK後）** — 対象idについて `DELETE FROM auth_two_factors WHERE user_id=?`・`UPDATE auth_users SET two_factor_enabled=0 WHERE id=?`・`DELETE FROM auth_sessions WHERE user_id=?`。パスワードが変えられていた疑いがある（体験パスワードでサインインできない）場合は、利用者に `DEMO_ACCOUNT_PASSWORD` の値で `npm run demo:seed:remote` を流してよいか確認する（既存アカウントは飛ばすため、効かなければ記録して利用者と相談）。
- [ ] **Step 5: 実URLで確認** — 体験管理者でサインイン→ブラウザ開発者ツール不要の方法として `curl` で `POST https://fireos-demo.hiromu1018ks.workers.dev/api/auth/sign-in/email` → cookie付きで `/api/auth/two-factor/enable` が403 `DEMO_ACCOUNT_LOCKED`。パスワードは `.env.demo-login`（Git管理外）から読み、コマンド履歴・記録に値を残さない。
- [ ] **Step 6: 記録とコミット** — demo-live-check.md に日時・稼働version・commit・Step 2の結果（登録の有無）・Step 4の実施有無・Step 5の結果。ops/demo-deploy.mdへStep 2/4の手順。`docs: record T091-S1 demo deployment and account state check`

---

### Task 3: S2 元添付を本人の未使用アップロードに限る（＋H5 draftId所有者照合）

**Files:**
- Modify: `src/server/attachments/link.ts`（`planAttachmentLinks` l.56-180）
- Test: Create `tests/attachment-links.test.ts`

**Interfaces:**
- Consumes/Produces: `planAttachmentLinks(env, unitId, actorUserId, input): Promise<LinkPlan>` — 署名は変えない（呼出側 issues.ts:65・activity-results.ts:192/267・facility-writes.ts:67・inspections/build.ts:227 は無変更）。

- [ ] **Step 1: 失敗する試験を書く**（文書は tests/documents.test.ts の `createDocument`/`uploadOriginal` と同じ手順を本ファイルにローカル関数で複製。API-99取消は document-policy.test.ts:229 の形）

```ts
it("document_original_cannot_be_relinked_to_an_issue_by_an_acl_member", async () => {
  // 文書ACL=admin role＋member M。M が API-91 で original.attachmentId を得る
  // M: POST /api/v1/issues {target:{type:"facility",id:F}, title, description, attachmentIds:[origId]} → 403
  // operator の GET /api/v1/attachments/:origId/content → 404 のまま
  // attachment_links に entity_type='document' の行が残り unlinked_at IS NULL
});
it("revoked_member_cannot_relink_document_original_to_activity_results", async () => {
  // 取消（API-99 で M を deny）後、M 所有の公開活動へ POST /api/v1/activities/:id/actual-results {…, attachmentIds:[origId]} → 403
  // M と operator の API-27 → 404
});
it("someone_elses_unlinked_upload_cannot_be_linked", async () => { /* officer の未紐付け添付を member が課題へ → 403 */ });
it("draft_id_of_another_user_is_forbidden", async () => { /* officer の draftId を member が施設作成(API-11)で指定 → 403 */ });
it("own_autolinked_photo_still_moves_and_only_its_autolink_is_removed", async () => {
  // member が施設Fへ直接アップロード（自動紐付け）→ 課題へ attachmentIds で移動 → 201
  // facility F のリンクは unlinked、課題リンクが有効。別途 admin が同添付を施設Gへ付けていた行が無いことを前提に件数で断言
});
```

- [ ] **Step 2: 赤を確認** — `npx vitest run --project workers tests/attachment-links.test.ts` → 最初の4件が201/200でFAIL。
- [ ] **Step 3: 実装**
  - draft分岐: JSで `draft.owner_user_id !== actorUserId` なら `HttpError("FORBIDDEN")`。既存のdraft root/conditionへ `AND owner_user_id = ?`（actorUserId）を足す。
  - attachmentIdsごとの新しい in-batch condition（既存のNOT_FOUND条件の直後・`failCode: "FORBIDDEN"`）:

```sql
SELECT 1 FROM attachments a
WHERE a.id = ? AND a.unit_id = ? AND a.owner_user_id = ?
  AND NOT EXISTS (SELECT 1 FROM document_versions dv WHERE dv.attachment_id = a.id)
  AND NOT EXISTS (
    SELECT 1 FROM attachment_links l
    WHERE l.attachment_id = a.id AND l.unlinked_at IS NULL
      AND l.entity_type <> 'document'
      AND NOT (l.entity_type = a.intent_target_type AND l.entity_id = a.intent_target_id)
      AND NOT (l.entity_type = ? AND l.entity_id = ?))          -- 今回の紐付け先（再送）
  AND NOT EXISTS (SELECT 1 FROM attachment_links l2 WHERE l2.attachment_id = a.id AND l2.entity_type = 'document')
```

    （`targetCreatedInBatch` のときも target.id は確定済みなので同じbind）
  - 機微対象のmove DELETE（l.133・l.139）: WHERE に `AND entity_type = (SELECT intent_target_type FROM attachments WHERE id = ?) AND entity_id = (SELECT intent_target_id FROM attachments WHERE id = ?)` を足し、自動紐付け以外は消さない。
- [ ] **Step 4: 緑と関連回帰** — `npx vitest run --project workers tests/attachment-links.test.ts tests/attachments.test.ts tests/upload.test.ts tests/file-inspection.test.ts tests/documents.test.ts tests/document-policy.test.ts tests/inspections-issues.test.ts tests/activity-results.test.ts tests/facilities.test.ts tests/sync.test.ts` → PASS。既存試験が他人の添付を使っていて落ちた場合は、その試験が正規導線か（本人アップロードに直せるか）を見て、試験側を本人アップロードへ直す（直した理由をコミット本文へ）。`npm run typecheck`。
- [ ] **Step 5: コミット** `fix: T091-S2 restrict attachment relinks to the caller's own unused uploads`

---

### Task 4: S3 自分宛てscopeの期限延長・撤廃を拒否

**Files:**
- Modify: `src/server/routes/member-roles.ts:60-67`
- Test: `tests/revocation.test.ts`

- [ ] **Step 1: 失敗する試験を書く**（既存 `putRoles(fx, who, target, body)`。期限付きscopeは authorization.test.ts:95 の形で直接INSERT＋`expires_at = now+1h`）

```ts
it("admin_cannot_extend_or_remove_expiry_of_own_scope", async () => {
  // admin(unit a) に PER-06 scope（entity=member X, expires_at=now+1h）
  // 同じscopeを expiresAt=now+1年 で自分へ PUT → 403 self_escalation
  // 同じscopeを expiresAt 無し で PUT → 403 self_escalation
  // expiresAt=now+30分（短縮）→ 200、scopes: []（削除）→ 200
});
```

- [ ] **Step 2: 赤を確認** → 延長が200でFAIL。
- [ ] **Step 3: 実装** — 自分宛てのとき、`SELECT entity_type, entity_id, permissions, expires_at FROM scope_assignments WHERE member_id = ? AND unit_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)` を読み、要求scopeごとに「同じ entityType/entityId/並べたpermissions の保持行があり、かつ（保持の期限がnull、または要求の期限が非nullで保持以下）」を満たさなければ `self_escalation`。`p.scopes` 比較はこれに置き換える。
- [ ] **Step 4: 緑と関連回帰** — `tests/revocation.test.ts tests/authorization.test.ts tests/members.test.ts` → PASS。typecheck。
- [ ] **Step 5: コミット** `fix: T091-S3 reject self-extension of scope expiry`

---

### Task 5: S4 タスク担当の付け替えで新担当者も認可

**Files:**
- Modify: `src/server/routes/tasks.ts`（API-87、l.293の直後）
- Test: `tests/tasks.test.ts`

- [ ] **Step 1: 失敗する試験を書く**

```ts
it("member_cannot_transfer_own_task_to_someone_else", async () => {
  // admin が member 担当のタスクを作成 → member: PATCH /api/v1/tasks/:id {version, assigneeMemberId: officer.memberId, reason} → 403、assignee は member のまま
  // 同じく assigneeMemberId: null → 403
  // 対照: member が assigneeMemberId: 自分 → 200、admin が officer へ付け替え → 200
  // 対照: 403になった要求と同じidempotency-keyで再送しても403（再送経路でも認可）
});
```

- [ ] **Step 2: 赤を確認** → 200でFAIL。
- [ ] **Step 3: 実装** — l.293の直後（`!knownKey` ブロックの外）: `if (body.assigneeMemberId !== undefined && body.assigneeMemberId !== current.assignee_member_id) requireTaskPermission(p, { unitId: p.unitId, type: "task", id: params.id, ownerMemberId: body.assigneeMemberId ?? undefined });`（先例 inspection-corrections.ts:52-57）。
- [ ] **Step 4: 緑と関連回帰** — `tests/tasks.test.ts tests/authorization.test.ts` → PASS。typecheck。
- [ ] **Step 5: コミット** `fix: T091-S4 authorize the new assignee on task transfer`

---

### Task 6: S5 取消済み出動への参加・資機材使用の書き込みを拒否

**Files:**
- Modify: `src/server/routes/incident-participants.ts`（`buildRecordParticipation` l.62-206）・`src/server/routes/resource-usages.ts`（`buildResourceUsageMutation` l.103-170）
- Test: `tests/incident-participants.test.ts`・`tests/resource-usages.test.ts`・`tests/sync.test.ts`

- [ ] **Step 1: 失敗する試験を書く**（取消は `PATCH /api/v1/incidents/:id {version, status:"voided", reason}`。sync は `syncCmd`/`postSync`）
  - `participant_record_on_voided_incident_is_rejected`: 取消後 `PUT /api/v1/incidents/:id/participants/:self {version:0, attendanceStatus:"arrived"}` → 422・`details[0].reason === "voided_is_terminal"`・incident_participants 0行。
  - `resource_usage_replace_on_voided_incident_is_rejected`: 取消後 `PUT /api/v1/operations/:incOp/resource-usages {...}` → 422・有効行0。
  - `sync_participant_record_on_voided_incident_is_rejected`（sync.test.ts）: API-81で同じ記録 → 結果が422相当・行0。
  - 対照: 取消前に記録したものと同じidempotency-keyの再送は保存済み応答を返す。
- [ ] **Step 2: 赤を確認** → 201/200でFAIL。
- [ ] **Step 3: 実装**
  - participants: l.71の読み取りに `status` を加え、`if (!knownKey)` 内で voided なら `throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "status", reason: "voided_is_terminal" }])`。specへ `conditions: [{ existsSql: "SELECT 1 FROM incidents WHERE id = ? AND unit_id = ? AND status <> 'voided'", binds: [incidentId, unitId], failCode: "INVALID_TRANSITION" }]`。
  - resource-usages: `!knownKey && !createdInBatch` の早期読みで `SELECT 1 FROM incidents WHERE unit_id = ? AND operation_id = ? AND status = 'voided'` が当たれば同じ422。`conditions` へ `SELECT 1 FROM units u WHERE u.id = ? AND NOT EXISTS (SELECT 1 FROM incidents i WHERE i.unit_id = u.id AND i.operation_id = ? AND i.status = 'voided')`（failCode `INVALID_TRANSITION`）。
- [ ] **Step 4: 緑と関連回帰** — `tests/incident-participants.test.ts tests/resource-usages.test.ts tests/sync.test.ts tests/incidents.test.ts tests/operation-link.test.ts` → PASS。typecheck。
- [ ] **Step 5: コミット** `fix: T091-S5 reject participant and resource usage writes on voided incidents`

---

### Task 7: S6 出動↔活動リンクで活動側も認可（API-71・API-22）

**Files:**
- Modify: `src/server/operations/link.ts`（`ActivityLinkTarget` l.44-53・`resolveActivityForLink` l.56-72・l.145付近）・`src/server/routes/incidents.ts`（API-22 l.73-88付近）・`docs/05_API仕様書.md:127`（API-71行の権限欄に「出動PER-04＋活動PER-03（両rootを認可）」）と API-22行の同欄
- Test: `tests/operation-link.test.ts`

**Interfaces:**
- Produces: `ActivityLinkTarget.ownerMemberId: string | null`（`a.owner_member_id` をSELECTに追加）

- [ ] **Step 1: 失敗する試験を書く**
  - `operator_scoped_to_incident_only_cannot_link_activity`: operator に incident scope `["PER-04"]` を直接INSERT（authorization.test.ts:95の形）→ 活動PATCHは403（前提の確認）→ `PUT /api/v1/incidents/:iid/activity {...}` → 403、活動のversion・activity_events件数・`linked_incident_id` 不変。
  - `operator_scoped_to_incident_only_cannot_create_incident_linked_to_activity`: 同operatorが API-22 で activityId 付き作成 → 403、incidents行増えず。
- [ ] **Step 2: 赤を確認** → 200/201でFAIL。
- [ ] **Step 3: 実装** — link.ts l.145の直後（`knownKey` 判定より前＝再送でも）に `requirePermission(p, "PER-03", { unitId: p.unitId, type: "activity", id: body.activityId, ownerMemberId: activity.ownerMemberId ?? undefined })`。API-22も `resolveActivityForLink` の直後に同じ。
- [ ] **Step 4: 緑と関連回帰** — `tests/operation-link.test.ts tests/incidents.test.ts tests/activities.test.ts tests/sync.test.ts tests/authorization.test.ts` → PASS。`npm run check:contracts` → PASS。typecheck。
- [ ] **Step 5: コミット** `fix: T091-S6 authorize the activity side of incident-activity links`

---

### Task 8: S7 お知らせ添付をAPI-24と同じ可視規則で配信

**Files:**
- Modify: `src/server/routes/announcements.ts`（l.106 `manageVisibility` の近く・`queryAnnouncements` l.164-172）・`src/server/routes/attachments.ts:35-47`
- Test: `tests/announcements.test.ts`

**Interfaces:**
- Produces: `export function announcementVisibilitySql(p: AuthzPrincipal, alias: string): { sql: string; binds: unknown[] }`（`(status='published' AND audience) OR (status='draft' AND manage) OR (status='archived' AND (audience OR manage))` を返す。`queryAnnouncements` もこれを使うよう置き換え）と `export async function isAnnouncementVisible(env: Pick<AppEnv,"DB">, p: AuthzPrincipal, announcementId: string): Promise<boolean>`

- [ ] **Step 1: 失敗する試験を書く** — `announcement_attachment_follows_announcement_visibility`: admin が `audienceMemberIds=[member]` で下書き作成、添付は ready行＋`attachment_links(entity_type='announcement')` を直接INSERT（announcements.test.ts:272の注記どおり）・R2へ架空PNGを置く → 下書き中の member の `GET /api/v1/attachments/:id/content` → 404。公開後: member 200（対照）・対象外 operator 404。対象から member を外す更新後: member 404。unit b admin 404（対照）。
- [ ] **Step 2: 赤を確認** → 200でFAIL。
- [ ] **Step 3: 実装** — attachments.ts のリンクループで `l.entity_type === "announcement"` は `isAnnouncementVisible(c.env, p, l.entity_id)`。他の種別（facility・vehicle・equipment・activity・issue・inspection）の読み取りAPIがPER-01より狭い規則を持つかを各routeで確かめ、結論をdocs/16 手順7の実施記録へ1行で書く（狭い規則があれば新しい台帳行 `T091-S7a` として登録し本タスクでは直さない）。
- [ ] **Step 4: 緑と関連回帰** — `tests/announcements.test.ts tests/attachments.test.ts tests/upload.test.ts tests/events.test.ts` → PASS。typecheck。
- [ ] **Step 5: コミット** `fix: T091-S7 apply announcement visibility to announcement attachments`

---

### Task 9: S8 見えない文書を参照するAIレビュー行の回答を伏せる

**Files:**
- Modify: `src/server/routes/ai-classification.ts`（`maskReadResults` l.95-103・toDto l.178-186）
- Test: `tests/assistant.test.ts`（`api_30_masks_read_results_of_documents_the_viewer_cannot_see` l.482 を拡張）

**Interfaces:**
- Produces: `const MASKED_ASSISTANT_ANSWER = "閲覧できない文書を参照しているため、この回答は表示しません";`（ai-classification.ts内）

- [ ] **Step 1: 失敗する断言を足す** — 既存試験で、隠し文書（`pageText` に「格納箱の非公開メモ（架空）」）が見えない閲覧者の行について: `JSON.stringify(row.output)` に「格納箱の非公開メモ」を含まない・`output.answer === MASKED_ASSISTANT_ANSWER`（文字列で断言）・`output.proposedEffects` が `[]`・`output.references` に隠し文書のidが無い。対照: 文書を見られるadminの同じ行は `answer` が伏せ文でなく、referencesに当該idがある。
- [ ] **Step 2: 赤を確認** → answerに本文が含まれFAIL。
- [ ] **Step 3: 実装** — 行の `readResults` と `references` のうち `type === "document"` のidを集め、`isDocumentVisible` が偽のものが1つでもあれば `{ ...parsed, answer: MASKED_ASSISTANT_ANSWER, proposedEffects: [], references: parsed.references.filter(r => !(r.type === "document" && hidden.has(r.id))), readResults: masked }`。可視判定はidごとに1回（Map）で、`maskReadResults` と結果を共有する。
- [ ] **Step 4: 緑と関連回帰** — `tests/assistant.test.ts tests/rag.test.ts tests/ai-decisions.test.ts tests/assistant-context-chips.test.tsx` → PASS。typecheck。
- [ ] **Step 5: コミット** `fix: T091-S8 withhold assistant answers that cite documents the viewer cannot see`

---

### Task 10: S9 イベント配信から下書きと他人の既読を落とす

**Files:**
- Modify: `src/server/routes/notifications.ts:42-43`（`RECIPIENT_VISIBLE_SQL` をexport）・`src/server/events/snapshot.ts`（`visibleFlagsOfBatch` l.108-163）・`docs/05_API仕様書.md:136`（API-80欄に「notification=宛先かつ状態approved/dispatching/finished/failed、`notification.read` は本人分のみ（管理者は全件）。announcement=対象者かつ状態published/archived（管理者は全件）」）
- Test: `tests/events.test.ts`

- [ ] **Step 1: 失敗する試験を書く** — `events_hide_drafts_and_other_members_reads`: admin が member と operator 宛ての通知下書き（`POST /api/v1/notifications/drafts`、source は試験内で作る活動）→ member の `GET /api/v1/events?afterSequence=0&entityType=notification` に当該通知のイベントが無い。承認（`POST /api/v1/notifications/:id/approval`）後は member に出る（対照）。operator が既読（`PUT /api/v1/notifications/:id/read`）→ member の結果に `notification.read` が無い。member が自分で既読 → 自分の `notification.read` は出る（対照）。admin には両方の既読が出る（対照）。member 対象のお知らせ下書き → `entityType=announcement` で出ない、公開後は出る（対照）。
- [ ] **Step 2: 赤を確認** → 下書きイベントが出てFAIL。
- [ ] **Step 3: 実装** — 非管理者の通知pending問い合わせを `notification_recipients r JOIN notifications n ON n.id = r.notification_id AND ${RECIPIENT_VISIBLE_SQL}` に。`event_type === "notification.read"` かつ `JSON.parse(payload_minimal).recipientMemberId !== p.memberId` の行は非管理者には偽。お知らせpendingは `JOIN announcements a ON a.id = au.announcement_id AND a.status IN ('published','archived')`。
- [ ] **Step 4: 緑と関連回帰** — `tests/events.test.ts tests/realtime.test.ts tests/notification-approval.test.ts tests/notification-delivery.test.ts tests/announcements.test.ts tests/realtime-client.test.tsx` → PASS。`npm run check:contracts` → PASS。typecheck。
- [ ] **Step 5: コミット** `fix: T091-S9 align event feed visibility with notification and announcement read rules`

---

### Task 11: S10 PDF展開量を文書全体で上限

**Files:**
- Modify: `src/server/documents/extract.ts`（`extractPdfPages` l.352・`expandObjectStreams` l.462・`decodeStream` l.522・`inflate` l.550・`extractTextFromContent` l.741・`buildFontDecoder` l.604・`loadToUnicodeMap` l.630）
- Test: `tests/document-extract.test.ts`

**Interfaces:**
- Produces: `interface InflateBudget { remaining: number }`（extract.ts内）。`inflate(stream, budget)`・`decodeStream(obj, budget)` と上記の呼出連鎖へ `budget` 引数を追加。`extractPdfPages` 開始時に `{ remaining: MAX_INFLATED_BYTES }` を1つ作る。

- [ ] **Step 1: 失敗する試験を書く** — `repeated_content_stream_refs_share_one_inflate_budget`: 10MiBのゼロをdeflateしたstream 4を、`buildMinimalPdfWithFlateStream` の変種（`/Contents [4 0 R 4 0 R 4 0 R 4 0 R]`。同ファイル内にローカル関数で作る）で包む → `createPublicDocument`→`uploadPdfOriginal`→`createVersion`→`runJobs` → job `status === "manual_review"`・`error_code === "unextractable_document"`・`chunkRows(versionId)` が `[]`。
- [ ] **Step 2: 赤を確認** — 各10MiBは単独上限内なのでジョブが成功しFAIL。
- [ ] **Step 3: 実装** — `inflate` は読んだchunkごとに `budget.remaining -= chunk.length`、負になったら `DocumentExtractError("unextractable_document","inflate_limit_exceeded")`。deflate→deflate-rawの再試行時は1回目で消費した分を戻してから再試行する（同じ予算を二重に引かない）。非圧縮streamは計上しない（従来どおり）。
- [ ] **Step 4: 緑と関連回帰** — `tests/document-extract.test.ts tests/documents.test.ts tests/retrieval.test.ts tests/rag.test.ts` → PASS（既存 `inflate_over_32mb_falls_back_to_manual_review` も緑）。typecheck。
- [ ] **Step 5: 記録** — docs/16 手順10の実施記録へ「stagingでの実メモリ/CPU観察は実Cloudflare未構築のため残作業（局所完了）」。
- [ ] **Step 6: コミット** `fix: T091-S10 cap PDF inflation per document instead of per stream`

---

### Task 12: 総合回帰・受入証跡・2回目の反映

**Files:**
- Modify: `docs/16_実装タスク一覧.md`（L78の完了件数・L186の状態欄・T091実施記録）・`docs/evidence/acceptance-index.json`・`docs/evidence/acceptance-results.md`（collect:evidenceが生成）・`docs/evidence/demo-live-check.md`

- [ ] **Step 1: 全ゲート** — AGENTS.mdの検証コマンドをCIと同じ順に（`npm ci`→typecheck→check:contracts→check:coverage→build→`npx vitest --run`→業務e2e 4project）→ 全PASS。落ちたら該当タスクへ戻って直す（skipしない）。
- [ ] **Step 2: 受入証跡** — e2eポート8797が空いていることを確かめて `npm run collect:evidence`（約20分）→ ゲート `npm run test:e2e -- tests/acceptance/all-requirements.spec.ts --grep acceptance_gate_fails_on_skip_missing_route_or_unexecuted_case` → PASS。
- [ ] **Step 3: docs/16更新** — T091の状態を「局所完了（S10のstaging観察が残る）」、完了件数を92へ、実施記録に各コミットと試験名。
- [ ] **Step 4: コミット** `feat: complete T091 security audit fixes`（collect:evidenceの生成物を含む）
- [ ] **Step 5: 2回目の反映（利用者のOK後）** — Task 2 Step 1・3・5と同じ手順で `npx wrangler deploy --env demo`、稼働versionと確認結果をdemo-live-check.mdへ追記し `docs: record T091 demo deployment` でコミット。
