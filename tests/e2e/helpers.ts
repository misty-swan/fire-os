import { readFileSync } from "node:fs";
import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page, type Response } from "@playwright/test";
import { secretFromUri, totpCode } from "../helpers/totp";
import { E2E_BASE } from "../../scripts/e2e-port";

/** e2eサーバーのorigin（scripts/e2e-port.ts。既定8797・FIREOS_E2E_PORT） */
export const BASE = E2E_BASE;
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
/** e2e用: data部の型をまとめて宣言できるadminApi */
export async function adminApiData<T>(request: APIRequestContext, method: "GET" | "POST" | "PATCH" | "PUT", path: string, body?: unknown): Promise<{ status: number; data: { data: T; error?: { code: string } } }> {
  return adminApi<{ data: T; error?: { code: string } }>(request, method, path, body) as Promise<{ status: number; data: { data: T; error?: { code: string } } }>;
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

/** e2e用: 型を気にせずdata部を参照する簡易アクセサ */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dataOf<T>(res: { data: unknown }): T {
  return (res.data ?? {}) as T;
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

/**
 * UIの書き込み操作を、wrangler dev のProxyWorkerが接続を落としても届くまでやり直す（T085b fix round1）。
 *
 * 背景: wrangler dev（4.150）のProxyWorker→UserWorker接続は、kjのkeep-aliveタイムアウト（約5秒アイドルで
 * プールの両側が同時切断）と重なった要求を落とす（cloudflare/workers-sdk #14926・#15252。workers=2の並行
 * 負荷で顕在化し、M3 run1のissues.spec赤＝この経路）。GETはwrangler側が自動再試行するが、PATCH/POSTは
 * 冪等でないため**再試行されず**、当該要求だけが失敗する（開発サーバー自体は生き続ける）。
 *
 * 対処はアプリの再送設計（docs/05 §2）と同じ: useMutation は同じ内容を同じ Idempotency-Key で再送し、
 * サーバーが1回だけ適用する。そこで**この落下の署名に限って**同じUI操作をやり直す:
 *  - 要求がトランスポート層で失敗した（requestfailed）
 *  - または 5xx 応答の本文が "Network connection lost"（wranglerのproxyが返す落下の署名）
 * それ以外（400/409/422等の製品の応答・署名の違う5xx・応答なし）はやり直さず呼び出し側の断言に任せる
 * ＝失敗を隠さない。署名入り5xxも規定回数続けば最後の応答を返して断言が赤にする
 */
export async function clickUntilWriteArrives(
  page: Page,
  click: () => Promise<unknown>,
  write: { urlIncludes: string; method: "PATCH" | "POST" },
  opts: { attempts?: number; timeoutMs?: number } = {},
): Promise<Response | null> {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  type Outcome = { kind: "responded" | "dropped" | "silent"; response: Response | null };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const responded: Promise<Outcome> = page
      .waitForResponse((r) => r.request().method() === write.method && r.url().includes(write.urlIncludes), { timeout: timeoutMs })
      .then((response): Outcome => ({ kind: "responded", response }))
      .catch((): Outcome => ({ kind: "silent", response: null }));
    const failed: Promise<Outcome> = page
      .waitForEvent("requestfailed", {
        predicate: (r) => r.method() === write.method && r.url().includes(write.urlIncludes),
        timeout: timeoutMs,
      })
      .then((): Outcome => ({ kind: "dropped", response: null }))
      .catch((): Outcome => ({ kind: "silent", response: null }));
    await click();
    const first = await Promise.race([responded, failed]); // 負けた側もcatch済みで放置できる
    if (first.kind === "silent") return null; // 応答も失敗も観測できず（送信すらされていない等）＝断言に任せる
    if (first.kind === "dropped") {
      if (attempt === attempts) return null; // 落下が続く＝回復不能。断言が赤にする
      await page.waitForTimeout(250);
      continue;
    }
    if (first.response!.status() < 500) return first.response; // 製品の応答（成功も4xxも）はそのまま返す
    const body = await first.response!.text().catch(() => "");
    if (!/network connection lost/i.test(body) || attempt === attempts) return first.response; // 署名が違う5xx・使い切り
    await page.waitForTimeout(250); // wrangler proxyの落下署名 → 同じ鍵で同じ操作をやり直す
  }
  return null;
}
