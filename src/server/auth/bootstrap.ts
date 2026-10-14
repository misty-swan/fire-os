import { assertionSql } from "../mutations/assertion";
import type { AppEnv } from "../env";
import { emailHash, tokenHash } from "./config";
import { newInvitationToken } from "./tokens";

/**
 * 初期管理者の作成（docs/07 §2「初期管理者」）。**通常のAPIからは呼ばない**。運用担当が
 * `npm run bootstrap:admin`（scripts/bootstrap-admin.ts）で、環境を明示して一回だけ実行する。
 *
 * やること: 分団・管理者の団員（未リンク）・「bootstrap」種別の招待（役割admin）を作り、一回だけ表示するtokenを返す。
 * 管理者は他の団員と同じ招待受領（登録→API-35）でアカウントを作る。公開の初期登録エンドポイントは無い。
 * 無効化: 分団が一つでもあれば拒否（already_bootstrapped）。招待が未使用のまま失われた場合だけ、
 * 管理者が一人もリンクされていないことを条件に reissue で旧招待を取消して再発行できる。
 */
export interface BootstrapInput {
  unitName: string;
  adminDisplayName: string;
  email: string;
  /** 招待の有効時間（既定72時間） */
  expiresInHours?: number;
  /** 未使用のまま失われた初期招待を再発行する */
  reissue?: boolean;
}
export interface BootstrapResult {
  unitId: string;
  memberId: string;
  /** 生token。この戻り値でしか得られない。ログ・画面・Gitに残さない */
  token: string;
  expiresAt: string;
}
export interface Stmt {
  sql: string;
  binds: unknown[];
}

export class BootstrapError extends Error {
  constructor(public readonly code: "already_bootstrapped" | "nothing_to_reissue" | "admin_already_linked" | "invalid_input") {
    super(code);
  }
}

const NAME = /^[^\u0000-\u001f\u007f]{1,200}$/u;

/** 実行する文の並び（D1 batchまたは wrangler d1 execute のSQLファイル）。assertionで途中の不成立を全体失敗にする */
export async function bootstrapStatements(
  input: BootstrapInput,
  ids: { unitId: string; memberId: string; invitationId: string; mutationId: string; auditId: string; attempt: string },
  now: Date,
  token: string,
): Promise<{ stmts: Stmt[]; expiresAt: string }> {
  const hours = input.expiresInHours ?? 72;
  if (!NAME.test(input.unitName) || !NAME.test(input.adminDisplayName) || !input.email.includes("@") || !(hours >= 1 && hours <= 720)) {
    throw new BootstrapError("invalid_input");
  }
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + hours * 3600_000).toISOString();
  const eh = await emailHash(input.email);
  const th = await tokenHash(token);
  const asrt = (seq: number, exists: string, ...binds: unknown[]): Stmt => ({ sql: assertionSql(exists), binds: [ids.attempt, seq, ...binds] });

  const stmts: Stmt[] = [];
  const insertInvitation = (unitId: string, memberId: string): Stmt => ({
    sql:
      "INSERT INTO invitations (id, unit_id, member_id, kind, email_hash, token_hash, status, expires_at, intended_authz, created_at, updated_at, created_by, actor_kind) " +
      "VALUES (?, ?, ?, 'bootstrap', ?, ?, 'pending', ?, '{\"roleCodes\":[\"admin\"]}', ?, ?, NULL, 'system')",
    binds: [ids.invitationId, unitId, memberId, eh, th, expiresAt, nowIso, nowIso],
  });
  const audit = (unitId: string, memberId: string): Stmt => ({
    sql:
      "INSERT INTO audit_logs (id, unit_id, actor_kind, actor_user_id, action, entity_type, entity_id, mutation_id, occurred_at, metadata_json) " +
      "VALUES (?, ?, 'system', NULL, 'bootstrap.issue', 'invitation', ?, ?, ?, ?)",
    binds: [ids.auditId, unitId, ids.invitationId, ids.mutationId, nowIso, JSON.stringify({ memberId })],
  });

  if (!input.reissue) {
    // 分団が一つも無いときだけ
    stmts.push(asrt(1, "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM units)"));
    stmts.push({
      sql: "INSERT INTO units (id, name, status, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, 'active', ?, ?, NULL, 'system')",
      binds: [ids.unitId, input.unitName, nowIso, nowIso],
    });
    stmts.push({
      sql: "INSERT INTO members (id, unit_id, display_name, status, created_at, updated_at, created_by, actor_kind) VALUES (?, ?, ?, 'active', ?, ?, NULL, 'system')",
      binds: [ids.memberId, ids.unitId, input.adminDisplayName, nowIso, nowIso],
    });
    stmts.push(insertInvitation(ids.unitId, ids.memberId), audit(ids.unitId, ids.memberId));
  } else {
    // 管理者が誰もリンクされておらず、初期招待が未使用で残っているときだけ、旧招待を取消して再発行する
    stmts.push(
      asrt(1, "SELECT 1 FROM invitations WHERE unit_id = ? AND kind = 'bootstrap' AND status = 'pending'", ids.unitId),
      asrt(
        2,
        "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.unit_id = ? AND r.code = 'admin' AND mr.revoked_at IS NULL)",
        ids.unitId,
      ),
      {
        sql:
          "UPDATE invitations SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'reissued', version = version + 1, updated_at = ? " +
          "WHERE unit_id = ? AND kind = 'bootstrap' AND status = 'pending'",
        binds: [nowIso, nowIso, ids.unitId],
      },
      insertInvitation(ids.unitId, ids.memberId),
      audit(ids.unitId, ids.memberId),
    );
  }
  stmts.push({ sql: "DELETE FROM mutation_assertions WHERE attempt_token = ?", binds: [ids.attempt] });
  return { stmts, expiresAt };
}

export async function bootstrapAdmin(env: Pick<AppEnv, "DB">, input: BootstrapInput, now: Date = new Date()): Promise<BootstrapResult> {
  const token = newInvitationToken();
  const ids: { unitId: string; memberId: string; invitationId: string; mutationId: string; auditId: string; attempt: string } = {
    unitId: crypto.randomUUID(), memberId: crypto.randomUUID(), invitationId: crypto.randomUUID(),
    mutationId: crypto.randomUUID(), auditId: crypto.randomUUID(), attempt: crypto.randomUUID(),
  };
  if (input.reissue) {
    const row = await env.DB.prepare(
      "SELECT i.unit_id, i.member_id FROM invitations i WHERE i.kind = 'bootstrap' AND i.status = 'pending'",
    ).first<{ unit_id: string; member_id: string }>();
    if (!row) throw new BootstrapError("nothing_to_reissue");
    ids.unitId = row.unit_id;
    ids.memberId = row.member_id;
  }
  const { stmts, expiresAt } = await bootstrapStatements(input, ids, now, token);
  try {
    await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.binds)));
  } catch (err) {
    // 事前条件(assertion)の不成立。原因は事後の状態から判別する（エラー文から推測しない）
    const units = await env.DB.prepare("SELECT count(*) AS n FROM units").first<{ n: number }>();
    if (input.reissue) {
      const admin = await env.DB.prepare(
        "SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE r.code = 'admin' AND mr.revoked_at IS NULL",
      ).first();
      throw new BootstrapError(admin ? "admin_already_linked" : "nothing_to_reissue");
    }
    if ((units?.n ?? 0) > 0) throw new BootstrapError("already_bootstrapped");
    throw err;
  }
  return { unitId: ids.unitId, memberId: ids.memberId, token, expiresAt };
}
