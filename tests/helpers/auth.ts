import { env } from "cloudflare:workers";
import { createAuthService, type AuthService } from "../../src/server/auth/adapter";
import { INVITATION_HEADER, emailHash, tokenHash, type ResetMessage } from "../../src/server/auth/config";
import { createRuntime } from "./runtime";

export const BASE = "http://example.com";
/** 回数制限はIP単位。試験ごとに別のIPを名乗り、互いの回数を食い合わないようにする */
const randomIp = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

/** 実ブラウザのように Cookie を持ち回り、同じoriginからの要求として Origin を付ける試験用クライアント */
export class Browser {
  /** loginAs が設定する：この端末のログイン情報（試験用） */
  email = "";
  authId = "";
  private jar = new Map<string, string>();
  constructor(
    private readonly send: (req: Request) => Promise<Response>,
    private readonly ip: string = randomIp(),
  ) {}

  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  hasCookie(name: string): boolean {
    return [...this.jar.keys()].some((k) => k.includes(name));
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const h: Record<string, string> = { origin: BASE, ...headers };
    if (body !== undefined) h["content-type"] = "application/json";
    const cookie = this.cookieHeader();
    if (cookie) h.cookie = cookie;
    h["cf-connecting-ip"] = this.ip;
    const res = await this.send(new Request(`${BASE}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
      if (expired) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return res;
  }
  json = async <T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    const res = await this.request(method, path, body, headers);
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data: data as T, res };
  };
}

/** 本物のWorker(Hono)経由で話すブラウザ */
export async function workerBrowser(ip?: string): Promise<Browser> {
  const rt = await createRuntime();
  return new Browser((r) => rt.fetch(r), ip);
}

/** 認証ライブラリを直接呼ぶ（配送の捕捉など、Workerに差し込めない依存を差し替えたいとき）。D1は同じ実体 */
export function directAuth(captured: ResetMessage[] = []): { service: AuthService; captured: ResetMessage[] } {
  const service = createAuthService(env, { deliverReset: async (m) => void captured.push(m) });
  return { service, captured };
}
export async function directBrowser(service: AuthService, ip?: string): Promise<Browser> {
  return new Browser((r) => service.handle(r), ip);
}

/** 招待を直接DBへ作る（API-33が無い段階の試験・架空データ用）。生tokenを返す */
export async function seedInvitation(opts: {
  unitId: string;
  memberId: string;
  email: string;
  createdBy: string | null;
  kind?: "invite" | "bootstrap";
  roleCodes?: string[];
  expiresAt?: string;
  status?: "pending" | "cancelled";
}): Promise<string> {
  const raw = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const now = "2026-10-13T00:00:00.000Z";
  // 一人に有効な招待は1件まで。試験で同じ団員へ何度も作れるよう、旧い有効な招待は取消しておく
  await env.DB.prepare("UPDATE invitations SET status = 'cancelled', cancelled_at = ? WHERE member_id = ? AND status = 'pending'").bind(now, opts.memberId).run();
  await env.DB.prepare(
    "INSERT INTO invitations (id, unit_id, member_id, kind, email_hash, token_hash, status, expires_at, cancelled_at, intended_authz, created_at, updated_at, created_by, actor_kind) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      crypto.randomUUID(), opts.unitId, opts.memberId, opts.kind ?? "invite", await emailHash(opts.email), await tokenHash(raw),
      opts.status ?? "pending", opts.expiresAt ?? "2099-01-01T00:00:00.000Z", opts.status === "cancelled" ? now : null,
      JSON.stringify({ roleCodes: opts.roleCodes ?? ["member"] }), now, now, opts.createdBy, opts.createdBy ? "human" : "system",
    )
    .run();
  return raw;
}

export { INVITATION_HEADER };
export const uniqueEmail = (label = "u") => `${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;
export const GOOD_PASSWORD = "correct-horse-battery-1";

/**
 * 架空の団員(fixture)に「実セッション」を持たせる。招待→登録の本物の経路で認証identityを作り、その authId を
 * 業務 users.auth_id に結びつけて、ログイン済みのブラウザ(Cookie付き)を返す。x-test-identity は使わない。
 * mfa:true は認証側の two_factor_enabled を直接立てる近道（TOTPそのものは auth-adapter 試験で確認済み）。
 */
export async function loginAs(identity: { userId: string; unitId: string }, opts: { mfa?: boolean } = {}): Promise<Browser> {
  const spare = await env.DB.prepare("SELECT id FROM members WHERE unit_id = ? AND user_id IS NULL LIMIT 1").bind(identity.unitId).first<{ id: string }>();
  if (!spare) throw new Error("未リンクの団員がいません");
  const email = uniqueEmail("login");
  const token = await seedInvitation({ unitId: identity.unitId, memberId: spare.id, email, createdBy: null });
  const b = await workerBrowser();
  const up = await b.json<{ user: { id: string } }>("POST", "/api/auth/sign-up/email", { email, password: GOOD_PASSWORD, name: "団員" }, { [INVITATION_HEADER]: token });
  if (up.status !== 200) throw new Error(`loginAs: sign-up失敗 ${up.status}`);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET auth_id = ? WHERE id = ?").bind(up.data.user.id, identity.userId),
    env.DB.prepare("UPDATE invitations SET status = 'cancelled', cancelled_at = ? WHERE member_id = ? AND status = 'pending'").bind("2026-10-13T00:00:00.000Z", spare.id),
    env.DB.prepare("UPDATE auth_users SET two_factor_enabled = ? WHERE id = ?").bind(opts.mfa ? 1 : 0, up.data.user.id),
  ]);
  b.email = email;
  b.authId = up.data.user.id;
  return b;
}

/** 同じ利用者の別の端末でパスワードログインする（loginAs の資格情報） */
export async function signInAnotherDevice(first: Browser): Promise<Browser> {
  const b = await workerBrowser();
  const r = await b.json("POST", "/api/auth/sign-in/email", { email: first.email, password: GOOD_PASSWORD });
  if (r.status !== 200) throw new Error(`別端末のログイン失敗 ${r.status}`);
  return b;
}
