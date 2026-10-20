/**
 * 認証イベントの監査記録（PH1-A2・T086。docs/evidence/ph1-review.md A「認証イベントが監査に残らない」）。
 *
 * T014の監査設計に従う:
 * - audit_logsは追記専用（トリガーでUPDATE/DELETE/上書きINSERTを拒否。監査APIに更新/削除の経路は無い）
 * - **本文を複製しない**: metadataに入れるのは結果と理由コード（CODE_LIKE）だけ。メールアドレス（PII）も
 *   パスワード・再設定token・TOTPの秘密・セッションtokenも監査に載せない（docs/07 §9「PII本文はマスク」）
 * - 帰属先は業務側の users→members→units。監査行はunit_idが必須（FK）のため、**unitに帰属できない試行
 *   （未登録メール・招待を受領する前のsign-up）は書かない**——その防御は認証経路のIP単位の回数制限
 *   （config.tsのrateLimit＋src/server/security/limits.ts）が担う。監査は「誰の口で何が起きたか」の追跡
 *
 * 書き込みは認証ライブラリ(Better Auth)のhooks.after/onPasswordResetから行う。監査の失敗でログインを
 * 壊さないよう例外は飲み込んでconsole.errorだけ出す（監査は追記の事実の記録であり、認証の成否の正本は
 * 認証ライブラリの表。ここが失敗しても認証・業務の状態は変わらない）。
 */

/** 監査のmetadataに入れてよい値の形（executeMutationのCODE_LIKEと同じ規則。本文・氏名を入れない） */
const CODE_LIKE = /^[A-Za-z0-9_.:-]{0,100}$/;

export interface AuthAuditInput {
  /** 認証identity（auth_users.id）。セッション文脈のイベントはこちら */
  authId?: string;
  /** サインイン等、メールで指定される経路のイベントはこちら（照合だけに使い監査には載せない） */
  email?: string;
  action: "auth.sign_in" | "auth.two_factor.setup_started" | "auth.two_factor.enabled" | "auth.two_factor.backup_codes_regenerated" | "auth.password_reset_requested" | "auth.password_reset_completed";
  /** 成功/失敗の区別（成功イベントの既定は "success"） */
  result: "success" | "failure" | "two_factor_required";
  /** 失敗の理由コード（認証ライブラリのerrorCode。例: INVALID_EMAIL_OR_PASSWORD / ACCOUNT_DISABLED） */
  reason?: string;
  /** サインイン確定に使った第二要素（verify-totp / verify-backup-code のサインイン経路） */
  secondFactor?: "totp" | "backup_code";
}

const clean = (v: string | undefined): string | undefined =>
  typeof v === "string" && CODE_LIKE.test(v) && v.length > 0 ? v.slice(0, 100) : undefined;

/** auth_users.id をEmail（正規化済みの比較）から引く。見つからなければnull（書かない） */
async function authIdByEmail(db: D1Database, email: string): Promise<string | null> {
  const row = await db.prepare("SELECT id FROM auth_users WHERE email = ?").bind(email).first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * 認証イベントを1行audit_logsへ書く。unitに帰属できない（業務usersと結びついていない）なら何もしない。
 * 呼び出し側はawaitしてよい（認証ライブラリのafter hook内。応答確定前に書き終わる）。
 */
export async function recordAuthAudit(db: D1Database, input: AuthAuditInput): Promise<void> {
  try {
    const authId = input.authId ?? (input.email !== undefined ? await authIdByEmail(db, input.email) : null);
    if (!authId) return;
    // 業務側の所属（users→members→units。1 user = 1 団員。members.user_id UNIQUE）
    const linked = await db
      .prepare(
        "SELECT u.id AS user_id, m.unit_id FROM users u JOIN members m ON m.user_id = u.id WHERE u.auth_id = ?",
      )
      .bind(authId)
      .first<{ user_id: string; unit_id: string }>();
    if (!linked) return; // 招待を受領する前（users行と未結合）はunit帰属が無いため書かない

    const metadata: Record<string, string> = { result: input.result };
    const reason = clean(input.reason);
    const secondFactor = clean(input.secondFactor);
    if (reason) metadata.reason = reason;
    if (secondFactor) metadata.secondFactor = secondFactor;

    await db
      .prepare(
        "INSERT INTO audit_logs (id, unit_id, actor_kind, actor_user_id, action, entity_type, entity_id, mutation_id, occurred_at, metadata_json) " +
          "VALUES (?, ?, 'human', ?, ?, 'user', ?, ?, ?, ?)",
      )
      .bind(
        crypto.randomUUID(), linked.unit_id, linked.user_id, input.action, linked.user_id,
        crypto.randomUUID(), new Date().toISOString(), JSON.stringify(metadata),
      )
      .run();
  } catch (err) {
    // 監査の失敗で認証を壊さない（冒頭の注記）。欠落はログから検出できる
    console.error(JSON.stringify({ audit: "auth", action: input.action, error: String(err) }));
  }
}

/** 認証ライブラリのエラー（APIError）から理由コードを取り出す（無い/長い場合はstatus文字列にfall back） */
export function authErrorCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const body = (err as { body?: { code?: unknown } }).body;
  if (typeof body?.code === "string" && CODE_LIKE.test(body.code)) return body.code;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "string" && CODE_LIKE.test(status)) return status;
  return undefined;
}
