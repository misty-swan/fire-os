import { readFileSync, writeFileSync } from "node:fs";
import { expect, test as setup } from "@playwright/test";
import { secretFromUri, totpCode } from "../helpers/totp";
import { BASE, PASSWORD, STATE_DIR, apiHeaders } from "./helpers";

/**
 * 管理者アカウントを実際の経路で作る（fixtureのCookie注入ではない）：
 *   bootstrap CLI の招待token → 登録(sign-up, 招待tokenつき) → 受領(API-35) → 二要素認証(TOTP＋回復コード)
 * 結果のセッションを storageState に保存し、以降の試験が使う。管理操作(PER-07)は二要素が有効でないと拒否される。
 */
setup("create_the_first_admin_through_the_real_invitation_flow", async ({ playwright }) => {
  const { email, token } = JSON.parse(readFileSync(`${STATE_DIR}/bootstrap.json`, "utf8")) as { email: string; token: string };
  const request = await playwright.request.newContext({ baseURL: BASE });
  const post = (path: string, data: unknown, extra: Record<string, string> = {}) =>
    request.post(path, { headers: apiHeaders({ "idempotency-key": crypto.randomUUID(), ...extra }), data: JSON.stringify(data) });

  // 自由登録は閉じている（招待tokenが無ければ拒否）
  expect((await post("/api/auth/sign-up/email", { email: "free@example.test", password: PASSWORD, name: "x" })).status()).toBe(403);

  const up = await post("/api/auth/sign-up/email", { email, password: PASSWORD, name: "管理者" }, { "x-invitation-token": token });
  expect(up.status()).toBe(200);
  const authId = ((await up.json()) as { user: { id: string } }).user.id;
  // 受領前は業務に入れない
  expect((await request.get("/api/v1/me", { headers: apiHeaders() })).status()).toBe(401);
  const accepted = await post("/api/v1/invitations/accept", { token, verifiedAuthIdentity: authId });
  expect(accepted.status()).toBe(200);
  expect(((await accepted.json()) as { data: { roleCodes: string[] } }).data.roleCodes).toEqual(["admin"]);

  // 管理者は二要素認証が必須：未設定の間は管理操作が拒否される
  const denied = await post("/api/v1/members", { displayName: "架空 試験", status: "active" });
  expect(denied.status()).toBe(403);
  const enable = await post("/api/auth/two-factor/enable", { password: PASSWORD });
  expect(enable.status()).toBe(200);
  const { totpURI, backupCodes } = (await enable.json()) as { totpURI: string; backupCodes: string[] };
  const secret = secretFromUri(totpURI);
  expect((await post("/api/auth/two-factor/verify-totp", { code: await totpCode(secret) })).status()).toBe(200);
  const ok = await post("/api/v1/members", { displayName: "架空 確認用", status: "active" });
  expect(ok.status()).toBe(201);

  writeFileSync(`${STATE_DIR}/admin.json`, JSON.stringify({ email, password: PASSWORD, totpSecret: secret, backupCodes }), { mode: 0o600 });
  await request.storageState({ path: `${STATE_DIR}/admin-storage.json` });
});
