import { Member } from "../../shared/contracts/auth";
import { HttpError, type ApiContext } from "../http";
import { registerJobHandler } from "../jobs/runner";
import { enqueueJobStatement } from "../jobs/store";
import { executeMutation } from "../mutations/execute";
import { authServiceFor } from "./adapter";
import type { AuthzPrincipal } from "./principal";
import { testIdentityAllowed } from "./principal";

/** 認証側の全セッション失効を再試行するjobの種類（永続ジョブ、docs/02 §5） */
export const REVOKE_JOB_KIND = "auth.revoke_sessions";

export const MEMBER_JSON =
  "SELECT json_object('id', id, 'version', version, 'displayName', display_name, 'rank', rank, 'squad', squad, " +
  "'qualifications', json(qualifications), 'joinedOn', CASE WHEN joined_at IS NULL THEN NULL ELSE substr(joined_at, 1, 10) END, " +
  "'status', status, 'hasAccount', json(CASE WHEN user_id IS NULL THEN 'false' ELSE 'true' END)) FROM members WHERE id = ?";

/** 「この団員を外しても、有効な管理者が他にいる」か、「この団員は管理者ではない」ことの検査（最後の管理者を守る） */
export const NOT_LAST_ADMIN_SQL =
  "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.member_id = ? AND mr.revoked_at IS NULL AND r.code = 'admin') " +
  "OR EXISTS (SELECT 1 FROM member_roles mr JOIN roles r ON r.id = mr.role_id JOIN members m ON m.id = mr.member_id JOIN users u ON u.id = m.user_id " +
  "WHERE mr.unit_id = ? AND mr.revoked_at IS NULL AND r.code = 'admin' AND m.id <> ? AND m.status = 'active' AND u.status = 'active')";
export const notLastAdmin = (unitId: string, memberId: string) => ({
  existsSql: NOT_LAST_ADMIN_SQL,
  binds: [memberId, unitId, memberId],
  failCode: "INVALID_TRANSITION" as const,
});
/** 事前の読取で理由(last_admin)つきの422にするための確認。確定の検査はbatch内の notLastAdmin */
export async function wouldRemoveLastAdmin(c: ApiContext, unitId: string, memberId: string): Promise<boolean> {
  const ok = await c.env.DB.prepare(NOT_LAST_ADMIN_SQL).bind(memberId, unitId, memberId).first();
  return ok === null;
}

/** 試験専用：認証ライブラリの失効に障害を注入する（local かつ TEST_AUTH=1 のときだけ有効） */
const faultRequested = (c: ApiContext) => testIdentityAllowed(c) && c.req.header("x-test-fault") === "revoke-all";

/**
 * 認証側の全セッションを今すぐ失効させる試み。成功したら再試行jobも完了にして取り残さない。
 * 失敗しても例外にしない：業務側は先にcommit済みで（認可版の増分・停止）、以後の業務要求は認証セッションに関係なく拒否される。
 * 失敗した分は永続job（Cron/Queue）が再試行する。
 */
export async function revokeSessionsNow(c: ApiContext, authId: string, userId: string, authz: number): Promise<"completed" | "pending"> {
  try {
    if (faultRequested(c)) throw new Error("injected revoke failure");
    await authServiceFor(c.env).revokeAll(authId);
    await c.env.DB.prepare("UPDATE jobs SET status = 'succeeded', updated_at = ? WHERE kind = ? AND source_id = ? AND source_version = ? AND status = 'queued'")
      .bind(new Date().toISOString(), REVOKE_JOB_KIND, userId, authz).run();
    return "completed";
  } catch (err) {
    console.error(JSON.stringify({ event: "session_revoke_failed", error: String(err) }));
    return "pending";
  }
}

/** 失効の再試行jobの状態（応答の sessionRevocation 用） */
export async function revocationState(c: ApiContext, userId: string, authz: number): Promise<"completed" | "pending"> {
  const row = await c.env.DB.prepare("SELECT status FROM jobs WHERE kind = ? AND source_id = ? AND source_version = ?")
    .bind(REVOKE_JOB_KIND, userId, authz).first<{ status: string }>();
  return row?.status === "succeeded" ? "completed" : "pending";
}

/** 失効jobを登録する文（業務更新と同じbatchに入れる） */
export function revokeJobStatement(c: ApiContext, unitId: string, requestedBy: string, userId: string, authzAfter: number) {
  return enqueueJobStatement(c.env, {
    unitId, kind: REVOKE_JOB_KIND, sourceType: "user", sourceId: userId, sourceVersion: authzAfter, configVersion: "1",
    requestedBy, dedupeKey: `${unitId}|${REVOKE_JOB_KIND}|${userId}|${authzAfter}`,
  }).statement;
}

/**
 * jobの処理：対象利用者の、job作成より前のセッションを全て削除する（冪等）。
 * 作成より後のセッション（失効後に再ログインした正当なもの）は消さない。停止中の利用者は新しいセッションを作れない。
 */
registerJobHandler(REVOKE_JOB_KIND, async (job, env) => {
  const row = await env.DB.prepare("SELECT u.auth_id FROM users u JOIN members m ON m.user_id = u.id WHERE u.id = ? AND m.unit_id = ?")
    .bind(job.sourceId, job.unitId).first<{ auth_id: string }>();
  if (!row) return { kind: "stale", errorCode: "user_missing" };
  await env.DB.prepare("DELETE FROM auth_sessions WHERE user_id = ? AND created_at <= ?").bind(row.auth_id, job.createdAt).run();
  return { kind: "succeeded" };
});

export interface DisableInput {
  memberId: string;
  /** 団員の版 */
  version: number;
  /** 対象利用者の認可版（読み取った時点のもの） */
  expectedAuthzVersion: number;
  status: "paused" | "retired";
  reason: string;
  key: string;
  requestHash: string;
}
export interface RevocationOutcome {
  member: ReturnType<typeof Member.parse>;
  sessionRevocation: "completed" | "pending";
  replayed: boolean;
}

/**
 * 利用停止（休団・退団）：団員の状態・利用者の停止・認可版の増分・失効jobの登録を**一つのcommit**で確定し、
 * その後で認証側の全セッション失効を試みる。失効が失敗しても、停止commit後の業務要求は拒否される（毎要求D1の最新状態で判定）。
 * 最後の管理者の停止は拒否する。
 */
export async function disableUser(c: ApiContext, p: AuthzPrincipal, input: DisableInput): Promise<RevocationOutcome> {
  const target = await c.env.DB.prepare(
    "SELECT u.id AS user_id, u.auth_id, u.status AS user_status FROM members m JOIN users u ON u.id = m.user_id WHERE m.id = ? AND m.unit_id = ?",
  ).bind(input.memberId, p.unitId).first<{ user_id: string; auth_id: string; user_status: string }>();
  if (!target) throw new HttpError("NOT_FOUND");
  if (await wouldRemoveLastAdmin(c, p.unitId, input.memberId)) {
    throw new HttpError("INVALID_TRANSITION", undefined, [{ field: "status", reason: "last_admin" }]);
  }
  return commitDisable(c, p, input, target);
}

/**
 * 確定のbatch。事前の読取（理由つきの422を返すための確認）とは別に、**最後の管理者の保護をbatch内でも検査**する
 * （事前確認から確定までの間に他の管理者が外れた場合に備える。直接呼ぶ試験でこの保護を確認する）。
 */
export async function commitDisable(
  c: ApiContext, p: AuthzPrincipal, input: DisableInput, target: { user_id: string; auth_id: string },
): Promise<RevocationOutcome> {
  const authzAfter = input.expectedAuthzVersion + 1;
  const job = revokeJobStatement(c, p.unitId, p.userId, target.user_id, authzAfter);
  const result = await executeMutation(c.env, p, {
    operationCode: "member.disable",
    key: input.key,
    requestHash: input.requestHash,
    expectedAuthzVersion: p.authzVersion,
    roots: [{ table: "members", id: input.memberId, expectedVersion: input.version }],
    conditions: [
      {
        existsSql: "SELECT 1 FROM users u JOIN members m ON m.user_id = u.id WHERE m.id = ? AND m.unit_id = ? AND u.status = 'active' AND u.authz_version = ?",
        binds: [input.memberId, p.unitId, input.expectedAuthzVersion],
        failCode: "VERSION_CONFLICT",
      },
      notLastAdmin(p.unitId, input.memberId),
    ],
    statements: (ctx) => [
      c.env.DB.prepare(
        "UPDATE members SET status = ?, status_reason = ?, version = version + 1, last_mutation_token = ?, updated_at = ? WHERE id = ? AND unit_id = ? AND version = ?",
      ).bind(input.status, input.reason, ctx.attempt, ctx.now, input.memberId, p.unitId, input.version),
      // 停止と認可版の増分は同じ文。以後、旧い認可版で判定中の更新は全て失敗する
      c.env.DB.prepare(
        "UPDATE users SET status = 'disabled', disabled_at = ?, disabled_reason = ?, authz_version = authz_version + 1, updated_at = ? WHERE id = ? AND status = 'active' AND authz_version = ?",
      ).bind(ctx.now, input.reason, ctx.now, target.user_id, input.expectedAuthzVersion),
      c.env.DB.prepare(
        "UPDATE invitations SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'member_inactive', version = version + 1, updated_at = ?, last_mutation_token = ? WHERE member_id = ? AND unit_id = ? AND status = 'pending'",
      ).bind(ctx.now, ctx.now, ctx.attempt, input.memberId, p.unitId),
      job,
    ],
    // 理由の本文は監査/outboxに複製しない（members/users の行に持つ）
    audit: { action: "member.disable", entityType: "member", entityId: input.memberId, metadata: { status: input.status, authzVersion: authzAfter } },
    event: { entityType: "member", entityId: input.memberId, entityVersion: input.version + 1, eventType: "member.disabled", payload: { status: input.status } },
    response: { status: 200, sql: MEMBER_JSON, binds: [input.memberId], decode: (j) => Member.parse(j) },
  });
  const sessionRevocation = result.replayed
    ? await revocationState(c, target.user_id, authzAfter)
    : await revokeSessionsNow(c, target.auth_id, target.user_id, authzAfter);
  return { member: result.data, sessionRevocation, replayed: result.replayed };
}
