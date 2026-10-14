import { readFileSync } from "node:fs";
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { secretFromUri, totpCode } from "../helpers/totp";

export const BASE = "http://localhost:8787";
export const PASSWORD = "e2e-correct-horse-9";
export const STATE_DIR = "tests/e2e/.state";

export interface AdminState {
  email: string;
  password: string;
  totpSecret: string;
  backupCodes: string[];
}
export const readAdmin = (): AdminState => JSON.parse(readFileSync(`${STATE_DIR}/admin.json`, "utf8")) as AdminState;
export const randomIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
export const uniqueEmail = (label: string) => `${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;
export const isPhone = (viewport: { width: number } | null) => (viewport?.width ?? 0) < 1024;

/** 局所のworkerdはIPを持たないので、試験ごとに別のIPを名乗り、認証の回数制限を食い合わない */
export async function withOwnIp(context: BrowserContext): Promise<void> {
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": randomIp() });
}

/** 管理者のセッション（storageState）でAPIを呼ぶ。Origin を付ける（ブラウザと同じ） */
export function apiHeaders(extra: Record<string, string> = {}) {
  return { origin: BASE, "content-type": "application/json", "cf-connecting-ip": randomIp(), ...extra };
}
export async function adminApi<T = unknown>(request: APIRequestContext, method: "GET" | "POST" | "PATCH" | "PUT", path: string, body?: unknown) {
  const res = await request.fetch(`${BASE}${path}`, {
    method,
    headers: apiHeaders(method === "GET" ? {} : { "idempotency-key": crypto.randomUUID() }),
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status(), data: (text ? JSON.parse(text) : null) as T };
}

/** 管理者が団員を登録して招待し、生tokenを返す（API-03→API-33） */
export async function inviteNewMember(request: APIRequestContext, name: string, email: string): Promise<{ memberId: string; invitationId: string; token: string }> {
  const m = await adminApi<{ data: { id: string } }>(request, "POST", "/api/v1/members", { displayName: name, status: "active", rank: "団員", squad: "2班" });
  expect(m.status).toBe(201);
  const i = await adminApi<{ data: { id: string; token: string } }>(request, "POST", "/api/v1/invitations", { memberId: m.data.data.id, email, expiresInHours: 48 });
  expect(i.status).toBe(201);
  return { memberId: m.data.data.id, invitationId: i.data.data.id, token: i.data.data.token };
}

/** 画面から招待を受領し、二要素認証を設定して回復コードを控える。新しい利用者のブラウザ文脈を返す */
export async function acceptInvitationViaUi(page: Page, email: string, token: string, opts: { mfa: boolean } = { mfa: true }) {
  await page.goto(`/login#invite=${token}`);
  await expect(page.getByRole("heading", { name: "招待を受け取る" })).toBeVisible();
  // token はアドレスから消えている
  await expect(page).not.toHaveURL(/invite=/);
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("新しいパスワード（12文字以上）").fill(PASSWORD);
  await page.getByLabel("パスワード（確認）").fill(PASSWORD);
  await page.getByRole("button", { name: "アカウントを作成して受け取る" }).click();
  await expect(page.getByRole("heading", { name: "二要素認証を設定します" })).toBeVisible();
  if (!opts.mfa) {
    await page.getByRole("button", { name: "あとで設定する" }).click();
    await expect(page).toHaveURL(/\/app$/);
    return { totpSecret: "", backupCodes: [] as string[] };
  }
  return enrollMfaViaUi(page);
}

/** 二要素認証の設定画面（パスワード再確認→QR/キー→6桁→回復コード一度表示）を最後まで進める */
export async function enrollMfaViaUi(page: Page) {
  await page.getByRole("button", { name: "二要素認証を設定する" }).click();
  await page.getByLabel("パスワード").fill(PASSWORD);
  await page.getByRole("button", { name: "次へ" }).click();
  const key = await page.getByLabel("手入力用のキー").textContent();
  const totpSecret = key!.replaceAll(" ", "");
  await expect(page.getByAltText("認証アプリ用のQRコード")).toBeVisible();
  await page.getByLabel("認証アプリの6桁").fill(await totpCode(totpSecret));
  await page.getByRole("button", { name: "確認して有効にする" }).click();
  await expect(page.getByRole("heading", { name: /回復コードを保管/ }).or(page.getByText("回復コードを保管してください"))).toBeVisible();
  const backupCodes = await page.getByRole("list", { name: "回復コード" }).getByRole("listitem").allTextContents();
  expect(backupCodes.length).toBe(8);
  await page.getByLabel("回復コードを安全な場所に保管しました").check();
  await page.getByRole("button", { name: "完了" }).click();
  return { totpSecret, backupCodes };
}

/** パスワード→（二要素）でログインする */
export async function loginViaUi(page: Page, email: string, second?: { totp?: string; backup?: string }, opts: { stay?: boolean } = {}) {
  if (!opts.stay) await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  if (second) {
    if (second.backup) {
      await page.getByRole("button", { name: "回復コードを使う" }).click();
      await page.getByLabel("回復コード").fill(second.backup);
    } else {
      await page.getByLabel("認証コード（6桁）").fill(second.totp!);
    }
    await page.getByRole("button", { name: "確認する" }).click();
  }
}

export async function newUserContext(browser: Browser, viewport: { width: number; height: number }) {
  const context = await browser.newContext({ viewport, baseURL: BASE, storageState: { cookies: [], origins: [] } });
  await withOwnIp(context);
  return context;
}

export { secretFromUri, totpCode };

/** メニュー画面（スマホはメニュータブ、PCは左下の利用者ブロック）からログアウトする */
export async function logoutViaUi(page: Page) {
  if (isPhone(page.viewportSize())) await page.getByTestId("bottom-nav").getByRole("link", { name: "メニュー" }).click();
  else await page.getByRole("link", { name: "プロフィールとログアウト" }).click();
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page).toHaveURL(/\/login$/);
}
