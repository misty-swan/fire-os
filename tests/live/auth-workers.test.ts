import { describe, expect, it } from "vitest";

/**
 * T007 / V01: 実Workers（staging または demo）に配置した認証の確認。
 * 局所の workerd 試験（tests/auth-adapter.test.ts）の代わりにはならない。環境が無ければ「未実施」として失敗する
 * （スキップして完了扱いにしない）。手順は docs/evidence/V01-auth.md。
 *
 * 必要な環境変数:
 *   LIVE_BASE_URL          配置したWorkerのhttps URL（AUTH_BASE_URLと同じorigin）
 *   LIVE_BOOTSTRAP_EMAIL   初期管理者の招待先メール（scripts/bootstrap-admin.ts に渡した値）
 *   LIVE_BOOTSTRAP_TOKEN   同CLIが一度だけ表示した招待token
 */
const base = process.env.LIVE_BASE_URL;
const email = process.env.LIVE_BOOTSTRAP_EMAIL;
const token = process.env.LIVE_BOOTSTRAP_TOKEN;
const password = process.env.LIVE_PASSWORD ?? `live-${crypto.randomUUID()}-Aa1`;

function requireLive() {
  if (!base || !email || !token) {
    throw new Error(
      "実Cloudflareの環境が未設定のため、この試験は未実施です。LIVE_BASE_URL / LIVE_BOOTSTRAP_EMAIL / LIVE_BOOTSTRAP_TOKEN を設定してください（docs/evidence/V01-auth.md）",
    );
  }
  if (!base.startsWith("https://")) throw new Error("LIVE_BASE_URL は https である必要があります");
  return { base, email, token };
}

describe("実Workers上の認証 (V01)", () => {
  it("auth_works_on_real_workers_without_public_signup", async () => {
    const live = requireLive();
    const origin = new URL(live.base).origin;
    const post = (path: string, body: unknown, headers: Record<string, string> = {}, cookie = "") =>
      fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}), ...headers },
        body: JSON.stringify(body),
        redirect: "manual",
      });

    // 自由登録は閉じている
    const free = await post("/api/auth/sign-up/email", { email: `free-${crypto.randomUUID()}@example.test`, password, name: "x" });
    expect(free.status).toBe(403);

    // 招待tokenでの登録（実Cookie属性を確認）
    const t0 = Date.now();
    const signUp = await post("/api/auth/sign-up/email", { email: live.email, password, name: "団員" }, { "x-invitation-token": live.token });
    const signUpMs = Date.now() - t0;
    expect(signUp.status).toBe(200);
    const setCookie = signUp.headers.getSetCookie().join("\n");
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    const cookie = signUp.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

    // 他originからの変更は拒否
    const evil = await post("/api/auth/sign-out", {}, { origin: "https://evil.example" }, cookie);
    expect(evil.status).toBe(403);

    // ログアウト後はセッションが無い
    const t1 = Date.now();
    const login = await post("/api/auth/sign-in/email", { email: live.email, password });
    const loginMs = Date.now() - t1;
    expect(login.status).toBe(200);
    const c2 = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect((await post("/api/auth/sign-out", {}, {}, c2)).status).toBe(200);
    const after = await fetch(`${origin}/api/auth/get-session`, { headers: { cookie: c2 } });
    expect(await after.json()).toBeNull();

    // 値は証跡へ転記する（CPU時間そのものは Workers のメトリクス/tail で別途確認する）
    console.log(JSON.stringify({ v01: "実Workersの壁時計(ms)", signUpMs, loginMs }));
  });
});
