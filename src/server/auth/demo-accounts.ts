import { hashPassword } from "better-auth/crypto";
import type { Stmt } from "./bootstrap";

/**
 * 体験アカウント3本（営業デモTask4）。販売デモで手を動かしてもらうための、固定資格情報・パスワードだけの
 * ログイン（MFAなし）アカウントをseedに作らせるための文生成（純関数）。
 *
 * - 3件固定（demo-admin@ / demo-officer@ / demo-member@ + example.testドメイン）。氏名はfixtures作法どおり
 *   「架空」付き（detectRealPersonalData・実データ混入の入口を作らない）。業務users→members→member_rolesと
 *   認証identity（auth_users/auth_accounts）と監査を1つの文並びで作る（bootstrap.tsのStmtと同じ形）。
 * - パスワードのhashは **better-auth自身のhashPassword**（better-auth/crypto。ログインのverifyPasswordと
 *   同一実装）を使う。手書きの暗号形式は作らない——一致は tests/demo-accounts.test.ts が実際のログインAPIで
 *   機械保証する。値はsourceに書かず、seed実行時に生成して標準出力へ一度だけ表示する（scripts/seed-demo.ts）。
 * - **認可規則は変えない**: 二要素は未有効（two_factor_enabled=0・auth_two_factorsも作らない）のままなので、
 *   admin体験アカウントでもPER-06/07/08の管理操作は `mfa_required` で拒否される（src/server/auth/authorize.ts）。
 *   解除経路は公開しないため、この状態は後から変わらない。
 */

export interface DemoCredential {
  email: string;
  password: string;
  memberName: string;
  role: "admin" | "officer" | "member";
}

/** 体験アカウントのメールdomain（架空検査のFICTIONAL_EMAIL_DOMAINS準拠。実在の配送先になり得ない予約域） */
export const DEMO_ACCOUNT_DOMAIN = "example.test";

const U = "00000000-0000-4000-8000-";

export interface DemoAccount {
  role: "admin" | "officer" | "member";
  email: string;
  /** 名簿の氏名（fixtures作法の「架空」付き。既存seedの架空団員と重複しない） */
  memberName: string;
  rank: string;
  /** 固定ID（auth_users / 業務users / members）。seedの架空データと同じ発番様式（scripts/seed-demo.ts） */
  ids: { authUser: string; user: string; member: string };
}

/** 3役割の体験アカウント（正本。seedも試験もこの定義を使う） */
export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    role: "admin",
    email: "demo-admin@example.test",
    memberName: "架空 体験管理者",
    rank: "分団長",
    ids: { authUser: `${U}000000de0015`, user: `${U}000000de0016`, member: `${U}000000de0017` },
  },
  {
    role: "officer",
    email: "demo-officer@example.test",
    memberName: "架空 体験幹部",
    rank: "副分団長",
    ids: { authUser: `${U}000000de0018`, user: `${U}000000de0019`, member: `${U}000000de001a` },
  },
  {
    role: "member",
    email: "demo-member@example.test",
    memberName: "架空 体験団員",
    rank: "団員",
    ids: { authUser: `${U}000000de001b`, user: `${U}000000de001c`, member: `${U}000000de001d` },
  },
];

/** パスワードの文字種（紛らわしい字 0/O/1/l/I と記号を除く。口頭で伝えられる資格情報にする） */
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * seed実行時に一度だけ使うパスワードを生成する（16文字以上・[crypto.getRandomValues]の棄却采样で一様）。
 * 生成した値を保存するのは利用者（ops/demo-deploy.md §「体験アカウント」。Git管理外の .env.demo-login 等）。
 */
export function generateDemoPassword(length = 20): string {
  if (length < 16 || length > 128) throw new Error("demo-accounts: パスワード長は16〜128で指定してください");
  const alphabet = PASSWORD_ALPHABET.length;
  // 棄却采样（modulo biasを除く。2^32はalphabetで割り切れないため上限未満の出目だけ使う）
  const limit = Math.floor(0x1_0000_0000 / alphabet) * alphabet;
  const buf = new Uint32Array(1);
  const chars: string[] = [];
  for (let i = 0; i < length; i++) {
    do {
      crypto.getRandomValues(buf);
    } while (buf[0]! >= limit);
    chars.push(PASSWORD_ALPHABET[buf[0]! % alphabet]!);
  }
  return chars.join("");
}

/**
 * 体験アカウントを作る文の並び（D1 batch、または wrangler d1 execute のSQLファイル）。
 * アカウント1件につき auth_users → auth_accounts → users → members → member_roles → audit_logs の6文。
 * 文はunitが既に在ることだけを仮定し、自分の内側で作った行だけで完結する（試験とCLIで同じ適用順）。
 */
export async function demoAccountStatements(input: { unitId: string; now: Date; credentials: DemoCredential[] }): Promise<Stmt[]> {
  const nowIso = input.now.toISOString();
  const mutationId = crypto.randomUUID(); // 1回の適用＝1 mutation（batch全体で1トランザクション）
  const stmts: Stmt[] = [];
  for (const c of input.credentials) {
    const account = DEMO_ACCOUNTS.find((a) => a.email === c.email);
    if (!account) throw new Error(`demo-accounts: 未定義のメールは作れない (${c.email})`);
    if (!c.email.endsWith(`@${DEMO_ACCOUNT_DOMAIN}`) || c.email !== c.email.trim().toLowerCase()) {
      throw new Error(`demo-accounts: メールは架空domain（@${DEMO_ACCOUNT_DOMAIN}）の小文字で指定してください (${c.email})`);
    }
    if (c.password.length < 12 || c.password.length > 128) {
      throw new Error("demo-accounts: パスワードは12〜128文字で指定してください（better-authの下限）");
    }
    if (!c.memberName.includes("架空")) throw new Error("demo-accounts: 氏名はfixtures作法どおり「架空」を含めてください");
    // better-auth自身のhashPassword（ログインのverifyPasswordと同一実装。@better-auth/utils/password の scrypt N=16384,r=16,p=1）
    const passwordHash = await hashPassword(c.password);

    // --- 認証identity。二要素は未有効で作る（PER-06/07/08の二要素必須は変えない。auth_two_factorsは作らない） ---
    stmts.push({
      sql: "INSERT INTO auth_users (id, name, email, email_verified, created_at, updated_at, two_factor_enabled) VALUES (?, ?, ?, 1, ?, ?, 0)",
      binds: [account.ids.authUser, c.memberName, c.email, nowIso, nowIso],
    });
    // credentialのaccount（登録経路と同じ形: account_id = auth_users.id・passwordにhash）
    stmts.push({
      sql: "INSERT INTO auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) VALUES (?, ?, 'credential', ?, ?, ?, ?)",
      binds: [crypto.randomUUID(), account.ids.authUser, account.ids.authUser, passwordHash, nowIso, nowIso],
    });
    // --- 業務側。users（auth_idでidentityと結合。resolvePrincipalが毎要求読む）→ 名簿 → 役割 ---
    stmts.push({
      sql: "INSERT INTO users (id, auth_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
      binds: [account.ids.user, account.ids.authUser, nowIso, nowIso],
    });
    stmts.push({
      sql: "INSERT INTO members (id, unit_id, user_id, display_name, rank, status, created_at, updated_at, actor_kind) " +
        "VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 'system')",
      binds: [account.ids.member, input.unitId, account.ids.user, c.memberName, account.rank, nowIso, nowIso],
    });
    // 役割はroles表の実IDで付く（migration固定のcode→idをサブクエリで解決し、IDの二重管理を避ける）。
    // granted_byはNOT NULLのため自分の業務userを指す（実際の付与主体はsystem＝seed。created_byとは違い監査の本体は下の監査行）
    stmts.push({
      sql: "INSERT INTO member_roles (id, unit_id, member_id, role_id, granted_by, created_at, updated_at, actor_kind) " +
        "VALUES (?, ?, ?, (SELECT id FROM roles WHERE code = ?), ?, ?, ?, 'system')",
      binds: [crypto.randomUUID(), input.unitId, account.ids.member, c.role, account.ids.user, nowIso, nowIso],
    });
    // --- 監査（system主体・bootstrap.issueと同じ形。メール・パスワードは載せない: docs/07 §9「PII本文はマスク」） ---
    stmts.push({
      sql: "INSERT INTO audit_logs (id, unit_id, actor_kind, actor_user_id, action, entity_type, entity_id, mutation_id, occurred_at, metadata_json) " +
        "VALUES (?, ?, 'system', NULL, 'demo.account_created', 'member', ?, ?, ?, ?)",
      binds: [
        crypto.randomUUID(), input.unitId, account.ids.member, mutationId, nowIso,
        JSON.stringify({ memberId: account.ids.member, role: c.role }),
      ],
    });
  }
  return stmts;
}
