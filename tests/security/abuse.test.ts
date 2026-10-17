import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/index";
import type { SecurityPolicy } from "../../src/server/security/limits";
import { GOOD_PASSWORD, INVITATION_HEADER, seedInvitation, uniqueEmail, workerBrowser } from "../helpers/auth";
import { secretFromUri, totpCode } from "../helpers/totp";
import { createFixture, type TestFixture } from "../helpers/fixture";

/**
 * 濫用への耐性（T081、docs/07 §2「レート上限案はIP＋user単位」「再設定/MFA…レート制限」、docs/05 §1の429行）。
 *
 * - **厳しいpolicyの注入でだけ429を観測する**（既定policyは寛容な開発設定で、既存の試験・e2eを壊さない。
 *   controller裁定2）。createAppのsecurityPolicy引数はroutesの登録前に効く（Honoは登録順に照合するため、
 *   routesの後からのapplySecurityでは既存routeの前に挟まらない）。
 * - 429は共通エラーenvelope（code=RATE_LIMITED）＋Retry-After。docs/05 §1の429行のとおり。
 * - バケットは auth / ai / search / upload / default の5系（limits.tsの台帳からの分類）。
 *   1つのバケットを使い切っても他のバケットとdefaultは止まらない（隔離）。
 * - 認証・招待・MFAの総当たりは、存在の有無を応答で区別できず、失敗の繰り返しで対象を壊さない。
 */

let fx: TestFixture;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  fx = await createFixture("two-units");
});

const STRICT: SecurityPolicy = {
  rateLimit: {
    auth: { requests: 3, windowMs: 60_000 },
    ai: { requests: 3, windowMs: 60_000 },
    search: { requests: 3, windowMs: 60_000 },
    upload: { requests: 3, windowMs: 60_000 },
    default: { requests: 3, windowMs: 60_000 },
  },
};

const jsonOf = async (res: Response): Promise<{ error?: { code: string }; data?: unknown }> => {
  try {
    return (await res.json()) as { error?: { code: string } };
  } catch {
    return {};
  }
};

describe("T081 濫用（連続要求・総当たり）", () => {
  it("strict_policy_limits_each_bucket_isolates_them_and_returns_429_with_retry_after", async () => {
    const app = createApp(env, STRICT);
    const send = (req: Request) => app.fetch(req, env);
    const jsonReq = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      new Request(`http://example.com${path}`, {
        method,
        headers: { "content-type": "application/json", origin: "http://example.com", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    // --- search バケット（API-76。{}は検証で拒否されるが、要求はバケットに計上される） ---
    for (let i = 0; i < 3; i++) {
      const res = await send(jsonReq("POST", "/api/v1/search/rag", {}));
      expect(res.status).not.toBe(429);
    }
    const searchLimited = await send(jsonReq("POST", "/api/v1/search/rag", {}));
    expect(searchLimited.status).toBe(429);
    expect((await jsonOf(searchLimited)).error?.code).toBe("RATE_LIMITED");
    expect(searchLimited.headers.get("retry-after")).toBeTruthy();
    const nosniff = searchLimited.headers.get("x-content-type-options");
    expect(nosniff).toBe("nosniff"); // 429の応答にも共通headersが付く

    // --- upload バケット（API-83。未認証は401で拒否されるが、要求は計上される） ---
    const uploadReq = () => jsonReq("PUT", `/api/v1/attachments/${crypto.randomUUID()}/upload`, undefined, { "x-upload-token": "abuse-probe" });
    for (let i = 0; i < 3; i++) expect((await send(uploadReq())).status).not.toBe(429);
    const uploadLimited = await send(uploadReq());
    expect(uploadLimited.status).toBe(429);

    // --- ai バケット（API-29。同上） ---
    const aiReq = () => jsonReq("POST", "/api/v1/ai/classifications", {});
    for (let i = 0; i < 3; i++) expect((await send(aiReq())).status).not.toBe(429);
    const aiLimited = await send(aiReq());
    expect(aiLimited.status).toBe(429);

    // --- auth バケット（資格情報を受ける経路。ライブラリのD1上限より前に、この層が429を返す） ---
    const authReq = () => jsonReq("POST", "/api/auth/sign-in/email", { email: uniqueEmail("abuse"), password: "wrong-password-1" });
    for (let i = 0; i < 3; i++) expect((await send(authReq())).status).not.toBe(429);
    const authLimited = await send(authReq());
    expect(authLimited.status).toBe(429);
    expect((await jsonOf(authLimited)).error?.code).toBe("RATE_LIMITED");

    // --- 隔離: 高価な4バケットを使い切っても、default（業務API）は止まらない ---
    const me = await send(jsonReq("GET", "/api/v1/me", undefined, { "x-test-identity": JSON.stringify(fx.units.a.people.admin) }));
    expect(me.status).toBe(200);
  });

  it("default_policy_is_generous_for_normal_use_and_does_not_trip_429", async () => {
    // 既定policy（本番の接続と同じ寛容な開発設定）で、通常の画面が一度に出すより多い要求を連続で出す
    for (let i = 0; i < 40; i++) {
      const res = await fx.client(fx.units.a.people.admin).request("GET", "/api/v1/me");
      expect(res.status, ` ${i + 1}件目で429/エラー`).toBe(200);
    }
    // 高価な系列も、人が出し得る回数では止まらない
    for (let i = 0; i < 10; i++) {
      const res = await fx.client(fx.units.a.people.member).request("GET", "/api/v1/announcements");
      expect(res.status).toBe(200);
    }
  });

  it("credential_recovery_invitation_and_mfa_abuse_is_uniform_and_breaks_nothing", async () => {
    // --- パスワード再設定: 登録の有無を応答で区別できない（8件とも同じstatus。docs/07 §2） ---
    const resetStatuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const b = await workerBrowser();
      resetStatuses.push((await b.json("POST", "/api/auth/request-password-reset", { email: uniqueEmail("reset") })).status);
    }
    expect(new Set(resetStatuses).size).toBe(1);
    expect(resetStatuses[0]).toBeLessThan(300); // 存在しないメールでも同じ成功応答

    // --- パスワード総当たり: 失敗は同じ応答で返り、正しい資格情報は仍う使える ---
    const email = uniqueEmail("brute");
    const inviteToken = await seedInvitation({ unitId: fx.units.a.id, memberId: fx.units.a.people.unlinked.memberId!, email, createdBy: null });
    const opener = await workerBrowser();
    expect((await opener.json("POST", "/api/auth/sign-up/email", { email, password: GOOD_PASSWORD, name: "架空" }, { [INVITATION_HEADER]: inviteToken })).status).toBe(200);
    const attacker = await workerBrowser();
    const wrongStatuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      wrongStatuses.push((await attacker.json("POST", "/api/auth/sign-in/email", { email, password: `wrong-${i}-xxxxxxxx` })).status);
    }
    expect(new Set(wrongStatuses).size).toBe(1); // 失敗の応答は揃っている
    const victim = await workerBrowser();
    expect((await victim.json("POST", "/api/auth/sign-in/email", { email, password: GOOD_PASSWORD })).status).toBe(200);

    // --- 招待tokenの総当たり: 誤tokenは403で、招待は消費されず、正しいtokenは仍う使える ---
    const target = fx.units.b.people.unlinked;
    const inviteEmail = uniqueEmail("invite");
    const token = await seedInvitation({ unitId: target.unitId, memberId: target.memberId!, email: inviteEmail, createdBy: null });
    for (let i = 0; i < 6; i++) {
      const b = await workerBrowser();
      const wrong = await b.json("POST", "/api/auth/sign-up/email", { email: inviteEmail, password: GOOD_PASSWORD, name: "架空" }, { [INVITATION_HEADER]: crypto.randomUUID().replaceAll("-", "") });
      expect(wrong.status).toBe(403);
    }
    const pendingCount = (await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM invitations WHERE member_id = ? AND status = 'pending'",
    ).bind(target.memberId!).first<{ n: number }>())!.n;
    expect(pendingCount).toBe(1); // 総当たりで消費・無効化されていない
    const winner = await workerBrowser();
    expect((await winner.json("POST", "/api/auth/sign-up/email", { email: inviteEmail, password: GOOD_PASSWORD, name: "架空" }, { [INVITATION_HEADER]: token })).status).toBe(200);

    // --- TOTPの総当たり: 誤codeは一様に401（正しい利用者は締め出されない）、
    //     続く総当たりはライブラリ自身のD1上限（verify-totp 5回/分/IP。docs/07 §2）で429になる ---
    const b = await workerBrowser();
    const mfaEmail = uniqueEmail("mfa");
    const mfaToken = await seedInvitation({ unitId: fx.units.a.id, memberId: fx.units.a.people.unlinked.memberId!, email: mfaEmail, createdBy: null });
    expect((await b.json("POST", "/api/auth/sign-up/email", { email: mfaEmail, password: GOOD_PASSWORD, name: "架空" }, { [INVITATION_HEADER]: mfaToken })).status).toBe(200);
    const enable = await b.json<{ totpURI: string }>("POST", "/api/auth/two-factor/enable", { password: GOOD_PASSWORD });
    expect(enable.status).toBe(200);
    const secret = secretFromUri(enable.data.totpURI);
    const wrongCodes: number[] = [];
    for (let i = 0; i < 4; i++) {
      wrongCodes.push((await b.json("POST", "/api/auth/two-factor/verify-totp", { code: String(100000 + i) })).status);
    }
    expect(wrongCodes.join(","), "TOTP誤codeの応答一覧").toBe("401,401,401,401");
    expect((await b.json("POST", "/api/auth/two-factor/verify-totp", { code: await totpCode(secret) })).status).toBe(200); // 5回目（上限内）で正しいcodeは通る
    // セッション無しの総当たりは、同じ経路の上限（5回/分/IP）で6回目に429になる
    const brute = await workerBrowser();
    const unauthCodes: number[] = [];
    for (let i = 0; i < 6; i++) {
      unauthCodes.push((await brute.json("POST", "/api/auth/two-factor/verify-totp", { code: String(200000 + i) })).status);
    }
    expect(unauthCodes.slice(0, 5).every((s) => s === 400 || s === 401), `前5回は一様に拒否: ${unauthCodes.join(",")}`).toBe(true);
    expect(unauthCodes[5], `6回目はライブラリの上限: ${unauthCodes.join(",")}`).toBe(429);
  });
});
